import assert from "node:assert/strict";
import { compareRetrievalBenchmarks, evaluateRetrievalBenchmark } from "../dist/evaluation-harness.js";

const cases = [{
  id: "current-truth",
  query: "what is current",
  project: "memhub",
  required_evidence: ["l3:current"],
  critical_evidence: ["l3:current"],
  optional_evidence: ["l2:history"],
  forbidden_evidence: ["l3:superseded"],
  expected_current_claims: ["current"]
}, {
  id: "critical-support",
  query: "supporting and critical",
  project: "memhub",
  required_evidence: ["l2:support"],
  critical_evidence: ["l3:critical"],
  optional_evidence: []
}];
const baseline = evaluateRetrievalBenchmark(cases, [{
  selected_evidence: ["l3:current", "l3:superseded", "l3:current"],
  current_claim_evidence: ["l3:current"],
  superseded_evidence: ["l3:superseded"],
  context_bytes: 7800,
  hydrate_count: 3,
  latency_ms: 25
}, {
  selected_evidence: ["l2:support"],
  current_claim_evidence: ["l2:support"],
  superseded_evidence: [],
  context_bytes: 2000,
  hydrate_count: 1,
  latency_ms: 5
}]);
const candidate = evaluateRetrievalBenchmark(cases, [{
  selected_evidence: ["l3:current", "l2:history"],
  current_claim_evidence: ["l3:current"],
  superseded_evidence: ["l3:superseded"],
  context_bytes: 6100,
  hydrate_count: 2,
  latency_ms: 22
}, {
  selected_evidence: ["l2:support", "l3:critical"],
  current_claim_evidence: ["l2:support", "l3:critical"],
  superseded_evidence: [],
  context_bytes: 2400,
  hydrate_count: 1,
  latency_ms: 7
}]);
assert.equal(baseline.grounded_task_accuracy, 0.5);
assert.equal(baseline.critical_recall, 0.5);
assert.equal(candidate.grounded_task_accuracy, 1);
assert.equal(candidate.recall, 1);
assert.equal(candidate.critical_recall, 1);
assert.equal(candidate.precision, 1);
assert.equal(candidate.superseded_leakage, 0);
assert.equal(candidate.duplicate_ratio, 0);
const delta = compareRetrievalBenchmarks(baseline, candidate);
assert.ok(delta.precision > 0);
assert.ok(delta.context_bytes < 0);
console.log("memhub-evaluation-harness-e2e: ok");
