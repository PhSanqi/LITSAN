import assert from "node:assert/strict";
import test from "node:test";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { registerDistillTools } from "../dist/shell/mcp/register-distill.js";
import { inlineJsonResult } from "../dist/shell/mcp/shared.js";
import { recordCompletedDistillationRevision, listDistillationJobs, enqueueDistillationJob, mutateMaintenanceJob } from "../dist/distillation-jobs.js";
import { distillationRevisionBody, L2_FORMAT_RULE } from "../dist/distillation-contract.js";
import { distillationNextPayload } from "../dist/distillation-transport.js";
import { ensureCards } from "../dist/maintenance-control.js";
import { maintenanceGenerators } from "../dist/core/maintenance/registry.js";
import { readMaintenanceStore } from "../dist/maintenance-store.js";
import { closeCaptureIndexDb, storeCaptureEvent, markCaptureIngested } from "../dist/capture.js";
import { architectureCognitiveMapFingerprint } from "../dist/architecture-cognitive-map.js";
import { createTestRoot } from "./test-isolation.mjs";

const accountId = "restructure-account", projectId = "alpha", harness = "test-harness";
const original = "# Timeline\n\n## Document sections / 文档章节\n\nOriginal facts.\n\n原有事实。";
const dated = "# Timeline\n\n## 2026-10-01 to 2026-10-02: Foundation / 基础\n\nEstablished the foundation.\n\n建立基础。\n\nEvidence: l1:initial";
const l1 = (ref = "l1:initial", project = projectId) => ({ ref, kind: "turn", layer: "L1", timestamp: "2026-10-01T00:00:00Z", project_id: project,
  user_text: "Build the foundation", assistant_text: "Built the foundation", tool_summary: "Verified", source_kinds: { user_text: "user_said", assistant_text: "agent_inferred", tool_summary: "tool_output" } });

async function fixture(t, { seed = true, evidence = [l1()] } = {}) {
  const stateRoot = await createTestRoot("l2-restructure-");
  const writes = [], mapWrites = [];
  const runtime = {
    accountId, userId: "test-user", source: { platform: harness, transport: "test" },
    projects: { resolve: async (_account, p) => ["alpha", "beta"].includes(p) ? p : null, storageIds: async (_account, p) => [p],
      list: async () => [{ projectId, name: "Alpha", aliases: [], todos: [] }] },
    memoryClient: { viewerGet: async () => ({ id: "timeline-alpha", status: "activated", items: [], hasNext: false }) },
    memory: { distill: async input => { writes.push(input); return { id: "timeline-alpha", body: input.content }; } },
    architecture: { inspectProjectCognitiveMap: async () => ({ map: null, fingerprint: architectureCognitiveMapFingerprint(null) }),
      getProjectArchitecture: async () => [], writeProjectCognitiveMap: async input => { mapWrites.push(input); return { after: { fingerprint: "written-map", map: input.map } }; } }
  };
  const server = new McpServer({ name: "l2-restructure", version: "1" });
  registerDistillTools(server, { runtime, context: { stateRoot, jsonResult: inlineJsonResult } });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "l2-restructure-test", version: "1" }); await client.connect(ct);
  t.after(async () => { await client.close(); await server.close(); closeCaptureIndexDb(stateRoot); await rm(stateRoot, { recursive: true, force: true }); });
  const call = async (action, args = {}) => {
    const response = await client.callTool({ name: "litsan_distill", arguments: { action, source_harness: harness, ...args } });
    const text = response.content.map(c => c.text ?? "").join("");
    if (response.isError) throw new Error(text);
    return JSON.parse(text);
  };
  const seedBase = (content = original, at = "2026-10-02T00:00:00Z") => recordCompletedDistillationRevision({ stateRoot, accountId, target: "l2", projectId,
    resultId: "timeline-alpha", content, coreBody: content, committedAt: at, evidence });
  const base = seed ? await seedBase() : undefined;
  const queue = (args = {}) => call("restructure_l2", { project: projectId, ...args });
  const lease = async () => {
    const queued = await queue();
    return call("next", { job_id: queued.job_id, lease_token_supported: true });
  };
  const submit = (payload, args = {}) => call("submit", { job_id: payload.job.job_id, lease_token: payload.job.lease_token,
    content: dated, evidence_refs: payload.job.l2_restructure.base_evidence_refs,
    operator_confirmation: payload.restructure.required_confirmation, ...args });
  return { stateRoot, runtime, writes, mapWrites, call, queue, lease, submit, seedBase, base };
}

