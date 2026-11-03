export interface RecallHit {
  id: string;
  kind: string;
  memoryLayer: string;
  status: string;
  title?: string;
  snippet: string;
  score: number;
  tags: string[];
  createdAt?: string;
  updatedAt?: string;
  source: string;
  retrievalRoutes?: string[];
}

export interface RetrievalRankDiagnostics {
  version: "retrieval-v1";
  rankingMode?: "memhub_v1" | "memhub_core";
  engineVersion?: string;
  semanticWeight: number;
  lexicalWeight: number;
  diversityPenalty: number;
  candidateCount: number;
  dedupedCount: number;
  emittedCount: number;
  queryTerms: string[];
  cutoff?: RetrievalCutoffDiagnostics;
  decisions: RetrievalCandidateDecision[];
}

export type RetrievalCandidateDecisionReason =
  | "ranked"
  | "top_k"
  | "duplicate_id"
  | "duplicate_content"
  | "canonical_revision_fallback"
  | "fresh_l1_injected"
  | "fresh_l1_merge_limit"
  | "other_branch";

export interface RetrievalCandidateDecision {
  id: string;
  memoryLayer?: string;
  source?: string;
  rank?: number;
  semanticScore?: number;
  lexicalScore?: number;
  fusedScore?: number;
  diversityPenaltyApplied?: number;
  adjustedScore?: number;
  coreScore?: number;
  matchedTerms?: string[];
  result: "kept" | "dropped";
  reason: RetrievalCandidateDecisionReason;
  duplicateOf?: string;
}

export interface RetrievalCutoffDiagnostics {
  lastKeptRank: number;
  lastKeptAdjustedScore: number;
  firstDroppedRank?: number;
  firstDroppedAdjustedScore?: number;
  adjustedScoreGap?: number;
}

export interface ContextRecallDiagnostics {
  version: "retrieval-v1";
  rankingMode?: RetrievalRankingMode;
  requestedLimit: number;
  finalLimit: number;
  candidateLimit: number;
  coreStatus?: string[];
  lanes: {
    global: RetrievalRankDiagnostics;
    globalState: RetrievalRankDiagnostics;
    project: RetrievalRankDiagnostics;
    skills: RetrievalRankDiagnostics;
  };
}

export type RetrievalRankingMode = "memhub_v1" | "memhub_core";

