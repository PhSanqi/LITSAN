#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildContextCapsule, utf8Prefix } from "../dist/context-capsule.js";
import { rankRecallHits, tokenizeRetrievalText } from "../dist/retrieval-ranker.js";
import { buildTurnKnowledgePlan, DEFAULT_TURN_KNOWLEDGE_POLICY } from "../dist/turn-knowledge-plan.js";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const OUTPUT = resolve(ROOT, ".review-runtime", "shared-admission-tkp-matrix-20261023.json");
const FINAL_BUDGET_BYTES = 4_200;
const FINAL_ITEM_BYTES = 1_000;

const baseScenarios = [
  factualScenario(),
  temporalScenario(),
  architectureScenario(),
  workflowScenario(),
  provenanceScenario(),
  preferenceScenario(),
  mixedScenario(),
  denseFreshScenario(),
  staleConflictScenario(),
  exploratoryArchitectureScenario(),
  exploratoryPlanningScenario(),
  narrowFactWithDistractorsScenario(),
  passageTailScenario(),
  ...generatedStressScenarios(8)
];
const scenarios = baseScenarios.flatMap(expandScenario);

const strategies = [
  { id: "fixed_fixed", admission: "fixed", tkp: "fixed", exploration: false },
  { id: "conditional_fixed", admission: "conditional", tkp: "fixed", exploration: false },
  { id: "conditional_dynamic", admission: "conditional", tkp: "dynamic", exploration: false },
  { id: "shared_dynamic", admission: "shared", tkp: "dynamic", exploration: false },
  { id: "shared_dynamic_explore", admission: "shared", tkp: "dynamic", exploration: true },
  { id: "shared_aligned", admission: "shared", tkp: "aligned", exploration: false },
  { id: "shared_aligned_explore", admission: "shared", tkp: "aligned", exploration: true, explorationSidecar: true },
  { id: "memhub_core_aligned", ranking: "memhub_core", admission: "shared", tkp: "aligned", exploration: false },
  { id: "memhub_core_aligned_explore", ranking: "memhub_core", admission: "shared", tkp: "aligned", exploration: true, explorationSidecar: true },
  { id: "memhub_core_tkp_only", ranking: "memhub_core", admission: "none", tkp: "dynamic", exploration: true, explorationSidecar: true },
  { id: "ablate_no_exploration_sidecar", admission: "shared", tkp: "aligned", exploration: true, explorationSidecar: false },
  { id: "ablate_static_demand", admission: "shared", tkp: "aligned", exploration: true, explorationSidecar: true, staticDemand: true },
  { id: "ablate_fixed_admission", admission: "fixed", tkp: "aligned", exploration: true, explorationSidecar: true },
  { id: "ablate_fixed_tkp", admission: "shared", tkp: "fixed", exploration: true, explorationSidecar: true },
  { id: "ablate_no_trust_admitted", admission: "shared", tkp: "aligned", exploration: true, explorationSidecar: true, trustAdmitted: false },
  { id: "ablate_no_temporal_split", admission: "shared", tkp: "aligned", exploration: true, explorationSidecar: true, temporalSplit: false },
  { id: "ablate_no_uncertainty_slack", admission: "shared", tkp: "aligned", exploration: true, explorationSidecar: true, uncertaintySlack: false },
  { id: "ablate_head_passages", admission: "shared", tkp: "aligned", exploration: true, explorationSidecar: true, matchedWindow: false },
  { id: "ablate_untyped_exploration", admission: "shared", tkp: "aligned", exploration: true, explorationSidecar: true, typedExploration: false },
  { id: "ablate_no_current_state_fresh", admission: "shared", tkp: "aligned", exploration: true, explorationSidecar: true, currentStateFresh: false },
  { id: "oracle_guarded", admission: "oracle_guarded", tkp: "aligned", exploration: true, explorationSidecar: true, oracle: true }
];

const rows = [];
for (const strategy of strategies) {
  for (const scenario of scenarios) rows.push(await runScenario(scenario, strategy));
}

const summary = strategies.map((strategy) => summarize(
  rows.filter((row) => row.strategy === strategy.id),
  strategy
));

const baseStability = stabilityByStrategy(rows, baseScenarios);
for (const item of summary) item.selection_repeatability = baseStability.get(item.id) ?? 0;

const pareto = [...summary].sort((a, b) =>
  b.factual_correctness - a.factual_correctness ||
  b.critical_recall - a.critical_recall ||
  b.context_precision - a.context_precision ||
  b.constructive_diversity - a.constructive_diversity ||
  b.selection_repeatability - a.selection_repeatability ||
  a.avg_admission_items - b.avg_admission_items
);

const result = {
  generated_at: new Date().toISOString(),
  purpose: "Offline shared Conditional Admission + dynamic TKP resource-allocation experiment. Production Core is not modified.",
  metric_semantics: {
    factual_correctness: "Among selected factual memory objects, fraction labelled current/correct rather than stale/conflicting/harmful.",
    grounded_task_accuracy: "Scenario-level exact success: all critical knowledge is present and no labelled harmful/stale item reaches final context.",
    context_precision: "Among final context objects, fraction labelled directly relevant to the query.",
    context_recall: "Fraction of all labelled-relevant objects represented in final context.",
    critical_recall: "Fraction of must-not-miss knowledge represented in final context.",
    selection_repeatability: "Jaccard stability of selected IDs across score/order/budget perturbations of the same base intent; measurement-style precision/repeatability.",
    role_coverage: "Fraction of required knowledge roles represented.",
    constructive_diversity: "Coverage of labelled useful lateral/context-expanding items, gated so irrelevant noise receives no reward.",
    intra_list_diversity: "Average pairwise token dissimilarity among selected relevant items; diagnostic only, never a primary objective.",
    grounding_score: "Geometric-style safety score combining factual correctness, critical recall and context precision.",
    shared_utility: "Guard-railed utility: grounding dominates, then recall/coverage, then constructive diversity, then byte/item cost."
  },
  final_budget_bytes: FINAL_BUDGET_BYTES,
  final_item_bytes: FINAL_ITEM_BYTES,
  strategies,
  scenarios: scenarios.map(({ id, baseId, query, intent, criticalIds, relevantIds, correctIds, harmfulIds, exploratoryIds, requiredRoles }) => ({
    id, baseId, query, intent, criticalIds, relevantIds, correctIds, harmfulIds, exploratoryIds, requiredRoles
  })),
  summary,
  pareto,
  rows
};

await mkdir(resolve(ROOT, ".review-runtime"), { recursive: true });
await writeFile(OUTPUT, JSON.stringify(result, null, 2) + "\n", "utf8");

console.log(`Shared Admission/TKP matrix: ${rows.length} runs, ${strategies.length} strategies, ${scenarios.length} scenario variants`);
console.table(pareto.map((row) => ({
  strategy: row.id,
  factual: f(row.factual_correctness),
  critical: f(row.critical_recall),
  worstCritical: f(row.worst_critical_recall),
  precision: f(row.context_precision),
  recall: f(row.context_recall),
  repeatability: f(row.selection_repeatability),
  diversity: f(row.constructive_diversity),
  ILD: f(row.intra_list_diversity),
  grounding: f(row.grounding_score),
  utility: f(row.shared_utility),
  admissionK: f(row.avg_admission_items, 2),
  planKB: f(row.avg_plan_bytes / 1024, 2),
  finalKB: f(row.avg_final_bytes / 1024, 2)
})));
console.log(`saved: ${OUTPUT}`);

