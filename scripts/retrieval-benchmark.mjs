#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  compareRetrievalBenchmarks,
  evaluateRetrievalBenchmark
} from "../dist/evaluation-harness.js";

const [suitePath, baselinePath, candidatePath] = process.argv.slice(2);
if (!suitePath || !baselinePath) {
  console.error("usage: node scripts/retrieval-benchmark.mjs <suite.json> <baseline-observations.json> [candidate-observations.json]");
  process.exit(2);
}

const suite = JSON.parse(await readFile(resolve(suitePath), "utf8"));
if (!suite || !Array.isArray(suite.cases)) throw new Error("suite must contain cases[]");
const baselineObservations = JSON.parse(await readFile(resolve(baselinePath), "utf8"));
if (!Array.isArray(baselineObservations)) throw new Error("baseline observations must be an array");
const baseline = evaluateRetrievalBenchmark(suite.cases, baselineObservations);
const output = {
  suite: suite.name ?? suite.snapshot_id ?? suitePath,
  snapshot_id: suite.snapshot_id ?? null,
  baseline
};
if (candidatePath) {
  const candidateObservations = JSON.parse(await readFile(resolve(candidatePath), "utf8"));
  if (!Array.isArray(candidateObservations)) throw new Error("candidate observations must be an array");
  const candidate = evaluateRetrievalBenchmark(suite.cases, candidateObservations);
  output.candidate = candidate;
  output.delta = compareRetrievalBenchmarks(baseline, candidate);
}
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
