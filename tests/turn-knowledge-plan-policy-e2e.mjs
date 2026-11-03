import assert from "node:assert/strict";
import { buildTurnKnowledgePlan, DEFAULT_TURN_KNOWLEDGE_POLICY } from "../dist/turn-knowledge-plan.js";
import { tokenizeRetrievalText } from "../dist/retrieval-ranker.js";

const query = "retrieval latest preference workflow architecture critical tail";
const queryTerms = tokenizeRetrievalText(query);
const retrieval = (content) => ({
  rank: 1,
  semanticScore: 0.7,
  lexicalScore: 0.7,
  fusedScore: 0.7,
  diversityPenaltyApplied: 0,
  matchedTerms: queryTerms.filter((term) => new Set(tokenizeRetrievalText(content)).has(term)),
  candidateCount: 1,
  dedupedCount: 1
});
const item = (id, layer, content, options = {}) => ({
  id,
  ...(options.evidenceRef ? { evidenceRef: options.evidenceRef } : {}),
  content,
  authority: options.authority ?? "remembered",
  scope: options.scope ?? "project",
  source: options.source ?? "memmy-memory",
  ...((options.scope ?? "project") === "project" ? { projectId: "memhub" } : {}),
  provenance: {
    memoryLayer: layer,
    ...(options.freshness ? { freshness: options.freshness } : {}),
    retrievalV1: retrieval(content)
  }
});
const architecture = (id, content) => ({
  id, content, authority: "authoritative", scope: "project", source: "project-architecture", projectId: "memhub"
});
const lane = {
  version: "retrieval-v1",
  semanticWeight: 0.68,
  lexicalWeight: 0.32,
  diversityPenalty: 0.12,
  candidateCount: 20,
  dedupedCount: 20,
  emittedCount: 20,
  queryTerms,
  decisions: []
};
const baseCapsule = {
  accountId: "acct",
  conversationId: null,
  resolvedProjectId: "memhub",
  resolutionSource: "explicit_project",
  recallScope: "global_and_project",
  globalState: [], globalMemory: [],
  projectMemory: [],
  reusableSkills: [],
  projectArchitecture: [],
  ambiguities: [],
  branchContext: null,
  contextBudget: {
    maxContentBytes: 512000,
    maxItemContentBytes: 128000,
    emittedContentBytes: 0,
    truncatedItems: 0,
    droppedItems: 0
  },
  retrievalDiagnostics: {
    version: "retrieval-v1",
    requestedLimit: 20,
    finalLimit: 20,
    candidateLimit: 50,
    lanes: { global: lane, project: lane, skills: lane }
  }
};

const diversityCapsule = {
  ...baseCapsule,
  projectMemory: [
    item("l3", "L3", "retrieval current truth", { evidenceRef: "l3:l3:r1" }),
    ...Array.from({ length: 6 }, (_, index) => item(
      `l1-${index + 1}`,
      "L1",
      `retrieval latest evidence ${index + 1}`,
      { authority: "evidence", source: "memhub-capture", freshness: "undistilled", evidenceRef: `l1:l1-${index + 1}` }
    )),
    item("l2", "L2", "retrieval latest chronology", { evidenceRef: "l2:l2:r1" })
  ],
  globalMemory: [item("l4", "L4", "retrieval stable preference", { scope: "global", evidenceRef: "l4:l4:r1" })],
  reusableSkills: [item("skill", "Skill", "retrieval workflow", { scope: "capability" })]
};

const baseline = await buildTurnKnowledgePlan({ query, capsule: diversityCapsule });
assert.deepEqual(baseline.supporting.map((entry) => entry.kind), ["L1", "L1", "L1", "L1"]);

const balanced = await buildTurnKnowledgePlan({
  query,
  capsule: diversityCapsule,
  policy: { supportingSelection: "balanced" }
});
assert.deepEqual(balanced.supporting.map((entry) => entry.kind), ["L1", "L2", "L4", "skill"]);

