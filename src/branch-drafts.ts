import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { withFileMutationLock } from "./file-mutation-lock.js";
import { assertActiveDistillationLease, listDistillationJobs, mutateMaintenanceJob, type DistillationJob } from "./distillation-jobs.js";
import { distillationRevisionBody, validateDurableMemoryContent } from "./distillation-contract.js";
import { normalizeL2EventKey, resolveChunkEvents } from "./core/maintenance/merge-l2.js";
import { validateL2ChunkAnswer } from "./core/maintenance/answers.js";
import { JsonProjectBranchStore } from "./branch-store.js";
import type { ProjectReader } from "./core/ports/projects.js";
import type { MaintenanceCard, L2ChunkInput } from "./contracts/maintenance.js";
import type { L2ChunkEvent } from "./contracts/maintenance.js";

// Workstream phase 2 interface (spec workstream-spec-2.md §3). Part A implements the bodies;
// part B (maintenance queue) only calls completeBranchJobWithEvents.
export interface BranchDraftEvent { event: L2ChunkEvent; job_id: string; card_id?: string; appended_at: string }
export interface BranchDraft {
  version: 1; account_id: string; project_id: string; branch_id: string;
  status: "open" | "merged" | "archived";
  events: BranchDraftEvent[];
  failed_job_ids?: string[];
  merged_at?: string; merge_job_id?: string; merged_event_count?: number; archived_at?: string;
}

export function branchDraftPath(stateRoot: string, accountId: string, projectId: string, branchId: string): string {
  return join(stateRoot, "workstream-drafts", createHash("sha256").update(JSON.stringify([accountId, projectId, branchId])).digest("hex") + ".json");
}