async function runScenario(scenario, strategy) {
  const initial = initialItems(scenario, strategy);
  const demand = buildDemandProfile(scenario, initial, strategy);
  const admitted = applyAdmission(initial, scenario, strategy, demand);
  const policy = strategy.tkp === "aligned"
    ? tkpPolicyFromAdmission(demand, admitted, strategy)
    : strategy.tkp === "dynamic"
      ? tkpPolicyFromDemand(demand)
      : DEFAULT_TURN_KNOWLEDGE_POLICY;
  const capsule = capsuleFromItems(admitted, scenario);
  const plan = await buildTurnKnowledgePlan({
    query: scenario.query,
    capsule,
    hydrateEvidence: hydrateFromScenario(scenario),
    dedupe: false,
    policy
  });
  const finalBudget = Math.max(900, Math.round(FINAL_BUDGET_BYTES * (scenario.budgetScale ?? 1)));
  let final = packPlan(plan, finalBudget, FINAL_ITEM_BYTES);
  if (strategy.explorationSidecar && demand.exploration_slots > 0 && groundingFloorSatisfied(plan, demand)) {
    final = appendExplorationSidecar(
      final,
      admitted,
      scenario.query,
      demand.exploration_slots,
      finalBudget,
      strategy.typedExploration !== false
    );
  }
  const finalIds = final.map((entry) => entry.id);
  const finalText = final.map((entry) => entry.content).join("\n\n");
  const semanticContext = scenario.perturbation === "base" &&
    (strategy.id === "fixed_fixed" || strategy.id === "shared_aligned_explore")
    ? final.map((entry) => `[${entry.kind}/${entry.role}] ${entry.content}`).join("\n\n")
    : undefined;
  const selectedSet = new Set(finalIds);
  const relevant = new Set(scenario.relevantIds);
  const critical = new Set(scenario.criticalIds);
  const correct = new Set(scenario.correctIds);
  const harmful = new Set(scenario.harmfulIds);
  const exploratory = new Set(scenario.exploratoryIds);
  const factualSelected = finalIds.filter((id) => correct.has(id) || harmful.has(id));
  const correctSelected = factualSelected.filter((id) => correct.has(id));
  const relevantSelected = finalIds.filter((id) => relevant.has(id));
  const criticalSelected = finalIds.filter((id) => critical.has(id));
  const exploratorySelected = finalIds.filter((id) => exploratory.has(id));
  const sidecarIds = final.filter((entry) => entry.role === "exploratory").map((entry) => entry.id);
  const usefulSidecar = sidecarIds.filter((id) => exploratory.has(id));
  const roleSet = new Set(finalIds.map((id) => scenario.roles[id]).filter(Boolean));
  const roleCoverage = ratio(scenario.requiredRoles.filter((role) => roleSet.has(role)).length, scenario.requiredRoles.length);
  const factualCorrectness = ratio(correctSelected.length, factualSelected.length);
  const contextPrecision = ratio(relevantSelected.length, finalIds.length);
  const contextRecall = ratio(relevantSelected.length, scenario.relevantIds.length);
  const criticalRecall = ratio(criticalSelected.length, scenario.criticalIds.length);
  const factRecall = ratio(
    (scenario.factMarkers ?? []).filter((marker) => finalText.includes(marker)).length,
    (scenario.factMarkers ?? []).length
  );
  const groundedTaskAccuracy = criticalRecall === 1 && factRecall === 1 && finalIds.every((id) => !harmful.has(id)) ? 1 : 0;
  const constructiveDiversity = ratio(exploratorySelected.length, scenario.exploratoryIds.length);
  const explorationPrecision = ratio(usefulSidecar.length, sidecarIds.length);
  const intraListDiversity = usefulIntraListDiversity(final, relevant);
  const groundingScore = geometricMean([factualCorrectness, criticalRecall, contextPrecision]);
  const sharedUtility = utilityScore({
    factualCorrectness,
    criticalRecall,
    contextPrecision,
    contextRecall,
    roleCoverage,
    constructiveDiversity,
    admittedCount: admitted.length,
    finalBytes: totalBytes(final.map((entry) => entry.content))
  });
  return {
    strategy: strategy.id,
    scenario: scenario.id,
    base_scenario: scenario.baseId,
    perturbation: scenario.perturbation,
    intent: scenario.intent,
    demand,
    tkp_policy: policy,
    admission_items: admitted.length,
    admitted_ids: admitted.map((item) => item.id),
    final_ids: finalIds,
    ...(semanticContext ? { semantic_context: semanticContext } : {}),
    final_items: final.length,
    factual_correctness: factualCorrectness,
    grounded_task_accuracy: groundedTaskAccuracy,
    harmful_rate: ratio(finalIds.filter((id) => harmful.has(id)).length, finalIds.length),
    context_precision: contextPrecision,
    context_recall: contextRecall,
    critical_recall: criticalRecall,
    fact_recall: factRecall,
    role_coverage: roleCoverage,
    constructive_diversity: constructiveDiversity,
    exploration_precision: explorationPrecision,
    intra_list_diversity: intraListDiversity,
    grounding_score: groundingScore,
    shared_utility: sharedUtility,
    plan_bytes: planBytes(plan),
    final_bytes: totalBytes(final.map((entry) => entry.content)),
    required_count: plan.required.length,
    supporting_count: plan.supporting.length
  };
}

function buildDemandProfile(scenario, items, strategy) {
  const query = scenario.query.toLocaleLowerCase();
  const currentState = /current|currently|right now|now|当前|现在|目前|现状/.test(query);
  const explicitTemporalHistory = /latest.*change|recent.*change|timeline|history|evolution|最近.*变化|最新.*变化|时间线|历史|演进|变化/.test(query);
  const temporalHistory = strategy.temporalSplit === false
    ? currentState || explicitTemporalHistory
    : explicitTemporalHistory;
  const temporal = currentState || temporalHistory || /today|yesterday|刚刚/.test(query);
  const architecture = /architecture|system architecture|retrieval architecture|架构|架构设计|结构|边界/.test(query);
  const workflow = /workflow|how to|process|skill|流程|怎么做|操作|步骤/.test(query);
  const provenance = /why|provenance|source|evidence|为什么|依据|证据|来源/.test(query);
  const preference = /preference|prefer|habit|偏好|习惯|风格/.test(query);
  const openEnded = /alternative|other|options|improve|brainstorm|方案|还有|其他|优化|可能性|思路/.test(query);
  const dense = items.length >= 12;
  const uncertainty = Math.min(1, (dense ? 0.35 : 0.08) + scoreAmbiguity(items) * 0.65);
  const freshNeed = temporalHistory || provenance ||
    (currentState && strategy.currentStateFresh !== false) ||
    /today|yesterday|刚刚/.test(query);
  const demand = {
    signals: { temporal, currentState, temporalHistory, architecture, workflow, provenance, preference, openEnded, uncertainty },
    L3: { min: 1, target: 1, max: 1 },
    architecture: { min: architecture ? 1 : 0, target: architecture ? 2 : openEnded ? 1 : 0, max: architecture ? 3 : openEnded ? 2 : 1 },
    L1: { min: freshNeed ? 1 : 0, target: freshNeed ? 2 : openEnded ? 1 : 0, max: freshNeed ? 4 : openEnded ? 2 : 1 },
    L2: { min: temporalHistory || provenance ? 1 : 0, target: temporalHistory ? 2 : provenance ? 2 : 0, max: temporalHistory || provenance ? 3 : 1 },
    L4: { min: preference ? 1 : 0, target: preference ? 1 : 0, max: preference || openEnded ? 1 : 0 },
    Skill: { min: workflow ? 1 : 0, target: workflow ? 1 : 0, max: workflow || openEnded ? 1 : 0 },
    exploration_slots: strategy.exploration && (openEnded || architecture || workflow) ? 1 : 0
  };
  if (strategy.staticDemand) {
    demand.architecture = { min: 0, target: 1, max: 2 };
    demand.L1 = { min: 0, target: 1, max: 2 };
    demand.L2 = { min: 0, target: 1, max: 2 };
    demand.L4 = { min: 0, target: 1, max: 1 };
    demand.Skill = { min: 0, target: 1, max: 1 };
    demand.exploration_slots = strategy.exploration ? 1 : 0;
  }
  return demand;
}

