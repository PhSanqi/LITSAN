import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { appendFile, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { withFileMutationLock } from "./file-mutation-lock.js";
import type { MaintenanceCard, MaintenanceCardSet, MaintenanceLogEntry, MaintenanceConfig, MaintenanceOfferState } from "./contracts/maintenance.js";
import { normalizeMaintenanceConfig } from "./core/maintenance/config.js";
import { withDistillationJobsBatch } from "./distillation-jobs.js";
export function generationKey(projectId: string, branchId?: string): string {
  return branchId ? JSON.stringify([projectId, branchId]) : projectId;
}
export interface GenerationMarker { structure_fp: string; l2_head_ref: string | null; generators?: string; at: string }
export interface MaintenanceStore { version: 1; cards: MaintenanceCard[]; sets: MaintenanceCardSet[]; generation: Record<string, GenerationMarker>; generation_jobs?: Record<string, string>; artifacts?: Record<string, unknown> }
// The on-disk account envelope isolates per-project markers just like cards and sets.
interface StoredMaintenance extends Omit<MaintenanceStore, "generation" | "generation_jobs" | "artifacts"> { generation?: Record<string, Record<string, GenerationMarker>>; generation_jobs?: Record<string, Record<string, string>>; artifacts?: Record<string, Record<string, unknown>> }
let maintenanceStoreHooks: { write?: (path: string) => void } | undefined;
export function setMaintenanceStoreHooks(hooks?: typeof maintenanceStoreHooks): void { maintenanceStoreHooks = hooks; }
const dirtyStores = new WeakSet<MaintenanceStore>();
export function markMaintenanceDirty(store: MaintenanceStore): void { dirtyStores.add(store); }
const folder = (root: string) => join(resolve(root), "maintenance");
type StoreRun<T> = (store: MaintenanceStore, log: (entry: MaintenanceLogEntry) => void, checkpoint: () => Promise<void>) => Promise<T>;
const activeStore = new AsyncLocalStorage<{ path: string; accountId: string; args: Parameters<StoreRun<unknown>>; active: boolean }>();
const activeOffers = new AsyncLocalStorage<{ path: string; accountId: string; state: MaintenanceOfferState; active: boolean }>();

/** Match the existing lock order: offers -> cards -> ledger. */
export async function withTurnCommitMaintenance<T>(root: string, accountId: string, run: () => Promise<T>): Promise<T> {
  const config = await getMaintenanceConfig(root).catch(() => undefined);
  if (!config || config.conversation_maintenance === "off") return withDistillationJobsBatch(root, run);
  const now = Date.now();
  return withMaintenanceOfferState(root, accountId, now, () =>
    withMaintenanceStore(root, accountId, now, () => withDistillationJobsBatch(root, run)));
}
async function readStore(root: string): Promise<StoredMaintenance> {
  try {
    const store = JSON.parse(await readFile(join(folder(root), "cards.json"), "utf8"));
    if (store.version !== 1 || !Array.isArray(store.cards) || !Array.isArray(store.sets) ||
      ![...store.cards, ...store.sets].every(item => typeof item?.account_id === "string")) throw new Error("invalid maintenance store");
    return store;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, cards: [], sets: [] }; throw error; }
}
export async function readMaintenanceStore(root: string, accountId: string): Promise<MaintenanceStore> {
  const store = await readStore(root);
  return { version: 1, cards: store.cards.filter(c => c.account_id === accountId), sets: store.sets.filter(s => s.account_id === accountId), generation: store.generation?.[accountId] ?? {}, generation_jobs: store.generation_jobs?.[accountId] ?? {}, artifacts: store.artifacts?.[accountId] ?? {} };
}
/** One lock covers generation, leases, merging and map read/modify/write. */
export async function withMaintenanceStore<T>(root: string, accountId: string, now: number,
  run: (store: MaintenanceStore, log: (entry: MaintenanceLogEntry) => void, checkpoint: () => Promise<void>) => Promise<T>): Promise<T> {
  const dir = folder(root), path = join(dir, "cards.json");
  const active = activeStore.getStore();
  if (active?.active && active.path === path && active.accountId === accountId) return run(...active.args);
  return withFileMutationLock(path, async () => {
    const all = await readStore(root);
    const own: MaintenanceStore = { version: 1, cards: all.cards.filter(c => c.account_id === accountId), sets: all.sets.filter(s => s.account_id === accountId), generation: all.generation?.[accountId] ?? {}, generation_jobs: all.generation_jobs?.[accountId] ?? {}, artifacts: all.artifacts?.[accountId] ?? {} };
    const logs: MaintenanceLogEntry[] = [];
    let saved = JSON.stringify(own);
    const checkpoint = async () => {
      // Keep legacy callbacks that directly edit the store compatible; orchestration helpers mark dirty explicitly.
      const dirty = dirtyStores.has(own) || JSON.stringify(own) !== saved;
      if (!dirty) {
        if (logs.length) { await mkdir(dir, { recursive: true, mode: 0o700 }); await appendLogs(dir, logs.splice(0), now); }
        return;
      }
      const protectedIds = new Set(own.sets.filter(s => s.status === "open").flatMap(s => s.card_ids));
      own.cards = own.cards.filter(c => !["accepted", "rejected", "superseded"].includes(c.status) || protectedIds.has(c.card_id) || Date.parse(c.updated_at) >= now - 30 * 86400000);
      const next = { version: 1, cards: [...all.cards.filter(c => c.account_id !== accountId), ...own.cards], sets: [...all.sets.filter(s => s.account_id !== accountId), ...own.sets],
        generation: { ...all.generation, ...(Object.keys(own.generation).length ? { [accountId]: own.generation } : {}) },
        generation_jobs: { ...all.generation_jobs, [accountId]: own.generation_jobs ?? {} },
        ...(all.artifacts || Object.keys(own.artifacts ?? {}).length ? { artifacts: { ...all.artifacts, [accountId]: own.artifacts ?? {} } } : {}) };
      const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await writeFile(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
      await rename(tmp, path);
      maintenanceStoreHooks?.write?.(path);
      dirtyStores.delete(own); saved = JSON.stringify(own);
      if (logs.length) await appendLogs(dir, logs.splice(0), now);
    };
    const scope = { path, accountId, active: true, args: [own,
      (entry: MaintenanceLogEntry) => { if (entry.account !== accountId) throw new Error("cross-account maintenance log"); logs.push(entry); }, checkpoint] as Parameters<StoreRun<unknown>> };
    try {
      const result = await activeStore.run(scope, () => run(...scope.args));
      await checkpoint();
      return result;
    } finally { scope.active = false; }
  });
}
export async function appendMaintenanceLog(root: string, accountId: string, entries: MaintenanceLogEntry[], now: number): Promise<void> {
  if (entries.some(entry => entry.account !== accountId)) throw new Error("cross-account maintenance log");
  if (entries.length) await appendLogs(folder(root), entries, now);
}
async function appendLogs(dir: string, entries: (MaintenanceLogEntry | MaintenanceCallTiming)[], now: number): Promise<void> {
  if (!entries.length) return;
  await withFileMutationLock(join(dir, "card-log.jsonl"), () => appendLogsLocked(dir, entries, now));
}
async function appendLogsLocked(dir: string, entries: (MaintenanceLogEntry | MaintenanceCallTiming)[], now: number): Promise<void> {
  if (!entries.length) return;
  const path = join(dir, "card-log.jsonl");
  const size = await stat(path).then(s => s.size, error => { if (error.code === "ENOENT") return 0; throw error; });
  if (size > 10 * 1024 * 1024) await rename(path, join(dir, `card-log.${new Date(now).toISOString().replaceAll(":", "-")}.${randomUUID()}.jsonl`));
  for (const name of await readdir(dir)) {
    const date = /^card-log\.(\d{4}-\d{2}-\d{2})T/.exec(name)?.[1];
    if (date && Date.parse(date) < now - 30 * 86400000) await unlink(join(dir, name));
  }
  if (entries.length) await appendFile(path, entries.map(e => JSON.stringify(e) + "\n").join(""), { mode: 0o600 });
}
export async function readMaintenanceLog(root: string, accountId: string): Promise<MaintenanceLogEntry[]> {
  const dir = folder(root);
  let names: string[];
  try { names = await readdir(dir); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const result: MaintenanceLogEntry[] = [];
  for (const name of names.filter(n => /^card-log(?:\..+)?\.jsonl$/.test(n))) {
    let content: string;
    try { content = await readFile(join(dir, name), "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    for (const line of content.split("\n").filter(Boolean)) {
      const entry = JSON.parse(line) as MaintenanceLogEntry;
      if (entry.account === accountId) result.push(entry);
    }
  }
  return result;
}

async function atomicMaintenanceJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await rename(tmp, path);
}
export async function getMaintenanceConfig(root: string): Promise<MaintenanceConfig> {
  try { return normalizeMaintenanceConfig(JSON.parse(await readFile(join(folder(root), "config.json"), "utf8"))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return normalizeMaintenanceConfig(); }
}
export async function setMaintenanceConfig(root: string, patch: Partial<MaintenanceConfig>): Promise<MaintenanceConfig> {
  const path = join(folder(root), "config.json");
  return withFileMutationLock(path, async () => {
    const config = normalizeMaintenanceConfig({ ...await getMaintenanceConfig(root), ...patch });
    await atomicMaintenanceJson(path, config); return config;
  });
}
async function readOfferStates(root: string): Promise<Record<string, MaintenanceOfferState>> {
  try { return JSON.parse(await readFile(join(folder(root), "offer-state.json"), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return {}; }
}
function dailyOfferState(state: MaintenanceOfferState | undefined, now: number): MaintenanceOfferState {
  const day = new Date(now).toISOString().slice(0, 10);
  return state?.day === day ? state : { day, cards_offered: 0, est_tokens_offered: 0, by_continuity: state?.by_continuity ?? {} };
}
export async function readMaintenanceOfferState(root: string, accountId: string, now: number): Promise<MaintenanceOfferState> {
  const all = await readOfferStates(root);
  return dailyOfferState(Object.hasOwn(all, accountId) ? all[accountId] : undefined, now);
}
export async function withMaintenanceOfferState<T>(root: string, accountId: string, now: number, run: (state: MaintenanceOfferState) => Promise<T>): Promise<T> {
  const path = join(folder(root), "offer-state.json");
  const active = activeOffers.getStore();
  if (active?.active && active.path === path && active.accountId === accountId) return run(active.state);
  return withFileMutationLock(path, async () => {
    const all = await readOfferStates(root), state = dailyOfferState(Object.hasOwn(all, accountId) ? all[accountId] : undefined, now);
    const scope = { path, accountId, state, active: true };
    try {
      const result = await activeOffers.run(scope, () => run(state));
      state.by_continuity = Object.fromEntries(Object.entries(state.by_continuity).slice(-500));
      await atomicMaintenanceJson(path, { ...all, [accountId]: state }); return result;
    } finally { scope.active = false; }
  });
}

export interface MaintenanceCallTiming {
  ts: string; account: string; action: string; outcome: "ok" | "rejected" | "error";
  duration_ms: number; card_id?: string; inline_turn_event?: string; code?: string; set_status?: string;
}
export async function appendMaintenanceCallTiming(root: string, entry: MaintenanceCallTiming): Promise<void> {
  const dir = join(folder(root), "timing");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await appendLogs(dir, [entry], Date.now());
}
