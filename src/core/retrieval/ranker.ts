import type { RecallHit } from "../../contracts/retrieval.js";
import { tokenizeRetrievalText as tokenizeLitsanCoreText } from "./litsan-core.js";

import type { RetrievalRankDiagnostics, RetrievalCandidateDecision } from "../../contracts/retrieval.js";
export type { RetrievalRankDiagnostics, RetrievalCandidateDecisionReason, RetrievalCandidateDecision, RetrievalCutoffDiagnostics } from "../../contracts/retrieval.js";

export interface RankedRecallHit {
  hit: RecallHit;
  rank: number;
  semanticScore: number;
  lexicalScore: number;
  fusedScore: number;
  diversityPenaltyApplied: number;
  coreScore?: number;
  matchedTerms: string[];
}

export interface RetrievalRankResult {
  hits: RankedRecallHit[];
  diagnostics: RetrievalRankDiagnostics;
}

const SEMANTIC_WEIGHT = 0.68;
const LEXICAL_WEIGHT = 0.32;
const DIVERSITY_PENALTY = 0.12;

/**
 * Retrieval v1 second-stage ranker.
 *
 * The caller must establish account/project/scope legality before invoking
 * this function. The ranker never broadens scope: it only reorders and
 * compresses an already legal candidate set.
 */
export function rankRecallHits(
  hits: readonly RecallHit[],
  query: string,
  limit: number
): RetrievalRankResult {
  const boundedLimit = Math.max(1, Math.min(50, Math.trunc(limit)));
  const queryTerms = tokenizeRetrievalText(query).slice(0, 32);
  const deduped = dedupeCandidates(hits);
  const uniqueCandidates = deduped.hits;
  const tokenized = uniqueCandidates.map((hit) => ({
    hit,
    tokens: documentTokens(hit),
    tokenSet: new Set(documentTokens(hit))
  }));
  const lexicalRaw = bm25Scores(tokenized.map((candidate) => candidate.tokens), queryTerms);
  const maxLexical = Math.max(0, ...lexicalRaw);

  const scored = tokenized.map((candidate, index) => {
    const semanticScore = normalizeSemantic(candidate.hit.score);
    const lexicalScore = maxLexical > 0 ? lexicalRaw[index]! / maxLexical : 0;
    const phraseBoost = exactPhraseBoost(query, candidate.hit);
    const fusedScore = clamp01(
      SEMANTIC_WEIGHT * semanticScore +
      LEXICAL_WEIGHT * lexicalScore +
      phraseBoost
    );
    return {
      ...candidate,
      semanticScore,
      lexicalScore,
      fusedScore,
      matchedTerms: queryTerms.filter((term) => candidate.tokenSet.has(term))
    };
  });

  const ordered: Array<(typeof scored)[number] & { adjusted: number; penalty: number }> = [];
  const remaining = [...scored];
  while (remaining.length > 0) {
    let bestIndex = 0;
    let bestAdjusted = Number.NEGATIVE_INFINITY;
    let bestPenalty = 0;
    for (let index = 0; index < remaining.length; index += 1) {
      const candidate = remaining[index]!;
      const similarity = ordered.length === 0
        ? 0
        : Math.max(...ordered.map((prior) => jaccard(candidate.tokenSet, prior.tokenSet)));
      const penalty = DIVERSITY_PENALTY * similarity;
      const adjusted = candidate.fusedScore - penalty;
      const best = remaining[bestIndex]!;
      if (
        adjusted > bestAdjusted ||
        (adjusted === bestAdjusted && candidate.fusedScore > best.fusedScore) ||
        (adjusted === bestAdjusted && candidate.fusedScore === best.fusedScore && candidate.hit.id.localeCompare(best.hit.id) < 0)
      ) {
        bestIndex = index;
        bestAdjusted = adjusted;
        bestPenalty = penalty;
      }
    }
    const [picked] = remaining.splice(bestIndex, 1);
    ordered.push({ ...picked!, adjusted: bestAdjusted, penalty: bestPenalty });
  }

  const selected = ordered.slice(0, boundedLimit);
  const rankedDecisions: RetrievalCandidateDecision[] = ordered.map((candidate, index) => ({
    id: candidate.hit.id,
    memoryLayer: candidate.hit.memoryLayer,
    source: candidate.hit.source,
    rank: index + 1,
    semanticScore: round(candidate.semanticScore),
    lexicalScore: round(candidate.lexicalScore),
    fusedScore: round(candidate.fusedScore),
    diversityPenaltyApplied: round(candidate.penalty),
    adjustedScore: round(candidate.adjusted),
    matchedTerms: candidate.matchedTerms.slice(0, 16),
    result: index < boundedLimit ? "kept" : "dropped",
    reason: index < boundedLimit ? "ranked" : "top_k"
  }));
  const lastKept = rankedDecisions[Math.min(boundedLimit, rankedDecisions.length) - 1];
  const firstDropped = rankedDecisions[boundedLimit];
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
    hits: selected.map((candidate, index) => ({
      hit: candidate.hit,
      rank: index + 1,
      semanticScore: round(candidate.semanticScore),
      lexicalScore: round(candidate.lexicalScore),
      fusedScore: round(candidate.fusedScore),
      diversityPenaltyApplied: round(candidate.penalty),
      matchedTerms: candidate.matchedTerms.slice(0, 16)
    })),
    diagnostics: {
      version: "retrieval-v1",
      rankingMode: "memhub_v1",
      semanticWeight: SEMANTIC_WEIGHT,
      lexicalWeight: LEXICAL_WEIGHT,
      diversityPenalty: DIVERSITY_PENALTY,
      candidateCount: hits.length,
      dedupedCount: uniqueCandidates.length,
      emittedCount: selected.length,
      queryTerms,
      ...(cutoff ? { cutoff } : {}),
      decisions: [...rankedDecisions, ...deduped.decisions]
    }
  };
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

function bm25Scores(documents: readonly string[][], queryTerms: readonly string[]): number[] {
  if (documents.length === 0 || queryTerms.length === 0) return documents.map(() => 0);
  const averageLength = documents.reduce((sum, doc) => sum + doc.length, 0) / Math.max(1, documents.length);
  const documentFrequency = new Map<string, number>();
  for (const doc of documents) {
    const seen = new Set(doc);
    for (const term of queryTerms) if (seen.has(term)) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
  }
  const k1 = 1.2;
  const b = 0.75;
  return documents.map((doc) => {
    const frequencies = new Map<string, number>();
    for (const token of doc) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
    let score = 0;
    for (const term of queryTerms) {
      const tf = frequencies.get(term) ?? 0;
      if (tf === 0) continue;
      const df = documentFrequency.get(term) ?? 0;
      const idf = Math.log(1 + (documents.length - df + 0.5) / (df + 0.5));
      const denominator = tf + k1 * (1 - b + b * doc.length / Math.max(1, averageLength));
      score += idf * (tf * (k1 + 1)) / denominator;
    }
    return score;
  });
}

export const tokenizeRetrievalText = tokenizeLitsanCoreText;

function exactPhraseBoost(query: string, hit: RecallHit): number {
  const phrase = normalizeForComparison(query);
  if (!phrase || phrase.length < 3 || phrase.length > 120) return 0;
  const document = normalizeForComparison(`${hit.title ?? ""} ${hit.snippet}`);
  return document.includes(phrase) ? 0.08 : 0;
}

function normalizeSemantic(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value / (1 + value);
}

function normalizeForComparison(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

function jaccard(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  const union = left.size + right.size - intersection;
  return union > 0 ? intersection / union : 0;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
