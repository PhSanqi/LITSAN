#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CONFIG = process.env.MEM_BENCH_DS_CONFIG || resolve(homedir(), ".config", "memhub", "mem-benchmark-ds.env");
const OUT = resolve(ROOT, ".review-runtime", "semantic-answer-eval");
const smokeOnly = process.argv.includes("--smoke");
const resume = process.argv.includes("--resume");
const repeatsArg = process.argv.find((arg) => arg.startsWith("--repeats="));
const repeats = Math.max(1, Math.min(10, Number(repeatsArg?.split("=")[1] ?? 3)));

const configStat = await stat(CONFIG).catch(() => null);
if (!configStat) fail(`Missing benchmark-only API config: ${CONFIG}`);
const mode = (configStat.mode & 0o777).toString(8).padStart(3, "0");
if (mode !== "600") fail(`Unsafe config permissions ${mode}; expected 600: ${CONFIG}`);

const env = dotenv.parse(await readFile(CONFIG, "utf8"));
for (const key of ["MEM_BENCH_DS_BASE_URL", "MEM_BENCH_DS_MODEL", "MEM_BENCH_DS_API_KEY"]) {
  if (process.env[key]?.trim()) env[key] = process.env[key].trim();
}
for (const key of ["MEM_BENCH_DS_BASE_URL", "MEM_BENCH_DS_MODEL", "MEM_BENCH_DS_API_KEY"]) {
  if (!env[key]?.trim()) fail(`Missing ${key} in ${CONFIG}`);
}

const endpoint = buildEndpoint(env.MEM_BENCH_DS_BASE_URL);
console.log(`benchmark_api_host=${new URL(endpoint).host}`);
console.log(`benchmark_model=${env.MEM_BENCH_DS_MODEL}`);
console.log(`config_mode=${mode}`);

const smoke = await chat([{ role: "user", content: "Reply with exactly MEM_BENCH_OK" }], { maxTokens: 256, temperature: 0 });
if (!smoke.includes("MEM_BENCH_OK")) fail(`API smoke returned unexpected content: ${smoke.slice(0, 120)}`);
console.log("smoke=PASS");
recordStatus({ status: "pass", stage: "smoke", model: env.MEM_BENCH_DS_MODEL, api_host: new URL(endpoint).host });
if (smokeOnly) process.exit(0);

spawnChecked(process.execPath, [resolve(ROOT, "scripts", "build-semantic-answer-eval.mjs")]);
const manifest = JSON.parse(await readFile(resolve(OUT, "manifest.json"), "utf8"));
const batches = chunk(manifest.cases, 4);

let runs = [];
const resultPath = resolve(OUT, "ds-answer-ab.json");
if (resume) {
  const prior = await readFile(resultPath, "utf8").then(JSON.parse).catch(() => null);
  if (prior?.model === env.MEM_BENCH_DS_MODEL && Array.isArray(prior.runs)) {
    runs = prior.runs;
    console.log(`resume_runs=${runs.length}`);
  }
}
for (let repeat = runs.length + 1; repeat <= repeats; repeat += 1) {
  const fixedAnswers = [];
  const sharedAnswers = [];
  const judged = [];
  const swap = repeat % 2 === 0;
  for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
    const batch = batches[batchIndex];
    console.log(`repeat=${repeat}/${repeats} batch=${batchIndex + 1}/${batches.length} fixed=RUN`);
    const fixedText = await chat([{ role: "user", content: buildLanePrompt(batch, "fixed") }], { maxTokens: 8192, temperature: 0 });
    console.log(`repeat=${repeat}/${repeats} batch=${batchIndex + 1}/${batches.length} shared=RUN`);
    const sharedText = await chat([{ role: "user", content: buildLanePrompt(batch, "shared") }], { maxTokens: 8192, temperature: 0 });
    const batchFixed = parseAnswerArray(fixedText, "fixed");
    const batchShared = parseAnswerArray(sharedText, "shared");
    fixedAnswers.push(...batchFixed);
    sharedAnswers.push(...batchShared);
    const laneA = swap ? batchShared : batchFixed;
    const laneB = swap ? batchFixed : batchShared;
    console.log(`repeat=${repeat}/${repeats} batch=${batchIndex + 1}/${batches.length} judge=RUN`);
    const judgeText = await chat([{ role: "user", content: buildJudgePrompt(batch, laneA, laneB) }], { maxTokens: 8192, temperature: 0 });
    judged.push(...parseJudgeArray(judgeText));
  }
  runs.push({
    repeat,
    blind_mapping: { A: swap ? "shared" : "fixed", B: swap ? "fixed" : "shared" },
    fixed_answers: fixedAnswers,
    shared_answers: sharedAnswers,
    judged
  });
}

