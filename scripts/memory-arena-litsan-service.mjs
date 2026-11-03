#!/usr/bin/env node
import http from "node:http";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { JsonProjectRegistry } from "../dist/project-registry.js";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const ARENA_ROOT = resolve(ROOT, ".review-runtime", "memory-arena");
const STATE_ROOT = resolve(process.env.MEMHUB_ARENA_STATE_ROOT || join(ARENA_ROOT, "state", "memhub"));
const CONTROL_ROOT = join(STATE_ROOT, "server");
const MEMORY_ROOT = join(STATE_ROOT, "memory");
const CORE_PORT = Number(process.env.MEMHUB_ARENA_CORE_PORT || 19110);
const GATEWAY_PORT = Number(process.env.MEMHUB_ARENA_GATEWAY_PORT || 19111);
const SERVICE_PORT = Number(process.env.MEMHUB_ARENA_SERVICE_PORT || 19092);
const ACCOUNT_ID = process.env.MEMHUB_ARENA_ACCOUNT_ID || "memory-arena-account";
const TOKEN = process.env.MEMHUB_ARENA_MEMORY_TOKEN || "memory-arena-test-token";
const RESET_ON_START = process.env.MEMHUB_ARENA_RESET === "1";

if (RESET_ON_START) await rm(STATE_ROOT, { recursive: true, force: true });
await prepareState();

const stack = spawn(process.execPath, [
  resolve(ROOT, "scripts", "run-stack.mjs"),
  "--home", STATE_ROOT,
  "--core-port", String(CORE_PORT),
  "--gateway-port", String(GATEWAY_PORT)
], {
  cwd: ROOT,
  env: { ...process.env, MEMHUB_HOME: STATE_ROOT },
  stdio: ["ignore", "ignore", "pipe"]
});

let stackError = "";
stack.stderr.on("data", (chunk) => { stackError += chunk.toString(); });
await waitForHealth();

const client = new Client({ name: "memhub-memory-arena", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${GATEWAY_PORT}/mcp`)));
const registry = new JsonProjectRegistry(join(CONTROL_ROOT, "project-registry.json"));
const generations = new Map();
const ensured = new Set();

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") {
      return send(res, 200, { ok: true, backend: "memhub", isolated_state: STATE_ROOT, core_port: CORE_PORT, gateway_port: GATEWAY_PORT });
    }
    if (req.method !== "POST") return send(res, 405, { error: "POST required" });
    const body = JSON.parse(await readBody(req));
    if (req.url === "/add") return send(res, 200, await add(body));
    if (req.url === "/search") return send(res, 200, await search(body));
    if (req.url === "/reset-user") return send(res, 200, resetUser(body));
    return send(res, 404, { error: "not found" });
  } catch (error) {
    return send(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(SERVICE_PORT, "127.0.0.1", () => {
  console.log(`memhub_arena_service=http://127.0.0.1:${SERVICE_PORT}`);
  console.log(`memhub_arena_state=${STATE_ROOT}`);
});

async function add(body) {
  const userId = requiredString(body.user_id, "user_id");
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (!messages.length) return { ok: true, skipped: true };
  const project = await projectFor(userId);
  const sessionId = body.session_key ?? body.conv_id ?? body.session_id ?? "";
  const committedEvents = [];

  // LoCoMo hands an adapter an entire session at once, but LITSAN's native L1
  // retrieval unit is a conversational turn.  Storing the whole session as one
  // giant turn makes Core index only the capture summary and hides facts that
  // occur later in the session.  Preserve benchmark messages as individual L1
  // evidence records so the Arena matches normal LITSAN capture granularity.
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index] ?? {};
    const role = String(message.role ?? "user");
    const name = String(message.name ?? message.speaker ?? role);
    const timestamp = message.chat_time ?? message.timestamp ?? message.session_date ?? "";
    const content = stringContent(message.content);
    const evidenceText = `${timestamp ? `[${timestamp}] ` : ""}${name} (${role}): ${content}`;
    const eventId = `arena-${createHash("sha256").update(`${project}\n${sessionId}\n${index}\n${evidenceText}`).digest("hex").slice(0, 24)}`;
    const opened = await call("memmy_turn", {
      action: "open",
      event_id: eventId,
      project,
      workspace_project: project,
      user_text: evidenceText
    });
    const committed = await call("memmy_turn", {
      action: "commit",
      event_id: opened.event_id ?? eventId,
      project,
      workspace_project: project,
      assistant_text: "[Memory Arena evidence boundary]"
    });
    committedEvents.push(committed.event_id ?? eventId);
  }

  return {
    ok: true,
    event_id: committedEvents.at(-1) ?? null,
    event_ids: committedEvents,
    project,
    ingested: committedEvents.length === messages.length,
    ingested_messages: committedEvents.length
  };
}

