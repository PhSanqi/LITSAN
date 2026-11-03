#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildContextCapsule, utf8Prefix } from "../dist/context-capsule.js";
import { rankRecallHits, tokenizeRetrievalText } from "../dist/retrieval-ranker.js";
import { buildTurnKnowledgePlan } from "../dist/turn-knowledge-plan.js";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const DYNAMIC_ONLY = process.argv.includes("--dynamic-topk");
const OUTPUT = resolve(
  ROOT,
  ".review-runtime",
  DYNAMIC_ONLY ? "dynamic-topk-matrix-20261023.json" : "retrieval-order-matrix-20261023.json"
);
const K_VALUES = DYNAMIC_ONLY ? [2, 4, 6, 8, 12] : [2, 4, 6, 8, 12, 16, 24, 32, 48, 50];
const ORDERS = [
  ["topk", "tkp", "budget"],
  ["topk", "budget", "tkp"],
  ["tkp", "topk", "budget"],
  ["tkp", "budget", "topk"],
  ["budget", "topk", "tkp"],
  ["budget", "tkp", "topk"]
];
const TOPK_POLICIES = [
  "project_score",
  "global_score",
  "kind_aware",
  "quota_aware",
  "adaptive_kind",
  "score_gap",
  "role_aware"
];
const DYNAMIC_TOPK_POLICIES = [
  "kind_relative_80",
  "kind_relative_50",
  "kind_relative_70",
  "kind_relative_85",
  "kind_relative_90",
  "kind_relative_92",
  "kind_top_p_50",
  "kind_top_p_70",
  "kind_top_p_85",
  "kind_top_p_95",
  "coverage_gap_10",
  "coverage_gap_20",
  "entropy_cap2",
  "entropy_cool",
  "entropy_tight",
  "entropy_warm",
  "entropy_wide",
  "entropy_relative_85",
  "planner_capacity_balanced",
  "planner_capacity_relevance",
  "planner_capacity_flex",
  "planner_priority_15",
  "planner_priority_30",
  "planner_priority_45",
  "planner_signal_idf",
  "planner_signal_mmr",
  "planner_signal_hybrid",
  "planner_recency_30",
  "planner_recency_60",
  "planner_temporal_aware",
  "utility_1500",
  "utility_1800",
  "utility_2k",
  "utility_2400",
  "utility_3k"
];
const ACTIVE_TOPK_POLICIES = DYNAMIC_ONLY
  ? ["kind_aware", "quota_aware", "adaptive_kind", "score_gap", ...DYNAMIC_TOPK_POLICIES]
  : TOPK_POLICIES;
const ACTIVE_ORDERS = DYNAMIC_ONLY ? [["topk", "tkp", "budget"]] : ORDERS;

const baseScenarios = [
  scenarioCurrentTruthTail(),
  scenarioArchitectureBudget(),
  scenarioMixedRoles(),
  scenarioDistractorSwarm(),
  scenarioFreshEvidenceTail(),
  scenarioSkillSwarm(),
  scenarioLongObjectBudget(),
  scenarioLargeCandidatePool(),
  scenarioDeepTailCritical(),
  scenarioMultiArchitectureCritical(),
  scenarioMultiFreshL1Critical(),
  scenarioDenseCrossKindCritical(),
  scenarioTemporalChineseLatest(),
  scenarioNonTemporalRelevantL2(),
  scenarioTemporalIrrelevantNewest(),
  scenarioPassageControl()
];
const scenarios = baseScenarios.flatMap(DYNAMIC_ONLY ? expandDynamicScenario : expandScenario);

const variants = ACTIVE_ORDERS.flatMap((ops) => ACTIVE_TOPK_POLICIES
  .filter((policy) => policy !== "role_aware" || ops.indexOf("tkp") < ops.indexOf("topk"))
  .map((policy) => ({
    id: `${ops.join("_")}__${policy}`,
    order: ops.join("_"),
    label: ops.map((op) => op === "topk" ? "TopK" : op === "tkp" ? "TKP" : "Budget").join(" → "),
    ops,
    topkPolicy: policy,
    currentSemantics: ops.join("_") === "topk_budget_tkp" && policy === "project_score"
  })));

const rows = [];
for (const k of K_VALUES) {
  for (const variant of variants) {
    for (const scenario of scenarios) {
      rows.push(await runScenario(scenario, variant, k));
    }
  }
}

const summary = K_VALUES.flatMap((k) => variants.map((variant) => summarize(
  rows.filter((row) => row.k === k && row.variant === variant.id),
  { k, variant: variant.id, order: variant.order, policy: variant.topkPolicy, label: variant.label }
)));

const orderSummary = ACTIVE_ORDERS.map((ops) => {
  const order = ops.join("_");
  return summarize(
    rows.filter((row) => row.order === order && row.topk_policy !== "role_aware"),
    { order, label: ops.map((op) => op === "topk" ? "TopK" : op === "tkp" ? "TKP" : "Budget").join(" → ") }
  );
});

const best = [...summary].sort((a, b) =>
  b.critical_recall - a.critical_recall ||
  b.role_coverage - a.role_coverage ||
  b.ndcg_at_8 - a.ndcg_at_8 ||
  b.context_precision - a.context_precision ||
  a.avg_final_context_bytes - b.avg_final_context_bytes
).slice(0, 12);

const result = {
  generated_at: new Date().toISOString(),
  purpose: "Offline order/Top-K comparison only. Does not touch Memory Core or the production runtime.",
  variants,
  k_values: K_VALUES,
  metrics: {
    critical_recall: "Fraction of ground-truth critical knowledge objects present in final context.",
    role_coverage: "Fraction of required knowledge roles (for example L3 and architecture) represented in final context.",
    context_recall: "Fraction of all labelled-relevant objects present in final context.",
    context_precision: "Fraction of final context objects that are labelled relevant.",
    ndcg_at_8: "Graded ranking quality of the final context order at depth 8.",
    critical_mrr: "Reciprocal rank of the first critical knowledge object in final context.",
    tkp_input_critical_recall: "Critical knowledge still visible when TKP starts; isolates pre-TKP loss.",
    topk_input_critical_recall: "Critical knowledge still visible when TopK starts.",
    budget_input_critical_recall: "Critical knowledge still visible when Context Budget starts.",
    topk_critical_loss: "Critical recall lost exactly when TopK executes.",
    tkp_critical_loss: "Critical recall lost exactly when TKP executes, including TKP internal caps.",
    budget_critical_loss: "Critical recall lost exactly when Context Budget executes.",
    avg_tkp_input_items: "Number of objects TKP inspects; deterministic cost proxy.",
    avg_tkp_input_bytes: "Bytes TKP inspects; deterministic scan-cost proxy.",
    avg_final_context_bytes: "Final context payload bytes; token/cost proxy.",
    avg_topk_output_items: "Actual number of candidates emitted by TopK/admission. Important for dynamic policies.",
    avg_topk_output_bytes: "Actual candidate bytes emitted by TopK/admission."
  },
  scenarios: scenarios.map(({ id, description, budgetBytes, itemBytes, groundTruth }) => ({
    id, description, budgetBytes, itemBytes, groundTruth
  })),
  order_summary: orderSummary,
  best_quality_rows: best,
  summary,
  rows
};

await mkdir(resolve(ROOT, ".review-runtime"), { recursive: true });
await writeFile(OUTPUT, JSON.stringify(result, null, 2) + "\n", "utf8");

console.log(`Retrieval operator matrix: ${rows.length} offline runs`);
console.log("Order effect, averaged over non-role policies, K values and scenarios");
console.table(orderSummary.map((row) => ({
  order: row.order,
  criticalRecall: f(row.critical_recall),
  roleCoverage: f(row.role_coverage),
  contextRecall: f(row.context_recall),
  contextPrecision: f(row.context_precision),
  nDCG8: f(row.ndcg_at_8),
  criticalMRR: f(row.critical_mrr),
  topkLoss: f(row.topk_critical_loss),
  tkpLoss: f(row.tkp_critical_loss),
  budgetLoss: f(row.budget_critical_loss),
  tkpKB: f(row.avg_tkp_input_bytes / 1024, 1),
  finalKB: f(row.avg_final_context_bytes / 1024, 1)
})));
console.log("Best quality rows");
console.table(best.map((row) => ({
  K: row.k,
  order: row.order,
  policy: row.policy,
  criticalRecall: f(row.critical_recall),
  roleCoverage: f(row.role_coverage),
  contextRecall: f(row.context_recall),
  contextPrecision: f(row.context_precision),
  nDCG8: f(row.ndcg_at_8),
  criticalMRR: f(row.critical_mrr),
  topkLoss: f(row.topk_critical_loss),
  tkpLoss: f(row.tkp_critical_loss),
  budgetLoss: f(row.budget_critical_loss),
  tkpKB: f(row.avg_tkp_input_bytes / 1024, 1),
  finalKB: f(row.avg_final_context_bytes / 1024, 1)
})));
console.log(`saved: ${OUTPUT}`);

