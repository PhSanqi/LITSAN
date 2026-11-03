import { distillationResultTimestamp } from "./core/lifecycle/evidence-refs.js";
export { distillationResultTimestamp } from "./core/lifecycle/evidence-refs.js";
import { createHash, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { TRUSTED_TURN_SOURCE_KINDS, type CaptureSourceKind, type StoredCaptureEvent } from "./capture.js";
import { withFileMutationLock } from "./file-mutation-lock.js";
import { MemoryCoreHttpError } from "./local-memory-client.js";
import { globalStateEvidenceItem, latestCompletedGlobalState } from "./global-state.js";

import type { DistillationTarget, DistillationFailureKind, DistillationEvidenceItem, DistillationJob, DistilledFactMetadataSet } from "./contracts/distillation.js";
export type { DistillationTarget, DistillationFailureKind, DistillationEvidenceItem, DistillationJob } from "./contracts/distillation.js";

export interface DistillationConfig {
  auto_enabled: boolean;
  turn_threshold: number;
  idle_minutes: number;
  auto_since?: string;
  promotion_review_accounts?: string[];
}

interface JobStore {
  version: 2;
  jobs: DistillationJob[];
}

export async function getDistillationConfig(stateRoot: string): Promise<DistillationConfig> {
  try {
    const raw = JSON.parse(await readFile(join(resolve(stateRoot), "distillation", "config.json"), "utf8")) as Partial<DistillationConfig>;
    return normalizeConfig(raw);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    return { auto_enabled: false, turn_threshold: 8, idle_minutes: 30 };
  }
}

export async function setDistillationConfig(stateRoot: string, patch: Partial<DistillationConfig>): Promise<DistillationConfig> {
  const path = join(resolve(stateRoot), "distillation", "config.json");
  // A read/modify/write without the same cross-process lock loses concurrent
  // admin changes and can silently reset the cutover boundary.
  return withFileMutationLock(path, async () => {
    const previous = await getDistillationConfig(stateRoot);
    const next = normalizeConfig({
      ...previous,
      ...patch,
      ...(patch.auto_enabled === true && !previous.auto_enabled ? { auto_since: new Date().toISOString() } : {})
    });
    await atomicJson(path, next);
    return next;
  });
}

export function effectiveDistillationFailureKind(
  job: Pick<DistillationJob, "status" | "failure" | "failure_kind">
): DistillationFailureKind | undefined {
  if (job.failure_kind) return job.failure_kind;
  if (job.status === "failed" && job.failure?.startsWith("invalid legacy rebuild evidence:")) {
    return "invalid_legacy_evidence";
  }
  return undefined;
}

export function distillationJobIsRetryable(
  job: Pick<DistillationJob, "status" | "failure" | "failure_kind">
): boolean {
  if (job.status !== "failed") return false;
  const kind = effectiveDistillationFailureKind(job);
  return kind !== "ambiguous_core_commit" && kind !== "invalid_legacy_evidence";
}

function withFailureClassification(job: DistillationJob): DistillationJob {
  const failureKind = effectiveDistillationFailureKind(job);
  return failureKind && failureKind !== job.failure_kind
    ? { ...job, failure_kind: failureKind }
    : job;
}

/** Read-only cached ledger view. Mutation callers use listDistillationJobs (isolated clones). */
export async function readDistillationJobsSnapshot(stateRoot: string, accountId?: string, includeRetired = false): Promise<import("./contracts/maintenance.js").MaintenanceReadonly<DistillationJob[]>> {
  const path = storePath(stateRoot), signature = await distillationJobsSignature(stateRoot);
  const batch = currentBatch(stateRoot);
  let cached = batch?.store ? batch.snapshot : jobSnapshots.get(path);
  if (!cached || cached.signature !== signature) {
    const store = batch?.store ? structuredClone(batch.store) : await loadStore(stateRoot);
    // Freeze recursively: a snapshot consumer cannot poison another account or a later read.
    const freeze = (value: unknown): void => { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } };
    store.jobs = store.jobs.map(withFailureClassification).sort((a, b) => b.created_at.localeCompare(a.created_at));
    freeze(store.jobs);
    cached = { signature, jobs: store.jobs };
    if (batch?.store) batch.snapshot = cached;
    else jobSnapshots.set(path, cached);
  }
  return cached.jobs.filter(job => (!accountId || job.account_id === accountId) && (includeRetired || !job.result_retirement));
}
const jobSnapshots = new Map<string, { signature: string; jobs: DistillationJob[] }>();
let jobStoreHooks: { parse?: (path: string) => void; write?: (path: string) => void } | undefined;
/** Test instrumentation; observes actual jobs.json parses, including locked mutations. */
export function setDistillationJobsHooks(hooks?: typeof jobStoreHooks): void { jobStoreHooks = hooks; }
export async function distillationJobsSignature(root: string): Promise<string> {
  try { const info = await stat(storePath(root)); return `${info.mtimeMs}:${info.size}:${info.ino}${currentBatch(root)?.dirty ? ":pending" : ""}`; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return currentBatch(root)?.dirty ? "missing:pending" : "missing"; throw error; }
}
export async function listDistillationJobs(stateRoot: string, accountId?: string, includeRetired = false): Promise<DistillationJob[]> {
  return structuredClone(await readDistillationJobsSnapshot(stateRoot, accountId, includeRetired)) as DistillationJob[];
}

/** Retire active revisions before the remote mutation, preserving exact historical evidence.
 * An ambiguous Core call leaves them quarantined until an explicit retry succeeds. */
