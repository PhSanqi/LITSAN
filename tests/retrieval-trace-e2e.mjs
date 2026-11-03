import assert from "node:assert/strict";
import { createTestRoot } from "./test-isolation.mjs";
import {
  explainRetrievalDecisionTrace,
  recordRetrievalDecisionTrace
} from "../dist/retrieval-trace.js";

const root = await createTestRoot("retrieval-trace-");
const accountId = "acct-trace";

const lane = (decisions, cutoff) => ({
  version: "retrieval-v1",
  semanticWeight: 0.68,
  lexicalWeight: 0.32,
  diversityPenalty: 0.12,
  candidateCount: decisions.length,
  dedupedCount: decisions.length,
  emittedCount: decisions.filter((decision) => decision.result === "kept").length,
  queryTerms: ["top", "retrieval", "trace"],
  ...(cutoff ? { cutoff } : {}),
  decisions
});

const capsule = {
  accountId,
  conversationId: null,
  resolvedProjectId: "memhub",
  resolutionSource: "explicit_project",
  recallScope: "global_and_project",
  globalState: [], globalMemory: [],
  projectMemory: [{
    id: "l1-kept",
    evidenceRef: "l1:l1-kept",
    content: "recent retrieval trace discussion",
    authority: "evidence",
    scope: "project",
    source: "memhub-capture",
    projectId: "memhub",
    provenance: { memoryLayer: "L1", freshness: "undistilled" }
  }],
  reusableSkills: [],
  projectArchitecture: [],
  ambiguities: [],
  branchContext: null,
  contextBudget: {
    maxContentBytes: 8000,
    maxItemContentBytes: 3000,
    emittedContentBytes: 34,
    truncatedItems: 0,
    droppedItems: 0
  },
  contextBudgetTrace: {
    decisions: [{
      collection: "projectMemory",
      id: "l1-kept",
      result: "kept",
      reason: "within_budget",
      originalBytes: 34,
      emittedBytes: 34
    }]
  },
  retrievalDiagnostics: {
    version: "retrieval-v1",
    requestedLimit: 2,
    finalLimit: 2,
    candidateLimit: 8,
    lanes: {
      global: lane([]),
      project: lane([
        {
          id: "l1-kept",
          memoryLayer: "L1",
          source: "memhub-capture",
          rank: 1,
          matchedTerms: ["retrieval", "trace"],
          result: "kept",
          reason: "fresh_l1_injected"
        },
        {
          id: "l1-topk-drop",
          memoryLayer: "L1",
          source: "search",
          rank: 3,
          semanticScore: 0.5,
          lexicalScore: 0.8,
          fusedScore: 0.596,
          diversityPenaltyApplied: 0.02,
          adjustedScore: 0.576,
          matchedTerms: ["retrieval"],
          result: "dropped",
          reason: "top_k"
        }
      ], {
        lastKeptRank: 2,
        lastKeptAdjustedScore: 0.61,
        firstDroppedRank: 3,
        firstDroppedAdjustedScore: 0.576,
        adjustedScoreGap: 0.034
      }),
      skills: lane([])
    }
  }
};

const plan = {
  version: "turn-knowledge-plan-v1",
  mode: "deterministic-existing-retrieval",
  persistence: "none",
  model_calls: 0,
  required: [],
  supporting: [{ role: "supporting", kind: "L1", id: "l1-kept", reason: "undistilled_turn_evidence" }],
  evidence_on_demand: {
    purpose: "why_or_provenance_only",
    tool: "litsan_memory",
    action: "why",
    candidate_evidence_refs: ["l1:l1-kept"]
  },
  coverage: {
    project_resolved: true,
    recall_scope: "global_and_project",
    current_truth_found: false,
    architecture_relevant: false,
    context_truncated_items: 0,
    context_dropped_items: 0,
    passage_bytes: 0,
    hydrated_full_revisions: 0,
    hydration_failures: 0,
    retrieval_degraded: false,
    core_status: [],
    omitted_items: 0
  },
  sufficiency: "unknown"
};

const receipt = await recordRetrievalDecisionTrace({
  stateRoot: root,
  accountId,
  query: "为什么刚刚的 topk retrieval 讨论没有召回",
  capsule,
  plan
});
assert.match(receipt.trace_id, /^rt_[a-f0-9]{32}$/);
assert.equal(receipt.query_stored, false);
assert.equal(receipt.candidate_decisions, 2);

const topk = await explainRetrievalDecisionTrace({
  stateRoot: root,
  accountId,
  traceId: receipt.trace_id,
  target: {
    evidence_ref: "l1:l1-topk-drop",
    memory_id: "l1-topk-drop",
    layer: "L1",
    project_id: "memhub"
  }
});
assert.equal(topk.first_exclusion_stage, "retrieval_ranking");
assert.equal(topk.reason, "top_k");
assert.equal(topk.retrieval.candidate_seen, true);

// Golden case for the real failure mode that motivated this feature: the
// exact recent L1 exists, but the recorded trace never saw it as a candidate.
// Explain must distinguish that from a later Top-K or context-budget cut.
const recentMissing = await explainRetrievalDecisionTrace({
  stateRoot: root,
  accountId,
  traceId: receipt.trace_id,
  target: {
    evidence_ref: "l1:l1-recent-discussion",
    memory_id: "l1-recent-discussion",
    layer: "L1",
    project_id: "memhub"
  }
});
assert.equal(recentMissing.first_exclusion_stage, "candidate_recall");
assert.equal(recentMissing.reason, "not_in_candidate_pool");
assert.equal(recentMissing.retrieval.candidate_seen, false);
assert.match(recentMissing.note, /candidate-recall miss/);

console.log("memhub-retrieval-trace-e2e: ok");