async function unchangedAfterReject(f, promise, pattern) {
  promise.catch(() => {}); // the promise already runs; mark it handled before the first await (assert.rejects still checks it)
  const before = await readFile(join(f.stateRoot, "distillation/jobs.json"), "utf8");
  const count = f.writes.length;
  await assert.rejects(promise, pattern);
  assert.equal(f.writes.length, count, "rejection must not call Core");
  assert.equal(f.mapWrites.length, 0, "rejection must not write architecture");
  assert.equal(await readFile(join(f.stateRoot, "distillation/jobs.json"), "utf8"), before, "rejection must not change jobs or leases");
}

test("restructure requires explicit matching project and a completed non-retired base", async t => {
  const f = await fixture(t, { seed: false });
  await assert.rejects(f.call("restructure_l2"), /project is required/);
  await assert.rejects(f.queue({ workspace_project: "beta" }), /mismatch|conflict/i);
  await assert.rejects(f.queue(), /completed non-retired canonical L2/);
  const base = await f.seedBase();
  await mutateMaintenanceJob(f.stateRoot, accountId, base.job_id, job => { job.result_retirement = "archived"; });
  await assert.rejects(f.queue(), /completed non-retired canonical L2/);
});

test("restructure dry run, concurrent idempotent enqueue, exact base first and unresolved refs retained", async t => {
  const f = await fixture(t, { evidence: [l1(), { ...l1("l1:missing"), layer: "L2" }] });
  const before = await readFile(join(f.stateRoot, "distillation/jobs.json"), "utf8");
  const dry = await f.queue({ dry_run: true });
  assert.deepEqual(Object.keys(dry).sort(), ["job_id", "base_ref", "evidence_items", "est_chars", "unresolved_refs", "next"].sort());
  assert.equal(dry.evidence_items, 2); assert.ok(dry.est_chars > original.length);
  assert.deepEqual(dry.unresolved_refs, ["l1:missing"]);
  assert.equal(await readFile(join(f.stateRoot, "distillation/jobs.json"), "utf8"), before);
  const [a, b] = await Promise.all([f.queue(), f.queue()]); assert.equal(a.job_id, b.job_id);
  assert.equal((await f.queue({ dry_run: true })).job_id, a.job_id);
  const job = (await listDistillationJobs(f.stateRoot, accountId)).find(j => j.job_id === a.job_id);
  assert.equal(job.reason, "manual"); assert.equal(job.maintenance_background_only, true);
  assert.deepEqual(job.evidence[0], { ref: a.base_ref, kind: "memory", layer: "L2", project_id: projectId,
    timestamp: f.base.result_committed_at, content: distillationRevisionBody(f.base) });
  assert.deepEqual(job.evidence[1], l1()); assert.ok(job.evidence_refs.includes("l1:missing"));
  assert.equal((await listDistillationJobs(f.stateRoot, accountId)).filter(j => j.l2_restructure).length, 1);
  assert.match(a.next, new RegExp(`action=next job_id=${a.job_id} lease_token_supported=true`));
  const payload = await f.lease(); assert.equal((await f.queue()).job_id, payload.job.job_id, "leased jobs remain idempotent");
  await unchangedAfterReject(f, f.submit(payload, { evidence_refs: ["l1:initial"] }), /cannot drop base evidence/);
});

