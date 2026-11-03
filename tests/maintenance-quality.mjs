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

import { validateL2ChunkAnswer, L2_CHUNK_ANSWER_SCHEMA } from "../dist/core/maintenance/answers.js";
import { linkedContext } from "../dist/core/maintenance/quality.js";
const source = (ref, user_text, assistant_text = "Source recorded.", conversation_id) => ({ ref, kind: "turn", layer: "L1", project_id: "alpha", timestamp: "2026-11-03T00:00:00Z", user_text, assistant_text, ...(conversation_id ? { conversation_id } : {}) });
const makeJob = (id, evidence) => ({ job_id: id, account_id: "acct", target: "l2", scope: "project", project_id: "alpha", status: "pending", reason: "manual", created_at: "2026-11-03T00:00:00Z", updated_at: "2026-11-03T00:00:00Z", evidence_hash: id, evidence_refs: evidence.map(e => e.ref), evidence });
const fact = (ref, field, quote, disposition = "kept", events = [0], state = "reported") => ({ ref, field, quote, disposition, events, state, ...(disposition === "kept" ? {} : { reason: disposition === "deferred" ? "More durable facts need a continuation" : "One-time non-durable chatter" }) });
const event = (ref, title = "Rename", en = "The public host controls OAuth; clients must authenticate again.", zh = "公开域名影响认证，客户端必须重新认证。") => ({ date: "2026-11-03", title_en: title, title_zh: "事件" + title, body_en: en, body_zh: zh, evidence_refs: [ref] });
const pick = async f => (await nextCard({ ...f.deps, projectId: "alpha", profile: { execution: "background", max_card_tokens: 8000 } })).card;
const submit = (f, card, answer) => submitCard({ ...f.deps, project: "alpha", cardId: card.card_id, leaseToken: card.lease_token, answer });