async function search(body) {
  const userId = requiredString(body.user_id, "user_id");
  const query = requiredString(body.query, "query");
  const topK = Math.max(1, Math.min(50, Number(body.top_k || 10)));
  const project = await projectFor(userId);
  const context = await call("memmy_context", { query, project, workspace_project: project, limit: topK });
  const memories = [];
  for (const item of context.projectMemory ?? []) {
    if (!item?.content) continue;
    memories.push({ id: item.id ?? "", memory: item.content, score: item.provenance?.retrievalV1?.fusedScore ?? item.provenance?.score ?? null, layer: item.provenance?.memoryLayer ?? null, evidence_ref: item.evidenceRef ?? null });
  }
  return { project, memories: memories.slice(0, topK), diagnostics: context.retrievalDiagnostics ?? null, tkp: context.turnKnowledgePlan ?? null };
}

function resetUser(body) {
  const userId = requiredString(body.user_id, "user_id");
  const generation = (generations.get(userId) ?? 0) + 1;
  generations.set(userId, generation);
  return { ok: true, user_id: userId, generation };
}

async function projectFor(userId) {
  const generation = generations.get(userId) ?? 0;
  const digest = createHash("sha256").update(userId).digest("hex").slice(0, 16);
  const project = `arena-${digest}-g${generation}`;
  if (!ensured.has(project)) {
    try {
      await registry.create(ACCOUNT_ID, { projectId: project, description: `Memory Arena isolated user ${digest}` });
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      if (!/exist|duplicate|already/i.test(text)) throw error;
    }
    ensured.add(project);
  }
  return project;
}

async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content?.find((item) => item.type === "text")?.text;
  if (!text) throw new Error(`${name} returned no text payload`);
  return JSON.parse(text);
}

async function prepareState() {
  await mkdir(CONTROL_ROOT, { recursive: true });
  await mkdir(MEMORY_ROOT, { recursive: true });
  const config = {
    memmyMemory: {
      version: 1,
      userId: "local-user",
      roleRouting: { summary: "follow", evolution: "follow" },
      storage: { mode: "local", backend: "sqlite", sqlitePath: join(MEMORY_ROOT, "memory.sqlite"), endpoint: `http://127.0.0.1:${CORE_PORT}`, token: TOKEN },
      algorithm: { enableMemoryAdd: true, enableMemorySearch: true, enableQueryRewrite: false },
      agentAccess: { autoScanKnownAgents: false, watchFileChanges: false, autoInjectSkill: false }
    },
    providers: {},
    modelAssignments: { default: null, memorySummary: null, memoryEvolution: null, embedding: null, asr: null, imageGeneration: null },
    modelPresets: {},
    app: {}
  };
  await writeFile(join(STATE_ROOT, "memory-config.yaml"), JSON.stringify(config, null, 2) + "\n");
  await writeFile(join(STATE_ROOT, "memhub.env"), [
    `MEMHUB_ACCOUNT_ID=${ACCOUNT_ID}`,
    `MEMHUB_OWNER_ACCOUNT_ID=${ACCOUNT_ID}`,
    "MEMHUB_OWNER_USER_ID=local-user",
    `MEMHUB_MEMORY_TOKEN=${TOKEN}`,
    `MEMHUB_MEMORY_URL=http://127.0.0.1:${CORE_PORT}`,
    `MEMHUB_STATE_ROOT=${CONTROL_ROOT}`
  ].join("\n") + "\n", { mode: 0o600 });
}

async function waitForHealth() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (stack.exitCode != null) throw new Error(`isolated LITSAN stack exited ${stack.exitCode}: ${stackError.slice(-2000)}`);
    try {
      const response = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/memhub/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
  }
  throw new Error(`isolated LITSAN stack did not become ready: ${stackError.slice(-2000)}`);
}

function stringContent(value) {
  if (typeof value === "string") return value;
  return JSON.stringify(value ?? "");
}
function requiredString(value, name) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${name} is required`);
  return text;
}
function readBody(req) { return new Promise((ok, fail) => { let body = ""; req.setEncoding("utf8"); req.on("data", (chunk) => body += chunk); req.on("end", () => ok(body)); req.on("error", fail); }); }
function send(res, status, value) { const body = JSON.stringify(value); res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) }); res.end(body); }

async function shutdown() {
  server.close();
  try { await client.close(); } catch {}
  stack.kill("SIGTERM");
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

