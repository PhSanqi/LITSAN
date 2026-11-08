// LITSAN_DERIVED_RAW_EVIDENCE=always returns the exact L1 turns behind selected derived facts
// even when the fact bundle already looks sufficient; without it, a sufficient bundle adds no
// raw evidence. Runs an isolated stack on a temp state root with one Core-backed L2 revision.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { JsonProjectRegistry } from "../dist/project-registry.js";
import { extractDistilledFactMetadata } from "../dist/fact-metadata.js";
import { recordCompletedDistillationRevision } from "../dist/distillation-jobs.js";
import { createLitsanRuntime } from "../dist/runtime.js";
import { DISTILLATION_CONTRACT_VERSION } from "../dist/distillation-contract.js";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const STATE = await mkdtemp(join(tmpdir(), "litsan-raw-evidence-always-"));
const CONTROL = join(STATE, "server");
const ACCOUNT = "raw-evidence-account", TOKEN = "raw-evidence-token", PROJECT = "raw-evidence-project";
const CORE_PORT = 19310 + Math.floor(Math.random() * 40) * 2, GATEWAY_PORT = CORE_PORT + 1;
const TURNS = {
  "ev-pottery": "Melanie: I signed up for a pottery class last Tuesday and made my first bowl.",
  "ev-camping": "Melanie: We went camping by the lake with the kids last weekend.",
  "ev-noise": "Caroline: The weather has been rainy all week."
};