function applyAdmission(items, scenario, strategy, demand) {
  if (strategy.admission === "none") return [...items];
  if (strategy.admission === "fixed") return [...items].sort(scoreSort).slice(0, 8);
  const options = {
    shared: strategy.admission !== "conditional",
    guarded: strategy.admission === "oracle_guarded",
    exploration: strategy.exploration,
    typedExploration: strategy.typedExploration !== false,
    uncertaintySlack: strategy.uncertaintySlack !== false
  };
  return conditionalAdmission(items, demand, options, scenario);
}

function conditionalAdmission(items, demand, options, scenario) {
  const groups = groupByKind(items);
  const selected = [];
  const ids = new Set();
  const add = (item) => {
    if (!item || ids.has(item.id)) return;
    selected.push(item);
    ids.add(item.id);
  };

  add(groups.get("L3")?.[0]);

  const kinds = ["architecture", "L1", "L2", "L4", "Skill"];
  for (const kind of kinds) {
    const profile = demand[kind];
    if (!profile) continue;
    const rawGroup = [...(groups.get(kind) ?? [])];
    const group = kind === "L2" && demand.signals.temporalHistory
      ? temporalRelevantOrder(rawGroup)
      : rawGroup.sort((a, b) => admissionUtility(b, kind, demand) - admissionUtility(a, kind, demand) || scoreSort(a, b));
    const baseTarget = options.shared ? profile.target : Math.min(profile.max, Math.max(profile.target, 1));
    const zeroTargetSlackAllowed = demand.exploration_slots > 0 && kind !== "L2";
    const slack = !options.uncertaintySlack
      ? 0
      : options.shared
      ? baseTarget === 0 && !zeroTargetSlackAllowed
        ? 0
        : Math.ceil(demand.signals.uncertainty * Math.max(0, profile.max - baseTarget))
      : baseTarget === 0 ? 0 : 1;
    const cap = Math.min(profile.max, baseTarget + slack);
    for (const item of group.slice(0, cap)) add(item);
  }

  if (options.exploration && demand.exploration_slots > 0) {
    const exploratory = [...items]
      .filter((item) =>
        !ids.has(item.id) &&
        matchedTermCount(item) > 0 &&
        (!options.typedExploration || isExplorationKind(itemKind(item)))
      )
      .sort((a, b) => explorationUtility(b, selected) - explorationUtility(a, selected));
    for (const item of exploratory.slice(0, demand.exploration_slots)) add(item);
  }

  if (options.guarded) {
    const harmful = new Set(scenario.harmfulIds);
    return selected.filter((item) => !harmful.has(item.id) || scenario.criticalIds.includes(item.id));
  }
  return selected;
}

function tkpPolicyFromAdmission(demand, admitted, strategy = {}) {
  const counts = new Map();
  for (const item of admitted) counts.set(itemKind(item), (counts.get(itemKind(item)) ?? 0) + 1);
  const arch = counts.get("architecture") ?? 0;
  const l1 = counts.get("L1") ?? 0;
  const l2 = Math.min(1, counts.get("L2") ?? 0);
  const l4 = counts.get("L4") ?? 0;
  const skill = counts.get("Skill") ?? 0;
  return {
    maxArchitectureEntries: Math.max(1, arch),
    maxRequiredEntries: Math.max(1, 1 + arch),
    maxFreshL1Entries: Math.max(1, l1),
    maxSupportingEntries: Math.max(2, l1 + l2 + l4 + skill),
    freshL1RelevantOnly: false,
    freshL1Role: "supporting",
    supportingSelection: demand.signals.openEnded ? "balanced" : "score",
    passageWindow: strategy.matchedWindow === false ? "head" : "matched",
    maxPassagesPerEntry: demand.signals.provenance || demand.signals.architecture ? 4 : 3,
    maxPassageChars: 900,
    trustAdmittedArchitecture: strategy.trustAdmitted !== false,
    trustAdmittedSupporting: strategy.trustAdmitted !== false
  };
}

function temporalRelevantOrder(items) {
  if (items.length <= 1) return items;
  const maxMatched = Math.max(...items.map(matchedTermCount));
  const floor = Math.max(2, Math.ceil(maxMatched * 0.5));
  return [...items].sort((a, b) => {
    const aEligible = matchedTermCount(a) >= floor ? 1 : 0;
    const bEligible = matchedTermCount(b) >= floor ? 1 : 0;
    if (aEligible !== bEligible) return bEligible - aEligible;
    if (aEligible) {
      const recency = temporalValue(b.updatedAt) - temporalValue(a.updatedAt);
      if (recency !== 0) return recency;
    }
    return scoreSort(a, b);
  });
}

function groundingFloorSatisfied(plan, demand) {
  const entries = [...plan.required, ...plan.supporting];
  const count = (kind) => entries.filter((entry) => entry.kind === kind).length;
  return count("L3") >= demand.L3.target &&
    count("architecture") >= demand.architecture.target &&
    count("L1") >= demand.L1.target &&
    count("L2") >= demand.L2.target &&
    count("L4") >= demand.L4.target &&
    count("skill") >= demand.Skill.target;
}

function appendExplorationSidecar(final, admitted, query, slots, maxBytes, typedExploration = true) {
  const used = new Set(final.map((entry) => entry.id));
  let remaining = maxBytes - totalBytes(final.map((entry) => entry.content));
  if (remaining < 180) return final;
  const selected = final.map((entry) => ({ id: entry.id, content: entry.content }));
  const candidates = admitted
    .filter((item) =>
      !used.has(item.id) &&
      (!typedExploration || isExplorationKind(itemKind(item))) &&
      matchedTermCount(item) > 0
    )
    .map((item) => ({
      item,
      score: explorationRuntimeScore(item, selected, query)
    }))
    .filter((candidate) => candidate.score > 0.22)
    .sort((a, b) => b.score - a.score || scoreSort(a.item, b.item));
  const output = [...final];
  for (const { item } of candidates.slice(0, slots)) {
    if (remaining < 180) break;
    const content = utf8Prefix(item.content, Math.min(600, remaining));
    if (!content) continue;
    output.push({ id: item.id, kind: itemKind(item), role: "exploratory", content });
    remaining -= bytes(content);
    selected.push({ id: item.id, content });
  }
  return output;
}

function explorationRuntimeScore(item, selected, query) {
  const queryTerms = new Set(tokenizeRetrievalText(query));
  const itemTerms = new Set(tokenizeRetrievalText(item.content));
  let overlap = 0;
  for (const term of queryTerms) if (itemTerms.has(term)) overlap += 1;
  const relevance = queryTerms.size ? overlap / queryTerms.size : 0;
  const novelty = selected.length === 0 ? 1 : 1 - Math.max(...selected.map((other) => tokenJaccard(item.content, other.content)));
  return 0.58 * relevance + 0.42 * novelty;
}

function isExplorationKind(kind) {
  return kind === "architecture" || kind === "Skill" || kind === "L4";
}