async function runScenario(scenario, variant, k) {
  let state = initialState(scenario);
  const stages = [];
  for (const op of variant.ops) {
    const before = stageSnapshot(state, scenario);
    if (op === "topk") state = applyTopK(state, k, variant.topkPolicy);
    else if (op === "tkp") state = await applyTKP(state, scenario);
    else state = applyBudget(state, scenario);
    const after = stageSnapshot(state, scenario);
    stages.push({ op, before, after, critical_loss: Math.max(0, before.critical_recall - after.critical_recall) });
  }

  const truth = scenario.groundTruth;
  const relevantIds = Object.keys(truth.grades).filter((id) => truth.grades[id] > 0);
  const criticalIds = truth.criticalIds;
  const finalIds = state.items.map((item) => item.id);
  const roleSet = new Set(finalIds.map((id) => truth.roles[id]).filter(Boolean));
  const requiredRoles = [...new Set(criticalIds.map((id) => truth.roles[id]).filter(Boolean))];
  const relevantFinal = finalIds.filter((id) => relevantIds.includes(id));
  const stage = (name) => stages.find((entry) => entry.op === name);
  return {
    scenario: scenario.id,
    variant: variant.id,
    order: variant.order,
    topk_policy: variant.topkPolicy,
    current_semantics: variant.currentSemantics,
    k,
    critical_recall: ratio(criticalIds.filter((id) => finalIds.includes(id)).length, criticalIds.length),
    role_coverage: ratio(requiredRoles.filter((role) => roleSet.has(role)).length, requiredRoles.length),
    context_recall: ratio(relevantFinal.length, relevantIds.length),
    context_precision: ratio(relevantFinal.length, finalIds.length),
    ndcg_at_8: ndcg(finalIds, truth.grades, 8),
    critical_mrr: reciprocalRank(finalIds, new Set(criticalIds)),
    tkp_input_critical_recall: stage("tkp")?.before.critical_recall ?? 1,
    topk_input_critical_recall: stage("topk")?.before.critical_recall ?? 1,
    budget_input_critical_recall: stage("budget")?.before.critical_recall ?? 1,
    topk_critical_loss: stage("topk")?.critical_loss ?? 0,
    tkp_critical_loss: stage("tkp")?.critical_loss ?? 0,
    budget_critical_loss: stage("budget")?.critical_loss ?? 0,
    tkp_input_items: stage("tkp")?.before.items ?? 0,
    tkp_input_bytes: stage("tkp")?.before.bytes ?? 0,
    topk_output_items: stage("topk")?.after.items ?? state.items.length,
    topk_output_bytes: stage("topk")?.after.bytes ?? totalBytes(state.items),
    final_context_bytes: totalBytes(state.items),
    final_items: state.items.length,
    final_ids: finalIds,
    tkp_required_ids: state.plan?.required.map((entry) => entry.id) ?? [],
    tkp_supporting_ids: state.plan?.supporting.map((entry) => entry.id) ?? [],
    stages
  };
}

function initialState(scenario) {
  const ranked = rankRecallHits(scenario.projectHits, scenario.query, 50);
  const project = ranked.hits.map(rankedToProjectItem);
  const others = [...scenario.globalItems, ...scenario.skillItems, ...scenario.architectureItems]
    .map(cloneItem)
    .map((item) => withEvalScore(item, scenario.query));
  return { items: [...project, ...others], query: scenario.query, tkpApplied: false, plan: null };
}

function applyTopK(state, k, policy) {
  let items;
  if (policy === "project_score") {
    const project = state.items.filter(isProjectMemory).sort(scoreSort).slice(0, k);
    items = [...project, ...state.items.filter((item) => !isProjectMemory(item))];
  } else if (policy === "global_score") {
    items = [...state.items].sort(scoreSort).slice(0, k);
  } else if (policy === "kind_aware") {
    items = kindAwareTopK(state.items, k);
  } else if (policy === "quota_aware") {
    items = quotaAwareTopK(state.items, k);
  } else if (policy === "adaptive_kind") {
    items = adaptiveKindTopK(state.items, k);
  } else if (policy === "score_gap") {
    items = scoreGapTopK(state.items, k);
  } else if (policy.startsWith("kind_relative_")) {
    items = kindRelativeTopK(state.items, k, Number(policy.slice("kind_relative_".length)) / 100);
  } else if (policy.startsWith("kind_top_p_")) {
    items = kindTopP(state.items, k, Number(policy.slice("kind_top_p_".length)) / 100);
  } else if (policy.startsWith("coverage_gap_")) {
    items = coverageGapTopK(state.items, k, Number(policy.slice("coverage_gap_".length)) / 100);
  } else if (policy === "entropy_tight") {
    items = entropyKindTopK(state.items, k, { temperature: 0.08, maxPerKind: 3 });
  } else if (policy === "entropy_cap2") {
    items = entropyKindTopK(state.items, k, { temperature: 0.08, maxPerKind: 2 });
  } else if (policy === "entropy_cool") {
    items = entropyKindTopK(state.items, k, { temperature: 0.05, maxPerKind: 3 });
  } else if (policy === "entropy_warm") {
    items = entropyKindTopK(state.items, k, { temperature: 0.11, maxPerKind: 3 });
  } else if (policy === "entropy_wide") {
    items = entropyKindTopK(state.items, k, { temperature: 0.14, maxPerKind: 5 });
  } else if (policy === "entropy_relative_85") {
    items = entropyRelativeTopK(state.items, k, { temperature: 0.08, maxPerKind: 4, relativeFloor: 0.85 });
  } else if (policy === "planner_capacity_balanced") {
    items = plannerCapacityTopK(state.items, { relevantOnly: false, flexible: false });
  } else if (policy === "planner_capacity_relevance") {
    items = plannerCapacityTopK(state.items, { relevantOnly: true, flexible: false });
  } else if (policy === "planner_capacity_flex") {
    items = plannerCapacityTopK(state.items, { relevantOnly: true, flexible: true });
  } else if (policy.startsWith("planner_priority_")) {
    items = plannerPriorityTopK(state.items, Number(policy.slice("planner_priority_".length)) / 100);
  } else if (policy === "planner_signal_idf") {
    items = plannerSignalTopK(state.items, { freshBoost: 0.22, idfWeight: 0.6, noveltyWeight: 0 });
  } else if (policy === "planner_signal_mmr") {
    items = plannerSignalTopK(state.items, { freshBoost: 0.22, idfWeight: 0, noveltyWeight: 0.45 });
  } else if (policy === "planner_signal_hybrid") {
    items = plannerSignalTopK(state.items, { freshBoost: 0.22, idfWeight: 0.45, noveltyWeight: 0.3 });
  } else if (policy === "planner_recency_30") {
    items = plannerRecencyTopK(state.items, { freshBoost: 0.30, l2RecencyWeight: 0.30 });
  } else if (policy === "planner_recency_60") {
    items = plannerRecencyTopK(state.items, { freshBoost: 0.30, l2RecencyWeight: 0.60 });
  } else if (policy === "planner_temporal_aware") {
    items = plannerTemporalTopK(state.items, state.query, 0.30);
  } else if (policy === "utility_1500") {
    items = utilityBudgetTopK(state.items, k, 1_500);
  } else if (policy === "utility_1800") {
    items = utilityBudgetTopK(state.items, k, 1_800);
  } else if (policy === "utility_2k") {
    items = utilityBudgetTopK(state.items, k, 2_000);
  } else if (policy === "utility_2400") {
    items = utilityBudgetTopK(state.items, k, 2_400);
  } else if (policy === "utility_3k") {
    items = utilityBudgetTopK(state.items, k, 3_000);
  } else {
    if (!state.tkpApplied) throw new Error("role_aware TopK requires TKP first");
    items = [...state.items].sort((a, b) => roleRank(a.role) - roleRank(b.role) || scoreSort(a, b)).slice(0, k);
  }
  return { ...state, items };
}

async function applyTKP(state, scenario) {
  const capsule = capsuleFromItems(state.items, scenario, 512_000, 128_000, "full");
  const plan = await buildTurnKnowledgePlan({
    query: scenario.query,
    capsule,
    hydrateEvidence: hydrateFromScenario(scenario),
    dedupe: false
  });
  const byId = new Map(state.items.map((item) => [item.id, item]));
  const entries = [
    ...plan.required.map((entry) => ({ entry, role: "required" })),
    ...plan.supporting.map((entry) => ({ entry, role: "supporting" }))
  ];
  const items = entries.flatMap(({ entry, role }) => {
    const original = byId.get(entry.id);
    if (!original) return [];
    const passage = (entry.passages ?? [])
      .map((p) => p.heading ? `# ${p.heading}\n${p.text}` : p.text)
      .join("\n\n").trim();
    const content = passage || utf8Prefix(original.content, 900);
    return [{ ...original, content, role }];
  });
  return { ...state, items, tkpApplied: true, plan };
}

function applyBudget(state, scenario) {
  if (state.tkpApplied) {
    const ordered = [...state.items].sort((a, b) => roleRank(a.role) - roleRank(b.role) || scoreSort(a, b));
    return { ...state, items: bytePack(ordered, scenario.budgetBytes, scenario.itemBytes) };
  }
  const capsule = capsuleFromItems(state.items, scenario, scenario.budgetBytes, scenario.itemBytes, "brief");
  const kept = new Map(capsuleItems(capsule).map((item) => [item.id, item.content]));
  return {
    ...state,
    items: state.items.flatMap((item) => kept.has(item.id) ? [{ ...item, content: kept.get(item.id) }] : [])
  };
}

function capsuleFromItems(items, scenario, maxContentBytes, maxItemContentBytes, detail) {
  const projectMemory = items.filter(isProjectMemory);
  return buildContextCapsule({
    accountId: "eval",
    resolution: resolvedProject(),
    globalMemory: items.filter((item) => item.scope === "global"),
    projectMemory,
    reusableSkills: items.filter((item) => item.scope === "capability"),
    projectArchitecture: items.filter((item) => item.source === "project-architecture"),
    retrievalDiagnostics: diagnosticsFromItems(projectMemory, scenario.query),
    detail,
    maxContentBytes,
    maxItemContentBytes,
    query: scenario.query
  });
}

function bytePack(items, maxBytes, maxItemBytes) {
  const output = [];
  let remaining = maxBytes;
  for (const item of items) {
    if (remaining < 64) break;
    const content = utf8Prefix(item.content, Math.min(maxItemBytes, remaining));
    if (!content) continue;
    output.push({ ...item, content });
    remaining -= bytes(content);
  }
  return output;
}

function capsuleItems(capsule) {
  return [
    ...capsule.globalMemory,
    ...capsule.projectMemory,
    ...capsule.reusableSkills,
    ...capsule.projectArchitecture
  ].map((item) => ({ ...item, emittedBytes: bytes(item.content) }));
}

function rankedToProjectItem(ranked) {
  const hit = ranked.hit;
  const l1 = hit.memoryLayer === "L1";
  return {
    id: hit.id,
    ...(hit.evidenceRef ? { evidenceRef: hit.evidenceRef } : {}),
    content: hit.snippet,
    authority: l1 ? "evidence" : "remembered",
    scope: "project",
    source: l1 ? "memhub-capture" : "memmy-memory",
    projectId: "memhub",
    ...(hit.createdAt ? { createdAt: hit.createdAt } : {}),
    ...(hit.updatedAt ? { updatedAt: hit.updatedAt } : {}),
    evalScore: ranked.fusedScore - ranked.diversityPenaltyApplied,
    provenance: {
      memoryLayer: hit.memoryLayer,
      ...(l1 ? { freshness: "undistilled" } : {}),
      retrievalV1: {
        rank: ranked.rank,
        semanticScore: ranked.semanticScore,
        lexicalScore: ranked.lexicalScore,
        fusedScore: ranked.fusedScore,
        diversityPenaltyApplied: ranked.diversityPenaltyApplied,
        matchedTerms: ranked.matchedTerms,
        candidateCount: 0,
        dedupedCount: 0
      }
    }
  };
}

