#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compareRetrievalBenchmarks, evaluateRetrievalBenchmark } from "../dist/evaluation-harness.js";

const REPO = resolve(fileURLToPath(new URL("..", import.meta.url)));
const OUTPUT = resolve(process.argv.find((arg) => arg.startsWith("--output="))?.slice("--output=".length)
  ?? join(REPO, ".review-runtime/benchmarks/memhub-core-internal-ab.json"));
const suites = [
  { id: "p0", path: join(REPO, "benchmarks/retrieval/p0-real-pipeline-suite.json") },
  { id: "chinese", path: join(REPO, "benchmarks/retrieval/memhub-core-chinese-ab-suite.json") },
  { id: "stress", path: join(REPO, ".review-runtime/benchmarks/core-order-stress-suite.json"), optional: true }
];

const availableSuites = [];
for (const suite of suites) {
  try {
    await readFile(suite.path, "utf8");
    availableSuites.push(suite);
  } catch (error) {
    if (!suite.optional) throw error;
  }
}

const results = [];
for (const suite of availableSuites) {
  const suiteJson = JSON.parse(await readFile(suite.path, "utf8"));
  const baseDir = join(REPO, ".review-runtime/benchmarks/memhub-core-internal-ab");
  await mkdir(baseDir, { recursive: true });
  const oldPath = join(baseDir, `${suite.id}-memhub-v1.json`);
  const corePath = join(baseDir, `${suite.id}-litsan-core.json`);
  await runObservationBuild(suite.path, oldPath, false);
  await runObservationBuild(suite.path, corePath, true);
  const oldObs = JSON.parse(await readFile(oldPath, "utf8"));
  const coreObs = JSON.parse(await readFile(corePath, "utf8"));
  const retrievalOld = evaluateRetrievalBenchmark(suiteJson.cases, oldObs);
  const retrievalCore = evaluateRetrievalBenchmark(suiteJson.cases, coreObs);
  const tkpOldObs = oldObs.map(tkpObservation);
  const tkpCoreObs = coreObs.map(tkpObservation);
  const tkpOld = evaluateRetrievalBenchmark(suiteJson.cases, tkpOldObs);
  const tkpCore = evaluateRetrievalBenchmark(suiteJson.cases, tkpCoreObs);
  const selection = compareSelections(oldObs, coreObs);
  const tkpSelection = compareSelections(tkpOldObs, tkpCoreObs);
  const perCase = suiteJson.cases.map((testCase, index) => caseComparison(testCase, oldObs[index], coreObs[index]));
  results.push({
    id: suite.id,
    name: suiteJson.name,
    snapshot_id: suiteJson.snapshot_id ?? null,
    source: suite.path.startsWith(join(REPO, ".review-runtime")) ? "review-runtime" : "repository",
    case_count: suiteJson.cases.length,
    retrieval: {
      memhub_v1: retrievalOld,
      memhub_core: retrievalCore,
      delta: compareRetrievalBenchmarks(retrievalOld, retrievalCore),
      selection
    },
    tkp: {
      memhub_v1: tkpOld,
      memhub_core: tkpCore,
      delta: compareRetrievalBenchmarks(tkpOld, tkpCore),
      selection: tkpSelection,
      latency_ms: {
        memhub_v1: average(oldObs.map((item) => item.tkp_latency_ms ?? 0)),
        memhub_core: average(coreObs.map((item) => item.tkp_latency_ms ?? 0))
      }
    },
    per_case: perCase,
    gate: evaluateGate(retrievalOld, retrievalCore, tkpOld, tkpCore, perCase)
  });
}

const overallGate = results.every((suite) => suite.gate.pass);
const report = {
  version: "memhub-core-internal-ab-v1",
  generated_at: new Date().toISOString(),
  comparison: "memhub_v1_vs_memhub_core_same_final_core",
  production_default_changed: false,
  suites: results,
  overall_gate: {
    pass: overallGate,
    rule: "No regression in Grounded Task Accuracy, Critical Recall, Current Truth Precision, Superseded Leakage, or per-case TKP required evidence. Precision may not regress by more than 0.01."
  }
};

await mkdir(dirname(OUTPUT), { recursive: true });
await writeFile(OUTPUT, JSON.stringify(report, null, 2) + "\n");
process.stdout.write(`${JSON.stringify({ output: OUTPUT, overall_gate: report.overall_gate, suites: results.map(compactSuite) }, null, 2)}\n`);

async function runObservationBuild(suitePath, outputPath, memhubCore) {
  const args = ["scripts/build-retrieval-pipeline-observations.mjs", suitePath, outputPath];
  if (memhubCore) args.push("--litsan-core");
  await run(process.execPath, args);
}

function run(command, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd: REPO, stdio: ["ignore", "ignore", "inherit"] });
    child.on("error", rejectRun);
    child.on("exit", (code, signal) => {
      if (code === 0) resolveRun();
      else rejectRun(new Error(`${command} ${args.join(" ")} failed: code=${code} signal=${signal ?? "none"}`));
    });
  });
}

function tkpObservation(observation) {
  return {
    case_id: observation.case_id,
    selected_evidence: observation.tkp_selected_evidence ?? [],
    current_claim_evidence: observation.tkp_current_claim_evidence ?? [],
    superseded_evidence: observation.tkp_superseded_evidence ?? [],
    context_bytes: observation.tkp_context_bytes ?? 0,
    hydrate_count: 0,
    latency_ms: observation.tkp_latency_ms ?? 0
  };
}

