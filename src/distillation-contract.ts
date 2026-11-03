import { createHash } from "node:crypto";
import type { ContextItem } from "./context-capsule.js";
import { listDistillationJobs, type DistillationJob } from "./distillation-jobs.js";
import { validateGlobalStateContent } from "./global-state.js";
import { extractDistilledFactMetadata, factMetadataSummary, factProjectStorageIds, filterFactMetadataEvidence, verifiedFactEvidenceRefs, type FactProjectReader } from "./fact-metadata.js";

// This is the pure text sanitizer called by Core's sanitizeMemoryAddRequest.
const { sanitizeMemmyProtocolText } = await import(new URL(
  "../vendor/memory-core/src/utils/memmy-context-tags.js", import.meta.url
).href) as { sanitizeMemmyProtocolText: (body: string) => string };
export const canonicalDistillationBody = sanitizeMemmyProtocolText;

export function distillationRevisionBody(job: Pick<DistillationJob, "result_content" | "result_core_content_hash">): string {
  const content = job.result_content ?? "";
  if (!job.result_core_content_hash) return canonicalDistillationBody(content);
  if (createHash("sha256").update(content).digest("hex") !== job.result_core_content_hash) {
    throw new Error("exact evidenceRef unavailable: ledger Core body hash does not match its revision");
  }
  return content;
}

export const DISTILLATION_CONTRACT_VERSION = "memhub-distill-v4";

export const L2_FORMAT_RULE = "Write L2 as a dated chronology: one `## YYYY-MM-DD: Title EN / 标题` heading per real change or decision (a short range/time label before the colon is allowed), newest-last. Under each event, keep a short EN paragraph and the same facts in 简体中文; add `Canonical time:` when the evidence supports an absolute date/range, preserving any meaningful relative-time phrase without inventing precision; add compact `Atomic fact:` bullets for retrieval-sized facts, each grounded in the event's exact refs; mark state changes with `Supersedes:` when an earlier value/decision is explicitly replaced; finish with an `Evidence:` line containing the exact refs. Do not copy document sections, specs or READMEs as events; summarise what changed, when, and why. Merge trivial turns into the nearest real event; keep superseded decisions as history rather than deleting them.";

export const L3_CURRENT_TRUTH_RULE = "Write L3 Current Truth as compact durable `Atomic fact:` bullets rather than long narrative. Each current fact must remain traceable to exact immutable L2 evidence refs, and a changed fact should state the prior value/decision it supersedes when that history is supported. Preserve explicit temporal anchors that materially distinguish current state from historical state; do not invent dates or precision that the evidence does not support.";

const PROMPT_CONTAMINATION = [
  /generate\s+0\s+to\s+3\s+hyperpersonalized\s+suggestions/i,
  /expert\s+at\s+upholding\s+safety\s+and\s+compliance\s+standards/i,
  /system\s+prompt/i,
  /developer\s+prompt/i
];

export interface DistillationEvidence {
  evidenceRefs?: string[];
  sourceConversations?: string[];
  confidence?: number;
}

export function validateDurableMemoryContent(content: string): string {
  const normalized = content.trim();
  if (!normalized) throw new TypeError("memory content must be non-empty");
  if (PROMPT_CONTAMINATION.some((pattern) => pattern.test(normalized))) {
    throw new Error("memory content rejected: host/system/developer prompt contamination");
  }
  return normalized;
}

