#!/usr/bin/env node
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EmbeddedMemoryCore } from "../dist/embedded-memory-core.js";
import { buildContextCapsule } from "../dist/context-capsule.js";
import { evaluateRetrievalBenchmark } from "../dist/evaluation-harness.js";
import { LocalMemoryRestClient } from "../dist/local-memory-client.js";
import { defaultMemoryUserId, MemoryRestContextSource } from "../dist/memory-source.js";
import { buildRetrievalScopeEnvelope, resolveProjectScope } from "../dist/project-scope.js";
import { buildTurnKnowledgePlan } from "../dist/turn-knowledge-plan.js";

const REPO = resolve(fileURLToPath(new URL("..", import.meta.url)));
const [suiteArg, outputArg] = process.argv.slice(2);
const rankingMode = process.argv.includes("--litsan-core") ? "memhub_core" : "memhub_v1";
const suitePath = resolve(suiteArg ?? join(REPO, "benchmarks/retrieval/p0-real-pipeline-suite.json"));
const outputPath = resolve(outputArg ?? join(REPO, ".review-runtime/benchmarks/p0-real-pipeline-observations.json"));
assertRepoLocal(suitePath, "suite");
assertRepoLocal(outputPath, "output");

const suite = JSON.parse(await readFile(suitePath, "utf8"));
if (!Array.isArray(suite.memory_fixtures) || !Array.isArray(suite.cases)) {
  throw new Error("real-pipeline suite requires memory_fixtures[] and cases[]");
}

const tempParent = join(REPO, ".tmp-tests");
await mkdir(tempParent, { recursive: true });
const root = await mkdtemp(join(tempParent, "retrieval-pipeline-benchmark-"));
assertRepoLocal(root, "benchmark state");
const memoryDir = join(root, "memory");
const configPath = join(root, "memory-config.yaml");
const dbPath = join(memoryDir, "memory.sqlite");
const port = await freePort();
const token = "retrieval-pipeline-benchmark-token";
let core;

