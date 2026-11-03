import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestRoot } from "./test-isolation.mjs";
import { evaluateRetrievalBenchmark } from "../dist/evaluation-harness.js";

const repo = resolve(fileURLToPath(new URL("..", import.meta.url)));
const root = await createTestRoot("memhub-core-retrieval-e2e-");
const suitePath = join(repo, "benchmarks/retrieval/memhub-core-chinese-ab-suite.json");
const outputPath = join(root, "observations.json");

try {
  const stdout = await run(process.execPath, [
    "scripts/build-retrieval-pipeline-observations.mjs",
    suitePath,
    outputPath,
    "--litsan-core"
  ]);
  assert.match(stdout, /"ranking_mode":\s*"memhub_core"/);

  const suite = JSON.parse(await readFile(suitePath, "utf8"));
  const observations = JSON.parse(await readFile(outputPath, "utf8"));
  assert.equal(observations.length, suite.cases.length);

  const metrics = evaluateRetrievalBenchmark(suite.cases, observations);
  assert.equal(metrics.grounded_task_accuracy, 1, "memhub_core Chinese/mixed benchmark must preserve exact task success");
  assert.equal(metrics.recall, 1, "memhub_core Chinese/mixed benchmark must preserve required evidence recall");
  assert.equal(metrics.critical_recall, 1, "memhub_core Chinese/mixed benchmark must preserve critical evidence recall");
  assert.equal(metrics.current_truth_precision, 1, "memhub_core must not regress Current Truth precision");
  assert.equal(metrics.superseded_leakage, 0, "memhub_core must not leak superseded evidence");

  const byId = new Map(observations.map((item) => [item.case_id, item]));
  for (const caseId of ["zh-current-state", "zh-provenance-reason", "zh-temporal-latest", "zh-source-synonym", "zh-mixed-current-truth"]) {
    assert.ok(byId.has(caseId), `benchmark must retain ${caseId}`);
  }

  console.log("litsan-core-retrieval-e2e: ok");
} finally {
  await rm(root, { recursive: true, force: true });
}

function run(command, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", rejectRun);
    child.once("exit", (code) => code === 0
      ? resolveRun(stdout)
      : rejectRun(new Error(stderr || stdout || `child exited ${code}`)));
  });
}