export async function retireDistillationMemory(input: {
  stateRoot: string; accountId: string; memoryId: string; operation: "archived" | "deleted";
  mutateCore: () => Promise<unknown>;
}): Promise<void> {
  const generation = randomUUID();
  const quarantine = await withMutation(input.stateRoot, async () => {
    const store = await loadStore(input.stateRoot);
    const revisions = store.jobs.filter((job) => job.account_id === input.accountId &&
      job.status === "completed" && job.result_kind !== "branch_draft" && job.result_id === input.memoryId);
    if (input.operation === "archived" && revisions.some((job) => job.result_retirement === "deleted")) {
      throw new Error("retirement conflict: memory already retired with a different operation");
    }
    if (revisions.length && revisions.every((job) => job.result_retirement === input.operation)) return null;
    if (revisions.some((job) => job.result_retirement === "pending" &&
      job.result_retirement_operation && job.result_retirement_operation !== input.operation)) {
      throw new Error("pending retirement must be retried with the same operation");
    }
    const active = revisions.filter((job) => job.result_retirement !== input.operation);
    const retrying = active.length > 0 && active.every((job) => job.result_retirement === "pending" &&
      job.result_retirement_operation === input.operation);
    const previous = active.filter((job) => job.result_retirement !== "pending").map((job) => ({ ...job }));
    for (const job of active) {
      job.result_retirement = "pending";
      job.result_retirement_generation = generation;
      job.result_retirement_operation = input.operation;
    }
    if (active.length) await saveStore(input.stateRoot, store);
    return { revisions: active.map((job) => job.job_id), retrying, previous };
  });
  if (!quarantine) return;
  const { revisions, retrying, previous } = quarantine;
  try {
    await input.mutateCore();
  } catch (error) {
    if (!(retrying && input.operation === "deleted" &&
      error instanceof MemoryCoreHttpError && error.status === 404)) {
      if (previous.length && error instanceof MemoryCoreHttpError && error.status >= 400 && error.status < 600) {
        await withMutation(input.stateRoot, async () => {
          const store = await loadStore(input.stateRoot);
          let restored = false;
          for (const before of previous) {
            const index = store.jobs.findIndex((job) => job.job_id === before.job_id &&
              job.account_id === input.accountId && job.result_id === input.memoryId &&
              job.result_retirement === "pending" && job.result_retirement_generation === generation);
            if (index !== -1) {
              store.jobs[index] = before;
              restored = true;
            }
          }
          if (restored) await saveStore(input.stateRoot, store);
        });
      }
      throw error;
    }
  }
  await withMutation(input.stateRoot, async () => {
    const store = await loadStore(input.stateRoot);
    const matching = store.jobs.filter((job) => revisions.includes(job.job_id) &&
      job.account_id === input.accountId && job.result_id === input.memoryId &&
      job.result_retirement === "pending" && job.result_retirement_generation === generation);
    if (matching.length !== revisions.length) throw new Error("retirement generation changed before finalize; retry required");
    for (const job of matching) job.result_retirement = input.operation;
    if (matching.length) await saveStore(input.stateRoot, store);
  });
}

/**
 * The current L3 artifact for a project is the one whose durable Core write
 * was completed last, not necessarily the job that was created last.
 * Concurrent workers can finish older-created jobs after newer-created jobs.
 */
export function latestCompletedL3ByProject(jobs: DistillationJob[]): DistillationJob[] {
  const latest = new Map<string, DistillationJob>();
  for (const job of jobs) {
    if (job.status !== "completed" ||
        job.result_kind !== "l3" ||
        !job.project_id ||
        !job.result_id?.trim() ||
        !job.result_content?.trim() ||
        !job.completed_at ||
        !Number.isFinite(Date.parse(job.completed_at))) continue;
    const previous = latest.get(job.project_id);
    if (!previous || compareCompletedRevision(job, previous) > 0) {
      latest.set(job.project_id, job);
    }
  }
  return [...latest.values()].sort((a, b) => a.project_id!.localeCompare(b.project_id!));
}

function compareCompletedRevision(a: DistillationJob, b: DistillationJob): number {
  return distillationResultTimestamp(a)!.localeCompare(distillationResultTimestamp(b)!) ||
    a.created_at.localeCompare(b.created_at) ||
    a.job_id.localeCompare(b.job_id);
}

function captureSourceKind(event: StoredCaptureEvent, field: "user_text" | "assistant_text" | "reasoning_summary" | "tool_summary"): CaptureSourceKind | undefined {
  const kinds = event.provenance?.source_kinds;
  const value = kinds && typeof kinds === "object" ? (kinds as Record<string, unknown>)[field] : undefined;
  return value === "user_said" || value === "agent_inferred" || value === "tool_output" || value === "imported"
    ? value : TRUSTED_TURN_SOURCE_KINDS[field];
}

function captureOrigin(event: StoredCaptureEvent): DistillationEvidenceItem["origin"] {
  const value = event.provenance?.origin;
  return value === "user" || value === "agent" || value === "automation" ? value : undefined;
}

function captureTrigger(event: StoredCaptureEvent): DistillationEvidenceItem["trigger"] {
  const value = event.provenance?.trigger;
  return typeof value === "string" && [
    "user_prompt", "hook", "task_notification", "side_session_note", "session_message",
    "scheduled_wakeup", "ci_event", "delegate", "cli_run", "other"
  ].includes(value) ? value as DistillationEvidenceItem["trigger"] : undefined;
}

export async function enqueueDistillationJob(input: {
  stateRoot: string;
  accountId: string;
  projectId: string | null;
  branchId?: string;
  captures: StoredCaptureEvent[];
  l2_restructure?: unknown;
  reason: "manual" | "turn_threshold" | "idle";
}): Promise<{ created: boolean; job: DistillationJob }> {
  if (input.branchId && input.l2_restructure) throw new Error("restructure_job_not_branch");
  if (input.branchId === "main") throw new Error("main is not a stored branch id");
  const branchId = input.branchId; // Preserve the branch selected by discovery even if the flag changes.
  if (!input.projectId) throw new Error("L2 project timeline requires a resolved project");
  const evidence: DistillationEvidenceItem[] = input.captures
    .filter((item) =>
      item.account_id === input.accountId &&
      item.capture_status === "complete" &&
      item.user_text?.trim() &&
      item.assistant_text?.trim()
    )
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    .map((item) => ({
      ref: `l1:${item.event_id}`,
      kind: "turn",
      layer: "L1",
      timestamp: item.timestamp,
      project_id: input.projectId!,
      conversation_id: item.conversation_id,
      user_text: item.user_text!.trim(),
      assistant_text: item.assistant_text!.trim(),
      ...(item.reasoning_summary?.trim() ? { reasoning_summary: item.reasoning_summary.trim() } : {}),
      ...(item.tool_summary?.trim() ? { tool_summary: item.tool_summary.trim() } : {}),
      source_kinds: {
        user_text: captureSourceKind(item, "user_text"),
        assistant_text: captureSourceKind(item, "assistant_text"),
        ...(item.reasoning_summary?.trim() ? { reasoning_summary: captureSourceKind(item, "reasoning_summary") } : {}),
        ...(item.tool_summary?.trim() ? { tool_summary: captureSourceKind(item, "tool_summary") } : {})
      },
      ...(captureOrigin(item) ? { origin: captureOrigin(item) } : {}),
      ...(captureTrigger(item) ? { trigger: captureTrigger(item) } : {})
    }));
  if (evidence.length === 0) throw new Error("L2 distillation requires complete L1 turns");
  return enqueueJob({
    stateRoot: input.stateRoot,
    accountId: input.accountId,
    target: "l2",
    projectId: input.projectId,
    evidence,
    reason: input.reason,
    ...(branchId ? { branchId } : {})
  });
}

