import type { ProjectReader } from "../ports/projects.js";
import type { AccountId, UserId } from "../../contracts/identity.js";
import type { MemoryViewerReader } from "../ports/memory.js";
import type { CaptureEvidenceReader } from "../ports/memory.js";
import type { DistillationJobReader } from "../ports/distillation.js";
import { completedRevisionCandidates, exactEvidenceRefError, parseVersionedLayerEvidenceRef, parseLayerEvidenceRef, canonicalLayerTitle, distillationResultTimestamp, objectRecord } from "./evidence-refs.js";
import type { DistillationEvidenceItem, DistillationJob } from "../../contracts/distillation.js";

export interface DistillationEvidenceDeps {
  projects: Pick<ProjectReader, "storageIds">;
  accountId: AccountId;
  userId: UserId;
  memoryClient: MemoryViewerReader;
}

/** Shared exact L2 carry-forward envelope for restructure and branch append jobs. */
export function isProjectL2BaseEvidence(item: DistillationEvidenceItem, ref: string, storageIds: Set<string> | null): boolean {
  return item.ref === ref && Boolean(parseVersionedLayerEvidenceRef(ref, "l2")) && item.kind === "memory" &&
    item.layer === "L2" && Boolean(item.content?.trim() && item.project_id && storageIds?.has(item.project_id));
}

/**
 * Evidence resolution/validation for distillation submits. These rules used to
 * live inline in mcp.ts; they are business rules, not transport concerns.
 */
export async function validateDistillationEvidenceChain(input: {
  stateRoot: string;
  runtime: DistillationEvidenceDeps;
  kind: "l2" | "l3" | "l4" | "skill";
  projectId: string | null;
  evidenceRefs: string[];
  job?: DistillationJob;
}, readers: CaptureEvidenceReader & DistillationJobReader): Promise<DistillationEvidenceItem[]> {
  if (input.kind === "skill") return [];

  if (input.job) {
    const expectedLayer = input.kind === "l2" ? "L1" : input.kind === "l3" ? "L2" : "L3";
    const baseRef = input.kind === "l2" ? input.job.l2_restructure?.base_ref ?? input.job.l2_append?.base_ref : undefined;
    const carriedBase = baseRef ? input.job.evidence[0] : undefined;
    const upstreamEvidence = carriedBase ? input.job.evidence.slice(1) : input.job.evidence;
    if (input.job.evidence.length === 0 || upstreamEvidence.some((item) => item.layer !== expectedLayer)) {
      throw new Error(`${input.kind.toUpperCase()} job evidence must come from ${expectedLayer}`);
    }
    const projectStorageIds = input.projectId
      ? new Set(await input.runtime.projects.storageIds(input.runtime.accountId, input.projectId))
      : null;
    if (input.kind === "l2") {
      if (baseRef && (!carriedBase || !isProjectL2BaseEvidence(carriedBase, baseRef, projectStorageIds))) {
        throw new Error("L2 restructure/append requires its exact project-scoped L2 base revision");
      }
      if (!input.projectId || upstreamEvidence.some((item) => {
        if (!item.project_id || !projectStorageIds?.has(item.project_id) || item.layer !== "L1") return true;
        if (item.kind === "turn") return !item.user_text?.trim() || !item.assistant_text?.trim();
        if (item.kind === "memory") return !item.content?.trim();
        return true;
      })) throw new Error("L2 job requires project-scoped L1 turn or Memory evidence");
      if (input.job.reason === "migration") {
        await validateMigrationL1EvidenceScope(input.runtime, input.projectId, input.job.evidence);
      }
      return structuredClone(input.job.evidence);
    }
    if (input.kind === "l3") {
      if (!input.projectId || input.job.evidence.some((item) => !item.project_id || !projectStorageIds?.has(item.project_id))) {
        throw new Error("L3 job evidence must be L2 from the same project");
      }
      return structuredClone(input.job.evidence);
    }
    const projects = new Set(input.job.evidence.map((item) => item.project_id).filter(Boolean));
    if (projects.size < 2) throw new Error("L4 job requires L3 evidence from at least two projects");
    return structuredClone(input.job.evidence);
  }

  if (input.kind === "l2") {
    if (!input.projectId) throw new Error("L2 evidence requires a resolved project");
    const projectStorageIds = new Set(await input.runtime.projects.storageIds(input.runtime.accountId, input.projectId));
    const captures = await readers.listCaptureEvents(input.stateRoot, input.runtime.accountId);
    const byId = new Map(captures.map((item) => [item.event_id, item]));
    const resolved: DistillationEvidenceItem[] = [];
    for (const ref of input.evidenceRefs) {
      const eventId = parseLayerEvidenceRef(ref, "l1");
      const event = byId.get(eventId);
      if (!event || !event.ingested || event.capture_status !== "complete" || !event.user_text?.trim() || !event.assistant_text?.trim()) {
        throw new Error(`L2 evidence does not resolve to a complete ingested L1 turn: ${ref}`);
      }
      if (!event.project_hint || !projectStorageIds.has(event.project_hint)) {
        throw new Error(`L2 evidence belongs to another or unresolved project: ${ref}`);
      }
      resolved.push({
        ref,
        kind: "turn",
        layer: "L1",
        timestamp: event.timestamp,
        project_id: event.project_hint,
        conversation_id: event.conversation_id,
        user_text: event.user_text.trim(),
        assistant_text: event.assistant_text.trim(),
        ...(event.reasoning_summary?.trim() ? { reasoning_summary: event.reasoning_summary.trim() } : {})
      });
    }
    return resolved;
  }

  const expectedLayer = input.kind === "l3" ? "L2" : "L3";
  const expectedPrefix = input.kind === "l3" ? "l2" : "l3";
  const projectStorageIds = input.kind === "l3" && input.projectId
    ? new Set(await input.runtime.projects.storageIds(input.runtime.accountId, input.projectId))
    : null;
  const jobs = await readers.listDistillationJobs(input.stateRoot, input.runtime.accountId);
  const candidateRefs = completedRevisionCandidates(jobs, expectedPrefix, projectStorageIds);
  const resolved: DistillationEvidenceItem[] = [];
  const projects = new Set<string>();

  for (const ref of input.evidenceRefs) {
    const parsed = parseVersionedLayerEvidenceRef(ref, expectedPrefix);
    if (!parsed) {
      throw exactEvidenceRefError({
        requiredLayer: expectedLayer,
        received: ref,
        projectId: input.projectId,
        expectedPrefix,
        candidateRefs
      });
    }
    const source = jobs.find((item) => item.job_id === parsed.revisionId);
    if (!source ||
        source.status !== "completed" ||
        source.target !== expectedPrefix ||
        source.result_kind !== expectedPrefix ||
        source.result_id !== parsed.memoryId ||
        !source.result_content?.trim() ||
        !distillationResultTimestamp(source)) {
      throw exactEvidenceRefError({
        requiredLayer: expectedLayer,
        received: ref,
        projectId: input.projectId,
        expectedPrefix,
        candidateRefs
      });
    }
    const project = source.project_id?.trim();
    if (!project) {
      throw new Error(`${expectedLayer} revision is missing project provenance: ${ref}`);
    }
    if (input.kind === "l3" && !projectStorageIds?.has(project)) {
      throw new Error(`L3 evidence belongs to another project: ${ref}`);
    }
    projects.add(project);
    resolved.push({
      ref,
      kind: "artifact",
      layer: expectedLayer,
      timestamp: distillationResultTimestamp(source)!,
      project_id: project,
      title: canonicalLayerTitle(expectedPrefix, project),
      content: source.result_content
    });
  }
  if (input.kind === "l4" && projects.size < 2) {
    throw new Error("L4 requires L3 evidence from at least two distinct projects");
  }
  return resolved;
}

