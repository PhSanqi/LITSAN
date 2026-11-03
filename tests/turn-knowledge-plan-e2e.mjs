import assert from "node:assert/strict";
import { buildTurnKnowledgePlan } from "../dist/turn-knowledge-plan.js";
import { extractDistilledFactMetadata } from "../dist/fact-metadata.js";

const retrieval = (matchedTerms = []) => ({
  rank: 1,
  semanticScore: 0.7,
  lexicalScore: matchedTerms.length > 0 ? 0.8 : 0,
  fusedScore: 0.72,
  diversityPenaltyApplied: 0,
  matchedTerms,
  candidateCount: 2,
  dedupedCount: 2
});

const lane = {
  version: "retrieval-v1",
  semanticWeight: 0.68,
  lexicalWeight: 0.32,
  diversityPenalty: 0.12,
  candidateCount: 2,
  dedupedCount: 2,
  emittedCount: 2,
  queryTerms: ["本轮知识", "使用计划", "current", "truth", "memmy", "context"],
  decisions: []
};

const capsule = {
  accountId: "acct",
  conversationId: null,
  resolvedProjectId: "memhub",
  resolutionSource: "explicit_project",
  recallScope: "global_and_project",
  globalState: [], globalMemory: [{
    id: "l4-profile",
    evidenceRef: "l4:l4-profile:r4",
    content: "# Stable preference\n- Prefer minimal sufficient architecture and low runtime overhead.",
    authority: "remembered",
    scope: "global",
    source: "memmy-memory",
    provenance: { memoryLayer: "L4", retrievalV1: retrieval(["minimal"]) }
  }],
  projectMemory: [{
    id: "l3-profile",
    evidenceRef: "l3:l3-profile:r3",
    content: "# LITSAN rules\n- Account identity is stable.\n- Harness owns semantic judgment.",
    authority: "remembered",
    scope: "project",
    source: "memmy-memory",
    projectId: "memhub",
    provenance: { memoryLayer: "L3", retrievalV1: retrieval(["harness"]) }
  }, {
    id: "l2-timeline",
    evidenceRef: "l2:l2-timeline:r2",
    content: "# Timeline\n## Earlier\nOld unrelated work.",
    authority: "remembered",
    scope: "project",
    source: "memmy-memory",
    projectId: "memhub",
    provenance: { memoryLayer: "L2", retrievalV1: retrieval(["memmy"]) }
  }],
  reusableSkills: [{
    id: "skill-unrelated",
    content: "Skill candidate: unrelated media workflow",
    authority: "remembered",
    scope: "capability",
    source: "memmy-memory",
    projectId: "other",
    provenance: { memoryLayer: "Skill", retrievalV1: retrieval([]) }
  }],
  projectArchitecture: [{
    id: "architecture:litsan:context",
    content: "# Context Router\nThe litsan_context boundary keeps one primary project and bounded progressive disclosure.\n\n# Other\nUnrelated deployment detail.",
    authority: "authoritative",
    scope: "project",
    source: "project-architecture",
    projectId: "memhub"
  }],
  ambiguities: [],
  branchContext: null,
  contextBudget: {
    maxContentBytes: 96000,
    maxItemContentBytes: 24000,
    emittedContentBytes: 5000,
    truncatedItems: 0,
    droppedItems: 0
  },
  retrievalDiagnostics: {
    version: "retrieval-v1",
    requestedLimit: 4,
    finalLimit: 4,
    candidateLimit: 16,
    lanes: { global: lane, project: lane, skills: lane }
  }
};