function tkpPolicyFromDemand(demand) {
  const arch = Math.max(demand.architecture.min, demand.architecture.target);
  const fresh = Math.max(demand.L1.min, demand.L1.target);
  const supportingTarget = Math.max(
    2,
    fresh + demand.L2.target + demand.L4.target + demand.Skill.target + demand.exploration_slots
  );
  return {
    maxArchitectureEntries: Math.min(demand.architecture.max, Math.max(1, arch + (demand.signals.uncertainty > 0.55 ? 1 : 0))),
    maxRequiredEntries: 1 + Math.min(demand.architecture.max, Math.max(0, arch + (demand.signals.uncertainty > 0.7 ? 1 : 0))),
    maxFreshL1Entries: Math.min(demand.L1.max, Math.max(1, fresh + (demand.signals.uncertainty > 0.55 ? 1 : 0))),
    maxSupportingEntries: Math.min(10, supportingTarget + (demand.signals.uncertainty > 0.55 ? 1 : 0)),
    freshL1RelevantOnly: true,
    freshL1Role: "supporting",
    supportingSelection: "balanced",
    passageWindow: "matched",
    maxPassagesPerEntry: demand.signals.provenance || demand.signals.architecture ? 4 : 3,
    maxPassageChars: 900
  };
}

function admissionUtility(item, kind, demand) {
  const score = Math.max(0, item.evalScore ?? 0);
  const matched = matchedTermCount(item);
  const recency = temporalValue(item.updatedAt);
  let value = score + matched * 0.06;
  if (kind === "L1") value += 0.18;
  if (kind === "L2" && demand.signals.temporalHistory) value += recency * 0.35;
  if (kind === "architecture" && demand.signals.architecture) value += 0.22;
  if (kind === "Skill" && demand.signals.workflow) value += 0.18;
  if (kind === "L4" && demand.signals.preference) value += 0.18;
  return value;
}

function explorationUtility(item, selected) {
  const relevance = Math.max(0, item.evalScore ?? 0) + matchedTermCount(item) * 0.05;
  const novelty = selected.length === 0 ? 1 : 1 - Math.max(...selected.map((other) => tokenJaccard(item.content, other.content)));
  return relevance * 0.55 + novelty * 0.45;
}

function utilityScore({ factualCorrectness, criticalRecall, contextPrecision, contextRecall, roleCoverage, constructiveDiversity, admittedCount, finalBytes }) {
  if (factualCorrectness < 0.98 || criticalRecall < 0.9) {
    return 0.45 * factualCorrectness + 0.45 * criticalRecall + 0.10 * contextPrecision;
  }
  const grounding = 0.30 * factualCorrectness + 0.25 * criticalRecall + 0.15 * contextPrecision + 0.10 * contextRecall + 0.08 * roleCoverage;
  const exploration = 0.07 * constructiveDiversity;
  const costPenalty = 0.025 * Math.min(1, admittedCount / 12) + 0.015 * Math.min(1, finalBytes / 5_000);
  return grounding + exploration - costPenalty;
}

function initialItems(scenario, strategy = {}) {
  if (strategy.ranking === "memhub_core") {
    const project = [...scenario.projectHits]
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .map((hit) => coreHitToItem(hit, scenario.query));
    const others = [...scenario.globalItems, ...scenario.skillItems, ...scenario.architectureItems]
      .map(clone)
      .map((item) => withEvalScore(item, scenario.query));
    return [...project, ...others];
  }
  const ranked = rankRecallHits(scenario.projectHits, scenario.query, 50);
  const project = ranked.hits.map(({ hit, ...meta }) => rankedToItem(hit, meta));
  const others = [...scenario.globalItems, ...scenario.skillItems, ...scenario.architectureItems]
    .map(clone)
    .map((item) => withEvalScore(item, scenario.query));
  return [...project, ...others];
}

function coreHitToItem(hit, query) {
  const l1 = hit.memoryLayer === "L1";
  const queryTerms = tokenizeRetrievalText(query);
  const tokens = new Set(tokenizeRetrievalText(`${hit.title ?? ""} ${hit.snippet}`));
  const matchedTerms = queryTerms.filter((term) => tokens.has(term));
  const coreScore = Number.isFinite(hit.score) && hit.score > 0 ? hit.score / (1 + hit.score) : 0;
  return {
    id: hit.id,
    ...(hit.evidenceRef ? { evidenceRef: hit.evidenceRef } : {}),
    content: hit.snippet,
    authority: l1 ? "evidence" : "remembered",
    scope: "project",
    source: l1 ? "memhub-capture" : "memmy-memory",
    projectId: "memhub",
    updatedAt: hit.updatedAt,
    evalScore: coreScore,
    provenance: {
      memoryLayer: hit.memoryLayer,
      ...(l1 ? { freshness: "undistilled" } : {}),
      retrievalV1: {
        rankingMode: "memhub_core",
        semanticScore: coreScore,
        lexicalScore: 0,
        fusedScore: coreScore,
        diversityPenaltyApplied: 0,
        matchedTerms
      }
    }
  };
}

function capsuleFromItems(items, scenario) {
  const projectMemory = items.filter((item) => item.scope === "project" && item.source !== "project-architecture");
  const emptyLane = { version: "retrieval-v1", semanticWeight: 0.68, lexicalWeight: 0.32, diversityPenalty: 0.12, candidateCount: 0, dedupedCount: 0, emittedCount: 0, queryTerms: tokenizeRetrievalText(scenario.query).slice(0, 32), decisions: [] };
  return buildContextCapsule({
    accountId: "eval",
    resolution: { projectId: "memhub", source: "explicit_project", recallScope: "global_and_project", candidates: ["memhub"], evidence: ["shared-allocation-eval"] },
    globalMemory: items.filter((item) => item.scope === "global"),
    projectMemory,
    reusableSkills: items.filter((item) => item.scope === "capability"),
    projectArchitecture: items.filter((item) => item.source === "project-architecture"),
    retrievalDiagnostics: {
      version: "retrieval-v1",
      requestedLimit: Math.max(1, items.length),
      finalLimit: Math.max(1, items.length),
      candidateLimit: Math.max(12, items.length),
      lanes: { global: emptyLane, project: { ...emptyLane, candidateCount: projectMemory.length, dedupedCount: projectMemory.length, emittedCount: projectMemory.length }, skills: emptyLane }
    },
    detail: "full",
    maxContentBytes: 512_000,
    maxItemContentBytes: 128_000,
    query: scenario.query
  });
}

function packPlan(plan, maxBytes, maxItemBytes) {
  const ordered = [
    ...plan.required.map((entry) => ({ ...entry, planRole: "required" })),
    ...plan.supporting.map((entry) => ({ ...entry, planRole: "supporting" }))
  ];
  const output = [];
  let remaining = maxBytes;
  for (const entry of ordered) {
    if (remaining < 64) break;
    const text = (entry.passages ?? []).map((p) => p.heading ? `# ${p.heading}\n${p.text}` : p.text).join("\n\n") || `${entry.kind}:${entry.id}`;
    const content = utf8Prefix(text, Math.min(maxItemBytes, remaining));
    if (!content) continue;
    output.push({ id: entry.id, kind: entry.kind, role: entry.planRole, content });
    remaining -= bytes(content);
  }
  return output;
}

function rankedToItem(hit, meta) {
  const l1 = hit.memoryLayer === "L1";
  return {
    id: hit.id,
    ...(hit.evidenceRef ? { evidenceRef: hit.evidenceRef } : {}),
    content: hit.snippet,
    authority: l1 ? "evidence" : "remembered",
    scope: "project",
    source: l1 ? "memhub-capture" : "memmy-memory",
    projectId: "memhub",
    updatedAt: hit.updatedAt,
    evalScore: meta.fusedScore - meta.diversityPenaltyApplied,
    provenance: { memoryLayer: hit.memoryLayer, ...(l1 ? { freshness: "undistilled" } : {}), retrievalV1: { ...meta, matchedTerms: meta.matchedTerms } }
  };
}

