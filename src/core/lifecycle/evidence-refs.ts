import type { DistillationJob } from "../../contracts/distillation.js";

export function distillationResultTimestamp(job: DistillationJob): string | undefined {
  if (job.result_committed_at && Number.isFinite(Date.parse(job.result_committed_at))) {
    return job.result_committed_at;
  }
  return job.completed_at && Number.isFinite(Date.parse(job.completed_at))
    ? job.completed_at
    : undefined;
}

export function completedRevisionCandidates(
  jobs: DistillationJob[],
  expectedPrefix: "l2" | "l3",
  projectStorageIds: Set<string> | null
): string[] {
  return jobs
    .filter((job) =>
      job.status === "completed" &&
      job.target === expectedPrefix &&
      job.result_kind === expectedPrefix &&
      Boolean(job.result_id?.trim()) &&
      Boolean(job.result_content?.trim()) &&
      Boolean(distillationResultTimestamp(job)) &&
      (!projectStorageIds || Boolean(job.project_id && projectStorageIds.has(job.project_id)))
    )
    .sort((a, b) =>
      (distillationResultTimestamp(b) ?? "").localeCompare(distillationResultTimestamp(a) ?? "") ||
      b.job_id.localeCompare(a.job_id)
    )
    .slice(0, 5)
    .map((job) => `${expectedPrefix}:${job.result_id}:${job.job_id}`);
}

export function exactEvidenceRefError(input: {
  requiredLayer: "L2" | "L3";
  received: string;
  projectId: string | null;
  expectedPrefix: "l2" | "l3";
  candidateRefs: string[];
}): Error {
  return new Error([
    "MEMHUB_EVIDENCE_REF_INVALID",
    `required_layer: ${input.requiredLayer}`,
    `received: ${input.received}`,
    `resolved_project: ${input.projectId ?? "account"}`,
    `valid_evidence_ref_example: ${input.expectedPrefix}:<memory-id>:<revision-id>`,
    "hint: Use the exact evidenceRef returned by litsan_context; do not rebuild it from the stable Memory id.",
    ...(input.candidateRefs.length > 0
      ? [`candidate_evidence_refs: ${input.candidateRefs.join(", ")}`]
      : [])
  ].join(" | "));
}

export function parseVersionedLayerEvidenceRef(
  ref: string,
  expectedPrefix: "l2" | "l3"
): { memoryId: string; revisionId: string } | null {
  const prefix = `${expectedPrefix}:`;
  if (!ref.startsWith(prefix)) return null;
  const value = ref.slice(prefix.length).trim();
  const separator = value.lastIndexOf(":");
  if (separator <= 0 || separator === value.length - 1) return null;
  const memoryId = value.slice(0, separator).trim();
  const revisionId = value.slice(separator + 1).trim();
  return memoryId && revisionId ? { memoryId, revisionId } : null;
}

export function parseLayerEvidenceRef(ref: string, expectedPrefix: "l1" | "l2" | "l3"): string {
  const prefix = `${expectedPrefix}:`;
  if (!ref.startsWith(prefix)) throw new Error(`expected ${expectedPrefix.toUpperCase()} evidence ref: ${ref}`);
  const id = ref.slice(prefix.length).trim();
  if (!id) throw new Error(`invalid ${expectedPrefix.toUpperCase()} evidence ref: ${ref}`);
  return id;
}

export function canonicalLayerTitle(kind: "l2" | "l3", projectId: string): string {
  return kind === "l2"
    ? `Project Timeline · ${projectId}`
    : `Project Rules & Experience · ${projectId}`;
}

export function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