const hydrationCalls = [];
const plan = await buildTurnKnowledgePlan({
  query: "实现本轮知识使用计划，让 litsan_context 明确 Current Truth，并保持低开销",
  capsule,
  hydrateEvidence: async (evidenceRef) => {
    hydrationCalls.push(evidenceRef);
    if (evidenceRef.startsWith("l3:")) {
      return { content: "# LITSAN rules\n- Account identity is stable.\n- 本轮知识使用计划应把 L3 Current Truth 标成 required，并让 Harness 负责最终语义判断。\n- Do not add a second memory service." };
    }
    if (evidenceRef.startsWith("l2:")) {
      return { content: "# Timeline\n## Earlier\nOld unrelated work.\n\n## Turn Knowledge Plan\nlitsan_context 开始组织本轮知识使用角色，并保持 progressive disclosure。" };
    }
    return null;
  }
});

assert.equal(plan.version, "turn-knowledge-plan-v1");
assert.equal(plan.persistence, "none");
assert.equal(plan.model_calls, 0);
assert.equal(plan.sufficiency, "unknown");
assert.deepEqual(new Set(hydrationCalls), new Set(["l3:l3-profile:r3", "l2:l2-timeline:r2"]));
assert.equal(plan.coverage.hydrated_full_revisions, 2);

const l3 = plan.required.find((entry) => entry.kind === "L3");
assert.ok(l3);
assert.match(l3.passages.map((passage) => passage.text).join("\n"), /本轮知识使用计划/);
const architecture = plan.required.find((entry) => entry.kind === "architecture");
assert.ok(architecture);
assert.match(architecture.passages.map((passage) => passage.text).join("\n"), /litsan_context/);
const l2 = plan.supporting.find((entry) => entry.kind === "L2");
assert.ok(l2);
assert.match(l2.passages.map((passage) => passage.text).join("\n"), /litsan_context|Turn Knowledge Plan/);
assert.equal(plan.supporting.some((entry) => entry.id === "skill-unrelated"), false);
assert.ok(plan.evidence_on_demand.candidate_evidence_refs.includes("l3:l3-profile:r3"));
assert.ok(plan.evidence_on_demand.candidate_evidence_refs.includes("l2:l2-timeline:r2"));

const partial = await buildTurnKnowledgePlan({
  query: "same query",
  capsule: {
    ...capsule,
    contextBudget: { ...capsule.contextBudget, truncatedItems: 1 }
  }
});
assert.equal(partial.sufficiency, "partial");
assert.equal(partial.coverage.context_truncated_items, 1);

const degraded = await buildTurnKnowledgePlan({
  query: "same query",
  capsule: {
    ...capsule,
    retrievalDiagnostics: { ...capsule.retrievalDiagnostics, coreStatus: ["fts_search:failed_pattern_fallback"] }
  }
});
assert.equal(degraded.sufficiency, "partial");
assert.equal(degraded.coverage.retrieval_degraded, true);
assert.deepEqual(degraded.coverage.core_status, ["fts_search:failed_pattern_fallback"]);

// Dedupe may remove passage text only when the capsule already carries that
// exact semantic window. A retrieval snippet must not erase a useful passage
// selected from the hydrated full revision.
const snippetCapsule = {
  ...capsule,
  projectMemory: [{
    ...capsule.projectMemory[0],
    id: "l3-snippet",
    evidenceRef: "l3:l3-snippet:r3",
    content: "# Project Profile\n## Subject\nAlex (user)."
  }],
  projectArchitecture: [],
  globalMemory: [],
  reusableSkills: []
};
const hydratedTail = [
  "# Project Profile",
  "## Subject",
  "Alex (user).",
  "## Stable preferences and attributes",
  "Alex prefers jasmine tea and Alex's dog Miso sees veterinarian Dr. Chen."
].join("\n");
const dedupedSnippet = await buildTurnKnowledgePlan({
  query: "Who is the veterinarian of Alex's dog?",
  capsule: snippetCapsule,
  dedupe: true,
  hydrateEvidence: async () => ({ content: hydratedTail })
});
const hydratedL3 = dedupedSnippet.required.find((entry) => entry.id === "l3-snippet");
assert.ok(hydratedL3);
assert.ok(Array.isArray(hydratedL3.passages));
assert.match(hydratedL3.passages.map((passage) => passage.text).join("\n"), /Dr\. Chen/);