function withEvalScore(item, query) {
  const queryTerms = tokenizeRetrievalText(query);
  const terms = new Set(tokenizeRetrievalText(item.content));
  const matchedTerms = queryTerms.filter((term) => terms.has(term));
  const lexical = queryTerms.length ? matchedTerms.length / queryTerms.length : 0;
  return { ...item, evalScore: Number.isFinite(item.evalScore) ? item.evalScore : lexical + (item.source === "project-architecture" ? 0.08 : 0.02), provenance: { ...(item.provenance ?? {}), retrievalV1: { ...(item.provenance?.retrievalV1 ?? {}), matchedTerms } } };
}

function hydrateFromScenario(scenario) {
  const byRef = new Map(scenario.projectHits.filter((hit) => hit.evidenceRef).map((hit) => [hit.evidenceRef, hit.snippet]));
  return async (ref) => byRef.has(ref) ? { content: byRef.get(ref) } : null;
}

function summarize(group, meta) {
  const m = (key) => mean(group.map((row) => row[key]));
  const min = (key) => Math.min(...group.map((row) => row[key]));
  return {
    ...meta,
    runs: group.length,
    factual_correctness: m("factual_correctness"),
    grounded_task_accuracy: m("grounded_task_accuracy"),
    harmful_rate: m("harmful_rate"),
    critical_recall: m("critical_recall"),
    fact_recall: m("fact_recall"),
    worst_critical_recall: min("critical_recall"),
    context_precision: m("context_precision"),
    context_recall: m("context_recall"),
    role_coverage: m("role_coverage"),
    constructive_diversity: m("constructive_diversity"),
    exploration_precision: m("exploration_precision"),
    intra_list_diversity: m("intra_list_diversity"),
    grounding_score: m("grounding_score"),
    shared_utility: m("shared_utility"),
    avg_admission_items: m("admission_items"),
    avg_plan_bytes: m("plan_bytes"),
    avg_final_bytes: m("final_bytes")
  };
}

function stabilityByStrategy(rows, bases) {
  const result = new Map();
  for (const strategy of strategies) {
    const scores = [];
    for (const base of bases) {
      const group = rows.filter((row) => row.strategy === strategy.id && row.base_scenario === base.id);
      const canonical = group.find((row) => row.perturbation === "base");
      if (!canonical) continue;
      const canonicalSet = new Set(canonical.final_ids);
      for (const row of group) {
        if (row === canonical) continue;
        scores.push(jaccardSets(canonicalSet, new Set(row.final_ids)));
      }
    }
    result.set(strategy.id, mean(scores));
  }
  return result;
}

function usefulIntraListDiversity(final, relevant) {
  const items = final.filter((entry) => relevant.has(entry.id));
  if (items.length < 2) return items.length === 1 ? 1 : 0;
  const values = [];
  for (let i = 0; i < items.length; i += 1) for (let j = i + 1; j < items.length; j += 1) values.push(1 - tokenJaccard(items[i].content, items[j].content));
  return mean(values);
}

function expandScenario(base) {
  return [
    variant(base, "base", 0, 1),
    variant(base, "jitter08", 0.08, 1),
    variant(base, "jitter18", 0.18, 1),
    variant(base, "jitter30", 0.30, 1),
    variant(base, "jitter45", 0.45, 1),
    variant(base, "tight_budget_proxy", 0.08, 0.78),
    variant(base, "very_tight_budget", 0.18, 0.62),
    variant(base, "loose_budget", 0.08, 1.25),
    variant(base, "flat_scores", 0, 1, true),
    shiftedVariant(base, "history_heavy", { L2: 1.55 }),
    shiftedVariant(base, "fresh_heavy", { L1: 1.45 }),
    shiftedVariant(base, "capability_heavy", { Skill: 1.45, architecture: 1.35 })
  ];
}

function shiftedVariant(base, perturbation, multipliers) {
  const copy = variant(base, perturbation, 0.08, 1);
  copy.projectHits = copy.projectHits.map((candidate) => ({
    ...candidate,
    score: candidate.score * (multipliers[candidate.memoryLayer] ?? 1)
  }));
  copy.skillItems = copy.skillItems.map((item) => ({ ...item, evalScore: (item.evalScore ?? 0) * (multipliers.Skill ?? 1) }));
  copy.architectureItems = copy.architectureItems.map((item) => ({ ...item, evalScore: (item.evalScore ?? 0) * (multipliers.architecture ?? 1) }));
  return copy;
}

function variant(base, perturbation, jitter, budgetScale, flatten = false) {
  const copy = clone(base);
  copy.id = `${base.id}__${perturbation}`;
  copy.baseId = base.id;
  copy.perturbation = perturbation;
  copy.budgetScale = budgetScale;
  copy.projectHits = copy.projectHits.map((candidate) => ({ ...candidate, score: flatten ? 0.55 : candidate.score * (1 + deterministicJitter(candidate.id) * jitter) }));
  for (const collection of [copy.globalItems, copy.skillItems, copy.architectureItems]) {
    for (const item of collection) if (Number.isFinite(item.evalScore)) item.evalScore = flatten ? 0.45 : item.evalScore * (1 + deterministicJitter(item.id) * jitter);
  }
  return copy;
}

function scenarioBase({ id, query, intent, projectHits = [], architectureItems = [], globalItems = [], skillItems = [], criticalIds, relevantIds, correctIds, harmfulIds = [], exploratoryIds = [], factMarkers = [], roles = {} }) {
  return { id, baseId: id, perturbation: "base", query, intent, projectHits, architectureItems, globalItems, skillItems, criticalIds, relevantIds, correctIds, harmfulIds, exploratoryIds, factMarkers, roles, requiredRoles: [...new Set(criticalIds.map((value) => roles[value]).filter(Boolean))] };
}

function factualScenario() {
  return scenarioBase({ id: "factual", query: "what is the current memhub retrieval rule", intent: "factual", projectHits: [hit("f-l3", "L3", 0.55, "# Current Truth\nmemhub retrieval protects Current Truth before supporting history.", "l3:f-l3:r1"), hit("f-l2", "L2", 1.4, "historical retrieval experiment notes", "l2:f-l2:r1"), hit("f-stale", "L2", 1.5, "old stale rule says global topk always wins", "l2:f-stale:r1")], architectureItems: [architecture("f-arch", "# Retrieval boundary\nCurrent Truth remains authoritative.", 0.46)], criticalIds: ["f-l3"], relevantIds: ["f-l3", "f-arch"], correctIds: ["f-l3", "f-arch", "f-l2"], harmfulIds: ["f-stale"], roles: { "f-l3": "L3", "f-arch": "architecture" } });
}

function temporalScenario() {
  return scenarioBase({ id: "temporal", query: "latest memhub retrieval experiment change", intent: "temporal", projectHits: [hit("t-l3", "L3", 0.5, "# Current Truth\nProduction Core stays unchanged during offline retrieval tests.", "l3:t-l3:r1"), hit("t-l1", "L1", 0.48, "Latest user request: compare shared dynamic Admission and TKP.", "l1:t-l1", "2026-10-23T06:00:00Z"), hit("t-l2-new", "L2", 0.45, "# Timeline\nLatest retrieval experiment added shared allocation metrics.", "l2:t-l2-new:r1", "2026-10-23T05:30:00Z"), hit("t-l2-old", "L2", 1.4, "retrieval experiment historical topk notes", "l2:t-l2-old:r1", "2026-09-01T00:00:00Z")], criticalIds: ["t-l3", "t-l1", "t-l2-new"], relevantIds: ["t-l3", "t-l1", "t-l2-new"], correctIds: ["t-l3", "t-l1", "t-l2-new", "t-l2-old"], roles: { "t-l3": "L3", "t-l1": "L1", "t-l2-new": "L2" } });
}

