import type { ContextCapsule, ContextItem } from "./context-capsule.js";
import { tokenizeRetrievalText } from "../retrieval/ranker.js";
import type { DistilledFactMetadataSet } from "../../contracts/distillation.js";

export type TurnKnowledgeRole = "required" | "supporting";
export type TurnKnowledgeKind = "L1" | "L2" | "L3" | "L4" | "GlobalState" | "architecture" | "skill";

export interface TurnKnowledgePassage {
  heading?: string;
  text: string;
  matched_terms: string[];
  score: number;
  fact_id?: string;
  parent_id?: string;
}

export interface TurnKnowledgeEntry {
  role: TurnKnowledgeRole;
  kind: TurnKnowledgeKind;
  id: string;
  project_id?: string;
  evidence_ref?: string;
  reason: string;
  use?: string;
  passages?: TurnKnowledgePassage[];
  passage_headings?: string[];
  load?: {
    tool: "litsan_skill";
    action: "load";
    skill_id: string;
  };
}

export interface TurnKnowledgePlan {
  version: "turn-knowledge-plan-v1";
  mode: "deterministic-existing-retrieval";
  persistence: "none";
  model_calls: 0;
  required: TurnKnowledgeEntry[];
  supporting: TurnKnowledgeEntry[];
  evidence_on_demand: {
    purpose: "why_or_provenance_only";
    rule?: string;
    tool: "litsan_memory";
    action: "why";
    candidate_evidence_refs: string[];
  };
  coverage: {
    project_resolved: boolean;
    recall_scope: ContextCapsule["recallScope"];
    current_truth_found: boolean;
    architecture_relevant: boolean;
    context_truncated_items: number;
    context_dropped_items: number;
    passage_bytes: number;
    hydrated_full_revisions: number;
    hydration_failures: number;
    retrieval_degraded: boolean;
    core_status: string[];
    omitted_items: number;
  };
  sufficiency: "unknown" | "partial";
  evidence_sufficiency?: TurnKnowledgeEvidenceSufficiency;
  context_packing?: TurnKnowledgeContextPacking;
  rules?: string[];
}

export interface DerivedFactPlanHit {
  fact_id: string;
  parent_id: string;
  score: number;
  semantic_score?: number;
  lexical_score?: number;
  matched_terms?: string[];
  series_id?: string;
  series_kind?: "entity_timeline" | "entity_topic" | "supersession";
  series_relation?: "seed" | "neighbor" | "time_window" | "ordered_series";
  series_distance?: number;
  temporal_time?: {
    raw: string;
    precision: "date" | "month" | "year" | "range" | "unknown";
    start?: string;
    end?: string;
    original_expression?: string;
    source: "canonical" | "relative_evidence" | "evidence_timestamp";
    confidence: number;
    answerable: boolean;
  };
}

export interface AdaptiveEvidenceCandidate {
  evidence_ref: string;
  text: string;
  score: number;
  matched_terms?: string[];
}

export interface TurnKnowledgeEvidenceSufficiency {
  version: "evidence-sufficiency-v1";
  status: "sufficient" | "partial" | "insufficient";
  query_terms: string[];
  matched_terms: string[];
  lexical_coverage: number;
  grounded_passages: number;
  adaptive_evidence_used: boolean;
  reason: string;
}

export interface TurnKnowledgeContextPacking {
  version: "adaptive-context-packing-v1";
  base_bytes: 4000;
  expanded_bytes: 6000;
  max_bytes: 8000;
  recommended_bytes: 4000 | 6000 | 8000;
}

export interface PackedTurnKnowledgeSection {
  id: string;
  role: TurnKnowledgeRole | "fallback";
  kind: TurnKnowledgeKind | "projectMemory";
  source: "turn_knowledge_plan" | "project_memory";
  text: string;
  score: number;
  evidence_ref?: string;
}

export interface PackedTurnKnowledgeContext {
  version: "adaptive-context-pack-v1";
  stage: "base_4k" | "expanded_6k" | "max_8k";
  budget_bytes: number;
  used_bytes: number;
  context: string;
  sections: PackedTurnKnowledgeSection[];
  evidence_sufficiency: TurnKnowledgeEvidenceSufficiency;
}

export interface BuildTurnKnowledgePlanInput {
  query: string;
  capsule: ContextCapsule;
  hydrateEvidence?: (evidenceRef: string) => Promise<{ content: string; factMetadata?: DistilledFactMetadataSet } | null>;
  detail?: "brief" | "full";
  dedupe?: boolean;
  adaptiveEvidence?: readonly AdaptiveEvidenceCandidate[];
  policy?: Partial<TurnKnowledgePolicy>;
}

export interface TurnKnowledgePolicy {
  maxPassagesPerEntry: number;
  maxPassageChars: number;
  maxRequiredEntries: number;
  maxSupportingEntries: number;
  maxArchitectureEntries: number;
  maxFreshL1Entries: number;
  freshL1RelevantOnly: boolean;
  freshL1Role: "required" | "supporting";
  supportingSelection: "current" | "balanced" | "score";
  passageWindow: "head" | "matched";
  trustAdmittedArchitecture: boolean;
  trustAdmittedSupporting: boolean;
}

export interface PassageCandidate {
  heading?: string;
  text: string;
}

const MAX_PASSAGES_PER_ENTRY = 3;
const MAX_PASSAGE_CHARS = 900;
const MAX_REQUIRED_ENTRIES = 4;
const MAX_SUPPORTING_ENTRIES = 4;
const SUPPORTING_PASSAGE_DUPLICATE_JACCARD = 0.8;
const TYPED_FACT_RARITY_WEIGHT = 0.25;
const PASSAGE_QUERY_STOPWORDS = new Set([
  "a", "an", "and", "are", "at", "current", "did", "do", "does", "for", "from",
  "how", "in", "is", "now", "of", "on", "or", "the", "to", "was", "were",
  "what", "when", "where", "which", "who", "why", "with"
]);
const TEMPORAL_QUERY_TERMS = new Set([
  "when", "date", "time", "year", "month", "day", "before", "after", "earlier", "later",
  "什么时候", "何时", "日期", "时间", "哪年", "哪月", "哪天", "之前", "之后", "以前", "后来"
]);
const STATE_QUERY_TERMS = new Set([
  "current", "latest", "now", "previous", "before", "changed", "change", "superseded", "supersedes",
  "当前", "现在", "最新", "之前", "以前", "原来", "变更", "改变", "取代", "替代"
]);

export const DEFAULT_TURN_KNOWLEDGE_POLICY: Readonly<TurnKnowledgePolicy> = Object.freeze({
  maxPassagesPerEntry: MAX_PASSAGES_PER_ENTRY,
  maxPassageChars: MAX_PASSAGE_CHARS,
  maxRequiredEntries: MAX_REQUIRED_ENTRIES,
  maxSupportingEntries: MAX_SUPPORTING_ENTRIES,
  maxArchitectureEntries: 2,
  maxFreshL1Entries: Number.MAX_SAFE_INTEGER,
  freshL1RelevantOnly: false,
  freshL1Role: "supporting",
  supportingSelection: "current",
  passageWindow: "matched",
  trustAdmittedArchitecture: false,
  trustAdmittedSupporting: false
});

/**
 * Builds a small advisory plan above the existing Context Capsule.
 *
 * It intentionally does not create another memory layer, index, cache or
 * semantic model call. Existing retrieval establishes legal scope and item
 * relevance; this helper only assigns turn-local roles and chooses bounded
 * passages with the same lexical terms already used by Retrieval v1.
 */
