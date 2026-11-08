import { env } from "./brand.mjs";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  DistilledCanonicalTime,
  DistilledFactMetadataSet,
  DistillationEvidenceItem
} from "./contracts/distillation.js";
import type { HydratedMemoryEvidence } from "./memory-hydration.js";
import { listCaptureEvents } from "./capture.js";
import { tokenizeRetrievalText } from "./retrieval-ranker.js";
import {
  buildEventSeriesSidecar,
  deriveEvidenceTemporalTime,
  eventSeriesQueryWindow,
  eventWindowTopicRelevant,
  expandEventSeries,
  queryNeedsEventSeries,
  type EventSeriesExpansion,
  type EventSeriesSidecar,
  type EventSeriesTime
} from "./event-series.js";

export type DerivedFactRetrievalMode = "lexical" | "semantic" | "lexical_fallback";

export interface DerivedFactRetrievalHit {
  memory_id: string;
  revision_id?: string;
  layer: "L2" | "L3";
  fact_id: string;
  parent_id: string;
  parent_heading?: string;
  text: string;
  canonical_time?: DistilledCanonicalTime;
  supersedes?: { text: string; fact_id?: string };
  evidence_refs: string[];
  parent_evidence_refs?: string[];
  score: number;
  semantic_score: number;
  lexical_score: number;
  matched_terms: string[];
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

export interface DerivedEvidenceRetrievalHit {
  evidence_ref: string;
  layer: string | null;
  timestamp: string;
  project_id: string | null;
  text: string;
  score: number;
  semantic_score: number;
  lexical_score: number;
  matched_terms: string[];
  identity_evidence_refs?: string[];
}

export interface DerivedEvidenceSufficiency {
  status: "sufficient" | "partial" | "insufficient";
  query_terms: string[];
  matched_terms: string[];
  lexical_coverage: number;
  top_fact_score: number;
  reason: string;
}

export interface DerivedRevisionRetrievalResult {
  version: "derived-revision-retrieval-v1";
  mode: DerivedFactRetrievalMode;
  facts: DerivedFactRetrievalHit[];
  raw_evidence: DerivedEvidenceRetrievalHit[];
  evidence_sufficiency: DerivedEvidenceSufficiency;
  event_series?: EventSeriesExpansion;
  diagnostics: {
    fact_candidates: number;
    raw_evidence_candidates: number;
    semantic_enabled: boolean;
    revision_cache_hits: number;
    revision_cache_misses: number;
    direct_evidence_refs: number;
    lexical_fallback_refs: number;
    event_series_enabled: boolean;
    event_series_selected: number;
    event_series_hits: number;
    semantic_error?: string;
  };
}

interface RankedTextCandidate<T> {
  item: T;
  text: string;
  score: number;
  semanticScore: number;
  lexicalScore: number;
  matchedTerms: string[];
}

interface LocalEmbedder {
  embedOne(text: string, role?: "query" | "document"): Promise<number[]>;
  embed(texts: string[], role?: "query" | "document"): Promise<number[][]>;
}

interface PersistedDerivedFactRevisionIndex {
  version: "derived-fact-index-v11";
  model: string;
  revision_id: string;
  memory_id: string;
  layer: "L2" | "L3";
  signature: string;
  fact_metadata: DistilledFactMetadataSet;
  event_series: EventSeriesSidecar;
  source_evidence: Array<{
    evidence_ref: string;
    layer: string | null;
    timestamp: string;
    project_id: string | null;
    conversation_id: string | null;
    text: string;
    tokens: string[];
    lower_text: string;
    vector: number[];
    temporal_time?: EventSeriesTime;
  }>;
  rows: Array<{
    fact_id: string;
    text_hash: string;
    vector: number[];
    tokens: string[];
    lower_text: string;
  }>;
}

interface RevisionVectorResult {
  vectors: number[][];
  cacheHits: number;
  cacheMisses: number;
}

const DEFAULT_MODEL = "Xenova/all-MiniLM-L6-v2";
const DERIVED_INDEX_VERSION = "derived-fact-index-v11" as const;
const QUERY_STOPWORDS = new Set([
  "a", "an", "and", "are", "at", "be", "been", "being", "did", "do", "does", "for", "from",
  "had", "has", "have", "how", "in", "is", "it", "of", "on", "or", "the", "to", "was", "were",
  "what", "when", "where", "which", "who", "why", "with", "would", "could", "should",
  "什么", "哪些", "哪个", "哪一个", "何时", "什么时候", "哪里", "为何", "为什么", "怎么", "如何"
]);
const IRREGULAR = new Map<string, string>([
  ["bought", "buy"], ["buying", "buy"], ["met", "meet"], ["went", "go"], ["gone", "go"],
  ["took", "take"], ["taken", "take"], ["made", "make"], ["ran", "run"], ["fell", "fall"],
  ["began", "begin"], ["begun", "begin"], ["played", "play"], ["playing", "play"]
]);

let embedderPromise: Promise<LocalEmbedder> | null = null;
const documentVectorCache = new Map<string, Promise<number[]>>();
const queryVectorCache = new Map<string, Promise<number[]>>();
const revisionIndexCache = new Map<string, Promise<PersistedDerivedFactRevisionIndex>>();
const lexicalPreparedCache = new Map<string, { tokens: Set<string>; lower: string }>();

/**
 * Query exact L2/L3 revision metadata as retrieval-sized fact units.
 *
 * This is deliberately a derived, in-memory retrieval lane. It never writes
 * Atomic Facts back as durable Memories, never creates an L5 layer, and all
 * hits remain anchored to the exact immutable L2/L3 revision and its evidence.
 */
export async function retrieveDerivedRevisionEvidence(input: {
  stateRoot: string;
  accountId: string;
  query: string;
  revisions: readonly HydratedMemoryEvidence[];
  mode?: "lexical" | "semantic";
  maxFacts?: number;
  includeRawEvidence?: boolean;
  maxRawEvidence?: number;
  rawEvidenceOrder?: RawEvidenceOrder;
  rawEvidenceSemanticLead?: number;
  expandEventSeries?: boolean;
  annotateTemporalEvidence?: boolean;
  temporalEvidenceOnly?: boolean;
  bindEventIdentity?: boolean;
  maxSeriesFacts?: number;
}): Promise<DerivedRevisionRetrievalResult> {
  const query = input.query.trim();
  const requestedMode = input.mode ?? derivedFactRetrievalMode();
  const maxFacts = Math.max(1, Math.min(24, Math.trunc(input.maxFacts ?? 8)));
  const maxRawEvidence = Math.max(0, Math.min(48, Math.trunc(input.maxRawEvidence ?? 4)));
  const factCandidates = input.revisions.flatMap((revision) => factCandidatesForRevision(revision));

  let semanticError: string | undefined;
  let mode: DerivedFactRetrievalMode = requestedMode;
  let rankedFacts: Array<RankedTextCandidate<(typeof factCandidates)[number]>>;
  let revisionCacheHits = 0;
  let revisionCacheMisses = 0;
  try {
    const ranked = await rankFactCandidates(
      input.stateRoot,
      input.accountId,
      query,
      factCandidates,
      requestedMode
    );
    rankedFacts = ranked.ranked;
    revisionCacheHits = ranked.cacheHits;
    revisionCacheMisses = ranked.cacheMisses;
  } catch (error) {
    semanticError = error instanceof Error ? error.message : String(error);
    mode = "lexical_fallback";
    rankedFacts = await rankTextCandidates(query, factCandidates, "lexical");
  }

  let facts: DerivedFactRetrievalHit[] = rankedFacts.slice(0, maxFacts).map((ranked) => {
    const parent = ranked.item.metadata.parents.find((candidate) => candidate.parent_id === ranked.item.fact.parent_id);
    return {
      memory_id: ranked.item.memoryId,
      ...(ranked.item.revisionId ? { revision_id: ranked.item.revisionId } : {}),
      layer: ranked.item.layer,
      fact_id: ranked.item.fact.fact_id,
      parent_id: ranked.item.fact.parent_id,
      ...(ranked.item.fact.parent_heading ? { parent_heading: ranked.item.fact.parent_heading } : {}),
      text: ranked.item.fact.text,
      ...(ranked.item.fact.canonical_time ? { canonical_time: ranked.item.fact.canonical_time } : {}),
      ...(ranked.item.fact.supersedes ? { supersedes: ranked.item.fact.supersedes } : {}),
      evidence_refs: ranked.item.fact.evidence_refs.slice(),
      ...(parent?.evidence_refs.length ? { parent_evidence_refs: parent.evidence_refs.slice() } : {}),
      score: round(ranked.score),
      semantic_score: round(ranked.semanticScore),
      lexical_score: round(ranked.lexicalScore),
      matched_terms: ranked.matchedTerms.slice(0, 16)
    };
  });

  let eventSeries: EventSeriesExpansion | undefined;
  let eventSeriesSidecars: EventSeriesSidecar[] | undefined;
  if (input.expandEventSeries && queryNeedsEventSeries(query)) {
    const sidecars = await cachedEventSeriesForRevisions(input.stateRoot, input.accountId, input.revisions);
    eventSeriesSidecars = sidecars;
    eventSeries = expandEventSeries({
      query,
      sidecars,
      seeds: facts.map((fact) => ({ fact_id: fact.fact_id, score: fact.score })),
      maxHits: Math.max(1, Math.min(12, Math.trunc(input.maxSeriesFacts ?? 8)))
    });
    if (eventSeries.query_window) {
      // A missing date or recording range is not evidence that an event is outside the window.
      const admitted = new Set(eventSeries.hits.map(hit => hit.fact_id));
      const seriesMembers = new Set(sidecars.flatMap(sidecar => sidecar.series.flatMap(series => series.member_fact_ids)));
      facts = facts.filter(fact => admitted.has(fact.fact_id) ||
        (!seriesMembers.has(fact.fact_id) &&
          (!fact.canonical_time || fact.canonical_time.precision === "range" || fact.canonical_time.precision === "unknown") &&
          eventWindowTopicRelevant(query, fact.text)));
    }
    if (eventSeries.hits.length > 0) {
      const byFact = new Map(facts.map((fact) => [fact.fact_id, fact]));
      for (const hit of eventSeries.hits) {
        const existing = byFact.get(hit.fact_id);
        if (existing) {
          existing.series_id = hit.series_id;
          existing.series_kind = hit.series_kind;
          existing.series_relation = hit.relation;
          existing.series_distance = hit.distance;
          if (hit.member.answer_time) existing.temporal_time = hit.member.answer_time;
          existing.score = Math.max(existing.score, round(hit.score));
          continue;
        }
        const sidecar = sidecars.find((candidate) => candidate.members.some((member) => member.fact_id === hit.fact_id));
        if (!sidecar) continue;
        const matchedTerms = normalizedQueryTerms(query).filter((term) =>
          hit.member.topic_terms.includes(term) || hit.member.entity_anchors.some((anchor) => anchor.toLocaleLowerCase().includes(term))
        );
        const expanded: DerivedFactRetrievalHit = {
          memory_id: sidecar.memory_id,
          revision_id: sidecar.revision_id,
          layer: sidecar.layer,
          fact_id: hit.member.fact_id,
          parent_id: hit.member.parent_id,
          ...(hit.member.parent_heading ? { parent_heading: hit.member.parent_heading } : {}),
          text: hit.member.text,
          evidence_refs: hit.member.evidence_refs.slice(),
          score: round(hit.score),
          semantic_score: 0,
          lexical_score: 0,
          matched_terms: matchedTerms.slice(0, 16),
          series_id: hit.series_id,
          series_kind: hit.series_kind,
          series_relation: hit.relation,
          series_distance: hit.distance,
          ...(hit.member.answer_time ? { temporal_time: hit.member.answer_time } : {})
        };
        facts.push(expanded);
        byFact.set(expanded.fact_id, expanded);
      }
      facts = facts.sort((left, right) => right.score - left.score || left.fact_id.localeCompare(right.fact_id))
        .slice(0, maxFacts + Math.max(1, Math.min(12, Math.trunc(input.maxSeriesFacts ?? 8))));
    }
  }

  const evidenceSufficiency = assessDerivedFactSufficiency(query, facts);
  let rawEvidence: DerivedEvidenceRetrievalHit[] = [];
  let directEvidenceRefs = 0;
  let lexicalFallbackRefs = 0;
  if (input.includeRawEvidence && maxRawEvidence > 0) {
    const cachedSourceEvidence = await cachedSourceEvidenceForRevisions(
      input.stateRoot,
      input.accountId,
      input.revisions
    );
    const direct = await directEvidenceFromFacts({
      stateRoot: input.stateRoot,
      accountId: input.accountId,
      query,
      facts,
      cachedSourceEvidence,
      fallbackEvidenceRefs: input.revisions
        .filter((revision) => revision.layer === "L2")
        .flatMap((revision) => revision.source_evidence_refs),
      maxEvidence: maxRawEvidence,
      order: input.rawEvidenceOrder,
      semanticLead: input.rawEvidenceSemanticLead
    });
    rawEvidence = direct.evidence;
    directEvidenceRefs = direct.directRefs;
    lexicalFallbackRefs = direct.lexicalFallbackRefs;
    if (input.expandEventSeries || input.annotateTemporalEvidence) {
      rawEvidence = annotateRawEvidenceTemporalHints(
        rawEvidence,
        cachedSourceEvidence,
        query,
        Boolean(input.temporalEvidenceOnly),
        eventSeries?.query_window ?? eventSeriesQueryWindow(query)
      );
    }
    if (input.bindEventIdentity) {
      eventSeriesSidecars ??= await cachedEventSeriesForRevisions(input.stateRoot, input.accountId, input.revisions);
      rawEvidence = await bindTemporalEventIdentity(rawEvidence, eventSeriesSidecars, cachedSourceEvidence, query);
    }
    if (input.expandEventSeries) {
      eventSeriesSidecars ??= await cachedEventSeriesForRevisions(input.stateRoot, input.accountId, input.revisions);
      rawEvidence = await expandRawTemporalEventEvidence(
        rawEvidence,
        eventSeriesSidecars,
        cachedSourceEvidence,
        query,
        eventSeries,
        maxRawEvidence
      );
    }
    if (eventSeries?.hits.length) {
      rawEvidence = mergeSeriesEvidence(rawEvidence, eventSeries, cachedSourceEvidence, query, maxRawEvidence);
    }
  }

  return {
    version: "derived-revision-retrieval-v1",
    mode,
    facts,
    raw_evidence: rawEvidence,
    evidence_sufficiency: evidenceSufficiency,
    ...(eventSeries ? { event_series: eventSeries } : {}),
    diagnostics: {
      fact_candidates: factCandidates.length,
      raw_evidence_candidates: directEvidenceRefs + lexicalFallbackRefs,
      semantic_enabled: requestedMode === "semantic",
      revision_cache_hits: revisionCacheHits,
      revision_cache_misses: revisionCacheMisses,
      direct_evidence_refs: directEvidenceRefs,
      lexical_fallback_refs: lexicalFallbackRefs,
      event_series_enabled: Boolean(input.expandEventSeries && queryNeedsEventSeries(query)),
      event_series_selected: eventSeries?.selected_series.length ?? 0,
      event_series_hits: eventSeries?.hits.length ?? 0,
      ...(semanticError ? { semantic_error: semanticError } : {})
    }
  };
}

export function assessDerivedFactSufficiency(
  query: string,
  facts: readonly DerivedFactRetrievalHit[]
): DerivedEvidenceSufficiency {
  const queryTerms = normalizedQueryTerms(query);
  const top = facts.slice(0, 6);
  const matched = unique(top.flatMap((fact) => fact.matched_terms));
  const coverage = queryTerms.length > 0
    ? matched.filter((term) => queryTerms.some((queryTerm) => termVariants(queryTerm).includes(term))).length / queryTerms.length
    : 0;
  const topScore = top[0]?.score ?? 0;

  if (top.length > 0 && topScore >= 0.60 && (coverage >= 0.42 || matched.length >= Math.min(3, queryTerms.length))) {
    return {
      status: "sufficient",
      query_terms: queryTerms,
      matched_terms: matched,
      lexical_coverage: round(coverage),
      top_fact_score: round(topScore),
      reason: "high-scoring derived facts cover the query anchors"
    };
  }
  if (top.length > 0 && (topScore >= 0.50 || coverage >= 0.25 || matched.length > 0)) {
    return {
      status: "partial",
      query_terms: queryTerms,
      matched_terms: matched,
      lexical_coverage: round(coverage),
      top_fact_score: round(topScore),
      reason: "derived facts are relevant but do not fully cover the query anchors"
    };
  }
  return {
    status: "insufficient",
    query_terms: queryTerms,
    matched_terms: matched,
    lexical_coverage: round(coverage),
    top_fact_score: round(topScore),
    reason: "derived facts do not provide a strong grounded match"
  };
}

function factCandidatesForRevision(revision: HydratedMemoryEvidence): Array<{
  memoryId: string;
  revisionId?: string;
  layer: "L2" | "L3";
  metadata: DistilledFactMetadataSet;
  fact: DistilledFactMetadataSet["facts"][number];
  text: string;
}> {
  if ((revision.layer !== "L2" && revision.layer !== "L3") || !revision.fact_metadata) return [];
  const layer: "L2" | "L3" = revision.layer;
  return revision.fact_metadata.facts.map((fact) => ({
    memoryId: revision.memory_id,
    ...(revision.revision_id ? { revisionId: revision.revision_id } : {}),
    layer,
    metadata: revision.fact_metadata!,
    fact,
    text: [fact.parent_heading, fact.text].filter(Boolean).join("\n")
  }));
}

async function directEvidenceFromFacts(input: {
  stateRoot: string;
  accountId: string;
  query: string;
  facts: readonly DerivedFactRetrievalHit[];
  cachedSourceEvidence: ReadonlyArray<PersistedDerivedFactRevisionIndex["source_evidence"][number]>;
  fallbackEvidenceRefs: readonly string[];
  maxEvidence: number;
  order?: RawEvidenceOrder;
  semanticLead?: number;
}): Promise<{
  evidence: DerivedEvidenceRetrievalHit[];
  directRefs: number;
  lexicalFallbackRefs: number;
}> {
  const byRef = new Map<string, { parentScore: number }>();
  const maxCandidates = Math.max(input.maxEvidence, input.maxEvidence * 3);
  const factRefs = input.facts.slice(0, 24).map((fact) => ({
    fact,
    refs: unique([...fact.evidence_refs, ...(fact.parent_evidence_refs ?? [])]
      .filter((ref) => /^l1:[^:]+$/.test(ref)))
  }));
  // Older revisions can attach a whole parent evidence block to every fact.
  // Filling the bounded candidate set fact-by-fact lets one coarse parent
  // consume every slot before a lower-ranked but still selected fact exposes
  // its exact first source. Admit provenance round-robin across selected facts
  // so each fact gets a chance before taking second/third refs.
  for (let refIndex = 0; byRef.size < maxCandidates; refIndex += 1) {
    let sawRefAtIndex = false;
    for (const { fact, refs } of factRefs) {
      const ref = refs[refIndex];
      if (!ref) continue;
      sawRefAtIndex = true;
      const existing = byRef.get(ref);
      if (!existing || fact.score > existing.parentScore) byRef.set(ref, { parentScore: fact.score });
      if (byRef.size >= maxCandidates) break;
    }
    if (!sawRefAtIndex) break;
  }
  const fallbackRefs = unique(input.fallbackEvidenceRefs.filter((ref) => /^l1:[^:]+$/.test(ref)));
  if (byRef.size === 0 && fallbackRefs.length === 0) {
    return { evidence: [], directRefs: 0, lexicalFallbackRefs: 0 };
  }

  const cachedByRef = new Map(input.cachedSourceEvidence.map((item) => [item.evidence_ref, item]));
  const needsCaptureStore = [...new Set([...byRef.keys(), ...fallbackRefs])]
    .some((ref) => !cachedByRef.has(ref));
  const events = needsCaptureStore ? await listCaptureEvents(input.stateRoot, input.accountId) : [];
  const eventById = new Map(events.map((event) => [event.event_id, event]));
  const queryTerms = normalizedQueryTerms(input.query);
  const queryVector = await embeddedQuery(input.query);
  const ranked: DerivedEvidenceRetrievalHit[] = [];
  // Preserve the proven revision-evidence candidate order. Cached semantic
  // scoring should be behaviorally equivalent to the old query-time raw-L1
  // rerank; fact provenance only supplements refs absent from that immutable
  // revision set instead of perturbing stable-sort ties.
  const candidateRefs = new Map<string, { parentScore?: number; source: "direct" | "semantic_fallback" }>();
  let lexicalFallbackRefs = 0;
  for (const ref of fallbackRefs) {
    const cached = cachedByRef.get(ref);
    const event = cached ? undefined : eventById.get(ref.slice(3));
    const text = cached?.text ?? (event ? captureEventText(event) : "");
    if (!text) continue;
    candidateRefs.set(ref, { source: "semantic_fallback" });
    lexicalFallbackRefs += 1;
  }
  for (const [ref, meta] of byRef) {
    if (!candidateRefs.has(ref)) candidateRefs.set(ref, { parentScore: meta.parentScore, source: "direct" });
  }

  for (const [ref] of candidateRefs) {
    const cached = cachedByRef.get(ref);
    const event = cached ? undefined : eventById.get(ref.slice(3));
    const text = cached?.text ?? (event ? captureEventText(event) : "");
    if (!text) continue;
    const lexical = lexicalMatch(queryTerms, text);
    const semantic = cached?.vector?.length ? clamp01(cosine(queryVector, cached.vector)) : 0;
    // Match the proven raw-evidence retrieval weighting, but consume vectors
    // precomputed with the immutable L2 revision instead of embedding hundreds
    // of L1 rows during every query. Direct fact provenance remains the
    // deterministic tiebreaker when fused scores are equal.
    const score = clamp01(0.82 * semantic + 0.18 * lexical.score);
    ranked.push({
      evidence_ref: ref,
      layer: cached?.layer ?? "L1",
      timestamp: cached?.timestamp ?? event!.timestamp,
      project_id: cached ? cached.project_id : (event!.project_hint ?? null),
      text,
      score: round(score),
      semantic_score: round(semantic),
      lexical_score: round(lexical.score),
      matched_terms: lexical.matched.slice(0, 16)
    });
  }
  ranked.sort((left, right) =>
    right.score - left.score ||
    right.lexical_score - left.lexical_score ||
    right.text.length - left.text.length
  );
  return {
    evidence: orderRawEvidence(ranked, [...byRef.keys()], input.order, input.semanticLead).slice(0, input.maxEvidence),
    directRefs: byRef.size,
    lexicalFallbackRefs
  };
}

/**
 * "semantic" keeps the query-similarity order over every source turn of the
 * revision. "cited_first" puts the turns cited by the selected facts first, in
 * fact-score order; "fused" combines both ranks by reciprocal-rank fusion.
 */
export type RawEvidenceOrder = "semantic" | "cited_first" | "fused" | "interleave";

function orderRawEvidence(
  ranked: DerivedEvidenceRetrievalHit[],
  citedRefs: readonly string[],
  order: RawEvidenceOrder = "semantic",
  semanticLead = 0
): DerivedEvidenceRetrievalHit[] {
  if (order === "semantic" || citedRefs.length === 0) return ranked;
  // Keep the first semanticLead turns of the semantic order, then reorder the rest.
  if (semanticLead > 0) {
    return [...ranked.slice(0, semanticLead), ...orderRawEvidence(ranked.slice(semanticLead), citedRefs, order)];
  }
  const citationRank = new Map(citedRefs.map((ref, index) => [ref, index]));
  if (order === "cited_first") {
    const cited = ranked.filter((hit) => citationRank.has(hit.evidence_ref))
      .sort((left, right) => citationRank.get(left.evidence_ref)! - citationRank.get(right.evidence_ref)!);
    return [...cited, ...ranked.filter((hit) => !citationRank.has(hit.evidence_ref))];
  }
  if (order === "interleave") {
    // Alternate the best remaining semantic turn and the best remaining cited turn.
    const cited = ranked.filter((hit) => citationRank.has(hit.evidence_ref))
      .sort((left, right) => citationRank.get(left.evidence_ref)! - citationRank.get(right.evidence_ref)!);
    const out: DerivedEvidenceRetrievalHit[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < ranked.length; i += 1) {
      for (const hit of [ranked[i], cited[i]]) {
        if (hit && !seen.has(hit.evidence_ref)) { seen.add(hit.evidence_ref); out.push(hit); }
      }
    }
    return out;
  }
  const fused = ranked.map((hit, semanticRank) => {
    const citation = citationRank.get(hit.evidence_ref);
    return { hit, score: 1 / (61 + semanticRank) + (citation === undefined ? 0 : 1 / (61 + citation)) };
  });
  return fused.sort((left, right) => right.score - left.score).map((item) => item.hit);
}

function captureEventText(event: {
  user_text?: string;
  assistant_text?: string;
  reasoning_summary?: string;
  tool_summary?: string;
}): string {
  return [
    event.user_text ? `user: ${event.user_text}` : "",
    event.assistant_text ? `assistant: ${event.assistant_text}` : "",
    event.reasoning_summary ? `reasoning_summary: ${event.reasoning_summary}` : "",
    event.tool_summary ? `tool_summary: ${event.tool_summary}` : ""
  ].filter(Boolean).join("\n").trim();
}

async function cachedSourceEvidenceForRevisions(
  stateRoot: string,
  accountId: string,
  revisions: readonly HydratedMemoryEvidence[]
): Promise<PersistedDerivedFactRevisionIndex["source_evidence"]> {
  const output: PersistedDerivedFactRevisionIndex["source_evidence"] = [];
  const seen = new Set<string>();
  for (const revision of revisions) {
    if (revision.layer !== "L2" || !revision.revision_id) continue;
    const index = revision.fact_metadata
      ? (await ensureDerivedFactRevisionIndex({
          stateRoot,
          accountId,
          revisionId: revision.revision_id,
          memoryId: revision.memory_id,
          layer: "L2",
          factMetadata: revision.fact_metadata
        })).index
      : await readExistingDerivedFactRevisionIndex({
          stateRoot,
          accountId,
          revisionId: revision.revision_id,
          memoryId: revision.memory_id,
          layer: "L2"
        });
    if (!index) continue;
    for (const item of index.source_evidence) {
      if (seen.has(item.evidence_ref)) continue;
      seen.add(item.evidence_ref);
      primeLexicalPreparedCache(item.text, item.tokens, item.lower_text);
      output.push(item);
    }
  }
  return output;
}

async function cachedEventSeriesForRevisions(
  stateRoot: string,
  accountId: string,
  revisions: readonly HydratedMemoryEvidence[]
): Promise<EventSeriesSidecar[]> {
  const output: EventSeriesSidecar[] = [];
  const seen = new Set<string>();
  for (const revision of revisions) {
    if ((revision.layer !== "L2" && revision.layer !== "L3") || !revision.revision_id) continue;
    const index = revision.fact_metadata
      ? (await ensureDerivedFactRevisionIndex({
          stateRoot,
          accountId,
          revisionId: revision.revision_id,
          memoryId: revision.memory_id,
          layer: revision.layer,
          factMetadata: revision.fact_metadata
        })).index
      : await readExistingDerivedFactRevisionIndex({
          stateRoot,
          accountId,
          revisionId: revision.revision_id,
          memoryId: revision.memory_id,
          layer: revision.layer
        });
    if (!index?.event_series || seen.has(index.event_series.revision_id)) continue;
    seen.add(index.event_series.revision_id);
    output.push(index.event_series);
  }
  return output;
}

function mergeSeriesEvidence(
  base: readonly DerivedEvidenceRetrievalHit[],
  expansion: EventSeriesExpansion,
  cachedSourceEvidence: ReadonlyArray<PersistedDerivedFactRevisionIndex["source_evidence"][number]>,
  query: string,
  maxEvidence: number
): DerivedEvidenceRetrievalHit[] {
  const cachedByRef = new Map(cachedSourceEvidence.map((item) => [item.evidence_ref, item]));
  const byRef = new Map(base.map((item) => [item.evidence_ref, { ...item }]));
  const queryTerms = normalizedQueryTerms(query);
  for (const hit of expansion.hits) {
    for (const ref of hit.member.evidence_refs) {
      const cached = cachedByRef.get(ref);
      if (!cached) continue;
      const queryBinding = lexicalMatch(queryTerms, cached.text);
      const rawTemporal = cached.temporal_time?.answerable ? cached.temporal_time : undefined;
      const observationMatchesWindow = expansion.query_window
        ? evidenceObservationOverlapsWindow(cached.text, expansion.query_window)
        : false;
      let temporal: EventSeriesTime | undefined;
      if (rawTemporal) {
        temporal = !expansion.query_window || temporalOverlapsWindow(rawTemporal, expansion.query_window) ||
          (observationMatchesWindow && temporalHintRelevant(query, cached.text, rawTemporal.original_expression))
          ? rawTemporal
          : undefined;
      } else if (hit.member.answer_time?.answerable &&
        (!expansion.query_window || temporalOverlapsWindow(hit.member.answer_time, expansion.query_window))) {
        const binding = lexicalMatch(normalizedQueryTerms(hit.member.text), cached.text);
        if (binding.score >= 0.28 || binding.matched.length >= 3) temporal = hit.member.answer_time;
      }
      const annotation = temporal
        ? `[Event series temporal normalization: ${temporal.raw}; source=${temporal.source}; confidence=${temporal.confidence.toFixed(2)}${temporal.original_expression ? `; expression=${temporal.original_expression}` : ""}]\n`
        : "";
      const existing = byRef.get(ref);
      const boundedSeriesScore = round(Math.min(hit.score, 0.64 + 0.36 * queryBinding.score));
      const candidate: DerivedEvidenceRetrievalHit = {
        evidence_ref: ref,
        layer: cached.layer,
        timestamp: cached.timestamp,
        project_id: cached.project_id,
        text: `${annotation}${cached.text}`,
        // Event-series membership is structural support, not a replacement for
        // query relevance. Preserve an existing raw-evidence rank when one is
        // available; for newly introduced series evidence, combine a bounded
        // structural floor with direct lexical binding to the current query so
        // a whole legacy parent evidence block cannot be flattened to score 1.
        score: round(Math.max(existing?.score ?? 0, boundedSeriesScore)),
        semantic_score: existing?.semantic_score ?? 0,
        lexical_score: existing?.lexical_score ?? round(queryBinding.score),
        matched_terms: existing?.matched_terms ?? queryBinding.matched.slice(0, 16)
      };
      if (existing?.text.startsWith("[Event family ")) continue;
      if (!existing || annotation && !existing.text.startsWith("[Event series")) {
        byRef.set(ref, candidate);
      }
    }
  }
  return [...byRef.values()]
    .sort((left, right) => right.score - left.score || right.semantic_score - left.semantic_score || left.evidence_ref.localeCompare(right.evidence_ref))
    .slice(0, maxEvidence);
}

function annotateRawEvidenceTemporalHints(
  base: readonly DerivedEvidenceRetrievalHit[],
  cachedSourceEvidence: ReadonlyArray<PersistedDerivedFactRevisionIndex["source_evidence"][number]>,
  query: string,
  temporalOnly: boolean,
  queryWindow?: NonNullable<EventSeriesExpansion["query_window"]>
): DerivedEvidenceRetrievalHit[] {
  const cachedByRef = new Map(cachedSourceEvidence.map((item) => [item.evidence_ref, item]));
  return base.flatMap((item) => {
    const temporal = cachedByRef.get(item.evidence_ref)?.temporal_time;
    if (!temporal?.answerable || item.text.startsWith("[Event series temporal normalization:")) return temporalOnly ? [] : [item];
    if (queryWindow && !temporalOverlapsWindow(temporal, queryWindow) && !evidenceObservationOverlapsWindow(item.text, queryWindow)) {
      return temporalOnly ? [] : [item];
    }
    if (!temporalHintRelevant(query, item.text, temporal.original_expression)) return temporalOnly ? [] : [item];
    const annotation = `[Event series temporal normalization: ${temporal.raw}; source=${temporal.source}; confidence=${temporal.confidence.toFixed(2)}${temporal.original_expression ? `; expression=${temporal.original_expression}` : ""}]\n`;
    return [{ ...item, text: `${annotation}${item.text}` }];
  });
}

async function bindTemporalEventIdentity(
  base: readonly DerivedEvidenceRetrievalHit[],
  sidecars: readonly EventSeriesSidecar[],
  cachedSourceEvidence: ReadonlyArray<PersistedDerivedFactRevisionIndex["source_evidence"][number]>,
  query: string
): Promise<DerivedEvidenceRetrievalHit[]> {
  const queryTerms = normalizedQueryTerms(query);
  if (queryTerms.length === 0) return base.slice();
  const queryVector = await embeddedQuery(query);
  const evidenceByRef = new Map(cachedSourceEvidence.map((item) => [item.evidence_ref, item]));
  const windowByRef = new Map(sidecars.flatMap((sidecar) => sidecar.identity_windows ?? []).map((window) => [window.evidence_ref, window]));
  return base.map((item) => {
    if (!item.text.startsWith("[Event series temporal normalization:")) return item;
    const rootMatch = lexicalMatch(queryTerms, item.text);
    const rootCoverage = rootMatch.matched.length / queryTerms.length;
    if (rootCoverage >= 0.8) return item;
    const window = windowByRef.get(item.evidence_ref);
    if (!window) return item;
    const bridge = window.next_refs[0] ? evidenceByRef.get(window.next_refs[0]) : undefined;
    if (!bridge?.vector?.length) return item;
    const bridgeSemantic = clamp01(cosine(queryVector, bridge.vector));
    const bridgeLexical = lexicalMatch(queryTerms, bridge.text).score;
    // Temporal adjacency is not event identity by itself. Require the first
    // conversational continuation to remain query-relevant before admitting
    // the bounded two-turn closure. This rejects same-session topic switches
    // such as soccer -> Sam's doctor/cooking update while retaining a letter
    // -> "who is it from?" -> sender/thanks sequence.
    const bridgeScore = 0.8 * bridgeSemantic + 0.2 * bridgeLexical;
    if (bridgeScore < 0.27) return item;
    const candidateRefs = window.next_refs.slice(0, 2);
    let text = item.text;
    const added: string[] = [];
    for (const ref of candidateRefs) {
      const evidence = evidenceByRef.get(ref);
      if (!evidence?.text) continue;
      text = `${text}\n[Event identity neighbor: ${ref}]\n${evidence.text}`;
      added.push(ref);
    }
    if (added.length === 0) return item;
    const combinedMatch = lexicalMatch(queryTerms, text);
    return {
      ...item,
      text,
      score: round(Math.min(1, item.score + 0.02)),
      matched_terms: combinedMatch.matched.slice(0, 16),
      identity_evidence_refs: added
    };
  });
}

async function expandRawTemporalEventEvidence(
  base: readonly DerivedEvidenceRetrievalHit[],
  sidecars: readonly EventSeriesSidecar[],
  cachedSourceEvidence: ReadonlyArray<PersistedDerivedFactRevisionIndex["source_evidence"][number]>,
  query: string,
  expansion: EventSeriesExpansion | undefined,
  maxEvidence: number
): Promise<DerivedEvidenceRetrievalHit[]> {
  const additions: DerivedEvidenceRetrievalHit[] = [];
  if (queryNeedsOrderedRawEventPair(query)) {
    additions.push(...await selectOrderedRawEventPair(query, cachedSourceEvidence));
  } else if (queryNeedsFirstMedicalRawEvent(query)) {
    additions.push(...await selectFirstMedicalRawEvent(query, cachedSourceEvidence));
  }
  if (expansion?.query_window) {
    additions.push(...await selectWindowedRawEventBundles(
      query,
      expansion.query_window,
      sidecars,
      cachedSourceEvidence
    ));
  }
  if (additions.length === 0) return base.slice();
  // These additions survived a stricter structural temporal gate than the
  // ordinary semantic raw-evidence lane. Insert them first so equal-score
  // series evidence cannot evict the exact event pair/window during the
  // later bounded merges and TKP supporting top-k.
  const byRef = new Map(additions.map((item) => [item.evidence_ref, { ...item }]));
  for (const item of base) {
    const previous = byRef.get(item.evidence_ref);
    if (!previous || item.score > previous.score) byRef.set(item.evidence_ref, { ...item });
  }
  for (const item of additions) {
    const previous = byRef.get(item.evidence_ref);
    if (!previous || item.score > previous.score || item.text.length > previous.text.length) {
      byRef.set(item.evidence_ref, item);
    }
  }
  return [...byRef.values()]
    .sort((left, right) => right.score - left.score || right.semantic_score - left.semantic_score || left.evidence_ref.localeCompare(right.evidence_ref))
    .slice(0, maxEvidence);
}

function queryNeedsOrderedRawEventPair(query: string): boolean {
  const lower = query.normalize("NFKC").toLocaleLowerCase();
  return /\bfirst\b.*\bsecond\b|\bsecond\b.*\bfirst\b|\bbetween\b.*\b(?:first|second)\b|\b(?:lapsed|elapsed|interval)\b|\bhow\s+many\s+(?:days?|weeks?|months?|years?)\s+(?:lapsed|elapsed|passed|between)\b/u.test(lower) ||
    /第一次.*第二次|第二次.*第一次|首次.*第二次|相隔|间隔/u.test(lower);
}

function queryNeedsFirstMedicalRawEvent(query: string): boolean {
  const lower = query.normalize("NFKC").toLocaleLowerCase();
  return /\b(?:first|earliest)\b/u.test(lower) &&
    !/\bsecond\b/u.test(lower) &&
    /\b(?:doctor|doc(?:tor)?['’]?s?|check[- ]?up|appointment)\b/u.test(lower);
}

async function selectFirstMedicalRawEvent(
  query: string,
  evidence: ReadonlyArray<PersistedDerivedFactRevisionIndex["source_evidence"][number]>
): Promise<DerivedEvidenceRetrievalHit[]> {
  const queryTerms = normalizedQueryTerms(query);
  const speakerNames = querySpeakerNames(query, evidence);
  const queryVector = await embeddedQuery(query);
  const candidates = evidence.flatMap((item) => {
    const speaker = evidenceSpeakerName(item.text);
    if (speakerNames.size > 0 && (!speaker || !speakerNames.has(speaker.toLocaleLowerCase()))) return [];
    if (!/\b(?:doctor|doc(?:tor)?['’]?s?|check[- ]?up|appointment)\b/iu.test(item.text)) return [];
    const orderDate = item.temporal_time?.start ?? evidenceMessageDate(item.text);
    if (!orderDate) return [];
    const semantic = item.vector?.length ? clamp01(cosine(queryVector, item.vector)) : 0;
    const lexical = lexicalMatch(queryTerms, item.text);
    if (semantic < 0.22 && lexical.score < 0.18) return [];
    return [{ item, orderDate, semantic, lexical }];
  });
  if (candidates.length === 0) return [];
  const byEvent = new Map<string, (typeof candidates)[number]>();
  for (const candidate of candidates) {
    const key = rawEventDedupKey(candidate.item.text, candidate.orderDate);
    const previous = byEvent.get(key);
    if (!previous || candidate.semantic > previous.semantic) byEvent.set(key, candidate);
  }
  const first = [...byEvent.values()]
    .sort((left, right) => left.orderDate.localeCompare(right.orderDate) || right.semantic - left.semantic)[0];
  if (!first) return [];
  const temporal = first.item.temporal_time?.answerable ? first.item.temporal_time : undefined;
  const annotation = temporal
    ? `[Event family ordinal member: first; ${temporal.raw}; source=${temporal.source}; confidence=${temporal.confidence.toFixed(2)}${temporal.original_expression ? `; expression=${temporal.original_expression}` : ""}]`
    : `[Event family ordinal member: first; evidence observed ${first.orderDate}; event date not explicitly normalized]`;
  return [{
    evidence_ref: first.item.evidence_ref,
    layer: first.item.layer,
    timestamp: first.item.timestamp,
    project_id: first.item.project_id,
    text: `${annotation}\n${first.item.text}`,
    score: 1,
    semantic_score: round(first.semantic),
    lexical_score: round(first.lexical.score),
    matched_terms: first.lexical.matched.slice(0, 16)
  }];
}

async function selectOrderedRawEventPair(
  query: string,
  evidence: ReadonlyArray<PersistedDerivedFactRevisionIndex["source_evidence"][number]>
): Promise<DerivedEvidenceRetrievalHit[]> {
  const queryTerms = normalizedQueryTerms(query);
  const speakerNames = querySpeakerNames(query, evidence);
  const medicalFamily = /\b(?:doctor|doc(?:tor)?['’]?s?|check[- ]?up|appointment)\b/iu.test(query);
  const queryVector = await embeddedQuery(query);
  const candidates = evidence.flatMap((item) => {
    const speaker = evidenceSpeakerName(item.text);
    if (speakerNames.size > 0 && (!speaker || !speakerNames.has(speaker.toLocaleLowerCase()))) return [];
    if (medicalFamily && !/\b(?:doctor|doc(?:tor)?['’]?s?|check[- ]?up|appointment)\b/iu.test(item.text)) return [];
    const orderDate = item.temporal_time?.start ?? evidenceMessageDate(item.text);
    if (!orderDate) return [];
    const semantic = item.vector?.length ? clamp01(cosine(queryVector, item.vector)) : 0;
    const lexical = lexicalMatch(queryTerms, item.text);
    if (semantic < 0.24 && lexical.score < 0.22) return [];
    return [{ item, orderDate, semantic, lexical }];
  });
  if (candidates.length < 2) return [];

  const byEvent = new Map<string, (typeof candidates)[number]>();
  for (const candidate of candidates) {
    const key = rawEventDedupKey(candidate.item.text, candidate.orderDate);
    const previous = byEvent.get(key);
    if (!previous || candidate.semantic > previous.semantic) byEvent.set(key, candidate);
  }
  const ordered = [...byEvent.values()]
    .sort((left, right) => left.orderDate.localeCompare(right.orderDate) || right.semantic - left.semantic);
  const selected = ordered.slice(0, 2);
  if (selected.length < 2) return [];
  const renderMember = (candidate: (typeof selected)[number], index: number): string => {
    const temporal = candidate.item.temporal_time?.answerable ? candidate.item.temporal_time : undefined;
    const annotation = temporal
      ? `[Event family ordered member ${index + 1}: ${temporal.raw}; source=${temporal.source}; confidence=${temporal.confidence.toFixed(2)}${temporal.original_expression ? `; expression=${temporal.original_expression}` : ""}]`
      : `[Event family ordered member ${index + 1}: evidence observed ${candidate.orderDate}; event date not explicitly normalized]`;
    return `${annotation}\n${candidate.item.text}`;
  };
  const first = selected[0]!;
  const second = selected[1]!;
  const monthGap = calendarMonthGap(first.orderDate, second.orderDate);
  const relation = `[Event family ordered relation: first=member1; second=member2; member1_month=${first.orderDate.slice(0, 7)}; member2_month=${second.orderDate.slice(0, 7)}${monthGap !== undefined ? `; calendar_month_gap=${monthGap}` : ""}]`;
  const combinedText = `${relation}\n${renderMember(first, 0)}\n[Event family ordered counterpart: ${second.item.evidence_ref}]\n${renderMember(second, 1)}`;
  const combinedMatch = lexicalMatch(queryTerms, combinedText);
  return [{
    evidence_ref: first.item.evidence_ref,
    layer: first.item.layer,
    timestamp: first.item.timestamp,
    project_id: first.item.project_id,
    text: combinedText,
    score: 1,
    semantic_score: round(Math.max(first.semantic, second.semantic)),
    lexical_score: round(combinedMatch.score),
    matched_terms: combinedMatch.matched.slice(0, 16),
    identity_evidence_refs: [second.item.evidence_ref]
  }];
}

async function selectWindowedRawEventBundles(
  query: string,
  window: NonNullable<EventSeriesExpansion["query_window"]>,
  sidecars: readonly EventSeriesSidecar[],
  evidence: ReadonlyArray<PersistedDerivedFactRevisionIndex["source_evidence"][number]>
): Promise<DerivedEvidenceRetrievalHit[]> {
  if (!queryNeedsRawWindowBundle(query, window)) return [];
  const queryTerms = normalizedQueryTerms(query);
  const speakerNames = querySpeakerNames(query, evidence);
  const queryVector = await embeddedQuery(query);
  const evidenceByRef = new Map(evidence.map((item) => [item.evidence_ref, item]));
  const windowByRef = new Map(sidecars.flatMap((sidecar) => sidecar.identity_windows ?? []).map((item) => [item.evidence_ref, item]));
  const candidates: DerivedEvidenceRetrievalHit[] = [];
  const allowObservationAnchor = Boolean(window.start && window.end && !window.month);

  for (const root of evidence) {
    const normalizedTemporal = root.temporal_time?.answerable ? root.temporal_time : undefined;
    const observedDate = allowObservationAnchor ? evidenceMessageDate(root.text) : undefined;
    const temporal: EventSeriesTime | undefined = normalizedTemporal ?? (observedDate ? {
      raw: observedDate,
      precision: "date",
      start: observedDate,
      source: "evidence_timestamp",
      confidence: 0.45,
      answerable: false
    } : undefined);
    if (!temporal || !temporalOverlapsWindow(temporal, window)) continue;
    const speaker = evidenceSpeakerName(root.text);
    if (speakerNames.size > 0 && (!speaker || !speakerNames.has(speaker.toLocaleLowerCase()))) continue;
    const identity = windowByRef.get(root.evidence_ref);
    const neighborRefs = identity?.next_refs.slice(0, 2) ?? [];
    const rows = [root, ...neighborRefs.flatMap((ref) => {
      const item = evidenceByRef.get(ref);
      return item ? [item] : [];
    })];
    const semantic = Math.max(...rows.map((item) => item.vector?.length ? clamp01(cosine(queryVector, item.vector)) : 0));
    const bundleText = rows.map((item) => item.text).join("\n");
    if (!eventWindowTopicRelevant(query, bundleText)) continue;
    const lexical = lexicalMatch(queryTerms, bundleText);
    const relevance = 0.78 * semantic + 0.22 * lexical.score;
    if (relevance < 0.28) continue;
    let text = normalizedTemporal
      ? `[Event family window match: ${temporal.raw}; query_window=${window.label}; source=${temporal.source}; confidence=${temporal.confidence.toFixed(2)}${temporal.original_expression ? `; expression=${temporal.original_expression}` : ""}]\n${root.text}`
      : `[Event family window observation: ${temporal.raw}; query_window=${window.label}; source=evidence_timestamp; event_time=unresolved]\n${root.text}`;
    const added: string[] = [];
    for (const ref of neighborRefs) {
      const item = evidenceByRef.get(ref);
      if (!item?.text) continue;
      text += `\n[Event family identity neighbor: ${ref}]\n${item.text}`;
      added.push(ref);
    }
    candidates.push({
      evidence_ref: root.evidence_ref,
      layer: root.layer,
      timestamp: root.timestamp,
      project_id: root.project_id,
      text,
      score: 1,
      semantic_score: round(semantic),
      lexical_score: round(lexical.score),
      matched_terms: lexical.matched.slice(0, 16),
      ...(added.length ? { identity_evidence_refs: added } : {})
    });
  }
  const selected = candidates
    .sort((left, right) => right.score - left.score || right.semantic_score - left.semantic_score || left.evidence_ref.localeCompare(right.evidence_ref))
    .slice(0, 3);
  if (selected.length === 0) return [];
  const primary = selected[0]!;
  const locationMembers = unique(selected.flatMap((item) => extractLocationMentions(item.text)));
  if (selected.length === 1 && locationMembers.length === 0) return selected;
  const relation = locationMembers.length > 0
    ? `[Event family window relation: query_window=${window.label}; location_members=${locationMembers.join("; ")}]\n`
    : `[Event family window relation: query_window=${window.label}; grouped_members=${selected.length}]\n`;
  const combinedText = relation + selected.map((item, index) =>
    index === 0
      ? item.text
      : `[Event family additional window member: ${item.evidence_ref}]\n${item.text}`
  ).join("\n");
  const combinedMatch = lexicalMatch(queryTerms, combinedText);
  return [{
    ...primary,
    text: combinedText,
    lexical_score: round(combinedMatch.score),
    matched_terms: combinedMatch.matched.slice(0, 16),
    identity_evidence_refs: unique([
      ...(primary.identity_evidence_refs ?? []),
      ...selected.slice(1).flatMap((item) => [item.evidence_ref, ...(item.identity_evidence_refs ?? [])])
    ])
  }];
}

function queryNeedsRawWindowBundle(
  query: string,
  window: NonNullable<EventSeriesExpansion["query_window"]>
): boolean {
  if (!window.month && !(window.start && window.end)) return false;
  const lower = query.normalize("NFKC").toLocaleLowerCase();
  return /\b(?:which\s+places?|what\s+places?|where\b|visiting\b|visited\b|what\s+(?:significant\s+)?events?\b|what\s+happened\b|activities\b|during\b)\b/u.test(lower) ||
    /哪些地方|什么地方|去了哪里|在哪里|什么事件|发生了什么|期间/u.test(lower);
}


function querySpeakerNames(
  query: string,
  evidence: ReadonlyArray<PersistedDerivedFactRevisionIndex["source_evidence"][number]>
): Set<string> {
  const lowerQuery = query.normalize("NFKC").toLocaleLowerCase();
  const names = new Set<string>();
  for (const item of evidence) {
    const speaker = evidenceSpeakerName(item.text);
    if (!speaker) continue;
    const normalized = speaker.toLocaleLowerCase();
    if (new RegExp(`\\b${escapeRegExp(normalized)}\\b`, "u").test(lowerQuery)) names.add(normalized);
  }
  return names;
}

function evidenceSpeakerName(text: string): string | undefined {
  return /^\s*\[[^\]]+\]\s+([A-Z][A-Za-z'’.-]{1,48})\s+\((?:user|assistant)\):/u.exec(text)?.[1];
}

function evidenceMessageDate(text: string): string | undefined {
  const human = /^\s*\[[^\]]*?\bon\s+(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December),?\s+(20\d{2})[^\]]*\]/iu.exec(text);
  if (!human) return undefined;
  const month = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"]
    .indexOf(human[2]!.toLocaleLowerCase()) + 1;
  if (month <= 0) return undefined;
  return `${human[3]}-${String(month).padStart(2, "0")}-${String(Number(human[1])).padStart(2, "0")}`;
}

function rawEventDedupKey(text: string, orderDate: string): string {
  return `${orderDate}\u0000${text.normalize("NFKC").toLocaleLowerCase()
    .replace(/\((?:user|assistant)\)/gu, "")
    .replace(/\[memory arena evidence boundary\]/gu, "")
    .replace(/\s+/gu, " ")
    .trim()}`;
}

function temporalOverlapsWindow(
  temporal: EventSeriesTime,
  window: NonNullable<EventSeriesExpansion["query_window"]>
): boolean {
  if (!temporal.start) return false;
  const end = temporal.end ?? temporal.start;
  if (window.start && window.end) return end >= window.start && temporal.start <= window.end;
  if (window.year && Number(temporal.start.slice(0, 4)) !== window.year) return false;
  if (window.month && Number(temporal.start.slice(5, 7)) !== window.month) return false;
  return Boolean(window.year || window.month);
}

function evidenceObservationOverlapsWindow(
  text: string,
  window: NonNullable<EventSeriesExpansion["query_window"]>
): boolean {
  const observed = evidenceMessageDate(text);
  if (!observed) return false;
  if (window.start && window.end) return observed >= window.start && observed <= window.end;
  if (window.year && Number(observed.slice(0, 4)) !== window.year) return false;
  if (window.month && Number(observed.slice(5, 7)) !== window.month) return false;
  return Boolean(window.year || window.month);
}

function calendarMonthGap(left: string, right: string): number | undefined {
  const a = /^(\d{4})-(\d{2})/u.exec(left);
  const b = /^(\d{4})-(\d{2})/u.exec(right);
  if (!a || !b) return undefined;
  const gap = (Number(b[1]) - Number(a[1])) * 12 + Number(b[2]) - Number(a[2]);
  return Number.isFinite(gap) && gap >= 0 ? gap : undefined;
}

function extractLocationMentions(text: string): string[] {
  const values: string[] = [];
  const pattern = /\b(?:in|at|from|through|visiting|visited|visit|went(?:\s+up)?\s+to|drove\s+to|travel(?:led|ed|ing)?\s+(?:to|through))\s+(?:the\s+)?([A-Z][A-Za-z'’.-]*(?:\s+[A-Z][A-Za-z'’.-]*){0,3})/gu;
  const rejected = new Set([
    "Evan", "Sam", "Tim", "John", "Jolene", "Deborah", "Memory Arena",
    "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"
  ]);
  for (const match of text.matchAll(pattern)) {
    const value = match[1]!.trim().replace(/[.,!?;:]+$/u, "");
    if (!value || rejected.has(value)) continue;
    values.push(value);
  }
  return unique(values).slice(0, 8);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function temporalHintRelevant(query: string, text: string, expression: string | undefined): boolean {
  if (!expression) return false;
  const lower = text.normalize("NFKC").toLocaleLowerCase();
  const needle = expression.normalize("NFKC").toLocaleLowerCase();
  const index = lower.indexOf(needle);
  if (index < 0) return false;
  const leftBoundary = Math.max(
    lower.lastIndexOf(".", index), lower.lastIndexOf("!", index), lower.lastIndexOf("?", index), lower.lastIndexOf("\n", index)
  );
  const rightCandidates = [lower.indexOf(".", index + needle.length), lower.indexOf("!", index + needle.length),
    lower.indexOf("?", index + needle.length), lower.indexOf("\n", index + needle.length)].filter((value) => value >= 0);
  const rightBoundary = rightCandidates.length > 0 ? Math.min(...rightCandidates) : text.length;
  const clause = text.slice(leftBoundary + 1, rightBoundary + 1);
  const queryTerms = normalizedQueryTerms(query);
  const match = lexicalMatch(queryTerms, clause);
  return match.matched.length >= 2 || match.score >= 0.24;
}

async function readExistingDerivedFactRevisionIndex(input: {
  stateRoot: string;
  accountId: string;
  revisionId: string;
  memoryId: string;
  layer: "L2" | "L3";
}): Promise<PersistedDerivedFactRevisionIndex | null> {
  const model = derivedEmbeddingModel();
  const path = derivedFactRevisionIndexPath(input.stateRoot, input.accountId, input.revisionId, model);
  const index = await readDerivedFactRevisionIndex(path);
  if (!index ||
      index.version !== DERIVED_INDEX_VERSION ||
      index.model !== model ||
      index.revision_id !== input.revisionId ||
      index.memory_id !== input.memoryId ||
      index.layer !== input.layer) return null;
  return index;
}

async function rankFactCandidates<T extends {
  memoryId: string;
  revisionId?: string;
  layer: "L2" | "L3";
  metadata: DistilledFactMetadataSet;
  fact: DistilledFactMetadataSet["facts"][number];
  text: string;
}>(
  stateRoot: string,
  accountId: string,
  query: string,
  candidates: readonly T[],
  mode: "lexical" | "semantic"
): Promise<{ ranked: Array<RankedTextCandidate<T>>; cacheHits: number; cacheMisses: number }> {
  if (candidates.length === 0) return { ranked: [], cacheHits: 0, cacheMisses: 0 };
  if (mode === "lexical") {
    return { ranked: await rankTextCandidates(query, candidates, "lexical"), cacheHits: 0, cacheMisses: 0 };
  }
  const queryTerms = normalizedQueryTerms(query);
  const lexical = candidates.map((candidate) => lexicalMatch(queryTerms, candidate.text));
  const queryVector = await embeddedQuery(query);
  const resolved = await revisionVectorsForCandidates(stateRoot, accountId, candidates);
  const semanticScores = resolved.vectors.map((vector) => cosine(queryVector, vector));
  const ranked = candidates.map((item, index) => {
    const semanticScore = clamp01(semanticScores[index] ?? 0);
    const lexicalScore = lexical[index]!.score;
    return {
      item,
      text: item.text,
      score: clamp01(0.82 * semanticScore + 0.18 * lexicalScore),
      semanticScore,
      lexicalScore,
      matchedTerms: lexical[index]!.matched
    };
  }).sort((left, right) =>
    right.score - left.score ||
    right.lexicalScore - left.lexicalScore ||
    right.text.length - left.text.length
  );
  return { ranked, cacheHits: resolved.cacheHits, cacheMisses: resolved.cacheMisses };
}

async function revisionVectorsForCandidates<T extends {
  memoryId: string;
  revisionId?: string;
  layer: "L2" | "L3";
  metadata: DistilledFactMetadataSet;
  fact: DistilledFactMetadataSet["facts"][number];
  text: string;
}>(
  stateRoot: string,
  accountId: string,
  candidates: readonly T[]
): Promise<RevisionVectorResult> {
  const vectors = new Array<number[]>(candidates.length);
  const grouped = new Map<string, { indices: number[]; candidate: T }>();
  const uncachedIndices: number[] = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index]!;
    if (!candidate.revisionId) {
      uncachedIndices.push(index);
      continue;
    }
    const key = `${candidate.layer}\u0000${candidate.memoryId}\u0000${candidate.revisionId}`;
    const group = grouped.get(key);
    if (group) group.indices.push(index);
    else grouped.set(key, { indices: [index], candidate });
  }

  let cacheHits = 0;
  let cacheMisses = 0;
  await Promise.all([...grouped.values()].map(async (group) => {
    const ensured = await ensureDerivedFactRevisionIndex({
      stateRoot,
      accountId,
      revisionId: group.candidate.revisionId!,
      memoryId: group.candidate.memoryId,
      layer: group.candidate.layer,
      factMetadata: group.candidate.metadata
    });
    if (ensured.cacheHit) cacheHits += 1;
    else cacheMisses += 1;
    const byFact = new Map(ensured.index.rows.map((row) => [row.fact_id, row]));
    for (const index of group.indices) {
      const candidate = candidates[index]!;
      const row = byFact.get(candidate.fact.fact_id);
      const expectedHash = derivedRetrievalCacheKey(candidate.text);
      if (!row || row.text_hash !== expectedHash) {
        throw new Error(`derived fact index mismatch for ${candidate.revisionId}/${candidate.fact.fact_id}`);
      }
      vectors[index] = row.vector;
    }
  }));

  if (uncachedIndices.length > 0) {
    const fallback = await embeddedDocuments(uncachedIndices.map((index) => candidates[index]!.text));
    for (let index = 0; index < uncachedIndices.length; index += 1) {
      vectors[uncachedIndices[index]!] = fallback[index]!;
    }
  }
  return { vectors, cacheHits, cacheMisses };
}

export async function prewarmDerivedFactRevisionIndex(input: {
  stateRoot: string;
  accountId: string;
  revisionId: string;
  memoryId: string;
  layer: "L2" | "L3";
  factMetadata: DistilledFactMetadataSet;
  sourceEvidence?: readonly DistillationEvidenceItem[];
}): Promise<{ cache_hit: boolean; facts: number; path: string }> {
  const ensured = await ensureDerivedFactRevisionIndex(input);
  return {
    cache_hit: ensured.cacheHit,
    facts: ensured.index.rows.length,
    path: derivedFactRevisionIndexPath(input.stateRoot, input.accountId, input.revisionId)
  };
}

async function ensureDerivedFactRevisionIndex(input: {
  stateRoot: string;
  accountId: string;
  revisionId: string;
  memoryId: string;
  layer: "L2" | "L3";
  factMetadata: DistilledFactMetadataSet;
  sourceEvidence?: readonly DistillationEvidenceItem[];
}): Promise<{ index: PersistedDerivedFactRevisionIndex; cacheHit: boolean }> {
  const model = derivedEmbeddingModel();
  const path = derivedFactRevisionIndexPath(input.stateRoot, input.accountId, input.revisionId, model);
  const signature = derivedRevisionSignature(input.memoryId, input.layer, input.factMetadata, model);
  const memoryKey = `${path}\u0000${signature}`;
  const existing = revisionIndexCache.get(memoryKey);
  if (existing) return { index: await existing, cacheHit: true };

  let loadedFromDisk = false;
  const promise = (async () => {
    const disk = await readDerivedFactRevisionIndex(path);
    if (disk && derivedIndexCoversRequest(disk, input, model)) {
      loadedFromDisk = true;
      primeDocumentVectorCache(disk, input.factMetadata);
      return disk;
    }

    const rows = input.factMetadata.facts.map((fact) => ({
      fact,
      text: [fact.parent_heading, fact.text].filter(Boolean).join("\n")
    }));
    const sourceRows = input.sourceEvidence
      ? sourceEvidenceRows(input.sourceEvidence)
      : disk && derivedIndexHasSameRevisionIdentity(disk, input, model)
        ? disk.source_evidence.map(({ vector: _vector, ...row }) => row)
        : [];
    const [vectors, sourceVectors] = await Promise.all([
      embeddedDocuments(rows.map((row) => row.text)),
      embeddedDocuments(sourceRows.map((row) => row.text))
    ]);
    const eventSeries = buildEventSeriesSidecar({
      revisionId: input.revisionId,
      memoryId: input.memoryId,
      layer: input.layer,
      factMetadata: input.factMetadata,
      sourceEvidence: sourceRows
    });
    const built: PersistedDerivedFactRevisionIndex = {
      version: DERIVED_INDEX_VERSION,
      model,
      revision_id: input.revisionId,
      memory_id: input.memoryId,
      layer: input.layer,
      signature,
      fact_metadata: structuredClone(input.factMetadata),
      event_series: eventSeries,
      source_evidence: sourceRows.map((row, index) => ({ ...row, vector: sourceVectors[index]! })),
      rows: rows.map((row, index) => ({
        fact_id: row.fact.fact_id,
        text_hash: derivedRetrievalCacheKey(row.text),
        vector: vectors[index]!,
        tokens: [...normalizedTokenSet(row.text)],
        lower_text: row.text.normalize("NFKC").toLocaleLowerCase()
      }))
    };
    await writeDerivedFactRevisionIndex(path, built);
    return built;
  })().catch((error) => {
    revisionIndexCache.delete(memoryKey);
    throw error;
  });
  revisionIndexCache.set(memoryKey, promise);
  const index = await promise;
  return { index, cacheHit: loadedFromDisk };
}

function derivedIndexHasSameRevisionIdentity(
  index: PersistedDerivedFactRevisionIndex,
  input: { revisionId: string; memoryId: string; layer: "L2" | "L3" },
  model: string
): boolean {
  return index.version === DERIVED_INDEX_VERSION &&
    index.model === model &&
    index.revision_id === input.revisionId &&
    index.memory_id === input.memoryId &&
    index.layer === input.layer;
}

function derivedIndexCoversRequest(
  index: PersistedDerivedFactRevisionIndex,
  input: {
    revisionId: string;
    memoryId: string;
    layer: "L2" | "L3";
    factMetadata: DistilledFactMetadataSet;
    sourceEvidence?: readonly DistillationEvidenceItem[];
  },
  model: string
): boolean {
  if (!derivedIndexHasSameRevisionIdentity(index, input, model) ||
      index.event_series?.version !== "event-series-sidecar-v4" ||
      index.fact_metadata.version !== input.factMetadata.version ||
      index.fact_metadata.layer !== input.factMetadata.layer) return false;

  // A prewarmed full-revision index may validly serve a later verified subset,
  // so do not require whole-set signature equality here. Instead, every fact
  // and parent requested now must be metadata-identical to the cached version.
  // This catches provenance/temporal/supersession-only changes while preserving
  // the existing superset reuse optimization.
  const indexedFacts = new Map(index.fact_metadata.facts.map((fact) => [fact.fact_id, fact]));
  for (const fact of input.factMetadata.facts) {
    const cached = indexedFacts.get(fact.fact_id);
    if (!cached || derivedRetrievalCacheKey(JSON.stringify(cached)) !== derivedRetrievalCacheKey(JSON.stringify(fact))) {
      return false;
    }
  }
  const indexedParents = new Map(index.fact_metadata.parents.map((parent) => [parent.parent_id, parent]));
  for (const parent of input.factMetadata.parents) {
    const cached = indexedParents.get(parent.parent_id);
    if (!cached ||
        cached.heading !== parent.heading ||
        derivedRetrievalCacheKey(JSON.stringify(cached.canonical_time ?? null)) !==
          derivedRetrievalCacheKey(JSON.stringify(parent.canonical_time ?? null)) ||
        derivedRetrievalCacheKey(JSON.stringify(cached.evidence_refs)) !==
          derivedRetrievalCacheKey(JSON.stringify(parent.evidence_refs)) ||
        parent.fact_ids.some((factId) => !cached.fact_ids.includes(factId))) return false;
  }
  const byFact = new Map(index.rows.map((row) => [row.fact_id, row]));
  for (const fact of input.factMetadata.facts) {
    const text = [fact.parent_heading, fact.text].filter(Boolean).join("\n");
    const row = byFact.get(fact.fact_id);
    if (!row || row.text_hash !== derivedRetrievalCacheKey(text)) return false;
  }
  if (input.sourceEvidence) {
    const cachedEvidence = new Map(index.source_evidence.map((item) => [item.evidence_ref, item.text]));
    for (const item of sourceEvidenceRows(input.sourceEvidence)) {
      if (cachedEvidence.get(item.evidence_ref) !== item.text) return false;
    }
  }
  return true;
}

function primeDocumentVectorCache(index: PersistedDerivedFactRevisionIndex, metadata: DistilledFactMetadataSet): void {
  const byFact = new Map(index.rows.map((row) => [row.fact_id, row]));
  for (const fact of metadata.facts) {
    const text = [fact.parent_heading, fact.text].filter(Boolean).join("\n");
    const row = byFact.get(fact.fact_id);
    if (!row || row.text_hash !== derivedRetrievalCacheKey(text)) continue;
    const key = derivedRetrievalCacheKey(`document\u0000${text}`);
    if (!documentVectorCache.has(key)) documentVectorCache.set(key, Promise.resolve(row.vector));
    primeLexicalPreparedCache(text, row.tokens, row.lower_text);
  }
}

async function readDerivedFactRevisionIndex(path: string): Promise<PersistedDerivedFactRevisionIndex | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as PersistedDerivedFactRevisionIndex;
    return parsed && Array.isArray(parsed.rows) && Array.isArray(parsed.source_evidence) && parsed.fact_metadata && parsed.event_series ? parsed : null;
  } catch {
    return null;
  }
}

function sourceEvidenceRows(
  evidence: readonly DistillationEvidenceItem[]
): Array<Omit<PersistedDerivedFactRevisionIndex["source_evidence"][number], "vector">> {
  const output: Array<Omit<PersistedDerivedFactRevisionIndex["source_evidence"][number], "vector">> = [];
  const seen = new Set<string>();
  for (const item of evidence) {
    if (item.layer !== "L1" || !/^l1:[^:]+$/.test(item.ref) || seen.has(item.ref)) continue;
    const text = [item.user_text, item.assistant_text, item.content, item.reasoning_summary]
      .filter((value): value is string => Boolean(value?.trim()))
      .join("\n")
      .trim();
    if (!text) continue;
    seen.add(item.ref);
    const temporalTime = deriveEvidenceTemporalTime({ evidence_ref: item.ref, timestamp: item.timestamp, text });
    output.push({
      evidence_ref: item.ref,
      layer: item.layer ?? null,
      timestamp: item.timestamp,
      project_id: item.project_id ?? null,
      conversation_id: item.conversation_id ?? null,
      text,
      tokens: [...normalizedTokenSet(text)],
      lower_text: text.normalize("NFKC").toLocaleLowerCase(),
      ...(temporalTime ? { temporal_time: temporalTime } : {})
    });
  }
  return output;
}

async function writeDerivedFactRevisionIndex(path: string, value: PersistedDerivedFactRevisionIndex): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value), { mode: 0o600 });
  await rename(temp, path);
}

function derivedRevisionSignature(
  memoryId: string,
  layer: "L2" | "L3",
  metadata: DistilledFactMetadataSet,
  model: string
): string {
  return derivedRetrievalCacheKey(JSON.stringify({ memoryId, layer, model, metadata }));
}

export function derivedFactRevisionIndexPath(
  stateRoot: string,
  accountId: string,
  revisionId: string,
  model = derivedEmbeddingModel()
): string {
  const account = derivedRetrievalCacheKey(accountId).slice(0, 24);
  const modelKey = derivedRetrievalCacheKey(model).slice(0, 24);
  const revision = derivedRetrievalCacheKey(revisionId);
  return join(stateRoot, "derived-fact-index", DERIVED_INDEX_VERSION, account, modelKey, `${revision}.json`);
}

export function resetDerivedFactRetrievalCachesForTests(): void {
  revisionIndexCache.clear();
  documentVectorCache.clear();
  queryVectorCache.clear();
  lexicalPreparedCache.clear();
}

async function rankTextCandidates<T extends { text: string }>(
  query: string,
  candidates: readonly T[],
  mode: "lexical" | "semantic"
): Promise<Array<RankedTextCandidate<T>>> {
  if (candidates.length === 0) return [];
  const queryTerms = normalizedQueryTerms(query);
  const lexical = candidates.map((candidate) => lexicalMatch(queryTerms, candidate.text));
  let semanticScores = candidates.map(() => 0);
  if (mode === "semantic") {
    const queryVector = await embeddedQuery(query);
    const vectors = await embeddedDocuments(candidates.map((candidate) => candidate.text));
    semanticScores = vectors.map((vector) => cosine(queryVector, vector));
  }
  return candidates.map((item, index) => {
    const semanticScore = clamp01(semanticScores[index] ?? 0);
    const lexicalScore = lexical[index]!.score;
    const score = mode === "semantic"
      ? clamp01(0.82 * semanticScore + 0.18 * lexicalScore)
      : lexicalScore;
    return {
      item,
      text: item.text,
      score,
      semanticScore,
      lexicalScore,
      matchedTerms: lexical[index]!.matched
    };
  }).sort((left, right) =>
    right.score - left.score ||
    right.lexicalScore - left.lexicalScore ||
    right.text.length - left.text.length
  );
}

function lexicalMatch(queryTerms: readonly string[], text: string): { score: number; matched: string[] } {
  if (queryTerms.length === 0) return { score: 0, matched: [] };
  const key = derivedRetrievalCacheKey(text);
  let prepared = lexicalPreparedCache.get(key);
  if (!prepared) {
    prepared = {
      tokens: normalizedTokenSet(text),
      lower: text.normalize("NFKC").toLocaleLowerCase()
    };
    lexicalPreparedCache.set(key, prepared);
  }
  const tokens = prepared.tokens;
  const lower = prepared.lower;
  const matched: string[] = [];
  let weighted = 0;
  for (const term of queryTerms) {
    const variants = termVariants(term);
    const hit = variants.find((variant) => tokens.has(variant) || lower.includes(variant));
    if (!hit) continue;
    matched.push(hit);
    weighted += Math.min(8, Math.max(2, [...term].length));
  }
  const maxWeight = queryTerms.reduce((sum, term) => sum + Math.min(8, Math.max(2, [...term].length)), 0);
  return { score: maxWeight > 0 ? clamp01(weighted / maxWeight) : 0, matched: unique(matched) };
}

function primeLexicalPreparedCache(text: string, tokens: readonly string[], lower: string): void {
  const key = derivedRetrievalCacheKey(text);
  if (!lexicalPreparedCache.has(key)) lexicalPreparedCache.set(key, { tokens: new Set(tokens), lower });
}

function normalizedQueryTerms(query: string): string[] {
  return unique(tokenizeRetrievalText(query)
    .map((term) => normalizeTerm(term))
    .filter((term) => [...term].length >= 2 && !QUERY_STOPWORDS.has(term)))
    .slice(0, 24);
}

function normalizedTokenSet(value: string): Set<string> {
  const output = new Set<string>();
  for (const token of tokenizeRetrievalText(value)) {
    for (const variant of termVariants(token)) output.add(variant);
  }
  return output;
}

function termVariants(value: string): string[] {
  const token = normalizeTerm(value);
  const variants = new Set<string>([token, IRREGULAR.get(token) ?? token]);
  const add = (candidate: string) => {
    const normalized = normalizeTerm(candidate);
    if (normalized.length >= 3) variants.add(IRREGULAR.get(normalized) ?? normalized);
  };
  if (token.endsWith("ies") && token.length > 4) add(`${token.slice(0, -3)}y`);
  else if (token.endsWith("s") && token.length > 3) add(token.slice(0, -1));
  if (token.endsWith("ing") && token.length > 5) {
    const base = token.slice(0, -3); add(base); add(`${base}e`);
    if (base.length > 3 && base.at(-1) === base.at(-2)) add(base.slice(0, -1));
  }
  if (token.endsWith("ed") && token.length > 4) {
    const base = token.slice(0, -2); add(base); add(`${base}e`);
    if (base.length > 3 && base.at(-1) === base.at(-2)) add(base.slice(0, -1));
  }
  return [...variants];
}

function normalizeTerm(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().trim();
}

async function localEmbedder(): Promise<LocalEmbedder> {
  if (!embedderPromise) {
    embedderPromise = (async () => {
      const moduleUrl = new URL("../vendor/memory-core/src/model/embedder.js", import.meta.url).href;
      const loaded = await import(moduleUrl) as { createEmbedder(config: Record<string, unknown>): LocalEmbedder };
      return loaded.createEmbedder({
        provider: "local",
        model: derivedEmbeddingModel(),
        normalize: true,
        cache: true
      });
    })();
  }
  return embedderPromise;
}

function derivedEmbeddingModel(): string {
  return env("DERIVED_FACT_EMBEDDING_MODEL")?.trim() || DEFAULT_MODEL;
}

function embeddedQuery(query: string): Promise<number[]> {
  const key = derivedRetrievalCacheKey(`query\u0000${query}`);
  const cached = queryVectorCache.get(key);
  if (cached) return cached;
  const promise = localEmbedder()
    .then((embedder) => embedder.embedOne(query, "query"))
    .catch((error) => {
      queryVectorCache.delete(key);
      throw error;
    });
  queryVectorCache.set(key, promise);
  return promise;
}

async function embeddedDocuments(texts: readonly string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const rows = texts.map((text) => ({ text, key: derivedRetrievalCacheKey(`document\u0000${text}`) }));
  const missingByKey = new Map<string, string>();
  for (const row of rows) if (!documentVectorCache.has(row.key)) missingByKey.set(row.key, row.text);
  if (missingByKey.size > 0) {
    const missing = [...missingByKey].map(([key, text]) => ({ key, text }));
    const embedder = await localEmbedder();
    const batch = embedder.embed(missing.map((row) => row.text), "document");
    for (let index = 0; index < missing.length; index += 1) {
      const row = missing[index]!;
      const vectorPromise = batch
        .then((vectors) => {
          const vector = vectors[index];
          if (!vector) throw new Error(`derived fact embedding row ${index} is missing`);
          return vector;
        })
        .catch((error) => {
          documentVectorCache.delete(row.key);
          throw error;
        });
      documentVectorCache.set(row.key, vectorPromise);
    }
  }
  return Promise.all(rows.map((row) => documentVectorCache.get(row.key)!));
}

function derivedFactRetrievalMode(): "lexical" | "semantic" {
  return env("DERIVED_FACT_RETRIEVAL")?.trim().toLocaleLowerCase() === "semantic"
    ? "semantic"
    : "lexical";
}

function cosine(left: readonly number[], right: readonly number[]): number {
  if (left.length === 0 || left.length !== right.length) return 0;
  let dot = 0, leftNorm = 0, rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index] ?? 0, b = right[index] ?? 0;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (leftNorm <= 0 || rightNorm <= 0) return 0;
  return dot / Math.sqrt(leftNorm * rightNorm);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

export function derivedRetrievalCacheKey(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
