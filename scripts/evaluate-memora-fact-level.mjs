#!/usr/bin/env node
import {materializeCurrentState} from "./memora-state.mjs";
import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const DATA = resolve(ROOT, ".review-runtime", "benchmarks", "upstream", "memora", "data", "weekly");
const OUT = resolve(ROOT, ".review-runtime", "benchmarks", "memora-fact-level.json");
const systems = [
  ["raw_lexical", "memora-weekly-retrieval-lexical.json", false],
  ["raw_hybrid", "memora-weekly-retrieval.json", false],
  ["current_state_lexical", "memora-current-state-lexical.json", true],
  ["current_state_hybrid", "memora-current-state-hybrid-local.json", true],
  ["current_state_hybrid_typed", "memora-current-state-hybrid-local-typed.json", true],
  ["current_state_hybrid_hydrated", "memora-current-state-hybrid-local.json", "hydrated"]
];

const personaCache = new Map();
const outputs = [];
for (const [id, file, stateMode] of systems) {
  const result = JSON.parse(await readFile(resolve(ROOT, ".review-runtime", "benchmarks", file), "utf8"));
  const rows = [];
  for (const row of result.rows) {
    const persona = await loadPersona(row.persona);
    const question = persona.questions.get(row.question_id);
    if (!question) continue;
    const currentFacts = factStrings(question.memory_evidence, false);
    const forgottenFacts = factStrings(question.forgetting_evidence, true);
    const retrievedTexts = stateMode === "hydrated"
      ? (row.retrieved_state_keys ?? []).map((key) => {
          const entry = requireStateEntry(persona, key, file);
          const source = persona.sessionText.get(entry.sessionId) ?? "";
          return `${entry.text}\n${matchedWindow(source, row.question, entry.item)}`;
        })
      : stateMode
        ? (row.retrieved_state_keys ?? []).map((key) => requireStateEntry(persona, key, file).text)
        : (row.retrieved_ids ?? []).map((sessionId) => persona.sessionText.get(Number(sessionId)) ?? "");
    rows.push({ task_type: row.task_type, current_fact_count: currentFacts.length, forgotten_fact_count: forgottenFacts.length,
      ...factMetrics(retrievedTexts, currentFacts, forgottenFacts) });
  }
  outputs.push({ id, aggregate: summarize(rows), by_task: groupSummary(rows), rows });
}

await mkdir(resolve(ROOT, ".review-runtime", "benchmarks"), { recursive: true });
await writeFile(OUT, JSON.stringify({ generated_at: new Date().toISOString(), systems: outputs }, null, 2) + "\n");
for (const output of outputs) console.log(output.id, JSON.stringify(output.aggregate));
console.log(`saved: ${OUT}`);

async function loadPersona(persona) {
  if (personaCache.has(persona)) return personaCache.get(persona);
  const root = resolve(DATA, persona);
  const evaluation = JSON.parse(await readFile(resolve(root, `evaluation_questions_${persona}.json`), "utf8"));
  const questions = new Map();
  for (const group of Object.values(evaluation.questions ?? {})) for (const question of Array.isArray(group) ? group : []) questions.set(question.question_id, question);
  const conversationDir = resolve(root, "conversations");
  const names = (await readdir(conversationDir)).filter((name) => /^session_\d+\.json$/.test(name)).sort();
  const sessions = [];
  const sessionText = new Map();
  for (const name of names) {
    const session = JSON.parse(await readFile(resolve(conversationDir, name), "utf8"));
    sessions.push(session);
    sessionText.set(Number(session.session_id), (session.conversation ?? []).map((turn) => `${turn.speaker ?? "speaker"}: ${turn.message ?? ""}`).join("\n"));
  }
  const state = materializeCurrentState(sessions);
  const value = { questions, sessionText, stateByKey: new Map(state.map((entry) => [entry.key, entry])) };
  personaCache.set(persona, value);
  return value;
}

function factStrings(value, forgetting) {
  const out = [];
  const skip = new Set(["session_id", "field", "category", "subcategory", "activity_type", "status"]);
  const walk = (node) => {
    if (Array.isArray(node)) { for (const item of node) walk(item); return; }
    if (!node || typeof node !== "object") return;
    for (const [key, child] of Object.entries(node)) {
      if (typeof child === "string") {
        if (skip.has(key) || key.endsWith("_count") || key.startsWith("total_")) continue;
        if (forgetting && !["value", "item", "removed_item"].includes(key)) continue;
        if (normalize(child).length >= 3) out.push(child);
      } else if (typeof child === "object" && child !== null) walk(child);
    }
  };
  walk(value);
  return [...new Map(out.map((text) => [normalize(text), text])).values()];
}

function factMetrics(texts, currentFacts, forgottenFacts) {
  const result = {};
  for (const k of [1, 3, 5, 10]) {
    const context = normalize(texts.slice(0, k).join("\n"));
    const currentMatched = currentFacts.filter((fact) => context.includes(normalize(fact))).length;
    const forgottenMatched = forgottenFacts.filter((fact) => context.includes(normalize(fact))).length;
    result[`fact_recall_at_${k}`] = currentFacts.length ? currentMatched / currentFacts.length : 1;
    result[`forgotten_fact_rate_at_${k}`] = forgottenFacts.length ? forgottenMatched / forgottenFacts.length : 0;
    result[`forgotten_fact_pollution_at_${k}`] = forgottenMatched > 0 ? 1 : 0;
  }
  return result;
}

function summarize(rows) {
  const metricKeys = Object.keys(rows[0] ?? {}).filter((key) => /^(fact_recall|forgotten_fact_)/.test(key));
  const result = { questions: rows.length };
  for (const key of metricKeys) result[key] = rows.length ? rows.reduce((sum, row) => sum + row[key], 0) / rows.length : 0;
  return result;
}

function groupSummary(rows) {
  return Object.fromEntries([...new Set(rows.map((row) => row.task_type))].sort().map((task) => [task, summarize(rows.filter((row) => row.task_type === task))]));
}



function requireStateEntry(persona, key, file) {
  const entry = persona.stateByKey.get(key);
  if (!entry) throw new Error(`Stale state key in ${file}: ${key}. Regenerate the retrieval report before scoring.`);
  return entry;
}

function normalize(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function matchedWindow(source, query, item, maxChars = 1200) {
  if (!source || source.length <= maxChars) return source;
  const lower = source.toLowerCase();
  const anchors = [item, ...String(query ?? "").split(/\s+/)]
    .map((value) => String(value ?? "").trim().toLowerCase())
    .filter((value) => value.length >= 4)
    .sort((a, b) => b.length - a.length);
  let index = -1;
  for (const anchor of anchors) {
    index = lower.indexOf(anchor);
    if (index >= 0) break;
  }
  if (index < 0) return source.slice(0, maxChars);
  const start = Math.max(0, Math.min(source.length - maxChars, index - Math.floor(maxChars / 3)));
  return source.slice(start, start + maxChars);
}
