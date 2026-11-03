import { listCaptureEvents } from "./capture.js";
import { listDistillationJobs } from "./distillation-jobs.js";
import { validateDistillationEvidenceChain as validateChain } from "./core/lifecycle/distillation-evidence.js";
import { parseLayerEvidenceRef } from "./core/lifecycle/evidence-refs.js";
import { resolveCaptureProject } from "./capture-project-resolution.js";
import { globalStateEvidenceRef, latestCompletedGlobalState, parseGlobalStateEvidenceRef } from "./global-state.js";
import type { DistillationEvidenceItem } from "./contracts/distillation.js";
import type { ProjectReader } from "./core/ports/projects.js";
import type { AccountId, UserId } from "./contracts/identity.js";
import type { MemoryViewerReader } from "./core/ports/memory.js";
export type { DistillationEvidenceDeps } from "./core/lifecycle/distillation-evidence.js";
export { validateMigrationL1EvidenceScope } from "./core/lifecycle/distillation-evidence.js";
export { completedRevisionCandidates, exactEvidenceRefError, parseVersionedLayerEvidenceRef, parseLayerEvidenceRef } from "./core/lifecycle/evidence-refs.js";

type OuterEvidenceInput = Omit<Parameters<typeof validateChain>[0], "kind" | "runtime"> & {
  kind: "l2" | "l3" | "l4" | "global_state" | "skill";
  runtime: {
    projects: Pick<ProjectReader, "storageIds" | "resolve">;
    accountId: AccountId;
    userId: UserId;
    memoryClient: MemoryViewerReader;
  };
};

export async function validateDistillationEvidenceChain(input: OuterEvidenceInput): Promise<DistillationEvidenceItem[]> {
  if (input.kind === "global_state") return validateGlobalStateEvidenceChain(input);
  return validateChain({
    ...input,
    kind: input.kind as "l2" | "l3" | "l4" | "skill"
  }, { listCaptureEvents, listDistillationJobs });
}

async function validateGlobalStateEvidenceChain(input: OuterEvidenceInput): Promise<DistillationEvidenceItem[]> {
  if (!input.job) throw new Error("Global State submission requires a leased discovery job");
  if (input.projectId !== null || input.job.project_id !== null || input.job.scope !== "account") {
    throw new Error("Global State must be account-scoped");
  }
  const jobs = await listDistillationJobs(input.stateRoot, input.runtime.accountId);
  const current = latestCompletedGlobalState(jobs);
  const baseItems = input.job.evidence.filter((item) => item.layer === "GlobalState");
  const turnItems = input.job.evidence.filter((item) => item.layer === "L1");
  if (baseItems.length > 1 || baseItems.length + turnItems.length !== input.job.evidence.length || turnItems.length === 0) {
    throw new Error("Global State job must contain optional exact Global State base plus explicit-global L1 turns");
  }
  if (current) {
    const base = baseItems[0];
    const parsed = base && parseGlobalStateEvidenceRef(base.ref);
    if (!base || !parsed || parsed.revisionId !== current.job_id || parsed.artifactId !== current.result_id ||
        base.kind !== "artifact" || base.content !== current.result_content ||
        base.timestamp !== (current.result_committed_at ?? current.completed_at ?? current.updated_at) ||
        base.ref !== globalStateEvidenceRef(current)) {
      throw new Error("Global State job base is stale or does not match the current canonical revision");
    }
  } else if (baseItems.length > 0) {
    throw new Error("Global State job contains a base but no canonical Global State revision exists");
  }
  const captures = await listCaptureEvents(input.stateRoot, input.runtime.accountId);
  const byId = new Map(captures.map((event) => [event.event_id, event]));
  for (const item of turnItems) {
    const eventId = parseLayerEvidenceRef(item.ref, "l1");
    const event = byId.get(eventId);
    if (!event || !event.ingested || event.capture_status !== "complete" || !event.user_text?.trim() || !event.assistant_text?.trim()) {
      throw new Error(`Global State evidence does not resolve to a complete ingested L1 turn: ${item.ref}`);
    }
    const resolution = await resolveCaptureProject(event,
      (ref) => input.runtime.projects.resolve(input.runtime.accountId, ref), input.stateRoot);
    if (resolution.source !== "keep_global" || resolution.projectId !== null) {
      throw new Error(`Global State evidence is no longer explicitly keep_global: ${item.ref}`);
    }
  }
  return structuredClone(input.job.evidence);
}