export async function buildTurnKnowledgePlan(input: BuildTurnKnowledgePlanInput): Promise<TurnKnowledgePlan> {
  const query = input.query.trim();
  const capsule = input.capsule;
  const policy = normalizePolicy(input.policy);
  const queryTerms = turnQueryTerms(query, capsule);
  const typedFactFocusTerms = queryTypedFactFocusTerms(query);
  const hydrated = new Map<string, { content: string; factMetadata?: DistilledFactMetadataSet }>();
  let hydrationFailures = 0;

  const topL3 = capsule.projectMemory.find((item) => memoryLayer(item) === "L3");
  const topL2 = capsule.projectMemory.find((item) => memoryLayer(item) === "L2");
  const hydrationTargets = [topL3, topL2]
    .filter((item): item is ContextItem => Boolean(item?.evidenceRef && input.hydrateEvidence));

  await Promise.all(hydrationTargets.map(async (item) => {
    try {
      const result = await input.hydrateEvidence!(item.evidenceRef!);
      if (result?.content.trim()) hydrated.set(item.evidenceRef!, {
        content: result.content.trim(),
        ...(result.factMetadata ? { factMetadata: result.factMetadata } : {})
      });
    } catch {
      hydrationFailures += 1;
    }
  }));

  const required: TurnKnowledgeEntry[] = [];
  const supporting: TurnKnowledgeEntry[] = [];
  let omittedItems = 0;

  if (topL3) {
    required.push(memoryEntry({
      item: topL3,
      role: "required",
      kind: "L3",
      reason: "project_current_truth",
      use: "Use as project Current Truth/rules within the resolved project. It outranks L2 chronology and L4 preferences when they conflict.",
      queryTerms,
      typedFactFocusTerms,
      fullContent: topL3.evidenceRef ? hydrated.get(topL3.evidenceRef)?.content : undefined,
      factMetadata: topL3.evidenceRef ? hydrated.get(topL3.evidenceRef)?.factMetadata : undefined,
      factRetrievalHits: derivedFactHits(topL3),
      fallback: "retrieval",
      maxPassages: policy.maxPassagesPerEntry,
      maxPassageChars: policy.maxPassageChars,
      passageWindow: policy.passageWindow
    }));
  }

  const architectureEntries = capsule.projectArchitecture
    .map((item) => {
      const passages = selectPassages(
        item.content,
        queryTerms,
        matchedTerms(item),
        policy.trustAdmittedArchitecture ? "retrieval" : "none",
        undefined,
        policy.maxPassagesPerEntry,
        policy.maxPassageChars,
        policy.passageWindow
      );
      return { item, passages, score: passages[0]?.score ?? 0 };
    })
    .filter((candidate) => candidate.score > 0 || (policy.trustAdmittedArchitecture && candidate.passages.length > 0))
    .sort((left, right) => right.score - left.score || left.item.id.localeCompare(right.item.id))
    .slice(0, policy.maxArchitectureEntries);
  for (const candidate of architectureEntries) {
    const derived = candidate.item.authority === "derived" || candidate.item.source === "project-architecture-cognitive-map";
    const entry: TurnKnowledgeEntry = {
      role: derived ? "supporting" : "required",
      kind: "architecture",
      id: candidate.item.id,
      ...(candidate.item.projectId ? { project_id: candidate.item.projectId } : {}),
      reason: derived ? "query_relevant_derived_architecture_map" : "query_relevant_project_architecture",
      use: derived
        ? "Use as an evidence-backed project mental model for navigation and structural understanding. It is derived and must not override the governed Project Architecture contract or L3 Current Truth."
        : "Treat as authoritative structural/source-of-truth constraints for implementation. Do not infer business memory from it.",
      passages: candidate.passages
    };
    (derived ? supporting : required).push(entry);
  }

  let freshL1Entries = 0;
  for (const item of capsule.projectMemory) {
    if (item.provenance?.memoryLayer !== "L1" || item.provenance.freshness !== "undistilled") continue;
    const terms = matchedTerms(item);
    if (policy.freshL1RelevantOnly && terms.length === 0) {
      omittedItems += 1;
      continue;
    }
    if (freshL1Entries >= policy.maxFreshL1Entries) {
      omittedItems += 1;
      continue;
    }
    freshL1Entries += 1;
    const entry = memoryEntry({
      item,
      role: policy.freshL1Role,
      kind: "L1",
      reason: "undistilled_turn_evidence",
      use: "Recent undistilled turn evidence. Check its provenance; it does not override L3 Current Truth/rules.",
      queryTerms,
      fallback: "retrieval",
      maxPassages: policy.maxPassagesPerEntry,
      maxPassageChars: policy.maxPassageChars,
      passageWindow: policy.passageWindow
    });
    (policy.freshL1Role === "required" ? required : supporting).push(entry);
  }

  const hasStructuralAdaptiveEvidence = (input.adaptiveEvidence ?? [])
    .some((candidate) => candidate.text.trimStart().startsWith("[Event family "));

  if (topL2 && !hasStructuralAdaptiveEvidence) {
    supporting.push(memoryEntry({
      item: topL2,
      role: "supporting",
      kind: "L2",
      reason: "project_chronology_and_recent_change",
      use: "Use for chronology, recent changes and how the project reached its current state. Do not let L2 override L3 Current Truth.",
      queryTerms,
      typedFactFocusTerms,
      fullContent: topL2.evidenceRef ? hydrated.get(topL2.evidenceRef)?.content : undefined,
      factMetadata: topL2.evidenceRef ? hydrated.get(topL2.evidenceRef)?.factMetadata : undefined,
      factRetrievalHits: derivedFactHits(topL2),
      fallback: "latest",
      maxPassages: policy.maxPassagesPerEntry,
      maxPassageChars: policy.maxPassageChars,
      passageWindow: policy.passageWindow
    }));
  }

  for (const candidate of input.adaptiveEvidence ?? []) {
    const text = candidate.text.trim();
    if (!text || !candidate.evidence_ref.trim()) continue;
    const eventFamilyTemporal = text.startsWith("[Event family ");
    const normalizedTemporal = text.startsWith("[Event series temporal normalization:");
    const structuralTemporal = eventFamilyTemporal || normalizedTemporal;
    supporting.push({
      role: "supporting",
      kind: "L1",
      id: `adaptive:${candidate.evidence_ref}`,
      evidence_ref: candidate.evidence_ref,
      reason: structuralTemporal ? "adaptive_structural_temporal_evidence" : "adaptive_evidence_hydration",
      use: structuralTemporal
        ? eventFamilyTemporal
          ? "Bounded exact L1 temporal event-family evidence. Use the grouped members together for order, interval or window reasoning; it remains supporting evidence and does not override Current Truth."
          : "Bounded exact L1 evidence with source-grounded temporal normalization. Use the normalized time together with the raw statement; it remains supporting evidence and does not override Current Truth."
        : "Exact raw evidence admitted only because the derived fact bundle was not sufficient. Use it to ground missing details without overriding Current Truth.",
      passages: [{
        text: boundText(text, Math.max(policy.maxPassageChars, 1200)),
        matched_terms: (candidate.matched_terms ?? []).slice(0, 16),
        score: Math.max(0, candidate.score) * 100
      }]
    });
  }

  for (const item of capsule.globalState) {
    const layer = memoryLayer(item);
    const terms = matchedTerms(item);
    if (terms.length === 0 && !policy.trustAdmittedSupporting) {
      omittedItems += 1;
      continue;
    }
    const isFresh = layer === "L1" && item.provenance?.freshness === "undistilled";
    supporting.push(memoryEntry({
      item,
      role: "supporting",
      kind: isFresh ? "L1" : "GlobalState",
      reason: isFresh ? "fresh_explicit_global_evidence" : "relevant_account_global_state",
      use: isFresh
        ? "Recent explicit-global L1 evidence. Use as current account context only; it does not establish a stable trait or override L4/L3."
        : "Use as current account-level state and recent transitions. Global State is supporting context below L4 stable profile and project L3 Current Truth; Profile Signals remain non-authoritative candidates.",
      queryTerms,
      fallback: "retrieval",
      maxPassages: policy.maxPassagesPerEntry,
      maxPassageChars: policy.maxPassageChars,
      passageWindow: policy.passageWindow
    }));
  }

  for (const item of capsule.globalMemory) {
    if (memoryLayer(item) !== "L4") continue;
    const terms = matchedTerms(item);
    if (terms.length === 0 && !policy.trustAdmittedSupporting) {
      omittedItems += 1;
      continue;
    }
    supporting.push(memoryEntry({
      item,
      role: "supporting",
      kind: "L4",
      reason: "relevant_cross_project_stable_preference",
      use: "Use only when the stable cross-project preference materially affects this turn. It does not override project-specific L3 rules.",
      queryTerms,
      fallback: "retrieval",
      maxPassages: policy.maxPassagesPerEntry,
      maxPassageChars: policy.maxPassageChars,
      passageWindow: policy.passageWindow
    }));
  }

  for (const item of capsule.reusableSkills) {
    const terms = matchedTerms(item);
    if (terms.length === 0 && !policy.trustAdmittedSupporting) {
      omittedItems += 1;
      continue;
    }
    supporting.push({
      role: "supporting",
      kind: "skill",
      id: item.id,
      ...(item.projectId ? { project_id: item.projectId } : {}),
      reason: "workflow_candidate_only",
      use: "Load only if the workflow matches the requested task. A Skill is procedure, not business fact or Current Truth.",
      passages: selectPassages(
        item.content,
        queryTerms,
        terms,
        "retrieval",
        undefined,
        policy.maxPassagesPerEntry,
        policy.maxPassageChars,
        policy.passageWindow
      ),
      load: { tool: "litsan_skill", action: "load", skill_id: item.id }
    });
  }

  const orderedSupporting = orderSupporting(
    supporting,
    input.adaptiveEvidence?.length ? "score" : policy.supportingSelection
  );
  const boundedRequired = required.slice(0, policy.maxRequiredEntries);
  const supportingLimit = input.adaptiveEvidence?.length
    ? Math.max(policy.maxSupportingEntries, Math.min(8, policy.maxSupportingEntries + input.adaptiveEvidence.length))
    : policy.maxSupportingEntries;
  const boundedSupporting = dedupeSupportingPassages(
    boundedRequired,
    orderedSupporting
  ).slice(0, supportingLimit);
  omittedItems += Math.max(0, required.length - boundedRequired.length);
  omittedItems += Math.max(0, orderedSupporting.length - boundedSupporting.length);

  const evidenceRefs = uniqueStrings([
    ...boundedRequired.map((entry) => entry.evidence_ref),
    ...boundedSupporting.map((entry) => entry.evidence_ref)
  ].filter((value): value is string => Boolean(value)));
  const passageBytes = [...boundedRequired, ...boundedSupporting]
    .flatMap((entry) => entry.passages ?? [])
    .reduce((total, passage) => total + (passage ? Buffer.byteLength(passage.text, "utf8") : 0), 0);
  const coreStatus = capsule.retrievalDiagnostics?.coreStatus ?? [];
  const retrievalDegraded = coreStatus.some((status) => /failed|degraded|fallback/.test(status));
  const partial = capsule.ambiguities.length > 0 ||
    capsule.contextBudget.truncatedItems > 0 ||
    capsule.contextBudget.droppedItems > 0 ||
    hydrationFailures > 0 ||
    retrievalDegraded;

  const rawPlan: TurnKnowledgePlan = {
    version: "turn-knowledge-plan-v1",
    mode: "deterministic-existing-retrieval",
    persistence: "none",
    model_calls: 0,
    required: boundedRequired,
    supporting: boundedSupporting,
    evidence_on_demand: {
      purpose: "why_or_provenance_only",
      ...(input.detail !== "brief" ? {
        rule: "Use WHY/L1 evidence only when the user asks why, provenance is disputed, memories conflict, or the model needs to distinguish direct reason from contextual candidate/unknown. Temporal adjacency alone is not causality."
      } : {}),
      tool: "litsan_memory",
      action: "why",
      candidate_evidence_refs: evidenceRefs.slice(0, 6)
    },
    coverage: {
      project_resolved: capsule.resolvedProjectId !== null,
      recall_scope: capsule.recallScope,
      current_truth_found: Boolean(topL3),
      architecture_relevant: architectureEntries.length > 0,
      context_truncated_items: capsule.contextBudget.truncatedItems,
      context_dropped_items: capsule.contextBudget.droppedItems,
      passage_bytes: passageBytes,
      hydrated_full_revisions: hydrated.size,
      hydration_failures: hydrationFailures,
      retrieval_degraded: retrievalDegraded,
      core_status: coreStatus,
      omitted_items: omittedItems
    },
    sufficiency: partial ? "partial" : "unknown",
    ...(input.detail !== "brief" ? {
      rules: [
        "required: use as current/authoritative guidance within its declared scope.",
        "supporting: use for chronology, stable preference or workflow context; it must not silently override required knowledge.",
        "evidence_on_demand: descend to WHY/L1 only when the reason or provenance matters; do not eagerly inject raw evidence.",
        "LITSAN organizes evidence and scope; the connected Harness remains responsible for semantic judgment and deciding whether more context is needed."
      ]
    } : {})
  };

  const planned = input.dedupe ? dedupeTurnKnowledgePlan(rawPlan, capsule) : rawPlan;
  return annotateTurnKnowledgeEvidence(planned, query, Boolean(input.adaptiveEvidence?.length));
}