/**
 * Queue explicit account-global L1 evidence into one canonical Global State
 * revision. The previous canonical revision is carried as an exact artifact
 * base so the Harness updates state instead of producing a disconnected delta.
 */
export async function enqueueGlobalStateDistillationJob(input: {
  stateRoot: string;
  accountId: string;
  captures: StoredCaptureEvent[];
  reason: "manual" | "turn_threshold" | "idle" | "migration";
}): Promise<{ created: boolean; job: DistillationJob }> {
  const turns: DistillationEvidenceItem[] = input.captures
    .filter((item) => item.account_id === input.accountId && item.capture_status === "complete" &&
      item.user_text?.trim() && item.assistant_text?.trim())
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.event_id.localeCompare(b.event_id))
    .map((item) => ({
      ref: `l1:${item.event_id}`,
      kind: "turn",
      layer: "L1",
      timestamp: item.timestamp,
      conversation_id: item.conversation_id,
      user_text: item.user_text!.trim(),
      assistant_text: item.assistant_text!.trim(),
      ...(item.reasoning_summary?.trim() ? { reasoning_summary: item.reasoning_summary.trim() } : {}),
      ...(item.tool_summary?.trim() ? { tool_summary: item.tool_summary.trim() } : {}),
      source_kinds: {
        user_text: captureSourceKind(item, "user_text"),
        assistant_text: captureSourceKind(item, "assistant_text"),
        ...(item.reasoning_summary?.trim() ? { reasoning_summary: captureSourceKind(item, "reasoning_summary") } : {}),
        ...(item.tool_summary?.trim() ? { tool_summary: captureSourceKind(item, "tool_summary") } : {})
      },
      ...(captureOrigin(item) ? { origin: captureOrigin(item) } : {}),
      ...(captureTrigger(item) ? { trigger: captureTrigger(item) } : {})
    }));
  if (turns.length === 0) throw new Error("Global State distillation requires complete explicit-global L1 turns");
  // Admission and base selection share the ledger lock so disjoint discovery scans cannot fork account state.
  return withMutation(input.stateRoot, async () => {
    const jobs = await listDistillationJobs(input.stateRoot, input.accountId);
    const active = jobs.find((job) => job.target === "global_state" &&
      (job.status === "pending" || job.status === "leased"));
    if (active) return { created: false, job: active };
    const previous = latestCompletedGlobalState(jobs);
    return enqueueJob({
      stateRoot: input.stateRoot,
      accountId: input.accountId,
      target: "global_state",
      projectId: null,
      evidence: [...(previous ? [globalStateEvidenceItem(previous)] : []), ...turns],
      reason: input.reason
    });
  });
}

export async function enqueueDerivedDistillationJob(input: {
  stateRoot: string;
  accountId: string;
  target: "l2" | "l3" | "l4" | "global_state" | "skill";
  dedupHash?: string;
  mergeContent?: string;
  l2Append?: NonNullable<DistillationJob["l2_append"]>;
  projectId: string | null;
  evidence: DistillationEvidenceItem[];
  reason?: "manual" | "upstream";
}): Promise<{ created: boolean; job: DistillationJob }> {
  if (input.target === "l3" && !input.projectId) throw new Error("L3 project profile requires projectId");
  if (input.target === "l4" && input.projectId) throw new Error("L4 user profile is account-scoped");
  if (input.target === "global_state" && input.projectId) throw new Error("Global State is account-scoped");
  if (input.evidence.length === 0) throw new Error(`${input.target.toUpperCase()} distillation requires evidence`);
  return enqueueJob({
    stateRoot: input.stateRoot,
    accountId: input.accountId,
    target: input.target,
    projectId: input.projectId,
    evidence: input.evidence,
    ...(input.dedupHash ? { dedupHash: input.dedupHash } : {}),
    ...(input.mergeContent !== undefined ? { mergeContent: input.mergeContent } : {}),
    ...(input.l2Append ? { l2Append: input.l2Append } : {}),
    reason: input.reason ?? "upstream"
  });
}

export async function enqueueL2RestructureJob(input: {
  stateRoot: string; accountId: string; projectId: string;
  evidence: DistillationEvidenceItem[];
  restructure: NonNullable<DistillationJob["l2_restructure"]>;
  dryRun: boolean;
}): Promise<{ created: boolean; job: DistillationJob }> {
  return enqueueJob({ ...input, target: "l2", reason: "manual", l2Restructure: input.restructure });
}


/**
 * Record a direct/manual L2-L4 Core write as an immutable completed revision.
 *
 * Job-backed distillation already gets this identity from its leased job.
 * Direct submit used to update the stable Memory id without leaving a durable
 * revision handle, which made downstream provenance race with later updates.
 * This ledger entry gives every successful direct write the same
 * <result_id>:<job_id> evidence identity as the queued path.
 */