function diagnosticsFromItems(projectItems, query) {
  const queryTerms = tokenizeRetrievalText(query).slice(0, 32);
  const empty = {
    version: "retrieval-v1",
    semanticWeight: 0.68,
    lexicalWeight: 0.32,
    diversityPenalty: 0.12,
    candidateCount: 0,
    dedupedCount: 0,
    emittedCount: 0,
    queryTerms,
    decisions: []
  };
  const project = {
    ...empty,
    candidateCount: projectItems.length,
    dedupedCount: projectItems.length,
    emittedCount: projectItems.length
  };
  return {
    version: "retrieval-v1",
    requestedLimit: Math.max(1, projectItems.length),
    finalLimit: Math.max(1, projectItems.length),
    candidateLimit: Math.max(12, projectItems.length),
    lanes: { global: empty, project, skills: empty }
  };
}

function withEvalScore(item, query) {
  const queryTerms = tokenizeRetrievalText(query);
  const terms = new Set(tokenizeRetrievalText(item.content));
  const matchedTerms = queryTerms.filter((term) => terms.has(term));
  const lexical = queryTerms.length ? matchedTerms.length / queryTerms.length : 0;
  const sourcePrior = item.source === "project-architecture" ? 0.08 : item.scope === "global" ? 0.04 : 0.02;
  return {
    ...item,
    evalScore: Number.isFinite(item.evalScore) ? item.evalScore : lexical + sourcePrior,
    provenance: {
      ...(item.provenance ?? {}),
      retrievalV1: {
        ...((item.provenance?.retrievalV1 ?? {})),
        matchedTerms: matchedTerms.slice(0, 16)
      }
    }
  };
}

function kindAwareTopK(items, k) {
  const kinds = ["L3", "architecture", "L1", "L2", "L4", "Skill", "other"];
  const groups = new Map(kinds.map((kind) => [kind, []]));
  for (const item of items) {
    const kind = itemKind(item);
    if (!groups.has(kind)) groups.set(kind, []);
    groups.get(kind).push(item);
  }
  for (const group of groups.values()) group.sort(scoreSort);
  const output = [];
  while (output.length < k) {
    let progressed = false;
    for (const kind of kinds) {
      const next = groups.get(kind)?.shift();
      if (!next) continue;
      output.push(next);
      progressed = true;
      if (output.length >= k) break;
    }
    if (!progressed) break;
  }
  return output;
}

function quotaAwareTopK(items, k) {
  const quotas = [
    ["L3", 1],
    ["architecture", 2],
    ["L1", 2],
    ["L2", 1],
    ["L4", 1],
    ["Skill", 1]
  ];
  const groups = new Map();
  for (const item of items) {
    const kind = itemKind(item);
    if (!groups.has(kind)) groups.set(kind, []);
    groups.get(kind).push(item);
  }
  for (const group of groups.values()) group.sort(scoreSort);
  const selected = [];
  const selectedIds = new Set();
  for (const [kind, quota] of quotas) {
    for (const item of (groups.get(kind) ?? []).slice(0, quota)) {
      if (selected.length >= k) break;
      selected.push(item);
      selectedIds.add(item.id);
    }
    if (selected.length >= k) break;
  }
  if (selected.length < k) {
    for (const item of [...items].sort(scoreSort)) {
      if (selectedIds.has(item.id)) continue;
      selected.push(item);
      selectedIds.add(item.id);
      if (selected.length >= k) break;
    }
  }
  return selected;
}

function adaptiveKindTopK(items, k) {
  const presentKinds = ["L3", "architecture", "L1", "L2", "L4", "Skill"]
    .filter((kind) => items.some((item) => itemKind(item) === kind));
  const target = Math.max(k, presentKinds.length);
  return kindAwareTopK(items, Math.min(50, target));
}

function scoreGapTopK(items, k) {
  const sorted = [...items].sort(scoreSort);
  if (sorted.length <= k) return sorted;
  let limit = Math.min(k, sorted.length);
  const maxLimit = Math.min(50, Math.max(k, k * 4));
  while (limit < Math.min(maxLimit, sorted.length)) {
    const previous = sorted[limit - 1]?.evalScore ?? 0;
    const next = sorted[limit]?.evalScore ?? 0;
    if (Math.abs(previous - next) > 0.03) break;
    limit += 1;
  }
  return sorted.slice(0, limit);
}

function kindRelativeTopK(items, k, relativeFloor) {
  const groups = groupByKind(items);
  const selected = [];
  const selectedIds = new Set();
  const maxLimit = Math.min(50, Math.max(12, k * 3));
  for (const kind of kindOrder()) {
    const group = groups.get(kind) ?? [];
    if (group.length === 0) continue;
    const top = Math.max(0.0001, group[0]?.evalScore ?? 0);
    for (const item of group.slice(0, 6)) {
      if (selected.length >= maxLimit) break;
      const score = Math.max(0, item.evalScore ?? 0);
      if (item !== group[0] && score < top * relativeFloor) break;
      selected.push(item);
      selectedIds.add(item.id);
    }
  }
  fillToMinimum(selected, selectedIds, items, k, maxLimit);
  return selected.sort(scoreSort);
}

function kindTopP(items, k, p) {
  const groups = groupByKind(items);
  const selected = [];
  const selectedIds = new Set();
  const maxLimit = Math.min(50, Math.max(12, k * 3));
  for (const kind of kindOrder()) {
    const group = groups.get(kind) ?? [];
    if (group.length === 0) continue;
    const weights = softmaxWeights(group.map((item) => item.evalScore ?? 0), 0.12);
    let mass = 0;
    for (let index = 0; index < group.length && index < 8; index += 1) {
      const item = group[index];
      if (!item || selected.length >= maxLimit) break;
      selected.push(item);
      selectedIds.add(item.id);
      mass += weights[index] ?? 0;
      if (mass >= p) break;
    }
  }
  fillToMinimum(selected, selectedIds, items, k, maxLimit);
  return selected.sort(scoreSort);
}

function coverageGapTopK(items, k, gapRatio) {
  const groups = groupByKind(items);
  const selected = [];
  const selectedIds = new Set();
  const maxLimit = Math.min(50, Math.max(12, k * 3));

  // Coverage floor: keep one representative from every present knowledge kind.
  for (const kind of kindOrder()) {
    const first = groups.get(kind)?.[0];
    if (!first) continue;
    selected.push(first);
    selectedIds.add(first.id);
  }

  const remaining = [...items].filter((item) => !selectedIds.has(item.id)).sort(scoreSort);
  for (const item of remaining) {
    if (selected.length >= maxLimit) break;
    const previous = [...selected].sort(scoreSort).at(-1);
    const previousScore = Math.max(0.0001, previous?.evalScore ?? 0);
    const nextScore = Math.max(0, item.evalScore ?? 0);
    if (selected.length >= k && (previousScore - nextScore) / previousScore > gapRatio) break;
    selected.push(item);
    selectedIds.add(item.id);
  }
  fillToMinimum(selected, selectedIds, items, k, maxLimit);
  return selected.sort(scoreSort);
}

function entropyKindTopK(items, k, { temperature, maxPerKind }) {
  const groups = groupByKind(items);
  const selected = [];
  const selectedIds = new Set();
  const maxLimit = Math.min(50, Math.max(12, k * 3));
  for (const kind of kindOrder()) {
    const group = groups.get(kind) ?? [];
    if (group.length === 0) continue;
    const weights = softmaxWeights(group.map((item) => item.evalScore ?? 0), temperature);
    const entropy = normalizedEntropy(weights);
    const width = Math.min(group.length, maxPerKind, 1 + Math.round(entropy * Math.max(0, maxPerKind - 1)));
    for (const item of group.slice(0, width)) {
      if (selected.length >= maxLimit) break;
      selected.push(item);
      selectedIds.add(item.id);
    }
  }
  fillToMinimum(selected, selectedIds, items, k, maxLimit);
  return selected.sort(scoreSort);
}

function entropyRelativeTopK(items, k, { temperature, maxPerKind, relativeFloor }) {
  const groups = groupByKind(items);
  const selected = [];
  const selectedIds = new Set();
  const maxLimit = Math.min(50, Math.max(12, k * 3));
  for (const kind of kindOrder()) {
    const group = groups.get(kind) ?? [];
    if (group.length === 0) continue;
    const weights = softmaxWeights(group.map((item) => item.evalScore ?? 0), temperature);
    const entropy = normalizedEntropy(weights);
    const entropyWidth = Math.min(group.length, maxPerKind, 1 + Math.round(entropy * Math.max(0, maxPerKind - 1)));
    const top = Math.max(0.0001, group[0]?.evalScore ?? 0);
    for (const item of group.slice(0, entropyWidth)) {
      if (selected.length >= maxLimit) break;
      const score = Math.max(0, item.evalScore ?? 0);
      if (item !== group[0] && score < top * relativeFloor) break;
      selected.push(item);
      selectedIds.add(item.id);
    }
  }
  fillToMinimum(selected, selectedIds, items, k, maxLimit);
  return selected.sort(scoreSort);
}

function utilityBudgetTopK(items, k, byteBudget) {
  const groups = groupByKind(items);
  const selected = [];
  const selectedIds = new Set();
  const maxLimit = Math.min(50, Math.max(12, k * 3));
  let estimatedBytes = 0;

  // Keep one representative per kind first. This is deliberately a coverage floor,
  // not an assertion that all kinds are equally authoritative.
  for (const kind of kindOrder()) {
    const item = groups.get(kind)?.[0];
    if (!item || selected.length >= maxLimit) continue;
    selected.push(item);
    selectedIds.add(item.id);
    estimatedBytes += admissionCost(item);
  }

  const candidates = [...items]
    .filter((item) => !selectedIds.has(item.id))
    .map((item) => ({ item, utility: normalizedKindScore(item, groups) / Math.sqrt(admissionCost(item) / 450 + 0.5) }))
    .sort((a, b) => b.utility - a.utility || scoreSort(a.item, b.item));
  for (const candidate of candidates) {
    if (selected.length >= maxLimit) break;
    const cost = admissionCost(candidate.item);
    if (selected.length >= k && estimatedBytes + cost > byteBudget) break;
    selected.push(candidate.item);
    selectedIds.add(candidate.item.id);
    estimatedBytes += cost;
  }
  fillToMinimum(selected, selectedIds, items, k, maxLimit);
  return selected.sort(scoreSort);
}