/**
 * Evidence sufficiency is intentionally a bounded deterministic signal, not a
 * second semantic judge. It answers only whether the selected evidence bundle
 * appears strong enough to stop expanding context for this turn.
 */
export function annotateTurnKnowledgeEvidence(
  plan: TurnKnowledgePlan,
  query: string,
  adaptiveEvidenceUsed = false
): TurnKnowledgePlan {
  const queryTerms = knowledgeQueryTerms(query);
  const passages = [...plan.required, ...plan.supporting]
    .flatMap((entry) => (entry.passages ?? []).map((passage) => ({ entry, passage })));
  const grounded = passages.filter(({ entry, passage }) =>
    entry.reason === "adaptive_evidence_hydration" ||
    /Atomic fact:/iu.test(passage.text) ||
    entry.kind === "L1"
  );
  const matchedTerms = uniqueStrings(grounded.flatMap(({ passage }) => [
    ...passage.matched_terms,
    ...matchedKnowledgeTerms(passage.text, queryTerms)
  ]));
  const coveredQueryTerms = queryTerms.filter((term) =>
    matchedTerms.some((matched) => comparableTerm(matched) === comparableTerm(term))
  );
  const lexicalCoverage = queryTerms.length > 0 ? coveredQueryTerms.length / queryTerms.length : 0;
  const topScore = Math.max(0, ...grounded.map(({ passage }) => passage.score));
  let status: TurnKnowledgeEvidenceSufficiency["status"];
  let reason: string;
  if (grounded.length > 0 && topScore >= 60 && (lexicalCoverage >= 0.4 || matchedTerms.length >= Math.min(3, queryTerms.length))) {
    status = "sufficient";
    reason = "high-scoring grounded passages cover the main query anchors";
  } else if (grounded.length > 0 && (topScore >= 45 || lexicalCoverage >= 0.2 || matchedTerms.length > 0)) {
    status = "partial";
    reason = "grounded evidence is relevant but some query anchors remain weakly covered";
  } else {
    status = "insufficient";
    reason = "the selected evidence bundle lacks a strong grounded match";
  }
  const recommended: 4000 | 6000 | 8000 = status === "sufficient" && !adaptiveEvidenceUsed
    ? 4000
    : status === "insufficient"
      ? 8000
      : 6000;
  return {
    ...plan,
    evidence_sufficiency: {
      version: "evidence-sufficiency-v1",
      status,
      query_terms: queryTerms,
      matched_terms: matchedTerms.slice(0, 24),
      lexical_coverage: roundScore(lexicalCoverage),
      grounded_passages: grounded.length,
      adaptive_evidence_used: adaptiveEvidenceUsed,
      reason
    },
    context_packing: {
      version: "adaptive-context-packing-v1",
      base_bytes: 4000,
      expanded_bytes: 6000,
      max_bytes: 8000,
      recommended_bytes: recommended
    }
  };
}

/**
 * Pack the host-facing answer context from TKP passages first, then bounded
 * project-memory fallbacks. The byte ceiling is a hard fence; callers cannot
 * silently turn adaptive expansion into an unbounded context dump.
 */
