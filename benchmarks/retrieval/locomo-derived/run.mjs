#!/usr/bin/env node
// P0 production-path evidence recall (CRITERIA.md). Isolated stack, real tools:
//   1. every LoCoMo turn is captured as its own L1 event through litsan_turn
//   2. each conversation gets one completed L2 revision whose atomic facts are the
//      extracted records (multihop/records), each citing its source L1 events, so the
//      turns are in the post-distillation state production is in
//   3. litsan_context answers the §9 dev/holdout questions with the derived-fact flag
//      off (arm A, today's default) and semantic (arm B)
// usage: node benchmarks/retrieval/locomo-derived/run.mjs [ingest|query|score|all]
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { JsonProjectRegistry } from "../../../dist/project-registry.js";
import { extractDistilledFactMetadata } from "../../../dist/fact-metadata.js";
import { recordCompletedDistillationRevision, listDistillationJobs } from "../../../dist/distillation-jobs.js";
import { prewarmDerivedFactRevisionIndex } from "../../../dist/derived-fact-retrieval.js";
import { createLitsanRuntime } from "../../../dist/runtime.js";
import { DISTILLATION_CONTRACT_VERSION } from "../../../dist/distillation-contract.js";

const ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
// Data folder (LoCoMo copy, attribution sets): LITSAN_BENCH_DATA, default <repo>/.review-runtime (git-ignored).
const DATA = process.env.LITSAN_BENCH_DATA ?? join(ROOT, ".review-runtime");
const MH = join(DATA, "attribution-20261106", "multihop");
const LOCOMO = join(DATA, "benchmarks", "data", "locomo10.json");
const SMOKE = process.env.P0_SMOKE === "1";
const OUT = resolve(ROOT, ".review-runtime", process.env.P0_OUT || (SMOKE ? "locomo-derived-smoke" : "locomo-derived"));
const STATE_ROOT = join(OUT, "state");
const CONTROL_ROOT = join(STATE_ROOT, "server");
const MEMORY_ROOT = join(STATE_ROOT, "memory");
const CORE_PORT = Number(process.env.P0_CORE_PORT ?? 19210), GATEWAY_PORT = CORE_PORT + 1;
const ACCOUNT_ID = "locomo-derived-account";
const TOKEN = "locomo-derived-test-token";
const step = process.argv[2] ?? "all";

const eventId = (conv, dia) => `lc-${conv}-${dia.replace(":", "-")}`;
const projectOf = (conv) => `locomo-${conv}`;
const conversations = JSON.parse(await readFile(LOCOMO, "utf8")).slice(0, SMOKE ? 1 : undefined);

function turnsOf(conv) {
  const c = conv.conversation, out = [];
  const keys = Object.keys(c).filter((k) => /^session_\d+$/.test(k) && Array.isArray(c[k])).sort((a, b) => +a.split("_")[1] - +b.split("_")[1]);
  for (const k of keys) for (const t of c[k]) {
    out.push({ dia: t.dia_id, session: k, date: c[`${k}_date_time`],
      text: `[${c[`${k}_date_time`]}] ${t.speaker}: ${t.text}${t.blip_caption ? ` [shares an image: ${t.blip_caption}]` : ""}` });
  }
  return out;
}

async function exists(p) { try { await access(p); return true; } catch { return false; } }

async function prepareState() {
  await mkdir(CONTROL_ROOT, { recursive: true });
  await mkdir(MEMORY_ROOT, { recursive: true });
  const config = { litsanMemory: { version: 1, userId: "local-user", roleRouting: { summary: "follow", evolution: "follow" },
    storage: { mode: "local", backend: "sqlite", sqlitePath: join(MEMORY_ROOT, "memory.sqlite"), endpoint: `http://127.0.0.1:${CORE_PORT}`, token: TOKEN },
    algorithm: { enableMemoryAdd: true, enableMemorySearch: true, enableQueryRewrite: false },
    agentAccess: { autoScanKnownAgents: false, watchFileChanges: false, autoInjectSkill: false } },
    providers: {}, modelAssignments: { default: null, memorySummary: null, memoryEvolution: null, embedding: null, asr: null, imageGeneration: null },
    modelPresets: {}, app: {} };
  await writeFile(join(STATE_ROOT, "memory-config.yaml"), JSON.stringify(config, null, 2) + "\n");
  await writeFile(join(STATE_ROOT, "memhub.env"), [`MEMHUB_ACCOUNT_ID=${ACCOUNT_ID}`, `MEMHUB_OWNER_ACCOUNT_ID=${ACCOUNT_ID}`,
    "MEMHUB_OWNER_USER_ID=local-user", `MEMHUB_MEMORY_TOKEN=${TOKEN}`, `MEMHUB_MEMORY_URL=http://127.0.0.1:${CORE_PORT}`,
    `MEMHUB_STATE_ROOT=${CONTROL_ROOT}`].join("\n") + "\n", { mode: 0o600 });
}