const completeCapsule = {
  ...snippetCapsule,
  projectMemory: [{ ...snippetCapsule.projectMemory[0], content: hydratedTail }]
};
const dedupedComplete = await buildTurnKnowledgePlan({
  query: "Who is the veterinarian of Alex's dog?",
  capsule: completeCapsule,
  dedupe: true,
  hydrateEvidence: async () => ({ content: hydratedTail })
});
const completeL3 = dedupedComplete.required.find((entry) => entry.id === "l3-snippet");
assert.ok(completeL3);
assert.equal(completeL3.passages, undefined);

// Highly overlapping L2 support should not repeat the same fact already
// carried by required L3 Current Truth, while a distinct chronology passage
// must remain available.
const precisionCapsule = {
  ...capsule,
  globalMemory: [],
  reusableSkills: [],
  projectArchitecture: [],
  projectMemory: [{
    ...capsule.projectMemory[0],
    id: "l3-current",
    evidenceRef: "l3:l3-current:r3",
    content: "# Current state\nAlex's current favorite color is green, changed from blue in 2026."
  }, {
    ...capsule.projectMemory[1],
    id: "l2-history",
    evidenceRef: "l2:l2-history:r2",
    content: "# 2026\nAlex's favorite color changed from blue to green in 2026. Green is Alex's current favorite color.\n\n# 2025\nAlex moved from Seattle to Portland in February 2025."
  }]
};
const precisionPlan = await buildTurnKnowledgePlan({
  query: "What is Alex's current favorite color?",
  capsule: precisionCapsule,
  hydrateEvidence: async (ref) => ref.startsWith("l3:")
    ? { content: precisionCapsule.projectMemory[0].content }
    : { content: precisionCapsule.projectMemory[1].content }
});
const precisionL3 = precisionPlan.required.find((entry) => entry.id === "l3-current");
const precisionL2 = precisionPlan.supporting.find((entry) => entry.id === "l2-history");
assert.ok(precisionL3?.passages?.some((passage) => /green/.test(passage.text)));
assert.ok(precisionL2);
assert.equal(precisionL2.passages?.some((passage) => /favorite color changed/.test(passage.text)), false);
assert.equal(precisionL2.passages?.some((passage) => /Portland/.test(passage.text)), false);

const chronologyPlan = await buildTurnKnowledgePlan({
  query: "Where did Alex move in 2025?",
  capsule: precisionCapsule,
  hydrateEvidence: async (ref) => ref.startsWith("l3:")
    ? { content: precisionCapsule.projectMemory[0].content }
    : { content: precisionCapsule.projectMemory[1].content }
});
const chronologyL2 = chronologyPlan.supporting.find((entry) => entry.id === "l2-history");
assert.ok(chronologyL2?.passages?.some((passage) => /Portland/.test(passage.text)));

const structuredTimeline = [
  "# Timeline",
  "## Relocation / 搬家",
  "Canonical time: 2025-02-14 (from the original expression 'last Friday')",
  "- Atomic fact: Alex moved from Seattle to Portland. | Evidence: l1:move-1",
  "- Supersedes: Alex lived in Seattle. | Evidence: l1:move-0",
  "- Atomic fact: Alex bought a red notebook after the move. | Evidence: l1:notebook-1"
].join("\n");
const structuredMetadata = extractDistilledFactMetadata("l2", structuredTimeline);
assert.ok(structuredMetadata);
const structuredCapsule = {
  ...capsule,
  globalMemory: [], reusableSkills: [], projectArchitecture: [],
  projectMemory: [{
    ...capsule.projectMemory[1], id: "l2-structured", evidenceRef: "l2:l2-structured:r1", content: structuredTimeline
  }]
};
const structuredTemporal = await buildTurnKnowledgePlan({
  query: "When did Alex move to Portland?",
  capsule: structuredCapsule,
  hydrateEvidence: async () => ({ content: "# Compact display", factMetadata: structuredMetadata })
});
const structuredTemporalL2 = structuredTemporal.supporting.find((entry) => entry.id === "l2-structured");
assert.ok(structuredTemporalL2?.passages?.some((passage) => /Atomic fact: Alex moved/.test(passage.text)));
assert.ok(structuredTemporalL2?.passages?.some((passage) => /Canonical time: 2025-02-14/.test(passage.text)));