export function packTurnKnowledgeContext(input: {
  query: string;
  plan: TurnKnowledgePlan;
  projectMemory?: readonly ContextItem[];
  maxBytes?: number;
}): PackedTurnKnowledgeContext {
  const annotated = input.plan.evidence_sufficiency && input.plan.context_packing
    ? input.plan
    : annotateTurnKnowledgeEvidence(input.plan, input.query);
  const recommended = annotated.context_packing?.recommended_bytes ?? 4000;
  const budget = Math.max(1000, Math.min(8000, Math.trunc(input.maxBytes ?? recommended)));
  const stage: PackedTurnKnowledgeContext["stage"] = budget <= 4000
    ? "base_4k"
    : budget <= 6000
      ? "expanded_6k"
      : "max_8k";

  const planSections = planContextSections(annotated);
  const fallbackSections = (input.projectMemory ?? []).map((item, index): PackedTurnKnowledgeSection => ({
    id: item.id,
    role: "fallback",
    kind: "projectMemory",
    source: "project_memory",
    text: item.content,
    score: Number((item.provenance?.retrievalV1 as { fusedScore?: number } | undefined)?.fusedScore ??
      item.provenance?.score ?? Math.max(0, 1 - index / 100)),
    ...(item.evidenceRef ? { evidence_ref: item.evidenceRef } : {})
  }));
  const seen = new Set<string>();
  const selected: PackedTurnKnowledgeSection[] = [];
  let remaining = budget;
  for (const section of [...planSections, ...fallbackSections]) {
    const key = normalizeComparableText(section.text);
    if (!key || seen.has(key)) continue;
    const prefix = `[${section.role}/${section.kind}/${section.source}]\n`;
    const prefixBytes = Buffer.byteLength(prefix, "utf8");
    if (remaining <= prefixBytes + 32) continue;
    const text = boundUtf8(section.text, remaining - prefixBytes);
    if (!text) continue;
    const renderedBytes = prefixBytes + Buffer.byteLength(text, "utf8");
    selected.push({ ...section, text });
    seen.add(key);
    remaining -= renderedBytes;
    if (remaining <= 64) break;
  }
  const context = selected.map((section) =>
    `[${section.role}/${section.kind}/${section.source}]\n${section.text}`
  ).join("\n\n");
  return {
    version: "adaptive-context-pack-v1",
    stage,
    budget_bytes: budget,
    used_bytes: Buffer.byteLength(context, "utf8"),
    context,
    sections: selected,
    evidence_sufficiency: annotated.evidence_sufficiency!
  };
}

function planContextSections(plan: TurnKnowledgePlan): PackedTurnKnowledgeSection[] {
  const entries = [...plan.required, ...plan.supporting];
  const sections = entries.flatMap((entry) => (entry.passages ?? []).map((passage, index): PackedTurnKnowledgeSection => ({
    id: `${entry.id}:p${index}`,
    role: entry.role,
    kind: entry.kind,
    source: "turn_knowledge_plan",
    text: passage.text,
    score: passage.score,
    ...(entry.evidence_ref ? { evidence_ref: entry.evidence_ref } : {})
  })));
  const priority = (section: PackedTurnKnowledgeSection): number => {
    if (section.role === "required") return 0;
    const entry = entries.find((candidate) => section.id.startsWith(`${candidate.id}:`) && candidate.reason === "adaptive_structural_temporal_evidence");
    if (entry) return 0.5;
    // Ordinary supporting L1 and evidence-backed L2 passages compete on the
    // relevance score already assigned by TKP. A hard L1-before-L2 ordering
    // can otherwise let several generic raw observations exhaust a bounded
    // context before a higher-scoring typed L2 fact that directly answers the
    // query. Structural temporal evidence stays ahead of both.
    if (section.kind === "L1" || section.kind === "L2") return 1;
    return 2;
  };
  return sections.sort((left, right) =>
    priority(left) - priority(right) || right.score - left.score || left.id.localeCompare(right.id)
  );
}

function knowledgeQueryTerms(query: string): string[] {
  return uniqueStrings(tokenizeRetrievalText(query)
    .map((term) => comparableTerm(term))
    .filter((term) => [...term].length >= 2 && !PASSAGE_QUERY_STOPWORDS.has(term)))
    .slice(0, 24);
}

function matchedKnowledgeTerms(text: string, queryTerms: readonly string[]): string[] {
  const tokens = new Set(tokenizeRetrievalText(text).map((term) => comparableTerm(term)));
  const lower = text.normalize("NFKC").toLocaleLowerCase();
  return queryTerms.filter((term) => tokens.has(comparableTerm(term)) || lower.includes(term));
}

function comparableTerm(value: string): string {
  const token = value.normalize("NFKC").toLocaleLowerCase();
  if (token.endsWith("ies") && token.length > 4) return `${token.slice(0, -3)}y`;
  if (token.endsWith("ing") && token.length > 5) return token.slice(0, -3);
  if (token.endsWith("ed") && token.length > 4) return token.slice(0, -2);
  if (token.endsWith("s") && token.length > 3) return token.slice(0, -1);
  return token;
}

function boundUtf8(value: string, maxBytes: number): string {
  const normalized = value.trim();
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(normalized, "utf8") <= maxBytes) return normalized;
  let low = 0, high = normalized.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(normalized.slice(0, mid), "utf8") <= Math.max(1, maxBytes - 3)) low = mid;
    else high = mid - 1;
  }
  let end = low;
  if (end > 0 && /[\uD800-\uDBFF]/u.test(normalized[end - 1]!)) end -= 1;
  return end > 0 ? `${normalized.slice(0, end).trimEnd()}…` : "";
}

function roundScore(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

export function dedupeTurnKnowledgePlan(plan: TurnKnowledgePlan, capsule: ContextCapsule): TurnKnowledgePlan {
  const capsuleItems = new Map<string, ContextItem>([
    ...capsule.globalMemory,
    ...capsule.globalState,
    ...capsule.projectMemory,
    ...capsule.reusableSkills,
    ...capsule.projectArchitecture
  ].map((item) => [item.id, item]));

  const dedupeEntry = (entry: TurnKnowledgeEntry): TurnKnowledgeEntry => {
    const capsuleItem = capsuleItems.get(entry.id);
    if (!capsuleItem) return entry;
    const passageHeadings = uniqueStrings((entry.passages ?? []).map((p) => p.heading).filter((h): h is string => Boolean(h)));
    const missingPassages = (entry.passages ?? []).filter((passage) =>
      !contextAlreadyContainsPassage(capsuleItem.content, passage.text)
    );
    return {
      role: entry.role,
      kind: entry.kind,
      id: entry.id,
      reason: entry.reason,
      passage_headings: passageHeadings,
      ...(missingPassages.length > 0 ? { passages: missingPassages } : {})
    };
  };

  return {
    ...plan,
    required: plan.required.map(dedupeEntry),
    supporting: plan.supporting.map(dedupeEntry)
  };
}

function dedupeSupportingPassages(
  required: readonly TurnKnowledgeEntry[],
  supporting: readonly TurnKnowledgeEntry[]
): TurnKnowledgeEntry[] {
  const seen = required.flatMap((entry) => entry.passages ?? []);
  return supporting.map((entry) => {
    if (!entry.passages?.length) return entry;
    const kept: TurnKnowledgePassage[] = [];
    for (const passage of entry.passages) {
      const duplicate = [...seen, ...kept].some((candidate) => {
        if (candidate.fact_id && passage.fact_id && candidate.fact_id !== passage.fact_id) return false;
        return passageTextJaccard(candidate.text, passage.text) >= SUPPORTING_PASSAGE_DUPLICATE_JACCARD;
      });
      if (!duplicate) kept.push(passage);
    }
    seen.push(...kept);
    return kept.length === entry.passages.length ? entry : { ...entry, passages: kept };
  });
}

function passageTextJaccard(left: string, right: string): number {
  const leftTokens = new Set(tokenizeRetrievalText(left));
  const rightTokens = new Set(tokenizeRetrievalText(right));
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  let intersection = 0;
  for (const token of leftTokens) if (rightTokens.has(token)) intersection += 1;
  const union = leftTokens.size + rightTokens.size - intersection;
  return union > 0 ? intersection / union : 0;
}

function contextAlreadyContainsPassage(contextContent: string, passageText: string): boolean {
  const context = normalizeComparableText(contextContent);
  const passage = normalizeComparableText(passageText)
    .replace(/^…\s*/, "")
    .replace(/\s*…$/, "")
    .trim();
  return passage.length > 0 && context.includes(passage);
}

function normalizeComparableText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim();
}