function compareSelections(left, right) {
  const rows = left.map((item, index) => {
    const a = item.selected_evidence ?? [];
    const b = right[index]?.selected_evidence ?? [];
    return {
      jaccard: jaccard(a, b),
      exact_order: JSON.stringify(a) === JSON.stringify(b)
    };
  });
  return {
    average_jaccard: average(rows.map((row) => row.jaccard)),
    exact_order_rate: ratio(rows.filter((row) => row.exact_order).length, rows.length)
  };
}

function caseComparison(testCase, oldObservation, coreObservation) {
  const required = testCase.required_evidence ?? [];
  const oldTkp = new Set(oldObservation?.tkp_selected_evidence ?? []);
  const coreTkp = new Set(coreObservation?.tkp_selected_evidence ?? []);
  return {
    id: testCase.id ?? null,
    retrieval_jaccard: jaccard(oldObservation?.selected_evidence ?? [], coreObservation?.selected_evidence ?? []),
    tkp_jaccard: jaccard(oldObservation?.tkp_selected_evidence ?? [], coreObservation?.tkp_selected_evidence ?? []),
    required_missing_old_tkp: required.filter((ref) => !oldTkp.has(ref)),
    required_missing_memhub_core_tkp: required.filter((ref) => !coreTkp.has(ref)),
    retrieval_added_by_memhub_core: difference(coreObservation?.selected_evidence ?? [], oldObservation?.selected_evidence ?? []),
    retrieval_removed_by_memhub_core: difference(oldObservation?.selected_evidence ?? [], coreObservation?.selected_evidence ?? [])
  };
}

function evaluateGate(retrievalOld, retrievalCore, tkpOld, tkpCore, perCase) {
  const failures = [];
  floor("retrieval.grounded_task_accuracy", retrievalOld.grounded_task_accuracy, retrievalCore.grounded_task_accuracy);
  floor("retrieval.critical_recall", retrievalOld.critical_recall, retrievalCore.critical_recall);
  floor("retrieval.current_truth_precision", retrievalOld.current_truth_precision, retrievalCore.current_truth_precision);
  ceiling("retrieval.superseded_leakage", retrievalOld.superseded_leakage, retrievalCore.superseded_leakage);
  toleranceFloor("retrieval.precision", retrievalOld.precision, retrievalCore.precision, 0.01);
  floor("tkp.grounded_task_accuracy", tkpOld.grounded_task_accuracy, tkpCore.grounded_task_accuracy);
  floor("tkp.critical_recall", tkpOld.critical_recall, tkpCore.critical_recall);
  floor("tkp.current_truth_precision", tkpOld.current_truth_precision, tkpCore.current_truth_precision);
  ceiling("tkp.superseded_leakage", tkpOld.superseded_leakage, tkpCore.superseded_leakage);
  toleranceFloor("tkp.precision", tkpOld.precision, tkpCore.precision, 0.01);
  for (const row of perCase) {
    if (row.required_missing_memhub_core_tkp.length > row.required_missing_old_tkp.length) {
      failures.push(`case:${row.id}:tkp_required_regression`);
    }
  }
  return { pass: failures.length === 0, failures };

  function floor(name, oldValue, newValue) {
    if (newValue + 1e-9 < oldValue) failures.push(`${name}:${oldValue}->${newValue}`);
  }
  function toleranceFloor(name, oldValue, newValue, tolerance) {
    if (newValue + tolerance + 1e-9 < oldValue) failures.push(`${name}:${oldValue}->${newValue}`);
  }
  function ceiling(name, oldValue, newValue) {
    if (newValue - 1e-9 > oldValue) failures.push(`${name}:${oldValue}->${newValue}`);
  }
}

function compactSuite(suite) {
  return {
    id: suite.id,
    cases: suite.case_count,
    source: suite.source,
    retrieval: {
      old_accuracy: suite.retrieval.memhub_v1.grounded_task_accuracy,
      new_accuracy: suite.retrieval.memhub_core.grounded_task_accuracy,
      old_critical_recall: suite.retrieval.memhub_v1.critical_recall,
      new_critical_recall: suite.retrieval.memhub_core.critical_recall,
      old_precision: suite.retrieval.memhub_v1.precision,
      new_precision: suite.retrieval.memhub_core.precision,
      selection_jaccard: suite.retrieval.selection.average_jaccard
    },
    tkp: {
      old_accuracy: suite.tkp.memhub_v1.grounded_task_accuracy,
      new_accuracy: suite.tkp.memhub_core.grounded_task_accuracy,
      old_critical_recall: suite.tkp.memhub_v1.critical_recall,
      new_critical_recall: suite.tkp.memhub_core.critical_recall,
      old_precision: suite.tkp.memhub_v1.precision,
      new_precision: suite.tkp.memhub_core.precision,
      selection_jaccard: suite.tkp.selection.average_jaccard
    },
    gate: suite.gate
  };
}

function difference(left, right) {
  const other = new Set(right);
  return left.filter((value) => !other.has(value));
}

function jaccard(left, right) {
  const a = new Set(left);
  const b = new Set(right);
  const union = new Set([...a, ...b]);
  if (union.size === 0) return 1;
  let overlap = 0;
  for (const value of a) if (b.has(value)) overlap += 1;
  return round(overlap / union.size);
}

function average(values) {
  return values.length ? round(values.reduce((sum, value) => sum + value, 0) / values.length) : 0;
}

function ratio(numerator, denominator) {
  return denominator > 0 ? round(numerator / denominator) : 1;
}

function round(value) {
  return Math.round(value * 10_000) / 10_000;
}