export async function recordCompletedDistillationRevision(input: {
  stateRoot: string;
  accountId: string;
  target: "l2" | "l3" | "l4";
  projectId: string | null;
  conversationId?: string;
  evidence: DistillationEvidenceItem[];
  resultId: string;
  content: string;
  committedAt: string;
  operationId?: string;
  coreBody?: string;
  factMetadata?: DistilledFactMetadataSet;
}): Promise<DistillationJob> {
  const resultId = input.resultId.trim();
  const content = input.content.trim();
  if (!resultId) throw new TypeError("completed revision requires resultId");
  if (!content) throw new TypeError("completed revision requires content");
  if ((input.target === "l2" || input.target === "l3") && !input.projectId) {
    throw new Error(`${input.target.toUpperCase()} completed revision requires projectId`);
  }
  if (input.target === "l4" && input.projectId) {
    throw new Error("L4 completed revision must be account-scoped");
  }
  if (input.evidence.length === 0) {
    throw new Error(`${input.target.toUpperCase()} completed revision requires evidence`);
  }
  const committedAtMs = Date.parse(input.committedAt);
  if (!Number.isFinite(committedAtMs)) throw new TypeError("completed revision requires a valid committedAt");
  const committedAt = new Date(committedAtMs).toISOString();
  const evidence = uniqueEvidence(input.evidence);
  const evidenceHash = createHash("sha256")
    .update(JSON.stringify({ target: input.target, project: input.projectId, evidence }), "utf8")
    .digest("hex");

  return withMutation(input.stateRoot, async () => {
    const store = await loadStore(input.stateRoot);
    const existing = store.jobs.find((job) =>
      job.account_id === input.accountId &&
      job.target === input.target &&
      job.project_id === input.projectId &&
      job.status === "completed" &&
      !job.result_retirement &&
      job.result_kind === input.target &&
      job.result_id === resultId &&
      job.result_content === content &&
      (!input.operationId || job.result_operation_id === input.operationId) &&
      job.evidence_hash === evidenceHash
    );
    if (existing) return structuredClone(existing);

    const job: DistillationJob = {
      job_id: randomUUID(),
      account_id: input.accountId,
      target: input.target,
      scope: input.projectId ? "project" : "account",
      project_id: input.projectId,
      ...(input.conversationId ? { conversation_id: input.conversationId } : {}),
      status: "completed",
      reason: "manual",
      created_at: committedAt,
      updated_at: committedAt,
      completed_at: committedAt,
      result_kind: input.target,
      result_id: resultId,
      result_content: content,
      ...(input.factMetadata ? { result_fact_metadata: structuredClone(input.factMetadata) } : {}),
      result_committed_at: committedAt,
      ...(input.coreBody !== undefined ? { result_core_content_hash: createHash("sha256").update(input.coreBody).digest("hex") } : {}),
      ...(input.operationId ? { result_operation_id: input.operationId } : {}),
      evidence_refs: evidence.map((item) => item.ref),
      evidence_hash: evidenceHash,
      evidence
    };
    store.jobs.push(job);
    await saveStore(input.stateRoot, store);
    return structuredClone(job);
  });
}

export async function enqueueLegacyL1DistillationJob(input: {
  stateRoot: string;
  accountId: string;
  projectId: string;
  evidence: DistillationEvidenceItem[];
}): Promise<{ created: boolean; job: DistillationJob }> {
  const projectId = input.projectId.trim();
  if (!projectId) throw new TypeError("legacy L1 rebuild requires projectId");
  if (input.evidence.length === 0) throw new Error("legacy L1 rebuild requires evidence");
  for (const item of input.evidence) {
    if (item.layer !== "L1" || item.project_id !== projectId) {
      throw new Error("legacy L1 rebuild evidence must be project-scoped L1");
    }
    if (item.kind === "turn") {
      if (!item.user_text?.trim() || !item.assistant_text?.trim()) {
        throw new Error("legacy L1 turn evidence must contain user and assistant text");
      }
      continue;
    }
    if (item.kind !== "memory" || !item.content?.trim()) {
      throw new Error("legacy L1 rebuild evidence must contain raw turn or Memory Core L1 content");
    }
  }
  return enqueueJob({
    stateRoot: input.stateRoot,
    accountId: input.accountId,
    target: "l2",
    projectId,
    evidence: input.evidence,
    reason: "migration"
  });
}

export async function leaseDistillationJob(
  stateRoot: string,
  accountId: string,
  input: {
    projectId?: string | null;
    target?: DistillationTarget;
    jobId?: string;
    harness: string;
    leaseSeconds?: number;
    useLeaseToken?: boolean;
  }
): Promise<DistillationJob | null> {
  return withMutation(stateRoot, async () => {
    const store = await loadStore(stateRoot);
    const now = Date.now();
    const job = store.jobs.find((item) =>
      item.account_id === accountId &&
      (input.jobId === undefined || item.job_id === input.jobId) &&
      item.maintenance_split_locked !== true &&
      (
        item.status === "pending" ||
        (item.status === "leased" && Boolean(item.leased_until) && Date.parse(item.leased_until!) <= now)
      ) &&
      (input.projectId === undefined || item.project_id === input.projectId) &&
      (input.target === undefined || item.target === input.target) &&
      // Owner-only leases are single-use; every reassignment requires a token.
      (input.useLeaseToken || (item.status === "pending" && !item.lease_token && !item.attempts))
    );
    if (!job) return null;
    // Reassign an expired generation only when this exact job is actually
    // selected. Leasing unrelated work must not erase another in-flight
    // worker's opaque token before its external Core request returns.
    const seconds = Math.max(30, Math.min(900, Math.trunc(input.leaseSeconds ?? 300)));
    job.status = "leased";
    job.attempts = (job.attempts ?? 0) + 1;
    job.leased_by = input.harness;
    if (input.useLeaseToken) job.lease_token = randomUUID();
    else delete job.lease_token;
    job.leased_until = new Date(now + seconds * 1000).toISOString();
    job.updated_at = new Date(now).toISOString();
    await saveStore(stateRoot, store);
    return structuredClone(job);
  });
}

export async function completeDistillationJob(
  stateRoot: string,
  accountId: string,
  jobId: string,
  result: { kind: DistillationTarget | "noop"; resultId?: string; content?: string },
  leaseOwner: string,
  leaseToken?: string
): Promise<DistillationJob> {
  let completed!: DistillationJob;
  await mutateJob(stateRoot, accountId, jobId, (job) => {
    assertActiveDistillationLease(job, leaseOwner, leaseToken);
    job.status = "completed";
    job.completed_at = new Date().toISOString();
    job.updated_at = job.completed_at;
    job.result_kind = result.kind;
    if (result.resultId) job.result_id = result.resultId;
    if (result.content) job.result_content = result.content;
    delete job.leased_until;
    delete job.leased_by;
    delete job.lease_token;
    delete job.failure;
    delete job.failed_at;
    completed = structuredClone(job);
  });
  return completed;
}

export async function completeDistillationLocalArtifact(
  stateRoot: string,
  accountId: string,
  jobId: string,
  result: { kind: "global_state"; resultId: string; content: string; committedAt?: string },
  leaseOwner: string,
  leaseToken?: string
): Promise<DistillationJob> {
  let completed!: DistillationJob;
  await mutateJob(stateRoot, accountId, jobId, (job) => {
    assertActiveDistillationLease(job, leaseOwner, leaseToken);
    if (job.target !== "global_state" || job.scope !== "account" || job.project_id !== null) {
      throw new Error("local Global State completion requires an account-scoped global_state job");
    }
    const committedAt = result.committedAt ?? new Date().toISOString();
    job.status = "completed";
    job.completed_at = committedAt;
    job.updated_at = committedAt;
    job.result_kind = result.kind;
    job.result_id = result.resultId;
    job.result_content = result.content;
    job.result_committed_at = committedAt;
    delete job.leased_until;
    delete job.leased_by;
    delete job.lease_token;
    delete job.failure;
    delete job.failed_at;
    completed = structuredClone(job);
  });
  return completed;
}