function plannerCapacityTopK(items, { relevantOnly, flexible }) {
  const groups = groupByKind(items);
  const selected = [];
  const selectedIds = new Set();

  const l3 = groups.get("L3")?.[0];
  if (l3) addUnique(selected, selectedIds, l3);

  const architecture = [...(groups.get("architecture") ?? [])]
    .sort(admissionRelevanceSort)
    .filter((item) => !relevantOnly || matchedTermCount(item) > 0)
    .slice(0, 2);
  for (const item of architecture) addUnique(selected, selectedIds, item);

  const supportingKinds = ["L1", "L2", "L4", "Skill"];
  const supporting = [];
  const supportingIds = new Set();

  // First pass: one representative from each supporting kind.
  for (const kind of supportingKinds) {
    const candidates = [...(groups.get(kind) ?? [])]
      .sort(admissionRelevanceSort)
      .filter((item) => !relevantOnly || matchedTermCount(item) > 0);
    const first = candidates[0];
    if (!first) continue;
    supporting.push(first);
    supportingIds.add(first.id);
    if (supporting.length >= 4) break;
  }

  // Second pass: only Fresh L1 may consume additional supporting slots.
  // Current TKP consumes one top L2, while L4/Skill are already represented
  // by the first-pass kind coverage. Admitting duplicate L2/L4/Skill here
  // only wastes capacity that TKP cannot use.
  if (supporting.length < 4) {
    const remaining = (groups.get("L1") ?? [])
      .filter((item) => !supportingIds.has(item.id))
      .filter((item) => !relevantOnly || matchedTermCount(item) > 0)
      .map((item) => ({ item, utility: supportingAdmissionUtility(item) }))
      .sort((a, b) => b.utility - a.utility || admissionRelevanceSort(a.item, b.item));
    for (const { item } of remaining) {
      if (supporting.length >= 4) break;
      supporting.push(item);
      supportingIds.add(item.id);
    }
  }
  for (const item of supporting) addUnique(selected, selectedIds, item);

  if (flexible) {
    // If the planner-side capacities are not fully used, do not fill with noise.
    // If there is unused required capacity, admit one extra strongly relevant
    // Architecture candidate so later TKP revisions can exploit it without a new recall.
    const unusedRequired = Math.max(0, 4 - (l3 ? 1 : 0) - architecture.length);
    if (unusedRequired > 0) {
      const extraArchitecture = [...(groups.get("architecture") ?? [])]
        .filter((item) => !selectedIds.has(item.id) && matchedTermCount(item) > 0)
        .sort(admissionRelevanceSort)
        .slice(0, unusedRequired);
      for (const item of extraArchitecture) addUnique(selected, selectedIds, item);
    }
  }
  return selected.sort(scoreSort);
}

function plannerPriorityTopK(items, freshBoost) {
  const groups = groupByKind(items);
  const selected = [];
  const selectedIds = new Set();

  const l3 = groups.get("L3")?.[0];
  if (l3) addUnique(selected, selectedIds, l3);

  const architecture = [...(groups.get("architecture") ?? [])]
    .sort(admissionRelevanceSort)
    .slice(0, 2);
  for (const item of architecture) addUnique(selected, selectedIds, item);

  const caps = new Map([["L1", 3], ["L2", 1], ["L4", 1], ["Skill", 1]]);
  const supportingCandidates = [];
  for (const [kind, cap] of caps) {
    for (const item of (groups.get(kind) ?? []).slice(0, cap)) {
      const normalized = normalizedKindScore(item, groups);
      const lexicalBonus = Math.min(0.25, matchedTermCount(item) * 0.05);
      const authorityBonus = kind === "L1" ? freshBoost : kind === "L2" ? 0.05 : 0;
      supportingCandidates.push({ item, utility: normalized + lexicalBonus + authorityBonus });
    }
  }
  supportingCandidates.sort((a, b) => b.utility - a.utility || admissionRelevanceSort(a.item, b.item));
  for (const { item } of supportingCandidates.slice(0, 4)) addUnique(selected, selectedIds, item);
  return selected.sort(scoreSort);
}

function plannerSignalTopK(items, { freshBoost, idfWeight, noveltyWeight }) {
  const groups = groupByKind(items);
  const selected = [];
  const selectedIds = new Set();

  const l3 = groups.get("L3")?.[0];
  if (l3) addUnique(selected, selectedIds, l3);

  const architecture = [...(groups.get("architecture") ?? [])]
    .sort((a, b) => signalUtility(b, groups, items, selected, { freshBoost: 0, idfWeight, noveltyWeight })
      - signalUtility(a, groups, items, selected, { freshBoost: 0, idfWeight, noveltyWeight }) || scoreSort(a, b))
    .slice(0, 2);
  for (const item of architecture) addUnique(selected, selectedIds, item);

  const caps = new Map([["L1", 3], ["L2", 1], ["L4", 1], ["Skill", 1]]);
  const counts = new Map([...caps.keys()].map((kind) => [kind, 0]));
  for (let slot = 0; slot < 4; slot += 1) {
    const candidates = [];
    for (const [kind, cap] of caps) {
      if ((counts.get(kind) ?? 0) >= cap) continue;
      for (const item of groups.get(kind) ?? []) {
        if (selectedIds.has(item.id)) continue;
        candidates.push({
          item,
          kind,
          utility: signalUtility(item, groups, items, selected, { freshBoost, idfWeight, noveltyWeight })
        });
      }
    }
    candidates.sort((a, b) => b.utility - a.utility || admissionRelevanceSort(a.item, b.item));
    const winner = candidates[0];
    if (!winner) break;
    addUnique(selected, selectedIds, winner.item);
    counts.set(winner.kind, (counts.get(winner.kind) ?? 0) + 1);
  }
  return selected.sort(scoreSort);
}

function plannerRecencyTopK(items, { freshBoost, l2RecencyWeight }) {
  const groups = groupByKind(items);
  const selected = [];
  const selectedIds = new Set();

  const l3 = groups.get("L3")?.[0];
  if (l3) addUnique(selected, selectedIds, l3);
  for (const item of [...(groups.get("architecture") ?? [])].sort(admissionRelevanceSort).slice(0, 2)) {
    addUnique(selected, selectedIds, item);
  }

  const caps = new Map([["L1", 3], ["L2", 1], ["L4", 1], ["Skill", 1]]);
  const candidates = [];
  for (const [kind, cap] of caps) {
    const group = groups.get(kind) ?? [];
    const recency = recencyRanks(group);
    for (const item of group) {
      const normalized = normalizedKindScore(item, groups);
      const lexicalBonus = Math.min(0.20, matchedTermCount(item) * 0.04);
      const fresh = kind === "L1" ? freshBoost : 0;
      const timelineRecency = kind === "L2" ? (recency.get(item.id) ?? 0) * l2RecencyWeight : 0;
      candidates.push({ item, kind, cap, utility: normalized + lexicalBonus + fresh + timelineRecency });
    }
  }
  const counts = new Map([...caps.keys()].map((kind) => [kind, 0]));
  for (let slot = 0; slot < 4; slot += 1) {
    const winner = candidates
      .filter(({ item, kind, cap }) => !selectedIds.has(item.id) && (counts.get(kind) ?? 0) < cap)
      .sort((a, b) => b.utility - a.utility || admissionRelevanceSort(a.item, b.item))[0];
    if (!winner) break;
    addUnique(selected, selectedIds, winner.item);
    counts.set(winner.kind, (counts.get(winner.kind) ?? 0) + 1);
  }
  return selected.sort(scoreSort);
}

function plannerTemporalTopK(items, query, freshBoost) {
  const groups = groupByKind(items);
  const selected = [];
  const selectedIds = new Set();

  const l3 = groups.get("L3")?.[0];
  if (l3) addUnique(selected, selectedIds, l3);
  for (const item of [...(groups.get("architecture") ?? [])].sort(admissionRelevanceSort).slice(0, 2)) {
    addUnique(selected, selectedIds, item);
  }

  const temporalIntent = /\b(?:latest|recent|today|newest)\b|最新|最近|刚刚|刚才/u.test(query);
  const groupsForSupport = new Map(groups);
  if (temporalIntent) {
    const l2 = groups.get("L2") ?? [];
    const dated = [...l2]
      .filter((item) => Number.isFinite(Date.parse(item.updatedAt ?? item.createdAt ?? "")))
      .sort((a, b) => Date.parse(b.updatedAt ?? b.createdAt) - Date.parse(a.updatedAt ?? a.createdAt));
    const maxMatched = Math.max(0, ...dated.map((item) => matchedTermCount(item)));
    const relevanceFloor = maxMatched > 0
      ? Math.max(2, Math.ceil(maxMatched * 0.5))
      : Number.POSITIVE_INFINITY;
    const eligible = dated.filter((item) => matchedTermCount(item) >= relevanceFloor);
    if (eligible.length > 0) groupsForSupport.set("L2", [eligible[0]]);
  }

  const caps = new Map([["L1", 3], ["L2", 1], ["L4", 1], ["Skill", 1]]);
  const supportingCandidates = [];
  for (const [kind, cap] of caps) {
    for (const item of (groupsForSupport.get(kind) ?? []).slice(0, Math.max(cap, 3))) {
      const normalized = normalizedKindScore(item, groups);
      const lexicalBonus = Math.min(0.25, matchedTermCount(item) * 0.05);
      const authorityBonus = kind === "L1" ? freshBoost : kind === "L2" ? 0.05 : 0;
      supportingCandidates.push({ item, kind, cap, utility: normalized + lexicalBonus + authorityBonus });
    }
  }
  const counts = new Map([...caps.keys()].map((kind) => [kind, 0]));
  for (let slot = 0; slot < 4; slot += 1) {
    const winner = supportingCandidates
      .filter(({ item, kind, cap }) => !selectedIds.has(item.id) && (counts.get(kind) ?? 0) < cap)
      .sort((a, b) => b.utility - a.utility || admissionRelevanceSort(a.item, b.item))[0];
    if (!winner) break;
    addUnique(selected, selectedIds, winner.item);
    counts.set(winner.kind, (counts.get(winner.kind) ?? 0) + 1);
  }
  return selected.sort(scoreSort);
}

