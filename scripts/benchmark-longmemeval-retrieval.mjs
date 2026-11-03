#!/usr/bin/env node
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createEmbedder } from "../vendor/memory-core/src/model/embedder.js";
import { rankRecallHits } from "../dist/retrieval-ranker.js";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const DATA = resolve(ROOT, ".review-runtime", "benchmarks", "data", "longmemeval_s_cleaned.json");
const OUT = resolve(ROOT, ".review-runtime", "benchmarks", "longmemeval-retrieval.json");
const mode = process.argv.includes("--lexical") ? "lexical" : "hybrid-local";
const perType = Number(process.argv.find((arg) => arg.startsWith("--per-type="))?.split("=")[1] ?? 10);
const questions = JSON.parse(await readFile(DATA, "utf8"));
const selected = stratified(questions, perType);
const embedder = mode === "hybrid-local"
  ? createEmbedder({ provider: "local", model: "Xenova/all-MiniLM-L6-v2", normalize: true, cache: true })
  : null;
const rows = [];

for (const question of selected) {
  const sessions = question.haystack_sessions.map((messages, index) => ({
    id: question.haystack_session_ids[index],
    text: serializeSession(messages)
  }));
  let semanticScores = new Array(sessions.length).fill(0.5);
  if (embedder) {
    const queryVector = await embedder.embedOne(question.question, "query");
    const views = sessions.flatMap((session) => sessionViews(session.text));
    const vectors = await embedder.embed(views, "document");
    semanticScores = sessions.map((_, index) => Math.max(
      dot(queryVector, vectors[index * 2]),
      dot(queryVector, vectors[index * 2 + 1])
    ));
  }
  const hits = sessions.map((session, index) => ({
    id: session.id,
    kind: "longmemeval-session",
    memoryLayer: "L2",
    status: "active",
    snippet: session.text,
    score: semanticScores[index],
    tags: ["benchmark:longmemeval", `type:${question.question_type}`],
    source: "benchmark"
  }));
  const ranked = rankRecallHits(hits, question.question, Math.min(10, hits.length));
  const ids = ranked.hits.map((row) => row.hit.id);
  const gold = new Set(question.answer_session_ids ?? []);
  rows.push({
    question_id: question.question_id,
    question_type: question.question_type,
    question: question.question,
    answer: question.answer,
    gold_session_ids: [...gold],
    retrieved_ids: ids,
    ...metrics(ids, gold)
  });
}

const aggregate = summarize(rows);
const byType = Object.fromEntries([...new Set(rows.map((row) => row.question_type))].sort().map((type) => [type, summarize(rows.filter((row) => row.question_type === type))]));
await mkdir(resolve(ROOT, ".review-runtime", "benchmarks"), { recursive: true });
await writeFile(OUT, JSON.stringify({ generated_at: new Date().toISOString(), aggregate, by_type: byType, rows }, null, 2) + "\n");
console.log(JSON.stringify({ aggregate, by_type: byType }, null, 2));
console.log(`saved: ${OUT}`);

function stratified(all, n) {
  const groups = new Map();
  for (const row of all) {
    if (!groups.has(row.question_type)) groups.set(row.question_type, []);
    groups.get(row.question_type).push(row);
  }
  return [...groups.values()].flatMap((rows) => rows.slice(0, Math.max(1, n)));
}

function serializeSession(messages) {
  return (messages ?? []).map((message) => `${message.role ?? "speaker"}: ${typeof message.content === "string" ? message.content : JSON.stringify(message.content)}`).join("\n");
}

function sessionViews(text) {
  const width = 3_000;
  return [text.slice(0, width), text.length > width ? text.slice(-width) : text];
}

function metrics(ids, gold) {
  const any = (k) => gold.size === 0 ? 1 : ids.slice(0, k).some((id) => gold.has(id)) ? 1 : 0;
  const all = (k) => gold.size === 0 ? 1 : [...gold].every((id) => ids.slice(0, k).includes(id)) ? 1 : 0;
  let rr = 0;
  for (let index = 0; index < ids.length; index += 1) if (gold.has(ids[index])) { rr = 1 / (index + 1); break; }
  return {
    any_at_1: any(1), any_at_3: any(3), any_at_5: any(5), any_at_10: any(10),
    all_at_1: all(1), all_at_3: all(3), all_at_5: all(5), all_at_10: all(10),
    mrr: rr
  };
}

function summarize(group) {
  const meanKey = (key) => mean(group.map((row) => row[key]));
  return {
    mode,
    questions: group.length,
    any_at_1: meanKey("any_at_1"), any_at_3: meanKey("any_at_3"), any_at_5: meanKey("any_at_5"), any_at_10: meanKey("any_at_10"),
    all_at_1: meanKey("all_at_1"), all_at_3: meanKey("all_at_3"), all_at_5: meanKey("all_at_5"), all_at_10: meanKey("all_at_10"),
    mrr: meanKey("mrr")
  };
}
function dot(a, b) { let sum = 0; for (let i = 0; i < Math.min(a?.length ?? 0, b?.length ?? 0); i += 1) sum += a[i] * b[i]; return sum; }
function mean(values) { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0; }