/**
 * Record a Memory Core result that has already committed. With an opaque
 * lease token, expiry alone must not erase a successful write: the token
 * proves this is still the same lease generation unless another worker has
 * actually reassigned the job. Legacy owner-only leases retain the stricter
 * active-time requirement because same-owner reassignment is not fenced.
 */
export async function completeDistillationJobAfterCoreCommit(
  stateRoot: string,
  accountId: string,
  jobId: string,
  result: { kind: DistillationTarget; resultId: string; content: string; committedAt: string; coreBody?: string; factMetadata?: DistilledFactMetadataSet },
  leaseOwner: string,
  leaseToken?: string
): Promise<DistillationJob> {
  let completed!: DistillationJob;
  await mutateJob(stateRoot, accountId, jobId, (job) => {
    assertPostCoreCommitLeaseGeneration(job, leaseOwner, leaseToken);
    job.status = "completed";
    job.completed_at = new Date().toISOString();
    job.updated_at = job.completed_at;
    job.result_kind = result.kind;
    job.result_id = result.resultId;
    job.result_content = result.content;
    if (result.factMetadata) job.result_fact_metadata = structuredClone(result.factMetadata);
    else delete job.result_fact_metadata;
    job.result_committed_at = result.committedAt;
    if (result.coreBody !== undefined) job.result_core_content_hash = createHash("sha256").update(result.coreBody).digest("hex");
    delete job.leased_until;
    delete job.leased_by;
    delete job.lease_token;
    delete job.failure;
    delete job.failed_at;
    completed = structuredClone(job);
  });
  return completed;
}

/**
 * A successful Core HTTP response without a stable artifact ID is an
 * ambiguous commit, not a retryable Core failure. Fence that lease
 * generation into failed/manual-review state so expiry cannot requeue it.
 */
export async function quarantineDistillationJobAfterCoreCommit(
  stateRoot: string,
  accountId: string,
  jobId: string,
  message: string,
  leaseOwner: string,
  leaseToken?: string,
  committedAt?: string
): Promise<void> {
  await failDistillationJobForLeaseGeneration(
    stateRoot, accountId, jobId, message, leaseOwner, leaseToken, "ambiguous_core_commit"
  );
  if (committedAt) {
    await mutateJob(stateRoot, accountId, jobId, (job) => {
      if (job.status !== "failed" || job.failure_kind !== "ambiguous_core_commit") {
        throw new Error("ambiguous Core commit quarantine changed before timestamp recording");
      }
      job.result_committed_at = committedAt;
    });
  }
}

/**
 * Preserve the current failed-job semantics for an external Core attempt
 * even if its token-fenced lease crossed the wall-clock deadline while the
 * request was in flight. A reassigned generation is still untouchable.
 */
export async function failDistillationJobForLeaseGeneration(
  stateRoot: string,
  accountId: string,
  jobId: string,
  message: string,
  leaseOwner: string,
  leaseToken?: string,
  failureKind: "core_error" | "ambiguous_core_commit" = "core_error"
): Promise<void> {
  await mutateJob(stateRoot, accountId, jobId, (job) => {
    assertPostCoreCommitLeaseGeneration(job, leaseOwner, leaseToken);
    job.status = "failed";
    job.failure = message.slice(0, 2000);
    job.failure_kind = failureKind;
    job.failed_at = new Date().toISOString();
    job.updated_at = job.failed_at;
    delete job.leased_until;
    delete job.leased_by;
    delete job.lease_token;
  });
}

export async function failDistillationJob(
  stateRoot: string,
  accountId: string,
  jobId: string,
  message: string,
  leaseOwner: string,
  leaseToken?: string
): Promise<void> {
  await mutateJob(stateRoot, accountId, jobId, (job) => {
    assertActiveDistillationLease(job, leaseOwner, leaseToken);
    job.status = "failed";
    job.failure = message.slice(0, 2000);
    job.failure_kind = "core_error";
    job.failed_at = new Date().toISOString();
    job.updated_at = job.failed_at;
    delete job.leased_until;
    delete job.leased_by;
    delete job.lease_token;
  });
}

export function assertActiveDistillationLease(job: DistillationJob, leaseOwner: string, leaseToken?: string): void {
  if (job.status !== "leased") throw new Error(`distillation job is not leased: ${job.status}`);
  if (!job.leased_until || Date.parse(job.leased_until) <= Date.now()) {
    throw new Error("distillation job lease has expired");
  }
  if (job.leased_by !== leaseOwner) {
    throw new Error(`distillation job is leased by another harness: ${job.leased_by ?? "unknown"}`);
  }
  if (job.lease_token !== leaseToken) {
    throw new Error("distillation job lease token is missing or stale");
  }
}

function assertPostCoreCommitLeaseGeneration(
  job: DistillationJob,
  leaseOwner: string,
  leaseToken?: string
): void {
  if (job.status !== "leased") throw new Error(`distillation job is not leased: ${job.status}`);
  if (job.leased_by !== leaseOwner) {
    throw new Error(`distillation job is leased by another harness: ${job.leased_by ?? "unknown"}`);
  }
  if (job.lease_token !== leaseToken) {
    throw new Error("distillation job lease token is missing or stale");
  }
  if (job.lease_token) {
    return;
  }
  if (!job.leased_until || Date.parse(job.leased_until) <= Date.now()) {
    throw new Error("legacy distillation lease expired after Core commit; manual reconciliation required");
  }
}

export async function renewDistillationJobLease(
  stateRoot: string,
  accountId: string,
  jobId: string,
  leaseOwner: string,
  leaseToken: string,
  leaseSeconds = 300
): Promise<DistillationJob> {
  let renewed!: DistillationJob;
  await mutateJob(stateRoot, accountId, jobId, (job) => {
    assertActiveDistillationLease(job, leaseOwner, leaseToken);
    if (!job.lease_token) throw new Error("legacy distillation lease cannot be renewed without a token");
    const seconds = Math.max(30, Math.min(900, Math.trunc(leaseSeconds)));
    job.leased_until = new Date(Math.max(Date.parse(job.leased_until!), Date.now() + seconds * 1000)).toISOString();
    job.updated_at = new Date().toISOString();
    renewed = structuredClone(job);
  });
  return renewed;
}