function recencyRanks(items) {
  const dated = items
    .map((item) => ({ item, time: Date.parse(item.updatedAt ?? item.createdAt ?? "") }))
    .filter((entry) => Number.isFinite(entry.time))
    .sort((a, b) => b.time - a.time);
  const ranks = new Map();
  if (dated.length === 0) return ranks;
  const denominator = Math.max(1, dated.length - 1);
  dated.forEach((entry, index) => ranks.set(entry.item.id, 1 - index / denominator));
  return ranks;
}

function signalUtility(item, groups, allItems, alreadySelected, { freshBoost, idfWeight, noveltyWeight }) {
  const normalized = normalizedKindScore(item, groups);
  const idf = matchedRarityScore(item, allItems);
  const novelty = alreadySelected.length === 0 ? 1 : 1 - Math.max(...alreadySelected.map((other) => tokenJaccard(item.content, other.content)));
  const authority = itemKind(item) === "L1" ? freshBoost : itemKind(item) === "L2" ? 0.04 : 0;
  return normalized * 0.55 + idf * idfWeight + novelty * noveltyWeight + authority;
}

function matchedRarityScore(item, allItems) {
  const terms = item.provenance?.retrievalV1?.matchedTerms;
  if (!Array.isArray(terms) || terms.length === 0) return 0;
  const unique = [...new Set(terms)];
  const score = unique.reduce((sum, term) => {
    const df = allItems.filter((candidate) => {
      const candidateTerms = candidate.provenance?.retrievalV1?.matchedTerms;
      return Array.isArray(candidateTerms) && candidateTerms.includes(term);
    }).length;
    return sum + Math.log((allItems.length + 1) / (df + 1));
  }, 0);
  return score / Math.max(1, unique.length);
}

function tokenJaccard(left, right) {
  const a = new Set(tokenizeRetrievalText(left));
  const b = new Set(tokenizeRetrievalText(right));
  if (a.size === 0 || b.size === 0) return 0;
  let overlap = 0;
  for (const term of a) if (b.has(term)) overlap += 1;
  return overlap / (a.size + b.size - overlap);
}

function addUnique(selected, selectedIds, item) {
  if (!item || selectedIds.has(item.id)) return;
  selected.push(item);
  selectedIds.add(item.id);
}

function matchedTermCount(item) {
  const value = item.provenance?.retrievalV1?.matchedTerms;
  return Array.isArray(value) ? value.length : 0;
}

function admissionRelevanceSort(a, b) {
  return matchedTermCount(b) - matchedTermCount(a) || scoreSort(a, b);
}

function supportingAdmissionUtility(item) {
  const match = matchedTermCount(item);
  const score = Math.max(0, item.evalScore ?? 0);
  const freshBoost = itemKind(item) === "L1" ? 0.35 : 0;
  return match * 0.3 + score + freshBoost;
}

function groupByKind(items) {
  const groups = new Map(kindOrder().map((kind) => [kind, []]));
  for (const item of items) {
    const kind = itemKind(item);
    if (!groups.has(kind)) groups.set(kind, []);
    groups.get(kind).push(item);
  }
  for (const group of groups.values()) group.sort(scoreSort);
  return groups;
}

function kindOrder() {
  return ["L3", "architecture", "L1", "L2", "L4", "Skill", "other"];
}

function fillToMinimum(selected, selectedIds, items, minimum, maxLimit) {
  if (selected.length >= minimum) return;
  for (const item of [...items].sort(scoreSort)) {
    if (selectedIds.has(item.id)) continue;
    selected.push(item);
    selectedIds.add(item.id);
    if (selected.length >= minimum || selected.length >= maxLimit) break;
  }
}

function softmaxWeights(scores, temperature) {
  if (scores.length === 0) return [];
  const max = Math.max(...scores);
  const weights = scores.map((score) => Math.exp((score - max) / Math.max(0.01, temperature)));
  const sum = weights.reduce((total, value) => total + value, 0) || 1;
  return weights.map((value) => value / sum);
}

function normalizedEntropy(weights) {
  if (weights.length <= 1) return 0;
  const entropy = -weights.reduce((sum, value) => sum + (value > 0 ? value * Math.log(value) : 0), 0);
  return entropy / Math.log(weights.length);
}

function admissionCost(item) {
  return Math.max(120, Math.min(900, bytes(item.content)));
}

function normalizedKindScore(item, groups) {
  const group = groups.get(itemKind(item)) ?? [item];
  const top = Math.max(0.0001, group[0]?.evalScore ?? 0);
  return Math.max(0, item.evalScore ?? 0) / top;
}

function stageSnapshot(state, scenario) {
  const ids = new Set(state.items.map((item) => item.id));
  const critical = scenario.groundTruth.criticalIds;
  return {
    items: state.items.length,
    bytes: totalBytes(state.items),
    critical_recall: ratio(critical.filter((id) => ids.has(id)).length, critical.length)
  };
}

function summarize(group, meta = {}) {
  const metric = (key) => mean(group.map((row) => row[key]));
  const minimum = (key) => group.length ? Math.min(...group.map((row) => row[key])) : 0;
  return {
    ...meta,
    runs: group.length,
    critical_recall: metric("critical_recall"),
    role_coverage: metric("role_coverage"),
    worst_case_critical_recall: minimum("critical_recall"),
    worst_case_role_coverage: minimum("role_coverage"),
    critical_role_full_pass_rate: ratio(
      group.filter((row) => row.critical_recall === 1 && row.role_coverage === 1).length,
      group.length
    ),
    context_recall: metric("context_recall"),
    context_precision: metric("context_precision"),
    noise_sensitivity: 1 - metric("context_precision"),
    ndcg_at_8: metric("ndcg_at_8"),
    critical_mrr: metric("critical_mrr"),
    tkp_input_critical_recall: metric("tkp_input_critical_recall"),
    topk_input_critical_recall: metric("topk_input_critical_recall"),
    budget_input_critical_recall: metric("budget_input_critical_recall"),
    topk_critical_loss: metric("topk_critical_loss"),
    tkp_critical_loss: metric("tkp_critical_loss"),
    budget_critical_loss: metric("budget_critical_loss"),
    avg_tkp_input_items: metric("tkp_input_items"),
    avg_tkp_input_bytes: metric("tkp_input_bytes"),
    avg_topk_output_items: metric("topk_output_items"),
    avg_topk_output_bytes: metric("topk_output_bytes"),
    avg_final_context_bytes: metric("final_context_bytes"),
    avg_final_items: metric("final_items")
  };
}

function hydrateFromScenario(scenario) {
  const byRef = new Map();
  for (const hit of scenario.projectHits) {
    if (hit.evidenceRef) byRef.set(hit.evidenceRef, hit.snippet);
  }
  return async (ref) => byRef.has(ref) ? { content: byRef.get(ref) } : null;
}

function hit(id, layer, score, snippet, evidenceRef, extra = {}) {
  return {
    id, kind: "eval", memoryLayer: layer, status: "active", snippet, score,
    tags: [`project:memhub`, `artifact:${layer.toLowerCase()}`], source: "search",
    ...(evidenceRef ? { evidenceRef } : {}),
    ...extra
  };
}

function item(id, layer, content, { scope = "project", source = "memmy-memory", authority = "remembered", evalScore } = {}) {
  return {
    id, content, authority, scope, source,
    ...(Number.isFinite(evalScore) ? { evalScore } : {}),
    ...(scope === "project" ? { projectId: "memhub" } : {}),
    provenance: { memoryLayer: layer, retrievalV1: { matchedTerms: tokenizeRetrievalText(content).slice(0, 8) } }
  };
}

function architecture(id, content, evalScore) {
  return {
    id, content, authority: "authoritative", scope: "project", source: "project-architecture", projectId: "memhub",
    ...(Number.isFinite(evalScore) ? { evalScore } : {})
  };
}

function skill(id, content, evalScore) {
  return item(id, "Skill", content, { scope: "capability", evalScore });
}

function scenarioCurrentTruthTail() {
  const query = "top k retrieval current truth ranking";
  return scenario({
    id: "current_truth_tail",
    description: "A lower-ranked L3 Current Truth competes with several lexically strong L2 items; tests pre-TKP Top-K loss.",
    query,
    budgetBytes: 5_000,
    itemBytes: 1_200,
    projectHits: [
      hit("l2-a", "L2", 1.8, repeat("top k retrieval ranking benchmark history ", 20), "l2:l2-a:r1"),
      hit("l2-b", "L2", 1.6, repeat("top k retrieval ranking prior experiment ", 20), "l2:l2-b:r1"),
      hit("l2-c", "L2", 1.4, repeat("retrieval ranking top k previous result ", 20), "l2:l2-c:r1"),
      hit("l2-d", "L2", 1.2, repeat("retrieval ranking tuning notes ", 20), "l2:l2-d:r1"),
      hit("l3-truth", "L3", 0.42, "# Current Truth\nTop K is only an early recall bound; project Current Truth must be protected before final context selection.", "l3:l3-truth:r1"),
      hit("l2-e", "L2", 0.6, "older unrelated ranking note", "l2:l2-e:r1")
    ],
    architectureItems: [], globalItems: [], skillItems: [],
    groundTruth: {
      grades: { "l3-truth": 3, "l2-a": 1, "l2-b": 1 },
      criticalIds: ["l3-truth"], roles: { "l3-truth": "L3" }
    }
  });
}

function scenarioArchitectureBudget() {
  const query = "retrieval decision trace architecture cutoff";
  return scenario({
    id: "architecture_budget_pressure",
    description: "A relevant second architecture object is behind a large first architecture object and can be lost when byte budget runs before TKP.",
    query,
    budgetBytes: 2_400,
    itemBytes: 1_000,
    projectHits: [
      hit("l3-main", "L3", 1.1, repeat("# Project Current Truth\nretrieval observability rules and runtime constraints. ", 18), "l3:l3-main:r1"),
      hit("l2-history", "L2", 0.8, repeat("retrieval tracing history and previous diagnostics. ", 12), "l2:l2-history:r1")
    ],
    architectureItems: [
      architecture("arch-general", repeat("# General Runtime\ninstallation deployment gateway unrelated details. ", 18)),
      architecture("arch-trace", "# Retrieval Decision Trace\nThe architecture requires stage-by-stage cutoff reasons, candidate survival and context-budget decisions."),
      architecture("arch-extra", "# Other\nUnrelated architecture appendix.")
    ],
    globalItems: [item("l4-pref", "L4", repeat("Stable preference for evidence backed verification. ", 12), { scope: "global" })],
    skillItems: [skill("skill-audit", repeat("Skill candidate: audit retrieval trace and explain cutoff. ", 8))],
    groundTruth: {
      grades: { "l3-main": 3, "arch-trace": 3, "l2-history": 1, "skill-audit": 1 },
      criticalIds: ["l3-main", "arch-trace"], roles: { "l3-main": "L3", "arch-trace": "architecture" }
    }
  });
}