function derivedFactHits(item: ContextItem): DerivedFactPlanHit[] {
  const provenance = item.provenance;
  if (!provenance || typeof provenance !== "object" || Array.isArray(provenance)) return [];
  const raw = provenance.derivedFactRetrieval;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const hits = (raw as { hits?: unknown }).hits;
  if (!Array.isArray(hits)) return [];
  return hits.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const hit = value as Partial<DerivedFactPlanHit>;
    if (typeof hit.fact_id !== "string" || typeof hit.parent_id !== "string" || typeof hit.score !== "number") return [];
    return [{
      fact_id: hit.fact_id,
      parent_id: hit.parent_id,
      score: hit.score,
      ...(typeof hit.semantic_score === "number" ? { semantic_score: hit.semantic_score } : {}),
      ...(typeof hit.lexical_score === "number" ? { lexical_score: hit.lexical_score } : {}),
      ...(Array.isArray(hit.matched_terms)
        ? { matched_terms: hit.matched_terms.filter((term): term is string => typeof term === "string") }
        : {}),
      ...(typeof hit.series_id === "string" ? { series_id: hit.series_id } : {}),
      ...(hit.series_kind === "entity_timeline" || hit.series_kind === "entity_topic" || hit.series_kind === "supersession"
        ? { series_kind: hit.series_kind }
        : {}),
      ...(hit.series_relation === "seed" || hit.series_relation === "neighbor" || hit.series_relation === "time_window" || hit.series_relation === "ordered_series"
        ? { series_relation: hit.series_relation }
        : {}),
      ...(typeof hit.series_distance === "number" ? { series_distance: hit.series_distance } : {}),
      ...(validTemporalPlanTime(hit.temporal_time) ? { temporal_time: hit.temporal_time } : {})
    }];
  });
}

function validTemporalPlanTime(value: unknown): value is NonNullable<DerivedFactPlanHit["temporal_time"]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<NonNullable<DerivedFactPlanHit["temporal_time"]>>;
  return typeof item.raw === "string" &&
    ["date", "month", "year", "range", "unknown"].includes(String(item.precision)) &&
    ["canonical", "relative_evidence", "evidence_timestamp"].includes(String(item.source)) &&
    typeof item.confidence === "number" && typeof item.answerable === "boolean";
}

function memoryEntry(input: {
  item: ContextItem;
  role: TurnKnowledgeRole;
  kind: "L1" | "L2" | "L3" | "L4" | "GlobalState";
  reason: string;
  use: string;
  queryTerms: readonly string[];
  typedFactFocusTerms?: readonly string[];
  fullContent?: string;
  factMetadata?: DistilledFactMetadataSet;
  factRetrievalHits?: readonly DerivedFactPlanHit[];
  fallback: "retrieval" | "latest";
  maxPassages: number;
  maxPassageChars: number;
  passageWindow: TurnKnowledgePolicy["passageWindow"];
}): TurnKnowledgeEntry {
  const content = input.fullContent?.trim() || input.item.content;
  const factPassageLimit = input.kind === "L2" && input.factRetrievalHits?.length
    ? Math.max(input.maxPassages, Math.min(6, input.factRetrievalHits.length))
    : input.maxPassages;
  return {
    role: input.role,
    kind: input.kind,
    id: input.item.id,
    ...(input.item.projectId ? { project_id: input.item.projectId } : {}),
    ...(input.item.evidenceRef ? { evidence_ref: input.item.evidenceRef } : {}),
    reason: input.reason,
    use: input.use,
    passages: selectFactMetadataPassages(
      input.factMetadata,
      input.queryTerms,
      matchedTerms(input.item),
      input.typedFactFocusTerms ?? [],
      factPassageLimit,
      input.maxPassageChars,
      input.factRetrievalHits
    ) ?? selectPassages(
        content,
        input.queryTerms,
        matchedTerms(input.item),
        input.fallback,
        input.item.content,
        input.maxPassages,
        input.maxPassageChars,
        input.passageWindow
      )
  };
}

function selectFactMetadataPassages(
  metadata: DistilledFactMetadataSet | undefined,
  queryTerms: readonly string[],
  itemMatchedTerms: readonly string[],
  focusTerms: readonly string[],
  maxPassages: number,
  maxPassageChars: number,
  retrievalHits: readonly DerivedFactPlanHit[] = []
): TurnKnowledgePassage[] | undefined {
  if (!metadata?.facts.length) return undefined;
  const wantsTemporal = queryNeedsTemporalContext(queryTerms);
  const wantsState = queryNeedsStateContext(queryTerms);
  const candidates = metadata.facts.map((fact) => ({ heading: fact.parent_heading, text: fact.text }));
  const byFactId = new Map(metadata.facts.map((fact, index) => [fact.fact_id, index]));
  const retrievalRank = new Map(retrievalHits.map((hit, index) => [hit.fact_id, { hit, index }]));
  const scored = retrievalRank.size > 0
    ? retrievalHits.flatMap((hit, rank) => {
        const index = byFactId.get(hit.fact_id);
        if (index === undefined) return [];
        const fact = metadata.facts[index]!;
        const temporalTime = fact.canonical_time ?? (hit.temporal_time?.answerable ? hit.temporal_time : undefined);
        const structuralBoost = (wantsState && fact.supersedes ? 12 : 0) +
          (wantsTemporal && temporalTime ? 6 : 0) +
          (wantsTemporal && hit.series_relation && hit.series_relation !== "seed" ? 4 : 0);
        return [{
          ...candidates[index]!,
          matched: hit.matched_terms ?? [],
          score: hit.score * 100 + structuralBoost,
          index,
          retrievalRank: rank,
          retrievalHit: hit
        }];
      }).sort((left, right) => right.score - left.score || left.retrievalRank - right.retrievalRank)
    : scoreTypedFactPassages(candidates, queryTerms, itemMatchedTerms, focusTerms)
        .filter((candidate) => candidate.score > 0)
        .map((candidate) => {
          const fact = metadata.facts[candidate.index];
          const structuralBoost = (wantsState && fact?.supersedes ? 12 : 0) +
            (wantsTemporal && fact?.canonical_time ? 6 : 0);
          return { ...candidate, score: candidate.score + structuralBoost };
        })
        .sort((left, right) => right.score - left.score || left.index - right.index);
  if (scored.length === 0) return undefined;
  const passages: TurnKnowledgePassage[] = [];
  const seen = new Set<string>();
  for (const candidate of scored) {
    const fact = metadata.facts[candidate.index];
    if (!fact) continue;
    const retrievalHit = "retrievalHit" in candidate ? candidate.retrievalHit as DerivedFactPlanHit | undefined : undefined;
    const temporalTime = fact.canonical_time ?? (retrievalHit?.temporal_time?.answerable ? retrievalHit.temporal_time : undefined);
    const evidence = fact.evidence_refs.length > 0 ? ` | Evidence: ${fact.evidence_refs.join(", ")}` : "";
    const text = [
      `Atomic fact: ${fact.text}${evidence}`,
      ...(wantsTemporal && temporalTime
        ? [fact.canonical_time
            ? `Canonical time: ${fact.canonical_time.raw}`
            : `Event-series time: ${temporalTime.raw}${temporalTime.original_expression ? ` (normalized from ${temporalTime.original_expression})` : ""}`]
        : []),
      ...(wantsTemporal && retrievalHit?.series_relation && retrievalHit.series_relation !== "seed"
        ? [`Event-series expansion: ${retrievalHit.series_relation}${retrievalHit.series_distance !== undefined && retrievalHit.series_distance < 99 ? `, distance ${retrievalHit.series_distance}` : ""}`]
        : []),
      ...(wantsState && fact.supersedes ? [`Supersedes: ${fact.supersedes.text}${evidence}`] : [])
    ].join("\n");
    const bounded = boundText(text, maxPassageChars);
    const key = normalizeComparableText(bounded);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    passages.push({
      ...(fact.parent_heading ? { heading: fact.parent_heading } : {}),
      text: bounded,
      matched_terms: candidate.matched.slice(0, 12),
      fact_id: fact.fact_id,
      parent_id: fact.parent_id,
      score: candidate.score + 4 +
        (wantsTemporal && temporalTime ? 6 : 0) +
        (wantsState && fact.supersedes ? 8 : 0)
    });
    if (passages.length >= maxPassages) break;
  }
  return passages.length > 0 ? passages : undefined;
}

interface TypedFactRarityTerm { variants: string[]; weight: number; }

