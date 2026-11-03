import {
  distillationResultTimestamp,
  type DistillationEvidenceItem,
  type DistillationJob
} from "./distillation-jobs.js";
import { canonicalDistillationBody, distillationRevisionBody } from "./distillation-contract.js";

export type DerivedL3ConflictReason =
  | "project_mismatch"
  | "evidence_mismatch"
  | "multiple_l3_claims";

export type DerivedL3ClaimInspection =
  | { state: "missing" }
  | { state: "valid"; claims: DistillationJob[]; representative: DistillationJob }
  | { state: "conflict"; claims: DistillationJob[]; reason: DerivedL3ConflictReason };

export function completedL2EvidenceRef(source: DistillationJob): string {
  if (!source.result_id?.trim()) throw new Error("completed L2 source is missing result id");
  return `l2:${source.result_id}:${source.job_id}`;
}

export function exactCompletedL2Evidence(
  item: DistillationEvidenceItem,
  source: DistillationJob
): boolean {
  return item.ref === completedL2EvidenceRef(source) &&
    item.kind === "artifact" &&
    item.layer === "L2" &&
    item.project_id === source.project_id &&
    typeof item.content === "string" && typeof source.result_content === "string" &&
    (source.result_core_content_hash ? item.content : canonicalDistillationBody(item.content)) === distillationRevisionBody(source) &&
    item.timestamp === distillationResultTimestamp(source);
}

/**
 * Validate the complete provenance batch of one L3 queue claim.
 * A legitimate L3 may consolidate multiple exact completed L2 revisions,
 * but every included revision must resolve to durable L2 provenance from the
 * same project. This rejects forged/foreign extra evidence while allowing
 * many-L2 -> one-L3 consolidation.
 */
export function validL3EvidenceBatch(
  child: DistillationJob,
  jobs: readonly DistillationJob[]
): boolean {
  if (child.target !== "l3" || child.scope !== "project" || !child.project_id) return false;
  if (child.evidence_refs.length === 0 || child.evidence_refs.length !== child.evidence.length) return false;
  if (new Set(child.evidence_refs).size !== child.evidence_refs.length) return false;
  if (new Set(child.evidence.map((item) => item.ref)).size !== child.evidence.length) return false;

  const completedL2ByRef = new Map<string, DistillationJob>();
  for (const source of jobs) {
    if (source.target !== "l2" || source.result_kind !== "l2" || source.status !== "completed" ||
        source.project_id !== child.project_id || !source.result_id?.trim() ||
        !source.result_content?.trim() || !distillationResultTimestamp(source)) continue;
    completedL2ByRef.set(completedL2EvidenceRef(source), source);
  }

  return child.evidence_refs.every((ref) => {
    const item = child.evidence.find((candidate) => candidate.ref === ref);
    const source = completedL2ByRef.get(ref);
    return Boolean(item && source && exactCompletedL2Evidence(item, source));
  });
}

/**
 * Inspect all L3 claims that reference one completed L2 result.
 * Multiple completed claims are valid only when they are revisions of the
 * same stable canonical L3 artifact id. Distinct artifacts remain a real
 * conflict. A single L3 claim may legitimately contain other exact L2 refs.
 */
export function inspectDerivedL3Claims(
  jobs: readonly DistillationJob[],
  source: DistillationJob
): DerivedL3ClaimInspection {
  const evidenceRef = completedL2EvidenceRef(source);
  const matches = jobs.filter((job) =>
    job.target === "l3" && job.evidence_refs.includes(evidenceRef)
  );
  if (matches.length === 0) return { state: "missing" };

  if (matches.some((job) => job.project_id !== source.project_id)) {
    return { state: "conflict", claims: matches, reason: "project_mismatch" };
  }
  if (matches.some((job) =>
    !validL3EvidenceBatch(job, jobs) ||
    !job.evidence.some((item) => exactCompletedL2Evidence(item, source))
  )) {
    return { state: "conflict", claims: matches, reason: "evidence_mismatch" };
  }

  const completedNoops = matches.filter((job) =>
    job.status === "completed" && job.result_kind === "noop"
  );
  const artifactClaims = matches.filter((job) => job.result_kind !== "noop");
  if (matches.length > 1) {
    // A completed noop is a terminal semantic disposition for an exact queue
    // claim, not a second durable L3 artifact. Historical stores can contain
    // such a skipped upstream claim alongside a later manual canonical L3
    // claim with the same evidence hash. Treat the noop as neutral only when
    // it is truly completed; live/failed/unknown duplicate claims remain a
    // fail-closed provenance conflict.
    if (completedNoops.length + artifactClaims.length !== matches.length) {
      return { state: "conflict", claims: matches, reason: "multiple_l3_claims" };
    }
    if (artifactClaims.length > 0) {
      const completedLineage = artifactClaims.every((job) =>
        job.status === "completed" && job.result_kind === "l3" && Boolean(job.result_id?.trim())
      );
      const artifactIds = new Set(artifactClaims.map((job) => job.result_id?.trim()).filter(Boolean));
      if (!completedLineage || artifactIds.size !== 1) {
        return { state: "conflict", claims: matches, reason: "multiple_l3_claims" };
      }
    }
  }

  // Prefer a real canonical artifact over a later noop when both are exact
  // terminal claims for the same source. If there is no artifact, a noop is
  // still a valid terminal derivation disposition.
  const representativePool = artifactClaims.length > 0 ? artifactClaims : matches;
  const representative = [...representativePool].sort((left, right) =>
    (distillationResultTimestamp(right) ?? right.updated_at)
      .localeCompare(distillationResultTimestamp(left) ?? left.updated_at)
  )[0]!;
  return { state: "valid", claims: matches, representative };
}
