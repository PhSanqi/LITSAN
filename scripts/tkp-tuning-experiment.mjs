#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildContextCapsule, utf8Prefix } from "../dist/context-capsule.js";
import {
  buildTurnKnowledgePlan,
  DEFAULT_TURN_KNOWLEDGE_POLICY
} from "../dist/turn-knowledge-plan.js";
import { tokenizeRetrievalText } from "../dist/retrieval-ranker.js";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const OUTPUT = resolve(ROOT, ".review-runtime", "tkp-tuning-matrix-20261023.json");
const FINAL_BUDGET_BYTES = 3_200;
const FINAL_ITEM_BYTES = 1_000;

const scenarios = [
  scenarioArchitectureCapacity(),
  scenarioSupportingDiversity(),
  scenarioFreshL1Flood(),
  scenarioPassageCount(),
  scenarioPassageLength(),
  scenarioConflictVisibility(),
  scenarioMixedPressure()
];

const policies = uniquePolicies([
  namedPolicy("baseline", {}),
  ...[3, 4, 6, 8, 12].map((value) => namedPolicy(`required_${value}`, { maxRequiredEntries: value })),
  ...[2, 4, 6, 8, 12, 16].map((value) => namedPolicy(`supporting_${value}`, { maxSupportingEntries: value })),
  ...[1, 2, 3, 4, 6].map((value) => namedPolicy(`architecture_${value}`, { maxArchitectureEntries: value })),
  ...[1, 2, 3, 4, 5, 6].map((value) => namedPolicy(`passages_${value}`, { maxPassagesPerEntry: value })),
  ...[256, 450, 600, 900, 1_200, 1_800].map((value) => namedPolicy(`passage_chars_${value}`, { maxPassageChars: value })),
  ...[1, 2, 4, 6, 8, 12].map((value) => namedPolicy(`fresh_l1_${value}`, { maxFreshL1Entries: value })),
  namedPolicy("fresh_relevant_only", { freshL1RelevantOnly: true }),
  namedPolicy("fresh_required", { freshL1Role: "required", maxRequiredEntries: 8 }),
  namedPolicy("support_balanced", { supportingSelection: "balanced" }),
  namedPolicy("support_score", { supportingSelection: "score" }),
  namedPolicy("matched_window_600", { passageWindow: "matched", maxPassageChars: 600 }),
  namedPolicy("matched_window_900", { passageWindow: "matched", maxPassageChars: 900 }),
  namedPolicy("matched_window_1200", { passageWindow: "matched", maxPassageChars: 1_200 }),
  namedPolicy("balanced_support_6", { supportingSelection: "balanced", maxSupportingEntries: 6 }),
  namedPolicy("balanced_support_8", { supportingSelection: "balanced", maxSupportingEntries: 8 }),
  namedPolicy("arch4_support6", { maxArchitectureEntries: 4, maxRequiredEntries: 6, maxSupportingEntries: 6 }),
  namedPolicy("arch6_support8", { maxArchitectureEntries: 6, maxRequiredEntries: 8, maxSupportingEntries: 8 }),
  namedPolicy("arch4_balanced6", {
    maxArchitectureEntries: 4,
    maxRequiredEntries: 6,
    maxSupportingEntries: 6,
    supportingSelection: "balanced"
  }),
  namedPolicy("arch6_balanced8", {
    maxArchitectureEntries: 6,
    maxRequiredEntries: 8,
    maxSupportingEntries: 8,
    supportingSelection: "balanced"
  }),
  namedPolicy("arch4_balanced6_relevant_l1", {
    maxArchitectureEntries: 4,
    maxRequiredEntries: 6,
    maxSupportingEntries: 6,
    supportingSelection: "balanced",
    freshL1RelevantOnly: true,
    maxFreshL1Entries: 4
  }),
  namedPolicy("roomy_passages", {
    maxArchitectureEntries: 4,
    maxRequiredEntries: 6,
    maxSupportingEntries: 6,
    supportingSelection: "balanced",
    maxPassagesPerEntry: 5,
    maxPassageChars: 1_200
  }),
  namedPolicy("balanced_matched", {
    maxArchitectureEntries: 4,
    maxRequiredEntries: 6,
    maxSupportingEntries: 6,
    supportingSelection: "balanced",
    freshL1RelevantOnly: true,
    maxFreshL1Entries: 4,
    passageWindow: "matched",
    maxPassagesPerEntry: 4,
    maxPassageChars: 900
  }),
  namedPolicy("large_plan", {
    maxArchitectureEntries: 6,
    maxRequiredEntries: 10,
    maxSupportingEntries: 12,
    supportingSelection: "balanced",
    maxPassagesPerEntry: 6,
    maxPassageChars: 1_800,
    maxFreshL1Entries: 8
  })
]);