test("quality: omission repaired before Core commit and replay cannot create another review", async t => {
  const item = source("l1:oauth", "Rename the host", "MEMHUB_PUBLIC_HOST drives OAuth, so clients must re-auth");
  const f = await fixture(t, [makeJob("oauth", [item])]);
  const card = await pick(f);
  const candidate = { events: [event(item.ref, "Rename", "Rename the public host.", "更改公开域名。")], facts: [fact(item.ref, "user_text", item.user_text)] };
  assert.equal((await submit(f, card, candidate)).ok, true); assert.equal(f.writes.length, 0);
  const review = await pick(f); assert.equal(review.input.stage, "review"); assert.deepEqual(review.input.candidate, candidate);
  const repaired = { events: [event(item.ref)], facts: [...candidate.facts, fact(item.ref, "assistant_text", item.assistant_text)] };
  assert.equal((await submit(f, review, repaired)).set_status, "merged");
  assert.equal(f.writes.length, 1); assert.match(f.writes[0].content, /clients must authenticate again/);
  assert.equal((await submit(f, card, candidate)).ok, false); assert.equal(f.writes.length, 1);
  assert.equal((await readMaintenanceStore(f.stateRoot, "acct")).cards.filter(c => c.input.stage === "review").length, 1);
});
test("quality: exact quote, speaker authority and complete candidate coverage are enforced", async t => {
  const item = source("l1:leave", "Leave it", "I suggest publishing over four days.");
  const f = await fixture(t, [makeJob("leave", [item])]); const c = await pick(f);
  const answer = { events: [event(item.ref)], facts: [fact(item.ref, "assistant_text", item.assistant_text, "kept", [0], "decision")] };
  assert.match(validateL2ChunkAnswer({ ...c, input: c.input }, answer).detail, /direct user/);
  answer.facts[0].state = "suggestion"; answer.facts[0].quote = "User approved four days";
  assert.match(validateL2ChunkAnswer(c, answer).detail, /verbatim/);
  answer.facts = [fact(item.ref, "user_text", "Leave it", "kept", [0], "uncertain"), fact(item.ref, "assistant_text", item.assistant_text, "kept", [0], "suggestion")];
  assert.equal((await submit(f, c, answer)).ok, true); const review = await pick(f);
  const dropped = { ...answer, facts: answer.facts.slice(0, 1) };
  assert.match(validateL2ChunkAnswer(review, dropped).detail, /cannot disappear/); assert.equal(f.writes.length, 0);
  answer.events = [event(item.ref, "Keep current state", "The user asks to leave the current state unchanged; the specific referent is unresolved. Four-day publishing is the assistant's suggestion.", "用户要求保持现状，具体指代未确定。分四天发布是助手建议。")];
  assert.equal((await submit(f, review, answer)).set_status, "merged");
});
test("quality: overflow remains pending through a reviewed continuation", async t => {
  const item = source("l1:two", "Retain permission and rollback requirements.");
  const f = await fixture(t, [makeJob("overflow", [item])]); const c = await pick(f);
  const first = { events: [event(item.ref, "Permission", "Permission is required.", "必须取得许可。")], facts: [fact(item.ref, "user_text", "permission"), fact(item.ref, "user_text", "rollback", "deferred", [])] };
  assert.equal((await submit(f, c, first)).ok, true); const review = await pick(f);
  assert.equal((await submit(f, review, first)).set_status, "open"); assert.equal(f.writes.length, 0);
  const continuation = await pick(f); assert.equal(continuation.input.stage, "extract"); assert.equal(continuation.input.required_facts[0].quote, "rollback");
  const second = { events: [event(item.ref, "Rollback", "Retain a rollback path.", "保留回滚路径。")], facts: [fact(item.ref, "user_text", "rollback")] };
  assert.equal((await submit(f, continuation, second)).ok, true);
  const final = await submit(f, await pick(f), second); assert.equal(final.set_status, "merged", JSON.stringify(final));
  assert.equal(f.writes.length, 1); assert.match(f.writes[0].content, /Permission is required/); assert.match(f.writes[0].content, /Retain a rollback path/);
});
test("quality: legacy accepted candidates are reviewed after restart", async t => {
  const item = source("l1:legacy", "Retain the original evidence"); const f = await fixture(t, [makeJob("legacy", [item])]);
  await ensureCards(f.deps);
  await withMaintenanceStore(f.stateRoot, "acct", Date.now(), store => {
    const card = store.cards.find(c => c.kind === "l2_chunk"); delete card.input.quality; delete card.input.stage;
    card.answer_schema = L2_CHUNK_ANSWER_SCHEMA; card.status = "accepted"; card.result = { events: [event(item.ref)] };
  });
  const review = await pick(f); assert.equal(review.input.stage, "review"); assert.equal(f.writes.length, 0);
  const final = await submit(f, review, { events: [event(item.ref)], facts: [fact(item.ref, "user_text", item.user_text)] }); assert.equal(final.set_status, "merged", JSON.stringify(final));
});
test("quality: even a skip is independently reviewed", async t => {
  const item = source("l1:noise", "Thanks"); const f = await fixture(t, [makeJob("noise", [item])]);
  const answer = { events: [], skip_reason: "Acknowledgement only", facts: [fact(item.ref, "user_text", "Thanks", "transient", [])] };
  assert.equal((await submit(f, await pick(f), answer)).set_status, "open");
  assert.equal((await submit(f, await pick(f), answer)).set_status, "merged"); assert.equal(f.writes.length, 0);
});
test("quality: repeated invalid reviews preserve evidence and show blocked work", async t => {
  const item = source("l1:block", "Keep pending work"); const f = await fixture(t, [makeJob("block", [item])]);
  await submit(f, await pick(f), { events: [event(item.ref)], facts: [fact(item.ref, "user_text", item.user_text)] });
  for (let n = 0; n < 3; n++) assert.equal((await submit(f, await pick(f), { events: [] })).ok, false);
  const q = await queueStatus({ ...f.deps, projectId: "alpha", dry: true, detailed: true });
  assert.equal(q.l2_backlog.quality_blocked_sets, 1); assert.equal(f.writes.length, 0); assert.equal(await pick(f), null);
  assert.equal((await listDistillationJobs(f.stateRoot, "acct")).find(j => j.job_id === "block").maintenance_background_only, undefined);
});
test("quality: linked context never guesses across projects or unbound turns", () => {
  const a = source("l1:a", "The label is cropped", "", "real-chat"), b = source("l1:b", "Leave it", "", "real-chat");
  assert.deepEqual(linkedContext([b], [a, b]), [a]);
  assert.deepEqual(linkedContext([b], [{ ...a, project_id: "beta" }, b]), []);
  assert.deepEqual(linkedContext([{ ...b, conversation_id: "memhub-unbound:x" }], [a, b]), []);
  assert.deepEqual(linkedContext([b], [{ ...a, conversation_id: "other-chat" }, b]), []);
});
test("quality: title-only duplication and pending-work skips are rejected", async t => {
  const item = source("l1:qa", "Do not publish before QA", "Part four is still rendering.");
  const f = await fixture(t, [makeJob("qa", [item])]); const card = await pick(f);
  const answer = { events: [], skip_reason: "The title already exists", facts: [fact(item.ref, "assistant_text", item.assistant_text, "duplicate", [])] };
  assert.match(validateL2ChunkAnswer(card, answer).detail, /previously reviewed/);
  answer.facts[0].disposition = "transient"; answer.facts[0].state = "pending";
  assert.match(validateL2ChunkAnswer(card, answer).detail, /unfinished work/);
});
test("quality: repeated overflow stops visibly without committing an incomplete set", async t => {
  const item = source("l1:overflow-limit", "Retain the pending prerequisite");
  const f = await fixture(t, [makeJob("overflow-limit", [item])]);
  const answer = { events: [], skip_reason: "Deferred durable work", facts: [fact(item.ref, "user_text", item.user_text, "deferred", [], "pending")] };
  for (let i = 0; i < 8; i++) assert.equal((await submit(f, await pick(f), answer)).ok, true);
  assert.equal(await pick(f), null); assert.equal(f.writes.length, 0);
  const q = await queueStatus({ ...f.deps, dry: true, detailed: true }); assert.equal(q.l2_backlog.quality_blocked_sets, 1);
  assert.match(q.l2_backlog.quality_blocked[0].reason, /3 continuations/);
});
test("quality: server grants a default review allowance but respects an explicit smaller bound", async t => {
  const item = source("l1:review-cap", "Retain prerequisites", "Long original source. ".repeat(180));
  const f = await fixture(t, [makeJob("review-cap", [item])]);
  const extract = await pick(f), answer = { events: [event(item.ref)], facts: [fact(item.ref, "user_text", item.user_text)] };
  assert.equal((await submit(f, extract, answer)).ok, true);
  await setMaintenanceConfig(f.stateRoot, { conversation_maintenance: "quiet" });
  const call = async args => JSON.parse((await f.client.callTool({ name: "litsan_turn", arguments: args })).content[0].text);
  const small = await call({ action: "open", project: "alpha", user_text: "Continue", client_profile: { max_card_tokens: 2000 } });
  assert.equal(small.inline_maintenance, undefined);
  const normal = await call({ action: "open", project: "alpha", user_text: "Continue" });
  assert.ok(normal.inline_maintenance); assert.equal(normal.inline_maintenance.card_id, (await readMaintenanceStore(f.stateRoot, "acct")).cards.find(c => c.input.stage === "review").card_id);
});
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