function scoreTypedFactPassages(
  candidates: readonly PassageCandidate[],
  queryTerms: readonly string[],
  itemMatchedTerms: readonly string[],
  focusTerms: readonly string[]
): Array<PassageCandidate & { matched: string[]; score: number; index: number }> {
  // Preserve the frozen 86/144 ranking for ordinary queries. Only enter the
  // cleaned compound lane when a query token really bridges two adjacent fact
  // tokens (for example roadtrips -> road trip). This keeps the fix narrow.
  const cleanedDirectTerms = typedFactRankingTerms(queryTerms);
  const compoundTerms = new Set(cleanedDirectTerms.filter((term) => {
    const variants = typedFactTermVariants(term);
    return candidates.some((candidate) => {
      if (candidate.text.toLocaleLowerCase().includes(term)) return false;
      const compounds = typedFactCompoundVariants(candidate.text);
      return variants.some((variant) => compounds.has(variant));
    });
  }));
  const compoundMode = compoundTerms.size > 0;
  const directTerms = compoundMode ? cleanedDirectTerms : uniqueStrings(queryTerms);
  const admittedTerms = compoundMode ? typedFactRankingTerms(itemMatchedTerms) : uniqueStrings(itemMatchedTerms);
  const rarity = typedFactQueryRarity(candidates, directTerms);
  const focus = new Set(typedFactRankingTerms(focusTerms));
  return scoreMarkdownPassages(candidates, directTerms, admittedTerms).map((candidate) => {
    const tokens = typedFactTokenVariants(candidate.text);
    const compoundTokens = typedFactCompoundVariants(candidate.text);
    let score = candidate.score + typedFactRarityBoost(candidate, rarity);
    for (const term of directTerms) {
      const variants = typedFactTermVariants(term);
      const tokenMatch = variants.some((variant) => tokens.has(variant));
      const compoundMatch = compoundMode && variants.some((variant) => compoundTokens.has(variant));
      if (!tokenMatch && !compoundMatch) continue;
      const lengthWeight = Math.min(8, Math.max(2, [...term].length));
      // scoreMarkdownPassages already covers literal substring matches. This
      // additive path is only for normalized/compound variants such as
      // roadtrips -> roadtrip <- "road trip".
      const literal = candidate.text.toLocaleLowerCase().includes(term);
      if (!literal) {
        if (compoundMode && compoundMatch && compoundTerms.has(term)) score += lengthWeight * 2;
        else if (compoundMode) score += lengthWeight;
      }
      if (focus.has(term) && tokenMatch) score += 40;
    }
    return { ...candidate, score };
  });
}

function typedFactRankingTerms(values: readonly string[]): string[] {
  return uniqueStrings(values)
    .map((term) => term.trim().toLocaleLowerCase())
    .filter((term) => [...term].length >= 2 && !TYPED_FACT_QUERY_STOPWORDS.has(term));
}

function typedFactQueryRarity(candidates: readonly PassageCandidate[], queryTerms: readonly string[]): TypedFactRarityTerm[] {
  const terms = uniqueStrings(queryTerms).map((term) => term.trim()).filter((term) => [...term].length >= 2);
  const candidateTokens = candidates.map((candidate) => typedFactTokenVariants(`${candidate.heading ?? ""}\n${candidate.text}`));
  const total = Math.max(1, candidates.length);
  const rarity: TypedFactRarityTerm[] = [];
  for (const term of terms) {
    const variants = typedFactTermVariants(term);
    let frequency = 0;
    for (const tokens of candidateTokens) if (variants.some((variant) => tokens.has(variant))) frequency += 1;
    if (frequency === 0) continue;
    const lengthWeight = Math.min(8, Math.max(2, [...term].length));
    rarity.push({ variants, weight: TYPED_FACT_RARITY_WEIGHT * Math.log(1 + total / frequency) * lengthWeight });
  }
  return rarity;
}

function typedFactRarityBoost(candidate: PassageCandidate, rarity: readonly TypedFactRarityTerm[]): number {
  const tokens = typedFactTokenVariants(`${candidate.heading ?? ""}\n${candidate.text}`);
  let boost = 0;
  for (const term of rarity) if (term.variants.some((variant) => tokens.has(variant))) boost += term.weight;
  return boost;
}

const TYPED_FACT_IRREGULAR_TERMS = new Map<string, string>([
  ["met", "meet"], ["began", "begin"], ["begun", "begin"], ["fell", "fall"], ["fallen", "fall"],
  ["went", "go"], ["gone", "go"], ["took", "take"], ["taken", "take"], ["made", "make"], ["ran", "run"]
]);

const TYPED_FACT_QUERY_STOPWORDS = new Set([
  ...PASSAGE_QUERY_STOPWORDS,
  "be", "been", "being", "has", "have", "had", "his", "her", "their", "them", "our", "your", "my",
  "during", "type", "kind"
]);

function typedFactTokenVariants(value: string): Set<string> {
  const variants = new Set<string>();
  const tokens = tokenizeRetrievalText(value);
  for (const token of tokens) for (const variant of typedFactTermVariants(token)) variants.add(variant);
  return variants;
}

function typedFactCompoundVariants(value: string): Set<string> {
  const compounds = new Set<string>();
  const tokens = tokenizeRetrievalText(value);
  for (let index = 0; index + 1 < tokens.length; index += 1) {
    const left = tokens[index]!, right = tokens[index + 1]!;
    if (!/^[a-z0-9]+$/u.test(left) || !/^[a-z0-9]+$/u.test(right)) continue;
    const joined = `${left}${right}`;
    if (joined.length > 24) continue;
    for (const variant of typedFactTermVariants(joined)) compounds.add(variant);
  }
  return compounds;
}

function queryTypedFactFocusTerms(query: string): string[] {
  const normalized = query.normalize("NFKC").toLocaleLowerCase();
  const match = /\b(?:what|which)\s+(?:type|kind)\s+of\s+([\p{L}\p{N}-]+)/u.exec(normalized);
  return match?.[1] ? tokenizeRetrievalText(match[1]) : [];
}

function typedFactTermVariants(value: string): string[] {
  const token = value.toLocaleLowerCase();
  const variants = new Set<string>([TYPED_FACT_IRREGULAR_TERMS.get(token) ?? token]);
  const add = (candidate: string) => {
    if (candidate.length >= 3) variants.add(TYPED_FACT_IRREGULAR_TERMS.get(candidate) ?? candidate);
  };
  if (token.endsWith("ing") && token.length > 5) {
    const base = token.slice(0, -3); add(base); add(`${base}e`);
    if (base.length > 3 && base.at(-1) === base.at(-2)) add(base.slice(0, -1));
  }
  if (token.endsWith("ed") && token.length > 4) {
    const base = token.slice(0, -2); add(base); add(`${base}e`);
    if (base.length > 3 && base.at(-1) === base.at(-2)) add(base.slice(0, -1));
  }
  if (token.endsWith("ies") && token.length > 4) add(`${token.slice(0, -3)}y`);
  else if (token.endsWith("s") && token.length > 3) add(token.slice(0, -1));
  return [...variants];
}

export function scoreMarkdownPassages(
  candidates: readonly PassageCandidate[],
  queryTerms: readonly string[],
  itemMatchedTerms: readonly string[] = []
): Array<PassageCandidate & { matched: string[]; score: number; index: number }> {
  const terms = uniqueStrings([...itemMatchedTerms, ...queryTerms])
    .map((term) => term.trim())
    .filter((term) => [...term].length >= 2)
    .slice(0, 48);
  return candidates.map((candidate, index) => {
    const haystack = `${candidate.heading ?? ""}\n${candidate.text}`.toLocaleLowerCase();
    const matched = terms.filter((term) => haystack.includes(term.toLocaleLowerCase()));
    const heading = (candidate.heading ?? "").toLocaleLowerCase();
    const lexicalScore = matched.reduce((total, term) => {
      const normalized = term.toLocaleLowerCase();
      const lengthWeight = Math.min(8, Math.max(2, [...term].length));
      const headingBoost = heading.includes(normalized) ? lengthWeight : 0;
      return total + lengthWeight + headingBoost;
    }, 0);
    const score = lexicalScore + structuredPassageBoost(candidate, matched, queryTerms);
    return { ...candidate, matched, score, index };
  });
}

