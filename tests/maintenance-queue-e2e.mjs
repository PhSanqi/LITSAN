import { closeCaptureIndexDb, listCaptureEvents } from "../dist/capture.js";
import { structureFingerprint, nodeEvidenceHash, maintenanceGenerators, registerMaintenanceGenerator } from "../dist/core/maintenance/registry.js";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { Readable } from "node:stream";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { registerContextTools } from "../dist/shell/mcp/register-context.js";
import { registerTurnTools } from "../dist/shell/mcp/register-turn.js";
import { handleMemoryControlAction } from "../dist/memory-control-actions.js";
import { renderConsole } from "../dist/web-ui.js";
import { registerCardTools } from "../dist/shell/mcp/register-card.js";
import { registerDistillTools } from "../dist/shell/mcp/register-distill.js";
import { registerMemoryTools } from "../dist/shell/mcp/register-memory.js";
import { JsonProjectBranchStore } from "../dist/branch-store.js";
import { setWorkstreamEnabled } from "../dist/workstream-config.js";
import { inlineJsonResult } from "../dist/shell/mcp/shared.js";
import { listDistillationJobs, leaseDistillationJob, recordCompletedDistillationRevision, mutateMaintenanceJob } from "../dist/distillation-jobs.js";
import { readMaintenanceStore, readMaintenanceLog, withMaintenanceStore, getMaintenanceConfig, setMaintenanceConfig, readMaintenanceOfferState, withMaintenanceOfferState } from "../dist/maintenance-store.js";
import { queueStatus, markRequested, maintenanceWaiting, ensureCards, nextCard, submitCard, releaseCard, offerForCommit, peekCard } from "../dist/maintenance-control.js";
import { buildArchitectureCognitiveMap, architectureCognitiveMapFingerprint } from "../dist/archify/architecture-cognitive-map.js";
import { readMemoryControlData } from "../dist/memory-control-plane.js";
import { hydrateMemoryEvidence } from "../dist/memory-hydration.js";
import { submitDistillationControl } from "../dist/distillation-submit.js";
import { validateDistillationEvidenceChain } from "../dist/distillation-evidence.js";
import { L2_INSTRUCTIONS } from "../dist/core/maintenance/chunk.js";
import { codexInlineHook } from "../dist/shell/recorders/codex-notify.js";
import { claudeHook } from "../dist/shell/recorders/claude-hook.js";
import { cardEstTokens } from "../dist/core/maintenance/estimate.js";
import { architectureDocRefs } from "../dist/archify/map-bootstrap.js";
import { registerArchReview } from "../dist/core/maintenance/arch-review.js";
import { FileProjectArchitectureSource } from "../dist/architecture-source.js";
import { mapBootstrapNext, mapBootstrapSubmit } from "../dist/shell/archify/map-bootstrap.js";
import { createTestRoot } from "./test-isolation.mjs";
const delegate = { execution: "delegate" }, harness = "test-harness";
function job(id, chars = 3600, count = 3) {
  const evidence = Array.from({ length: count }, (_, i) => ({ ref: `l1:${id}-${i}`, kind: "turn", layer: "L1", timestamp: `2026-10-${String(20 + i).padStart(2, "0")}T00:00:00Z`,
    project_id: "alpha", user_text: `User ${i}`, assistant_text: "a".repeat(chars) }));
  return { job_id: id, account_id: "acct", target: "l2", scope: "project", project_id: "alpha", status: "pending", reason: "manual", created_at: "2026-10-20T00:00:00Z",
    updated_at: "2026-10-20T00:00:00Z", evidence_hash: id, evidence_refs: evidence.map(e => e.ref), evidence };
}
const answer = (card, index = card.chunk?.index ?? 0) => ({ events: [{ date: `2026-10-${String(21 + index).padStart(2, "0")}`, title_en: `Capture event ${index}`, title_zh: `捕获事件${index}`,
  body_en: `Durable captured change ${index}.`, body_zh: `长期捕获变更${index}。`, evidence_refs: [card.allowed_refs[0]] }] });
async function fixture(t, jobs = [], architecture = false) {
  const stateRoot = await createTestRoot("maintenance-queue-");
  await mkdir(join(stateRoot, "distillation"), { recursive: true });
  await writeFile(join(stateRoot, "distillation", "jobs.json"), JSON.stringify({ version: 2, jobs }));
  let map = architecture ? buildArchitectureCognitiveMap({ projectId: "alpha", sourceEvidenceRefs: ["l1:initial"], generatedAt: "2026-10-01T00:00:00Z", candidate: {
    nodes: [{ id: "alpha", kind: "project", label: "Alpha", summary: "Alpha project", parent_id: null, order: 0, evidence_refs: ["l1:initial"], confidence: 1 },
      { id: "capture", kind: "domain", label: "Capture", summary: "Capture maintenance", parent_id: "alpha", order: 0, evidence_refs: ["l1:initial"], confidence: 0.9 }], edges: [], timeline_links: [] } }) : null;
  const writes = [], mapWrites = [];
  let failCore = 0, race = false, visualizationReads = 0, architectureLoads = 0;
  const runtime = {
    accountId: "acct", userId: "user-acct", source: { platform: harness, transport: "test" },
    projects: { resolve: async (_a, p) => ["alpha", "beta"].includes(p) ? p : p === "alias" ? "alpha" : null,
      list: async () => [{ projectId: "alpha", name: "Alpha", aliases: [], todos: [] }], storageIds: async (_a, p) => [p], suggest: async () => [], updateDistilledDescription: async () => { throw Error("unexpected description write"); } },
    memoryClient: { viewerGet: async path => {
      if (path.startsWith("/api/v1/memory/")) return { id: "timeline-alpha", status: "activated" };
      const latest = (await listDistillationJobs(stateRoot, "acct")).filter(j => j.status === "completed" && j.result_kind === "l2")
        .sort((a, b) => (a.result_committed_at ?? a.completed_at).localeCompare(b.result_committed_at ?? b.completed_at)).at(-1);
      return { items: latest ? [{ id: latest.result_id, projectId: "alpha", body: latest.result_content, updatedAt: latest.result_committed_at ?? latest.completed_at }] : [], hasNext: false };
    }, openSession: async () => ({}), completeTurn: async () => ({}) },
    memory: { distill: async input => { if (failCore-- > 0) throw Error("temporary test Core failure"); writes.push(input); return { id: input.kind === "l3" ? "profile-alpha" : "timeline-alpha", body: input.content }; } },
    architecture: { inspectProjectCognitiveMap: async () => ({ projectId: "alpha", path: "in-memory", exists: !!map, map: structuredClone(map), fingerprint: architectureCognitiveMapFingerprint(map) }),
      writeProjectCognitiveMap: async input => {
        if (race) { race = false; map.source_evidence_refs.push("l1:racing"); throw Error("fingerprint changed after it was read"); }
        assert.equal(input.expectedFingerprint, architectureCognitiveMapFingerprint(map)); mapWrites.push(input); map = structuredClone(input.map); return { after: { map } };
      }, getProjectArchitecture: async () => [],
      listProjectArchitectureMarkdown: async input => {
        assert.deepEqual(input, { accountId: "acct", projectId: "alpha" }); architectureLoads++;
        return [{ path: "z.md", content: "Architecture Z" }, { path: "a.md", content: "Architecture A" }];
      } },
    branches: new JsonProjectBranchStore(join(stateRoot, "branches.json"))
  };
  const deps = { stateRoot, runtime, harness, profile: delegate,
    readVisualization: async input => { assert.equal(input.kind, "visualization"); visualizationReads++; return readMemoryControlData(input); } };
  const server = new McpServer({ name: "maintenance-test", version: "1" });
  const context = { stateRoot, jsonResult: inlineJsonResult, inlineJsonResult };
  registerCardTools(server, { runtime, context }); registerDistillTools(server, { runtime, context }); registerTurnTools(server, { runtime, context }); registerMemoryTools(server, { runtime, context });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "maintenance-client", version: "1" }); await client.connect(clientTransport);
  // Windows cannot unlink open SQLite files: release the capture index before removing the state root.
  t.after(async () => { await client.close(); await server.close(); closeCaptureIndexDb(stateRoot); await rm(stateRoot, { recursive: true, force: true }); });
  const call = async (action, args = {}) => {
    const result = await client.callTool({ name: "litsan_card", arguments: { action, client_profile: delegate, ...args } });
    const text = result.content.map(c => c.text ?? "").join("");
    assert.equal(result.isError, undefined, text); return JSON.parse(text);
  };
  return { ...deps, deps, call, client, writes, mapWrites, get architectureLoads() { return architectureLoads; }, get visualizationReads() { return visualizationReads; }, get map() { return map; }, set map(value) { map = value; }, fail: () => { failCore = 1; }, race: () => { race = true; } };
}
async function seedTimeline(f, content = "# Timeline\n\n## 2026-10-19: Earlier history\n\nKeep earlier timeline intact.") {
  return recordCompletedDistillationRevision({ stateRoot: f.stateRoot, accountId: "acct", target: "l2", projectId: "alpha", resultId: "timeline-alpha", content,
    committedAt: "2026-10-19T00:00:00Z", evidence: [{ ref: "l1:initial", kind: "turn", layer: "L1", timestamp: "2026-10-19T00:00:00Z", project_id: "alpha", user_text: "initial", assistant_text: "history" }] });
}
test("retired code-review cards cannot be picked up after rollback", async t => {
  const f = await fixture(t, [job("keep-distilling", 500, 1)]);
  await ensureCards(f.deps);
  await withMaintenanceStore(f.stateRoot, "acct", Date.now(), async store => {
    const existing = store.cards.find(card => card.kind === "l2_chunk");
    for (const [id, project, status] of [["old-alpha", "alpha", "pending"], ["old-beta", "beta", "pending"], ["old-done", "alpha", "accepted"]])
      store.cards.push({ ...structuredClone(existing), card_id: id, kind: "code_change_review", project_id: project, status });
  });
  await ensureCards({ ...f.deps, projectId: "alpha" });
  const cards = (await readMaintenanceStore(f.stateRoot, "acct")).cards;
  assert.equal(cards.find(card => card.card_id === "old-alpha").status, "superseded");
  assert.equal(cards.find(card => card.card_id === "old-beta").status, "pending");
  assert.equal(cards.find(card => card.card_id === "old-done").status, "accepted");
  assert.equal((await f.call("next", { project: "alpha", kinds: ["l2_chunk"] })).card.kind, "l2_chunk");
});
test("existing L2 cards refresh instructions without exceeding client token limits", async t => {
  const f = await fixture(t, [job("legacy-card", 500, 1)]);
  await ensureCards(f.deps);
  await withMaintenanceStore(f.stateRoot, "acct", Date.now(), async store => {
    const oldCard = store.cards.find(card => card.kind === "l2_chunk");
    oldCard.instructions = "Legacy card instructions.";
    oldCard.est_tokens = cardEstTokens(oldCard);
  });
  const oldCard = (await readMaintenanceStore(f.stateRoot, "acct")).cards.find(card => card.kind === "l2_chunk");
  const updatedEstimate = cardEstTokens({ ...oldCard, instructions: L2_INSTRUCTIONS });
  assert.ok(updatedEstimate > oldCard.est_tokens);
  await assert.rejects(nextCard({ ...f.deps, cardId: oldCard.card_id,
    profile: { execution: "delegate", max_card_tokens: oldCard.est_tokens } }), /card_too_large/);
  const card = (await f.call("next", { card_id: oldCard.card_id })).card;
  assert.equal(card.instructions, L2_INSTRUCTIONS);
  assert.equal(card.est_tokens, updatedEstimate);
});
test("maintenance MCP L2 chunks reject bad refs, preserve timeline, merge through normal L3 pipeline", async t => {
  const f = await fixture(t, [job("chunks", 9000)]); await seedTimeline(f);
  const status = await f.call("queue_status", { project: "alpha" }); assert.equal(status.kinds.l2_chunk.pending, 3);
  assert.equal(Buffer.byteLength(JSON.stringify(status)) <= 1024, true);
  let card = (await f.call("next")).card;
  const bad = answer(card); bad.events[0].evidence_refs = ["l1:alien"];
  const rejected = await f.call("submit", { card_id: card.card_id, lease_token: card.lease_token, answer: bad });
  assert.equal(rejected.code, "ref_not_allowed"); assert.equal(f.writes.length, 0);
  assert.equal((await readMaintenanceStore(f.stateRoot, "acct")).cards.find(c => c.card_id === card.card_id).status, "pending");
  const cards = (await readMaintenanceStore(f.stateRoot, "acct")).cards.filter(c => c.kind === "l2_chunk").sort((a, b) => a.chunk.index - b.chunk.index);
  assert.equal(cards.length, 3);
  await assert.rejects(nextCard({ ...f.deps, cardId: cards[1].card_id }), /unavailable/);
  for (const chunk of cards) {
    card = (await f.call("next", { card_id: chunk.card_id })).card;
    assert.equal(card.card_id, chunk.card_id);
    assert.equal(card.input.prior_events.length, chunk.chunk.index);
    assert.equal((await f.call("next", { kinds: ["l2_chunk"] })).card, null, "later chunks remain blocked while the current chunk is leased");
    const accepted = await f.call("submit", { card_id: card.card_id, lease_token: card.lease_token, answer: answer(chunk, chunk.chunk.index) });
    assert.equal(accepted.ok, true); assert.equal(accepted.merge_error, undefined);
    if (chunk === cards[0]) {
      assert.equal((await listDistillationJobs(f.stateRoot, "acct")).find(j => j.job_id === "chunks").maintenance_split_locked, true);
      for (const useLeaseToken of [false, true]) assert.equal(await leaseDistillationJob(f.stateRoot, "acct", { harness: "legacy", useLeaseToken, target: "l2" }), null);
    }
  }
  assert.equal(f.writes.length, 1); assert.match(f.writes[0].content, /Earlier history/);
  const content = f.writes[0].content;
  assert.ok(content.indexOf("2026-10-21:") < content.indexOf("2026-10-22:") && content.indexOf("2026-10-22:") < content.indexOf("2026-10-23:"));
  const jobs = await listDistillationJobs(f.stateRoot, "acct"); const completed = jobs.find(j => j.job_id === "chunks"); assert.equal(completed.status, "completed");
  assert.deepEqual(completed.result_fact_metadata?.facts.map(fact => [fact.text, fact.evidence_refs]),
    [0, 1, 2].map(i => [`Durable captured change ${i}.`, [`l1:chunks-${i}`]]));
  const hydrated = await hydrateMemoryEvidence({ stateRoot: f.stateRoot, accountId: "acct", evidenceRef: "l2:timeline-alpha:chunks" });
  assert.deepEqual(hydrated.fact_metadata?.facts.map(fact => [fact.text, fact.evidence_refs]),
    [0, 1, 2].map(i => [`Durable captured change ${i}.`, [`l1:chunks-${i}`]]));
  assert.equal(jobs.filter(j => j.target === "l3" && j.evidence_refs.includes("l2:timeline-alpha:chunks")).length, 1);
  const l3 = await leaseDistillationJob(f.stateRoot, "acct", { harness, projectId: "alpha", target: "l3", useLeaseToken: true });
  assert.ok(l3?.lease_token);
  const l3Ref = "l2:timeline-alpha:chunks";
  const l3Result = await submitDistillationControl({ stateRoot: f.stateRoot, runtime: f.runtime, sourceHarness: harness, leaseToken: l3.lease_token,
    args: { job_id: l3.job_id, content: `# Current Truth\n\n## Capture / 捕获\n\nAtomic fact: Captured changes are durable. | Evidence: ${l3Ref}\n\n捕获的变更长期有效。` },
    resolveToolScope: async () => ({ projectId: "alpha", resolutionSource: "explicit" }), validateDistillationEvidenceChain });
  assert.equal(l3Result.fact_metadata?.fact_count, 1);
  const l3Hydrated = await hydrateMemoryEvidence({ stateRoot: f.stateRoot, accountId: "acct", evidenceRef: `l3:profile-alpha:${l3.job_id}` });
  assert.deepEqual(l3Hydrated.fact_metadata?.facts[0]?.evidence_refs, [l3Ref]);
  assert.equal((await readMaintenanceStore(f.stateRoot, "acct")).sets[0].status, "merged");
  assert.ok((await readMaintenanceLog(f.stateRoot, "acct")).some(e => e.outcome === "rejected"));
});
test("maintenance arch links preserve generated_at, siblings and provenance; fence structural changes", async t => {
  const f = await fixture(t, [], true);
  await seedTimeline(f, "# Timeline\n\n## 2026-10-19: Capture initial\nInitial facts.\n\n## 2026-10-20: Capture later\nLater facts.\n\n## 2026-10-21: Capture newest\nNewest facts.");
  await f.call("queue_status");
  const cards = (await readMaintenanceStore(f.stateRoot, "acct")).cards.filter(c => c.kind === "arch_link"); assert.equal(cards.length, 3);
  const generated = f.map.generated_at;
  const link = { links: [{ architecture_refs: ["capture"], architecture_level: "domain", change_kind: "refine", confidence: 0.9 }] };
  for (const c of cards.slice(0, 2)) {
    const card = (await f.call("next", { card_id: c.card_id })).card;
    if (c === cards[0]) f.race();
    assert.equal((await f.call("submit", { card_id: card.card_id, lease_token: card.lease_token, answer: link })).ok, true);
  }
  assert.equal(f.map.timeline_links.length, 2); assert.ok(f.map.timeline_links.every(l => !Object.hasOwn(l, "card_id"))); assert.equal(f.map.generated_at, generated);
  assert.ok(f.map.source_evidence_refs.includes(cards[0].allowed_refs[0]));
  const stale = (await f.call("next", { card_id: cards[2].card_id })).card;
  f.map.nodes[1].label += " changed";
  const writes = f.mapWrites.length;
  assert.equal((await f.call("submit", { card_id: stale.card_id, lease_token: stale.lease_token, answer: link })).code, "stale_fingerprint");
  assert.equal(f.mapWrites.length, writes);
});
test("maintenance MCP preserves historical code owners through map parsing after an unrelated commit", async t => {
  const f = await fixture(t, [], true);
  const root = join(f.stateRoot, "architecture"), repo = join(root, "alpha");
  await mkdir(join(repo, "src", "core"), { recursive: true });
  await mkdir(join(repo, ".memhub"));
  await writeFile(join(repo, "ARCHITECTURE.md"), "# Alpha\nBounded capture.\n");
  await writeFile(join(repo, "src", "core", "capture.ts"), "export const LIMIT = 8;\n");
  await writeFile(join(repo, ".memhub", "layers.json"), JSON.stringify({ layers: [{ name: "core", paths: ["src/core/**"] }], allowed: { core: [] } }));
  const git = (...args) => promisify(execFile)("git", ["-C", repo, ...args]);
  const commit = () => git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "-qm", "fixture");
  await git("init", "-q"); await git("add", "."); await commit();
  f.runtime.architecture = new FileProjectArchitectureSource({ rootDir: root, managedRootDir: join(root, "managed") });
  await seedTimeline(f, "# Timeline\n\n## 2026-10-19: Capture initial\nInitial capture.\n\n## 2026-10-20: Capture bounded\nBounded capture.");
  const pkg = await mapBootstrapNext(f.runtime, { stateRoot: f.stateRoot, projectId: "alpha" });
  const module = pkg.code.items.find(item => item.kind === "module"), constant = pkg.code.items.find(item => item.kind === "constant");
  const candidate = { nodes: f.map.nodes.map(node => ({ ...node, evidence_refs: [module.ref] })), edges: [], timeline_links: [] };
  candidate.nodes[1].facts = [{ key: "limit", value: 8, evidence_refs: [constant.ref], confidence: .95 }];
  await mapBootstrapSubmit(f.runtime, { stateRoot: f.stateRoot, projectId: "alpha", base_fingerprint: pkg.base_fingerprint, architecture_map: candidate });
  const read = () => f.runtime.architecture.inspectProjectCognitiveMap({ accountId: "acct", projectId: "alpha" });
  const before = await read();
  await writeFile(join(repo, "README.md"), "Unrelated documentation.\n"); await git("add", "."); await commit();
  assert.notEqual((await f.runtime.architecture.getProjectCodeEvidence({ accountId: "acct", projectId: "alpha" })).revision, pkg.code.revision);
  for (let i = 0; i < 2; i++) {
    const card = (await f.call("next", { project: "alpha", kinds: ["arch_link"] })).card;
    assert.ok(card);
    const result = await f.call("submit", { project: "alpha", card_id: card.card_id, lease_token: card.lease_token,
      answer: { links: [{ architecture_refs: ["capture"], architecture_level: "domain", change_kind: "refine", confidence: .9 }] } });
    assert.equal(result.ok, true);
  }
  const after = await read();
  assert.deepEqual(after.map.nodes, before.map.nodes);
  assert.equal(after.map.generated_at, before.map.generated_at);
  assert.equal(after.map.timeline_links.length, 2);
  assert.equal(after.map.nodes[1].facets.layer, "core");
  const changed = structuredClone(after.map); changed.nodes[1].facts[0].value = 99;
  await assert.rejects(f.runtime.architecture.writeProjectCognitiveMap({ accountId: "acct", projectId: "alpha", expectedFingerprint: after.fingerprint, map: changed }), /stale code evidence/);
  assert.equal((await read()).fingerprint, after.fingerprint);
});
test("maintenance arch links refill after draining a bounded batch without replaying no-fit answers", async t => {
  const f = await fixture(t, [], true);
  await seedTimeline(f, "# Timeline\n\n" + Array.from({ length: 21 }, (_, i) =>
    `## 2026-10-${String(i + 1).padStart(2, "0")}: Capture ${i}\nCapture change ${i}.`).join("\n\n"));
  assert.equal((await f.call("queue_status", { project: "alpha" })).kinds.arch_link.pending, 20);
  const ids = new Set();
  for (let i = 0; i < 21; i++) {
    const card = (await f.call("next", { project: "alpha", kinds: ["arch_link"] })).card;
    assert.ok(card, `card ${i + 1} should refill from the remaining timeline events`);
    assert.ok(!ids.has(card.card_id)); ids.add(card.card_id);
    const answer = i % 2 ? { no_fit: true, reason: "No structural change in this fixture event." }
      : { links: [{ architecture_refs: ["capture"], architecture_level: "domain", change_kind: "refine", confidence: .9 }] };
    assert.equal((await f.call("submit", { project: "alpha", card_id: card.card_id, lease_token: card.lease_token, answer })).ok, true);
  }
  assert.equal((await f.call("next", { project: "alpha", kinds: ["arch_link"] })).card, null);
  assert.equal((await f.call("queue_status", { project: "alpha", dry: true })).kinds.arch_link.pending, 0);
  assert.equal(f.map.timeline_links.length, 11);
});
test("maintenance containment, expiry/reclaim, release, inline cap and account filtering", async t => {
  const f = await fixture(t, [job("leases")]); await ensureCards(f.deps);
  assert.equal((await f.call("next", { client_profile: { execution: "inline", max_card_tokens: 8000 } })).card, null);
  const card = (await f.call("next")).card;
  assert.equal((await f.call("submit", { card_id: card.card_id, lease_token: card.lease_token, project: "beta", answer: answer(card) })).code, "wrong_project");
  const re = card;
  assert.deepEqual((await readMaintenanceStore(f.stateRoot, "acct")).cards.find(c => c.card_id === re.card_id).lease.token, re.lease_token);
  const other = { ...f.deps, runtime: { ...f.runtime, accountId: "other" } };
  const before = await readFile(join(f.stateRoot, "maintenance", "cards.json"), "utf8");
  assert.equal((await submitCard({ ...other, cardId: re.card_id, leaseToken: re.lease_token, answer: answer(re) })).code, "wrong_account");
  assert.equal(await readFile(join(f.stateRoot, "maintenance", "cards.json"), "utf8"), before);
  assert.equal((await readMaintenanceStore(f.stateRoot, "other")).cards.length, 0);
  assert.equal((await f.call("release", { card_id: re.card_id, lease_token: re.lease_token })).ok, true);
  const now = Date.now(), leased = (await nextCard({ ...f.deps, cardId: re.card_id, now, leaseSeconds: 30 })).card;
  assert.equal((await submitCard({ ...f.deps, cardId: leased.card_id, leaseToken: leased.lease_token, answer: answer(leased), now: now + 30001 })).code, "lease_expired");
  const old = leased;
  const reclaimed = (await nextCard({ ...f.deps, cardId: re.card_id, now: now + 30001 })).card;
  assert.notEqual(old.lease_token, reclaimed.lease_token);
  assert.equal((await submitCard({ ...f.deps, cardId: old.card_id, leaseToken: old.lease_token, answer: answer(old), now: now + 30002 })).code, "lease_token_stale");
  const logs = await readMaintenanceLog(f.stateRoot, "acct"); for (const outcome of ["leased", "rejected", "released", "expired"]) assert.ok(logs.some(e => e.outcome === outcome));
});
test("maintenance accepted partials lock legacy workers; three answer rejects abort", async t => {
  const g = await fixture(t, [job("partial", 9000)]); await ensureCards(g.deps);
  let card = (await g.call("next")).card;
  assert.equal((await g.call("submit", { card_id: card.card_id, lease_token: card.lease_token, answer: answer(card) })).ok, true);
  assert.equal(await leaseDistillationJob(g.stateRoot, "acct", { harness: "legacy", useLeaseToken: true }), null);
  card = (await g.call("next")).card;
  for (let i = 0; i < 3; i++) {
    if (i) card = (await g.call("next", { card_id: card.card_id })).card;
    assert.equal((await g.call("submit", { card_id: card.card_id, lease_token: card.lease_token, answer: { events: [] } })).code, "schema_invalid");
  }
  const store = await readMaintenanceStore(g.stateRoot, "acct"); assert.equal(store.sets[0].status, "aborted"); assert.ok(store.cards.every(c => c.status === "superseded"));
  const parent = (await listDistillationJobs(g.stateRoot, "acct"))[0]; assert.equal(parent.maintenance_background_only, true); assert.equal(parent.split_card_set, undefined); assert.equal(parent.maintenance_split_locked, undefined);
});
test("maintenance merge retries without double commit, skip-all uses noop path", async t => {
  const f = await fixture(t, [job("retry", 100, 1)]); await seedTimeline(f); f.fail();
  const card = (await f.call("next")).card;
  const now = Date.now() + 12345;
  const result = await submitCard({ ...f.deps, cardId: card.card_id, leaseToken: card.lease_token, answer: answer(card), now });
  assert.equal((await listDistillationJobs(f.stateRoot, "acct")).find(j => j.job_id === "retry").leased_until, new Date(now + 900000).toISOString());
  assert.match(result.merge_error, /temporary/); assert.equal(result.set_status, "open");
  let logs = await readMaintenanceLog(f.stateRoot, "acct");
  assert.equal(logs.filter(e => e.outcome === "merge_failed").length, 1);
  assert.equal(logs.filter(e => e.outcome === "accepted").length, 1);
  assert.equal((await queueStatus({ ...f.deps, dry: true })).kinds.l2_chunk.accepted_today, 1);
  await ensureCards(f.deps); await ensureCards(f.deps);
  assert.equal((await readMaintenanceStore(f.stateRoot, "acct")).sets[0].status, "merged"); assert.equal(f.writes.length, 1);
  const g = await fixture(t, [job("noop", 100, 1)]); const empty = (await g.call("next")).card;
  const noop = await g.call("submit", { card_id: empty.card_id, lease_token: empty.lease_token, answer: { events: [], skip_reason: "No durable change" } });
  assert.equal(noop.merge_error, undefined); assert.equal(g.writes.length, 0);
  assert.equal((await listDistillationJobs(g.stateRoot, "acct"))[0].result_kind, "noop");
});
test("maintenance dry status does not generate, oversized evidence stays whole, stale jobs supersede", async t => {
  const f = await fixture(t, [job("huge", 40000, 1), job("changed", 100, 1)]);
  assert.equal((await queueStatus({ ...f.deps, dry: true })).kinds.l2_chunk.pending, 0);
  await ensureCards(f.deps); assert.equal((await queueStatus({ ...f.deps, dry: true })).background_only_jobs, 1);
  await mutateMaintenanceJob(f.stateRoot, "acct", "changed", j => { j.evidence_hash = "changed hash"; });
  await ensureCards(f.deps);
  const store = await readMaintenanceStore(f.stateRoot, "acct"); assert.ok(store.cards.some(c => c.status === "superseded"));
});
test("maintenance store retains open partials and isolates pruning across accounts", async t => {
  const f = await fixture(t, [job("retention", 9000)]); await ensureCards(f.deps);
  const old = "2020-01-01T00:00:00Z";
  await withMaintenanceStore(f.stateRoot, "acct", Date.now(), async store => { store.cards[0].status = "accepted"; store.cards[0].updated_at = old; });
  assert.equal((await readMaintenanceStore(f.stateRoot, "acct")).cards.length, 3);
  assert.equal((await readMaintenanceStore(f.stateRoot, "acct")).cards[0].status, "accepted");
  await withMaintenanceStore(f.stateRoot, "other", Date.now(), async store => {
    store.cards.push({ ...(await readMaintenanceStore(f.stateRoot, "acct")).cards[0], account_id: "other", card_id: "other-old" });
  });
  assert.equal((await readMaintenanceStore(f.stateRoot, "other")).cards.length, 0, "unprotected old cards are pruned only in their account");
  assert.equal((await readMaintenanceStore(f.stateRoot, "acct")).cards.length, 3, "another account cannot prune open partials");
});

