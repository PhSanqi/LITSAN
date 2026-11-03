import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { DistillationEvidenceItem } from "./contracts/distillation.js";

export type DistillationClaimAction =
  | "new"
  | "reinforce"
  | "supersede"
  | "refute"
  | "append_history"
  | "omit"
  | "uncertain";

export interface DistillationClaimTraceInput {
  claim_id: string;
  claim_key?: string;
  action: DistillationClaimAction;
  source_evidence_refs: string[];
  source_spans?: string[];
  previous_claim?: string;
  new_claim?: string;
  model_confidence?: number;
  validation_result?: string;
  repair_count?: number;
  reason?: string;
}

export function parseDistillationClaimTraces(value: unknown, allowedEvidenceRefs: readonly string[]): DistillationClaimTraceInput[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError("claim_traces must be an array");
  if (value.length > 200) throw new TypeError("claim_traces must contain at most 200 claims");
  const allowed = new Set(allowedEvidenceRefs);
  return value.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new TypeError(`claim_traces[${index}] must be an object`);
    const item = raw as Record<string, unknown>;
    const claimId = requiredString(item.claim_id, `claim_traces[${index}].claim_id`);
    const action = requiredString(item.action, `claim_traces[${index}].action`) as DistillationClaimAction;
    if (!["new", "reinforce", "supersede", "refute", "append_history", "omit", "uncertain"].includes(action)) {
      throw new TypeError(`claim_traces[${index}].action is invalid`);
    }
    const refs = stringArray(item.source_evidence_refs, `claim_traces[${index}].source_evidence_refs`);
    if (refs.length === 0) throw new TypeError(`claim_traces[${index}] requires source_evidence_refs`);
    for (const ref of refs) if (!allowed.has(ref)) {
      throw new Error(`claim_traces[${index}] references evidence outside the validated distillation evidence set: ${ref}`);
    }
    const confidence = optionalNumber(item.model_confidence, `claim_traces[${index}].model_confidence`);
    if (confidence !== undefined && (confidence < 0 || confidence > 1)) throw new TypeError("model_confidence must be between 0 and 1");
    const repairCount = optionalInteger(item.repair_count, `claim_traces[${index}].repair_count`);
    if (repairCount !== undefined && repairCount < 0) throw new TypeError("repair_count must be >= 0");
    return {
      claim_id: claimId,
      ...(optionalString(item.claim_key) ? { claim_key: optionalString(item.claim_key)! } : {}),
      action,
      source_evidence_refs: [...new Set(refs)],
      ...(Array.isArray(item.source_spans) ? { source_spans: item.source_spans.map((span, spanIndex) => requiredString(span, `source_spans[${spanIndex}]`)).slice(0, 32) } : {}),
      ...(optionalString(item.previous_claim) ? { previous_claim: optionalString(item.previous_claim)! } : {}),
      ...(optionalString(item.new_claim) ? { new_claim: optionalString(item.new_claim)! } : {}),
      ...(confidence !== undefined ? { model_confidence: confidence } : {}),
      ...(optionalString(item.validation_result) ? { validation_result: optionalString(item.validation_result)! } : {}),
      ...(repairCount !== undefined ? { repair_count: repairCount } : {}),
      ...(optionalString(item.reason) ? { reason: optionalString(item.reason)!.slice(0, 500) } : {})
    };
  });
}

export function validateDistillationTraceSpans(claims: readonly DistillationClaimTraceInput[], evidence: readonly DistillationEvidenceItem[]): void {
  for (const claim of claims) for (const span of claim.source_spans ?? []) {
    const found = evidence.some(item => claim.source_evidence_refs.includes(item.ref) &&
      [item.title, item.content, item.user_text, item.assistant_text, item.reasoning_summary, item.tool_summary]
        .some(value => typeof value === "string" && value.includes(span)));
    if (!found) throw new Error(`claim_traces ${claim.claim_id} source_spans must be exact text in the claim's cited evidence`);
  }
}

export async function recordDistillationTrace(input: {
  stateRoot: string;
  accountId: string;
  jobId?: string;
  targetLayer: "l2" | "l3" | "l4" | "skill";
  projectId: string | null;
  commitRevision?: string;
  claims: readonly DistillationClaimTraceInput[];
}): Promise<{ distillation_id: string; claims: number; stored: true }> {
  const distillationId = `dt_${randomUUID().replaceAll("-", "")}`;
  const record = {
    version: "distillation-claim-trace-v1",
    distillation_id: distillationId,
    job_id: input.jobId ?? null,
    target_layer: input.targetLayer,
    project_id: input.projectId,
    commit_revision: input.commitRevision ?? null,
    timestamp: new Date().toISOString(),
    claims: input.claims
  };
  const path = distillationTracePath(input.stateRoot, input.accountId);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await appendFile(path, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
  return { distillation_id: distillationId, claims: input.claims.length, stored: true };
}

function distillationTracePath(stateRoot: string, accountId: string): string {
  const hash = createHash("sha256").update(accountId, "utf8").digest("hex").slice(0, 24);
  return join(resolve(stateRoot), "telemetry", `distillation-${hash}.jsonl`);
}

function requiredString(value: unknown, field: string): string {
  const normalized = optionalString(value);
  if (!normalized) throw new TypeError(`${field} is required`);
  if (normalized.length > 8_000) throw new TypeError(`${field} is too long`);
  return normalized;
}
function optionalString(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
  return value.map((item, index) => requiredString(item, `${field}[${index}]`));
}
function optionalNumber(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError(`${field} must be a finite number`);
  return value;
}
function optionalInteger(value: unknown, field: string): number | undefined {
  const number = optionalNumber(value, field);
  if (number === undefined) return undefined;
  if (!Number.isInteger(number)) throw new TypeError(`${field} must be an integer`);
  return number;
}