/**
 * Fence the external Memory Core request with enough lease budget to outlive
 * the local Core client's bounded request timeout. Token-aware clients can
 * safely extend the same generation. Legacy owner-only leases cannot prove
 * same-owner generation after reassignment, so a near-expiry legacy submit
 * must reacquire before it is allowed to write Core.
 */
export async function prepareDistillationLeaseForExternalWrite(
  stateRoot: string,
  accountId: string,
  jobId: string,
  leaseOwner: string,
  leaseToken?: string,
  minimumRemainingSeconds = 60
): Promise<DistillationJob> {
  let prepared!: DistillationJob;
  await mutateJob(stateRoot, accountId, jobId, (job) => {
    assertActiveDistillationLease(job, leaseOwner, leaseToken);
    const now = Date.now();
    const minimumMs = Math.max(30, Math.min(900, Math.trunc(minimumRemainingSeconds))) * 1000;
    const remainingMs = Date.parse(job.leased_until!) - now;
    if (!job.lease_token) {
      if (remainingMs < minimumMs) {
        throw new Error("legacy distillation lease is too close to expiry for an external Core write; reacquire the job first");
      }
      prepared = structuredClone(job);
      return;
    }
    if (remainingMs < minimumMs) {
      job.leased_until = new Date(now + minimumMs).toISOString();
      job.updated_at = new Date(now).toISOString();
    }
    prepared = structuredClone(job);
  });
  return prepared;
}

export async function retryDistillationJob(stateRoot: string, accountId: string, jobId: string): Promise<DistillationJob> {
  let retried!: DistillationJob;
  await mutateJob(stateRoot, accountId, jobId, (job) => {
    if (job.status !== "failed") throw new Error("only failed distillation jobs can be retried");
    const failureKind = effectiveDistillationFailureKind(job);
    if (failureKind === "ambiguous_core_commit") {
      throw new Error("ambiguous Core commit requires manual reconciliation; ordinary retry is disabled");
    }
    if (failureKind === "invalid_legacy_evidence") {
      throw new Error("invalid legacy migration evidence is superseded and cannot be retried; rebuild from current project-scoped evidence instead");
    }
    job.status = "pending";
    job.updated_at = new Date().toISOString();
    delete job.failure;
    delete job.failure_kind;
    delete job.failed_at;
    delete job.leased_until;
    delete job.leased_by;
    delete job.lease_token;
    retried = structuredClone(job);
  });
  return retried;
}

async function enqueueJob(input: {
  stateRoot: string;
  accountId: string;
  target: DistillationTarget;
  projectId: string | null;
  conversationId?: string;
  evidence: DistillationEvidenceItem[];
  reason: DistillationJob["reason"];
  l2Restructure?: NonNullable<DistillationJob["l2_restructure"]>;
  dryRun?: boolean;
  branchId?: string;
  dedupHash?: string;
  mergeContent?: string;
  l2Append?: NonNullable<DistillationJob["l2_append"]>;
}): Promise<{ created: boolean; job: DistillationJob }> {
  // Agreed with the maintenance queue: an L2 restructure job never belongs to a branch.
  if (input.l2Restructure && input.branchId) throw new Error("restructure_job_not_branch");
  // Global State deliberately keeps its exact base revision first, followed by
  // chronological L1 turns. Sorting all evidence by timestamp can move a newly
  // committed base behind older-but-newly-routed captures and obscures the
  // full-replacement contract for the semantic executor.
  const evidence = input.l2Restructure || input.l2Append || input.target === "global_state"
    ? structuredClone(input.evidence)
    : uniqueEvidence(input.evidence);
  const evidenceHash = input.dedupHash ?? createHash("sha256")
    .update(JSON.stringify({ target: input.target, project: input.projectId, evidence, ...(input.branchId ? { branch_id: input.branchId } : {}) }), "utf8")
    .digest("hex");
  return withMutation(input.stateRoot, async () => {
    const store = await loadStore(input.stateRoot);
    const existing = store.jobs.find((job) =>
      job.account_id === input.accountId &&
      job.target === input.target &&
      job.project_id === input.projectId &&
      (input.l2Restructure
        ? Boolean(job.l2_restructure) && (job.status === "pending" || job.status === "leased")
        : job.evidence_hash === evidenceHash)
    );
    if (existing) return { created: false, job: structuredClone(existing) };
    // Discovery scans and threshold updates can race. An exact batch hash is
    // insufficient: [A,B] and [B,C] have different hashes but must not create
    // two L2 jobs containing the same durable turn. Check within the locked
    // mutation; a later discovery pass can enqueue the remaining turn.
    if ((input.target === "l2" || input.target === "global_state") && !input.l2Restructure && !input.dedupHash) {
      const refs = new Set(evidence.map((item) => item.ref));
      const overlap = store.jobs.find((job) =>
        job.account_id === input.accountId &&
        job.target === input.target &&
        job.project_id === input.projectId &&
        job.evidence_refs.some((ref) => ref.startsWith("l1:") && refs.has(ref))
      );
      if (overlap) return { created: false, job: structuredClone(overlap) };
    }
    const now = new Date().toISOString();
    const job: DistillationJob = {
      job_id: randomUUID(),
      account_id: input.accountId,
      target: input.target,
      scope: input.projectId ? "project" : "account",
      project_id: input.projectId,
      ...(input.conversationId ? { conversation_id: input.conversationId } : {}),
      ...(input.branchId ? { branch_id: input.branchId } : {}),
      ...(input.mergeContent !== undefined ? { maintenance_merge_content: input.mergeContent, maintenance_background_only: true } : {}),
      status: "pending",
      reason: input.reason,
      ...(input.l2Append ? { l2_append: structuredClone(input.l2Append) } : {}),
      ...(input.l2Restructure ? { l2_restructure: structuredClone(input.l2Restructure), maintenance_background_only: true } : {}),
      created_at: now,
      updated_at: now,
      evidence_refs: [...new Set([...evidence.map((item) => item.ref), ...(input.l2Restructure?.base_evidence_refs ?? [])])],
      evidence_hash: evidenceHash,
      evidence
    };
    if (!input.dryRun) {
      store.jobs.push(job);
      await saveStore(input.stateRoot, store);
    }
    return { created: true, job: structuredClone(job) };
  });
}