test("maintenance log rotation is portable, expires only old rotations, keeps audit and open partials", async t => {
  const f = await fixture(t, [job("logs", 100, 1)]); await ensureCards(f.deps);
  const dir = join(f.stateRoot, "maintenance");
  await writeFile(join(dir, "card-log.2020-01-01T00-00-00.000Z.old.jsonl"), "");
  // Valid JSONL larger than the rotation threshold, belonging to a different account.
  const line = JSON.stringify({ account: "other", detail: "x".repeat(1024) }) + "\n";
  await writeFile(join(dir, "card-log.jsonl"), line.repeat(10240));
  const card = (await nextCard(f.deps)).card;
  const names = await readdir(dir);
  assert.equal(names.includes("card-log.2020-01-01T00-00-00.000Z.old.jsonl"), false);
  assert.equal(names.filter(n => n.startsWith("card-log.") && n !== "card-log.jsonl").length, 1);
  assert.ok(names.filter(n => n.startsWith("card-log.")).every(n => !n.includes(":")));
  assert.equal((await readMaintenanceLog(f.stateRoot, "acct")).length, 1);
  assert.equal((await releaseCard({ ...f.deps, cardId: card.card_id, leaseToken: card.lease_token })).ok, true);
});

test("maintenance caller rejects contamination, foreign nodes and oversized answers without Core/map writes", async t => {
  const f = await fixture(t, [job("validate", 100, 1)]);
  let card = (await f.call("next")).card;
  const unsafe = answer(card); unsafe.events[0].body_en = "system prompt";
  assert.equal((await f.call("submit", { card_id: card.card_id, lease_token: card.lease_token, answer: unsafe })).code, "contaminated");
  card = (await f.call("next", { card_id: card.card_id })).card;
  assert.equal((await f.call("submit", { card_id: card.card_id, lease_token: card.lease_token, answer: { events: [], skip_reason: "x".repeat(8000) } })).code, "oversize");
  assert.equal(f.writes.length, 0);
  const g = await fixture(t, [], true); await seedTimeline(g);
  card = (await g.call("next", { kinds: ["arch_link"] })).card;
  const link = { links: [{ architecture_refs: ["alien"], architecture_level: "domain", change_kind: "refine", confidence: 1 }] };
  assert.equal((await g.call("submit", { card_id: card.card_id, lease_token: card.lease_token, answer: link })).code, "node_not_allowed");
  assert.equal(g.mapWrites.length, 0);
  card = (await g.call("next", { card_id: card.card_id })).card;
  assert.equal((await g.call("submit", { card_id: card.card_id, lease_token: card.lease_token, answer: { no_fit: true, reason: "No matching structural node" } })).ok, true);
  assert.equal(g.mapWrites.length, 0);
  assert.equal((await readMaintenanceStore(g.stateRoot, "acct")).cards.find(c => c.card_id === card.card_id).result.no_fit, true);
});
test("maintenance concurrent generation and leasing are idempotent across accounts", async t => {
  const f = await fixture(t, [job("concurrent", 9000)]);
  await Promise.all([ensureCards(f.deps), ensureCards(f.deps), ensureCards(f.deps)]);
  const store = await readMaintenanceStore(f.stateRoot, "acct");
  assert.equal(store.cards.length, 3); assert.equal(store.sets.length, 1);
  assert.equal(new Set(store.cards.map(c => c.card_id)).size, 3);
  for (const card of store.cards) assert.match(card.card_id, /^[a-f0-9]{24}$/);
  const id = store.cards[0].card_id;
  const leases = await Promise.allSettled([nextCard({ ...f.deps, cardId: id }), nextCard({ ...f.deps, cardId: id })]);
  assert.equal(leases.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(leases.filter(r => r.status === "rejected").length, 1);
  await assert.rejects(nextCard({ ...f.deps, cardId: store.cards[1].card_id }), /unavailable/);
  assert.equal((await nextCard(f.deps)).card, null, "concurrent requests cannot lease a later chunk");
  const held = leases.find(r => r.status === "fulfilled").value.card;
  assert.equal((await submitCard({ ...f.deps, cardId: held.card_id, leaseToken: held.lease_token, answer: answer(held) })).ok, true);
  await assert.rejects(nextCard({ ...f.deps, cardId: store.cards[1].card_id, profile: { execution: "inline" } }), /card_too_large/);
  const g = await fixture(t, [job("tiny-a", 100, 1), job("tiny-b", 100, 1)]);
  await Promise.all([ensureCards(g.deps), ensureCards(g.deps), ensureCards(g.deps)]);
  const coalesced = await readMaintenanceStore(g.stateRoot, "acct");
  assert.equal(coalesced.sets.length, 1, "concurrent generation coalesces tiny jobs once");
  assert.equal(coalesced.cards.length, 1);
  assert.deepEqual(coalesced.sets[0].parent_job_ids, ["tiny-a", "tiny-b"]);
  assert.deepEqual(coalesced.cards[0].allowed_refs, ["l1:tiny-a-0", "l1:tiny-b-0"]);
});

for (const leaseTokenSupported of [false, true]) test(`maintenance soft split yields to legacy next (token=${leaseTokenSupported})`, async t => {
  const f = await fixture(t, [job("legacy")]);
  await f.call("queue_status");
  const held = (await f.call("next")).card;
  const result = await f.client.callTool({ name: "litsan_distill", arguments: { action: "next", ...(leaseTokenSupported ? { lease_token_supported: true } : {}) } });
  assert.equal(result.isError, undefined);
  const legacy = JSON.parse(result.content.map(c => c.text ?? "").join("")).job;
  assert.equal(legacy.job_id, "legacy"); assert.equal(Boolean(legacy.lease_token), leaseTokenSupported);
  await f.call("queue_status");
  const store = await readMaintenanceStore(f.stateRoot, "acct");
  assert.equal(store.sets[0].status, "aborted"); assert.ok(store.cards.every(c => c.status === "superseded"));
  const before = await readFile(join(f.stateRoot, "distillation", "jobs.json"), "utf8");
  const parent = (await listDistillationJobs(f.stateRoot, "acct"))[0];
  assert.equal(parent.split_card_set, undefined); assert.equal(parent.maintenance_split_locked, undefined);
  assert.equal(parent.maintenance_background_only, undefined); assert.equal(parent.status, "leased");
  assert.equal((await f.call("submit", { card_id: held.card_id, lease_token: held.lease_token, answer: answer(held) })).code, "stale_fingerprint");
  assert.equal(await readFile(join(f.stateRoot, "distillation", "jobs.json"), "utf8"), before);
  assert.equal(f.writes.length, 0);
});
test("maintenance identity failures are log-only; three wrong tokens preserve the real lease", async t => {
  const f = await fixture(t, [job("identity")]);
  const held = (await f.call("next")).card;
  const before = await readMaintenanceStore(f.stateRoot, "acct");
  for (let i = 0; i < 3; i++) assert.equal((await f.call("submit", { card_id: held.card_id, lease_token: "wrong", answer: answer(held) })).code, "lease_token_stale");
  assert.equal((await f.call("submit", { card_id: held.card_id, lease_token: held.lease_token, workspace_project: "beta", answer: answer(held) })).code, "wrong_project");
  assert.deepEqual(await readMaintenanceStore(f.stateRoot, "acct"), before);
  assert.equal((await f.call("submit", { card_id: held.card_id, lease_token: held.lease_token, answer: answer(held) })).ok, true);
});
test("maintenance generation markers avoid visualization reads and isolate project/account changes", async t => {
  const beta = { ...job("beta", 100, 1), project_id: "beta" };
  const f = await fixture(t, [job("alpha", 100, 1), beta], true); await seedTimeline(f);
  const inspected = [];
  const inspect = f.runtime.architecture.inspectProjectCognitiveMap;
  f.runtime.architecture.inspectProjectCognitiveMap = async input => { inspected.push(input.projectId); return inspect(input); };
  await queueStatus({ ...f.deps, projectId: "alpha" }); assert.equal(f.visualizationReads, 1);
  const first = await readMaintenanceStore(f.stateRoot, "acct");
  assert.ok(first.cards.every(c => c.project_id === "alpha")); assert.deepEqual(Object.keys(first.generation), ["alpha"]);
  assert.equal((await listDistillationJobs(f.stateRoot, "acct")).find(j => j.job_id === "beta").split_card_set, undefined);
  await queueStatus({ ...f.deps, projectId: "alpha" }); assert.equal(f.visualizationReads, 1);
  assert.ok(inspected.every(p => p === "alpha"));
  await seedTimeline(f, "# Timeline\n\n## 2026-10-22: New revision\nNew facts.");
  await queueStatus({ ...f.deps, projectId: "alpha" }); assert.equal(f.visualizationReads, 2);
  const held = (await nextCard({ ...f.deps, projectId: "alpha", kinds: ["arch_link"] })).card;
  f.map.nodes[1].label += " changed";
  await queueStatus({ ...f.deps, projectId: "alpha" }); assert.equal(f.visualizationReads, 3);
  assert.equal((await readMaintenanceStore(f.stateRoot, "acct")).cards.find(c => c.card_id === held.card_id).status, "superseded");
  const ownMarker = (await readMaintenanceStore(f.stateRoot, "acct")).generation;
  const other = { ...f.deps, runtime: { ...f.runtime, accountId: "other" } };
  assert.deepEqual((await readMaintenanceStore(f.stateRoot, "other")).generation, {});
  await queueStatus({ ...other, projectId: "alpha" }); assert.equal(f.visualizationReads, 4);
  assert.deepEqual((await readMaintenanceStore(f.stateRoot, "acct")).generation, ownMarker);
  await queueStatus({ ...other, projectId: "alpha" }); assert.equal(f.visualizationReads, 4);
});

async function turnCall(f, action, args = {}) {
  const result = await f.client.callTool({ name: "litsan_turn", arguments: { action, ...args } });
  const body = result.content.map(c => c.text ?? "").join(""); assert.equal(result.isError, undefined, body); return JSON.parse(body);
}
async function commit(f, id, extra = {}) {
  return turnCall(f, "commit", { turn_id: id, conversation_id: "offers", continuity_id: "offers", project: "alpha", user_text: "Record this project fact", assistant_text: "A light answer.", ...extra });
}
const offerTurn = { ingested: true, projectId: "alpha", assistantChars: 10, toolSummaryChars: 0, continuityId: "offers" };
for (const action of ["inline_claim", "next"]) test(`lazy inline claims are scoped, retryable and do not lease on open (${action})`, async t => {
  const f = await fixture(t, [job("lazy-claim", 200, 1)]); await seedTimeline(f);
  await setMaintenanceConfig(f.stateRoot, { conversation_maintenance: "quiet", daily_card_cap: 1 });
  const opened = await turnCall(f, "open", { project: "alpha", user_text: "A user question", inline_maintenance: false });
  assert.equal(opened.inline_maintenance, undefined);
  assert.equal((await readMaintenanceStore(f.stateRoot, "acct")).cards.filter(c => c.status === "leased").length, 0);
  const call = async args => { const r = await f.client.callTool({ name: "litsan_card", arguments: args });
    assert.equal(r.isError, undefined, JSON.stringify(r)); return JSON.parse(r.content.map(c => c.text ?? "").join("")); };
  const args = { action, inline_turn_event: opened.event_id };
  assert.equal((await call({ action, inline_turn_event: "" })).code, "turn_unavailable");
  assert.equal((await call({ action, inline_turn_event: "l1_missing" })).code, "turn_unavailable");
  assert.equal((await call({ ...args, project: "beta" })).code, "wrong_project");
  const [first, retry] = await Promise.all([call(args), call(args)]); assert.equal(first.ok, true); assert.ok(first.card); assert.ok(first.card.input.items.length);
  assert.equal(retry.card.card_id, first.card.card_id); assert.equal(retry.card.lease_token, first.card.lease_token);
  assert.equal((await readMaintenanceOfferState(f.stateRoot, "acct", Date.now())).cards_offered, 1);
  await turnCall(f, "commit", { event_id: opened.event_id, project: "alpha", assistant_text: "Normal response.", inline_maintenance: false });
  assert.equal((await call(args)).code, "turn_unavailable");
  assert.equal((await readMaintenanceStore(f.stateRoot, "acct")).cards.find(c => c.card_id === first.card.card_id).status, "pending");
});
for (const action of ["inline_claim", "next"]) test(`lazy inline claim honors disabled and opted-out projects (${action})`, async t => {
  const f = await fixture(t, [job("lazy-opt-out", 200, 1)]);
  const opened = await turnCall(f, "open", { project: "alpha", user_text: "User request", inline_maintenance: false });
  const call = async () => JSON.parse((await f.client.callTool({ name: "litsan_card", arguments: { action, inline_turn_event: opened.event_id } })).content[0].text);
  assert.equal((await call()).card, null);
  await setMaintenanceConfig(f.stateRoot, { conversation_maintenance: "quiet", opted_out_projects: ["alpha"] });
  assert.equal((await call()).card, null);
  assert.equal((await readMaintenanceStore(f.stateRoot, "acct")).cards.filter(c => c.status === "leased").length, 0);
});
test("hydrated inline claim releases evidence that exceeds the turn budget", async t => {
  const f = await fixture(t, [job("hydrated-overflow", 200, 1)]);
  await seedTimeline(f, "# Timeline\n\n## 2026-10-22: " + "oversized heading ".repeat(2000));
  await setMaintenanceConfig(f.stateRoot, { conversation_maintenance: "quiet" });
  const opened = await turnCall(f, "open", { project: "alpha", user_text: "Question", inline_maintenance: false });
  const response = await f.client.callTool({ name: "litsan_card", arguments: { action: "next", inline_turn_event: opened.event_id } });
  const result = JSON.parse(response.content[0].text);
  assert.equal(result.ok, false); assert.equal(result.code, "card_too_large");
  assert.equal((await readMaintenanceStore(f.stateRoot, "acct")).cards.filter(c => c.status === "leased").length, 0);
});
test("skipped and expired in-turn cards back off without blocking explicit workers", async t => {
  const f = await fixture(t, [job("inline-backoff", 200, 1)]);
  const now = Date.now();
  const pull = (time, owner = "memhub-in-turn:first") => nextCard({ ...f.deps, projectId: "alpha", kinds: ["l2_chunk"], now: time,
    harness: owner, profile: { execution: "inline" }, inlineBranchId: "main", inlineL2MaxTokens: 3000, leaseSeconds: 30 });
  const first = (await pull(now)).card;
  assert.ok(first);
  await releaseCard({ ...f.deps, harness: "memhub-in-turn:first", cardId: first.card_id, leaseToken: first.lease_token, now: now + 1000 });
  assert.equal((await pull(now + 2000, "memhub-in-turn:second")).card, null);
  assert.equal((await queueStatus({ ...f.deps, projectId: "alpha", dry: true, now: now + 2000 })).kinds.l2_chunk.inline_deferred, 1);
  const worker = (await nextCard({ ...f.deps, projectId: "alpha", kinds: ["l2_chunk"], now: now + 2000 })).card;
  assert.equal(worker.card_id, first.card_id);
  await releaseCard({ ...f.deps, cardId: worker.card_id, leaseToken: worker.lease_token, now: now + 3000 });
  const retried = (await pull(now + 301001, "memhub-in-turn:third")).card;
  assert.equal(retried.card_id, first.card_id);
  assert.equal((await pull(now + 331002, "memhub-in-turn:fourth")).card, null);
  const stored = (await readMaintenanceStore(f.stateRoot, "acct")).cards.find(c => c.card_id === first.card_id);
  assert.equal(stored.inline_skips, 2);
  assert.equal(stored.status, "pending");
  assert.equal(Date.parse(stored.inline_retry_after), now + 331002 + 600000);
  const direct = (await nextCard({ ...f.deps, projectId: "alpha", kinds: ["l2_chunk"], now: now + 331003 })).card;
  assert.equal(direct.card_id, first.card_id);
});
test("in-turn L2 selection does not inspect the architecture map", async t => {
  const f = await fixture(t, [job("in-turn-fast-path", 200, 1)]);
  await setMaintenanceConfig(f.stateRoot, { conversation_maintenance: "quiet" });
  f.runtime.architecture.inspectProjectCognitiveMap = async () => { throw Error("unexpected architecture read"); };
  const opened = await turnCall(f, "open", { project: "alpha", user_text: "A normal question", inline_maintenance: true });
  assert.equal(opened.inline_maintenance?.kind, "l2_chunk");
  assert.equal(opened.inline_maintenance.input, undefined);
});
test("in-turn architecture review is generated, isolated and recorded without rewriting the map", async t => {
  const previous = maintenanceGenerators.get("arch_review");
  maintenanceGenerators.delete("arch_review");
  registerArchReview();
  try {
    const f = await fixture(t, [], true);
    const docs = [{ path: "z.md", content: "Architecture Z" }, { path: "a.md", content: "Architecture A" }];
    const ref = architectureDocRefs("alpha", docs).sources[0].ref;
    for (const node of f.map.nodes) node.evidence_refs = [ref];
    f.map.source_evidence_refs = [ref];
    await setMaintenanceConfig(f.stateRoot, { conversation_maintenance: "quiet" });
    await setWorkstreamEnabled(f.stateRoot, "acct", "alpha", true);
    const branch = await f.runtime.branches.create("acct", "alpha", { name: "feature-review", goal: "Separate work" });
    const args = { project: "alpha", conversation_id: "review-chat", turn_id: "review-turn", user_text: "A normal question", inline_maintenance: true };
    const opened = await turnCall(f, "open", args);
    assert.equal(opened.inline_maintenance?.kind, "arch_review");
    assert.equal(opened.inline_maintenance.input, undefined);
    assert.equal((await turnCall(f, "open", args)).inline_maintenance.card_id, opened.inline_maintenance.card_id);
    const otherBranch = await turnCall(f, "open", { project: "alpha", branch: branch.branchId, user_text: "Separate branch", inline_maintenance: true });
    assert.equal(otherBranch.inline_maintenance, undefined);
    const card = opened.inline_maintenance;
    const loadArgs = { action: "inline_load", project: "alpha", card_id: card.card_id, lease_token: card.lease_token, inline_turn_event: opened.event_id };
    const loaded = JSON.parse((await f.client.callTool({ name: "litsan_card", arguments: loadArgs })).content[0].text);
    assert.equal(loaded.card.input.review_round, 1);
    const wrongProject = JSON.parse((await f.client.callTool({ name: "litsan_card", arguments: { ...loadArgs, project: "beta" } })).content[0].text);
    assert.equal(wrongProject.code, "wrong_project");
    const answer = { faithfulness: 4, clarity: 4, cited_refs: loaded.card.allowed_refs.slice(0, 1), issues: ["EN: Clarify ownership ZH: 说明职责"] };
    const committed = await turnCall(f, "commit", { event_id: opened.event_id, conversation_id: "review-chat", turn_id: "review-turn", project: "alpha", assistant_text: "The normal answer.", maintenance_answer: { card_id: card.card_id, lease_token: card.lease_token, answer } });
    assert.equal(committed.ingested, true);
    assert.equal(committed.maintenance_result.ok, true);
    assert.equal(f.mapWrites.length, 0);
    assert.equal(f.writes.length, 0);
  } finally {
    maintenanceGenerators.delete("arch_review");
    if (previous) maintenanceGenerators.set("arch_review", previous);
  }
});
test("in-turn selection accepts a larger L2 card only when the client explicitly allows it", async t => {
  const f = await fixture(t, [job("in-turn-existing-card", 8000, 1)]);
  await setMaintenanceConfig(f.stateRoot, { conversation_maintenance: "quiet" });
  await ensureCards(f.deps);
  const opened = await turnCall(f, "open", { project: "alpha", user_text: "Continue the project", inline_maintenance: true,
    client_profile: { execution: "inline", max_card_tokens: 8000 } });
  assert.ok(opened.inline_maintenance?.est_tokens > 3000);
  assert.ok(opened.inline_maintenance.est_tokens <= 8000);
});
test("in-turn cards respect explicit token budgets, including replay and release", async t => {
  const f = await fixture(t, [job("in-turn-budget", 8000, 1)]);
  await setMaintenanceConfig(f.stateRoot, { conversation_maintenance: "quiet" });
  await ensureCards(f.deps);
  const small = await turnCall(f, "open", { project: "alpha", conversation_id: "small-budget", turn_id: "small",
    user_text: "A normal question", inline_maintenance: true });
  assert.equal(small.inline_maintenance, undefined);
  assert.equal((await readMaintenanceStore(f.stateRoot, "acct")).cards.find(c => c.kind === "l2_chunk").status, "pending");
  const args = { project: "alpha", conversation_id: "large-budget", turn_id: "large", user_text: "A normal question",
    inline_maintenance: true, client_profile: { execution: "inline", max_card_tokens: 8000 } };
  const opened = await turnCall(f, "open", args);
  const card = opened.inline_maintenance;
  assert.ok(card.est_tokens > 2000);
  const replay = await turnCall(f, "open", { ...args, client_profile: { execution: "inline", max_card_tokens: 2000 } });
  assert.equal(replay.inline_maintenance, undefined, "a replay cannot bypass a lowered budget");
  const loaded = JSON.parse((await f.client.callTool({ name: "litsan_card", arguments: { action: "inline_load", project: "alpha",
    card_id: card.card_id, lease_token: card.lease_token, inline_turn_event: opened.event_id } })).content[0].text);
  assert.deepEqual(loaded, { ok: false, code: "card_too_large" });
  await turnCall(f, "commit", { event_id: opened.event_id, conversation_id: "large-budget", project: "alpha", assistant_text: "Normal answer." });
  assert.equal((await readMaintenanceStore(f.stateRoot, "acct")).cards.find(c => c.card_id === card.card_id).status, "pending");
  const delegated = (await f.call("next", { project: "alpha", kinds: ["l2_chunk"] })).card;
  assert.equal(delegated.card_id, card.card_id, "a capable delegate can still claim the preserved card");
  await f.call("release", { project: "alpha", card_id: delegated.card_id, lease_token: delegated.lease_token });
  assert.equal(f.writes.length, 0);
});
test("in-turn load checks the budget after adding recent timeline context", async t => {
  for (const oversized of [false, true]) {
    const f = await fixture(t, [job(`in-turn-context-${oversized}`, 200, 1)]);
    await seedTimeline(f, `# Timeline\n\n## 2026-10-19: ${oversized ? "x".repeat(5000) : "Earlier history"}`);
    await setMaintenanceConfig(f.stateRoot, { conversation_maintenance: "quiet" });
    const opened = await turnCall(f, "open", { project: "alpha", user_text: "A normal question", inline_maintenance: true,
      client_profile: { execution: "inline", max_card_tokens: 2000 } });
    const card = opened.inline_maintenance;
    assert.ok(card && card.est_tokens <= 2000);
    const loaded = JSON.parse((await f.client.callTool({ name: "litsan_card", arguments: { action: "inline_load", project: "alpha",
      card_id: card.card_id, lease_token: card.lease_token, inline_turn_event: opened.event_id } })).content[0].text);
    if (oversized) assert.deepEqual(loaded, { ok: false, code: "card_too_large" });
    else { assert.equal(loaded.ok, true); assert.ok(loaded.card.est_tokens <= 2000); }
    await turnCall(f, "commit", { event_id: opened.event_id, project: "alpha", assistant_text: "Normal answer." });
    assert.equal((await readMaintenanceStore(f.stateRoot, "acct")).cards.find(c => c.card_id === card.card_id).status, "pending");
    assert.equal(f.writes.length, 0);
  }
});
test("new in-turn L2 jobs split to the client budget and merge every source in order", async t => {
  const source = job("adaptive-inline", 600, 3);
  const f = await fixture(t, [source]);
  await seedTimeline(f);
  await setMaintenanceConfig(f.stateRoot, { conversation_maintenance: "quiet" });
  const open = index => turnCall(f, "open", { project: "alpha", conversation_id: "adaptive", turn_id: `turn-${index}`,
    user_text: "Continue the project", inline_maintenance: true, client_profile: { execution: "inline", max_card_tokens: 2000 } });
  let opened = await open(0);
  const store = await readMaintenanceStore(f.stateRoot, "acct");
  const cards = store.cards.filter(c => c.kind === "l2_chunk").sort((a, b) => a.chunk.index - b.chunk.index);
  assert.ok(cards.length > 1);
  assert.ok(cards.every(card => card.est_tokens <= 2000));
  assert.deepEqual(cards.flatMap(card => card.allowed_refs), source.evidence_refs);
  for (let index = 0; index < cards.length; index++) {
    if (index) opened = await open(index);
    const offered = opened.inline_maintenance;
    assert.equal(offered.card_id, cards[index].card_id);
    const loaded = JSON.parse((await f.client.callTool({ name: "litsan_card", arguments: { action: "inline_load", project: "alpha",
      card_id: offered.card_id, lease_token: offered.lease_token, inline_turn_event: opened.event_id } })).content[0].text);
    assert.equal(loaded.ok, true);
    assert.ok(loaded.card.est_tokens <= 2000);
    const output = answer(loaded.card, index);
    output.events[0].evidence_refs = loaded.card.allowed_refs;
    const committed = await turnCall(f, "commit", { event_id: opened.event_id, conversation_id: "adaptive", project: "alpha",
      assistant_text: "Normal answer.", maintenance_answer: { card_id: offered.card_id, lease_token: offered.lease_token, answer: output } });
    assert.equal(committed.maintenance_result.ok, true);
  }
  assert.equal(f.writes.length, 1);
  for (const ref of source.evidence_refs) assert.ok(f.writes[0].content.includes(ref));
  assert.equal((await listDistillationJobs(f.stateRoot, "acct")).find(j => j.job_id === source.job_id).status, "completed");
});
test("budget-aware generation preserves requested sets and leaves indivisible large evidence for delegates", async t => {
  const existing = await fixture(t, [job("existing-large-set", 600, 3)]);
  await setMaintenanceConfig(existing.stateRoot, { conversation_maintenance: "quiet" });
  await ensureCards(existing.deps);
  await markRequested({ ...existing.deps, projectId: "alpha", kinds: ["l2_chunk"] });
  const before = await readMaintenanceStore(existing.stateRoot, "acct");
  assert.equal(before.cards.filter(c => c.kind === "l2_chunk").length, 1);
  assert.ok(before.cards.find(c => c.kind === "l2_chunk").est_tokens > 2000);
  const open = await turnCall(existing, "open", { project: "alpha", user_text: "Continue", inline_maintenance: true,
    client_profile: { execution: "inline", max_card_tokens: 2000 } });
  assert.equal(open.inline_maintenance, undefined);
  const after = await readMaintenanceStore(existing.stateRoot, "acct");
  assert.deepEqual(after.sets, before.sets);
  assert.deepEqual(after.cards, before.cards);

  const large = await fixture(t, [job("indivisible-large", 8000, 1)]);
  await setMaintenanceConfig(large.stateRoot, { conversation_maintenance: "quiet" });
  const skipped = await turnCall(large, "open", { project: "alpha", user_text: "Continue", inline_maintenance: true });
  assert.equal(skipped.inline_maintenance, undefined);
  const card = (await large.call("next", { project: "alpha", kinds: ["l2_chunk"] })).card;
  assert.ok(card.est_tokens > 3000);
  assert.deepEqual(card.allowed_refs, ["l1:indivisible-large-0"]);
  await large.call("release", { project: "alpha", card_id: card.card_id, lease_token: card.lease_token });
});
test("in-turn replan preserves coalesced parents and merges all evidence once", async t => {
  const sources = [job("old-a", 1500, 2), job("old-b", 1500, 2), job("old-c", 1500, 2)];
  const f = await fixture(t, sources); await seedTimeline(f);
  await setMaintenanceConfig(f.stateRoot, { conversation_maintenance: "quiet" });
  await ensureCards(f.deps);
  const before = await readMaintenanceStore(f.stateRoot, "acct");
  const oldSet = before.sets.find(s => s.status === "open");
  const oldCard = before.cards.find(c => c.card_id === oldSet.card_ids[0]);
  assert.equal(oldSet.parent_job_ids.length, 3);
  assert.equal(oldSet.card_ids.length, 1);
  assert.ok(oldCard.est_tokens > 3000);
  const parentBefore = (await listDistillationJobs(f.stateRoot, "acct")).filter(j => sources.some(s => s.job_id === j.job_id));
  const open = index => turnCall(f, "open", { project: "alpha", conversation_id: "replan", turn_id: `replan-${index}`,
    user_text: "Continue the project", inline_maintenance: true });
  const starts = await Promise.all([open(0), open(1)]);
  const offered = starts.filter(x => x.inline_maintenance?.kind === "l2_chunk");
  assert.equal(offered.length, 1, "concurrent turns cannot lease the same first chunk");
  for (const start of starts.filter(x => x !== offered[0]))
    await turnCall(f, "commit", { event_id: start.event_id, project: "alpha", assistant_text: "Normal answer." });
  const after = await readMaintenanceStore(f.stateRoot, "acct");
  const newSet = after.sets.find(s => s.set_id === oldSet.set_id);
  const cards = newSet.card_ids.map(id => after.cards.find(c => c.card_id === id));
  assert.ok(cards.length > 1 && cards.every(c => c.est_tokens <= 3000));
  assert.equal(after.cards.find(c => c.card_id === oldCard.card_id).status, "superseded");
  assert.deepEqual(newSet.parent_job_ids, oldSet.parent_job_ids);
  assert.deepEqual((await listDistillationJobs(f.stateRoot, "acct")).filter(j => sources.some(s => s.job_id === j.job_id)), parentBefore);
  assert.deepEqual(cards.flatMap(c => c.allowed_refs), sources.flatMap(s => s.evidence_refs));
  let turn = offered[0];
  for (let index = 0; index < cards.length; index++) {
    if (index) turn = await open(index + 1);
    assert.equal(turn.inline_maintenance?.card_id, cards[index].card_id);
    const card = turn.inline_maintenance;
    const loaded = JSON.parse((await f.client.callTool({ name: "litsan_card", arguments: { action: "inline_load", project: "alpha",
      card_id: card.card_id, lease_token: card.lease_token, inline_turn_event: turn.event_id } })).content[0].text);
    assert.equal(loaded.ok, true); assert.ok(loaded.card.est_tokens <= 3000);
    const output = answer(loaded.card, index); output.events[0].evidence_refs = loaded.card.allowed_refs;
    const result = await turnCall(f, "commit", { event_id: turn.event_id, project: "alpha", assistant_text: "Normal answer.",
      maintenance_answer: { card_id: card.card_id, lease_token: card.lease_token, answer: output } });
    assert.equal(result.maintenance_result.ok, true);
  }
  assert.equal(f.writes.length, 1);
  for (const source of sources) for (const ref of source.evidence_refs) assert.ok(f.writes[0].content.includes(ref));
  assert.ok((await listDistillationJobs(f.stateRoot, "acct")).filter(j => sources.some(s => s.job_id === j.job_id)).every(j => j.status === "completed"));
});

test("in-turn replan leaves active, released and partially accepted sets intact", async t => {
  const f = await fixture(t, [job("inflight-old", 1500, 6)]);
  await setMaintenanceConfig(f.stateRoot, { conversation_maintenance: "quiet" }); await ensureCards(f.deps);
  const before = await readMaintenanceStore(f.stateRoot, "acct");
  const original = before.cards.find(c => c.kind === "l2_chunk"); assert.ok(original.est_tokens > 3000);
  const leased = (await f.call("next", { project: "alpha", kinds: ["l2_chunk"] })).card;
  assert.equal(leased.card_id, original.card_id);
  const during = await turnCall(f, "open", { project: "alpha", user_text: "Continue", inline_maintenance: true });
  assert.equal((await readMaintenanceStore(f.stateRoot, "acct")).sets[0].card_ids[0], original.card_id);
  await turnCall(f, "commit", { event_id: during.event_id, project: "alpha", assistant_text: "Normal answer." });
  await f.call("release", { project: "alpha", card_id: leased.card_id, lease_token: leased.lease_token });
  const released = await turnCall(f, "open", { project: "alpha", user_text: "Continue again", inline_maintenance: true });
  assert.equal((await readMaintenanceStore(f.stateRoot, "acct")).sets[0].card_ids[0], original.card_id);
  await turnCall(f, "commit", { event_id: released.event_id, project: "alpha", assistant_text: "Normal answer." });
  assert.equal(f.writes.length, 0);

  const g = await fixture(t, [job("partial-old", 6000, 3)]);
  await setMaintenanceConfig(g.stateRoot, { conversation_maintenance: "quiet" }); await ensureCards(g.deps);
  const partialBefore = await readMaintenanceStore(g.stateRoot, "acct");
  assert.ok(partialBefore.sets[0].card_ids.length > 1);
  const first = (await g.call("next", { project: "alpha", kinds: ["l2_chunk"] })).card;
  assert.equal((await g.call("submit", { card_id: first.card_id, lease_token: first.lease_token, answer: answer(first) })).ok, true);
  const started = await turnCall(g, "open", { project: "alpha", user_text: "Continue", inline_maintenance: true });
  const partialAfter = await readMaintenanceStore(g.stateRoot, "acct");
  assert.deepEqual(partialAfter.sets[0].card_ids, partialBefore.sets[0].card_ids);
  assert.equal(partialAfter.cards.find(c => c.card_id === first.card_id).status, "accepted");
  await turnCall(g, "commit", { event_id: started.event_id, project: "alpha", assistant_text: "Normal answer." });
  assert.equal(g.writes.length, 0);
});

test("in-turn replan only changes untouched sets in the active branch", async t => {
  const f = await fixture(t, [job("branch-old", 1500, 6)]);
  await setMaintenanceConfig(f.stateRoot, { conversation_maintenance: "quiet" });
  await setWorkstreamEnabled(f.stateRoot, "acct", "alpha", true);
  const branch = await f.runtime.branches.create("acct", "alpha", { name: "old-branch", goal: "Isolate work" });
  await mutateMaintenanceJob(f.stateRoot, "acct", "branch-old", item => { item.branch_id = branch.branchId; });
  await ensureCards(f.deps);
  const before = await readMaintenanceStore(f.stateRoot, "acct");
  const main = await turnCall(f, "open", { project: "alpha", user_text: "Main work", inline_maintenance: true });
  assert.deepEqual((await readMaintenanceStore(f.stateRoot, "acct")).sets[0].card_ids, before.sets[0].card_ids);
  const turn = await turnCall(f, "open", { project: "alpha", branch: branch.branchId, user_text: "Branch work", inline_maintenance: true });
  assert.ok(turn.inline_maintenance?.est_tokens <= 3000);
  const after = await readMaintenanceStore(f.stateRoot, "acct");
  assert.notDeepEqual(after.sets[0].card_ids, before.sets[0].card_ids);
  assert.ok(after.sets[0].card_ids.every(id => after.cards.find(c => c.card_id === id).branch_id === branch.branchId));
  await turnCall(f, "commit", { event_id: main.event_id, project: "alpha", assistant_text: "Main answer." });
  await turnCall(f, "commit", { event_id: turn.event_id, project: "alpha", assistant_text: "Branch answer." });
  assert.equal(f.writes.length, 0);
});

test("budget-aware in-turn chunks stay within their workstream branch", async t => {
  const f = await fixture(t, [job("adaptive-branch", 600, 3)]);
  await setMaintenanceConfig(f.stateRoot, { conversation_maintenance: "quiet" });
  await setWorkstreamEnabled(f.stateRoot, "acct", "alpha", true);
  const branch = await f.runtime.branches.create("acct", "alpha", { name: "feature-budget", goal: "Isolate work" });
  await mutateMaintenanceJob(f.stateRoot, "acct", "adaptive-branch", item => { item.branch_id = branch.branchId; });
  const main = await turnCall(f, "open", { project: "alpha", user_text: "Main work", inline_maintenance: true });
  assert.equal(main.inline_maintenance, undefined);
  const opened = await turnCall(f, "open", { project: "alpha", branch: branch.branchId, user_text: "Branch work", inline_maintenance: true,
    client_profile: { execution: "inline", max_card_tokens: 2000 } });
  const card = opened.inline_maintenance;
  assert.ok(card && card.est_tokens <= 2000);
  const store = await readMaintenanceStore(f.stateRoot, "acct");
  assert.ok(store.cards.filter(c => c.parent_job_id === "adaptive-branch").every(c => c.branch_id === branch.branchId));
  const args = { action: "inline_load", project: "alpha", card_id: card.card_id, lease_token: card.lease_token };
  const wrongBranch = JSON.parse((await f.client.callTool({ name: "litsan_card", arguments: { ...args, inline_turn_event: main.event_id } })).content[0].text);
  assert.equal(wrongBranch.code, "card_unavailable");
  const sameBranch = JSON.parse((await f.client.callTool({ name: "litsan_card", arguments: { ...args, inline_turn_event: opened.event_id } })).content[0].text);
  assert.equal(sameBranch.ok, true);
  await turnCall(f, "commit", { event_id: opened.event_id, project: "alpha", assistant_text: "Branch answer." });
  await turnCall(f, "commit", { event_id: main.event_id, project: "alpha", assistant_text: "Main answer." });
  assert.equal((await readMaintenanceStore(f.stateRoot, "acct")).cards.find(c => c.card_id === card.card_id).status, "pending");
  assert.equal(f.writes.length, 0);
});
test("in-turn L2 card shares the user turn and commits once without another model task", async t => {
  const f = await fixture(t, [job("in-turn", 200, 1)]); await seedTimeline(f);
  await setMaintenanceConfig(f.stateRoot, { conversation_maintenance: "quiet" });
  await ensureCards(f.deps);
  const args = { project: "alpha", conversation_id: "chat", turn_id: "same-turn", user_text: "A normal question", inline_maintenance: true };
  const opened = await turnCall(f, "open", args);
  assert.equal(opened.inline_maintenance.kind, "l2_chunk");
  assert.equal(opened.inline_maintenance.project_id, "alpha");
  assert.ok(opened.inline_maintenance.lease_token);
  const replayOpen = await turnCall(f, "open", args);
  assert.equal(replayOpen.inline_maintenance.card_id, opened.inline_maintenance.card_id, "retry resumes the same lease");
  const card = opened.inline_maintenance;
  const payload = { card_id: card.card_id, lease_token: card.lease_token, answer: answer(card) };
  const finish = { event_id: opened.event_id, conversation_id: "chat", project: "alpha", assistant_text: "A normal answer.", maintenance_answer: payload };
  const committed = await turnCall(f, "commit", finish);
  assert.equal(committed.ingested, true);
  assert.equal(committed.maintenance_result.ok, true);
  assert.equal(committed.maintenance_result.set_status, "merged");
  const replayCommit = await turnCall(f, "commit", finish);
  assert.equal(replayCommit.maintenance_result.ok, true);
  assert.equal(replayCommit.maintenance_result.already_accepted, true);
  assert.equal((await readMaintenanceStore(f.stateRoot, "acct")).cards.filter(c => c.kind === "l2_chunk" && c.status === "accepted").length, 1);
  assert.equal(f.writes.length, 1);
});
test("in-turn invalid evidence cannot block the conversation or write memory", async t => {
  const f = await fixture(t, [job("in-turn-invalid", 200, 1)]);
  await setMaintenanceConfig(f.stateRoot, { conversation_maintenance: "quiet" });
  await ensureCards(f.deps);
  const opened = await turnCall(f, "open", { project: "alpha", user_text: "A normal question", inline_maintenance: true });
  const card = opened.inline_maintenance;
  const bad = answer(card); bad.events[0].evidence_refs = ["l1:other-project"];
  const committed = await turnCall(f, "commit", { event_id: opened.event_id, project: "alpha",
    assistant_text: "The user answer is preserved.", maintenance_answer: { card_id: card.card_id, lease_token: card.lease_token, answer: bad } });
  assert.equal(committed.ingested, true);
  assert.equal(committed.maintenance_result.ok, false);
  assert.equal(committed.maintenance_result.code, "ref_not_allowed");
  assert.equal((await readMaintenanceStore(f.stateRoot, "acct")).cards.find(c => c.card_id === card.card_id).status, "pending");
  assert.equal(f.writes.length, 0);
});
test("in-turn tasks honor opt-out, project scope, budget and release on failure", async t => {
  const f = await fixture(t, [job("in-turn-scoped", 200, 1)]);
  await setMaintenanceConfig(f.stateRoot, { conversation_maintenance: "quiet", daily_card_cap: 1 });
  await ensureCards(f.deps);
  const normal = await turnCall(f, "open", { project: "alpha", user_text: "Normal turn", inline_maintenance: false });
  assert.equal(normal.inline_maintenance, undefined);
  const wrong = await turnCall(f, "open", { project: "beta", user_text: "Other project", inline_maintenance: true });
  assert.equal(wrong.inline_maintenance, undefined);
  const first = await turnCall(f, "open", { project: "alpha", user_text: "Use the current project", inline_maintenance: true });
  assert.ok(first.inline_maintenance);
  const limited = await turnCall(f, "open", { project: "alpha", user_text: "Another turn", inline_maintenance: true });
  assert.equal(limited.inline_maintenance, undefined, "account offer budget must apply");
  await turnCall(f, "failed", { event_id: first.event_id, project: "alpha", tool_summary: "Cancelled", inline_maintenance: true });
  const card = (await readMaintenanceStore(f.stateRoot, "acct")).cards.find(c => c.card_id === first.inline_maintenance.card_id);
  assert.equal(card.status, "pending");
  assert.equal(card.lease, undefined);
});
test("quiet MCP clients submit one card early without a host conversation id", async t => {
  for (const platform of ["chatgpt", "claude-code", "codex", "antigravity", "grok-bot"]) {
    const f = await fixture(t, [job(`universal-${platform}`, 200, 1)]); await seedTimeline(f);
    f.runtime.source.platform = platform;
    await setMaintenanceConfig(f.stateRoot, { conversation_maintenance: "quiet" }); await ensureCards(f.deps);
    const opened = await turnCall(f, "open", { project: "alpha", user_text: "A normal user request" });
    assert.equal(opened.transport_conversation_id, null);
    assert.equal(opened.inline_maintenance?.kind, "l2_chunk");
    const card = opened.inline_maintenance;
    const load = await f.client.callTool({ name: "litsan_card", arguments: { action: "inline_load", project: "alpha",
      inline_turn_event: opened.event_id, card_id: card.card_id, lease_token: card.lease_token } });
    assert.equal(load.isError, undefined, JSON.stringify(load));
    assert.ok(JSON.parse(load.content[0].text).card.input.items.length);
    const submitted = await f.client.callTool({ name: "litsan_card", arguments: { action: "submit", project: "alpha",
      inline_turn_event: opened.event_id, card_id: card.card_id, lease_token: card.lease_token, answer: answer(card) } });
    assert.equal(JSON.parse(submitted.content[0].text).ok, true);
    assert.equal((await listCaptureEvents(f.stateRoot, "acct", { eventId: opened.event_id, limit: 1 }))[0].capture_status, "open");
    const committed = await turnCall(f, "commit", { event_id: opened.event_id, project: "alpha", assistant_text: "The normal answer." });
    assert.equal(committed.ingested, true);
    assert.equal(committed.maintenance, undefined);
    const event = (await listCaptureEvents(f.stateRoot, "acct", { eventId: opened.event_id, limit: 1 }))[0];
    assert.equal(event.assistant_text, "The normal answer.");
    assert.equal(f.writes.length, 1);
  }
});
test("record-only hosts still capture the turn without issuing an invisible card offer", async t => {
  const f = await fixture(t, [], true); await seedTimeline(f);
  await setMaintenanceConfig(f.stateRoot, { conversation_maintenance: "quiet", inline_every_n_turns: 1 });
  const recorded = await turnCall(f, "record", { project: "alpha", user_text: "User request", assistant_text: "Normal response", inline_maintenance: false });
  assert.equal(recorded.ingested, true); assert.equal(recorded.maintenance, undefined); assert.equal(recorded.inline_maintenance, undefined);
  assert.equal((await readMaintenanceLog(f.stateRoot, "acct")).some(e => e.outcome === "offered" || e.outcome === "leased"), false);
});
test("quiet MCP turns release a skipped card even when the client omits inline flags", async t => {
  const f = await fixture(t, [job("universal-skip", 200, 1)]);
  await setMaintenanceConfig(f.stateRoot, { conversation_maintenance: "quiet", inline_every_n_turns: 1 }); await ensureCards(f.deps);
  const agent = await turnCall(f, "open", { project: "alpha", origin: "agent", user_text: "Agent task" });
  assert.equal(agent.inline_maintenance, undefined);
  const scheduled = await turnCall(f, "open", { project: "alpha", trigger: "scheduled_wakeup", user_text: "Scheduled task" });
  assert.equal(scheduled.inline_maintenance, undefined);
  const opened = await turnCall(f, "open", { project: "alpha", user_text: "User task" });
  assert.ok(opened.inline_maintenance);
  const committed = await turnCall(f, "commit", { event_id: opened.event_id, project: "alpha", assistant_text: "Normal answer" });
  assert.equal(committed.ingested, true);
  assert.equal(committed.maintenance, undefined);
  const card = (await readMaintenanceStore(f.stateRoot, "acct")).cards.find(c => c.card_id === opened.inline_maintenance.card_id);
  assert.equal(card.status, "pending"); assert.equal(card.lease, undefined);
});
test("in-turn card cannot be submitted by another conversation", async t => {
  const f = await fixture(t, [job("in-turn-owner", 200, 1)]);
  await setMaintenanceConfig(f.stateRoot, { conversation_maintenance: "quiet" }); await ensureCards(f.deps);
  const first = await turnCall(f, "open", { project: "alpha", user_text: "First", inline_maintenance: true });
  const second = await turnCall(f, "open", { project: "alpha", user_text: "Second" });
  const card = first.inline_maintenance;
  const attempt = await turnCall(f, "commit", { event_id: second.event_id, project: "alpha", assistant_text: "Second answer",
    maintenance_answer: { card_id: card.card_id, lease_token: card.lease_token, answer: answer(card) } });
  assert.equal(attempt.ingested, true);
  assert.equal(attempt.maintenance_result.code, "lease_token_stale");
  assert.equal((await readMaintenanceStore(f.stateRoot, "acct")).cards.find(c => c.card_id === card.card_id).status, "leased");
  assert.equal(f.writes.length, 0);
});
test("in-turn L2 cards stay within the current workstream", async t => {
  const f = await fixture(t);
  await setMaintenanceConfig(f.stateRoot, { conversation_maintenance: "quiet" });
  await setWorkstreamEnabled(f.stateRoot, "acct", "alpha", true);
  const branch = await f.runtime.branches.create("acct", "alpha", { name: "feature", goal: "Feature" });
  const jobs = [{ ...job("a-feature", 200, 1), branch_id: branch.branchId }, job("z-main", 200, 1)];
  await writeFile(join(f.stateRoot, "distillation", "jobs.json"), JSON.stringify({ version: 2, jobs }));
  await ensureCards(f.deps);
  const main = await turnCall(f, "open", { project: "alpha", user_text: "Main question", inline_maintenance: true });
  assert.deepEqual(main.inline_maintenance.allowed_refs, ["l1:z-main-0"]);
  const feature = await turnCall(f, "open", { project: "alpha", branch: branch.branchId, user_text: "Feature question", inline_maintenance: true });
  assert.deepEqual(feature.inline_maintenance.allowed_refs, ["l1:a-feature-0"]);
});
test("in-turn card can be submitted through the existing card tool before the final reply", async t => {
  const f = await fixture(t, [job("in-turn-tool", 200, 1)]); await seedTimeline(f);
  await setMaintenanceConfig(f.stateRoot, { conversation_maintenance: "quiet" }); await ensureCards(f.deps);
  const open = await turnCall(f, "open", { project: "alpha", user_text: "A normal question", inline_maintenance: true });
  const card = open.inline_maintenance;
  const loadArgs = { action: "inline_load", project: "alpha", card_id: card.card_id, lease_token: card.lease_token, inline_turn_event: open.event_id };
  const load = async args => {
    const response = await f.client.callTool({ name: "litsan_card", arguments: args });
    assert.equal(response.isError, undefined, JSON.stringify(response));
    return JSON.parse(response.content.map(c => c.text ?? "").join(""));
  };
  const loaded = await load(loadArgs);
  assert.deepEqual(loaded.card.allowed_refs, card.allowed_refs);
  assert.ok(loaded.card.input.items.length);
  assert.equal((await load({ ...loadArgs, lease_token: "wrong" })).code, "card_unavailable");
  const raw = await f.client.callTool({ name: "litsan_card", arguments: { action: "submit", project: "alpha",
    card_id: card.card_id, lease_token: card.lease_token, inline_turn_event: open.event_id, answer: answer(card) } });
  assert.equal(raw.isError, undefined, JSON.stringify(raw));
  assert.equal(JSON.parse(raw.content.map(c => c.text ?? "").join("")).ok, true);
  const commit = await turnCall(f, "commit", { event_id: open.event_id, project: "alpha", assistant_text: "The final answer.", inline_maintenance: true });
  assert.equal(commit.ingested, true);
  assert.equal(f.writes.length, 1);
});
test("in-turn Codex hook carries one model result through the real card and turn tools", async t => {
  const f = await fixture(t, [job("in-turn-hook", 200, 1)]); await seedTimeline(f);
  await setMaintenanceConfig(f.stateRoot, { conversation_maintenance: "quiet" }); await ensureCards(f.deps);
  let state = { sequence: 0, skipped: {} }, stdout = "", generations = 0;
  const recorder = { io: { stdout: { write: s => { stdout += s; } } },
    locked: async (_key, fn) => fn(), load: async () => structuredClone(state),
    save: async (_key, value) => { state = structuredClone(value); }, base: async () => ({ project: "alpha" }),
    call: async args => { const r = await f.client.callTool({ name: "litsan_turn", arguments: args });
      assert.equal(r.isError, undefined, JSON.stringify(r)); return JSON.parse(r.content.map(c => c.text ?? "").join("")); } };
  await codexInlineHook("UserPromptSubmit", { session_id: "s", turn_id: "t", cwd: "/test", prompt: "A user question" }, recorder);
  const context = JSON.parse(stdout).hookSpecificOutput.additionalContext;
  assert.match(context, /Before the main user task/);
  assert.match(context, /submit the evidence-bound answer immediately/);
  const route = JSON.parse(context.match(/litsan card --json-args '([^']+)'/)[1]);
  const tool = async args => { const r = await f.client.callTool({ name: "litsan_card", arguments: args });
    assert.equal(r.isError, undefined, JSON.stringify(r)); return JSON.parse(r.content.map(c => c.text ?? "").join("")); };
  const claim = await tool(route); assert.equal(claim.ok, true); assert.ok(claim.card);
  const loaded = claim; assert.ok(loaded.card.input.items.length);
  const model = card => { generations++; return { reply: "The user's answer.", answer: answer(card) }; };
  const result = model(loaded.card);
  assert.equal((await tool({ ...route, action: "submit", card_id: claim.card.card_id, lease_token: claim.card.lease_token, answer: result.answer })).ok, true);
  stdout = "";
  await codexInlineHook("Stop", { session_id: "s", turn_id: "t", cwd: "/test", last_assistant_message: result.reply }, recorder);
  const events = await listCaptureEvents(f.stateRoot, "acct", { eventId: route.inline_turn_event, limit: 1 });
  assert.equal(generations, 1);
  assert.equal(events[0].assistant_text, result.reply);
  assert.equal(f.writes.length, 1);
});
test("an open response lost in transit leaves no lease and the preallocated event can claim", async t => {
  const f = await fixture(t, [job("lazy-timeout", 200, 1)]); await seedTimeline(f);
  await setMaintenanceConfig(f.stateRoot, { conversation_maintenance: "quiet" });
  let state = { sequence: 0, skipped: {} }, stdout = "";
  const recorder = { io: { stdout: { write: s => { stdout += s; } } },
    locked: async (_key, fn) => fn(), load: async () => structuredClone(state), save: async (_key, value) => { state = structuredClone(value); },
    base: async () => ({ project: "alpha" }), call: async args => {
      const r = await f.client.callTool({ name: "litsan_turn", arguments: args });
      assert.equal(r.isError, undefined, JSON.stringify(r));
      return args.action === "open" ? undefined : JSON.parse(r.content[0].text);
    } };
  await codexInlineHook("UserPromptSubmit", { session_id: "timeout", turn_id: "t", prompt: "A user question" }, recorder);
  const route = JSON.parse(JSON.parse(stdout).hookSpecificOutput.additionalContext.match(/litsan card --json-args '([^']+)'/)[1]);
  assert.equal(route.inline_turn_event, state.turn.event_id);
  assert.equal((await readMaintenanceStore(f.stateRoot, "acct")).cards.filter(c => c.status === "leased").length, 0);
  const claimed = JSON.parse((await f.client.callTool({ name: "litsan_card", arguments: route })).content[0].text);
  assert.equal(claimed.ok, true); assert.ok(claimed.card);
});
test("Claude hook exposes its leased card for immediate submit before the user task ends", async t => {
  const f = await fixture(t, [job("claude-early", 200, 1)]); await seedTimeline(f);
  await setMaintenanceConfig(f.stateRoot, { conversation_maintenance: "quiet" }); await ensureCards(f.deps);
  const transcript = join(f.stateRoot, "claude-transcript.jsonl");
  await writeFile(transcript, [
    { type: "user", message: { role: "user", content: "A user question" } },
    { type: "assistant", message: { role: "assistant", content: "The user's answer." } }
  ].map(JSON.stringify).join("\n") + "\n");
  let state = { sequence: 0, skipped: {} }, stdout = "";
  const recorder = { io: { stdout: { write: s => { stdout += s; } } }, remaining: () => 5000,
    locked: async (_key, fn) => fn(), load: async () => structuredClone(state),
    save: async (_key, value) => { state = structuredClone(value); }, base: async () => ({ project: "alpha" }),
    call: async args => { const r = await f.client.callTool({ name: "litsan_turn", arguments: args });
      assert.equal(r.isError, undefined, JSON.stringify(r)); return JSON.parse(r.content.map(c => c.text ?? "").join("")); } };
  await claudeHook("UserPromptSubmit", { session_id: "claude-test", cwd: "/test", prompt: "A user question", transcript_path: transcript }, recorder);
  const context = JSON.parse(stdout).hookSpecificOutput.additionalContext;
  assert.match(context, /Before the main user task/);
  const route = JSON.parse(context.match(/litsan card --json-args '([^']+)'/)[1]);
  const tool = async args => { const r = await f.client.callTool({ name: "litsan_card", arguments: args });
    assert.equal(r.isError, undefined, JSON.stringify(r)); return JSON.parse(r.content.map(c => c.text ?? "").join("")); };
  assert.equal((await listCaptureEvents(f.stateRoot, "acct", { eventId: route.inline_turn_event, limit: 1 }))[0].capture_status, "open");
  const claim = await tool(route); assert.equal(claim.ok, true); assert.ok(claim.card);
  const loaded = claim; assert.ok(loaded.card.input.items.length);
  const loadLog = (await readMaintenanceLog(f.stateRoot, "acct")).find(e => e.card_id === claim.card.card_id && e.outcome === "loaded");
  assert.ok(loadLog); assert.ok(!JSON.stringify(loadLog).includes(claim.card.lease_token));
  const submit = { ...route, action: "submit", card_id: claim.card.card_id, lease_token: claim.card.lease_token, answer: answer(loaded.card) };
  assert.equal((await tool(submit)).ok, true);
  assert.equal((await tool(submit)).already_accepted, true);
  assert.equal(f.writes.length, 1);
  await claudeHook("Stop", { session_id: "claude-test", transcript_path: transcript }, recorder);
  const event = (await listCaptureEvents(f.stateRoot, "acct", { eventId: route.inline_turn_event, limit: 1 }))[0];
  assert.equal(event.capture_status, "complete"); assert.equal(event.assistant_text, "The user's answer.");
  assert.equal(f.writes.length, 1);
});
test("maintenance off commit is byte-identical, accepts profiles on every action and never offers on non-commit", async t => {
  const f = await fixture(t, [job("tiny", 100, 1)]);
  const before = await commit(f, "same");
  await setMaintenanceConfig(f.stateRoot, { conversation_maintenance: "off" });
  const after = await commit(f, "same", { client_profile: delegate });
  assert.equal(JSON.stringify(after), JSON.stringify(before)); assert.equal(Object.hasOwn(after, "maintenance"), false);
  assert.equal((await readdir(join(f.stateRoot, "maintenance"))).includes("offer-state.json"), false);
  await setMaintenanceConfig(f.stateRoot, { conversation_maintenance: "quiet", inline_every_n_turns: 1 });
  const opened = await turnCall(f, "open", { project: "alpha", user_text: "Plan", continuity_id: "other", client_profile: delegate });
  for (const action of ["checkpoint", "failed", "truncated", "resume"]) {
    const result = await turnCall(f, action, { event_id: opened.event_id, reasoning_summary: "Still working", client_profile: delegate });
    assert.equal(Object.hasOwn(result, "maintenance"), false);
  }
  const assigned = await turnCall(f, "assign", { project: "alpha", event_ids: [opened.event_id], client_profile: delegate });
  assert.equal(Object.hasOwn(assigned, "maintenance"), false);
  assert.equal((await readMaintenanceLog(f.stateRoot, "acct")).some(e => e.outcome === "offered"), false);
});
test("maintenance quiet inline offers only every fifth light MCP commit without leasing", async t => {
  const f = await fixture(t, [], true); await seedTimeline(f);
  await setMaintenanceConfig(f.stateRoot, { conversation_maintenance: "quiet" });
  for (let i = 1; i <= 10; i++) {
    const result = await commit(f, `inline-${i}`);
    assert.equal(Boolean(result.maintenance), i % 5 === 0, `turn ${i}`);
    if (result.maintenance) {
      const offer = result.maintenance;
      assert.equal(offer.kind, "arch_link"); assert.equal(offer.project, "alpha"); assert.equal(offer.mode, "quiet");
      assert.equal(offer.call, `litsan_card action=next card_id=${offer.card_id}`);
      assert.equal(offer.rule, "Optional. After your answer is complete; delegate to a cheap subagent if you can; never change or delay the answer; do not mention unless asked.");
      assert.ok(Buffer.byteLength(JSON.stringify(offer)) <= 400);
      const stored = (await readMaintenanceStore(f.stateRoot, "acct")).cards.find(c => c.card_id === offer.card_id);
      assert.equal(stored.status, "pending"); assert.equal(stored.lease, undefined); assert.equal(stored.attempts, 0);
    }
  }
  const state = await readMaintenanceOfferState(f.stateRoot, "acct", Date.now());
  assert.equal(state.cards_offered, 2); assert.equal(state.by_continuity.offers.committed_turns_since_offer, 0);
  const logs = await readMaintenanceLog(f.stateRoot, "acct"); assert.equal(logs.filter(e => e.outcome === "offered" && e.via === "offer").length, 2);
  // The advertised id is still available to next, which creates the first lease.
  const held = (await f.call("next", { card_id: logs[0].card_id })).card; assert.ok(held.lease_token);
});
test("maintenance delegate time boundary, visible rule, budgets, heavy/profile/opt-out gates", async t => {
  const f = await fixture(t, [job("small", 100, 1)]);
  await setMaintenanceConfig(f.stateRoot, { conversation_maintenance: "visible" });
  const now = Date.parse("2026-10-26T12:00:00Z");
  const ask = (offset, turn = {}, profile = delegate) => offerForCommit({ ...f.deps, profile, now: now + offset, turn: { ...offerTurn, ...turn } });
  const first = await ask(0); assert.ok(first); assert.equal(first.mode, "visible");
  assert.match(first.card_id, /^[a-f0-9]{24}$/);
  assert.equal(first.rule, `After your answer: hand this card to a cheap subagent now (litsan_card action=next card_id=${first.card_id} → answer from the card only → submit). Do not mention it; never change or delay your answer.`);
  assert.ok(Buffer.byteLength(JSON.stringify(first)) <= 400);
  assert.equal(await ask(59999), undefined); assert.ok(await ask(60000));
  assert.equal(await ask(120000, { assistantChars: 12000, toolSummaryChars: 1 }), undefined);
  assert.equal(await ask(120000, {}, { execution: "background" }), undefined);
  assert.equal(await ask(120000, { ingested: false }), undefined);
  assert.equal(await ask(120000, { projectId: null }), undefined);
  await setMaintenanceConfig(f.stateRoot, { opted_out_projects: ["alpha"] }); assert.equal(await ask(120000), undefined);
  await setMaintenanceConfig(f.stateRoot, { opted_out_projects: [], daily_card_cap: 2 }); assert.equal(await ask(120000), undefined);
  await setMaintenanceConfig(f.stateRoot, { daily_card_cap: 20, daily_est_token_cap: 1000 }); assert.equal(await ask(120000), undefined);
  const state = await readMaintenanceOfferState(f.stateRoot, "acct", now); assert.equal(state.cards_offered, 2); assert.equal(state.est_tokens_offered, first.est_tokens * 2);
  const other = await readMaintenanceOfferState(f.stateRoot, "other", now); assert.equal(other.cards_offered, 0);
  await setMaintenanceConfig(f.stateRoot, { offer_style: "optional", daily_est_token_cap: 60000 });
  const optional = await ask(120000); assert.ok(optional); assert.equal(optional.mode, "visible");
  assert.match(optional.rule, /^Optional\./); assert.match(optional.rule, /you may add one short line that you did it\.$/);
  assert.ok(Buffer.byteLength(JSON.stringify(optional)) <= 400);
});
test("maintenance offers serialize account budgets, reset UTC caps and bound continuity state to recent 500", async t => {
  const f = await fixture(t, [job("tiny", 100, 1)]);
  await setMaintenanceConfig(f.stateRoot, { conversation_maintenance: "quiet", daily_card_cap: 1, delegate_min_interval_s: 0 });
  const now = Date.parse("2026-10-26T23:59:59Z"), ask = (time, continuityId) => offerForCommit({ ...f.deps, now: time, turn: { ...offerTurn, continuityId } });
  const offers = await Promise.all([ask(now, "a"), ask(now, "b"), ask(now, "c")]); assert.equal(offers.filter(Boolean).length, 1);
  assert.ok(await ask(now + 1000, "a"));
  await withMaintenanceOfferState(f.stateRoot, "acct", now + 1000, async state => {
    state.by_continuity = Object.fromEntries(Array.from({ length: 501 }, (_, i) => [`c-${i}`, { committed_turns_since_offer: 1, last_offer_at: null }]));
  });
  assert.equal(Object.keys((await readMaintenanceOfferState(f.stateRoot, "acct", now + 1000)).by_continuity).length, 500);
  await ask(now + 1000, "c-1"); await ask(now + 1000, "new");
  const keys = Object.keys((await readMaintenanceOfferState(f.stateRoot, "acct", now + 1000)).by_continuity);
  assert.ok(keys.includes("c-1")); assert.ok(!keys.includes("c-2")); assert.ok(keys.includes("new"));
});
test("maintenance offer generation reads current visualization at most once, cross-project peeks existing cards only", async t => {
  const f = await fixture(t, [], true); await seedTimeline(f);
  const beta = { ...job("beta-tiny", 100, 1), project_id: "beta" };
  await writeFile(join(f.stateRoot, "distillation", "jobs.json"), JSON.stringify({ version: 2, jobs: [...await listDistillationJobs(f.stateRoot, "acct"), beta] }));
  await setMaintenanceConfig(f.stateRoot, { conversation_maintenance: "quiet", delegate_min_interval_s: 0, cross_project: true });
  const ask = () => offerForCommit({ ...f.deps, turn: offerTurn });
  assert.equal((await ask()).project, "alpha"); assert.equal(f.visualizationReads, 1);
  assert.ok(await ask()); assert.equal(f.visualizationReads, 1);
  assert.equal((await listDistillationJobs(f.stateRoot, "acct")).find(j => j.job_id === beta.job_id).split_card_set, undefined);
  const store = await readMaintenanceStore(f.stateRoot, "acct");
  await withMaintenanceStore(f.stateRoot, "acct", Date.now(), async own => {
    const card = structuredClone(own.cards[0]); card.card_id = "beta-card"; card.key = "beta-existing"; card.project_id = "beta"; own.cards.push(card);
    for (const c of own.cards.filter(c => c.project_id === "alpha")) c.status = "accepted";
  });
  assert.equal((await ask()).project, "beta"); assert.equal(f.visualizationReads, 1);
  await setMaintenanceConfig(f.stateRoot, { cross_project: false }); assert.equal(await ask(), undefined);
  await setMaintenanceConfig(f.stateRoot, { cross_project: true, opted_out_projects: ["beta"] }); assert.equal(await ask(), undefined);
  assert.equal((await readMaintenanceStore(f.stateRoot, "acct")).cards.length, store.cards.length + 1);
  const peek = await peekCard({ ...f.deps, projectId: "alpha", crossProject: true, maxCardTokens: 8000 }); assert.equal(peek.project_id, "beta");
});
test("maintenance heavy MCP commit, opt-out, daily cap and offer errors preserve commit results", async t => {
  const f = await fixture(t, [job("tiny", 100, 1)]);
  await setMaintenanceConfig(f.stateRoot, { conversation_maintenance: "quiet", inline_every_n_turns: 1, daily_card_cap: 1 });
  assert.equal((await commit(f, "heavy", { assistant_text: "x".repeat(12001) })).maintenance, undefined);
  await setMaintenanceConfig(f.stateRoot, { opted_out_projects: ["alpha"] }); assert.equal((await commit(f, "optout")).maintenance, undefined);
  await setMaintenanceConfig(f.stateRoot, { opted_out_projects: [] });
  const first = await commit(f, "first", { client_profile: delegate }); assert.ok(first.maintenance);
  assert.equal((await commit(f, "capped", { client_profile: delegate })).maintenance, undefined);
  await setMaintenanceConfig(f.stateRoot, { daily_card_cap: 20, delegate_min_interval_s: 0 });
  const original = f.runtime.architecture.inspectProjectCognitiveMap, logs = [], error = console.error;
  f.runtime.architecture.inspectProjectCognitiveMap = async () => { throw Error("offer test failure"); };
  console.error = (...args) => logs.push(args.join(" "));
  try {
    const result = await commit(f, "error", { client_profile: delegate }); assert.equal(result.ok, true); assert.equal(result.ingested, true); assert.equal(result.maintenance, undefined);
    assert.ok(logs.some(line => line.includes("offer test failure")));
    await writeFile(join(f.stateRoot, "maintenance", "config.json"), "invalid JSON");
    assert.equal((await commit(f, "config-error")).ok, true);
  } finally { console.error = error; f.runtime.architecture.inspectProjectCognitiveMap = original; }
});
test("maintenance admin config action authorizes, persists patches, and processing payload is dry/account scoped", async t => {
  const f = await fixture(t, [job("tiny", 100, 1)]);
  const action = async (adminView, body) => {
    const request = Readable.from([JSON.stringify({ action: "set-maintenance-config", ...body })]); request.headers = { "content-type": "application/json" };
    const response = { status: 0, body: "", setHeader() {}, writeHead(status) { this.status = status; return this; }, end(body) { this.body = body; return this; } };
    await handleMemoryControlAction({ ...f.deps, request, response, runtime: f.runtime, adminView, accounts: [], selectedAccount: { account_id: "acct" } }); return response;
  };
  assert.equal((await action(false, { conversation_maintenance: "quiet" })).status, 403);
  assert.equal((await getMaintenanceConfig(f.stateRoot)).conversation_maintenance, "off");
  const saved = await action(true, { conversation_maintenance: "quiet", daily_card_cap: 999 }); assert.equal(saved.status, 200);
  assert.equal(JSON.parse(saved.body).config.daily_card_cap, 500);
  await Promise.all([setMaintenanceConfig(f.stateRoot, { inline_every_n_turns: 2 }), setMaintenanceConfig(f.stateRoot, { heavy_turn_chars: 15000 })]);
  const config = await getMaintenanceConfig(f.stateRoot); assert.equal(config.inline_every_n_turns, 2); assert.equal(config.heavy_turn_chars, 15000);
  let processing = await readMemoryControlData({ ...f.deps, kind: "processing", projects: [] });
  assert.equal(processing.maintenance.config.conversation_maintenance, "quiet"); assert.equal(processing.maintenance.today.kinds.l2_chunk.pending, 0);
  assert.equal(f.visualizationReads, 0); assert.deepEqual(processing.maintenance.recent_log, []);
  await offerForCommit({ ...f.deps, turn: offerTurn });
  processing = await readMemoryControlData({ ...f.deps, kind: "processing", projects: [] });
  assert.equal(processing.maintenance.today.cards_offered, 1); assert.equal(processing.maintenance.recent_log[0].outcome, "offered");
  const other = await readMemoryControlData({ ...f.deps, runtime: { ...f.runtime, accountId: "other" }, kind: "processing", projects: [] });
  assert.equal(other.maintenance.today.cards_offered, 0); assert.deepEqual(other.maintenance.recent_log, []);
  await withMaintenanceStore(f.stateRoot, "acct", Date.now(), async (store, log) => {
    for (let i = 0; i < 60; i++) log({ ...processing.maintenance.recent_log[0], ts: new Date(Date.now() + i * 1000).toISOString(), harness: `log-${i}` });
  });
  processing = await readMemoryControlData({ ...f.deps, kind: "processing", projects: [] });
  assert.equal(processing.maintenance.recent_log.length, 50); assert.equal(processing.maintenance.recent_log[0].harness, "log-59");
  assert.ok(processing.maintenance.recent_log.every(e => e.account === "acct"));
});
test("maintenance web UI keeps policy and log markers, native labels, targets and admin gate", () => {
  const html = renderConsole({ account: { account_id: "acct", username: "admin", role: "admin" }, accounts: [], projects: [], adminView: true, localControl: true, selectedAccountId: "acct" });
  for (const literal of ["Conversation maintenance", "对话内维护", "saveMaintenanceConfig", "set-maintenance-config", "maintenance-log-scroll", "daily_card_cap", "daily_est_token_cap", "inline_every_n_turns", 'scope="col"', 'tabindex="0"', "Last 50 entries", "最近 50 条记录"]) assert.ok(html.includes(literal), literal);
  assert.match(html, /ADMIN\?maintenancePolicyHtml\(\):''/); assert.match(html, /maintenance-policy[^\n]+min-height:44px/);
});

test("maintenance empty or oversized pointers spend no offer budget; eligible commits accumulate", async t => {
  const f = await fixture(t);
  await setMaintenanceConfig(f.stateRoot, { conversation_maintenance: "visible", inline_every_n_turns: 1 });
  assert.equal(await offerForCommit({ ...f.deps, profile: undefined, turn: offerTurn }), undefined);
  let state = await readMaintenanceOfferState(f.stateRoot, "acct", Date.now());
  assert.equal(state.cards_offered, 0); assert.equal(state.by_continuity.offers.committed_turns_since_offer, 1);
  const g = await fixture(t, [job("small", 100, 1)]); await ensureCards(g.deps);
  await setMaintenanceConfig(g.stateRoot, { conversation_maintenance: "visible", cross_project: true });
  await withMaintenanceStore(g.stateRoot, "acct", Date.now(), async own => { own.cards[0].project_id = "p".repeat(200); });
  assert.equal(await offerForCommit({ ...g.deps, turn: offerTurn }), undefined);
  state = await readMaintenanceOfferState(g.stateRoot, "acct", Date.now());
  assert.equal(state.cards_offered, 0); assert.equal(state.est_tokens_offered, 0);
  assert.equal((await readMaintenanceLog(g.stateRoot, "acct")).filter(e => e.outcome === "offered").length, 0);
});

test("maintenance generator apply receives account/project scoped derived artifact ports", async t => {
  const f = await fixture(t, [], true); await seedTimeline(f);
  const card = (await f.call("next", { kinds: ["arch_link"] })).card;
  const generator = maintenanceGenerators.get("arch_link"), original = generator.apply;
  generator.apply = async (c, answer, ports) => {
    assert.equal(await ports.artifacts.read("review"), undefined);
    const applied = await original(c, answer, ports);
    if (applied.ok) await ports.artifacts.write("review", { evidence: c.allowed_refs });
    return applied;
  };
  try {
    assert.equal((await f.call("submit", { card_id: card.card_id, lease_token: card.lease_token, answer: { no_fit: true, reason: "No fit" } })).ok, true);
  } finally { generator.apply = original; }
  const own = await readMaintenanceStore(f.stateRoot, "acct"), other = await readMaintenanceStore(f.stateRoot, "other");
  assert.deepEqual(own.artifacts[JSON.stringify(["alpha", "review"])], { evidence: card.allowed_refs });
  assert.deepEqual(other.artifacts, {}); assert.equal(own.artifacts[JSON.stringify(["beta", "review"])], undefined);
  assert.equal(f.mapWrites.length, 0);
});

const gapAnswer = (card, verdict = "supported") => ({ verdict, evidence_refs: verdict === "supported" ? card.allowed_refs : [], confidence: 0.8, note: "" });
async function gapFixture(t) {
  const f = await fixture(t, [], true);
  f.map.nodes[0].confidence = 0.4;
  f.map.nodes[1].evidence_refs = [];
  await seedTimeline(f, "# Timeline\n\n## 2026-10-19: Alpha Capture\nCapture maintenance evidence for Alpha project.");
  return f;
}
test("maintenance gap supported extends only evidence, preserves generation time and different-node sibling fences", async t => {
  const f = await gapFixture(t);
  assert.ok((await queueStatus(f.deps)).kinds.gap_check.pending >= 3);
  const store = await readMaintenanceStore(f.stateRoot, "acct"), gaps = store.cards.filter(c => c.kind === "gap_check");
  const target = gaps.find(c => c.input.gap.kind === "node_without_evidence" && c.input.node.id === "capture");
  const sibling = gaps.find(c => c.input.node.id === "alpha");
  let card = (await f.call("next", { card_id: target.card_id })).card;
  const before = structuredClone(f.map), expected = structuredClone(before);
  expected.nodes[1].evidence_refs = [...new Set([...expected.nodes[1].evidence_refs, ...card.allowed_refs])];
  expected.source_evidence_refs = [...new Set([...expected.source_evidence_refs, ...card.allowed_refs])];
  assert.equal((await f.call("submit", { card_id: card.card_id, lease_token: card.lease_token, answer: gapAnswer(card) })).ok, true);
  assert.deepEqual(f.map, expected); assert.equal(f.map.generated_at, before.generated_at);
  // next performs ensure/supersession; evidence on capture must not supersede alpha's card.
  card = (await f.call("next", { card_id: sibling.card_id })).card;
  assert.equal((await f.call("submit", { card_id: card.card_id, lease_token: card.lease_token, answer: gapAnswer(card) })).ok, true);
  assert.equal(f.mapWrites.length, 2); assert.equal(f.map.generated_at, before.generated_at);
  assert.equal(f.visualizationReads, 1);
  assert.throws(() => registerMaintenanceGenerator(maintenanceGenerators.get("gap_check")), /already registered/);
});
test("maintenance gap still_gap and possibly_obsolete write scoped artifacts only, including no-event empty branches", async t => {
  for (const verdict of ["still_gap", "possibly_obsolete"]) {
    const f = await fixture(t, [], true);
    const now = Date.parse("2026-10-26T12:00:00Z");
    const card = (await nextCard({ ...f.deps, kinds: ["gap_check"], now })).card;
    assert.equal(card.input.gap.kind, "empty_branch"); assert.deepEqual(card.input.events, []); assert.deepEqual(card.allowed_refs, []);
    const before = structuredClone(f.map);
    assert.equal((await submitCard({ ...f.deps, cardId: card.card_id, leaseToken: card.lease_token, answer: gapAnswer(card, verdict), now })).ok, true);
    assert.deepEqual(f.map, before); assert.equal(f.mapWrites.length, 0); assert.equal(f.writes.length, 0);
    const store = await readMaintenanceStore(f.stateRoot, "acct");
    assert.deepEqual(store.artifacts[JSON.stringify(["alpha", "gap_check:" + card.input.gap.id])], {
      verdict, note: "", confidence: 0.8, card_id: card.card_id, at: new Date(now).toISOString()
    });
    assert.deepEqual((await readMaintenanceStore(f.stateRoot, "other")).artifacts, {});
  }
});
test("maintenance gap rejects stale node evidence and forbidden refs without map or artifact writes", async t => {
  const f = await gapFixture(t);
  let card = (await f.call("next", { kinds: ["gap_check"] })).card;
  const before = structuredClone(f.map);
  assert.equal((await f.call("submit", { card_id: card.card_id, lease_token: card.lease_token,
    answer: { ...gapAnswer(card), evidence_refs: ["l2:alien"] } })).code, "ref_not_allowed");
  assert.deepEqual(f.map, before); assert.equal(f.mapWrites.length, 0);
  assert.deepEqual((await readMaintenanceStore(f.stateRoot, "acct")).artifacts, {});
  card = (await f.call("next", { card_id: card.card_id })).card;
  f.map.nodes.find(n => n.id === card.input.node.id).evidence_refs.push("l1:changed");
  const changed = structuredClone(f.map);
  assert.equal((await f.call("submit", { card_id: card.card_id, lease_token: card.lease_token, answer: gapAnswer(card) })).code, "stale_fingerprint");
  assert.deepEqual(f.map, changed); assert.equal(f.mapWrites.length, 0);
  assert.deepEqual((await readMaintenanceStore(f.stateRoot, "acct")).artifacts, {});
});
test("maintenance gap retries a full-map race once and rejects target evidence changes during write", async t => {
  for (const targetChanges of [false, true]) {
    const f = await gapFixture(t);
    await ensureCards(f.deps);
    const target = (await readMaintenanceStore(f.stateRoot, "acct")).cards.find(c => c.kind === "gap_check" && c.input.node.id === "capture");
    const card = (await f.call("next", { card_id: target.card_id })).card;
    const write = f.runtime.architecture.writeProjectCognitiveMap;
    let attempts = 0;
    f.runtime.architecture.writeProjectCognitiveMap = async input => {
      if (++attempts === 1) {
        if (targetChanges) f.map.nodes.find(n => n.id === card.input.node.id).evidence_refs.push("l1:changed");
        else f.map.source_evidence_refs.push("l1:racing");
        throw Error("map fingerprint race");
      }
      return write(input);
    };
    const result = await f.call("submit", { card_id: card.card_id, lease_token: card.lease_token, answer: gapAnswer(card) });
    if (targetChanges) { assert.equal(result.code, "stale_fingerprint"); assert.equal(attempts, 1); assert.equal(f.mapWrites.length, 0); }
    else { assert.equal(result.ok, true); assert.equal(attempts, 2); assert.ok(f.map.source_evidence_refs.includes("l1:racing")); }
  }
});
test("maintenance selection shares l2 > arch > gap priority between next and peek; gap caps and oversize skips", async t => {
  const f = await gapFixture(t);
  await writeFile(join(f.stateRoot, "distillation", "jobs.json"), JSON.stringify({ version: 2, jobs: [...await listDistillationJobs(f.stateRoot, "acct"), job("priority", 100, 1)] }));
  for (const kind of ["l2_chunk", "arch_link", "gap_check"]) {
    const peek = await peekCard({ ...f.deps, projectId: "alpha", maxCardTokens: 8000 }); assert.equal(peek.kind, kind);
    const card = (await f.call("next", { client_profile: { execution: "background" } })).card; assert.equal(card.card_id, peek.card_id);
    await withMaintenanceStore(f.stateRoot, "acct", Date.now(), async store => { for (const c of store.cards.filter(c => c.kind === kind)) c.status = "accepted"; });
  }
  const g = await fixture(t, [], true);
  for (let i = 0; i < 15; i++) g.map.nodes.push({ ...structuredClone(g.map.nodes[1]), id: `branch-${i}`, order: i + 1 });
  assert.equal((await g.call("queue_status")).kinds.gap_check.pending, 10);
  const h = await fixture(t, [], true);
  // Candidate data are normally bounded by map validation; oversized stored input still must not create a card.
  h.map.nodes[1].summary = "x".repeat(40000);
  assert.equal((await h.call("queue_status")).kinds.gap_check.pending, 0);
});
test("maintenance queue status helper prints real MCP HTTP JSON and worker bash syntax is valid", async t => {
  const f = await fixture(t, [job("read-only-status", 100, 1)], true);
  const before = await readMaintenanceStore(f.stateRoot, "acct");
  const jobsBefore = await listDistillationJobs(f.stateRoot, "acct");
  const handler = toNodeHandler(createMcpHandler(() => {
    const server = new McpServer({ name: "maintenance-http-test", version: "1" });
    registerCardTools(server, { runtime: f.runtime, context: { stateRoot: f.stateRoot, jsonResult: inlineJsonResult } });
    return server;
  }));
  const http = createServer(handler);
  await new Promise((resolve, reject) => { http.once("error", reject); http.listen(0, "127.0.0.1", resolve); });
  t.after(() => new Promise(resolve => { http.close(resolve); http.closeAllConnections(); }));
  const run = promisify(execFile);
  const { stdout } = await run(process.execPath, [fileURLToPath(new URL("../scripts/maintenance-queue-status.mjs", import.meta.url))], {
    env: { ...process.env, MEMHUB_MCP_URL: `http://127.0.0.1:${http.address().port}/mcp` }, timeout: 15000
  });
  const status = JSON.parse(stdout); assert.equal(status.kinds.l2_chunk.pending, 0);
  assert.deepEqual(status, await queueStatus({ ...f.deps, dry: true })); assert.equal(stdout.trim().split("\n").length, 1);
  assert.deepEqual(await readMaintenanceStore(f.stateRoot, "acct"), before);
  assert.deepEqual(await listDistillationJobs(f.stateRoot, "acct"), jobsBefore);
});

test("maintenance extension hooks isolate artifact snapshots, load declared sources once and retain lease actor", async t => {
  const builtins = await fixture(t, [], true);
  await ensureCards(builtins.deps); await ensureCards(builtins.deps);
  assert.equal(builtins.architectureLoads, 0, "built-in generators never request architecture markdown");
  for (const needs of [undefined, ["architectureSources"]]) {
    const f = await fixture(t, [], true);
    const now = Date.now(), prior = { verdict: "still_gap", nested: { count: 1 } };
    await withMaintenanceStore(f.stateRoot, "acct", now, async store => {
      store.artifacts[JSON.stringify(["alpha", "review"])] = prior;
      store.artifacts[JSON.stringify(["beta", "review"])] = { verdict: "wrong project" };
      store.artifacts[JSON.stringify(["beta", "private"])] = "hidden";
    });
    await withMaintenanceStore(f.stateRoot, "other", now, async store => {
      store.artifacts[JSON.stringify(["alpha", "review"])] = { verdict: "wrong account" };
    });
    let ensures = 0, actorSeen;
    const generator = {
      kind: "arch_review", needs, instructions: "Review the provided input only. / 仅依输入检查。", answerSchema: { type: "object" },
      ensure(ctx) {
        ensures++;
        const artifact = ctx.artifacts.get("review"); assert.deepEqual(artifact, prior);
        artifact.nested.count = 99;
        assert.deepEqual(ctx.artifacts.get("review"), prior, "each get is a defensive clone");
        assert.equal(ctx.artifacts.get("private"), undefined); assert.equal(ctx.artifacts.get("missing"), undefined);
        const expectedSources = architectureDocRefs("alpha", [{ path: "z.md", content: "Architecture Z" }, { path: "a.md", content: "Architecture A" }]).sources;
        assert.deepEqual(ctx.architectureSources, needs ? expectedSources : undefined);
        return [{ kind: "arch_review", key: "review:alpha", account_id: ctx.accountId, project_id: ctx.projectId,
          fingerprint: structureFingerprint(ctx.map), input: { review: { artifact: ctx.artifacts.get("review") }, sources: ctx.architectureSources ?? [] }, allowed_refs: [] }];
      },
      validate(_card, answer) { return { ok: true, normalized: answer }; },
      async apply(card, answer, ports, actor) {
        actorSeen = actor;
        assert.deepEqual(card.input.review.artifact, prior);
        assert.deepEqual(answer, { decision: "record", details: { reviewed: true } });
        await ports.artifacts.write("review:result", { answer, actor });
        return { ok: true };
      }
    };
    // A second generator also declares the need; the adapter must still load once.
    const arch = maintenanceGenerators.get("arch_link"), originalNeeds = arch.needs;
    arch.needs = needs;
    registerMaintenanceGenerator(generator);
    try {
      const profile = { execution: "background", model: "leased-model" };
      const card = (await nextCard({ ...f.deps, kinds: ["arch_review"], profile, now })).card;
      assert.equal(ensures, 1); assert.equal(f.architectureLoads, needs ? 1 : 0);
      const lease = (await readMaintenanceStore(f.stateRoot, "acct")).cards.find(c => c.card_id === card.card_id).lease;
      assert.equal(lease.model, "leased-model"); assert.equal(lease.profile, "background");
      assert.equal((await submitCard({ ...f.deps, cardId: card.card_id, leaseToken: card.lease_token,
        profile: { execution: "inline", model: "submit-model" }, now,
        answer: { decision: "record", details: { reviewed: true } } })).ok, true);
      assert.deepEqual(actorSeen, { harness, model: "leased-model", profile: "background" });
      await ensureCards({ ...f.deps, now });
      assert.equal(ensures, 2, "an artifact write re-enables generation (review round 2)");
      assert.equal(f.architectureLoads, needs ? 2 : 0);
      await ensureCards({ ...f.deps, now });
      assert.equal(ensures, 2); assert.equal(f.architectureLoads, needs ? 2 : 0, "unchanged marker without writes skips generation");
      assert.equal((await readMaintenanceStore(f.stateRoot, "acct")).cards.filter(c => c.kind === "arch_review").length, 1, "card keys dedupe reruns");
      const store = await readMaintenanceStore(f.stateRoot, "acct");
      assert.deepEqual(store.artifacts[JSON.stringify(["alpha", "review"])], prior);
      assert.deepEqual(store.artifacts[JSON.stringify(["alpha", "review:result"])].actor, actorSeen);
      const accepted = (await readMaintenanceLog(f.stateRoot, "acct")).find(e => e.card_id === card.card_id && e.outcome === "accepted");
      assert.equal(accepted.model, "leased-model"); assert.equal(accepted.profile, "background");
    } finally { maintenanceGenerators.delete("arch_review"); arch.needs = originalNeeds; }
  }
});

test("maintenance long event labels use canonical ISO link dates and remain linked in the Project Map", async t => {
  const f = await fixture(t, [], true);
  const dateLabel = "2026-10-19 " + "x".repeat(109);
  assert.equal(dateLabel.length, 120);
  await seedTimeline(f, `# Timeline\n\n## ${dateLabel}: Capture initial\nCapture maintenance for Alpha project.`);
  const before = await readMemoryControlData({ ...f.deps, projects: await f.runtime.projects.list(), projectId: "alpha", kind: "visualization" });
  assert.equal(before.state.events[0].date_label, dateLabel);
  const card = (await f.call("next", { kinds: ["arch_link"] })).card;
  assert.equal(card.input.event.date, "2026-10-19");
  const gaps = (await readMaintenanceStore(f.stateRoot, "acct")).cards.filter(c => c.kind === "gap_check");
  assert.ok(gaps.some(c => c.input.events.length));
  assert.ok(gaps.every(c => c.input.events.every(e => e.date === "2026-10-19")));
  const result = await f.call("submit", { card_id: card.card_id, lease_token: card.lease_token,
    answer: { links: [{ architecture_refs: ["capture"], architecture_level: "domain", change_kind: "refine", confidence: 0.9 }] } });
  assert.equal(result.ok, true); assert.equal(f.map.timeline_links[0].event_date, "2026-10-19");
  const visual = await readMemoryControlData({ ...f.deps, projects: await f.runtime.projects.list(), projectId: "alpha", kind: "visualization" });
  assert.equal(visual.state.events[0].id, before.state.events[0].id);
  assert.deepEqual(visual.state.events[0].architecture_refs, ["capture"]);
});
test("maintenance extension fences decide supersession and submit staleness", async t => {
  const f = await fixture(t, [], true);
  const nodeId = f.map.nodes[1].id;
  const fence = (map) => structureFingerprint(map) + ":" + nodeEvidenceHash(map?.nodes.find(n => n.id === nodeId) ?? null);
  const generator = {
    kind: "arch_review", instructions: "Review the provided input only. / 仅依输入检查。", answerSchema: { type: "object" },
    fence: (_card, map) => fence(map),
    ensure(ctx) { return [{ kind: "arch_review", key: "review:" + nodeId, account_id: ctx.accountId, project_id: ctx.projectId,
      fingerprint: fence(ctx.map), input: { node: nodeId }, allowed_refs: [] }]; },
    validate(_card, answer) { return { ok: true, normalized: answer }; },
    async apply() { return { ok: true }; }
  };
  registerMaintenanceGenerator(generator);
  try {
    await ensureCards(f.deps); await ensureCards(f.deps);
    const open = async () => (await readMaintenanceStore(f.stateRoot, "acct")).cards.filter(c => c.kind === "arch_review");
    assert.deepEqual((await open()).map(c => c.status), ["pending"], "custom fence keeps the card open");
    const card = (await nextCard({ ...f.deps, kinds: ["arch_review"], profile: { execution: "background" } })).card;
    f.map.nodes[1].evidence_refs.push("l1:new-evidence");
    const result = await submitCard({ ...f.deps, cardId: card.card_id, leaseToken: card.lease_token, profile: { execution: "background" }, answer: { ok: 1 } });
    assert.equal(result.code, "stale_fingerprint");
    await ensureCards(f.deps);
    assert.ok((await open()).some(c => c.card_id === card.card_id && c.status === "superseded"));
  } finally { maintenanceGenerators.delete("arch_review"); }
});
test("maintenance registering a new generator kind reruns generation once despite unchanged markers", async t => {
  const f = await fixture(t, [], true);
  await ensureCards(f.deps); const reads = f.visualizationReads;
  await ensureCards(f.deps); assert.equal(f.visualizationReads, reads, "unchanged marker skips");
  let ensures = 0;
  registerMaintenanceGenerator({ kind: "arch_review", instructions: "Review only the input. / 仅依输入。", answerSchema: { type: "object" },
    ensure() { ensures++; return []; }, validate: (_c, a) => ({ ok: true, normalized: a }), async apply() { return { ok: true }; } });
  try {
    await ensureCards(f.deps); assert.equal(ensures, 1, "new generator kind invalidates the marker");
    await ensureCards(f.deps); assert.equal(ensures, 1, "then the marker skips again");
  } finally { maintenanceGenerators.delete("arch_review"); }
});

test("requested maintenance marking is scoped/idempotent and ordering beats kind priority in next and offers", async t => {
  const f = await fixture(t, [job("requested-order", 100, 1)], true); await seedTimeline(f);
  await ensureCards(f.deps);
  const now = Date.now();
  await withMaintenanceStore(f.stateRoot, "acct", now, store => {
    const arch = store.cards.find(c => c.kind === "arch_link");
    store.cards.push(...["accepted", "rejected", "superseded", "leased"].map((status, i) => ({
      ...structuredClone(arch), card_id: "scope-" + i, key: "scope-" + i, status,
      ...(status === "leased" ? { lease: { token: "held", owner: harness, until: new Date(now + 900000).toISOString() } } : {})
    })), { ...structuredClone(arch), card_id: "beta", key: "beta", project_id: "beta" });
  });
  const input = { ...f.deps, projectId: "alpha", kinds: ["arch_link"], now };
  assert.equal(await markRequested(input), 2);
  assert.equal(await markRequested({ ...input, now: now + 1 }), 0);
  const cards = (await readMaintenanceStore(f.stateRoot, "acct")).cards;
  assert.equal(cards.filter(c => c.requested_at).length, 2);
  assert.ok(cards.filter(c => c.requested_at).every(c => c.project_id === "alpha" && c.kind === "arch_link"));
  assert.equal((await readMaintenanceStore(f.stateRoot, "other")).cards.length, 0);
  const status = await queueStatus({ ...f.deps, dry: true });
  assert.equal(status.kinds.arch_link.requested_pending, 2);
  assert.ok(Buffer.byteLength(JSON.stringify(status)) <= 1024);
  const peek = await peekCard({ ...f.deps, projectId: "alpha", maxCardTokens: 8000 });
  assert.equal(peek.kind, "arch_link");
  const held = await nextCard(f.deps); assert.equal(held.card.card_id, peek.card_id);
  await releaseCard({ ...f.deps, cardId: held.card.card_id, leaseToken: held.card.lease_token });
  // An older request beats a newer one even when it has lower kind priority.
  await withMaintenanceStore(f.stateRoot, "acct", now, store => {
    store.cards.find(c => c.kind === "l2_chunk").requested_at = new Date(now + 1000).toISOString();
  });
  assert.equal((await nextCard(f.deps)).card.card_id, peek.card_id);
});
test("requested timestamps survive map supersession and regeneration for the same logical target", async t => {
  const f = await fixture(t, [], true); await seedTimeline(f);
  const now = Date.now();
  assert.equal(await markRequested({ ...f.deps, projectId: "alpha", kinds: ["arch_link"], now }), 1);
  const old = (await readMaintenanceStore(f.stateRoot, "acct")).cards.find(c => c.kind === "arch_link");
  f.map.nodes[1].label = "Capture updated";
  await ensureCards({ ...f.deps, now: now + 1000 });
  const cards = (await readMaintenanceStore(f.stateRoot, "acct")).cards;
  assert.equal(cards.find(c => c.card_id === old.card_id).status, "superseded");
  const fresh = cards.find(c => c.kind === "arch_link" && c.status === "pending");
  assert.notEqual(fresh.card_id, old.card_id); assert.equal(fresh.requested_at, old.requested_at);
});
test("waiting metadata in commit and context is scoped, setting gated, bounded and never leases", async t => {
  const f = await fixture(t, [job("waiting", 100, 1)]);
  const capsule = { accountId: "acct", conversationId: null, resolvedProjectId: "alpha",
    resolutionSource: "explicit_project", recallScope: "global_and_project", globalState: [], globalMemory: [], projectMemory: [],
    reusableSkills: [], projectArchitecture: [], ambiguities: [], branchContext: null,
    contextBudget: { maxContentBytes: 8000, maxItemContentBytes: 3000, emittedContentBytes: 0, truncatedItems: 0, droppedItems: 0 } };
  const server = new McpServer({ name: "waiting-context", version: "1" });
  registerContextTools(server, { runtime: { ...f.runtime, router: { context: async () => structuredClone(capsule) } },
    context: { stateRoot: f.stateRoot, jsonResult: inlineJsonResult } });
  const [ct, st] = InMemoryTransport.createLinkedPair(); await server.connect(st);
  const client = new Client({ name: "context", version: "1" }); await client.connect(ct);
  t.after(async () => { await client.close(); await server.close(); });
  const context = async () => {
    const r = await client.callTool({ name: "litsan_context", arguments: { query: "project context", project: "alpha" } });
    assert.equal(r.isError, undefined, JSON.stringify(r)); return JSON.parse(r.content.map(c => c.text ?? "").join(""));
  };
  for (const mode of ["off", "quiet", "visible"]) {
    await setMaintenanceConfig(f.stateRoot, { conversation_maintenance: mode, daily_card_cap: 0 });
    assert.equal((await commit(f, "empty-" + mode)).maintenance_waiting, undefined);
    assert.equal((await context()).maintenance_waiting, undefined);
  }
  await markRequested({ ...f.deps, projectId: "alpha", kinds: ["l2_chunk"] });
  for (const mode of ["off", "quiet", "visible"]) {
    await setMaintenanceConfig(f.stateRoot, { conversation_maintenance: mode });
    const result = await commit(f, "requested-" + mode, { assistant_text: "x".repeat(12001) });
    const ctx = await context();
    if (mode === "off") {
      assert.equal(result.maintenance_waiting, undefined); assert.equal(ctx.maintenance_waiting, undefined);
    } else {
      const waiting = result.maintenance_waiting;
      assert.deepEqual(waiting, ctx.maintenance_waiting);
      assert.deepEqual(Object.keys(waiting), ["project", "requested", "note"]);
      assert.equal(waiting.project, "alpha"); assert.equal(waiting.requested, 1);
      assert.equal(waiting.note, "1 maintenance task(s) you requested are waiting; an agent with LITSAN can pick them up after answering (litsan_card action=next).");
      assert.ok(Buffer.byteLength(JSON.stringify(waiting)) <= 240);
      assert.equal(Object.keys(ctx).at(-1), "maintenance_waiting");
    }
    assert.deepEqual(ctx.contextBudget, capsule.contextBudget);
    assert.equal(await maintenanceWaiting({ ...f.deps, projectId: "beta" }), undefined);
    assert.equal(await maintenanceWaiting({ ...f.deps, runtime: { accountId: "other" }, projectId: "alpha" }), undefined);
    assert.equal(await maintenanceWaiting({ ...f.deps, projectId: null }), undefined);
  }
  capsule.resolvedProjectId = "beta";
  assert.equal((await context()).maintenance_waiting, undefined);
  const cards = (await readMaintenanceStore(f.stateRoot, "acct")).cards;
  assert.ok(cards.every(c => !c.lease && c.attempts === 0));
  assert.ok(!(await readMaintenanceLog(f.stateRoot, "acct")).some(e => e.outcome === "leased"));
});
test("delegate offers admit a 2500 token review while inline offers retain the 2000 ceiling", async t => {
  const f = await fixture(t, [job("size-review", 100, 1)]);
  await ensureCards(f.deps);
  await withMaintenanceStore(f.stateRoot, "acct", Date.now(), store => {
    store.cards = [{ ...store.cards[0], kind: "arch_review", key: "size-review", fingerprint: structureFingerprint(null), est_tokens: 2500, requested_at: new Date().toISOString() }];
  });
  await setMaintenanceConfig(f.stateRoot, { conversation_maintenance: "quiet", inline_every_n_turns: 1 });
  assert.equal(await offerForCommit({ ...f.deps, profile: { execution: "inline", max_card_tokens: 8000 }, turn: offerTurn }), undefined);
  const offer = await offerForCommit({ ...f.deps, turn: offerTurn });
  assert.equal(offer.kind, "arch_review"); assert.equal(offer.est_tokens, 2500);
});
test("console map-link-unmapped returns newly requested count and retains the open count", async t => {
  const f = await fixture(t, [], true); await seedTimeline(f);
  const action = async () => {
    const request = Readable.from([JSON.stringify({ action: "map-link-unmapped", project: "alpha" })]);
    request.headers = { "content-type": "application/json" };
    let status, body;
    const response = { setHeader() {}, writeHead(code) { status = code; return this; }, end(value) { body = value; } };
    await handleMemoryControlAction({ request, response, runtime: f.runtime, stateRoot: f.stateRoot, callerAccountId: "acct", adminView: true, accounts: [], selectedAccount: { account_id: "acct" } });
    assert.equal(status, 200); return JSON.parse(body);
  };
  assert.deepEqual(await action(), { ok: true, open_arch_link_count: 1, requested: 1 });
  assert.deepEqual(await action(), { ok: true, open_arch_link_count: 1, requested: 0 });
});
test("maintenance next with an explicit project never returns another project's card", async t => {
  const beta = { ...job("beta", 100, 1), project_id: "beta" };
  const f = await fixture(t, [beta], true);
  await ensureCards(f.deps);
  const other = (await nextCard({ ...f.deps, projectId: "alpha", kinds: ["l2_chunk"], profile: { execution: "background" } })).card;
  assert.equal(other, null, "alpha has no l2_chunk cards; beta's must not be returned");
  const own = (await nextCard({ ...f.deps, projectId: "beta", kinds: ["l2_chunk"], profile: { execution: "background" } })).card;
  assert.equal(own?.project_id, "beta");
});
test("maintenance branch set merge calls completeBranchJobWithEvents and never Core submit", async t => {
  const branchJob = {
    ...job("branch-chunks", 9000),
    branch_id: "feature-branch"
  };
  const f = await fixture(t, [branchJob]);
  await seedTimeline(f);

  let status = await f.call("queue_status", { project: "alpha" });
  assert.equal(status.kinds.l2_chunk.pending, 3);
  assert.equal(status.branch_sets_open, 1);

  const storeBefore = await readMaintenanceStore(f.stateRoot, "acct");
  const branchCards = storeBefore.cards.filter(c => c.kind === "l2_chunk").sort((a, b) => a.chunk.index - b.chunk.index);
  assert.equal(branchCards.length, 3);
  for (const c of branchCards) {
    assert.match(c.key, /^l2:feature-branch:branch-chunks:\d+$/);
    assert.equal(c.branch_id, "feature-branch");
  }
  const branchSet = storeBefore.sets.find(s => s.parent_job_id === "branch-chunks");
  assert.ok(branchSet);
  assert.equal(branchSet.branch_id, "feature-branch");
  assert.equal(branchSet.status, "open");

  let branchJobCall = null;
  const mockCompleteBranch = async (input) => {
    branchJobCall = input;
    await mutateMaintenanceJob(f.stateRoot, "acct", input.jobId, j => {
      j.status = "completed";
      j.result_kind = "branch_draft";
      delete j.lease_token;
      delete j.leased_by;
      delete j.leased_until;
      return j;
    });
    return { appended: input.events.length, dropped_duplicates: 0, job_completed: true };
  };
  f.deps.completeBranchJob = mockCompleteBranch;

  await assert.rejects(nextCard({ ...f.deps, cardId: branchCards[1].card_id }), /unavailable/);
  for (const c of branchCards) {
    const next = await nextCard({ ...f.deps, cardId: c.card_id });
    assert.equal(next.card.input.prior_events.length, c.chunk.index);
    const ans = answer(next.card, c.chunk.index);
    const submitted = await submitCard({ ...f.deps, cardId: next.card.card_id, leaseToken: next.card.lease_token, answer: ans });
    assert.equal(submitted.ok, true);
  }

  assert.ok(branchJobCall, "completeBranchJob should have been called on mergeSet");
  assert.equal(branchJobCall.jobId, "branch-chunks");
  assert.equal(branchJobCall.leaseOwner, "memhub-card-merge");
  assert.ok(branchJobCall.leaseToken);
  assert.equal(branchJobCall.events.length, 3);
  assert.deepEqual(branchJobCall.cardIds, branchCards.map(c => c.card_id));
  assert.equal(f.writes.length, 0, "branch set merge must never call Core memory.distill");

  const storeAfter = await readMaintenanceStore(f.stateRoot, "acct");
  const mergedSet = storeAfter.sets.find(s => s.parent_job_id === "branch-chunks");
  assert.equal(mergedSet.status, "merged");
  assert.equal(mergedSet.result_job_id, "branch-chunks");

  const statusAfter = await f.call("queue_status", { project: "alpha" });
  assert.equal(statusAfter.branch_sets_open, undefined);
});

test("maintenance mergeSet uses deps.completeBranchJob dependency injection directly", async t => {
  const branchJob = {
    ...job("inject-branch-chunks", 3600, 1),
    branch_id: "direct-branch"
  };
  const f = await fixture(t, [branchJob]);
  await seedTimeline(f);
  await ensureCards(f.deps);
  const store = await readMaintenanceStore(f.stateRoot, "acct");
  const card = store.cards.find(c => c.kind === "l2_chunk" && c.branch_id === "direct-branch");
  assert.ok(card);
  const next = await nextCard({ ...f.deps, cardId: card.card_id });
  let directInjectionCalled = false;
  const submitted = await submitCard({
    ...f.deps,
    completeBranchJob: async (input) => {
      directInjectionCalled = true;
      assert.equal(input.jobId, "inject-branch-chunks");
      await mutateMaintenanceJob(f.stateRoot, "acct", input.jobId, j => {
        j.status = "completed";
        j.result_kind = "branch_draft";
        return j;
      });
      return { appended: 1, dropped_duplicates: 0, job_completed: true };
    },
    cardId: next.card.card_id,
    leaseToken: next.card.lease_token,
    answer: answer(next.card)
  });
  assert.equal(submitted.ok, true);
  assert.equal(directInjectionCalled, true, "submitCard must use deps.completeBranchJob directly");
});

test("maintenance completed branch_draft job does not trigger regeneration and preserves generation marker", async t => {
  const f = await fixture(t, [], true);
  await seedTimeline(f);
  await ensureCards(f.deps);
  const store1 = await readMaintenanceStore(f.stateRoot, "acct");
  const initialMarker = store1.generation["alpha"];
  assert.ok(initialMarker);
  const reads1 = f.visualizationReads;

  const jobs = await listDistillationJobs(f.stateRoot, "acct");
  jobs.push({
    ...job("completed-branch-job"),
    job_id: "completed-branch-job",
    account_id: "acct",
    target: "l2",
    result_kind: "branch_draft",
    branch_id: "feature-branch",
    status: "completed",
    completed_at: new Date().toISOString(),
    project_id: "alpha",
    evidence: [{ ...job("completed-branch-job").evidence[0], ref: "l1:b1", user_text: "branch text" }]
  });
  await writeFile(join(f.stateRoot, "distillation", "jobs.json"), JSON.stringify({ version: 2, jobs }));

  await ensureCards(f.deps);
  const store2 = await readMaintenanceStore(f.stateRoot, "acct");
  const marker2 = store2.generation["alpha"];
  assert.equal(marker2.l2_head_ref, initialMarker.l2_head_ref, "headRef should remain unaffected by branch_draft");
  assert.equal(f.visualizationReads, reads1, "generation should be skipped because headRef is unchanged");
});

test("litsan_memory plan and execute branch_not_main refusal, main bypass, and flag-off transparency", async t => {
  const f = await fixture(t, []);
  await seedTimeline(f);

  const branchStore = f.runtime.branches;
  await branchStore.create("acct", "alpha", { name: "ws-feature", goal: "Feature branch" });
  await branchStore.createAuto("acct", "alpha", {
    key: "git:feature-git",
    name: "ws-git",
    goal: "Git branch",
    base_map_fingerprint: "fp",
    base_l2_revision: null,
    now: new Date().toISOString()
  });

  await setWorkstreamEnabled(f.stateRoot, "acct", "alpha", true);

  const planRefused = JSON.parse((await f.client.callTool({
    name: "litsan_memory",
    arguments: {
      action: "plan",
      kind: "l3",
      project: "alpha",
      branch: "ws-feature",
      content: "# Alpha Rules\n\nBranch change."
    }
  })).content[0].text);
  assert.equal(planRefused.ok, false);
  assert.equal(planRefused.error, "branch_not_main");
  assert.equal(planRefused.branch.name, "ws-feature");
  assert.equal(planRefused.message_en, "L3/L4 can be edited only from main; close or merge the branch first");
  assert.equal(planRefused.message_zh, "只能从 main 修改 L3/L4，请先关闭或合并分支");

  const planHintRefused = JSON.parse((await f.client.callTool({
    name: "litsan_memory",
    arguments: {
      action: "plan",
      kind: "l3",
      project: "alpha",
      workstream: { git_branch: "feature-git" },
      content: "# Alpha Rules\n\nBranch change."
    }
  })).content[0].text);
  assert.equal(planHintRefused.ok, false);
  assert.equal(planHintRefused.error, "branch_not_main");
  assert.equal(planHintRefused.branch.name, "ws-git");

  const execRefused = JSON.parse((await f.client.callTool({
    name: "litsan_memory",
    arguments: {
      action: "execute",
      project: "alpha",
      branch: "ws-feature",
      authorization_id: "auth-123",
      confirmation_evidence_ref: "l1:dummy"
    }
  })).content[0].text);
  assert.equal(execRefused.ok, false);
  assert.equal(execRefused.error, "branch_not_main");
  assert.equal(execRefused.branch.name, "ws-feature");

  const mainPlan = ((await f.client.callTool({
    name: "litsan_memory",
    arguments: {
      action: "plan",
      kind: "l3",
      project: "alpha",
      branch: "main",
      content: "# Alpha Rules\n\nMain content."
    }
  })).content[0].text);
  // Past the guard the original L3 plan handler runs (it may reject this fixture for other reasons).
  assert.ok(!mainPlan.includes("branch_not_main"));

  await setWorkstreamEnabled(f.stateRoot, "acct", "alpha", false);
  const flagOffPlan = ((await f.client.callTool({
    name: "litsan_memory",
    arguments: {
      action: "plan",
      kind: "l3",
      project: "alpha",
      branch: "ws-feature",
      content: "# Alpha Rules\n\nFlag off content."
    }
  })).content[0].text);
  // Past the guard the original L3 plan handler runs (it may reject this fixture for other reasons).
  assert.ok(!flagOffPlan.includes("branch_not_main"));
});

test("requested timestamp carry-over isolates main and branch logical targets", async t => {
  const f = await fixture(t, [], true), now = Date.now();
  let branchId, round = 0;
  registerMaintenanceGenerator({ kind: "arch_review", instructions: "Review", answerSchema: { type: "object" }, fence: () => String(round),
    ensure(ctx) { return [{ kind: "arch_review", key: `requested-target:${round}`, fingerprint: String(round),
      account_id: ctx.accountId, project_id: ctx.projectId, ...(branchId ? { branch_id: branchId } : {}), input: {}, allowed_refs: [] }]; },
    validate: (_card, answer) => ({ ok: true, normalized: answer }), async apply() { return { ok: true }; } });
  try {
    await ensureCards(f.deps);
    await markRequested({ ...f.deps, projectId: "alpha", kinds: ["arch_review"], now });
    const generate = async nextBranch => {
      await withMaintenanceStore(f.stateRoot, "acct", now, store => {
        for (const card of store.cards.filter(c => c.kind === "arch_review")) card.status = "superseded";
        store.generation.alpha.structure_fp = "force-regeneration";
      });
      branchId = nextBranch; round++;
      await ensureCards({ ...f.deps, now: now + round * 1000 });
      return (await readMaintenanceStore(f.stateRoot, "acct")).cards.find(c => c.kind === "arch_review" && c.status === "pending");
    };
    const branch = await generate("branch-a"); assert.equal(branch.requested_at, undefined);
    await markRequested({ ...f.deps, projectId: "alpha", kinds: ["arch_review"], now: now + 2000 });
    const sibling = await generate("branch-b"); assert.equal(sibling.requested_at, undefined);
    const main = await generate(undefined); assert.equal(main.requested_at, new Date(now).toISOString());
    const sameBranch = await generate("branch-a"); assert.equal(sameBranch.requested_at, new Date(now + 2000).toISOString());
  } finally { maintenanceGenerators.delete("arch_review"); }
});

test("ensureCards never splits l2_restructure even without background-only marker", async t => {
  const restructure = { ...job("unsplit-restructure"), l2_restructure: { base_ref: "l2:timeline:revision", base_evidence_refs: [] } };
  const f = await fixture(t, [restructure]); await ensureCards(f.deps);
  const store = await readMaintenanceStore(f.stateRoot, "acct");
  assert.equal(store.sets.some(s => s.parent_job_id === restructure.job_id), false);
  assert.equal(store.cards.some(c => c.parent_job_id === restructure.job_id), false);
  assert.equal((await listDistillationJobs(f.stateRoot, "acct"))[0].split_card_set, undefined);
});


test("quiet same-turn timeline digest stores a derived view without rewriting L2", async t => {
  const f = await fixture(t); await seedTimeline(f); await setMaintenanceConfig(f.stateRoot, { conversation_maintenance: "quiet" });
  const opened = await turnCall(f, "open", { project: "alpha", user_text: "Continue the project" });
  assert.equal(opened.inline_maintenance?.kind, "timeline_digest");
  const card = opened.inline_maintenance;
  const loaded = JSON.parse((await f.client.callTool({ name: "litsan_card", arguments: { action: "inline_load", project: "alpha",
    inline_turn_event: opened.event_id, card_id: card.card_id, lease_token: card.lease_token } })).content[0].text);
  assert.equal(loaded.ok, true);
  const ids = loaded.card.input.events.map(event => event.id);
  const answer = { milestones: [{ kind: "main", title_en: "Established the project", title_zh: "建立项目",
    summary_en: "Recorded the earlier history.", summary_zh: "记录了早期历史。", source_ids: ids }], omitted_ids: [] };
  const result = await turnCall(f, "commit", { event_id: opened.event_id, project: "alpha", assistant_text: "Normal answer.",
    maintenance_answer: { card_id: card.card_id, lease_token: card.lease_token, answer } });
  assert.equal(result.maintenance_result.ok, true);
  const visual = await readMemoryControlData({ ...f.deps, projects: await f.runtime.projects.list("acct"), projectId: "alpha", kind: "visualization" });
  assert.equal(visual.state.timeline_digest.milestones.length, 1);
  assert.equal(visual.state.timeline_digest.processed, ids.length);
  assert.equal(f.writes.length, 0, "digest never rewrites L2");
  assert.equal(f.mapWrites.length, 0, "digest never rewrites architecture");
  await recordCompletedDistillationRevision({ stateRoot: f.stateRoot, accountId: "acct", target: "l2", projectId: "alpha", resultId: "timeline-alpha",
    content: "# Timeline\n\n## 2026-10-19: Earlier history\n\nChanged source text.", committedAt: "2026-10-20T00:00:00Z",
    evidence: [{ ref: "l1:initial", kind: "turn", layer: "L1", timestamp: "2026-10-19T00:00:00Z", project_id: "alpha", user_text: "initial", assistant_text: "history" }] });
  const changed = await readMemoryControlData({ ...f.deps, projects: await f.runtime.projects.list("acct"), projectId: "alpha", kind: "visualization" });
  assert.equal(changed.state.timeline_digest.milestones.length, 0, "changed L2 cannot keep a stale summary visible");
  assert.equal(changed.state.timeline_digest.processed, 0);
});

test("timeline cards carry earlier sources across batches without losing their evidence", async t => {
  const f = await fixture(t);
  const events = Array.from({ length: 12 }, (_, i) => `## 2026-10-${String(i + 1).padStart(2, "0")}: Change ${i} / 变更 ${i}\n\nEN: Improved capture ${i}.\n\nZH: 改进采集 ${i}。`);
  await seedTimeline(f, "# Timeline\n\n" + events.join("\n\n"));
  const next = () => f.call("next", { project: "alpha", kinds: ["timeline_digest"], client_profile: { execution: "inline", max_card_tokens: 2000 } });
  const first = (await next()).card;
  assert.ok(first && first.est_tokens <= 2000);
  const firstIds = first.input.events.map(event => event.id);
  const firstAnswer = { milestones: [{ kind: "topic", topic_en: "Capture", topic_zh: "采集",
    title_en: "Improved capture", title_zh: "改进采集", summary_en: "Recorded capture changes.", summary_zh: "记录采集变更。",
    source_ids: firstIds.slice(0, 2) }], omitted_ids: firstIds.slice(2) };
  assert.equal((await f.call("submit", { card_id: first.card_id, lease_token: first.lease_token, answer: firstAnswer })).ok, true);
  const second = (await next()).card;
  assert.ok(second && second.est_tokens <= 2000);
  assert.deepEqual(second.input.carry.source_ids, firstIds.slice(0, 2));
  const newIds = second.input.events.map(event => event.id).filter(id => !second.input.carry.source_ids.includes(id));
  assert.ok(newIds.length > 0);
  const combined = { milestones: [{ ...firstAnswer.milestones[0], summary_en: "Recorded earlier and later capture changes.",
    summary_zh: "记录先前与后续采集变更。", source_ids: [...second.input.carry.source_ids, newIds[0]] }],
    omitted_ids: newIds.slice(1) };
  assert.equal((await f.call("submit", { card_id: second.card_id, lease_token: second.lease_token, answer: combined })).ok, true);
  const visual = await readMemoryControlData({ ...f.deps, projects: await f.runtime.projects.list("acct"), projectId: "alpha", kind: "visualization" });
  assert.equal(visual.state.timeline_digest.milestones.length, 1);
  assert.deepEqual(visual.state.timeline_digest.milestones[0].source_ids, combined.milestones[0].source_ids);
  assert.equal(f.writes.length, 0);
});
