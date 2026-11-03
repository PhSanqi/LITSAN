import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestRoot } from "./test-isolation.mjs";
import { evaluateRetrievalBenchmark } from "../dist/evaluation-harness.js";

const repo = resolve(fileURLToPath(new URL("..", import.meta.url)));
const root = await createTestRoot("retrieval-pipeline-e2e-");
const suitePath = join(repo, "benchmarks/retrieval/p0-real-pipeline-suite.json");
const baselinePath = join(repo, "benchmarks/retrieval/p0-real-pipeline-baseline.json");
const outputPath = join(root, "observations.json");

try {
  const stdout = await run(process.execPath, [
    "scripts/build-retrieval-pipeline-observations.mjs",
    suitePath,
    outputPath
  ]);
  assert.match(stdout, /real-core-pipeline-v1/);
  const suite = JSON.parse(await readFile(suitePath, "utf8"));
  const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
  const observations = JSON.parse(await readFile(outputPath, "utf8"));
  assert.equal(observations.length, suite.cases.length);
  const byId = new Map(observations.map((item) => [item.case_id, item]));
  assert.deepEqual(byId.get("global-only").selected_evidence, ["fixture:global-profile@current"]);
  assert.ok(byId.get("explicit-cross-project-skill-reuse").selected_evidence.includes("fixture:other-skill@current"));
  assert.ok(!byId.get("explicit-cross-project-skill-reuse").selected_evidence.includes("fixture:other-profile@current"));
  assert.ok(!byId.get("project-isolation-negative").selected_evidence.includes("fixture:other-profile@current"));
  assert.ok(!byId.get("account-isolation-negative").selected_evidence.includes("fixture:second-account-profile@current"));
  assert.ok(observations.every((item) => item.scope.version === "retrieval-scope-envelope-v1"));
  assert.deepEqual(
    observations.map((item) => ({
      case_id: item.case_id,
      selected_evidence: item.selected_evidence,
      current_claim_evidence: item.current_claim_evidence,
      superseded_evidence: item.superseded_evidence,
      context_bytes: item.context_bytes,
      hydrate_count: item.hydrate_count
    })),
    baseline.map(({ latency_ms: _latency, ...item }) => item),
    "fresh real-pipeline selections and context bytes must match the frozen baseline; latency is intentionally not exact"
  );
  const metrics = evaluateRetrievalBenchmark(suite.cases, observations);
  assert.equal(metrics.grounded_task_accuracy, 1);
  assert.equal(metrics.critical_recall, 1);
  assert.equal(metrics.superseded_leakage, 0);
  console.log("memhub-retrieval-pipeline-benchmark-e2e: ok");
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
    child.once("exit", (code) => code === 0 ? resolveRun(stdout) : rejectRun(new Error(stderr || stdout || `child exited ${code}`)));
  });
}
