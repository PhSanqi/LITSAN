#!/usr/bin/env node
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { createEmbedder } from "../vendor/memory-core/src/model/embedder.js";
import { rankRecallHits } from "../dist/retrieval-ranker.js";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const DATA = resolve(ROOT, ".review-runtime", "benchmarks", "upstream", "memora", "data", "weekly");
const stateAware = process.argv.includes("--state-aware");
const mode = process.argv.includes("--lexical") ? "lexical" : "hybrid-local";
const questionLimit = Number(process.argv.find((arg) => arg.startsWith("--limit="))?.split("=")[1] ?? 0);
const OUT = resolve(ROOT, ".review-runtime", "benchmarks", `memora-weekly-retrieval-${mode}${stateAware ? "-state-aware" : ""}.json`);
const embedder = mode === "hybrid-local"
  ? createEmbedder({ provider: "local", model: "Xenova/all-MiniLM-L6-v2", normalize: true, cache: true })
  : null;

const personas = (await readdir(DATA, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
const rows = [];
let processedQuestions = 0;

for (const persona of personas) {
  const root = resolve(DATA, persona);
  const evalFile = resolve(root, `evaluation_questions_${persona}.json`);
  const evaluation = JSON.parse(await readFile(evalFile, "utf8"));
  const conversationDir = resolve(root, "conversations");
  const sessionFiles = (await readdir(conversationDir)).filter((name) => /^session_\d+\.json$/.test(name)).sort();
  const sessions = [];
  for (const name of sessionFiles) {
    const doc = JSON.parse(await readFile(resolve(conversationDir, name), "utf8"));
    const text = (doc.conversation ?? []).map((turn) => `${turn.speaker ?? "speaker"}: ${turn.message ?? ""}`).join("\n");
    sessions.push({ id: Number(doc.session_id), date: doc.date, text, operation: doc.operation ?? null, operationDetails: doc.operation_details ?? {} });
  }
  const invalidated = stateAware ? buildInvalidatedSessions(sessions) : new Set();
  const documentVectors = embedder ? await embedder.embed(sessions.map((session) => session.text), "document") : [];

  for (const [taskType, questions] of Object.entries(evaluation.questions ?? {})) {
    if (!Array.isArray(questions)) continue;
    for (const question of questions) {
      if (questionLimit > 0 && processedQuestions >= questionLimit) break;
      const current = evidenceSessionIds(question.memory_evidence);
      const forgotten = evidenceSessionIds(question.forgetting_evidence);
      const queryVector = embedder ? await embedder.embedOne(question.question, "query") : null;
      const hits = sessions.filter((session) => !invalidated.has(session.id)).map((session) => {
        const index = sessions.findIndex((candidate) => candidate.id === session.id);
        return ({
        id: String(session.id),
        kind: "memora-session",
        memoryLayer: "L2",
        status: "active",
        snippet: session.text,
        score: queryVector ? dot(queryVector, documentVectors[index]) : 0.5,
        tags: ["benchmark:memora", `persona:${persona}`],
        source: "benchmark",
        updatedAt: session.date
      });
      });
      const ranked = rankRecallHits(hits, question.question, Math.min(20, hits.length));
      const ids = ranked.hits.map((row) => Number(row.hit.id));
      rows.push({
        persona,
        task_type: taskType,
        question_id: question.question_id,
        question: question.question,
        current_session_ids: [...current],
        forgotten_session_ids: [...forgotten],
        retrieved_ids: ids,
        ...metrics(ids, current, forgotten)
      });
      processedQuestions += 1;
    }
    if (questionLimit > 0 && processedQuestions >= questionLimit) break;
  }
  if (questionLimit > 0 && processedQuestions >= questionLimit) break;
}

const aggregate = summarize(rows);
const byTask = Object.fromEntries([...new Set(rows.map((row) => row.task_type))].sort().map((task) => [task, summarize(rows.filter((row) => row.task_type === task))]));
await mkdir(resolve(ROOT, ".review-runtime", "benchmarks"), { recursive: true });
await writeFile(OUT, JSON.stringify({ generated_at: new Date().toISOString(), aggregate, by_task: byTask, rows }, null, 2) + "\n");
console.log(JSON.stringify({ aggregate, by_task: byTask }, null, 2));
console.log(`saved: ${OUT}`);

function buildInvalidatedSessions(sessions) {
  const invalidated = new Set();
  const seenByItem = new Map();
  for (const session of [...sessions].sort((a, b) => a.id - b.id)) {
    const details = session.operationDetails ?? {};
    const item = canonicalItem(details.item);
    const oldItem = canonicalItem(details.old_item);
    if (session.operation === "update") {
      if (item) invalidateSeen(item, session.id);
      if (oldItem) invalidateSeen(oldItem, session.id);
      for (const prior of sessionHistoryIds(details.session_history)) if (prior < session.id) invalidated.add(prior);
    }
    if (session.operation === "delete") {
      if (item) invalidateSeen(item, session.id);
      for (const prior of sessionHistoryIds(details.session_history)) if (prior < session.id) invalidated.add(prior);
      for (const deletion of Array.isArray(details.memory_deletes) ? details.memory_deletes : []) {
        const removed = canonicalItem(deletion?.removed_item);
        if (removed) invalidateTextMatch(removed, session.id);
      }
    }
    if (details.moved_to_completed === true && item) invalidateSeen(item, session.id);
    if (item) {
      const key = normalizeItem(item);
      const bucket = seenByItem.get(key) ?? [];
      bucket.push(session.id);
      seenByItem.set(key, bucket);
    }
  }
  return invalidated;

  function invalidateSeen(item, beforeId) {
    const bucket = seenByItem.get(normalizeItem(item)) ?? [];
    for (const id of bucket) if (id < beforeId) invalidated.add(id);
  }
  function invalidateTextMatch(item, beforeId) {
    const needle = normalizeItem(item);
    if (!needle) return;
    for (const prior of sessions) {
      if (prior.id >= beforeId) continue;
      if (normalizeItem(prior.text).includes(needle)) invalidated.add(prior.id);
    }
  }
}

function canonicalItem(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  for (const key of ["description", "title", "name", "task", "goal", "event"]) {
    if (typeof value[key] === "string") return value[key];
  }
  return "";
}

function normalizeItem(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function sessionHistoryIds(value) {
  const ids = [];
  const walk = (node) => {
    if (Array.isArray(node)) { for (const item of node) walk(item); return; }
    if (Number.isInteger(node)) { ids.push(node); return; }
    if (!node || typeof node !== "object") return;
    for (const [key, child] of Object.entries(node)) {
      if ((key === "session_id" || key === "sessionId") && Number.isInteger(child)) ids.push(child);
      else walk(child);
    }
  };
  walk(value);
  return ids;
}

function evidenceSessionIds(value) {
  const ids = new Set();
  walk(value);
  return ids;
  function walk(node) {
    if (Array.isArray(node)) { for (const item of node) walk(item); return; }
    if (!node || typeof node !== "object") return;
    if (Number.isInteger(node.session_id)) ids.add(node.session_id);
    for (const child of Object.values(node)) walk(child);
  }
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
  const m = (key) => mean(group.map((row) => row[key]));
  return {
    mode,
    questions: group.length,
    current_any_at_1: m("current_any_at_1"), current_any_at_3: m("current_any_at_3"), current_any_at_5: m("current_any_at_5"), current_any_at_10: m("current_any_at_10"),
    current_all_at_3: m("current_all_at_3"), current_all_at_5: m("current_all_at_5"), current_all_at_10: m("current_all_at_10"),
    forgotten_pollution_at_1: m("forgotten_pollution_at_1"), forgotten_pollution_at_3: m("forgotten_pollution_at_3"), forgotten_pollution_at_5: m("forgotten_pollution_at_5"), forgotten_pollution_at_10: m("forgotten_pollution_at_10"),
    current_before_forgotten: m("current_before_forgotten")
  };
}

function dot(a, b) {
  let sum = 0;
  const length = Math.min(a?.length ?? 0, b?.length ?? 0);
  for (let index = 0; index < length; index += 1) sum += a[index] * b[index];
  return sum;
}
function mean(values) { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0; }
