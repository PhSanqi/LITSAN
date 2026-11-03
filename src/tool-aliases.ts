import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { brand, toolName } from "./brand.mjs";
import { withFileMutationLock } from "./file-mutation-lock.js";

type AliasUsage = Record<string, { name: string; count: number; last_seen: string }>;

const FLUSH_DELAY_MS = 5_000;
// Counts per state root, kept in memory so a legacy call never waits on disk.
const pending = new Map<string, AliasUsage>();
let flushTimer: NodeJS.Timeout | undefined;

export function canonicalToolName(name: string): string {
  return brand.legacyToolPrefixes.some(prefix => name.startsWith(prefix)) ? toolName(name) : name;
}

/** Counts a legacy tool name; the file under the state root is updated in the background. */
export function logToolAlias(stateRoot: string, oldName: string, newName: string): void {
  if (oldName === newName) return;
  const usage = pending.get(stateRoot) ?? {};
  usage[oldName] = { name: newName, count: (usage[oldName]?.count ?? 0) + 1, last_seen: new Date().toISOString() };
  pending.set(stateRoot, usage);
  flushTimer ??= setTimeout(() => { void flushToolAliasUsage(); }, FLUSH_DELAY_MS).unref();
}

/** Merges pending counts into `tool-alias-usage.json`; exported for shutdown paths and tests. */
export async function flushToolAliasUsage(): Promise<void> {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = undefined; }
  const batches = [...pending.entries()];
  pending.clear();
  for (const [stateRoot, delta] of batches) {
    const path = join(stateRoot, "tool-alias-usage.json");
    try {
      await withFileMutationLock(path, async () => {
        let usage: AliasUsage = {};
        try { usage = JSON.parse(await readFile(path, "utf8")); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        for (const [oldName, entry] of Object.entries(delta)) {
          usage[oldName] = { name: entry.name, count: (usage[oldName]?.count ?? 0) + entry.count, last_seen: entry.last_seen };
        }
        const temporary = `${path}.${randomUUID()}.tmp`;
        await writeFile(temporary, JSON.stringify(usage, null, 2) + "\n", { mode: 0o600 });
        await rename(temporary, path);
      });
    } catch (error) {
      // Telemetry failure must not break an existing client's call.
      console.error(`[${brand.slug}] tool alias usage flush failed:`, error);
    }
  }
}
