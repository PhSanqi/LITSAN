import type { RecallHit } from "../../contracts/retrieval.js";
import type { RetrievalCandidateDecision, RetrievalRankResult } from "./ranker.js";

export const LITSAN_CORE_RETRIEVAL_VERSION = "memhub-core-v1" as const;

/**
 * Unified LITSAN retrieval boundary.
 *
 * Memory Core already owns candidate generation, channel fusion, thresholding,
 * and MMR. This adapter deliberately preserves Core ordering instead of
 * applying another BM25/fusion/diversity pass in LITSAN. LITSAN only adds
 * bounded duplicate protection plus structured diagnostics for TKP and audit.
 */
export function selectLitsanCoreHits(
  hits: readonly RecallHit[],
  query: string,
  limit: number
): RetrievalRankResult {
  const boundedLimit = Math.max(1, Math.min(50, Math.trunc(limit)));
  const queryTerms = tokenizeRetrievalText(query).slice(0, 32);
  const deduped = dedupeCandidates(hits);
  // The Memory Core result order already contains its fused channel ranking,
  // thresholding and MMR decisions. Preserve it exactly. Sorting again by the
  // scalar score here would silently undo Core's diversity ordering and create
  // another ranking layer under a different name.
  const ordered = [...deduped.hits];
  const selected = ordered.slice(0, boundedLimit);
  const decisions: RetrievalCandidateDecision[] = ordered.map((hit, index) => {
    const tokens = new Set(documentTokens(hit));
    const coreScore = round(Math.max(0, Number.isFinite(hit.score) ? hit.score : 0));
    const matchedTerms = queryTerms.filter((term) => tokens.has(term)).slice(0, 16);
    return {
      id: hit.id,
      memoryLayer: hit.memoryLayer,
      source: hit.source,
      rank: index + 1,
      semanticScore: 0,
      lexicalScore: 0,
      fusedScore: coreScore,
      diversityPenaltyApplied: 0,
      adjustedScore: coreScore,
      coreScore,
      matchedTerms,
      result: index < boundedLimit ? "kept" : "dropped",
      reason: index < boundedLimit ? "ranked" : "top_k"
    };
  });
  const lastKept = decisions[Math.min(boundedLimit, decisions.length) - 1];
  const firstDropped = decisions[boundedLimit];
  const cutoff = lastKept ? {
    lastKeptRank: lastKept.rank!,
    lastKeptAdjustedScore: lastKept.adjustedScore!,
    ...(firstDropped ? {
      firstDroppedRank: firstDropped.rank!,
      firstDroppedAdjustedScore: firstDropped.adjustedScore!,
      adjustedScoreGap: round(lastKept.adjustedScore! - firstDropped.adjustedScore!)
    } : {})
  } : undefined;

  return {
    hits: selected.map((hit, index) => {
      const decision = decisions[index]!;
      return {
        hit,
        rank: index + 1,
        semanticScore: 0,
        lexicalScore: 0,
        fusedScore: decision.fusedScore ?? 0,
        diversityPenaltyApplied: 0,
        coreScore: decision.coreScore,
        matchedTerms: decision.matchedTerms ?? []
      };
    }),
    diagnostics: {
      version: "retrieval-v1",
      rankingMode: "memhub_core",
      engineVersion: LITSAN_CORE_RETRIEVAL_VERSION,
      semanticWeight: 0,
      lexicalWeight: 0,
      diversityPenalty: 0,
      candidateCount: hits.length,
      dedupedCount: ordered.length,
      emittedCount: selected.length,
      queryTerms,
      ...(cutoff ? { cutoff } : {}),
      decisions: [...decisions, ...deduped.decisions]
    }
  };
}

/**
 * Shared tokenizer for mixed Chinese/Latin retrieval diagnostics and TKP term
 * matching. Short Han runs are retained whole and all Han bigrams are added;
 * Latin/numeric identifiers remain intact.
 */
export function tokenizeRetrievalText(value: string): string[] {
  const normalized = value.normalize("NFKC").toLocaleLowerCase();
  const segments = normalized.match(/[\p{L}\p{N}]+/gu) ?? [];
  const output: string[] = [];
  for (const segment of segments) {
    if (/^[\p{Script=Han}]+$/u.test(segment)) {
      if (segment.length === 1) output.push(segment);
      else {
        if (segment.length <= 8) output.push(segment);
        for (let index = 0; index < segment.length - 1; index += 1) output.push(segment.slice(index, index + 2));
      }
      continue;
    }
    if (segment.length >= 2 || /^\d+$/u.test(segment)) output.push(segment);
  }
  return unique(output).slice(0, 512);
}

function dedupeCandidates(hits: readonly RecallHit[]): {
  hits: RecallHit[];
  decisions: RetrievalCandidateDecision[];
} {
  const byId = new Set<string>();
  const byContent = new Map<string, string>();
  const output: RecallHit[] = [];
  const decisions: RetrievalCandidateDecision[] = [];
  for (const hit of hits) {
    if (byId.has(hit.id)) {
      decisions.push({
        id: hit.id,
        memoryLayer: hit.memoryLayer,
        source: hit.source,
        result: "dropped",
        reason: "duplicate_id",
        duplicateOf: hit.id
      });
      continue;
    }
    byId.add(hit.id);
    const contentKey = normalizeForComparison(`${hit.title ?? ""}\n${hit.snippet}`);
    const duplicateOf = contentKey ? byContent.get(contentKey) : undefined;
    if (duplicateOf) {
      decisions.push({
        id: hit.id,
        memoryLayer: hit.memoryLayer,
        source: hit.source,
        result: "dropped",
        reason: "duplicate_content",
        duplicateOf
      });
      continue;
    }
    if (contentKey) byContent.set(contentKey, hit.id);
    output.push(hit);
  }
  return { hits: output, decisions };
}

function documentTokens(hit: RecallHit): string[] {
  const title = tokenizeRetrievalText(hit.title ?? "");
  const body = tokenizeRetrievalText(hit.snippet);
  return [...title, ...title, ...body].slice(0, 2_048);
}

function normalizeForComparison(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