export function selectPassages(
  content: string,
  queryTerms: readonly string[],
  itemMatchedTerms: readonly string[],
  fallback: "none" | "retrieval" | "latest",
  retrievalFallback?: string,
  maxPassages = MAX_PASSAGES_PER_ENTRY,
  maxPassageChars = MAX_PASSAGE_CHARS,
  passageWindow: TurnKnowledgePolicy["passageWindow"] = "matched"
): TurnKnowledgePassage[] {
  const candidates = markdownPassages(
    content,
    passageWindow === "matched" ? Number.MAX_SAFE_INTEGER : maxPassageChars
  );
  const scored = scoreMarkdownPassages(candidates, queryTerms, itemMatchedTerms);
  const positiveCandidates = scored.filter((candidate) => candidate.score > 0);
  const discriminative = discriminativePassageTerms(scored, queryTerms);
  const focusedCandidates = discriminative.length > 0
    ? positiveCandidates.filter((candidate) => passageContainsAnyTerm(candidate, discriminative))
    : positiveCandidates;
  const ranked = focusedCandidates.sort((left, right) => right.score - left.score || left.index - right.index);
  // Preserve the user's matching statement before verbose assistant suggestions crowd it out.
  const userStatements = positiveCandidates.filter(candidate => /^(?:user|user_agent|用户)\s*[:：]/iu.test(candidate.text))
    .sort((left, right) => right.score - left.score || left.index - right.index);
  const userIndexes = new Set(userStatements.map(candidate => candidate.index));
  ranked.splice(0, ranked.length, ...userStatements, ...ranked.filter(candidate => !userIndexes.has(candidate.index)));
  const positive = expandStructuredPassageContext(ranked, scored, queryTerms, maxPassages)
    .map((candidate) => toPassage(candidate, maxPassageChars, passageWindow));
  if (positive.length > 0) return positive;
  if (fallback === "none") return [];
  if (fallback === "latest" && scored.length > 0) {
    return [toPassage(scored[scored.length - 1]!, maxPassageChars, passageWindow)];
  }
  const fallbackContent = (retrievalFallback ?? content).trim();
  if (!fallbackContent) return [];
  return [{ text: boundText(fallbackContent, maxPassageChars), matched_terms: [], score: 0 }];
}

function expandStructuredPassageContext<T extends PassageCandidate & { matched: string[]; score: number; index: number }>(
  ranked: readonly T[],
  all: readonly T[],
  queryTerms: readonly string[],
  maxPassages: number
): T[] {
  const selected: T[] = [];
  const selectedIndexes = new Set<number>();
  const wantsTemporal = queryNeedsTemporalContext(queryTerms);
  const wantsState = queryNeedsStateContext(queryTerms);
  const add = (candidate: T | undefined) => {
    if (!candidate || selectedIndexes.has(candidate.index) || selected.length >= maxPassages) return;
    selected.push(candidate);
    selectedIndexes.add(candidate.index);
  };

  for (const candidate of ranked) {
    add(candidate);
    if (selected.length >= maxPassages) break;
    if (!candidate.heading) continue;
    const siblings = all.filter((other) => other.index !== candidate.index && other.heading === candidate.heading);
    if (isAtomicFactPassage(candidate.text)) {
      if (wantsState) add(immediateFollowingSupersessionSibling(siblings, candidate.index));
      if (wantsTemporal && selected.length < maxPassages) add(siblings.find((other) => isCanonicalTimePassage(other.text)));
    } else if (wantsTemporal && isCanonicalTimePassage(candidate.text)) {
      add(bestAtomicFactSibling(siblings));
    } else if (wantsState && isSupersessionPassage(candidate.text)) {
      add(nearestPrecedingAtomicFactSibling(siblings, candidate.index) ?? bestAtomicFactSibling(siblings));
    }
    if (selected.length >= maxPassages) break;
  }
  return selected.slice(0, maxPassages);
}

function nearestPrecedingAtomicFactSibling<T extends PassageCandidate & { index: number }>(siblings: readonly T[], index: number): T | undefined {
  return siblings.filter((candidate) => candidate.index < index && isAtomicFactPassage(candidate.text))
    .sort((left, right) => right.index - left.index)[0];
}

function immediateFollowingSupersessionSibling<T extends PassageCandidate & { index: number }>(siblings: readonly T[], index: number): T | undefined {
  return siblings.find((candidate) => candidate.index === index + 1 && isSupersessionPassage(candidate.text));
}

function bestAtomicFactSibling<T extends PassageCandidate & { score: number; index: number }>(siblings: readonly T[]): T | undefined {
  return siblings.filter((candidate) => isAtomicFactPassage(candidate.text))
    .sort((left, right) => right.score - left.score || left.index - right.index)[0];
}

function structuredPassageBoost(candidate: PassageCandidate, matched: readonly string[], queryTerms: readonly string[]): number {
  if (matched.length === 0) return 0;
  if (isAtomicFactPassage(candidate.text)) return 4;
  if (isCanonicalTimePassage(candidate.text) && queryNeedsTemporalContext(queryTerms)) return 6;
  if (isSupersessionPassage(candidate.text) && queryNeedsStateContext(queryTerms)) return 8;
  return 0;
}

function isAtomicFactPassage(text: string): boolean {
  return /^[-*+]\s*(?:atomic\s+fact|fact|原子事实|事实)\s*[:：]/iu.test(text.trim());
}

function isCanonicalTimePassage(text: string): boolean {
  return /^(?:[-*+]\s*)?(?:canonical\s+time|normalized\s+time|规范时间|标准时间|绝对时间)\s*[:：]/iu.test(text.trim());
}

function isSupersessionPassage(text: string): boolean {
  return /^(?:[-*+]\s*)?(?:supersedes?|superseded\s+by|replaces?|取代|替代|已被.+取代)\s*[:：]/iu.test(text.trim());
}

function queryNeedsTemporalContext(queryTerms: readonly string[]): boolean {
  return queryTerms.some((term) => {
    const normalized = term.trim().toLocaleLowerCase();
    return TEMPORAL_QUERY_TERMS.has(normalized) || /^\d{4}(?:[-/.]\d{1,2})?/.test(normalized);
  });
}

function queryNeedsStateContext(queryTerms: readonly string[]): boolean {
  return queryTerms.some((term) => STATE_QUERY_TERMS.has(term.trim().toLocaleLowerCase()));
}

function discriminativePassageTerms(candidates: readonly PassageCandidate[], queryTerms: readonly string[]): string[] {
  if (candidates.length === 0) return [];
  const terms = uniqueStrings(queryTerms).filter((term) => {
    const normalized = term.toLocaleLowerCase();
    return !PASSAGE_QUERY_STOPWORDS.has(normalized) && [...normalized].length >= 2;
  });
  if (terms.length === 0) return [];
  const maxFrequency = Math.max(1, Math.ceil(candidates.length * 0.5));
  return terms.filter((term) => {
    let frequency = 0;
    for (const candidate of candidates) if (passageContainsTerm(candidate, term)) frequency += 1;
    return frequency > 0 && frequency <= maxFrequency;
  });
}

function passageContainsAnyTerm(candidate: PassageCandidate, terms: readonly string[]): boolean {
  return terms.some((term) => passageContainsTerm(candidate, term));
}

function passageContainsTerm(candidate: PassageCandidate, term: string): boolean {
  const haystack = `${candidate.heading ?? ""}\n${candidate.text}`.toLocaleLowerCase();
  return haystack.includes(term.toLocaleLowerCase());
}

export function extractMarkdownHeadings(content: string, limit = 12): string[] {
  const headings: string[] = [];
  let inFence = false;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (/^```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || /^artifact:[^\s]+$/.test(line)) continue;
    const headingMatch = /^(#{1,6})\s+(.+)$/.exec(line);
    if (headingMatch) {
      headings.push(headingMatch[2]!.trim());
      if (headings.length >= limit) break;
    }
  }
  return headings;
}

export function markdownPassages(content: string, maxPassageChars = MAX_PASSAGE_CHARS): PassageCandidate[] {
  const passages: PassageCandidate[] = [];
  let heading: string | undefined;
  let paragraph: string[] = [];
  let inFence = false;
  const flush = () => {
    const text = paragraph.join(" ").trim();
    paragraph = [];
    if (text) passages.push({ ...(heading ? { heading } : {}), text: boundText(text, maxPassageChars) });
  };
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (/^```/.test(line)) {
      flush();
      inFence = !inFence;
      continue;
    }
    if (inFence || /^artifact:[^\s]+$/.test(line)) continue;
    const headingMatch = /^(#{1,6})\s+(.+)$/.exec(line);
    if (headingMatch) {
      flush();
      heading = headingMatch[2]!.trim();
      continue;
    }
    if (!line) {
      flush();
      continue;
    }
    if (/^(?:[-*+]\s+|\d+[.)]\s+)/.test(line)) {
      flush();
      passages.push({ ...(heading ? { heading } : {}), text: boundText(line, maxPassageChars) });
      continue;
    }
    paragraph.push(line);
  }
  flush();
  if (passages.length === 0 && content.trim()) passages.push({ text: boundText(content.trim(), maxPassageChars) });
  return passages;
}

