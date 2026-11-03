#!/usr/bin/env node
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createEmbedder } from "../vendor/memory-core/src/model/embedder.js";
import { rankRecallHits } from "../dist/retrieval-ranker.js";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const DATA = resolve(ROOT, ".review-runtime", "benchmarks", "data", "locomo10.json");
const OUT = resolve(ROOT, ".review-runtime", "benchmarks", "locomo-retrieval.json");
const argLimit = Number(process.argv.find((arg) => arg.startsWith("--limit="))?.split("=")[1] ?? 0);
const mode = process.argv.includes("--lexical") ? "lexical" : "hybrid-local";

const samples = JSON.parse(await readFile(DATA, "utf8"));
const embedder = mode === "hybrid-local"
  ? createEmbedder({
      provider: "local",
      model: "Xenova/all-MiniLM-L6-v2",
      normalize: true,
      cache: true
    })
  : null;

const rows = [];
let seenQuestions = 0;
for (const sample of samples) {
  const sessions = buildSessions(sample);
  const docVectors = embedder
    ? await embedder.embed(sessions.map((session) => session.text), "document")
    : [];
  for (const qa of sample.qa ?? []) {
    if (argLimit > 0 && seenQuestions >= argLimit) break;
    seenQuestions += 1;
    const queryVector = embedder ? await embedder.embedOne(qa.question, "query") : null;
    const hits = sessions.map((session, index) => ({
      id: session.id,
      kind: "locomo-session",
      memoryLayer: "L2",
      status: "active",
      snippet: session.text,
      score: queryVector ? dot(queryVector, docVectors[index]) : 0.5,
      tags: ["benchmark:locomo", `sample:${sample.sample_id}`],
      source: "benchmark"
    }));
    const ranked = rankRecallHits(hits, qa.question, Math.min(10, Math.max(1, hits.length)));
    const ids = ranked.hits.map((row) => row.hit.id);
    const gold = goldSessionIds(qa.evidence ?? [], sessions);
    rows.push({
      sample_id: sample.sample_id,
      question: qa.question,
      answer: qa.answer,
      category: qa.category,
      evidence: qa.evidence ?? [],
      gold_session_ids: [...gold],
      retrieved_ids: ids,
      ...metrics(ids, gold)
    });
  }
  if (argLimit > 0 && seenQuestions >= argLimit) break;
}

const aggregate = {
  mode,
  questions: rows.length,
  any_at_1: mean(rows.map((row) => row.any_at_1)),
  any_at_3: mean(rows.map((row) => row.any_at_3)),
  any_at_5: mean(rows.map((row) => row.any_at_5)),
  any_at_10: mean(rows.map((row) => row.any_at_10)),
  all_at_1: mean(rows.map((row) => row.all_at_1)),
  all_at_3: mean(rows.map((row) => row.all_at_3)),
  all_at_5: mean(rows.map((row) => row.all_at_5)),
  all_at_10: mean(rows.map((row) => row.all_at_10)),
  mrr: mean(rows.map((row) => row.mrr))
};
const byCategory = Object.fromEntries([...new Set(rows.map((row) => String(row.category)))].sort().map((category) => {
  const group = rows.filter((row) => String(row.category) === category);
  return [category, {
    questions: group.length,
    any_at_3: mean(group.map((row) => row.any_at_3)),
    all_at_3: mean(group.map((row) => row.all_at_3)),
    any_at_5: mean(group.map((row) => row.any_at_5)),
    all_at_5: mean(group.map((row) => row.all_at_5))
  }];
}));

await mkdir(resolve(ROOT, ".review-runtime", "benchmarks"), { recursive: true });
await writeFile(OUT, JSON.stringify({ generated_at: new Date().toISOString(), aggregate, by_category: byCategory, rows }, null, 2) + "\n");
console.log(JSON.stringify({ aggregate, by_category: byCategory }, null, 2));
console.log(`saved: ${OUT}`);

function buildSessions(sample) {
  const out = [];
  for (const [key, value] of Object.entries(sample.conversation ?? {})) {
    if (!/^session_\d+$/.test(key) || !Array.isArray(value)) continue;
    const ids = value.map((turn) => turn?.dia_id).filter(Boolean);
    const text = value.map((turn) => `${turn?.speaker ?? "speaker"}: ${turn?.text ?? ""}`).join("\n");
    out.push({ id: `${sample.sample_id}:${key}`, key, ids: new Set(ids), text });
  }
  return out;
}

function goldSessionIds(evidence, sessions) {
  const gold = new Set();
  for (const evidenceId of evidence) {
    for (const session of sessions) if (session.ids.has(evidenceId)) gold.add(session.id);
  }
  return gold;
}

function metrics(ids, gold) {
  const any = (k) => gold.size === 0 ? 1 : ids.slice(0, k).some((id) => gold.has(id)) ? 1 : 0;
  const all = (k) => gold.size === 0 ? 1 : [...gold].every((id) => ids.slice(0, k).includes(id)) ? 1 : 0;
  let rr = 0;
  for (let index = 0; index < ids.length; index += 1) {
    if (gold.has(ids[index])) { rr = 1 / (index + 1); break; }
  }
  return {
    any_at_1: any(1), any_at_3: any(3), any_at_5: any(5), any_at_10: any(10),
    all_at_1: all(1), all_at_3: all(3), all_at_5: all(5), all_at_10: all(10),
    mrr: rr
  };
}

function dot(a, b) {
  let sum = 0;
  const length = Math.min(a?.length ?? 0, b?.length ?? 0);
  for (let index = 0; index < length; index += 1) sum += a[index] * b[index];
  return sum;
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}