try {
  await mkdir(memoryDir, { recursive: true });
  await writeFile(configPath, JSON.stringify({
    memmyMemory: {
      version: 1,
      userId: "local-user",
      roleRouting: { summary: "follow", evolution: "follow" },
      storage: {
        mode: "local",
        backend: "sqlite",
        sqlitePath: dbPath,
        endpoint: `http://127.0.0.1:${port}`,
        token
      },
      algorithm: {
        enableMemoryAdd: true,
        enableMemorySearch: true,
        enableQueryRewrite: false,
        retrieval: { llmFilterEnabled: false }
      },
      agentAccess: { autoScanKnownAgents: false, watchFileChanges: false, autoInjectSkill: false }
    },
    providers: {},
    modelAssignments: {
      default: null,
      memorySummary: null,
      memoryEvolution: null,
      embedding: null,
      asr: null,
      imageGeneration: null
    },
    modelPresets: {},
    app: {}
  }, null, 2) + "\n");

  core = new EmbeddedMemoryCore({ stateRoot: root, port, configPath, dbPath });
  await core.start();
  const client = new LocalMemoryRestClient({ endpoint: core.endpoint, token });
  const memory = new MemoryRestContextSource(client, undefined, rankingMode);
  const evidenceState = new Map();
  const memoryEvidence = new Map();
  const defaultAccount = suite.default_account ?? "benchmark-account-a";

  for (const fixture of suite.memory_fixtures) {
    const revisions = Array.isArray(fixture.revisions) ? fixture.revisions : [];
    if (!fixture.key || revisions.length === 0) throw new Error(`invalid benchmark fixture: ${fixture.key ?? "<missing>"}`);
    for (const [index, revision] of revisions.entries()) {
      const evidenceKey = requiredString(revision.evidence_key, `fixture ${fixture.key} evidence_key`);
      const state = requiredString(revision.state, `fixture ${fixture.key} state`);
      evidenceState.set(evidenceKey, state);
      const accountId = fixture.account ?? defaultAccount;
      const userId = defaultMemoryUserId(accountId);
      const projectId = fixture.project ?? null;
      const title = `${fixture.title ?? fixture.key} [${evidenceKey}]`;
      const content = `${requiredString(revision.content, `fixture ${fixture.key} content`)}\n\nBENCH_EVIDENCE[${evidenceKey}]`;
      const result = await memory.distill({
        accountId,
        userId,
        kind: fixture.kind,
        content,
        projectId,
        title,
        sourceHarness: "retrieval-pipeline-benchmark",
        artifactId: fixture.artifact_id ?? `benchmark:${fixture.key}`,
        ...(fixture.kind === "skill" ? { version: fixture.version ?? "1.0.0" } : {}),
        tags: ["benchmark:retrieval-pipeline", `benchmark-fixture:${fixture.key}`, `benchmark-state:${state}`],
        evidenceRefs: [`benchmark:${fixture.key}:${index}`],
        contractVersion: "memhub-distill-v3"
      });
      const memoryId = memoryResultId(result);
      if (memoryId) memoryEvidence.set(memoryId, evidenceKey);
    }
  }

  // The public add path commits text/FTS synchronously; local vector work may
  // complete just after the response. Keep the settle bounded and local.
  await sleep(250);

  const observations = [];
  for (const testCase of suite.cases) {
    const accountId = testCase.account ?? defaultAccount;
    const userId = defaultMemoryUserId(accountId);
    const projectId = testCase.project ?? null;
    const capabilityProjects = Array.isArray(testCase.capability_projects) ? testCase.capability_projects : [];
    const resolution = projectId ? resolveProjectScope({ workspaceProjectId: projectId }) : resolveProjectScope({});
    const scope = buildRetrievalScopeEnvelope({
      accountId,
      resolution,
      workspaceProjectId: projectId ?? undefined,
      projectStorageIds: projectId ? [projectId] : [],
      reusableSkillProjectIds: capabilityProjects,
      crossProjectSkillAllowed: capabilityProjects.length > 0
    });
    const started = performance.now();
    const recalled = await memory.recall({
      accountId,
      userId,
      query: requiredString(testCase.query, `case ${testCase.id ?? "<unknown>"} query`),
      scope,
      limit: Number.isFinite(testCase.limit) ? testCase.limit : 6
    });
    const retrievalLatency = performance.now() - started;
    const items = [...recalled.globalMemory, ...recalled.projectMemory, ...recalled.reusableSkills];
    const selectedEvidence = items.map((item) => evidenceForItem(item, memoryEvidence)).filter(Boolean);
    const capsule = buildContextCapsule({
      accountId,
      resolution,
      retrievalScope: scope,
      globalMemory: recalled.globalMemory,
      projectMemory: recalled.projectMemory,
      reusableSkills: recalled.reusableSkills,
      projectArchitecture: [],
      retrievalDiagnostics: recalled.diagnostics,
      query: testCase.query,
      detail: "full"
    });
    const tkpStarted = performance.now();
    const plan = await buildTurnKnowledgePlan({
      query: testCase.query,
      capsule,
      detail: "full"
    });
    const tkpLatency = performance.now() - tkpStarted;
    const itemById = new Map(items.map((item) => [item.id, item]));
    const tkpEntries = [...plan.required, ...plan.supporting];
    const tkpSelectedEvidence = tkpEntries
      .map((entry) => itemById.get(entry.id))
      .map((item) => item ? evidenceForItem(item, memoryEvidence) : null)
      .filter(Boolean);
    const tkpContextBytes = tkpEntries.reduce((sum, entry) => sum + planEntryBytes(entry), 0);
    observations.push({
      case_id: testCase.id ?? null,
      selected_evidence: selectedEvidence,
      current_claim_evidence: selectedEvidence.filter((ref) => evidenceState.get(ref) === "current"),
      superseded_evidence: selectedEvidence.filter((ref) => evidenceState.get(ref) === "superseded"),
      context_bytes: items.reduce((sum, item) => sum + Buffer.byteLength(item.content, "utf8"), 0),
      hydrate_count: 0,
      latency_ms: roundMs(retrievalLatency),
      retrieval_latency_ms: roundMs(retrievalLatency),
      tkp_latency_ms: roundMs(tkpLatency),
      tkp_selected_evidence: tkpSelectedEvidence,
      tkp_current_claim_evidence: tkpSelectedEvidence.filter((ref) => evidenceState.get(ref) === "current"),
      tkp_superseded_evidence: tkpSelectedEvidence.filter((ref) => evidenceState.get(ref) === "superseded"),
      tkp_context_bytes: tkpContextBytes,
      tkp_plan: {
        required: plan.required.map((entry) => ({ id: entry.id, kind: entry.kind, role: entry.role, reason: entry.reason })),
        supporting: plan.supporting.map((entry) => ({ id: entry.id, kind: entry.kind, role: entry.role, reason: entry.reason })),
        coverage: plan.coverage,
        sufficiency: plan.sufficiency
      },
      scope: {
        version: scope.version,
        account: scope.accountId,
        primary_project: scope.primaryProject,
        cross_project_skill_allowed: scope.crossProjectSkillAllowed,
        reusable_skill_projects: scope.reusableSkillProjectIds
      },
      core_status: recalled.diagnostics.coreStatus ?? [],
      selected_items: items.map((item) => ({
        id: item.id,
        layer: item.provenance?.memoryLayer ?? null,
        project: item.projectId ?? null,
        evidence: evidenceForItem(item, memoryEvidence)
      }))
    });
  }

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(observations, null, 2) + "\n");
  process.stdout.write(`${JSON.stringify({
    suite: suite.name,
    snapshot_id: suite.snapshot_id,
    ranking_mode: rankingMode,
    output: outputPath,
    metrics: evaluateRetrievalBenchmark(suite.cases, observations)
  }, null, 2)}\n`);
} finally {
  await core?.stop().catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}

function planEntryBytes(entry) {
  const passages = Array.isArray(entry.passages) ? entry.passages : [];
  if (passages.length === 0) return 0;
  return passages.reduce((sum, passage) => sum + Buffer.byteLength(String(passage.text ?? ""), "utf8"), 0);
}

function roundMs(value) {
  return Math.round(value * 10) / 10;
}

function evidenceForItem(item, memoryEvidence) {
  const marker = /BENCH_EVIDENCE\[([^\]]+)\]/.exec(item.content)?.[1];
  if (marker) return marker;
  const titleMarker = /\[(fixture:[^\]]+)\]/.exec(item.content)?.[1];
  return titleMarker ?? memoryEvidence.get(item.id) ?? null;
}

function memoryResultId(value) {
  if (!value || typeof value !== "object") return null;
  if (typeof value.id === "string") return value.id;
  if (value.item && typeof value.item === "object" && typeof value.item.id === "string") return value.item.id;
  if (value.memory && typeof value.memory === "object" && typeof value.memory.id === "string") return value.memory.id;
  return null;
}

function requiredString(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${field} must be non-empty`);
  return value.trim();
}

function assertRepoLocal(path, field) {
  const rel = relative(REPO, resolve(path));
  if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith("../") || rel.startsWith("..\\")) {
    throw new Error(`${field} must stay under memhubruntime`);
  }
}

async function freePort() {
  const server = createServer();
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unable to allocate benchmark port");
  await new Promise((resolveClose) => server.close(resolveClose));
  return address.port;
}

function sleep(ms) { return new Promise((resolveSleep) => setTimeout(resolveSleep, ms)); }