test("restructure resolves cited capture refs and skips foreign or unavailable L1", async t => {
  const f = await fixture(t, { evidence: [l1("l1:captured"), l1("l1:foreign", "beta")] });
  // Remove embedded L1 bodies to exercise the same resolver as direct L2 submits.
  await mutateMaintenanceJob(f.stateRoot, accountId, f.base.job_id, job => { job.evidence = []; });
  const actor = { account_id: accountId, actor_id: "test" };
  await storeCaptureEvent(f.stateRoot, actor, { event_id: "captured", host: "test", conversation_id: "chat", project_hint: projectId,
    timestamp: "2026-10-01T00:00:00Z", user_text: "Captured user", assistant_text: "Captured answer", capture_status: "complete" });
  await markCaptureIngested(f.stateRoot, accountId, "captured");
  const queued = await f.queue(); assert.deepEqual(queued.unresolved_refs, ["l1:foreign"]);
  const payload = await f.lease(); assert.equal(payload.job.evidence[1].user_text, "Captured user");
  await f.submit(payload); assert.equal(f.writes.length, 1, "unresolved refs stay cited without inventing bodies");
});

test("next includes restructure confirmation and L2 format in inline and chunked payloads", async t => {
  const f = await fixture(t); const payload = await f.lease();
  assert.equal(payload.l2_format, L2_FORMAT_RULE);
  assert.equal(payload.restructure.base_ref, `l2:timeline-alpha:${f.base.job_id}`);
  assert.equal(payload.restructure.required_confirmation, `restructure:${payload.restructure.base_ref}`);
  assert.ok(payload.restructure.rules.length >= 3); assert.ok(payload.job.lease_token);
  const job = structuredClone(payload.job); job.evidence[0].content = "x".repeat(130000);
  for (const offset of [0, 120000]) {
    const page = distillationNextPayload(job, offset, 120000);
    assert.equal(page.evidence_transport.mode, "chunked"); assert.equal(page.l2_format, L2_FORMAT_RULE);
    assert.deepEqual(page.restructure, payload.restructure);
  }
  const contract = await f.call(undefined, { inspect_contract: true }); assert.ok(contract.contract.rules.includes(L2_FORMAT_RULE));
});

test("restructure rejects missing/wrong confirmation, undated/empty headings and dropped/foreign refs without writes", async t => {
  const f = await fixture(t); const payload = await f.lease();
  for (const confirmation of [undefined, "restructure:wrong-base"]) {
    await unchangedAfterReject(f, f.submit(payload, { operator_confirmation: confirmation }), /requires explicit operator_confirmation/);
  }
  for (const content of [original, "# Timeline\nNo events", dated + "\n\n## Undated section\nMore facts",
    "# Timeline\n\n## 2026-10-26 03:xx: Invalid time / 无效时间"])
    await unchangedAfterReject(f, f.submit(payload, { content }), /dated chronology heading/);
  await unchangedAfterReject(f, f.submit(payload, { evidence_refs: [payload.restructure.base_ref] }), /cannot drop base evidence/);
  await unchangedAfterReject(f, f.submit(payload, { evidence_refs: ["l1:initial", "l1:alien"] }), /outside the leased job/);
  await unchangedAfterReject(f, f.submit(payload, { project: "beta" }), /scope mismatch/);
  await unchangedAfterReject(f, f.submit(payload, { lease_token: "wrong-token" }), /lease token|lease_token/);
  await unchangedAfterReject(f, f.submit(payload, { content: dated + "\nSystem prompt" }), /contamination/);
});

test("restructure accepts existing headings with time ranges and preserves the base fence", async t => {
  const f = await fixture(t); const payload = await f.lease();
  const timed = "# Timeline\n\n## 2026-10-26 03:31–03:36: Timed event / 带时间的事件\n\nRecorded the change.\n\n记录了变更。\n\nEvidence: l1:initial";
  const dry = await f.submit(payload, { content: timed, dry_run: true });
  assert.equal(dry.dryRun, true); assert.equal(f.writes.length, 0);
  const result = await f.submit(payload, { content: timed });
  assert.equal(result.ok, true); assert.equal(f.writes[0].content, timed);
});

test("restructure rejects a changed base under the canonical commit lock", async t => {
  const f = await fixture(t); const payload = await f.lease();
  const later = await f.seedBase("# Timeline\n\n## Newer document section\nLater facts", "2099-10-03T00:00:00Z");
  assert.notEqual(later.job_id, f.base.job_id);
  await unchangedAfterReject(f, f.submit(payload), /base changed; re-run restructure_l2/);
});