async function startStack(derived, extraEnv = {}, root = ROOT) {
  // Another stack on these ports would answer the health check and receive our queries.
  try { await fetch(`http://127.0.0.1:${GATEWAY_PORT}/memhub/health`); throw new Error(`port ${GATEWAY_PORT} already in use; set P0_CORE_PORT`); }
  catch (error) { if (String(error?.message).includes("already in use")) throw error; }
  const env = { ...process.env, MEMHUB_HOME: STATE_ROOT, LITSAN_HOME: STATE_ROOT };
  for (const k of ["MEMHUB_DERIVED_FACT_RETRIEVAL", "LITSAN_DERIVED_FACT_RETRIEVAL", "MEMHUB_DERIVED_RAW_EVIDENCE", "LITSAN_DERIVED_RAW_EVIDENCE"]) delete env[k];
  if (derived) env.LITSAN_DERIVED_FACT_RETRIEVAL = derived;
  Object.assign(env, extraEnv);
  const stack = spawn(process.execPath, [resolve(root, "scripts", "run-stack.mjs"), "--home", STATE_ROOT,
    "--core-port", String(CORE_PORT), "--gateway-port", String(GATEWAY_PORT)], { cwd: root, env, stdio: ["ignore", "ignore", "pipe"] });
  let err = ""; stack.stderr.on("data", (c) => { err += c.toString(); });
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (stack.exitCode != null) throw new Error(`stack exited ${stack.exitCode}: ${err.slice(-2000)}`);
    try { if ((await fetch(`http://127.0.0.1:${GATEWAY_PORT}/memhub/health`)).ok) break; } catch {}
    if (Date.now() > deadline) throw new Error(`stack not healthy: ${err.slice(-2000)}`);
    await new Promise((r) => setTimeout(r, 300));
  }
  const client = new Client({ name: "locomo-derived", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${GATEWAY_PORT}/mcp`)));
  const call = async (name, args) => {
    const res = await client.callTool({ name, arguments: args });
    const text = res.content?.find((i) => i.type === "text")?.text;
    if (!text) throw new Error(`${name} returned no text`);
    if (res.isError) throw new Error(`${name}: ${text.slice(0, 400)}`);
    return text;
  };
  const stop = async () => { await client.close().catch(() => {}); stack.kill("SIGTERM"); await new Promise((r) => stack.once("exit", r)); };
  return { call, stop };
}

async function ingest() {
  const marker = join(OUT, "ingested.json");
  if (await exists(marker)) { console.log("ingest: already done"); return; }
  await prepareState();
  const registry = new JsonProjectRegistry(join(CONTROL_ROOT, "project-registry.json"));
  for (const conv of conversations) {
    try { await registry.create(ACCOUNT_ID, { projectId: projectOf(conv.sample_id), description: `LoCoMo ${conv.sample_id} (P0 eval)` }); }
    catch (e) { if (!/exist|duplicate|already/i.test(String(e))) throw e; }
  }
  const { call, stop } = await startStack(null);
  const captured = {};
  try {
    for (const conv of conversations) {
      const project = projectOf(conv.sample_id);
      for (const t of turnsOf(conv)) {
        const id = eventId(conv.sample_id, t.dia);
        await call("litsan_turn", { action: "open", event_id: id, project, workspace_project: project, user_text: t.text });
        await call("litsan_turn", { action: "commit", event_id: id, project, workspace_project: project, assistant_text: "[LoCoMo evidence boundary]" });
        captured[id] = { ts: new Date().toISOString(), text: t.text };
      }
      console.log("captured", conv.sample_id, Object.keys(captured).length);
    }
    await writeL2(captured);
  } finally { await stop(); }
  await writeFile(marker, JSON.stringify({ at: new Date().toISOString(), turns: Object.keys(captured).length }, null, 1));
}

// L2: one revision per conversation, facts = extracted records citing their L1 events. Written to
// Core through the same MemoryRestContextSource.distill call distillation submit uses, then
// recorded as the completed revision, so hydration and derived retrieval see a real Core revision.
async function writeL2(captured) {
  const runtime = createLitsanRuntime({ accountId: ACCOUNT_ID, ownerAccountId: ACCOUNT_ID, ownerUserId: "local-user",
    memoryEndpoint: `http://127.0.0.1:${CORE_PORT}`, memoryToken: TOKEN, controlRoot: CONTROL_ROOT, disableArchitecture: true });
  for (const conv of conversations) {
    const cid = conv.sample_id, project = projectOf(cid);
    const records = JSON.parse(await readFile(join(MH, "records", `${cid}.json`), "utf8")).records;
    const bySession = new Map();
    for (const r of records) {
      const refs = (r.dia_ids ?? []).map((d) => eventId(cid, d)).filter((id) => captured[id]);
      if (!refs.length || !r.statement) continue;
      const s = Math.min(...(r.dia_ids ?? []).map((d) => +d.split(":")[0].slice(1)));
      if (!bySession.has(s)) bySession.set(s, []);
      bySession.get(s).push(`- Atomic fact: ${r.statement.replace(/\s+/g, " ").trim()} | Evidence: ${refs.map((id) => `l1:${id}`).join(", ")}`);
    }
    const date = (s) => conv.conversation[`session_${s}_date_time`] ?? "";
    const content = ["# Timeline", ...[...bySession.keys()].sort((a, b) => a - b).flatMap((s) => [`## Session ${s} — ${date(s)}`, ...bySession.get(s)])].join("\n");
    const factMetadata = extractDistilledFactMetadata("l2", content);
    const evidence = Object.entries(captured).filter(([id]) => id.startsWith(`lc-${cid}-`)).map(([id, c]) => ({
      ref: `l1:${id}`, kind: "turn", layer: "L1", project_id: project, timestamp: c.ts, user_text: c.text }));
    const core = await runtime.memory.distill({ accountId: ACCOUNT_ID, userId: runtime.userId, kind: "l2", content, projectId: project,
      title: `${project} timeline`, tags: ["memory-v2", "layer:l2"], sourceHarness: "locomo-derived-eval",
      evidenceRefs: evidence.map((e) => e.ref), contractVersion: DISTILLATION_CONTRACT_VERSION, confidence: 0.9 });
    const resultId = core?.id ?? core?.memoryId;
    if (!resultId) throw new Error(`Core returned no id for ${cid}: ${JSON.stringify(core).slice(0, 300)}`);
    const job = await recordCompletedDistillationRevision({ stateRoot: CONTROL_ROOT, accountId: ACCOUNT_ID, target: "l2", projectId: project,
      resultId, content, committedAt: new Date().toISOString(), coreBody: content, factMetadata: factMetadata ?? undefined, evidence });
    console.log("l2", cid, "facts", factMetadata?.facts.length ?? 0, "core", resultId, "job", job.job_id);
  }
  runtime.dispose?.();
}

async function prewarm(root = ROOT) {
  const { prewarmDerivedFactRevisionIndex } = await import(resolve(root, "dist", "derived-fact-retrieval.js"));
  for (const job of await listDistillationJobs(CONTROL_ROOT, ACCOUNT_ID, true)) {
    if (job.status !== "completed" || job.target !== "l2" || !job.result_fact_metadata) continue;
    await prewarmDerivedFactRevisionIndex({ stateRoot: CONTROL_ROOT, accountId: ACCOUNT_ID, revisionId: job.job_id, memoryId: job.result_id,
      layer: "L2", factMetadata: job.result_fact_metadata, sourceEvidence: job.evidence });
  }
}

async function query() {
  await prepareState(); // rewrites the port-bearing config for P0_CORE_PORT
  const qs = await questionSets();
  const convIds = new Set(conversations.map((c) => c.sample_id));
  const rows = Object.entries(qs).flatMap(([part, list]) => list.map((r) => ({ ...r, part }))).filter((r) => convIds.has(r.conv));
  // C (P1): B plus LITSAN_DERIVED_RAW_EVIDENCE=always
  // P0_ARMS (rollout check) runs released code trees on the same state: [[name, root, flag, extraEnv], ...]
  const arms = process.env.P0_ARMS ? JSON.parse(process.env.P0_ARMS)
    : [["A", ROOT, null, {}], ["B", ROOT, "semantic", {}], ["C", ROOT, "semantic", { LITSAN_DERIVED_RAW_EVIDENCE: "always" }]];
  for (const [arm, root, flag, extra] of arms) {
    const file = join(OUT, `responses-${arm}.json`);
    if (await exists(file)) { console.log("query", arm, "already done"); continue; }
    if (flag) await prewarm(root);
    const { call, stop } = await startStack(flag, extra, root);
    const out = {};
    try {
      for (const r of rows) {
        const project = projectOf(r.conv);
        const t0 = performance.now();
        const text = await call("litsan_context", { query: r.question, project, workspace_project: project });
        out[r.id] = { ms: Math.round(performance.now() - t0), text };
      }
    } finally { await stop(); }
    await writeFile(file, JSON.stringify(out));
    console.log("query", arm, "done", rows.length);
  }
}

// P0_QUESTIONS swaps the question file ({part: [questions]}); P0_PARTS keeps only the named parts,
// so tuning arms can run on dev without touching the held-out parts.
async function questionSets() {
  const all = JSON.parse(await readFile(process.env.P0_QUESTIONS ?? join(MH, "questions.json"), "utf8"));
  const parts = process.env.P0_PARTS?.split(",");
  return Object.fromEntries(Object.entries(all).filter(([part]) => !parts || parts.includes(part)));
}

const norm = (s) => s.toLowerCase().replace(/\\n/g, " ").replace(/[^a-z0-9]+/g, " ").trim();

async function score() {
  const qs = await questionSets();
  const turnText = new Map();
  for (const conv of conversations) for (const t of turnsOf(conv)) turnText.set(eventId(conv.sample_id, t.dia), t.text.replace(/^\[[^\]]*\]\s*/, ""));
  const result = {};
  for (const arm of (process.env.P0_SCORE_ARMS ?? "A,B,C").split(",")) {
    if (!(await exists(join(OUT, `responses-${arm}.json`)))) continue;
    const resp = JSON.parse(await readFile(join(OUT, `responses-${arm}.json`), "utf8"));
    for (const part of Object.keys(qs)) {
      const rows = qs[part].filter((r) => r.evidence.length && resp[r.id]);
      let raw = 0, ref = 0, completeRaw = 0, completeAny = 0, bytes = 0;
      const ms = [];
      for (const r of rows) {
        const { text, ms: t } = resp[r.id];
        const hay = norm(text);
        const gold = r.evidence.map((d) => eventId(r.conv, d)).filter((id) => turnText.has(id));
        // raw: the turn's own words are delivered (first 60 normalized chars, or the whole turn if shorter)
        const rawHit = gold.map((id) => { const n = norm(turnText.get(id)); return hay.includes(n.slice(0, Math.min(60, n.length))); });
        const refHit = gold.map((id) => text.includes(`l1:${id}`));
        raw += rawHit.filter(Boolean).length / gold.length;
        ref += gold.map((_, i) => rawHit[i] || refHit[i]).filter(Boolean).length / gold.length;
        if (rawHit.every(Boolean)) completeRaw += 1;
        if (gold.every((_, i) => rawHit[i] || refHit[i])) completeAny += 1;
        bytes += Buffer.byteLength(text); ms.push(t);
      }
      ms.sort((a, b) => a - b);
      result[`${arm}:${part}`] = { n: rows.length, raw_recall: +(raw / rows.length).toFixed(3), raw_or_cited_recall: +(ref / rows.length).toFixed(3),
        complete_raw: completeRaw, complete_raw_or_cited: completeAny, mean_bytes: Math.round(bytes / rows.length),
        p50_ms: ms[Math.floor(ms.length * 0.5)], p95_ms: ms[Math.floor(ms.length * 0.95)] };
    }
  }
  await writeFile(join(OUT, process.env.P0_SCORE_FILE ?? "score.json"), JSON.stringify(result, null, 1));
  console.table(result);
}