function uniqueEvidence(items: DistillationEvidenceItem[]): DistillationEvidenceItem[] {
  const byRef = new Map<string, DistillationEvidenceItem>();
  for (const item of items) {
    if (!item.ref.trim()) throw new TypeError("distillation evidence ref must be non-empty");
    byRef.set(item.ref, structuredClone(item));
  }
  return [...byRef.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.ref.localeCompare(b.ref));
}

function normalizeConfig(value: Partial<DistillationConfig>): DistillationConfig {
  const threshold = Number.isFinite(value.turn_threshold) ? Math.trunc(value.turn_threshold!) : 8;
  const idleMinutes = Number.isFinite(value.idle_minutes) ? Math.trunc(value.idle_minutes!) : 30;
  return {
    auto_enabled: value.auto_enabled === true,
    ...(Array.isArray(value.promotion_review_accounts) ? { promotion_review_accounts: [...new Set(value.promotion_review_accounts.filter(x => typeof x === "string" && x.trim()))] } : {}),
    turn_threshold: Math.max(2, Math.min(100, threshold)),
    idle_minutes: Math.max(5, Math.min(1440, idleMinutes)),
    ...(typeof value.auto_since === "string" && Number.isFinite(Date.parse(value.auto_since))
      ? { auto_since: new Date(value.auto_since).toISOString() }
      : {})
  };
}

async function mutateJob(
  stateRoot: string,
  accountId: string,
  jobId: string,
  fn: (job: DistillationJob) => void
): Promise<void> {
  await withMutation(stateRoot, async () => {
    const store = await loadStore(stateRoot);
    const index = store.jobs.findIndex((item) => item.job_id === jobId && item.account_id === accountId);
    if (index < 0) throw new Error("distillation job not found for account");
    const job = structuredClone(store.jobs[index]!);
    fn(job);
    store.jobs[index] = job;
    await saveStore(stateRoot, store);
  });
}

function storePath(root: string): string {
  return join(resolve(root), "distillation", "jobs.json");
}

async function loadStore(root: string): Promise<JobStore> {
  return currentBatch(root)?.store ?? structuredClone((await cachedStore(root)).store);
}

interface CachedStore { signature: string; store: JobStore; legacy?: string }
const jobStores = new Map<string, CachedStore>();
async function cachedStore(root: string): Promise<CachedStore> {
  const path = storePath(root);
  for (;;) {
    const signature = await distillationJobsSignature(root);
    const cached = jobStores.get(path);
    if (cached?.signature === signature) return cached;
    let contents: string;
    try { contents = await readFile(path, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (signature !== "missing") continue;
      return { signature, store: { version: 2, jobs: [] } };
    }
    // Do not label a pre-rename read with the replacement file's signature.
    if (signature !== await distillationJobsSignature(root)) continue;
    jobStoreHooks?.parse?.(path);
    const raw = JSON.parse(contents), store = parseStore(raw);
    const next = { signature, store, ...(raw.version === 1 ? { legacy: contents } : {}) };
    jobStores.set(path, next);
    return next;
  }
}

function parseStore(raw: unknown): JobStore {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("invalid distillation job store: expected an object");
  }
  const record = raw as Record<string, unknown>;
  if (record.version !== 1 && record.version !== 2) {
    throw new Error("invalid distillation job store: unsupported version");
  }
  if (!Array.isArray(record.jobs)) {
    throw new Error("invalid distillation job store: jobs must be an array");
  }
  const jobs = record.jobs.map((value: unknown, index: number) => {
    const invalid = () => new Error(`invalid distillation job store: invalid job at index ${index}`);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
    const job = value as Record<string, unknown>;
    if (!["job_id", "account_id", "created_at", "updated_at"].every((key) =>
      typeof job[key] === "string" && (job[key] as string).length > 0) ||
        !["pending", "leased", "completed", "failed"].includes(job.status as string) ||
        !["manual", "turn_threshold", "idle", "upstream", "migration"].includes(job.reason as string) ||
        !(job.project_id === null || typeof job.project_id === "string") ||
        !Array.isArray(job.evidence) || !job.evidence.every((item) =>
          item && typeof item === "object" && !Array.isArray(item))) throw invalid();
    if (record.version === 1) {
      if (!job.evidence.every((item) => typeof item.event_id === "string" && item.event_id.trim() &&
          typeof item.timestamp === "string")) throw invalid();
      return migrateV1Job(job);
    }
    if (!["l2", "l3", "l4", "global_state", "skill"].includes(job.target as string) ||
        !["account", "project"].includes(job.scope as string) ||
        typeof job.evidence_hash !== "string" ||
        !Array.isArray(job.evidence_refs) || !job.evidence_refs.every((ref) => typeof ref === "string") ||
        !job.evidence.every((item) => typeof item.ref === "string" &&
          typeof item.timestamp === "string" && ["turn", "memory", "artifact"].includes(item.kind))) throw invalid();
    return job as unknown as DistillationJob;
  });
  return { version: 2, jobs };
}