function architectureScenario() {
  return scenarioBase({ id: "architecture", query: "optimize memhub retrieval architecture and context packing", intent: "architecture", projectHits: [hit("a-l3", "L3", 0.5, "# Current Truth\nKeep one memory control layer and minimal sufficient architecture.", "l3:a-l3:r1")], architectureItems: [architecture("a-arch1", "# Admission\nUse typed admission before TKP.", 0.52), architecture("a-arch2", "# Packing\nRole-aware final packing protects required knowledge.", 0.48), architecture("a-side", "# Alternative\nA query-conditioned budget can reserve one lateral architecture option for comparison.", 0.34)], criticalIds: ["a-l3", "a-arch1", "a-arch2"], relevantIds: ["a-l3", "a-arch1", "a-arch2", "a-side"], correctIds: ["a-l3", "a-arch1", "a-arch2", "a-side"], exploratoryIds: ["a-side"], roles: { "a-l3": "L3", "a-arch1": "architecture", "a-arch2": "architecture", "a-side": "architecture" } });
}

function workflowScenario() {
  return scenarioBase({ id: "workflow", query: "how should we test the memhub retrieval workflow", intent: "workflow", projectHits: [hit("w-l3", "L3", 0.5, "# Rule\nDo not modify production Core during offline tests.", "l3:w-l3:r1"), hit("w-l1", "L1", 0.43, "User requested actual server tests with shared metrics.", "l1:w-l1")], skillItems: [skill("w-skill", "Skill candidate: retrieval audit workflow with golden cases and replay.", 0.48), skill("w-side", "Skill candidate: counterexample generation workflow for adversarial retrieval testing.", 0.32)], criticalIds: ["w-l3", "w-skill"], relevantIds: ["w-l3", "w-l1", "w-skill", "w-side"], correctIds: ["w-l3", "w-l1", "w-skill", "w-side"], exploratoryIds: ["w-side"], roles: { "w-l3": "L3", "w-skill": "Skill" } });
}

function provenanceScenario() {
  return scenarioBase({ id: "provenance", query: "why did retrieval miss the latest evidence and what is the provenance", intent: "provenance", projectHits: [hit("p-l3", "L3", 0.5, "# Rule\nUse L1 evidence when provenance or reason is disputed.", "l3:p-l3:r1"), hit("p-l1a", "L1", 0.48, "User observed the latest L1 was not returned by retrieval.", "l1:p-l1a"), hit("p-l1b", "L1", 0.44, "Trace showed the target did not enter the candidate pool.", "l1:p-l1b"), hit("p-l2", "L2", 0.4, "# Timeline\nRetrieval trace instrumentation was added before this investigation.", "l2:p-l2:r1")], criticalIds: ["p-l3", "p-l1a", "p-l1b"], relevantIds: ["p-l3", "p-l1a", "p-l1b", "p-l2"], correctIds: ["p-l3", "p-l1a", "p-l1b", "p-l2"], roles: { "p-l3": "L3", "p-l1a": "L1", "p-l1b": "L1" } });
}

function preferenceScenario() {
  return scenarioBase({ id: "preference", query: "what are the stable preferences for memhub architecture", intent: "preference", projectHits: [hit("pr-l3", "L3", 0.5, "# Project rule\nUse minimal sufficient architecture.", "l3:pr-l3:r1")], globalItems: [globalItem("pr-l4", "Stable preference: evidence-backed verification and minimal parallel systems.", 0.46), globalItem("pr-side", "Stable preference: preserve room for alternative implementation paths when they are low-risk.", 0.28)], criticalIds: ["pr-l3", "pr-l4"], relevantIds: ["pr-l3", "pr-l4", "pr-side"], correctIds: ["pr-l3", "pr-l4", "pr-side"], exploratoryIds: ["pr-side"], roles: { "pr-l3": "L3", "pr-l4": "L4" } });
}

function mixedScenario() {
  return scenarioBase({ id: "mixed", query: "optimize the latest memhub retrieval architecture workflow and explain why", intent: "mixed", projectHits: [hit("m-l3", "L3", 0.5, "# Current Truth\nShared demand must not override authority hierarchy.", "l3:m-l3:r1"), hit("m-l1", "L1", 0.47, "Latest request asks for dynamic shared resource allocation.", "l1:m-l1"), hit("m-l2", "L2", 0.42, "# Timeline\nDynamic Admission experiments preceded dynamic TKP experiments.", "l2:m-l2:r1")], architectureItems: [architecture("m-arch", "# Architecture\nAdmission and TKP share a demand profile.", 0.49), architecture("m-side", "# Alternative\nReserve a small bounded exploration slot after grounding floors are met.", 0.30)], skillItems: [skill("m-skill", "Skill candidate: replay retrieval traces and compare allocation policies.", 0.44)], criticalIds: ["m-l3", "m-l1", "m-arch", "m-skill"], relevantIds: ["m-l3", "m-l1", "m-l2", "m-arch", "m-skill", "m-side"], correctIds: ["m-l3", "m-l1", "m-l2", "m-arch", "m-skill", "m-side"], exploratoryIds: ["m-side"], roles: { "m-l3": "L3", "m-l1": "L1", "m-arch": "architecture", "m-skill": "Skill" } });
}

function denseFreshScenario() {
  return scenarioBase({ id: "dense_fresh", query: "latest evidence from the last retrieval tests", intent: "temporal", projectHits: [hit("df-l3", "L3", 0.46, "# Current Truth\nProduction Core remains unchanged.", "l3:df-l3:r1"), ...[1,2,3,4].map((n) => hit(`df-l1-${n}`, "L1", 0.5 - n * 0.03, `Latest evidence ${n}: shared allocation test observation ${n}.`, `l1:df-l1-${n}`)), ...Array.from({ length: 10 }, (_, index) => hit(`df-noise-${index}`, "L2", 1.4 - index * 0.04, `retrieval historical experiment noise ${index}`, `l2:df-noise-${index}:r1`))], criticalIds: ["df-l3", "df-l1-1", "df-l1-2", "df-l1-3"], relevantIds: ["df-l3", "df-l1-1", "df-l1-2", "df-l1-3", "df-l1-4"], correctIds: ["df-l3", "df-l1-1", "df-l1-2", "df-l1-3", "df-l1-4", ...Array.from({ length: 10 }, (_, i) => `df-noise-${i}`)], roles: { "df-l3": "L3", "df-l1-1": "L1", "df-l1-2": "L1", "df-l1-3": "L1" } });
}

function staleConflictScenario() {
  return scenarioBase({ id: "stale_conflict", query: "current memhub retrieval deployment status", intent: "factual", projectHits: [hit("sc-l3", "L3", 0.5, "# Current Truth\nRetrieval experiments are not deployed to production Core.", "l3:sc-l3:r1"), hit("sc-l1", "L1", 0.46, "Latest evidence: source tests passed but production release was not switched.", "l1:sc-l1"), hit("sc-stale", "L2", 1.6, "Old stale note: retrieval experiment is already deployed to production.", "l2:sc-stale:r1")], criticalIds: ["sc-l3", "sc-l1"], relevantIds: ["sc-l3", "sc-l1"], correctIds: ["sc-l3", "sc-l1"], harmfulIds: ["sc-stale"], roles: { "sc-l3": "L3", "sc-l1": "L1" } });
}