const rows = [];
for (const policy of policies) {
  for (const scenario of scenarios) rows.push(await runScenario(scenario, policy));
}

const summary = policies.map((policy) => summarize(
  rows.filter((row) => row.policy === policy.id),
  policy
));
const best = [...summary].sort((a, b) =>
  b.worst_fact_recall - a.worst_fact_recall ||
  b.worst_critical_object_recall - a.worst_critical_object_recall ||
  b.fact_recall - a.fact_recall ||
  b.critical_object_recall - a.critical_object_recall ||
  b.plan_precision - a.plan_precision ||
  a.plan_bytes - b.plan_bytes
).slice(0, 15);

const result = {
  generated_at: new Date().toISOString(),
  purpose: "Offline TKP capacity/passage/policy tuning. Default production behavior is unchanged unless a policy is explicitly supplied.",
  default_policy: DEFAULT_TURN_KNOWLEDGE_POLICY,
  final_budget_bytes: FINAL_BUDGET_BYTES,
  final_item_bytes: FINAL_ITEM_BYTES,
  policies,
  scenarios: scenarios.map((scenario) => ({
    id: scenario.id,
    description: scenario.description,
    critical_ids: scenario.criticalIds,
    fact_markers: scenario.factMarkers,
    relevant_ids: scenario.relevantIds,
    expected_kinds: scenario.expectedKinds
  })),
  best,
  summary,
  rows
};

await mkdir(resolve(ROOT, ".review-runtime"), { recursive: true });
await writeFile(OUTPUT, JSON.stringify(result, null, 2) + "\n", "utf8");

console.log(`TKP tuning matrix: ${rows.length} offline runs, ${policies.length} policies, ${scenarios.length} scenarios`);
console.log("Best policies by worst-case fact/object retention, then precision and bytes");
console.table(best.map((row) => ({
  policy: row.id,
  critical: f(row.critical_object_recall),
  worstCritical: f(row.worst_critical_object_recall),
  facts: f(row.fact_recall),
  worstFacts: f(row.worst_fact_recall),
  kindCoverage: f(row.supporting_kind_coverage),
  precision: f(row.plan_precision),
  finalFacts: f(row.final_fact_recall),
  finalCritical: f(row.final_critical_object_recall),
  planKB: f(row.plan_bytes / 1024, 1),
  finalKB: f(row.final_bytes / 1024, 1)
})));
console.log(`saved: ${OUTPUT}`);

