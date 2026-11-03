import { createHash } from "node:crypto";
import type { ContextItem } from "./contracts/context.js";
import type { DistillationEvidenceItem, DistillationJob } from "./contracts/distillation.js";
import type { StoredCaptureEvent } from "./capture.js";

export const GLOBAL_STATE_LAYER = "GlobalState" as const;
export const GLOBAL_STATE_TITLE = "Account Global State / 账号全局状态";
export const GLOBAL_STATE_REQUIRED_HEADINGS = [
  "## Current State Snapshot / 当前状态快照",
  "## Recent Transitions / 近期变化",
  "## Profile Signals / 画像信号"
] as const;

export function globalStateAdmission(event: Pick<StoredCaptureEvent, "user_text" | "provenance">): "admit" | "skip_noise" {
  const text = event.user_text?.trim().replace(/\s+/g, " ") ?? "";
  // Historical Projectless suggestion tasks were captured before every host
  // reliably stamped provenance.origin=automation. Their text is a generated
  // task instruction, not user-authored account state. Match the narrow task
  // shape itself so migration does not accidentally promote those prompts.
  const projectlessSuggestionTask = /^generate\b/i.test(text) &&
    /\bprojectless\b/i.test(text) &&
    /\bsuggestions?\b/i.test(text);
  const syntheticProjectlessSuggestion = projectlessSuggestionTask &&
    (event.provenance?.origin === "automation" || /\bconnected[- ]app activity\b/i.test(text));
  if (syntheticProjectlessSuggestion) return "skip_noise";
  return "admit";
}

export function globalStateArtifactId(accountId: string): string {
  const hash = createHash("sha256").update(accountId.trim(), "utf8").digest("hex").slice(0, 24);
  return `account_state_${hash}`;
}

export function globalStateEvidenceRef(job: Pick<DistillationJob, "job_id" | "result_id">): string {
  if (!job.result_id?.trim()) throw new Error("Global State revision is missing result id");
  return `global_state:${job.result_id}:${job.job_id}`;
}

export function parseGlobalStateEvidenceRef(ref: string): { artifactId: string; revisionId: string } | null {
  const match = /^global_state:([^:]+):([^:]+)$/.exec(ref.trim());
  return match?.[1] && match?.[2] ? { artifactId: match[1], revisionId: match[2] } : null;
}

export function latestCompletedGlobalState(jobs: readonly DistillationJob[]): DistillationJob | undefined {
  return jobs
    .filter((job) => job.target === "global_state" && job.status === "completed" &&
      job.result_kind === "global_state" && job.scope === "account" && job.project_id === null &&
      Boolean(job.result_id?.trim() && job.result_content?.trim()) && !job.result_retirement)
    .sort((left, right) => globalStateTimestamp(right).localeCompare(globalStateTimestamp(left)))[0];
}

export function globalStateTimestamp(job: Pick<DistillationJob, "result_committed_at" | "completed_at" | "updated_at">): string {
  return job.result_committed_at ?? job.completed_at ?? job.updated_at;
}

export function globalStateEvidenceItem(job: DistillationJob): DistillationEvidenceItem {
  return {
    ref: globalStateEvidenceRef(job),
    kind: "artifact",
    layer: GLOBAL_STATE_LAYER,
    timestamp: globalStateTimestamp(job),
    title: GLOBAL_STATE_TITLE,
    content: job.result_content!
  };
}

export function validateGlobalStateContent(content: string): void {
  for (const heading of GLOBAL_STATE_REQUIRED_HEADINGS) {
    if (!content.includes(heading)) {
      throw new Error(`Global State candidate is missing required section: ${heading}`);
    }
  }
}

export function globalStateContextItem(job: DistillationJob, matchedTerms: string[]): ContextItem {
  return {
    id: job.result_id!,
    evidenceRef: globalStateEvidenceRef(job),
    content: job.result_content!,
    authority: "observed",
    scope: "global",
    source: "memhub-global-state",
    createdAt: job.created_at,
    updatedAt: globalStateTimestamp(job),
    provenance: {
      memoryLayer: GLOBAL_STATE_LAYER,
      freshness: "derived-state",
      retrievalV1: { matchedTerms },
      artifact: "global_state"
    }
  };
}
