import type { RecallHit } from "../../contracts/retrieval.js";
import type { RetrievalScopeEnvelope } from "../scope/project-scope.js";
import { rankRecallHits, type RetrievalRankResult } from "./ranker.js";

export interface MemoryStore {
  add(request: Record<string, unknown>): Promise<unknown>;
  read(memoryId: string): Promise<unknown>;
}

export interface SemanticRetriever {
  search(query: string, scope: RetrievalScopeEnvelope, limit: number): Promise<RecallHit[]>;
}

export interface LexicalRetriever {
  search(query: string, scope: RetrievalScopeEnvelope, limit: number): Promise<RecallHit[]>;
}

export interface FusionRanker {
  rank(query: string, candidates: readonly RecallHit[], limit: number): RetrievalRankResult;
}

export interface Hydrator {
  load(evidenceRef: string): Promise<unknown>;
}

export interface Compactor<TInput = unknown, TOutput = unknown> {
  compact(input: TInput): Promise<TOutput> | TOutput;
}

export interface EvaluationCaseResult {
  selectedEvidence: string[];
  contextBytes: number;
  hydrateCount: number;
  latencyMs: number;
}

export interface Evaluator<TCase = unknown> {
  evaluate(testCase: TCase): Promise<EvaluationCaseResult>;
}

/** Current production fusion adapter. Scope legality is resolved by Hub before this adapter is called. */
export class RetrievalV1FusionRanker implements FusionRanker {
  rank(query: string, candidates: readonly RecallHit[], limit: number): RetrievalRankResult {
    return rankRecallHits(candidates, query, limit);
  }
}