const longContent = `# Retrieval Critical Tail\n${"retrieval background ".repeat(90)}critical tail FACT_MATCHED_WINDOW`;
const passageCapsule = {
  ...baseCapsule,
  projectMemory: [item("long-l3", "L3", longContent, { evidenceRef: "l3:long-l3:r1" })]
};
const defaultPassage = await buildTurnKnowledgePlan({
  query,
  capsule: passageCapsule,
  hydrateEvidence: async () => ({ content: longContent })
});
assert.equal(defaultPassage.required[0].passages.some((passage) => passage.text.includes("FACT_MATCHED_WINDOW")), true);
const headPassage = await buildTurnKnowledgePlan({
  query, capsule: passageCapsule,
  hydrateEvidence: async () => ({ content: longContent }),
  policy: { passageWindow: "head" }
});
assert.equal(headPassage.required[0].passages.some((passage) => passage.text.includes("FACT_MATCHED_WINDOW")), false);
const matchedPassage = await buildTurnKnowledgePlan({
  query,
  capsule: passageCapsule,
  hydrateEvidence: async () => ({ content: longContent }),
  policy: { passageWindow: "matched", maxPassageChars: 600 }
});
assert.equal(matchedPassage.required[0].passages.some((passage) => passage.text.includes("FACT_MATCHED_WINDOW")), true);

const architectureCapsule = {
  ...baseCapsule,
  projectMemory: [item("arch-l3", "L3", "retrieval architecture current truth", { evidenceRef: "l3:arch-l3:r1" })],
  projectArchitecture: Array.from({ length: 4 }, (_, index) =>
    architecture(`arch-${index + 1}`, `# Retrieval Architecture ${index + 1}\nretrieval architecture constraint ${index + 1}`)
  )
};
const defaultArchitecture = await buildTurnKnowledgePlan({ query, capsule: architectureCapsule });
assert.equal(defaultArchitecture.required.filter((entry) => entry.kind === "architecture").length, 2);
const expandedArchitecture = await buildTurnKnowledgePlan({
  query,
  capsule: architectureCapsule,
  policy: { maxArchitectureEntries: 4, maxRequiredEntries: 6 }
});
assert.equal(expandedArchitecture.required.filter((entry) => entry.kind === "architecture").length, 4);

assert.equal(DEFAULT_TURN_KNOWLEDGE_POLICY.trustAdmittedArchitecture, false);
assert.equal(DEFAULT_TURN_KNOWLEDGE_POLICY.trustAdmittedSupporting, false);

const admittedTrustCapsule = {
  ...baseCapsule,
  projectMemory: [item("trust-l3", "L3", "retrieval current truth", { evidenceRef: "l3:trust-l3:r1" })],
  projectArchitecture: [architecture("trust-arch", "# Alternative constraint\nBounded orchestration remains authoritative even when query wording differs.")],
  reusableSkills: [item("trust-skill", "Skill", "counterexample generation procedure", { scope: "capability" })]
};
const untrustedAdmission = await buildTurnKnowledgePlan({ query, capsule: admittedTrustCapsule });
assert.equal(untrustedAdmission.required.some((entry) => entry.id === "trust-arch"), false);
assert.equal(untrustedAdmission.supporting.some((entry) => entry.id === "trust-skill"), false);
const trustedAdmission = await buildTurnKnowledgePlan({
  query,
  capsule: admittedTrustCapsule,
  policy: {
    trustAdmittedArchitecture: true,
    trustAdmittedSupporting: true,
    maxArchitectureEntries: 2,
    maxRequiredEntries: 4,
    maxSupportingEntries: 4
  }
});
assert.equal(trustedAdmission.required.some((entry) => entry.id === "trust-arch"), true);
assert.equal(trustedAdmission.supporting.some((entry) => entry.id === "trust-skill"), true);

console.log("turn-knowledge-plan-policy-e2e: ok");