function exploratoryArchitectureScenario() {
  return scenarioBase({ id: "explore_arch", query: "what other architecture options could improve memhub retrieval", intent: "exploratory", projectHits: [hit("ea-l3", "L3", 0.48, "# Current Truth\nDo not add a parallel memory service.", "l3:ea-l3:r1")], architectureItems: [architecture("ea-main", "# Main\nUse shared demand profile for Admission and TKP.", 0.5), architecture("ea-side-a", "# Alternative A\nUse uncertainty slack to widen only ambiguous kinds.", 0.33), architecture("ea-side-b", "# Alternative B\nUse a tiny exploration reserve after grounding constraints are satisfied.", 0.31), architecture("ea-noise", "# Unrelated\nCloudflare certificate deployment notes.", 0.42)], criticalIds: ["ea-l3", "ea-main"], relevantIds: ["ea-l3", "ea-main", "ea-side-a", "ea-side-b"], correctIds: ["ea-l3", "ea-main", "ea-side-a", "ea-side-b", "ea-noise"], exploratoryIds: ["ea-side-a", "ea-side-b"], roles: { "ea-l3": "L3", "ea-main": "architecture" } });
}

function exploratoryPlanningScenario() {
  return scenarioBase({ id: "explore_plan", query: "give other ways to test conditional admission and improve the experiment", intent: "exploratory", projectHits: [hit("ep-l3", "L3", 0.48, "# Rule\nUse evidence-backed tests and keep production unchanged.", "l3:ep-l3:r1"), hit("ep-l1", "L1", 0.44, "Current experiment compares Conditional Admission with TKP.", "l1:ep-l1")], skillItems: [skill("ep-main", "Skill candidate: golden-case replay and perturbation testing.", 0.48), skill("ep-side", "Skill candidate: metamorphic testing across score calibration shifts and missing labels.", 0.29)], architectureItems: [architecture("ep-alt", "# Alternative\nEvaluate a Pareto frontier rather than a single weighted score.", 0.30)], criticalIds: ["ep-l3", "ep-main"], relevantIds: ["ep-l3", "ep-l1", "ep-main", "ep-side", "ep-alt"], correctIds: ["ep-l3", "ep-l1", "ep-main", "ep-side", "ep-alt"], exploratoryIds: ["ep-side", "ep-alt"], roles: { "ep-l3": "L3", "ep-main": "Skill" } });
}

function narrowFactWithDistractorsScenario() {
  return scenarioBase({ id: "narrow_distractors", query: "is production core currently modified by the retrieval experiment", intent: "factual", projectHits: [hit("nd-l3", "L3", 0.48, "# Current Truth\nProduction Core has not been modified by the retrieval experiments.", "l3:nd-l3:r1"), hit("nd-l1", "L1", 0.44, "Server tests changed only source/test harnesses; runtime release stayed unchanged.", "l1:nd-l1"), ...Array.from({ length: 12 }, (_, index) => hit(`nd-noise-${index}`, "L2", 1.5 - index * 0.03, `retrieval experiment historical detail ${index}`, `l2:nd-noise-${index}:r1`))], architectureItems: [architecture("nd-side", "# General idea\nAn exploratory context slot is unnecessary for a narrow binary fact query.", 0.32)], criticalIds: ["nd-l3", "nd-l1"], relevantIds: ["nd-l3", "nd-l1"], correctIds: ["nd-l3", "nd-l1", ...Array.from({ length: 12 }, (_, i) => `nd-noise-${i}`), "nd-side"], exploratoryIds: [], roles: { "nd-l3": "L3", "nd-l1": "L1" } });
}

function passageTailScenario() {
  const marker = "FACT_SHARED_ALLOCATION_TAIL";
  const longBody = `# Retrieval Architecture\n${"background context packing retrieval architecture discussion ".repeat(100)} uniqueanchor Conditional Admission and TKP share one guarded demand profile. ${marker}`;
  return scenarioBase({
    id: "passage_tail",
    query: "uniqueanchor shared allocation conditional admission tkp retrieval architecture",
    intent: "architecture",
    projectHits: [
      hit("pt-l3", "L3", 0.52, "# Current Truth\nConditional Admission and TKP share one guarded demand profile.", "l3:pt-l3:r1")
    ],
    architectureItems: [architecture("pt-arch", longBody, 0.5)],
    criticalIds: ["pt-l3", "pt-arch"],
    relevantIds: ["pt-l3", "pt-arch"],
    correctIds: ["pt-l3", "pt-arch"],
    factMarkers: [marker],
    roles: { "pt-l3": "L3", "pt-arch": "architecture" }
  });
}

function generatedStressScenarios(perIntent) {
  const intents = ["factual", "current", "temporal", "architecture", "workflow", "provenance", "preference", "exploratory"];
  const output = [];
  for (const intent of intents) {
    for (let seed = 1; seed <= perIntent; seed += 1) output.push(generatedStressScenario(intent, seed));
  }
  return output;
}

