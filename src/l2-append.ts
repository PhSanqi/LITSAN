import { reconcileCompletedL2DerivedJob } from "./distillation-derived-recovery.js";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { mainL2Head } from "./branch-drafts.js";
import { distillationRevisionBody } from "./distillation-contract.js";
import { listDistillationJobs, enqueueDerivedDistillationJob, leaseDistillationJob, mutateMaintenanceJob } from "./distillation-jobs.js";
import { mergeChunkEvents } from "./core/maintenance/merge-l2.js";
import { submitDistillationControl, type DistillationSubmitDeps } from "./distillation-submit.js";
import { resolveToolScope } from "./context-router.js";
import { validateDistillationEvidenceChain } from "./distillation-evidence.js";
import type { L2ChunkEvent } from "./contracts/maintenance.js";

// Workstream phase 2 port (spec workstream-spec-2.md §5): the only way a branch merge writes main L2.
export interface L2AppendProvenance { branch_id: string; branch_name: string; harness: string; source_job_ids: string[] }
export interface L2AppendResult { committed: boolean; job_id?: string; appended: number; dropped_duplicates: number }

export interface L2AppendDeps { stateRoot: string; runtime: DistillationSubmitDeps }

export async function commitL2Append(deps: unknown, input: { projectId: string; events: L2ChunkEvent[]; provenance: L2AppendProvenance; now?: Date }): Promise<L2AppendResult> {
  const { stateRoot, runtime } = deps as L2AppendDeps;
  const jobs = await listDistillationJobs(stateRoot, runtime.accountId);
  const sourceIds = [...new Set(input.provenance.source_job_ids)].sort();
  const normalizedEvents = input.events.map(event => [event.date, event.title_en, event.title_zh, event.body_en, event.body_zh]
    .map(value => value.normalize("NFKC").trim()).concat([...event.evidence_refs].sort()));
  const hashFor = (headRef: string | null) => createHash("sha256").update(JSON.stringify([
    input.provenance.branch_id, headRef, normalizedEvents, sourceIds
  ])).digest("hex");
  // Completed candidates retain their original base: replay must survive main advancing.
  const completed = jobs.find(j => j.target === "l2" && j.project_id === input.projectId && !j.branch_id &&
    j.status === "completed" && j.l2_append?.branch_id === input.provenance.branch_id &&
    j.evidence_hash === hashFor(j.l2_append.base_ref));
  if (completed) {
    await reconcileCompletedL2DerivedJob({ stateRoot, accountId: runtime.accountId, projectId: input.projectId, jobId: completed.job_id, dryRun: false });
    const original = mergeChunkEvents({ baseContent: completed.evidence.find(e => e.layer === "L2")?.content ?? null,
      canonicalTitle: `Project Timeline · ${input.projectId}`,
      events: input.events.map((event, eventIndex) => ({ event, eventIndex, chunkIndex: 0, cardId: "" })) });
    return { committed: true, job_id: completed.job_id, appended: original.appended, dropped_duplicates: original.dropped_duplicates };
  }
  const storageIds = await runtime.projects.storageIds(runtime.accountId, input.projectId);
  const head = mainL2Head(jobs, storageIds);
  const headRef = head ? `l2:${head.result_id}:${head.job_id}` : null;
  const hash = hashFor(headRef);
  const replay = jobs.find(j => j.target === "l2" && j.project_id === input.projectId && j.evidence_hash === hash && !j.branch_id);
  const merged = mergeChunkEvents({ baseContent: head ? distillationRevisionBody(head) : null,
    canonicalTitle: `Project Timeline · ${input.projectId}`,
    provenanceLine: `Branch: ${input.provenance.branch_name.replace(/[\r\n]+/g, " ")}`,
    events: input.events.map((event, eventIndex) => ({ event, eventIndex, chunkIndex: 0, cardId: "" })) });
  const sources = sourceIds.map(id => {
    const source = jobs.find(j => j.job_id === id && j.project_id === input.projectId && j.branch_id === input.provenance.branch_id && j.status === "completed");
    if (!source) throw new Error("branch merge source job missing or incomplete");
    return source;
  });
  if (!merged.appended) return { committed: false, appended: 0, dropped_duplicates: merged.dropped_duplicates };
  const evidence = [...new Map(sources.flatMap(j => j.evidence).map(e => [e.ref, e])).values()];
  // Reuse the restructure carry-forward envelope; normal L2 jobs still require L1.
  if (head) evidence.unshift({ ref: headRef!, kind: "memory", layer: "L2",
    timestamp: head.result_committed_at ?? head.completed_at ?? head.updated_at, project_id: head.project_id!,
    content: distillationRevisionBody(head), title: "Main timeline carried forward" });
  // A different head creates a fresh fenced candidate. Retire the stale candidate
  // from the queue without deleting it; it must never submit obsolete main content.
  for (const stale of jobs.filter(j => j.l2_append?.branch_id === input.provenance.branch_id &&
    j.project_id === input.projectId && j.status !== "completed" && j.status !== "failed" && j.evidence_hash !== hash)) {
    const commitPath = join(resolve(stateRoot), "distillation", "commits", createHash("sha256")
      .update(JSON.stringify([runtime.accountId, "l2", input.projectId, `project-timeline:${input.projectId}`])).digest("hex") + ".json");
    try {
      const commit = JSON.parse(await readFile(commitPath, "utf8")) as { args?: { job_id?: string }; response?: unknown; rejected?: boolean };
      if (commit.args?.job_id === stale.job_id && !commit.response && !commit.rejected) {
        throw new Error("branch append has an unresolved external commit; reconcile the frozen candidate before rebasing");
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await mutateMaintenanceJob(stateRoot, runtime.accountId, stale.job_id, current => {
      if (current.status === "completed") throw new Error("branch merge candidate completed concurrently; retry");
      current.status = "failed"; current.failure = "superseded branch merge base";
      current.failed_at = current.updated_at = new Date().toISOString();
      delete current.leased_by; delete current.leased_until; delete current.lease_token;
    });
  }
  let job = replay ?? (await enqueueDerivedDistillationJob({ stateRoot, accountId: runtime.accountId, projectId: input.projectId,
    target: "l2", evidence, dedupHash: hash, mergeContent: merged.content, l2Append: { branch_id: input.provenance.branch_id, base_ref: headRef } })).job;
  job = await mutateMaintenanceJob(stateRoot, runtime.accountId, job.job_id, current => {
    if (current.status === "failed" && current.failure_kind !== "ambiguous_core_commit") {
      current.status = "pending";
      delete current.failure; delete current.failure_kind; delete current.failed_at;
    }
    current.maintenance_merge_content = merged.content;
    current.evidence = evidence; current.evidence_refs = evidence.map(e => e.ref);
    return structuredClone(current);
  });
  const leased = await leaseDistillationJob(stateRoot, runtime.accountId, { jobId: job.job_id, harness: "memhub-branch-merge", useLeaseToken: true, leaseSeconds: 900 });
  if (leased) job = leased;
  else if (job.status !== "leased" || job.leased_by !== "memhub-branch-merge") throw new Error("branch merge job is not leasable");
  const response = await submitDistillationControl({ stateRoot, runtime, sourceHarness: "memhub-branch-merge", leaseToken: job.lease_token,
    args: { job_id: job.job_id, kind: "l2", scope: "project", project: input.projectId, content: job.maintenance_merge_content,
      tags: ["workstream-merge", `branch:${input.provenance.branch_id}`] }, resolveToolScope, validateDistillationEvidenceChain });
  if (response.next_layer_enqueue_error) throw new Error(String(response.next_layer_enqueue_error));
  return { committed: true, job_id: job.job_id, appended: merged.appended, dropped_duplicates: merged.dropped_duplicates };
}
