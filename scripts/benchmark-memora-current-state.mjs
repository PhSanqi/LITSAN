#!/usr/bin/env node
import {materializeCurrentState, conditionalStateCandidates} from "./memora-state.mjs";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createEmbedder } from "../vendor/memory-core/src/model/embedder.js";
import { rankRecallHits } from "../dist/retrieval-ranker.js";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const DATA = resolve(ROOT, ".review-runtime", "benchmarks", "upstream", "memora", "data", "weekly");
const mode = process.argv.includes("--lexical") ? "lexical" : "hybrid-local";
const typedAdmission = process.argv.includes("--typed-admission");
const questionLimit = Number(process.argv.find((arg) => arg.startsWith("--limit="))?.split("=")[1] ?? 0);
const OUT = resolve(ROOT, ".review-runtime", "benchmarks", `memora-current-state-${mode}${typedAdmission ? "-typed" : ""}.json`);
const embedder = mode === "hybrid-local"
  ? createEmbedder({ provider: "local", model: "Xenova/all-MiniLM-L6-v2", normalize: true, cache: true })
  : null;

const personas = (await readdir(DATA, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const rows = [];
let processedQuestions = 0;

for (const persona of personas) {
  const root = resolve(DATA, persona);
  const evaluation = JSON.parse(await readFile(resolve(root, `evaluation_questions_${persona}.json`), "utf8"));
  const conversationDir = resolve(root, "conversations");
  const names = (await readdir(conversationDir)).filter((name) => /^session_\d+\.json$/.test(name)).sort();
  const sessions = [];
  for (const name of names) sessions.push(JSON.parse(await readFile(resolve(conversationDir, name), "utf8")));

  for (const [taskType, questions] of Object.entries(evaluation.questions ?? {})) {
    if (!Array.isArray(questions)) continue;
    for (const question of questions) {
      if (questionLimit > 0 && processedQuestions >= questionLimit) break;
      const state = materializeCurrentState(sessions, question.question_date);
      const stateByKey = new Map(state.map((entry) => [entry.key, entry]));
      const stateVectors = embedder && state.length ? await embedder.embed(state.map((entry) => entry.text), "document") : [];
      const current = evidenceSessionIds(question.memory_evidence);
      const forgotten = evidenceSessionIds(question.forgetting_evidence);
      const queryVector = embedder ? await embedder.embedOne(question.question, "query") : null;
      const admittedState = typedAdmission ? conditionalStateCandidates(state, question.question, question.question_date) : state;
      const hits = admittedState.map((entry) => {
        const index = state.findIndex((candidate) => candidate.key === entry.key);
        return ({
        id: entry.key,
        kind: "memora-current-state",
        memoryLayer: "L3",
        status: "active",
        snippet: entry.text,
        score: queryVector ? dot(queryVector, stateVectors[index]) : 0.5,
        tags: ["benchmark:memora", "state:current", `persona:${persona}`],
        source: "benchmark-current-state",
        updatedAt: entry.date
      });
      });
      const ranked = rankRecallHits(hits, question.question, Math.min(20, hits.length));
      const retrievedEntries = ranked.hits.map((row) => stateByKey.get(row.hit.id)).filter(Boolean);
      const ids = retrievedEntries.map((entry) => entry.sessionId);
      rows.push({
        persona,
        task_type: taskType,
        question_id: question.question_id,
        question: question.question,
        state_items: state.length,
        current_session_ids: [...current],
        forgotten_session_ids: [...forgotten],
        retrieved_ids: ids,
        retrieved_state_keys: retrievedEntries.map((entry) => entry.key),
        ...metrics(ids, current, forgotten)
      });
      processedQuestions += 1;
    }
    if (questionLimit > 0 && processedQuestions >= questionLimit) break;
  }
  if (questionLimit > 0 && processedQuestions >= questionLimit) break;
}

const aggregate = summarize(rows);
const byTask = Object.fromEntries([...new Set(rows.map((row) => row.task_type))].sort()
  .map((task) => [task, summarize(rows.filter((row) => row.task_type === task))]));
await mkdir(resolve(ROOT, ".review-runtime", "benchmarks"), { recursive: true });
await writeFile(OUT, JSON.stringify({ generated_at: new Date().toISOString(), aggregate, by_task: byTask, rows }, null, 2) + "\n");
console.log(JSON.stringify({ aggregate, by_task: byTask }, null, 2));
console.log(`saved: ${OUT}`);

function evidenceSessionIds(value) {
  const ids = new Set();
  const walk = (node) => {
    if (Array.isArray(node)) { for (const item of node) walk(item); return; }
    if (!node || typeof node !== "object") return;
    if (Number.isInteger(node.session_id)) ids.add(node.session_id);
    for (const child of Object.values(node)) walk(child);
  };
  walk(value);
  return ids;
}

function metrics(ids, current, forgotten) {
  const anyCurrent = (k) => current.size === 0 ? 1 : ids.slice(0, k).some((id) => current.has(id)) ? 1 : 0;
  const allCurrent = (k) => current.size === 0 ? 1 : [...current].every((id) => ids.slice(0, k).includes(id)) ? 1 : 0;
  const forgottenPollution = (k) => forgotten.size === 0 ? 0 : ids.slice(0, k).some((id) => forgotten.has(id)) ? 1 : 0;
  const firstCurrent = ids.findIndex((id) => current.has(id));
  const firstForgotten = ids.findIndex((id) => forgotten.has(id));
  return {
    current_any_at_1: anyCurrent(1), current_any_at_3: anyCurrent(3), current_any_at_5: anyCurrent(5), current_any_at_10: anyCurrent(10),
    current_all_at_3: allCurrent(3), current_all_at_5: allCurrent(5), current_all_at_10: allCurrent(10),
    forgotten_pollution_at_1: forgottenPollution(1), forgotten_pollution_at_3: forgottenPollution(3), forgotten_pollution_at_5: forgottenPollution(5), forgotten_pollution_at_10: forgottenPollution(10),
    current_before_forgotten: current.size === 0 ? 1 : firstCurrent >= 0 && (firstForgotten < 0 || firstCurrent < firstForgotten) ? 1 : 0
  };
}

function summarize(group) {
  const mean = (key) => group.length ? group.reduce((sum, row) => sum + row[key], 0) / group.length : 0;
  return {
    mode,
    questions: group.length,
    current_any_at_1: mean("current_any_at_1"), current_any_at_3: mean("current_any_at_3"), current_any_at_5: mean("current_any_at_5"), current_any_at_10: mean("current_any_at_10"),
    current_all_at_3: mean("current_all_at_3"), current_all_at_5: mean("current_all_at_5"), current_all_at_10: mean("current_all_at_10"),
    forgotten_pollution_at_1: mean("forgotten_pollution_at_1"), forgotten_pollution_at_3: mean("forgotten_pollution_at_3"), forgotten_pollution_at_5: mean("forgotten_pollution_at_5"), forgotten_pollution_at_10: mean("forgotten_pollution_at_10"),
    current_before_forgotten: mean("current_before_forgotten")
  };
}

function dot(a, b) {
  let sum = 0;
  const length = Math.min(a?.length ?? 0, b?.length ?? 0);
  for (let index = 0; index < length; index += 1) sum += a[index] * b[index];
  return sum;
}