function scenarioMixedRoles() {
  const query = "memhub retrieval top k turn knowledge plan evidence workflow";
  return scenario({
    id: "mixed_roles",
    description: "Balanced query needs Current Truth, architecture, chronology, recent evidence, preference and one workflow.",
    query,
    budgetBytes: 4_500,
    itemBytes: 1_100,
    projectHits: [
      hit("l3-mixed", "L3", 1.0, "# Rules\nTurn Knowledge Plan must preserve project Current Truth while retrieval stays bounded.", "l3:l3-mixed:r1"),
      hit("l1-recent", "L1", 1.3, "User: compare Top K and TKP order.\nAssistant: run offline experiments and do not modify production Core.", "l1:l1-recent"),
      hit("l2-mixed", "L2", 0.9, "# Timeline\nRetrieval Decision Trace was implemented locally and has not been deployed.", "l2:l2-mixed:r1"),
      hit("noise-mixed", "L2", 1.5, repeat("retrieval top k turn knowledge plan keyword noise ", 20), "l2:noise-mixed:r1")
    ],
    architectureItems: [architecture("arch-mixed", "# Retrieval Architecture\nProduction Core is immutable during offline comparison; only source/test harnesses may change.")],
    globalItems: [item("l4-mixed", "L4", "Prefer evidence-backed verification and minimal sufficient architecture.", { scope: "global" })],
    skillItems: [skill("skill-mixed", "Skill candidate: retrieval audit workflow with golden cases and replay metrics.")],
    groundTruth: {
      grades: { "l3-mixed": 3, "arch-mixed": 3, "l1-recent": 2, "l2-mixed": 2, "l4-mixed": 1, "skill-mixed": 1 },
      criticalIds: ["l3-mixed", "arch-mixed", "l1-recent"],
      roles: { "l3-mixed": "L3", "arch-mixed": "architecture", "l1-recent": "L1" }
    }
  });
}

function scenarioDistractorSwarm() {
  const query = "retrieval top k cutoff context budget";
  const distractors = Array.from({ length: 14 }, (_, index) =>
    hit(`noise-${index + 1}`, "L2", 1.7 - index * 0.04, repeat(`retrieval top k cutoff context budget duplicate note ${index + 1} `, 8), `l2:noise-${index + 1}:r1`)
  );
  return scenario({
    id: "distractor_swarm",
    description: "Many superficially relevant chronology items compete with one critical L3 and one architecture constraint.",
    query,
    budgetBytes: 4_000,
    itemBytes: 1_000,
    projectHits: [
      ...distractors,
      hit("l3-swarm", "L3", 0.38, "# Current Truth\nDo not let a swarm of similar chronology items suppress the single authoritative project rule.", "l3:l3-swarm:r1")
    ],
    architectureItems: [architecture("arch-swarm", "# Context Selection\nRequired knowledge roles must survive before supporting chronology consumes the context budget.")],
    globalItems: [], skillItems: [],
    groundTruth: {
      grades: { "l3-swarm": 3, "arch-swarm": 3, "noise-1": 1, "noise-2": 1 },
      criticalIds: ["l3-swarm", "arch-swarm"], roles: { "l3-swarm": "L3", "arch-swarm": "architecture" }
    }
  });
}

function scenarioFreshEvidenceTail() {
  const query = "latest retrieval decision trace change not deployed";
  return scenario({
    id: "fresh_l1_tail",
    description: "Fresh undistilled L1 is critical but trails several semantically similar L2 notes.",
    query,
    budgetBytes: 3_600,
    itemBytes: 900,
    projectHits: [
      hit("old-l2-1", "L2", 1.5, repeat("retrieval decision trace change deployment historical note ", 15), "l2:old-l2-1:r1"),
      hit("old-l2-2", "L2", 1.4, repeat("retrieval decision trace not deployed previous state ", 15), "l2:old-l2-2:r1"),
      hit("old-l2-3", "L2", 1.3, repeat("latest retrieval trace plan historical state ", 12), "l2:old-l2-3:r1"),
      hit("l1-fresh", "L1", 0.45, "User: continue the expanded order experiment. Assistant: keep production Core untouched and compare all operator orders.", "l1:l1-fresh"),
      hit("l3-fresh", "L3", 0.7, "# Current Truth\nProduction runtime remains unchanged while retrieval experiments run offline.", "l3:l3-fresh:r1")
    ],
    architectureItems: [], globalItems: [], skillItems: [],
    groundTruth: {
      grades: { "l1-fresh": 3, "l3-fresh": 3, "old-l2-1": 1 },
      criticalIds: ["l1-fresh", "l3-fresh"],
      roles: { "l1-fresh": "L1", "l3-fresh": "L3" }
    }
  });
}

function scenarioSkillSwarm() {
  const query = "retrieval audit workflow current truth architecture";
  const skills = Array.from({ length: 8 }, (_, index) => skill(
    `skill-noise-${index + 1}`,
    repeat(`Skill candidate retrieval audit workflow helper ${index + 1}. `, 8),
    0.95 - index * 0.04
  ));
  return scenario({
    id: "skill_swarm",
    description: "High-scoring workflow candidates test whether a global TopK starves factual Current Truth and Architecture.",
    query,
    budgetBytes: 3_200,
    itemBytes: 900,
    projectHits: [
      hit("l3-skill-swarm", "L3", 0.65, "# Current Truth\nSkills are procedures and must not displace project facts.", "l3:l3-skill-swarm:r1"),
      hit("l2-skill-history", "L2", 0.75, "# Timeline\nRetrieval audit workflow experiments were introduced after trace instrumentation.", "l2:l2-skill-history:r1")
    ],
    architectureItems: [architecture("arch-skill-swarm", "# Boundary\nSkill candidates are orthogonal capability context, not project Current Truth.", 0.6)],
    globalItems: [], skillItems: skills,
    groundTruth: {
      grades: { "l3-skill-swarm": 3, "arch-skill-swarm": 3, "l2-skill-history": 1, "skill-noise-1": 1 },
      criticalIds: ["l3-skill-swarm", "arch-skill-swarm"],
      roles: { "l3-skill-swarm": "L3", "arch-skill-swarm": "architecture" }
    }
  });
}

function scenarioLongObjectBudget() {
  const query = "current truth retrieval cutoff reason";
  return scenario({
    id: "long_object_budget",
    description: "A long relevant object can consume byte budget before other critical roles; tests TKP passage extraction before Budget.",
    query,
    budgetBytes: 2_200,
    itemBytes: 1_600,
    projectHits: [
      hit("l3-long", "L3", 1.1, `${repeat("# Background\nunrelated project history and verbose notes. ", 45)}\n# Current Truth\nretrieval cutoff reason must remain explainable and evidence-backed.`, "l3:l3-long:r1"),
      hit("l1-long", "L1", 0.8, "User: do not change running Core while comparing retrieval order.", "l1:l1-long")
    ],
    architectureItems: [architecture("arch-long", "# Retrieval Boundary\nThe production Core is unchanged; selection experiments are offline only.", 0.66)],
    globalItems: [], skillItems: [],
    groundTruth: {
      grades: { "l3-long": 3, "arch-long": 3, "l1-long": 2 },
      criticalIds: ["l3-long", "arch-long", "l1-long"],
      roles: { "l3-long": "L3", "arch-long": "architecture", "l1-long": "L1" }
    }
  });
}

function scenarioLargeCandidatePool() {
  const query = "retrieval top k current truth architecture fresh evidence";
  const history = Array.from({ length: 42 }, (_, index) => hit(
    `large-l2-${index + 1}`,
    "L2",
    1.95 - index * 0.025,
    repeat(`retrieval top k current truth architecture historical note ${index + 1} `, 5),
    `l2:large-l2-${index + 1}:r1`
  ));
  return scenario({
    id: "large_candidate_pool",
    description: "A 50-item-class candidate pool exposes whether large K values improve recall or merely feed more noise into later stages.",
    query,
    budgetBytes: 5_000,
    itemBytes: 1_000,
    projectHits: [
      ...history,
      hit("large-l1-a", "L1", 0.58, "User: production Core stays unchanged. Assistant: run expanded offline retrieval experiments.", "l1:large-l1-a"),
      hit("large-l1-b", "L1", 0.54, "User: compare TKP limits and larger K. Assistant: preserve critical knowledge before final budget.", "l1:large-l1-b"),
      hit("large-l3", "L3", 0.36, "# Current Truth\nA larger K is useful only when downstream selection protects authoritative and fresh knowledge.", "l3:large-l3:r1")
    ],
    architectureItems: [
      architecture("large-arch-a", "# Retrieval Boundary\nCritical architecture constraints must survive candidate expansion.", 0.44),
      architecture("large-arch-b", "# Retrieval TKP Boundary\nretrieval TKP must see enough candidates before irreversible final packing.", 0.41)
    ],
    globalItems: [item("large-l4", "L4", "Prefer evidence-backed optimization rather than blindly increasing K.", { scope: "global", evalScore: 0.33 })],
    skillItems: [skill("large-skill", "Skill candidate: retrieval replay and trace diagnosis.", 0.39)],
    groundTruth: {
      grades: {
        "large-l3": 3,
        "large-arch-a": 3,
        "large-arch-b": 3,
        "large-l1-a": 2,
        "large-l1-b": 2,
        "large-l4": 1,
        "large-skill": 1,
        "large-l2-1": 1,
        "large-l2-2": 1
      },
      criticalIds: ["large-l3", "large-arch-a", "large-arch-b", "large-l1-a", "large-l1-b"],
      roles: {
        "large-l3": "L3",
        "large-arch-a": "architecture",
        "large-arch-b": "architecture",
        "large-l1-a": "L1",
        "large-l1-b": "L1"
      }
    }
  });
}