const multiDateTimeline = [
  "# Timeline",
  "## 2025-01-03: Portland planning", "Canonical time: 2025-01-03",
  "- Atomic fact: Alex planned a Portland visit. | Evidence: l1:plan-1",
  "## 2025-02-14: Portland museum", "Canonical time: 2025-02-14",
  "- Atomic fact: Alex visited a Portland museum. | Evidence: l1:museum-1",
  "## 2025-03-20: Portland park", "Canonical time: 2025-03-20",
  "- Atomic fact: Alex visited a Portland park. | Evidence: l1:park-1"
].join("\n");
const multiDateMetadata = extractDistilledFactMetadata("l2", multiDateTimeline);
const multiDatePlan = await buildTurnKnowledgePlan({
  query: "When did Alex visit Portland?",
  capsule: { ...structuredCapsule, projectMemory: [{ ...structuredCapsule.projectMemory[0], id: "l2-multi-date", content: multiDateTimeline }] },
  hydrateEvidence: async () => ({ content: multiDateTimeline, factMetadata: multiDateMetadata }),
  policy: { maxPassagesPerEntry: 3 }
});
const multiDateL2 = multiDatePlan.supporting.find((entry) => entry.id === "l2-multi-date");
assert.equal(multiDateL2?.passages?.length, 3);
assert.equal(multiDateL2?.passages?.every((passage) => /Atomic fact:/.test(passage.text) && /Canonical time:/.test(passage.text)), true);

const rarityTimeline = [
  "# Timeline",
  "## 2025-01-01: Team practice", "Canonical time: 2025-01-01", "- Atomic fact: Alex joined teammates for practice. | Evidence: l1:team-1",
  "## 2025-01-02: Team dinner", "Canonical time: 2025-01-02", "- Atomic fact: Alex met teammates for dinner. | Evidence: l1:team-2",
  "## 2025-01-03: Chicago", "Canonical time: 2025-01-03", "- Atomic fact: Alex visited Chicago. | Evidence: l1:chicago-1",
  "## 2025-01-04: Team review", "Canonical time: 2025-01-04", "- Atomic fact: Alex thanked teammates after a review. | Evidence: l1:team-3"
].join("\n");
const rarityMetadata = extractDistilledFactMetadata("l2", rarityTimeline);
const rarityPlan = await buildTurnKnowledgePlan({
  query: "When was Alex in Chicago versus with teammates?",
  capsule: { ...structuredCapsule, projectMemory: [{ ...structuredCapsule.projectMemory[0], id: "l2-rarity", content: rarityTimeline }] },
  hydrateEvidence: async () => ({ content: rarityTimeline, factMetadata: rarityMetadata }),
  policy: { maxPassagesPerEntry: 3 }
});
assert.match(rarityPlan.supporting.find((entry) => entry.id === "l2-rarity")?.passages?.[0]?.text ?? "", /visited Chicago/);