export async function validateMigrationL1EvidenceScope(
  runtime: DistillationEvidenceDeps,
  projectId: string,
  evidence: DistillationJob["evidence"]
): Promise<void> {
  const storageIds = await runtime.projects.storageIds(runtime.accountId, projectId);
  const scopedMemoryIds = new Set<string>();
  for (const storageProjectId of storageIds) {
    for (let page = 1; page <= 100; page += 1) {
      const params = new URLSearchParams({
        userId: runtime.userId,
        projectId: storageProjectId,
        page: String(page),
        limit: "200"
      });
      const payload = objectRecord(await runtime.memoryClient.viewerGet(`/api/v1/l1?${params.toString()}`));
      const items = Array.isArray(payload.items) ? payload.items.map(objectRecord) : [];
      for (const item of items) {
        if (typeof item.id === "string" && item.id.trim()) scopedMemoryIds.add(item.id.trim());
      }
      if (payload.hasNext !== true) break;
    }
  }

  const scopedRawTurnIds = new Set<string>();
  for (const storageProjectId of storageIds) {
    for (let page = 1; page <= 100; page += 1) {
      const params = new URLSearchParams({
        userId: runtime.userId,
        projectId: storageProjectId,
        page: String(page),
        limit: "100"
      });
      const payload = objectRecord(await runtime.memoryClient.viewerGet(`/api/v1/raw-turns?${params.toString()}`));
      const items = Array.isArray(payload.items) ? payload.items.map(objectRecord) : [];
      for (const item of items) {
        if (typeof item.rawTurnId === "string" && item.rawTurnId.trim()) scopedRawTurnIds.add(item.rawTurnId.trim());
      }
      if (payload.hasNext !== true) break;
    }
  }

  for (const item of evidence) {
    if (item.kind === "memory") {
      const match = /^l1-memory:(.+)$/.exec(item.ref);
      if (!match?.[1] || !scopedMemoryIds.has(match[1])) {
        throw new Error(`migration L1 memory evidence is outside project scope: ${item.ref}`);
      }
      continue;
    }
    if (item.kind === "turn") {
      const match = /^raw-turn:(.+)$/.exec(item.ref);
      if (!match?.[1] || !scopedRawTurnIds.has(match[1])) {
        throw new Error(`migration raw-turn evidence is outside project scope: ${item.ref}`);
      }
    }
  }
}