function generatedStressScenario(intent, seed) {
  const prefix = `mc-${intent}-${seed}`;
  const rand = mulberry32(hashString(prefix));
  const projectHits = [];
  const architectureItems = [];
  const globalItems = [];
  const skillItems = [];
  const criticalIds = [];
  const relevantIds = [];
  const correctIds = [];
  const harmfulIds = [];
  const exploratoryIds = [];
  const roles = {};

  const addCritical = (id, role) => { criticalIds.push(id); relevantIds.push(id); correctIds.push(id); roles[id] = role; };
  const addRelevant = (id, { exploratory = false } = {}) => { relevantIds.push(id); correctIds.push(id); if (exploratory) exploratoryIds.push(id); };

  const l3 = `${prefix}-l3`;
  projectHits.push(hit(l3, "L3", 0.30 + rand() * 0.30, `# Current Truth\nmemhub retrieval shared allocation keeps authoritative current truth for ${intent} requests.`, `l3:${l3}:r1`));
  addCritical(l3, "L3");

  let query = "current memhub retrieval rule";
  if (intent === "current") query = "is memhub retrieval currently using the latest shared allocation state";
  if (intent === "temporal") query = "what recent changes happened in the memhub retrieval timeline";
  if (intent === "architecture") query = "optimize memhub retrieval architecture and context allocation";
  if (intent === "workflow") query = "how should we run the memhub retrieval testing workflow";
  if (intent === "provenance") query = "why did memhub retrieval choose this evidence and what is the provenance";
  if (intent === "preference") query = "what stable preference should guide memhub retrieval design";
  if (intent === "exploratory") query = "what other options could improve memhub retrieval architecture";

  if (["current", "temporal", "provenance"].includes(intent)) {
    const freshCount = intent === "provenance" ? 2 : seed % 3 === 0 ? 3 : 2;
    for (let i = 1; i <= freshCount; i += 1) {
      const id = `${prefix}-l1-${i}`;
      projectHits.push(hit(id, "L1", 0.22 + rand() * 0.22, `Latest memhub retrieval evidence ${i} for ${intent}: shared allocation observation ${seed}-${i}.`, `l1:${id}`, `2026-10-${String(15 + Math.min(seed, 8)).padStart(2, "0")}T0${i}:00:00Z`));
      if (i <= 2) addCritical(id, "L1"); else addRelevant(id);
    }
  }

  if (["temporal", "provenance"].includes(intent)) {
    const recent = `${prefix}-l2-recent`;
    projectHits.push(hit(recent, "L2", 0.24 + rand() * 0.18, `# Timeline\nRecent memhub retrieval change for ${intent}: shared allocation now separates grounding and exploration.`, `l2:${recent}:r1`, "2026-10-22T05:00:00Z"));
    addCritical(recent, "L2");
  }

  if (["architecture", "exploratory"].includes(intent)) {
    for (let i = 1; i <= 2; i += 1) {
      const id = `${prefix}-arch-${i}`;
      architectureItems.push(architecture(id, `# Retrieval Architecture ${i}\nmemhub retrieval architecture uses shared demand and bounded context allocation path ${i}.`, 0.26 + rand() * 0.24));
      addCritical(id, "architecture");
    }
    const side = `${prefix}-arch-side`;
    architectureItems.push(architecture(side, `# Alternative Retrieval Option\nA bounded alternative for memhub retrieval is uncertainty-sensitive exploration after grounding.`, 0.18 + rand() * 0.18));
    addRelevant(side, { exploratory: true });
  }

  if (intent === "workflow") {
    const id = `${prefix}-skill`;
    skillItems.push(skill(id, "Skill candidate: memhub retrieval workflow with golden-case replay, score jitter, and context-budget checks.", 0.26 + rand() * 0.22));
    addCritical(id, "Skill");
    const side = `${prefix}-skill-side`;
    skillItems.push(skill(side, "Skill candidate: adversarial counterexample generation for retrieval allocation experiments.", 0.16 + rand() * 0.18));
    addRelevant(side, { exploratory: true });
  }

  if (intent === "preference") {
    const id = `${prefix}-l4`;
    globalItems.push(globalItem(id, "Stable preference: memhub retrieval should prefer evidence-backed minimal architecture and explicit verification.", 0.28 + rand() * 0.22));
    addCritical(id, "L4");
    const side = `${prefix}-l4-side`;
    globalItems.push(globalItem(side, "Stable preference: preserve one low-risk alternative path when the question is open-ended.", 0.15 + rand() * 0.16));
    addRelevant(side, { exploratory: true });
  }

  if (intent === "exploratory") {
    const skillSide = `${prefix}-skill-side`;
    skillItems.push(skill(skillSide, "Skill candidate: compare retrieval allocation policies on a Pareto frontier instead of one scalar score.", 0.15 + rand() * 0.18));
    addRelevant(skillSide, { exploratory: true });
  }

  const distractorCount = 8 + Math.floor(rand() * 13);
  for (let i = 0; i < distractorCount; i += 1) {
    const id = `${prefix}-noise-${i}`;
    projectHits.push(hit(id, "L2", 1.05 + rand() * 0.65, `memhub retrieval historical experiment repeated context allocation note ${i} for old ranking tests`, `l2:${id}:r1`, `2026-0${1 + (i % 8)}-10T00:00:00Z`));
    correctIds.push(id);
  }

  if (["factual", "current"].includes(intent) && seed % 2 === 0) {
    const stale = `${prefix}-stale`;
    projectHits.push(hit(stale, "L2", 1.55 + rand() * 0.25, "Old stale retrieval note says production already switched to the experimental dynamic planner.", `l2:${stale}:r1`, "2026-05-01T00:00:00Z"));
    harmfulIds.push(stale);
  }

  if (intent === "factual" && seed % 3 === 0) {
    const arch = `${prefix}-arch`;
    architectureItems.push(architecture(arch, "# Retrieval Boundary\nCurrent memhub retrieval keeps the production runtime unchanged during offline policy tests.", 0.25 + rand() * 0.20));
    addRelevant(arch);
  }

  return scenarioBase({
    id: prefix,
    query,
    intent,
    projectHits,
    architectureItems,
    globalItems,
    skillItems,
    criticalIds,
    relevantIds,
    correctIds,
    harmfulIds,
    exploratoryIds,
    roles
  });
}

function hit(id, layer, score, snippet, evidenceRef, updatedAt) { return { id, kind: "eval", memoryLayer: layer, status: "active", snippet, score, tags: [`project:memhub`, `artifact:${layer.toLowerCase()}`], source: "search", ...(evidenceRef ? { evidenceRef } : {}), ...(updatedAt ? { updatedAt } : {}) }; }
function architecture(id, content, evalScore) { return { id, content, authority: "authoritative", scope: "project", source: "project-architecture", projectId: "memhub", evalScore }; }
function skill(id, content, evalScore) { return { id, content, authority: "remembered", scope: "capability", source: "memmy-memory", projectId: "memhub", evalScore, provenance: { memoryLayer: "Skill" } }; }
function globalItem(id, content, evalScore) { return { id, content, authority: "remembered", scope: "global", source: "memmy-memory", evalScore, provenance: { memoryLayer: "L4" } }; }

function groupByKind(items) { const groups = new Map(); for (const item of items) { const kind = itemKind(item); if (!groups.has(kind)) groups.set(kind, []); groups.get(kind).push(item); } for (const group of groups.values()) group.sort(scoreSort); return groups; }
function itemKind(item) { return item.source === "project-architecture" ? "architecture" : item.provenance?.memoryLayer ?? "other"; }
function matchedTermCount(item) { const value = item.provenance?.retrievalV1?.matchedTerms; return Array.isArray(value) ? value.length : 0; }
function scoreSort(a, b) { return (b.evalScore ?? 0) - (a.evalScore ?? 0) || a.id.localeCompare(b.id); }
function scoreAmbiguity(items) { const scores = [...items].map((item) => item.evalScore ?? 0).sort((a,b) => b-a).slice(0, 8); if (scores.length < 2) return 0; const gaps = scores.slice(0,-1).map((score,i) => Math.abs(score - scores[i+1])); return 1 - Math.min(1, mean(gaps) / 0.25); }
function temporalValue(value) { const timestamp = Date.parse(value ?? ""); if (!Number.isFinite(timestamp)) return 0; const oldest = Date.parse("2026-01-01T00:00:00Z"); const newest = Date.parse("2026-12-31T23:59:59Z"); return Math.max(0, Math.min(1, (timestamp - oldest) / (newest - oldest))); }
function planBytes(plan) { return bytes([...plan.required, ...plan.supporting].flatMap((entry) => entry.passages ?? []).map((passage) => passage.text).join("\n")); }
function tokenJaccard(left, right) { const a = new Set(tokenizeRetrievalText(left)); const b = new Set(tokenizeRetrievalText(right)); if (!a.size || !b.size) return 0; let overlap = 0; for (const term of a) if (b.has(term)) overlap += 1; return overlap / (a.size + b.size - overlap); }
function jaccardSets(a, b) { if (!a.size && !b.size) return 1; let overlap = 0; for (const value of a) if (b.has(value)) overlap += 1; return overlap / (a.size + b.size - overlap); }
function geometricMean(values) { if (values.some((value) => value <= 0)) return 0; return Math.exp(mean(values.map((value) => Math.log(value)))); }
function deterministicJitter(value) { let hash = 2166136261; for (const char of value) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619); return ((hash >>> 0) / 0xffffffff) * 2 - 1; }
function hashString(value) { let hash = 2166136261; for (const char of value) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619); return hash >>> 0; }
function mulberry32(seed) { return () => { let t = seed += 0x6D2B79F5; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function clone(value) { return structuredClone(value); }
function ratio(a,b) { return b > 0 ? a/b : 1; }
function mean(values) { return values.length ? values.reduce((a,b) => a+b,0)/values.length : 0; }
function bytes(value) { return Buffer.byteLength(value ?? "", "utf8"); }
function totalBytes(values) { return values.reduce((sum, value) => sum + bytes(value), 0); }
function f(value, digits=3) { return Number(value.toFixed(digits)); }