// P6 follow-up retrieval: P0_FU_PLANS = {questionId: {queries: [...]}} written by followup/followup.mjs plan;
// every query goes through litsan_context under the N4200 flags (or P0_FU_ARM = [flag, extraEnv]).
// Output P0_FU_OUT = {questionId: [{query, ms, text}]}. No model call happens here.
async function followup() {
  await prepareState();
  const plans = JSON.parse(await readFile(process.env.P0_FU_PLANS, "utf8"));
  const file = join(OUT, process.env.P0_FU_OUT);
  if (await exists(file)) { console.log("followup already done", file); return; }
  const qs = await questionSets();
  const convIds = new Set(conversations.map((c) => c.sample_id));
  const rows = Object.values(qs).flat().filter((r) => convIds.has(r.conv) && plans[r.id]?.queries?.length);
  const [flag, extra] = process.env.P0_FU_ARM ? JSON.parse(process.env.P0_FU_ARM)
    : ["semantic", { LITSAN_DERIVED_RAW_EVIDENCE: "always", LITSAN_DERIVED_RAW_EVIDENCE_MAX: "16", LITSAN_DERIVED_RAW_EVIDENCE_ORDER: "cited_first",
        LITSAN_DERIVED_RAW_EVIDENCE_SEMANTIC_LEAD: "8", LITSAN_DERIVED_RAW_EVIDENCE_BYTES: "4200", LITSAN_CONTEXT_LEAN: "1" }];
  await prewarm();
  const { call, stop } = await startStack(flag, extra);
  const out = {};
  try {
    for (const r of rows) {
      const project = projectOf(r.conv);
      out[r.id] = [];
      for (const query of plans[r.id].queries.slice(0, 3)) {
        const t0 = performance.now();
        const text = await call("litsan_context", { query, project, workspace_project: project });
        out[r.id].push({ query, ms: Math.round(performance.now() - t0), text });
      }
    }
  } finally { await stop(); }
  await writeFile(file, JSON.stringify(out));
  console.log("followup done", rows.length, "questions");
}

if (step === "followup") await followup();

if (step === "ingest" || step === "all") await ingest();
if (step === "query" || step === "all") await query();
if (step === "score" || step === "all") await score();
