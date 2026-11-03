import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { createTestRoot } from "./test-isolation.mjs";
import { parseDistillationClaimTraces, recordDistillationTrace, validateDistillationTraceSpans } from "../dist/distillation-trace.js";

const allowed = ["l1:event-a", "l1:event-b"];
const claims = parseDistillationClaimTraces([{
  claim_id: "claim-1",
  claim_key: "project:state",
  action: "supersede",
  source_evidence_refs: ["l1:event-a", "l1:event-b"],
  previous_claim: "old",
  new_claim: "new",
  model_confidence: 0.92,
  validation_result: "evidence_chain_valid",
  repair_count: 1,
  reason: "newer explicit evidence"
}], allowed);
assert.equal(claims.length, 1);
assert.equal(claims[0].action, "supersede");
assert.throws(() => parseDistillationClaimTraces([{
  claim_id: "bad",
  action: "new",
  source_evidence_refs: ["l1:not-validated"]
}], allowed), /outside the validated distillation evidence set/);
const evidence = [
  { ref: "l1:event-a", kind: "turn", timestamp: "2026-10-30", user_text: "Movement is horizontal." },
  { ref: "l1:event-b", kind: "turn", timestamp: "2026-10-30", user_text: "Another source." }
];
const withSpan = [{ ...claims[0], source_evidence_refs: ["l1:event-a"], source_spans: ["Movement is horizontal."] }];
assert.doesNotThrow(() => validateDistillationTraceSpans(withSpan, evidence));
assert.throws(() => validateDistillationTraceSpans([{ ...withSpan[0], source_spans: ["Movement is vertical."] }], evidence), /source_spans/);
assert.throws(() => validateDistillationTraceSpans([{ ...withSpan[0], source_spans: ["Another source."] }], evidence), /source_spans/);

const root = await createTestRoot("distillation-trace-");
try {
  const receipt = await recordDistillationTrace({
    stateRoot: root,
    accountId: "acct",
    jobId: "job-1",
    targetLayer: "l3",
    projectId: "memhub",
    commitRevision: "l3:memory-1:revision-1",
    claims
  });
  assert.match(receipt.distillation_id, /^dt_[a-f0-9]{32}$/);
  assert.equal(receipt.claims, 1);
  assert.equal(receipt.stored, true);
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("memhub-distillation-trace-e2e: ok");