function scenarioDeepTailCritical() {
  const query = "retrieval decision current truth latest evidence";
  const distractors = Array.from({ length: 48 }, (_, index) => hit(
    `tail-noise-${index + 1}`,
    "L2",
    2.1 - index * 0.02,
    repeat(`retrieval decision current truth latest evidence historical distractor ${index + 1} `, 4),
    `l2:tail-noise-${index + 1}:r1`
  ));
  return scenario({
    id: "deep_tail_critical",
    description: "Critical L3 and L1 live deep in a 50-hit project lane; tests K saturation and whether structured TopK can avoid K≈50 brute force.",
    query,
    budgetBytes: 4_200,
    itemBytes: 950,
    projectHits: [
      ...distractors,
      hit("tail-l1", "L1", 0.24, "User: latest requirement is to keep production Core unchanged while tuning TKP.", "l1:tail-l1"),
      hit("tail-l3", "L3", 0.18, "# Current Truth\nDo not solve low recall by flooding the final context with every historical candidate.", "l3:tail-l3:r1")
    ],
    architectureItems: [architecture("tail-arch", "# Retrieval Design\nUse structure-aware admission before expensive knowledge orchestration.", 0.28)],
    globalItems: [],
    skillItems: [],
    groundTruth: {
      grades: { "tail-l3": 3, "tail-l1": 3, "tail-arch": 3, "tail-noise-1": 1 },
      criticalIds: ["tail-l3", "tail-l1", "tail-arch"],
      roles: { "tail-l3": "L3", "tail-l1": "L1", "tail-arch": "architecture" }
    }
  });
}

function scenarioMultiArchitectureCritical() {
  const query = "retrieval architecture admission current truth routing boundary";
  return scenario({
    id: "multi_architecture_critical",
    description: "Two independently critical Architecture objects plus L3 must survive dynamic admission; catches one-per-kind over-pruning.",
    query,
    budgetBytes: 4_200,
    itemBytes: 950,
    projectHits: [
      hit("ma-l3", "L3", 0.62, "# Current Truth\nRetrieval admission must preserve authoritative project constraints.", "l3:ma-l3:r1"),
      ...Array.from({ length: 10 }, (_, index) => hit(
        `ma-noise-${index + 1}`,
        "L2",
        1.45 - index * 0.05,
        repeat(`retrieval architecture admission routing historical noise ${index + 1} `, 4),
        `l2:ma-noise-${index + 1}:r1`
      ))
    ],
    architectureItems: [
      architecture("ma-arch-routing", "# Routing Boundary\nretrieval routing must keep one canonical project scope and reject cross-project business memory.", 0.36),
      architecture("ma-arch-budget", "# Context Boundary\nretrieval admission must preserve authoritative architecture before final context budget packing.", 0.34),
      architecture("ma-arch-noise", "# Deployment Appendix\nUnrelated architecture deployment appendix.", 0.72)
    ],
    globalItems: [], skillItems: [],
    groundTruth: {
      grades: { "ma-l3": 3, "ma-arch-routing": 3, "ma-arch-budget": 3, "ma-noise-1": 1 },
      criticalIds: ["ma-l3", "ma-arch-routing", "ma-arch-budget"],
      roles: { "ma-l3": "L3", "ma-arch-routing": "architecture", "ma-arch-budget": "architecture" }
    }
  });
}

function scenarioMultiFreshL1Critical() {
  const query = "latest retrieval requirement dynamic admission production unchanged";
  const noise = Array.from({ length: 14 }, (_, index) => hit(
    `mf-noise-${index + 1}`,
    "L2",
    1.55 - index * 0.045,
    repeat(`latest retrieval requirement dynamic admission historical note ${index + 1} `, 4),
    `l2:mf-noise-${index + 1}:r1`
  ));
  return scenario({
    id: "multi_fresh_l1_critical",
    description: "Three distinct fresh L1 requirements are simultaneously critical; tests whether dynamic admission reserves enough same-kind width.",
    query,
    budgetBytes: 4_600,
    itemBytes: 950,
    projectHits: [
      ...noise,
      hit("mf-l1-a", "L1", 0.42, "User requirement: latest retrieval dynamic admission experiments must not modify production Core.", "l1:mf-l1-a"),
      hit("mf-l1-b", "L1", 0.39, "User requirement: compare dynamic admission by worst-case recall and actual candidate count.", "l1:mf-l1-b"),
      hit("mf-l1-c", "L1", 0.36, "User requirement: keep the running production runtime unchanged while testing retrieval changes offline.", "l1:mf-l1-c"),
      hit("mf-l3", "L3", 0.58, "# Current Truth\nProduction remains unchanged during retrieval admission experiments.", "l3:mf-l3:r1")
    ],
    architectureItems: [], globalItems: [], skillItems: [],
    groundTruth: {
      grades: { "mf-l3": 3, "mf-l1-a": 3, "mf-l1-b": 3, "mf-l1-c": 3, "mf-noise-1": 1 },
      criticalIds: ["mf-l3", "mf-l1-a", "mf-l1-b", "mf-l1-c"],
      roles: { "mf-l3": "L3", "mf-l1-a": "L1", "mf-l1-b": "L1", "mf-l1-c": "L1" }
    }
  });
}

function scenarioDenseCrossKindCritical() {
  const query = "retrieval current truth architecture latest evidence timeline preference workflow";
  return scenario({
    id: "dense_cross_kind_critical",
    description: "Critical knowledge spans every supported kind within current TKP capacity; tests coverage-aware dynamic admission under dense mixed intent.",
    query,
    budgetBytes: 5_600,
    itemBytes: 1_000,
    projectHits: [
      hit("dc-l3", "L3", 0.52, "# Current Truth\nretrieval current truth must survive admission.", "l3:dc-l3:r1"),
      hit("dc-l1", "L1", 0.48, "User latest evidence requires production to remain unchanged.", "l1:dc-l1"),
      hit("dc-l2", "L2", 0.44, "# Timeline\nretrieval timeline records the latest experiment sequence.", "l2:dc-l2:r1", { updatedAt: "2026-10-23T05:00:00Z" }),
      ...Array.from({ length: 12 }, (_, index) => hit(
        `dc-noise-${index + 1}`,
        "L2",
        1.6 - index * 0.05,
        repeat(`retrieval current truth timeline historical distractor ${index + 1} `, 3),
        `l2:dc-noise-${index + 1}:r1`,
        { updatedAt: `2026-09-${String(Math.max(1, 20 - index)).padStart(2, "0")}T05:00:00Z` }
      ))
    ],
    architectureItems: [
      architecture("dc-arch-a", "# Architecture Routing\nretrieval architecture defines canonical project routing.", 0.40),
      architecture("dc-arch-b", "# Architecture Budget\nretrieval architecture defines bounded context delivery.", 0.38)
    ],
    globalItems: [item("dc-l4", "L4", "Stable preference: use evidence-backed retrieval verification.", { scope: "global", evalScore: 0.35 })],
    skillItems: [skill("dc-skill", "Skill candidate: retrieval workflow for replaying golden cases.", 0.33)],
    groundTruth: {
      grades: { "dc-l3": 3, "dc-arch-a": 3, "dc-arch-b": 3, "dc-l1": 3, "dc-l2": 2, "dc-l4": 2, "dc-skill": 2 },
      criticalIds: ["dc-l3", "dc-arch-a", "dc-arch-b", "dc-l1", "dc-l2", "dc-l4", "dc-skill"],
      roles: {
        "dc-l3": "L3", "dc-arch-a": "architecture", "dc-arch-b": "architecture",
        "dc-l1": "L1", "dc-l2": "L2", "dc-l4": "L4", "dc-skill": "Skill"
      }
    }
  });
}

function scenarioTemporalChineseLatest() {
  const query = "最近 memhub retrieval 检索实验 有什么变化";
  return scenario({
    id: "temporal_chinese_latest",
    description: "Chinese temporal intent should prefer the newest relevant L2 chronology even when older history has a higher raw score.",
    query,
    budgetBytes: 3_600,
    itemBytes: 950,
    projectHits: [
      hit("tc-l3", "L3", 0.55, "# Current Truth\nLITSAN retrieval experiments remain offline and production is unchanged.", "l3:tc-l3:r1"),
      hit("tc-l2-recent", "L2", 0.38, "# 最近变化\nLITSAN retrieval 动态 admission 新增了 temporal-aware 测试。", "l2:tc-l2-recent:r1", { updatedAt: "2026-10-23T05:20:00Z" }),
      hit("tc-l2-old-1", "L2", 1.35, repeat("LITSAN retrieval 检索实验 历史记录 top k 旧结果 ", 5), "l2:tc-l2-old-1:r1", { updatedAt: "2026-09-20T05:00:00Z" }),
      hit("tc-l2-old-2", "L2", 1.20, repeat("LITSAN retrieval 检索实验 历史记录 旧架构 ", 5), "l2:tc-l2-old-2:r1", { updatedAt: "2026-08-18T05:00:00Z" })
    ],
    architectureItems: [], globalItems: [], skillItems: [],
    groundTruth: {
      grades: { "tc-l3": 3, "tc-l2-recent": 3, "tc-l2-old-1": 1 },
      criticalIds: ["tc-l3", "tc-l2-recent"],
      roles: { "tc-l3": "L3", "tc-l2-recent": "L2" }
    }
  });
}

function scenarioNonTemporalRelevantL2() {
  const query = "retrieval architecture routing rationale";
  return scenario({
    id: "non_temporal_relevant_l2",
    description: "Without temporal intent, admission must prefer topical L2 relevance rather than blindly choosing the newest chronology item.",
    query,
    budgetBytes: 3_800,
    itemBytes: 950,
    projectHits: [
      hit("nt-l3", "L3", 0.58, "# Current Truth\nretrieval architecture routing follows one canonical project.", "l3:nt-l3:r1"),
      hit("nt-l2-relevant", "L2", 0.62, "# Routing rationale\nretrieval architecture routing rejects cross-project business memory.", "l2:nt-l2-relevant:r1", { updatedAt: "2026-09-15T05:00:00Z" }),
      hit("nt-l2-newest", "L2", 1.05, "# Deployment\ncertificate rotation and tunnel packaging notes.", "l2:nt-l2-newest:r1", { updatedAt: "2026-10-23T05:25:00Z" })
    ],
    architectureItems: [architecture("nt-arch", "# Routing Boundary\nretrieval architecture keeps one canonical project scope.", 0.42)],
    globalItems: [], skillItems: [],
    groundTruth: {
      grades: { "nt-l3": 3, "nt-arch": 3, "nt-l2-relevant": 2 },
      criticalIds: ["nt-l3", "nt-arch", "nt-l2-relevant"],
      roles: { "nt-l3": "L3", "nt-arch": "architecture", "nt-l2-relevant": "L2" }
    }
  });
}

