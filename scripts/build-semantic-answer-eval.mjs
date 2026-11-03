#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const MATRIX = resolve(ROOT, ".review-runtime", "shared-admission-tkp-matrix-20261023.json");
const OUT = resolve(ROOT, ".review-runtime", "semantic-answer-eval");

const caseSpecs = [
  {
    id: "factual",
    gold: "The current retrieval rule gives Current Truth authority over supporting history; historical/global ranking must not override current truth."
  },
  {
    id: "temporal",
    gold: "The latest experiment added shared allocation metrics / shared Admission+TKP evaluation, while production Core remained unchanged."
  },
  {
    id: "architecture",
    gold: "Use typed Admission before TKP and role-aware final packing that protects required knowledge; keep the architecture minimal and avoid parallel memory systems."
  },
  {
    id: "workflow",
    gold: "Test with golden-case replay and perturbation/counterexample testing while keeping production Core unchanged."
  },
  {
    id: "provenance",
    gold: "The latest evidence was missed because it did not enter the candidate pool; L1 evidence and retrieval trace/provenance should be used to diagnose the miss."
  },
  {
    id: "preference",
    gold: "Stable preferences favor evidence-backed verification and minimal sufficient architecture / minimal parallel systems."
  },
  {
    id: "mixed",
    gold: "Admission and TKP share one demand profile; authority hierarchy remains protected; replay traces/compare policies is the relevant workflow; bounded exploration comes only after grounding."
  },
  {
    id: "dense_fresh",
    gold: "The latest evidence is the recent L1 shared-allocation test observations; historical L2 noise should not displace the fresh evidence, and production Core remains unchanged."
  },
  {
    id: "stale_conflict",
    gold: "The retrieval experiment is NOT deployed to production. Source tests passed, but the production runtime/release was not switched. The old note claiming deployment is stale and must not be used."
  },
  {
    id: "explore_arch",
    gold: "The main direction is shared demand for Admission and TKP. Useful alternatives include uncertainty-sensitive widening / a bounded exploration reserve after grounding; unrelated certificate deployment notes should not drive the answer."
  },
  {
    id: "narrow_distractors",
    gold: "No. Production Core has not been modified by the retrieval experiment; only source/test harnesses changed and the runtime release stayed unchanged."
  },
  {
    id: "passage_tail",
    gold: "Conditional Admission and TKP share one guarded demand profile. The key tail marker is FACT_SHARED_ALLOCATION_TAIL."
  }
];

const matrix = JSON.parse(await readFile(MATRIX, "utf8"));
const cases = caseSpecs.map((spec) => {
  const scenario = matrix.scenarios.find((item) => item.id === `${spec.id}__base` || item.baseId === spec.id && item.id?.endsWith("__base"));
  if (!scenario) throw new Error(`missing base scenario ${spec.id}`);
  const get = (strategy) => {
    const row = matrix.rows.find((item) => item.base_scenario === spec.id && item.perturbation === "base" && item.strategy === strategy);
    if (!row?.semantic_context) throw new Error(`missing semantic context ${spec.id}/${strategy}`);
    return {
      context: row.semantic_context,
      ids: row.final_ids,
      admission_items: row.admission_items,
      context_precision: row.context_precision,
      critical_recall: row.critical_recall
    };
  };
  return {
    id: spec.id,
    query: scenario.query,
    gold: spec.gold,
    fixed: get("fixed_fixed"),
    shared: get("shared_aligned_explore")
  };
});

function promptFor(lane) {
  const payload = cases.map((item) => ({
    case_id: item.id,
    question: item.query,
    context: item[lane].context
  }));
  return [
    "You are evaluating a memory-augmented assistant. Do not call tools or use external facts.",
    "For each case, answer the question using only the supplied context. If the context is insufficient, say so instead of guessing.",
    "Treat explicit Current Truth / authoritative constraints as stronger than historical notes when they conflict.",
    "For open-ended questions, you may synthesize useful alternatives that are actually supported by the context, but do not introduce unrelated ideas.",
    "Return ONLY one JSON array. Each element must be {\"case_id\": string, \"answer\": string}. Preserve the input order.",
    "CASES:",
    JSON.stringify(payload)
  ].join("\n\n");
}

await mkdir(OUT, { recursive: true });
await writeFile(resolve(OUT, "manifest.json"), JSON.stringify({ generated_at: new Date().toISOString(), cases }, null, 2) + "\n");
await writeFile(resolve(OUT, "fixed.prompt.txt"), promptFor("fixed"));
await writeFile(resolve(OUT, "shared.prompt.txt"), promptFor("shared"));
console.log(`semantic answer bundle: ${cases.length} cases`);
console.log(`saved: ${OUT}`);