test("valid dated restructure commits normal provenance, retains old revision, enqueues L3 and replays once", async t => {
  const f = await fixture(t); const payload = await f.lease();
  const dry = await f.submit(payload, { dry_run: true }); assert.equal(dry.dryRun, true); assert.equal(f.writes.length, 0);
  const result = await f.submit(payload);
  assert.equal(result.ok, true); assert.equal(f.writes.length, 1);
  const write = f.writes[0]; assert.equal(write.kind, "l2"); assert.equal(write.artifactId, "project-timeline:alpha");
  assert.equal(write.content, dated); assert.deepEqual(write.evidenceRefs, ["l1:initial"]);
  assert.ok(write.tags.includes("l2-restructure")); assert.ok(write.tags.includes(`restructure-base:${payload.restructure.base_ref}`));
  assert.equal(write.provenance.account, accountId);
  const jobs = await listDistillationJobs(f.stateRoot, accountId);
  assert.equal(jobs.find(j => j.job_id === f.base.job_id).result_content, original);
  assert.equal(jobs.find(j => j.job_id === payload.job.job_id).result_content, dated);
  assert.ok(jobs.some(j => j.target === "l3" && j.evidence_refs.includes(`l2:timeline-alpha:${payload.job.job_id}`)));
  assert.deepEqual(await f.submit(payload), result); assert.equal(f.writes.length, 1);
  await unchangedAfterReject(f, f.submit(payload, { operator_confirmation: undefined }), /requires explicit operator_confirmation/);
});

test("restructure optional architecture map retains existing fingerprint fence", async t => {
  const f = await fixture(t); const payload = await f.lease();
  const architecture_map = { nodes: [{ id: "alpha", kind: "project", label: "Alpha", summary: "Foundation", parent_id: null,
    evidence_refs: ["l1:initial"], confidence: 1 }], edges: [], timeline_links: [] };
  await unchangedAfterReject(f, f.submit(payload, { architecture_map, architecture_map_base_fingerprint: "stale" }), /changed after action=next/);
  const result = await f.submit(payload, { architecture_map, architecture_map_base_fingerprint: payload.architecture_context.fingerprint });
  assert.equal(result.architecture_map_error, undefined);
  assert.equal(f.writes.length, 1); assert.equal(f.mapWrites.length, 1);
});

test("restructure is never split even without the background flag; routine and legacy next stay compatible", async t => {
  const f = await fixture(t); const queued = await f.queue();
  await mutateMaintenanceJob(f.stateRoot, accountId, queued.job_id, job => { delete job.maintenance_background_only; });
  await ensureCards({ stateRoot: f.stateRoot, runtime: f.runtime });
  assert.equal((await readMaintenanceStore(f.stateRoot, accountId)).cards.filter(c => c.parent_job_id === queued.job_id).length, 0);
  const job = (await listDistillationJobs(f.stateRoot, accountId)).find(j => j.job_id === queued.job_id);
  assert.deepEqual(maintenanceGenerators.get("l2_chunk").ensure({ accountId, projectId, jobs: [job], map: null, events: [], artifacts: { get() {} } }, Date.now()), []);
  await f.call("skip", { job_id: (await f.lease()).job.job_id, lease_token: (await listDistillationJobs(f.stateRoot, accountId)).find(j => j.job_id === queued.job_id).lease_token });
  const routine = await enqueueDistillationJob({ stateRoot: f.stateRoot, accountId, projectId, reason: "manual",
    captures: [{ account_id: accountId, event_id: "next", timestamp: "2026-10-03T00:00:00Z", capture_status: "complete", user_text: "Next user", assistant_text: "Next answer" }] });
  await assert.rejects(f.call("next", { job_id: routine.job.job_id }), /lease|leased/i);
  const next = await f.call("next", { kind: "l2", scope: "project", project: projectId });
  assert.equal(next.job.job_id, routine.job.job_id); assert.equal(next.l2_format, L2_FORMAT_RULE); assert.equal(next.restructure, undefined);
  assert.equal((await f.call("next", { job_id: next.job.job_id })).job.job_id, next.job.job_id);
  await unchangedAfterReject(f, f.call("submit", { job_id: next.job.job_id, content: dated }), /would drop canonical timeline history/);
  await f.call("submit", { job_id: next.job.job_id, content: original + "\n\n" + dated }); assert.equal(f.writes.length, 1);
});