function scenarioTemporalIrrelevantNewest() {
  const query = "latest retrieval architecture change";
  return scenario({
    id: "temporal_irrelevant_newest",
    description: "Temporal intent must not let the newest but off-topic L2 beat an older strongly relevant retrieval change.",
    query,
    budgetBytes: 3_800,
    itemBytes: 950,
    projectHits: [
      hit("ti-l3", "L3", 0.54, "# Current Truth\nretrieval architecture changes remain offline until verified.", "l3:ti-l3:r1"),
      hit("ti-l2-relevant", "L2", 0.58, "# Retrieval change\nlatest retrieval architecture change introduces structure-aware admission experiments.", "l2:ti-l2-relevant:r1", { updatedAt: "2026-10-20T05:00:00Z" }),
      hit("ti-l2-newest", "L2", 0.92, "# Latest deployment note\nlatest certificate rotation completed for an unrelated tunnel.", "l2:ti-l2-newest:r1", { updatedAt: "2026-10-23T05:30:00Z" }),
      hit("ti-l2-old", "L2", 0.82, repeat("retrieval architecture historical change archive ", 5), "l2:ti-l2-old:r1", { updatedAt: "2026-09-10T05:00:00Z" })
    ],
    architectureItems: [architecture("ti-arch", "# Retrieval Architecture\nstructure-aware admission is evaluated before production changes.", 0.40)],
    globalItems: [], skillItems: [],
    groundTruth: {
      grades: { "ti-l3": 3, "ti-arch": 3, "ti-l2-relevant": 3, "ti-l2-old": 1 },
      criticalIds: ["ti-l3", "ti-arch", "ti-l2-relevant"],
      roles: { "ti-l3": "L3", "ti-arch": "architecture", "ti-l2-relevant": "L2" }
    }
  });
}

function scenarioPassageControl() {
  const query = "semantic passage selection retrieval";
  const longArch = `${repeat("# Background\nUnrelated deployment prose. ", 45)}\n# Semantic Passage Selection\nretrieval should select the bounded query-relevant passage instead of blindly copying the full object.`;
  return scenario({
    id: "passage_control",
    description: "Control case where current brief-mode passage extraction should already protect a relevant passage inside a large object.",
    query,
    budgetBytes: 3_000,
    itemBytes: 1_100,
    projectHits: [hit("l3-control", "L3", 0.9, "# Current Truth\nUse bounded semantic passage selection for large objects.", "l3:l3-control:r1")],
    architectureItems: [architecture("arch-control", longArch)],
    globalItems: [], skillItems: [],
    groundTruth: {
      grades: { "l3-control": 3, "arch-control": 3 },
      criticalIds: ["l3-control", "arch-control"], roles: { "l3-control": "L3", "arch-control": "architecture" }
    }
  });
}

function expandScenario(base) {
  const mutateScores = (value, amplitude) => ({
    ...structuredClone(value),
    projectHits: value.projectHits.map((candidate) => ({
      ...candidate,
      score: candidate.score * (1 + deterministicJitter(candidate.id) * amplitude)
    })),
    globalItems: value.globalItems.map((candidate) => jitterItem(candidate, amplitude)),
    skillItems: value.skillItems.map((candidate) => jitterItem(candidate, amplitude)),
    architectureItems: value.architectureItems.map((candidate) => jitterItem(candidate, amplitude))
  });
  return [
    { ...structuredClone(base), id: `${base.id}__base` },
    { ...structuredClone(base), id: `${base.id}__tight_budget`, budgetBytes: Math.max(900, Math.round(base.budgetBytes * 0.82)) },
    { ...mutateScores(base, 0.15), id: `${base.id}__score_jitter` },
    {
      ...mutateScores(base, 0.15),
      id: `${base.id}__tight_jitter`,
      budgetBytes: Math.max(900, Math.round(base.budgetBytes * 0.82))
    }
  ];
}

function expandDynamicScenario(base) {
  const variants = [
    { ...structuredClone(base), id: `${base.id}__base` },
    { ...structuredClone(base), id: `${base.id}__tight_budget`, budgetBytes: Math.max(800, Math.round(base.budgetBytes * 0.72)) },
    { ...mutateScenarioScores(base, 0.08, "jitter-a"), id: `${base.id}__jitter08_a` },
    { ...mutateScenarioScores(base, 0.18, "jitter-b"), id: `${base.id}__jitter18_b` },
    { ...mutateScenarioScores(base, 0.30, "jitter-c"), id: `${base.id}__jitter30_c` },
    { ...mutateScenarioScores(base, 0.18, "jitter-d"), id: `${base.id}__tight_jitter18`, budgetBytes: Math.max(800, Math.round(base.budgetBytes * 0.72)) },
    { ...calibrationShift(base, "history-heavy"), id: `${base.id}__history_heavy_scores` },
    { ...calibrationShift(base, "capability-heavy"), id: `${base.id}__capability_heavy_scores` },
    { ...flattenScenarioScores(base, 0.35), id: `${base.id}__flat_scores` }
  ];
  return variants;
}

function mutateScenarioScores(value, amplitude, salt) {
  const cloned = structuredClone(value);
  cloned.projectHits = cloned.projectHits.map((candidate) => ({
    ...candidate,
    score: candidate.score * (1 + deterministicJitter(`${salt}:${candidate.id}`) * amplitude)
  }));
  cloned.globalItems = cloned.globalItems.map((candidate) => jitterItemSeeded(candidate, amplitude, salt));
  cloned.skillItems = cloned.skillItems.map((candidate) => jitterItemSeeded(candidate, amplitude, salt));
  cloned.architectureItems = cloned.architectureItems.map((candidate) => jitterItemSeeded(candidate, amplitude, salt));
  return cloned;
}

function calibrationShift(value, mode) {
  const cloned = structuredClone(value);
  const multiplier = (kind) => {
    if (mode === "history-heavy") {
      if (kind === "L2") return 1.35;
      if (kind === "L3") return 0.72;
      if (kind === "L1") return 0.82;
      if (kind === "architecture") return 0.78;
      if (kind === "Skill") return 1.15;
    } else {
      if (kind === "Skill") return 1.45;
      if (kind === "L4") return 1.25;
      if (kind === "L3") return 0.78;
      if (kind === "architecture") return 0.82;
    }
    return 1;
  };
  cloned.projectHits = cloned.projectHits.map((candidate) => ({ ...candidate, score: candidate.score * multiplier(candidate.memoryLayer) }));
  cloned.globalItems = cloned.globalItems.map((candidate) => scaleEvalItem(candidate, multiplier("L4")));
  cloned.skillItems = cloned.skillItems.map((candidate) => scaleEvalItem(candidate, multiplier("Skill")));
  cloned.architectureItems = cloned.architectureItems.map((candidate) => scaleEvalItem(candidate, multiplier("architecture")));
  return cloned;
}

function flattenScenarioScores(value, factor) {
  const cloned = structuredClone(value);
  const projectMean = mean(cloned.projectHits.map((candidate) => candidate.score));
  cloned.projectHits = cloned.projectHits.map((candidate) => ({
    ...candidate,
    score: projectMean + (candidate.score - projectMean) * factor
  }));
  for (const key of ["globalItems", "skillItems", "architectureItems"]) {
    const scored = cloned[key].filter((candidate) => Number.isFinite(candidate.evalScore));
    const average = mean(scored.map((candidate) => candidate.evalScore));
    cloned[key] = cloned[key].map((candidate) => Number.isFinite(candidate.evalScore)
      ? { ...candidate, evalScore: average + (candidate.evalScore - average) * factor }
      : candidate);
  }
  return cloned;
}

function jitterItemSeeded(item, amplitude, salt) {
  const cloned = structuredClone(item);
  if (Number.isFinite(cloned.evalScore)) cloned.evalScore *= 1 + deterministicJitter(`${salt}:${cloned.id}`) * amplitude;
  return cloned;
}

function scaleEvalItem(item, factor) {
  const cloned = structuredClone(item);
  if (Number.isFinite(cloned.evalScore)) cloned.evalScore *= factor;
  return cloned;
}

function jitterItem(item, amplitude) {
  const cloned = structuredClone(item);
  if (Number.isFinite(cloned.evalScore)) cloned.evalScore *= 1 + deterministicJitter(cloned.id) * amplitude;
  return cloned;
}

function deterministicJitter(value) {
  let hash = 2166136261;
  for (const char of value) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return ((hash >>> 0) / 0xffffffff) * 2 - 1;
}

function scenario(value) { return value; }
function resolvedProject() { return { projectId: "memhub", source: "explicit_project", recallScope: "global_and_project", candidates: ["memhub"], evidence: ["offline-eval"] }; }
function cloneItem(value) { return structuredClone(value); }
function repeat(value, count) { return value.repeat(count); }
function bytes(value) { return Buffer.byteLength(value, "utf8"); }
function totalBytes(items) { return items.reduce((sum, item) => sum + bytes(item.content), 0); }
function ratio(a, b) { return b > 0 ? a / b : 1; }
function mean(values) { return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0; }
function f(value, digits = 3) { return Number(value.toFixed(digits)); }
function isProjectMemory(item) { return item.scope === "project" && item.source !== "project-architecture"; }
function scoreSort(a, b) { return (b.evalScore ?? 0) - (a.evalScore ?? 0) || a.id.localeCompare(b.id); }
function roleRank(role) { return role === "required" ? 0 : role === "supporting" ? 1 : 2; }
function itemKind(item) { return item.source === "project-architecture" ? "architecture" : item.provenance?.memoryLayer ?? "other"; }

function reciprocalRank(ids, relevant) {
  const index = ids.findIndex((id) => relevant.has(id));
  return index < 0 ? 0 : 1 / (index + 1);
}

function ndcg(ids, grades, k) {
  const dcg = ids.slice(0, k).reduce((sum, id, index) => sum + gain(grades[id] ?? 0) / Math.log2(index + 2), 0);
  const ideal = Object.values(grades).sort((a, b) => b - a).slice(0, k)
    .reduce((sum, grade, index) => sum + gain(grade) / Math.log2(index + 2), 0);
  return ideal > 0 ? dcg / ideal : 1;
}

function gain(grade) { return Math.pow(2, grade) - 1; }