export async function readBranchDraft(stateRoot: string, accountId: string, projectId: string, branchId: string): Promise<BranchDraft | null> {
  try {
    const draft = JSON.parse(await readFile(branchDraftPath(stateRoot, accountId, projectId, branchId), "utf8")) as BranchDraft;
    if (draft.version !== 1 || draft.account_id !== accountId || draft.project_id !== projectId || draft.branch_id !== branchId ||
        !["open", "merged", "archived"].includes(draft.status) || !Array.isArray(draft.events)) throw new Error("invalid branch draft");
    return draft;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Global lock order: branches project lock → merge mutex → draft lock → job store.
 * Never resolve/acquire the branch store while holding a draft lock. */
export async function mutateBranchDraft<T>(stateRoot: string, account: string, project: string, branch: string,
  run: (draft: BranchDraft) => Promise<T>): Promise<T> {
  const path = branchDraftPath(stateRoot, account, project, branch);
  return withFileMutationLock(path, async () => {
    const draft = await readBranchDraft(stateRoot, account, project, branch) ?? {
      version: 1, account_id: account, project_id: project, branch_id: branch, status: "open", events: []
    };
    const before = JSON.stringify(draft);
    const result = await run(draft);
    if (JSON.stringify(draft) === before) return result;
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.tmp-${randomUUID()}`;
    await writeFile(temporary, JSON.stringify(draft, null, 2) + "\n", { mode: 0o600 });
    await rename(temporary, path);
    return result;
  });
}

/** Same canonical main-head ordering as the maintenance chunk merge. */
export function mainL2Head(jobs: DistillationJob[], projectIds: string[]): DistillationJob | undefined {
  return jobs.filter(j => j.status === "completed" && j.target === "l2" && j.result_kind === "l2" &&
    j.result_id && j.result_content?.trim() && j.project_id && projectIds.includes(j.project_id))
    .sort((a, b) => (a.result_committed_at ?? a.completed_at ?? a.updated_at).localeCompare(b.result_committed_at ?? b.completed_at ?? b.updated_at) || a.job_id.localeCompare(b.job_id)).at(-1);
}

/** Reuse the chunk validator, including all bilingual/ref/date/length checks. */
export function validateBranchEvents(events: unknown, allowedRefs: string[], maxEvents = 12): L2ChunkEvent[] {
  if (!Array.isArray(events) || events.length > maxEvents) throw new Error(`expected 0-${maxEvents} events`);
  const prior: NonNullable<L2ChunkInput["prior_events"]> = [];
  const card = { allowed_refs: allowedRefs, input: { prior_events: prior } } as unknown as MaintenanceCard;
  for (let i = 0; i < events.length; i++) {
    const result = validateL2ChunkAnswer(card, { events: events.slice(i, i + 1) });
    if (!result.ok) throw new Error(`${result.code}: ${result.detail}`);
    const accepted = events[i] as L2ChunkEvent;
    prior.push({ key: normalizeL2EventKey(accepted.date + " " + accepted.title_en), date: accepted.date, title_en: accepted.title_en });
    for (const event of events.slice(i, i + 1) as L2ChunkEvent[]) for (const field of [event.title_en, event.title_zh, event.body_en, event.body_zh]) validateDurableMemoryContent(field);
  }
  return structuredClone(events) as L2ChunkEvent[];
}

/** Draft persistence precedes ledger completion, so a crash can safely replay. */
export async function completeBranchJobWithEvents(input: {
  stateRoot: string; accountId: string; jobId: string; leaseOwner: string; leaseToken?: string;
  events: L2ChunkEvent[]; cardIds?: string[]; now?: Date;
  projects?: Pick<ProjectReader, "storageIds">;
}): Promise<{ appended: number; dropped_duplicates: number; job_completed: boolean }> {
  const { stateRoot, accountId, jobId, leaseOwner, leaseToken } = input;
  const job = (await listDistillationJobs(stateRoot, accountId)).find(j => j.job_id === jobId);
  if (!job) throw new Error("distillation job not found for account");
  if (job.branch_id && job.l2_restructure) throw new Error("restructure_job_not_branch");
  if (!job.branch_id || job.branch_id === "main" || job.target !== "l2" || !job.project_id) throw new Error("not a branch L2 job");
  if (job.status === "completed" && job.result_kind === "branch_draft") return { appended: 0, dropped_duplicates: 0, job_completed: true };
  assertActiveDistillationLease(job, leaseOwner, leaseToken);
  // A card set may contain more than 12 events; the direct submit boundary caps at 12.
  const validated = validateBranchEvents(input.events, job.evidence_refs, Number.MAX_SAFE_INTEGER);
  const resolved = resolveChunkEvents(validated.map((event, eventIndex) => ({ event, eventIndex, chunkIndex: 0, cardId: "" })));
  const events = resolved.events.map(row => row.event);
  const now = (input.now ?? new Date()).toISOString();
  return new JsonProjectBranchStore(join(stateRoot, "project-branches.json")).withProjectLock(accountId, job.project_id, async store => {
    const branch = await store.resolve(accountId, job.project_id!, job.branch_id!, { includeClosed: true });
    const storageIds = input.projects ? await input.projects.storageIds(accountId, job.project_id!) : [job.project_id!];
    const result = await mutateBranchDraft(stateRoot, accountId, job.project_id!, job.branch_id!, async draft => {
      const current = (await listDistillationJobs(stateRoot, accountId)).find(j => j.job_id === jobId)!;
      if (current.status === "completed" && current.result_kind === "branch_draft") return { appended: 0, dropped_duplicates: 0 };
      assertActiveDistillationLease(current, leaseOwner, leaseToken);
      if (draft.events.some(e => e.job_id === jobId)) return { appended: 0, dropped_duplicates: 0 };
      if (draft.status === "merged") { draft.merged_event_count = draft.events.length; draft.status = "open"; delete draft.merged_at; delete draft.merge_job_id; }
      if (branch?.status === "expired") { draft.status = "archived"; draft.archived_at ??= now; }
      const head = mainL2Head(await listDistillationJobs(stateRoot, accountId), storageIds);
      const seen = new Set(draft.events.map(e => normalizeL2EventKey(e.event.date + " " + e.event.title_en)));
      for (const match of (head ? distillationRevisionBody(head) : "").normalize("NFKC").matchAll(/^##\s+(\d{4}-\d{2}-\d{2})\s*[:：]\s*(.+)$/gm)) {
        seen.add(normalizeL2EventKey(match[1] + " " + match[2]!.split(" / ")[0]));
      }
      let appended = 0;
      for (const [index, event] of events.entries()) {
        const key = normalizeL2EventKey(event.date + " " + event.title_en);
        if (seen.has(key)) continue;
        seen.add(key); appended++;
        const cardId = job.maintenance_cards?.find(c => event.evidence_refs.every(ref => c.evidence_refs.includes(ref)))?.card_id ?? input.cardIds?.[index];
        draft.events.push({ event, job_id: jobId, ...(cardId ? { card_id: cardId } : {}), appended_at: now });
      }
      // Keep the historical prefix stable: merged_event_count is a segment boundary.
      const boundary = draft.merged_event_count ?? 0;
      draft.events.splice(boundary, draft.events.length - boundary,
        ...draft.events.slice(boundary).sort((a, b) => a.event.date.localeCompare(b.event.date)));
      return { appended, dropped_duplicates: resolved.dropped_duplicates + events.length - appended };
    });
    await mutateMaintenanceJob(stateRoot, accountId, jobId, current => {
      if (current.status === "completed" && current.result_kind === "branch_draft") return;
      assertActiveDistillationLease(current, leaseOwner, leaseToken);
      current.status = "completed"; current.result_kind = "branch_draft";
      current.completed_at = current.updated_at = now;
      delete current.result_id; delete current.result_content; delete current.result_committed_at;
      delete current.leased_until; delete current.leased_by; delete current.lease_token;
      delete current.failure; delete current.failed_at;
    });
    if ((branch?.status === "merged" || branch?.status === "closed") && result.appended > 0) await store.transition(accountId, job.project_id!, job.branch_id!,
      { status: "closing", closing_since: now }, now);
    return { ...result, job_completed: true };
  });
}