function toPassage(
  candidate: PassageCandidate & { matched: string[]; score: number },
  maxPassageChars = MAX_PASSAGE_CHARS,
  passageWindow: TurnKnowledgePolicy["passageWindow"] = "matched"
): TurnKnowledgePassage {
  return {
    ...(candidate.heading ? { heading: candidate.heading } : {}),
    text: passageWindow === "matched"
      ? boundTextAroundMatches(candidate.text, candidate.matched, maxPassageChars)
      : boundText(candidate.text, maxPassageChars),
    matched_terms: candidate.matched.slice(0, 12),
    score: candidate.score
  };
}

export function turnQueryTerms(query: string, capsule: ContextCapsule): string[] {
  const diagnostics = capsule.retrievalDiagnostics;
  return uniqueStrings([
    ...(diagnostics?.lanes.project.queryTerms ?? []),
    ...(diagnostics?.lanes.global.queryTerms ?? []),
    ...(diagnostics?.lanes.globalState?.queryTerms ?? []),
    ...(diagnostics?.lanes.skills.queryTerms ?? []),
    ...tokenizeRetrievalText(query)
  ]).slice(0, 64);
}

function matchedTerms(item: ContextItem): string[] {
  const retrieval = objectRecord(item.provenance?.retrievalV1);
  const value = retrieval?.matchedTerms;
  return Array.isArray(value) ? uniqueStrings(value.filter((term): term is string => typeof term === "string")) : [];
}

function memoryLayer(item: ContextItem): "L1" | "L2" | "L3" | "L4" | "GlobalState" | null {
  const raw = typeof item.provenance?.memoryLayer === "string" ? item.provenance.memoryLayer.trim() : "";
  if (raw === "GlobalState") return "GlobalState";
  const value = raw.toUpperCase();
  return value === "L1" || value === "L2" || value === "L3" || value === "L4" ? value : null;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function boundText(value: string, maxChars = MAX_PASSAGE_CHARS): string {
  const normalized = value.trim();
  if (normalized.length <= maxChars) return normalized;
  let end = Math.max(1, maxChars - 1);
  const previous = normalized.charCodeAt(end - 1), next = normalized.charCodeAt(end);
  if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end -= 1;
  return `${normalized.slice(0, end).trimEnd()}…`;
}

function normalizePolicy(input: Partial<TurnKnowledgePolicy> | undefined): TurnKnowledgePolicy {
  const integer = (value: number | undefined, fallback: number, min: number, max: number) => {
    if (!Number.isFinite(value)) return fallback;
    return Math.max(min, Math.min(max, Math.floor(value!)));
  };
  return {
    maxPassagesPerEntry: integer(input?.maxPassagesPerEntry, DEFAULT_TURN_KNOWLEDGE_POLICY.maxPassagesPerEntry, 1, 12),
    maxPassageChars: integer(input?.maxPassageChars, DEFAULT_TURN_KNOWLEDGE_POLICY.maxPassageChars, 128, 8_000),
    maxRequiredEntries: integer(input?.maxRequiredEntries, DEFAULT_TURN_KNOWLEDGE_POLICY.maxRequiredEntries, 1, 32),
    maxSupportingEntries: integer(input?.maxSupportingEntries, DEFAULT_TURN_KNOWLEDGE_POLICY.maxSupportingEntries, 0, 64),
    maxArchitectureEntries: integer(input?.maxArchitectureEntries, DEFAULT_TURN_KNOWLEDGE_POLICY.maxArchitectureEntries, 0, 16),
    maxFreshL1Entries: integer(input?.maxFreshL1Entries, DEFAULT_TURN_KNOWLEDGE_POLICY.maxFreshL1Entries, 0, 64),
    freshL1RelevantOnly: input?.freshL1RelevantOnly ?? DEFAULT_TURN_KNOWLEDGE_POLICY.freshL1RelevantOnly,
    freshL1Role: input?.freshL1Role === "required" ? "required" : DEFAULT_TURN_KNOWLEDGE_POLICY.freshL1Role,
    supportingSelection: input?.supportingSelection === "balanced" || input?.supportingSelection === "score"
      ? input.supportingSelection
      : DEFAULT_TURN_KNOWLEDGE_POLICY.supportingSelection,
    passageWindow: input?.passageWindow === "head" ? "head" : input?.passageWindow === "matched" ? "matched" : DEFAULT_TURN_KNOWLEDGE_POLICY.passageWindow,
    trustAdmittedArchitecture: input?.trustAdmittedArchitecture ?? DEFAULT_TURN_KNOWLEDGE_POLICY.trustAdmittedArchitecture,
    trustAdmittedSupporting: input?.trustAdmittedSupporting ?? DEFAULT_TURN_KNOWLEDGE_POLICY.trustAdmittedSupporting
  };
}

function boundTextAroundMatches(value: string, terms: readonly string[], maxChars: number): string {
  const normalized = value.trim();
  if (normalized.length <= maxChars || terms.length === 0) return boundText(normalized, maxChars);
  const lower = normalized.toLocaleLowerCase();
  const candidates = uniqueStrings(terms)
    .map((term) => {
      const needle = term.toLocaleLowerCase();
      const index = lower.indexOf(needle);
      if (index < 0) return null;
      let count = 0;
      let cursor = 0;
      while (cursor < lower.length) {
        const found = lower.indexOf(needle, cursor);
        if (found < 0) break;
        count += 1;
        cursor = found + Math.max(1, needle.length);
      }
      return { term, index, count };
    })
    .filter((value): value is { term: string; index: number; count: number } => Boolean(value))
    .sort((left, right) =>
      left.count - right.count ||
      [...right.term].length - [...left.term].length ||
      right.index - left.index
    );
  const best = candidates[0];
  if (!best) return boundText(normalized, maxChars);
  const before = Math.floor(maxChars * 0.35);
  let start = Math.max(0, best.index - before);
  let prefix = start > 0 ? "…" : "";
  let suffix = start + maxChars < normalized.length ? "…" : "";
  let bodyBudget = Math.max(1, maxChars - prefix.length - suffix.length);
  if (start + bodyBudget >= normalized.length) {
    suffix = "";
    bodyBudget = Math.max(1, maxChars - prefix.length);
    start = Math.max(0, normalized.length - bodyBudget);
    prefix = start > 0 ? "…" : "";
    bodyBudget = Math.max(1, maxChars - prefix.length);
  }
  const end = Math.min(normalized.length, start + bodyBudget);
  const body = normalized.slice(start, end).trim();
  return `${prefix}${body}${suffix}`;
}

function orderSupporting(
  entries: readonly TurnKnowledgeEntry[],
  selection: TurnKnowledgePolicy["supportingSelection"]
): TurnKnowledgeEntry[] {
  if (selection === "current") return [...entries];
  if (selection === "score") {
    return [...entries].sort((left, right) =>
      (right.passages?.[0]?.score ?? 0) - (left.passages?.[0]?.score ?? 0)
    );
  }
  const kindOrder: TurnKnowledgeKind[] = ["L1", "L2", "L4", "skill"];
  const groups = new Map<TurnKnowledgeKind, TurnKnowledgeEntry[]>(kindOrder.map((kind) => [kind, []]));
  for (const entry of entries) {
    if (!groups.has(entry.kind)) groups.set(entry.kind, []);
    groups.get(entry.kind)!.push(entry);
  }
  const output: TurnKnowledgeEntry[] = [];
  while (output.length < entries.length) {
    let progressed = false;
    for (const kind of kindOrder) {
      const next = groups.get(kind)?.shift();
      if (!next) continue;
      output.push(next);
      progressed = true;
    }
    if (!progressed) break;
  }
  return output;
}