const summary = summarize(runs);
await mkdir(OUT, { recursive: true });
await writeFile(resultPath, JSON.stringify({
  generated_at: new Date().toISOString(),
  protocol: "memhub-answer-ab-v1",
  model: env.MEM_BENCH_DS_MODEL,
  api_host: new URL(endpoint).host,
  repeats,
  summary,
  runs
}, null, 2) + "\n");
console.log(JSON.stringify(summary, null, 2));
console.log(`saved=${resultPath}`);

function buildEndpoint(rawBase) {
  let base;
  try { base = new URL(rawBase); } catch { fail(`Invalid MEM_BENCH_DS_BASE_URL: ${rawBase}`); }
  if (!["https:", "http:"].includes(base.protocol)) fail(`Unsupported API protocol: ${base.protocol}`);
  if (/\.comv1$/i.test(base.hostname)) fail(`MEM_BENCH_DS_BASE_URL looks malformed (${base.hostname}). Did you mean https://api.deepseek.com/v1 ?`);
  return new URL("chat/completions", base.toString().replace(/\/+$/, "") + "/").toString();
}

async function chat(messages, { maxTokens, temperature }) {
  const body = { model: env.MEM_BENCH_DS_MODEL, messages, temperature, max_tokens: maxTokens, stream: false };
  const temp = await mkdtemp(join(tmpdir(), "memhub-membench-"));
  try {
    const requestPath = join(temp, "request.json");
    const responsePath = join(temp, "response.json");
    const curlConfigPath = join(temp, "curl.conf");
    await writeFile(requestPath, JSON.stringify(body), { mode: 0o600 });
    await writeFile(curlConfigPath, [
      `url = "${curlEscape(endpoint)}"`,
      `header = "Authorization: Bearer ${curlEscape(env.MEM_BENCH_DS_API_KEY)}"`,
      `header = "Content-Type: application/json"`,
      "request = POST",
      "silent",
      "show-error",
      "connect-timeout = 15",
      "max-time = 180"
    ].join("\n") + "\n", { mode: 0o600 });
    await chmod(curlConfigPath, 0o600);
    const curl = spawnSync("curl", [
      "--config", curlConfigPath,
      "--ipv4",
      "--retry", "4",
      "--retry-all-errors",
      "--retry-delay", "1",
      "--data-binary", `@${requestPath}`,
      "--output", responsePath,
      "--write-out", "%{http_code}"
    ], { encoding: "utf8", timeout: 190_000 });
    const httpStatus = Number((curl.stdout || "0").trim());
    if (curl.error) fail(`curl failed: ${curl.error.message}`);
    if (curl.status !== 0) fail(`curl transport failed (exit ${curl.status}): ${(curl.stderr || "").trim().slice(0, 300)}`);
    const raw = await readFile(responsePath, "utf8").catch(() => "");
    let data;
    try { data = JSON.parse(raw); } catch { fail(`API returned non-JSON HTTP ${httpStatus}: ${raw.slice(0, 300)}`); }
    if (httpStatus < 200 || httpStatus >= 300 || data.error) {
      const error = data.error || data;
      fail(`API HTTP ${httpStatus}: ${String(error?.message || error?.type || JSON.stringify(error)).slice(0, 400)}`);
    }
    const choice = data?.choices?.[0];
    const message = choice?.message || {};
    const content = message?.content;
    if (typeof content !== "string") fail("API response missing choices[0].message.content");
    if (!content.trim() && typeof message.reasoning_content === "string" && message.reasoning_content.length > 0) {
      fail(`API returned empty final content after reasoning (reasoning_chars=${message.reasoning_content.length}, finish_reason=${String(choice?.finish_reason || "unknown")})`);
    }
    return content;
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

function parseAnswerArray(text, lane) {
  const parsed = parseJsonPayload(text);
  if (!Array.isArray(parsed)) fail(`${lane} answer is not a JSON array`);
  return parsed.map((row) => ({ case_id: String(row.case_id ?? ""), answer: String(row.answer ?? "") }));
}

function parseJudgeArray(text) {
  const parsed = parseJsonPayload(text);
  if (!Array.isArray(parsed)) fail("judge output is not a JSON array");
  return parsed;
}

function parseJsonPayload(text) {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(trimmed); } catch {}
  const start = trimmed.indexOf("[");
  const end = trimmed.lastIndexOf("]");
  if (start >= 0 && end > start) {
    const candidate = trimmed.slice(start, end + 1);
    try { return JSON.parse(candidate); } catch (error) { fail(`Could not parse extracted model JSON: ${error.message}; prefix=${candidate.slice(0, 200)}`); }
  }
  fail(`Could not locate a JSON array in model output; prefix=${trimmed.slice(0, 200)}`);
}

function buildJudgePrompt(cases, laneA, laneB) {
  const a = new Map(laneA.map((row) => [row.case_id, row.answer]));
  const b = new Map(laneB.map((row) => [row.case_id, row.answer]));
  const payload = cases.map((item) => ({ case_id: item.id, question: item.query, gold_reference: item.gold, answer_A: a.get(item.id) ?? "", answer_B: b.get(item.id) ?? "" }));
  return [
    "You are a strict blinded evaluator of memory-augmented answers. Judge only against the question and gold_reference.",
    "For each answer A and B, emit binary 0/1 fields:",
    "grounded_task_accuracy: 1 only if the answer reaches the correct conclusion and contains the required core information.",
    "factual_correctness: 1 only if it makes no material false/stale/conflicting claim relative to the gold reference.",
    "critical_omission: 1 if a must-have fact from the gold reference is missing, otherwise 0.",
    "stale_fact_usage: 1 if it relies on a superseded/stale claim, otherwise 0.",
    "constructive_breadth: 1 only if it adds a useful supported angle without harming correctness; otherwise 0.",
    "Return ONLY a JSON array with {case_id,A:{...},B:{...}} in input order. No prose.",
    JSON.stringify(payload)
  ].join("\n\n");
}

function buildLanePrompt(cases, lane) {
  const payload = cases.map((item) => ({ case_id: item.id, question: item.query, context: item[lane].context }));
  return [
    "You are evaluating a memory-augmented assistant. Do not call tools or use external facts.",
    "For each case, answer the question using only the supplied context. If the context is insufficient, say so instead of guessing.",
    "Treat explicit Current Truth / authoritative constraints as stronger than historical notes when they conflict.",
    "For open-ended questions, you may synthesize useful alternatives that are actually supported by the context, but do not introduce unrelated ideas.",
    "Return ONLY one JSON array. Each element must be {\"case_id\": string, \"answer\": string}. Preserve the input order.",
    "CASES:",
    JSON.stringify(payload)
  ].join("\n\n");
}

function chunk(items, size) {
  const result = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

function summarize(runs) {
  const lanes = { fixed: [], shared: [] };
  for (const run of runs) for (const row of run.judged) for (const blind of ["A", "B"]) lanes[run.blind_mapping[blind]].push(row?.[blind] || {});
  return Object.fromEntries(Object.entries(lanes).map(([lane, scores]) => [lane, {
    ...aggregate(scores),
    strict_outcome_repeatability: strictOutcomeRepeatability(runs, lane)
  }]));
}

function aggregate(scores) {
  const mean = (key) => scores.length ? scores.reduce((sum, row) => sum + Number(row?.[key] || 0), 0) / scores.length : 0;
  const strict = scores.length ? scores.reduce((sum, row) => sum + (strictGrounded(row) ? 1 : 0), 0) / scores.length : 0;
  return {
    judged_answers: scores.length,
    grounded_task_accuracy: mean("grounded_task_accuracy"),
    strict_grounded_success_rate: strict,
    factual_correctness: mean("factual_correctness"),
    critical_omission_rate: mean("critical_omission"),
    stale_fact_usage_rate: mean("stale_fact_usage"),
    constructive_breadth: mean("constructive_breadth")
  };
}

function strictGrounded(row) {
  return Number(row?.grounded_task_accuracy) === 1
    && Number(row?.factual_correctness) === 1
    && Number(row?.critical_omission) === 0
    && Number(row?.stale_fact_usage) === 0;
}

function strictOutcomeRepeatability(runs, lane) {
  const byCase = new Map();
  for (const run of runs) {
    for (const row of run.judged) {
      const blind = run.blind_mapping.A === lane ? "A" : "B";
      const values = byCase.get(row.case_id) || [];
      values.push(strictGrounded(row?.[blind] || {}) ? 1 : 0);
      byCase.set(row.case_id, values);
    }
  }
  if (!byCase.size) return 0;
  let stable = 0;
  for (const values of byCase.values()) if (new Set(values).size === 1) stable += 1;
  return stable / byCase.size;
}

function spawnChecked(command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: "utf8", stdio: "inherit" });
  if (result.error || result.status !== 0) fail(`${command} failed with status ${result.status ?? "unknown"}`);
}

function curlEscape(value) { return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r|\n/g, ""); }
function recordStatus(payload) {
  try {
    mkdirSync(OUT, { recursive: true });
    writeFileSync(resolve(OUT, "ds-api-status.json"), JSON.stringify({ generated_at: new Date().toISOString(), ...payload }, null, 2) + "\n");
  } catch {}
}
function fail(message) {
  recordStatus({ status: "fail", stage: "api", error: String(message).slice(0, 1000) });
  console.error(`ERROR: ${message}`);
  process.exit(1);
}