const lemmaTimeline = [
  "# Timeline",
  "## 2025-01-01: Team discussion", "Canonical time: 2025-01-01", "- Atomic fact: Alex discussed teammates after practice. | Evidence: l1:discuss-1",
  "## 2025-01-02: Team meeting", "Canonical time: 2025-01-02", "- Atomic fact: Alex met teammates after practice. | Evidence: l1:meet-1",
  "## 2025-01-03: Team review", "Canonical time: 2025-01-03", "- Atomic fact: Alex thanked teammates after practice. | Evidence: l1:thanks-1"
].join("\n");
const lemmaMetadata = extractDistilledFactMetadata("l2", lemmaTimeline);
const lemmaPlan = await buildTurnKnowledgePlan({
  query: "When did Alex meet teammates after practice?",
  capsule: { ...structuredCapsule, projectMemory: [{ ...structuredCapsule.projectMemory[0], id: "l2-lemma", content: lemmaTimeline }] },
  hydrateEvidence: async () => ({ content: lemmaTimeline, factMetadata: lemmaMetadata }),
  policy: { maxPassagesPerEntry: 3 }
});
assert.match(lemmaPlan.supporting.find((entry) => entry.id === "l2-lemma")?.passages?.[0]?.text ?? "", /met teammates/);

const headingLeakTimeline = [
  "# Timeline",
  "## 2023-03-28 — Yoga atmosphere and music preferences",
  "- Atomic fact: Deborah bought new yoga props and a candle to improve the atmosphere and her practice. | Evidence: l1:props",
  "- Atomic fact: Jolene listens to Nils Frahm during yoga and planned to explore Deborah's recommendations. | Evidence: l1:jolene",
  "## Preferences and coping",
  "- Atomic fact: Deborah prefers mellow instrumental music for meditation and relaxation. | Evidence: l1:music"
].join("\n");
const headingLeakMetadata = extractDistilledFactMetadata("l2", headingLeakTimeline);
const headingLeakPlan = await buildTurnKnowledgePlan({
  query: "What type of music does Deborah find helpful during her yoga practice?",
  capsule: { ...structuredCapsule, projectMemory: [{ ...structuredCapsule.projectMemory[0], id: "l2-heading-leak", content: headingLeakTimeline }] },
  hydrateEvidence: async () => ({ content: headingLeakTimeline, factMetadata: headingLeakMetadata }),
  policy: { maxPassagesPerEntry: 1 }
});
assert.match(headingLeakPlan.supporting.find((entry) => entry.id === "l2-heading-leak")?.passages?.[0]?.text ?? "", /mellow instrumental music/);

const roadtripTimeline = [
  "# Timeline",
  "## Family and health",
  "- Atomic fact: Evan traveled in Canada with his partner and said his family motivated him to stay healthy. | Evidence: l1:family",
  "## Jasper road trip",
  "- Atomic fact: Evan took his family on a road trip to Jasper through the Icefields Parkway. | Evidence: l1:jasper",
  "## Rockies road trip",
  "- Atomic fact: Evan described a recent road trip to the Rocky Mountains as refreshing and relaxing. | Evidence: l1:rockies"
].join("\n");
const roadtripMetadata = extractDistilledFactMetadata("l2", roadtripTimeline);
const roadtripPlan = await buildTurnKnowledgePlan({
  query: "Where has Evan been on roadtrips with his family?",
  capsule: { ...structuredCapsule, projectMemory: [{ ...structuredCapsule.projectMemory[0], id: "l2-roadtrips", content: roadtripTimeline }] },
  hydrateEvidence: async () => ({ content: roadtripTimeline, factMetadata: roadtripMetadata }),
  policy: { maxPassagesPerEntry: 2 }
});
const roadtripText = roadtripPlan.supporting.find((entry) => entry.id === "l2-roadtrips")?.passages?.map((passage) => passage.text).join("\n") ?? "";
assert.match(roadtripText, /Jasper/);
assert.match(roadtripText, /Rocky Mountains/);

const structuredState = await buildTurnKnowledgePlan({
  query: "Where does Alex live now after the change?", capsule: structuredCapsule,
  hydrateEvidence: async () => ({ content: structuredTimeline, factMetadata: structuredMetadata })
});
const structuredStateL2 = structuredState.supporting.find((entry) => entry.id === "l2-structured");
assert.ok(structuredStateL2?.passages?.some((passage) => /Supersedes: Alex lived in Seattle/.test(passage.text)));

console.log("turn-knowledge-plan-e2e: ok");