export function validateBilingualDistillationContent(content: string, kind: "l3" | "l4"): void {
  const prose = content.replace(/```[\s\S]*?```|`[^`]*`|https?:\/\/\S+|\b(?:l[1-4]|skill):\S+/giu, " ")
    .replace(/\b(?:EN|ZH|Evidence|References|Atomic fact|Canonical time|Supersedes)\s*[:：]/giu, " ")
    .replace(/(?:原子事实|证据|引用|中文|英文)\s*[:：]/gu, " ");
  if (!/[A-Za-z]{2}/u.test(prose) || !/[\u3400-\u9fff]/u.test(prose)) {
    throw new TypeError(`${kind.toUpperCase()} distillation requires both English and Chinese content`);
  }
}

/**
 * LITSAN deliberately does not perform semantic distillation here. The
 * connected harness/model produces the candidate; LITSAN only enforces the
 * storage contract and rejects known instruction/prompt contamination.
 */
export function validateDistillationCandidate(input: {
  kind: "l2" | "l3" | "l4" | "global_state" | "skill";
  content: string;
  evidence: DistillationEvidence;
}): void {
  validateDurableMemoryContent(input.content);
  if (input.evidence.confidence !== undefined &&
      (!Number.isFinite(input.evidence.confidence) || input.evidence.confidence < 0 || input.evidence.confidence > 1)) {
    throw new TypeError("confidence must be between 0 and 1");
  }
  for (const ref of [...(input.evidence.evidenceRefs ?? []), ...(input.evidence.sourceConversations ?? [])]) {
    if (!ref.trim() || ref.length > 1000) throw new TypeError("distillation evidence reference is invalid");
  }
  const evidenceRefs = input.evidence.evidenceRefs ?? [];
  if (input.kind !== "skill" && evidenceRefs.length === 0) {
    throw new TypeError(`${input.kind.toUpperCase()} distillation requires evidence_refs`);
  }
  if (input.kind === "l4" && evidenceRefs.length < 2) {
    throw new TypeError("L4 distillation requires evidence from at least two project L3 artifacts");
  }
  if (input.kind === "global_state") validateGlobalStateContent(input.content);
}

export function distillationContract() {
  return {
    version: DISTILLATION_CONTRACT_VERSION,
    executor: "connected_mcp_or_harness_model",
    memhub_role: "evidence_boundary_schema_validation_provenance_commit",
    rules: [
      L2_FORMAT_RULE,
      L3_CURRENT_TRUTH_RULE,
      "Ground claims in supplied or explicitly referenced evidence; do not invent user facts.",
      "Keep content source separate from the model/harness that performs distillation.",
      "Respect L1 source_kinds: user_said is direct user evidence; agent_inferred, tool_output, and imported are not direct user assertions and must not silently override user-confirmed L3 truth. Treat conflicts as evidence for review/candidate updates rather than automatic replacement.",
      "Do not turn system/developer prompts, tool schemas, safety policies, ambient suggestion prompts, or transient test instructions into user memory.",
      "Use project scope only when the project is explicit or deterministically conversation-bound.",
      "For L3 and L4, use exact immutable L2/L3 revision refs returned by LITSAN (for example l2:<memory-id>:<revision-id>); never rebuild evidence from a stable Memory id or silently resolve the latest revision.",
      "L2 is a project-scoped chronological development narrative derived from L1 turns; preserve sequence, state changes, decisions, current truth, and superseded history. Normalize relative time into evidence-supported absolute dates/ranges when possible while retaining the original expression, and expose retrieval-sized atomic facts inside the parent event instead of creating another durable memory layer. Routine L2 submits are full canonical timeline replacements: retain prior timeline events and merge the new L1 evidence; delta-only replacement content is invalid.",
      "L2 may also submit a Project Architecture Cognitive Map as a separate derived Project Architecture artifact. The map is not L1-L4 and does not replace the governed hard Architecture contract. Keep its abstraction at Project -> Domain/Layer -> Capability/Subsystem -> Process/Flow -> Method/Mechanism; stop before functions, APIs, parameters, files, or code. Every node, relation, and timeline link must retain evidence_refs and confidence. Use stable node IDs and submit the complete current map with the base fingerprint returned by action=next.",
      "When an L2 timeline event materially changes architecture, link that event to the affected architecture node(s), abstraction level, and change kind (add/refine/replace/remove/reroute). Do not infer causality from temporal adjacency alone.",
      "When producing L2, also provide a concise evidence-backed project description when the project objective/scope/current focus is supported; LITSAN stores it as distilled routing metadata without overwriting an explicit manual description.",
      "L3 is a project-scoped set of durable current facts, user rules, preferences, experience, and working habits derived from L2; do not promote one-off events without support. Keep current facts compact and evidence-linked, and retain explicit supersession information when an older state is replaced so retrieval can distinguish current truth from history.",
      "L4 is an account-scoped cross-project user profile derived from L3 artifacts; require repeated or cross-project evidence and do not infer sensitive traits.",
      "Global State is an account-scoped derived sidecar from explicitly keep_global L1 evidence. It is not L2, L4, or a fifth numbered memory layer. Keep a compact bilingual Current State Snapshot, Recent Transitions, and non-authoritative Profile Signals; one-off state never becomes stable identity merely by appearing here.",
      "Global State must not consume unresolved project evidence. Automation, agent-inferred and tool-output evidence may support operational state but cannot independently establish a stable user trait; synthetic recommendation prompts should be omitted when they add no user-authored fact.",
      "Skill is an executable reusable procedure and is orthogonal to L1-L4.",
      "Every Skill must use a stable artifact_id as source identity across revisions and a numeric dotted version; revisions replace/archive the prior current Skill instead of creating parallel active truths.",
      "Prefer a compact durable artifact over copying raw conversation text.",
      "Bilingual output (required for L2, L3, L4, Global State and project_description): write every distilled artifact natively in both English and Simplified Chinese, so collaborators who read only one language can hand over work. Keep each item paired: a bilingual heading (\"English / 中文\"), then the English text, then the Chinese text with the same facts, dates, numbers, identifiers, paths and commands. Do not translate code, file paths, commands, IDs, slugs, version strings or quoted evidence. Do not let the two languages drift: a fact present in one must be present in the other. When updating an existing Chinese-only artifact, keep its facts unchanged and add the missing language rather than rewriting history."
    ]
  };
}

export function exactDistillationRevisionForMemory(
  jobs: DistillationJob[], memory: { id: string; memoryLayer: string; body: string }
): DistillationJob {
  const hash = (body: string) => createHash("sha256").update(body).digest("hex");
  const source = jobs.filter((job) => job.status === "completed" && !job.result_retirement &&
    job.result_id === memory.id && job.result_kind === memory.memoryLayer.toLowerCase() &&
    job.target === job.result_kind && job.result_content &&
    hash(distillationRevisionBody(job)) === hash(memory.body))
    .sort((a, b) => (b.result_committed_at ?? b.completed_at ?? b.updated_at).localeCompare(
      a.result_committed_at ?? a.completed_at ?? a.updated_at))[0];
  if (!source) throw new Error(`exact evidenceRef unavailable: revision/content hash does not match Memory ${memory.id}`);
  return source;
}

export async function attachExactDistillationEvidenceRefs(input: {
  stateRoot: string; accountId: string; items: ContextItem[];
  projects?: FactProjectReader;
  readMemory: (id: string) => Promise<unknown>;
}): Promise<void> {
  const jobs = await listDistillationJobs(input.stateRoot, input.accountId);
  for (const item of input.items) {
    const layer = item.provenance?.memoryLayer;
    if (!["L2", "L3", "L4"].includes(String(layer))) continue;
    delete item.evidenceRef;
    if (!jobs.some((job) => job.result_kind !== "branch_draft" && job.result_id === item.id)) continue;
    try {
      const payload = await input.readMemory(item.id) as Record<string, unknown>;
      const memory = (payload.item ?? payload) as Record<string, unknown>;
      if (memory.id !== item.id || memory.memoryLayer !== layer || typeof memory.body !== "string") {
        throw new Error(`exact evidenceRef unavailable: Core revision identity is missing for Memory ${item.id}`);
      }
      const source = exactDistillationRevisionForMemory(jobs, { id: item.id, memoryLayer: String(layer), body: memory.body });
      item.evidenceRef = `${String(layer).toLowerCase()}:${item.id}:${source.job_id}`;
      const projectStorageIds = source.target === "l2"
        ? await factProjectStorageIds(input.projects, input.accountId, source.project_id)
        : [];
      const structuredFacts = filterFactMetadataEvidence(
        source.result_fact_metadata ?? extractDistilledFactMetadata(
          source.target, source.result_content ?? "", source.target === "l3" ? source.evidence_refs : []
        ),
        verifiedFactEvidenceRefs({ kind: source.target, accountId: input.accountId, projectId: source.project_id,
          projectStorageIds, evidence: source.evidence, jobs, asOf: source.result_committed_at ?? source.completed_at ?? source.updated_at })
      );
      item.provenance = {
        ...(item.provenance ?? {}),
        ...(structuredFacts ? { structuredFacts: factMetadataSummary(structuredFacts) } : {})
      };
      if (item.provenance) delete item.provenance.exactEvidenceError;
    } catch (error) {
      item.provenance = { ...item.provenance, exactEvidenceError: error instanceof Error ? error.message : String(error) };
    }
  }
}