async function startStack(extraEnv) {
  const env = { ...process.env, LITSAN_HOME: STATE, LITSAN_DERIVED_FACT_RETRIEVAL: "semantic", ...extraEnv };
  if (!("LITSAN_DERIVED_RAW_EVIDENCE" in extraEnv)) delete env.LITSAN_DERIVED_RAW_EVIDENCE;
  const stack = spawn(process.execPath, [join(ROOT, "scripts", "run-stack.mjs"), "--home", STATE, "--core-port", String(CORE_PORT),
    "--gateway-port", String(GATEWAY_PORT)], { cwd: ROOT, env, stdio: ["ignore", "ignore", "pipe"] });
  let err = ""; stack.stderr.on("data", (c) => { err += c; });
  for (const deadline = Date.now() + 60_000; ;) {
    if (stack.exitCode != null) throw new Error(`stack exited: ${err.slice(-1500)}`);
    try { if ((await fetch(`http://127.0.0.1:${GATEWAY_PORT}/litsan/health`)).ok) break; } catch {}
    if (Date.now() > deadline) throw new Error(`stack not healthy: ${err.slice(-1500)}`);
    await new Promise((r) => setTimeout(r, 300));
  }
  const client = new Client({ name: "raw-evidence-always-e2e", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${GATEWAY_PORT}/mcp`)));
  const call = async (name, args) => {
    const res = await client.callTool({ name, arguments: args });
    const text = res.content?.find((i) => i.type === "text")?.text ?? "";
    assert.ok(!res.isError, `${name}: ${text.slice(0, 300)}`);
    return text;
  };
  return { call, stop: async () => { await client.close().catch(() => {}); stack.kill("SIGTERM"); await new Promise((r) => stack.once("exit", r)); } };
}

try {
  await mkdir(CONTROL, { recursive: true });
  await writeFile(join(STATE, "memory-config.yaml"), JSON.stringify({ litsanMemory: { version: 1, userId: "local-user",
    roleRouting: { summary: "follow", evolution: "follow" },
    storage: { mode: "local", backend: "sqlite", sqlitePath: join(STATE, "memory", "memory.sqlite"), endpoint: `http://127.0.0.1:${CORE_PORT}`, token: TOKEN },
    algorithm: { enableMemoryAdd: true, enableMemorySearch: true, enableQueryRewrite: false },
    agentAccess: { autoScanKnownAgents: false, watchFileChanges: false, autoInjectSkill: false } }, providers: {},
    modelAssignments: { default: null, memorySummary: null, memoryEvolution: null, embedding: null, asr: null, imageGeneration: null },
    modelPresets: {}, app: {} }));
  await mkdir(join(STATE, "memory"), { recursive: true });
  await writeFile(join(STATE, "memhub.env"), [`MEMHUB_ACCOUNT_ID=${ACCOUNT}`, `MEMHUB_OWNER_ACCOUNT_ID=${ACCOUNT}`, "MEMHUB_OWNER_USER_ID=local-user",
    `MEMHUB_MEMORY_TOKEN=${TOKEN}`, `MEMHUB_MEMORY_URL=http://127.0.0.1:${CORE_PORT}`, `MEMHUB_STATE_ROOT=${CONTROL}`].join("\n") + "\n");
  await new JsonProjectRegistry(join(CONTROL, "project-registry.json")).create(ACCOUNT, { projectId: PROJECT, description: "raw evidence e2e" });

  let stack = await startStack({});
  const at = {};
  for (const [id, text] of Object.entries(TURNS)) {
    await stack.call("litsan_turn", { action: "open", event_id: id, project: PROJECT, workspace_project: PROJECT, user_text: text });
    await stack.call("litsan_turn", { action: "commit", event_id: id, project: PROJECT, workspace_project: PROJECT, assistant_text: "[boundary]" });
    at[id] = new Date().toISOString();
  }
  const content = ["# Timeline", "## Hobbies",
    "- Atomic fact: Melanie took a pottery class and made her first bowl. | Evidence: l1:ev-pottery",
    "- Atomic fact: Melanie went camping by the lake with her kids. | Evidence: l1:ev-camping"].join("\n");
  const runtime = createLitsanRuntime({ accountId: ACCOUNT, ownerAccountId: ACCOUNT, ownerUserId: "local-user",
    memoryEndpoint: `http://127.0.0.1:${CORE_PORT}`, memoryToken: TOKEN, controlRoot: CONTROL, disableArchitecture: true });
  const evidence = Object.entries(TURNS).map(([id, text]) => ({ ref: `l1:${id}`, kind: "turn", layer: "L1", project_id: PROJECT, timestamp: at[id], user_text: text }));
  const core = await runtime.memory.distill({ accountId: ACCOUNT, userId: runtime.userId, kind: "l2", content, projectId: PROJECT,
    title: `${PROJECT} timeline`, tags: ["memory-v2", "layer:l2"], sourceHarness: "raw-evidence-e2e", evidenceRefs: evidence.map((e) => e.ref), contractVersion: DISTILLATION_CONTRACT_VERSION });
  await recordCompletedDistillationRevision({ stateRoot: CONTROL, accountId: ACCOUNT, target: "l2", projectId: PROJECT, resultId: core.id,
    content, committedAt: new Date().toISOString(), coreBody: content, factMetadata: extractDistilledFactMetadata("l2", content), evidence });
  runtime.dispose?.();
  const query = { query: "What pottery class did Melanie take and what did she make?", project: PROJECT, workspace_project: PROJECT };
  const adaptive = (text) => (JSON.parse(text).turnKnowledgePlan?.supporting ?? []).filter((s) => String(s.reason).startsWith("adaptive"));

  const withoutFlag = adaptive(await stack.call("litsan_context", query));
  await stack.stop();
  stack = await startStack({ LITSAN_DERIVED_RAW_EVIDENCE: "always" });
  const withFlag = adaptive(await stack.call("litsan_context", query));
  await stack.stop();

  assert.ok(withFlag.some((s) => s.evidence_ref === "l1:ev-pottery" && /pottery class/.test(s.passages?.[0]?.text ?? "")),
    `always: expected the raw pottery turn, got ${JSON.stringify(withFlag).slice(0, 400)}`);
  // Uncited turns may still fill lexical-fallback slots (existing behaviour); cited ones rank first.
  const rank = (ref) => withFlag.findIndex((s) => s.evidence_ref === ref);
  assert.ok(rank("l1:ev-noise") === -1 || rank("l1:ev-pottery") < rank("l1:ev-noise"), "cited turn must outrank uncited fallback");
  assert.ok(withFlag.length > withoutFlag.length, `always should add raw turns (${withoutFlag.length} -> ${withFlag.length})`);
  console.log(`derived-raw-evidence-always: ${withoutFlag.length} -> ${withFlag.length} raw passages; passed`);
} finally {
  await rm(STATE, { recursive: true, force: true });
}
