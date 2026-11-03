import type { DistillationJob } from "../../contracts/distillation.js";

/** Shared with the routine heading guard so restructure fences the same base. */
/** `includeRetired` keeps the routine heading guard's original selection (it never skipped retired revisions). */
export function latestCanonicalL2(jobs: DistillationJob[], projectId: string, jobProjectId: string | null = projectId,
  options: { includeRetired?: boolean } = {}): DistillationJob | undefined {
  const projectIds = new Set([projectId, jobProjectId]);
  return jobs.filter(item => item.status === "completed" && item.target === "l2" && item.result_kind === "l2" &&
    (options.includeRetired || !item.result_retirement) && Boolean(item.result_id) && Boolean(item.result_content?.trim()) &&
    Boolean(item.project_id && projectIds.has(item.project_id)))
    .sort((a, b) => (a.result_committed_at ?? a.completed_at ?? a.updated_at)
      .localeCompare(b.result_committed_at ?? b.completed_at ?? b.updated_at) || a.job_id.localeCompare(b.job_id)).at(-1);
}

export function assertL2RestructureCandidate(job: DistillationJob, content: string, evidenceRefs: string[]): void {
  const restructure = job.l2_restructure!;
  const headings = content.split(/\r?\n/).filter(line => line.startsWith("## "));
  if (!headings.length || headings.some(line => !/^## \d{4}-\d{2}-\d{2}(?:[^:\r\n]|:(?=\d)){0,40}: .+/.test(line))) {
    throw new Error("L2 restructure requires at least one dated chronology heading; every ## heading must use ## YYYY-MM-DD: Title EN / 标题");
  }
  const refs = new Set(evidenceRefs);
  const missing = restructure.base_evidence_refs.filter(ref => !refs.has(ref));
  if (missing.length) throw new Error(`L2 restructure cannot drop base evidence refs: ${missing.join(", ")}`);
  const allowed = new Set([restructure.base_ref, ...restructure.base_evidence_refs,
    ...job.evidence.filter(item => item.layer === "L1").map(item => item.ref)]);
  if (evidenceRefs.some(ref => !allowed.has(ref))) throw new Error("L2 restructure evidence refs must belong to the base or resolved L1 evidence");
}
