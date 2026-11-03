#!/usr/bin/env node
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

  const state = materializeCurrentState(sessions);
  const stateByKey = new Map(state.map((entry) => [entry.key, entry]));
  const stateVectors = embedder ? await embedder.embed(state.map((entry) => entry.text), "document") : [];

  for (const [taskType, questions] of Object.entries(evaluation.questions ?? {})) {
    if (!Array.isArray(questions)) continue;
    for (const question of questions) {
      if (questionLimit > 0 && processedQuestions >= questionLimit) break;
      const current = evidenceSessionIds(question.memory_evidence);
      const forgotten = evidenceSessionIds(question.forgetting_evidence);
      const queryVector = embedder ? await embedder.embedOne(question.question, "query") : null;
      const admittedState = typedAdmission ? conditionalStateCandidates(state, question.question) : state;
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

function materializeCurrentState(sessions) {
  const active = new Map();
  for (const session of [...sessions].sort((a, b) => Number(a.session_id) - Number(b.session_id))) {
    if (!session.operation) continue;
    const details = session.operation_details ?? {};
    const type = session.session_type ?? "memory";
    const item = canonicalItem(details.item) || contentAnchor(details.content_data);
    const oldItem = canonicalItem(details.old_item);
    const key = stateKey(type, details, item);
    const oldKey = oldItem ? stateKey(type, details, oldItem) : "";

    if (session.operation === "update") {
      if (oldKey && oldKey !== key) active.delete(oldKey);
      if (key) active.delete(key);
    }
    if (session.operation === "delete") {
      if (key) active.delete(key);
      if (oldKey) active.delete(oldKey);
    }
    if (details.moved_to_completed === true && !hasContent(details.content_data)) {
      if (key) active.delete(key);
      continue;
    }

    const hasResidualState = session.operation !== "delete" || hasContent(details.content_data);
    if (!key || !hasResidualState) continue;
    active.set(key, {
      key,
      sessionId: Number(session.session_id),
      date: session.date,
      demandKind: stateDemandKind(session, details, item),
      text: stateText(session, details, item)
    });
  }
  return [...active.values()];
}

function stateKey(type, details, item) {
  if (!item) return "";
  return [type, details.category ?? "", details.subcategory ?? "", normalize(item)].join(":");
}

function conditionalStateCandidates(state, query) {
  const demand = queryDemandKind(query);
  if (!demand) return state;
  const matched = state.filter((entry) => entry.demandKind === demand);
  return matched.length ? matched : state;
}

function queryDemandKind(query) {
  const text = String(query ?? "").toLowerCase();
  if (/meeting notes?/.test(text)) return "meeting_notes";
  if (/project proposal/.test(text)) return "project_proposal";
  if (/\bemail\b/.test(text)) return "email";
  if (/todo|tasks? remain/.test(text)) return "todo";
  if (/calendar|upcoming events?/.test(text)) return "calendar";
  if (/expense|spent|spend/.test(text)) return "expense";
  if (/\bsteps?\b/.test(text)) return "steps";
  if (/recommend|suggest/.test(text)) return "preference";
  if (/\bgoals?\b/.test(text)) return "goal";
  return null;
}

function stateDemandKind(session, details, item) {
  const normalizedItem = normalize(item);
  if (normalizedItem.includes("meeting notes") || details.content_data?.meeting_title) return "meeting_notes";
  if (normalizedItem.includes("project proposal") || details.content_data?.project_title) return "project_proposal";
  if (normalizedItem.includes("email") || details.content_data?.email_purpose || details.content_data?.email_subject) return "email";
  if (details.category === "todo_list") return "todo";
  if (details.category === "calendar_event") return "calendar";
  if (details.category === "food_expenses") return "expense";
  if (details.category === "step_tracker") return "steps";
  if (session.session_type === "preference") return "preference";
  if (session.session_type === "goal") return "goal";
  return "other";
}

function stateText(session, details, item) {
  const pieces = [
    `type: ${session.session_type ?? "memory"}`,
    details.category ? `category: ${details.category}` : "",
    details.subcategory ? `subcategory: ${details.subcategory}` : "",
    item ? `item: ${item}` : "",
    details.preference ? `preference: ${details.preference}` : "",
    hasContent(details.content_data) ? `content: ${flatten(details.content_data)}` : "",
    `operation: ${session.operation}`
  ].filter(Boolean);
  return pieces.join("\n");
}

function canonicalItem(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  for (const key of ["description", "title", "name", "task", "goal", "event"]) {
    if (typeof value[key] === "string") return value[key];
  }
  return flatten(value);
}

function contentAnchor(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  for (const key of ["meeting_title", "project_title", "title", "email_subject", "email_purpose", "event_title", "name"]) {
    if (typeof value[key] === "string" && value[key].trim()) return value[key].trim();
  }
  return "";
}

function flatten(value) {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(flatten).filter(Boolean).join("; ");
  if (typeof value === "object") return Object.entries(value).map(([key, child]) => `${key}: ${flatten(child)}`).join("; ");
  return "";
}

function hasContent(value) {
  if (value == null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

function normalize(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

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