function migrateV1Job(item: Record<string, unknown>): DistillationJob {
  const evidence = Array.isArray(item.evidence)
    ? item.evidence.map((raw) => {
        const row = raw as Record<string, unknown>;
        return {
          ref: `l1:${String(row.event_id ?? randomUUID())}`,
          kind: "turn" as const,
          layer: "L1" as const,
          timestamp: String(row.timestamp ?? new Date(0).toISOString()),
          ...(typeof item.project_id === "string" ? { project_id: item.project_id } : {}),
          ...(typeof item.conversation_id === "string" ? { conversation_id: item.conversation_id } : {}),
          ...(typeof row.user_text === "string" ? { user_text: row.user_text } : {}),
          ...(typeof row.assistant_text === "string" ? { assistant_text: row.assistant_text } : {})
        };
      })
    : [];
  const legacyResult = typeof item.result_kind === "string" ? item.result_kind : undefined;
  return {
    job_id: String(item.job_id ?? randomUUID()),
    account_id: String(item.account_id ?? ""),
    target: legacyResult === "skill" ? "skill" : "l2",
    scope: item.project_id ? "project" : "account",
    project_id: typeof item.project_id === "string" ? item.project_id : null,
    ...(typeof item.conversation_id === "string" ? { conversation_id: item.conversation_id } : {}),
    status: (["pending", "leased", "completed", "failed"].includes(String(item.status))
      ? item.status
      : "failed") as DistillationJob["status"],
    reason: (["manual", "turn_threshold", "idle", "upstream", "migration"].includes(String(item.reason))
      ? item.reason
      : "manual") as DistillationJob["reason"],
    created_at: String(item.created_at ?? new Date(0).toISOString()),
    updated_at: String(item.updated_at ?? item.created_at ?? new Date(0).toISOString()),
    ...(typeof item.leased_until === "string" ? { leased_until: item.leased_until } : {}),
    ...(typeof item.leased_by === "string" ? { leased_by: item.leased_by } : {}),
    ...(typeof item.lease_token === "string" ? { lease_token: item.lease_token } : {}),
    ...(typeof item.completed_at === "string" ? { completed_at: item.completed_at } : {}),
    ...(typeof item.failure === "string" ? { failure: item.failure } : {}),
    ...(["core_error", "ambiguous_core_commit", "invalid_legacy_evidence"].includes(String(item.failure_kind))
      ? { failure_kind: item.failure_kind as DistillationJob["failure_kind"] }
      : {}),
    ...(typeof item.failed_at === "string" ? { failed_at: item.failed_at } : {}),
    ...(typeof item.attempts === "number" ? { attempts: item.attempts } : {}),
    ...(legacyResult ? { result_kind: legacyResult === "skill" ? "skill" : legacyResult === "noop" ? "noop" : "l2" } : {}),
    ...(typeof item.result_id === "string" ? { result_id: item.result_id } : {}),
    ...(typeof item.result_content === "string" ? { result_content: item.result_content } : {}),
    ...(typeof item.result_committed_at === "string" &&
        Number.isFinite(Date.parse(item.result_committed_at))
      ? { result_committed_at: item.result_committed_at }
      : {}),
    evidence_refs: evidence.map((entry) => entry.ref),
    evidence_hash: String(item.evidence_hash ?? createHash("sha256").update(JSON.stringify(evidence)).digest("hex")),
    evidence
  };
}

async function saveStore(root: string, store: JobStore): Promise<void> {
  const batch = currentBatch(root);
  if (!batch) throw new Error("job store mutation requires its ledger lock");
  batch.store = store; batch.dirty = true; batch.snapshot = undefined;
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flush: true });
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

async function withMutation<T>(stateRoot: string, run: () => Promise<T>): Promise<T> {
  return withDistillationJobsBatch(stateRoot, async () => {
    const batch = currentBatch(stateRoot)!;
    if (!batch.store) {
      const cached = await cachedStore(stateRoot);
      batch.store = structuredClone(cached.store);
      if (cached.legacy !== undefined) {
        await writeFile(`${storePath(stateRoot)}.v1-backup-${Date.now()}`, cached.legacy, { flag: "wx", mode: 0o600, flush: true });
        batch.dirty = true;
      }
    }
    return run();
  });
}

interface JobBatch {
  path: string;
  store?: JobStore;
  snapshot?: { signature: string; jobs: DistillationJob[] };
  dirty: boolean;
  release?: () => Promise<void>;
}
const jobBatch = new AsyncLocalStorage<JobBatch | undefined>();
function currentBatch(root: string): JobBatch | undefined {
  const batch = jobBatch.getStore();
  return batch?.path === storePath(root) && batch.release ? batch : undefined;
}
async function acquireBatch(batch: JobBatch): Promise<void> {
  let acquired!: () => void, failed!: (error: unknown) => void, release!: () => void;
  const ready = new Promise<void>((resolve, reject) => { acquired = resolve; failed = reject; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const lock = withFileMutationLock(batch.path, async () => { acquired(); await held; });
  void lock.catch(failed);
  await ready;
  batch.release = async () => { batch.release = undefined; release(); await lock; };
}
/** One ledger write for local mutations; callers acquire offer/card locks first. */
export async function withDistillationJobsBatch<T>(root: string, run: () => Promise<T>): Promise<T> {
  if (currentBatch(root)) return run();
  const batch: JobBatch = { path: storePath(root), dirty: false };
  await acquireBatch(batch);
  return jobBatch.run(batch, async () => {
    try { return await run(); }
    finally {
      try { await flushDistillationJobs(root); }
      finally { await batch.release?.(); }
    }
  });
}
export async function flushDistillationJobs(root: string): Promise<void> {
  const batch = currentBatch(root);
  if (!batch?.dirty || !batch.store) return;
  await atomicJson(batch.path, batch.store);
  batch.dirty = false; batch.snapshot = undefined;
  jobStoreHooks?.write?.(batch.path);
  jobStores.set(batch.path, { signature: await distillationJobsSignature(root), store: structuredClone(batch.store) });
  jobSnapshots.delete(batch.path);
}
/** Core/branch merges retain their durable fences and must not hold the ledger lock across I/O. */
export async function outsideDistillationJobsBatch<T>(root: string, run: () => Promise<T>): Promise<T> {
  const batch = currentBatch(root);
  if (!batch) return run();
  await flushDistillationJobs(root);
  await batch.release!();
  try { return await jobBatch.run(undefined, run); }
  finally {
    batch.store = undefined; batch.snapshot = undefined;
    await acquireBatch(batch);
  }
}

/** Maintenance claims and internal merge leases use the same ledger lock as legacy workers. */
export async function mutateMaintenanceJob<T>(stateRoot: string, accountId: string, jobId: string,
  change: (job: DistillationJob) => T): Promise<T> {
  let result!: T;
  await mutateJob(stateRoot, accountId, jobId, job => { result = change(job); });
  return result;
}

/** Atomically fence/claim all coalesced parents; callbacks must validate every parent before mutation. */
export async function mutateMaintenanceJobs<T>(stateRoot: string, accountId: string, jobIds: string[], change: (jobs: DistillationJob[]) => T): Promise<T> {
  return withMutation(stateRoot, async () => {
    const store = await loadStore(stateRoot);
    const jobs = jobIds.map(id => store.jobs.find(j => j.account_id === accountId && j.job_id === id));
    if (jobs.some(j => !j)) throw new Error("distillation job not found for account");
    const changed = structuredClone(jobs) as DistillationJob[];
    const result = change(changed);
    const replacements = new Map(changed.map(job => [job.job_id, job]));
    store.jobs = store.jobs.map(job => job.account_id === accountId ? replacements.get(job.job_id) ?? job : job);
    await saveStore(stateRoot, store);
    return result;
  });
}