async function runScenario(scenario, policy) {
  const capsule = buildContextCapsule({
    accountId: "eval",
    resolution: resolvedProject(),
    globalMemory: scenario.globalMemory.map(clone),
    projectMemory: scenario.projectMemory.map(clone),
    reusableSkills: scenario.reusableSkills.map(clone),
    projectArchitecture: scenario.projectArchitecture.map(clone),
    retrievalDiagnostics: diagnostics(scenario),
    detail: "full",
    maxContentBytes: 512_000,
    maxItemContentBytes: 128_000,
    query: scenario.query
  });
  const plan = await buildTurnKnowledgePlan({
    query: scenario.query,
    capsule,
    hydrateEvidence: hydrateFromScenario(scenario),
    dedupe: false,
    policy: policy.config
  });
  const planEntries = [...plan.required, ...plan.supporting];
  const planIds = planEntries.map((entry) => entry.id);
  const planText = planEntries.map(entryText).join("\n\n");
  const final = packPlan(plan, FINAL_BUDGET_BYTES, FINAL_ITEM_BYTES);
  const finalIds = final.map((entry) => entry.id);
  const finalText = final.map((entry) => entry.content).join("\n\n");
  const supportingKinds = new Set(plan.supporting.map((entry) => entry.kind));
  const relevantInPlan = planIds.filter((id) => scenario.relevantIds.includes(id)).length;
  return {
    policy: policy.id,
    scenario: scenario.id,
    critical_object_recall: recall(planIds, scenario.criticalIds),
    fact_recall: markerRecall(planText, scenario.factMarkers),
    supporting_kind_coverage: ratio(
      scenario.expectedKinds.filter((kind) => supportingKinds.has(kind)).length,
      scenario.expectedKinds.length
    ),
    plan_precision: ratio(relevantInPlan, planIds.length),
    final_critical_object_recall: recall(finalIds, scenario.criticalIds),
    final_fact_recall: markerRecall(finalText, scenario.factMarkers),
    plan_bytes: bytes(planText),
    final_bytes: final.reduce((sum, entry) => sum + bytes(entry.content), 0),
    required_count: plan.required.length,
    supporting_count: plan.supporting.length,
    architecture_count: plan.required.filter((entry) => entry.kind === "architecture").length,
    fresh_l1_count: planEntries.filter((entry) => entry.kind === "L1").length,
    passage_count: planEntries.reduce((sum, entry) => sum + (entry.passages?.length ?? 0), 0),
    omitted_items: plan.coverage.omitted_items,
    plan_ids: planIds,
    final_ids: finalIds,
    missing_facts: scenario.factMarkers.filter((marker) => !planText.includes(marker)),
    final_missing_facts: scenario.factMarkers.filter((marker) => !finalText.includes(marker))
  };
}

function summarize(group, policy) {
  const avg = (key) => mean(group.map((row) => row[key]));
  const min = (key) => Math.min(...group.map((row) => row[key]));
  return {
    id: policy.id,
    config: policy.config,
    runs: group.length,
    critical_object_recall: avg("critical_object_recall"),
    worst_critical_object_recall: min("critical_object_recall"),
    fact_recall: avg("fact_recall"),
    worst_fact_recall: min("fact_recall"),
    supporting_kind_coverage: avg("supporting_kind_coverage"),
    plan_precision: avg("plan_precision"),
    final_critical_object_recall: avg("final_critical_object_recall"),
    final_fact_recall: avg("final_fact_recall"),
    plan_bytes: avg("plan_bytes"),
    final_bytes: avg("final_bytes"),
    required_count: avg("required_count"),
    supporting_count: avg("supporting_count"),
    passage_count: avg("passage_count"),
    omitted_items: avg("omitted_items")
  };
}

function packPlan(plan, maxBytes, maxItemBytes) {
  const output = [];
  let remaining = maxBytes;
  for (const entry of [...plan.required, ...plan.supporting]) {
    if (remaining < 64) break;
    const content = utf8Prefix(entryText(entry) || entry.reason, Math.min(maxItemBytes, remaining));
    if (!content) continue;
    output.push({ id: entry.id, content });
    remaining -= bytes(content);
  }
  return output;
}

function entryText(entry) {
  return (entry.passages ?? [])
    .map((passage) => `${passage.heading ? `# ${passage.heading}\n` : ""}${passage.text}`)
    .join("\n\n");
}

function scenarioArchitectureCapacity() {
  const query = "retrieval architecture required constraint";
  const arches = Array.from({ length: 6 }, (_, index) => architecture(
    `arch-cap-${index + 1}`,
    `# Retrieval Architecture ${index + 1}\nretrieval architecture required constraint FACT_ARCH_${index + 1}`
  ));
  return scenario({
    id: "architecture_capacity",
    description: "Five critical architecture objects plus L3 expose maxArchitectureEntries and maxRequiredEntries ceilings.",
    query,
    projectMemory: [remembered("l3-arch-cap", "L3", "# Current Truth\nretrieval architecture required constraint FACT_L3_ARCH", 0.9)],
    projectArchitecture: arches,
    globalMemory: [], reusableSkills: [],
    criticalIds: ["l3-arch-cap", ...arches.slice(0, 5).map((item) => item.id)],
    relevantIds: ["l3-arch-cap", ...arches.slice(0, 5).map((item) => item.id)],
    factMarkers: ["FACT_L3_ARCH", ...Array.from({ length: 5 }, (_, i) => `FACT_ARCH_${i + 1}`)],
    expectedKinds: []
  });
}

function scenarioSupportingDiversity() {
  const query = "latest retrieval chronology preference workflow evidence";
  const fresh = Array.from({ length: 7 }, (_, index) => freshL1(
    `div-l1-${index + 1}`,
    index < 2
      ? `latest retrieval evidence FACT_DIV_L1_${index + 1}`
      : `latest retrieval evidence repeated supporting note ${index + 1}`,
    query
  ));
  return scenario({
    id: "supporting_diversity",
    description: "A Fresh-L1 flood precedes L2/L4/Skill in current supporting order, testing starvation under the 4-entry cap.",
    query,
    projectMemory: [
      remembered("div-l3", "L3", "# Current Truth\nretrieval current truth FACT_DIV_L3", 0.9),
      ...fresh,
      remembered("div-l2", "L2", "# Timeline\nlatest retrieval chronology FACT_DIV_L2", 0.7)
    ],
    projectArchitecture: [],
    globalMemory: [globalL4("div-l4", "stable retrieval preference FACT_DIV_L4", query)],
    reusableSkills: [skillItem("div-skill", "retrieval workflow FACT_DIV_SKILL", query)],
    criticalIds: ["div-l3", "div-l1-1", "div-l2", "div-l4", "div-skill"],
    relevantIds: ["div-l3", "div-l1-1", "div-l1-2", "div-l2", "div-l4", "div-skill"],
    factMarkers: ["FACT_DIV_L3", "FACT_DIV_L1_1", "FACT_DIV_L2", "FACT_DIV_L4", "FACT_DIV_SKILL"],
    expectedKinds: ["L1", "L2", "L4", "skill"]
  });
}

function scenarioFreshL1Flood() {
  const query = "retrieval top k tkp latest requirement";
  const irrelevant = Array.from({ length: 8 }, (_, index) => freshL1(
    `flood-noise-${index + 1}`,
    `unrelated deployment chatter note ${index + 1}`,
    query,
    []
  ));
  const relevant = [
    freshL1("flood-critical-1", "retrieval top k latest requirement FACT_FLOOD_1", query),
    freshL1("flood-critical-2", "tkp latest requirement FACT_FLOOD_2", query)
  ];
  return scenario({
    id: "fresh_l1_flood",
    description: "Many undistilled but query-irrelevant L1 turns precede two relevant L1 turns; tests relevance filtering and maxFreshL1Entries.",
    query,
    projectMemory: [
      remembered("flood-l3", "L3", "# Current Truth\nretrieval latest requirement FACT_FLOOD_L3", 0.9),
      ...relevant,
      remembered("flood-l2", "L2", "# Timeline\nretrieval chronology FACT_FLOOD_L2", 0.6),
      ...irrelevant
    ],
    projectArchitecture: [], globalMemory: [], reusableSkills: [],
    criticalIds: ["flood-l3", "flood-critical-1", "flood-critical-2", "flood-l2"],
    relevantIds: ["flood-l3", "flood-critical-1", "flood-critical-2", "flood-l2"],
    factMarkers: ["FACT_FLOOD_L3", "FACT_FLOOD_1", "FACT_FLOOD_2", "FACT_FLOOD_L2"],
    expectedKinds: ["L1", "L2"]
  });
}

function scenarioPassageCount() {
  const query = "retrieval passage fact section";
  const sections = Array.from({ length: 6 }, (_, index) =>
    `# Retrieval Passage Section ${index + 1}\nretrieval passage fact section FACT_PASSAGE_${index + 1}`
  ).join("\n\n");
  return scenario({
    id: "passage_count",
    description: "One authoritative object contains six independently relevant sections; tests maxPassagesPerEntry rather than object recall.",
    query,
    projectMemory: [remembered("passage-l3", "L3", "# Current Truth\nretrieval passage fact section FACT_PASSAGE_L3", 0.9)],
    projectArchitecture: [architecture("passage-arch", sections)],
    globalMemory: [], reusableSkills: [],
    criticalIds: ["passage-l3", "passage-arch"],
    relevantIds: ["passage-l3", "passage-arch"],
    factMarkers: ["FACT_PASSAGE_L3", ...Array.from({ length: 6 }, (_, i) => `FACT_PASSAGE_${i + 1}`)],
    expectedKinds: []
  });
}

function scenarioPassageLength() {
  const query = "retrieval long passage critical tail";
  const padding = "retrieval long passage background ".repeat(48);
  return scenario({
    id: "passage_length",
    description: "The critical fact sits beyond 900 characters inside a query-relevant paragraph; tests maxPassageChars.",
    query,
    projectMemory: [remembered("length-l3", "L3", `# Retrieval Long Passage\n${padding} critical tail FACT_LONG_TAIL`, 0.9)],
    projectArchitecture: [], globalMemory: [], reusableSkills: [],
    criticalIds: ["length-l3"],
    relevantIds: ["length-l3"],
    factMarkers: ["FACT_LONG_TAIL"],
    expectedKinds: []
  });
}

function scenarioConflictVisibility() {
  const query = "retrieval policy conflict latest user correction";
  return scenario({
    id: "conflict_visibility",
    description: "L3 Current Truth and a recent explicit L1 correction must both remain visible so the harness can detect a stale-rule conflict.",
    query,
    projectMemory: [
      remembered("conflict-l3", "L3", "# Current Truth\nretrieval policy conflict FACT_OLD_RULE", 0.9),
      freshL1("conflict-l1", "latest user correction retrieval policy conflict FACT_NEW_CORRECTION", query),
      ...Array.from({ length: 5 }, (_, index) => freshL1(`conflict-noise-${index + 1}`, `latest unrelated user note ${index + 1}`, query, []))
    ],
    projectArchitecture: [], globalMemory: [], reusableSkills: [],
    criticalIds: ["conflict-l3", "conflict-l1"],
    relevantIds: ["conflict-l3", "conflict-l1"],
    factMarkers: ["FACT_OLD_RULE", "FACT_NEW_CORRECTION"],
    expectedKinds: ["L1"]
  });
}

function scenarioMixedPressure() {
  const query = "retrieval tkp architecture latest timeline preference workflow";
  const fresh = Array.from({ length: 8 }, (_, index) => freshL1(
    `mixp-l1-${index + 1}`,
    `retrieval tkp latest evidence ${index + 1} ${index < 2 ? `FACT_MIX_L1_${index + 1}` : ""}`,
    query
  ));
  const arches = Array.from({ length: 4 }, (_, index) => architecture(
    `mixp-arch-${index + 1}`,
    `# Retrieval Architecture ${index + 1}\nretrieval tkp architecture FACT_MIX_ARCH_${index + 1}`
  ));
  return scenario({
    id: "mixed_pressure",
    description: "Architecture, fresh evidence, chronology, stable preference and skill all compete under a fixed final context budget.",
    query,
    projectMemory: [
      remembered("mixp-l3", "L3", "# Current Truth\nretrieval tkp current truth FACT_MIX_L3", 0.9),
      ...fresh,
      remembered("mixp-l2", "L2", "# Timeline\nretrieval timeline FACT_MIX_L2", 0.7)
    ],
    projectArchitecture: arches,
    globalMemory: [globalL4("mixp-l4", "retrieval stable preference FACT_MIX_L4", query)],
    reusableSkills: [skillItem("mixp-skill", "retrieval workflow FACT_MIX_SKILL", query)],
    criticalIds: ["mixp-l3", "mixp-arch-1", "mixp-arch-2", "mixp-arch-3", "mixp-l1-1", "mixp-l2", "mixp-l4", "mixp-skill"],
    relevantIds: ["mixp-l3", ...arches.map((item) => item.id), "mixp-l1-1", "mixp-l1-2", "mixp-l2", "mixp-l4", "mixp-skill"],
    factMarkers: ["FACT_MIX_L3", "FACT_MIX_ARCH_1", "FACT_MIX_ARCH_2", "FACT_MIX_ARCH_3", "FACT_MIX_L1_1", "FACT_MIX_L2", "FACT_MIX_L4", "FACT_MIX_SKILL"],
    expectedKinds: ["L1", "L2", "L4", "skill"]
  });
}

function scenario(value) {
  return {
    globalMemory: [], projectMemory: [], reusableSkills: [], projectArchitecture: [],
    criticalIds: [], relevantIds: [], factMarkers: [], expectedKinds: [],
    ...value
  };
}

function remembered(id, layer, content, score) {
  return contextItem(id, content, {
    scope: "project",
    authority: "remembered",
    source: "memmy-memory",
    layer,
    evidenceRef: `${layer.toLowerCase()}:${id}:r1`,
    score
  });
}

function freshL1(id, content, query, explicitMatchedTerms) {
  const matchedTerms = explicitMatchedTerms ?? matched(query, content);
  return contextItem(id, content, {
    scope: "project",
    authority: "evidence",
    source: "memhub-capture",
    layer: "L1",
    evidenceRef: `l1:${id}`,
    score: 0.8,
    freshness: "undistilled",
    matchedTerms
  });
}

function globalL4(id, content, query) {
  return contextItem(id, content, {
    scope: "global", authority: "remembered", source: "memmy-memory", layer: "L4", score: 0.5,
    evidenceRef: `l4:${id}:r1`, matchedTerms: matched(query, content)
  });
}

function skillItem(id, content, query) {
  return contextItem(id, content, {
    scope: "capability", authority: "remembered", source: "memmy-memory", layer: "Skill", score: 0.5,
    matchedTerms: matched(query, content)
  });
}

function architecture(id, content) {
  return {
    id, content, authority: "authoritative", scope: "project", source: "project-architecture", projectId: "memhub"
  };
}

function contextItem(id, content, options) {
  return {
    id,
    ...(options.evidenceRef ? { evidenceRef: options.evidenceRef } : {}),
    content,
    authority: options.authority,
    scope: options.scope,
    source: options.source,
    ...(options.scope === "project" ? { projectId: "memhub" } : {}),
    provenance: {
      memoryLayer: options.layer,
      ...(options.freshness ? { freshness: options.freshness } : {}),
      retrievalV1: {
        rank: 1,
        semanticScore: options.score ?? 0.5,
        lexicalScore: options.score ?? 0.5,
        fusedScore: options.score ?? 0.5,
        diversityPenaltyApplied: 0,
        matchedTerms: options.matchedTerms ?? tokenizeRetrievalText(content).slice(0, 8),
        candidateCount: 1,
        dedupedCount: 1
      }
    }
  };
}

function diagnostics(scenario) {
  const queryTerms = tokenizeRetrievalText(scenario.query).slice(0, 32);
  const lane = (count) => ({
    version: "retrieval-v1",
    semanticWeight: 0.68,
    lexicalWeight: 0.32,
    diversityPenalty: 0.12,
    candidateCount: count,
    dedupedCount: count,
    emittedCount: count,
    queryTerms,
    decisions: []
  });
  return {
    version: "retrieval-v1",
    requestedLimit: 50,
    finalLimit: 50,
    candidateLimit: 50,
    lanes: {
      global: lane(scenario.globalMemory.length),
      project: lane(scenario.projectMemory.length),
      skills: lane(scenario.reusableSkills.length)
    }
  };
}

function hydrateFromScenario(scenario) {
  const byRef = new Map(
    [...scenario.projectMemory, ...scenario.globalMemory]
      .filter((item) => item.evidenceRef)
      .map((item) => [item.evidenceRef, item.content])
  );
  return async (ref) => byRef.has(ref) ? { content: byRef.get(ref) } : null;
}

function namedPolicy(id, config) {
  return { id, config };
}

function uniquePolicies(values) {
  const seen = new Set();
  return values.filter((value) => {
    const key = JSON.stringify(value.config);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function matched(query, content) {
  const contentTerms = new Set(tokenizeRetrievalText(content));
  return tokenizeRetrievalText(query).filter((term) => contentTerms.has(term)).slice(0, 16);
}

function resolvedProject() {
  return { projectId: "memhub", source: "explicit_project", recallScope: "global_and_project", candidates: ["memhub"], evidence: ["offline-eval"] };
}

function recall(actual, expected) {
  const set = new Set(actual);
  return ratio(expected.filter((id) => set.has(id)).length, expected.length);
}

function markerRecall(text, markers) {
  return ratio(markers.filter((marker) => text.includes(marker)).length, markers.length);
}

function clone(value) { return structuredClone(value); }
function bytes(value) { return Buffer.byteLength(value, "utf8"); }
function ratio(a, b) { return b > 0 ? a / b : 1; }
function mean(values) { return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0; }
function f(value, digits = 3) { return Number(value.toFixed(digits)); }
