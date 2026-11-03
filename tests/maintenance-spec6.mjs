import { submitReviewed as submitCard, withFacts, finishReview } from "./maintenance-answers.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, readFile, writeFile, stat, rm } from "node:fs/promises";
import { Readable } from "node:stream";
import { handleMemoryControlAction } from "../dist/memory-control-actions.js";
import { renderConsole } from "../dist/web-ui.js";
import { join } from "node:path";
import { closeCaptureIndexDb } from "../dist/capture.js";
import { createTestRoot } from "./test-isolation.mjs";
import { planL2Chunks, L2_INSTRUCTIONS } from "../dist/core/maintenance/chunk.js";
import { normalizeL2EventKey, mergeChunkEvents } from "../dist/core/maintenance/merge-l2.js";
import { validateCardAnswer } from "../dist/core/maintenance/validate.js";
import { normalizeMaintenanceConfig } from "../dist/core/maintenance/config.js";
import { readBranchDraft, validateBranchEvents } from "../dist/branch-drafts.js";
import { ensureCards, nextCard, peekCard, offerForCommit, queueStatus } from "../dist/maintenance-control.js";
import { readMaintenanceStore, withMaintenanceStore, setMaintenanceConfig, setMaintenanceStoreHooks } from "../dist/maintenance-store.js";
import { listDistillationJobs, readDistillationJobsSnapshot, mutateMaintenanceJob, recordCompletedDistillationRevision, leaseDistillationJob, setDistillationJobsHooks, withDistillationJobsBatch, outsideDistillationJobsBatch } from "../dist/distillation-jobs.js";
const now = Date.now(), profile = { execution: "delegate" }, harness = "spec6";
function job(id, chars = 100, count = 1, extra = {}) {
  const evidence = Array.from({ length: count }, (_, index) => ({ ref: `l1:${id}-${index}`, kind: "turn", layer: "L1", project_id: "alpha",
    timestamp: "2026-10-26T00:00:00Z", user_text: "Keep the confirmed project change", assistant_text: "a".repeat(chars) }));
  return { job_id: id, account_id: "acct", target: "l2", scope: "project", project_id: "alpha", status: "pending", reason: "manual",
    created_at: "2026-10-26T00:00:00Z", updated_at: "2026-10-26T00:00:00Z", evidence_hash: id, evidence_refs: evidence.map(e => e.ref), evidence, ...extra };
}
const event = (ref, title = "One change", extra = {}) => ({ date: "2026-10-26", title_en: title, title_zh: "同一个变更", body_en: "Confirmed change.", body_zh: "已确认变更。", evidence_refs: [ref], ...extra });
async function fixture(t, jobs = []) {
  const stateRoot = await createTestRoot("maintenance-spec6-");
  await mkdir(join(stateRoot, "distillation"), { recursive: true });
  await writeFile(join(stateRoot, "distillation", "jobs.json"), JSON.stringify({ version: 2, jobs }));
  const writes = [];
  let inspections = 0, fail = false;
  const runtime = {
    accountId: "acct", userId: "user-acct", source: { platform: harness, transport: "test" },
    projects: { resolve: async (_a, p) => p, list: async () => [{ projectId: "alpha", name: "Alpha", todos: [], aliases: [] }], storageIds: async (_a, p) => [p], suggest: async () => [] },
    memory: { distill: async input => { if (fail) { fail = false; throw Error("temporary Core failure"); } writes.push(input); return { id: "timeline-alpha", body: input.content }; } },
    memoryClient: { viewerGet: async path => {
      if (path.startsWith("/api/v1/memory/")) return { id: "timeline-alpha", status: "activated" };
      const latest = (await listDistillationJobs(stateRoot, "acct")).filter(j => j.result_kind === "l2" && j.status === "completed")
        .sort((a, b) => (a.result_committed_at ?? a.completed_at).localeCompare(b.result_committed_at ?? b.completed_at)).at(-1);
      return { items: latest ? [{ id: latest.result_id, projectId: "alpha", body: latest.result_content, updatedAt: latest.result_committed_at }] : [], hasNext: false };
    } },
    architecture: { inspectProjectCognitiveMap: async () => { inspections++; return { map: null, fingerprint: "missing" }; }, getProjectArchitecture: async () => [], listProjectArchitectureMarkdown: async () => [] }
  };
  const deps = { stateRoot, runtime, now, profile, harness };
  t.after(async () => { setDistillationJobsHooks(); setMaintenanceStoreHooks(); closeCaptureIndexDb(stateRoot); await rm(stateRoot, { recursive: true, force: true }); });
  return { ...deps, deps, writes, get inspections() { return inspections; }, fail: () => { fail = true; } };
}
async function accept(f, card, answer) {
  return submitCard({ ...f.deps, cardId: card.card_id, leaseToken: card.lease_token, answer: answer ?? { events: [event(card.allowed_refs[0])] } });
}

test("latency batch isolates snapshots, discards rejected job edits and writes prior successful work once", async t => {
  const f = await fixture(t, [job('a'), job('b')]); let writes = 0;
  setDistillationJobsHooks({ write: () => writes++ });
  await withDistillationJobsBatch(f.stateRoot, async () => {
    await mutateMaintenanceJob(f.stateRoot, 'acct', 'a', j => { j.reason = 'idle'; });
    const snapshot = await readDistillationJobsSnapshot(f.stateRoot, 'acct');
    assert.throws(() => { snapshot[0].status = 'failed'; }, TypeError);
    await assert.rejects(mutateMaintenanceJob(f.stateRoot, 'acct', 'b', j => { j.status = 'failed'; throw Error('rejected'); }), /rejected/);
    await mutateMaintenanceJob(f.stateRoot, 'acct', 'a', j => { j.attempts = 2; });
    assert.equal(writes, 0);
  });
  assert.equal(writes, 1);
  const jobs = await listDistillationJobs(f.stateRoot, 'acct');
  assert.equal(jobs.find(j => j.job_id === 'b').status, 'pending');
  assert.equal(jobs.find(j => j.job_id === 'a').attempts, 2);
});

test("latency external merge boundary flushes and releases ledger lock, then reloads external changes", async t => {
  const f = await fixture(t, [job('a')]); const path = join(f.stateRoot, 'distillation', 'jobs.json');
  await withDistillationJobsBatch(f.stateRoot, async () => {
    await mutateMaintenanceJob(f.stateRoot, 'acct', 'a', j => { j.reason = 'idle'; });
    await assert.rejects(outsideDistillationJobsBatch(f.stateRoot, async () => {
      assert.equal(JSON.parse(await readFile(path, 'utf8')).jobs[0].reason, 'idle');
      await assert.rejects(stat(`${path}.lock`), { code: 'ENOENT' });
      await mutateMaintenanceJob(f.stateRoot, 'acct', 'a', j => { j.attempts = 1; });
      throw Error('Core response lost');
    }), /Core response lost/);
    await mutateMaintenanceJob(f.stateRoot, 'acct', 'a', j => { assert.equal(j.attempts, 1); j.status = 'failed'; });
  });
  assert.equal((await listDistillationJobs(f.stateRoot, 'acct'))[0].status, 'failed');
});
async function seedBase(f) {
  return recordCompletedDistillationRevision({ stateRoot: f.stateRoot, accountId: "acct", target: "l2", projectId: "alpha", resultId: "timeline-alpha",
    content: "# Timeline\n\n" + Array.from({ length: 7 }, (_, i) => `## 2026-10-${10 + i}: Base ${i}\n\nConfirmed prior history.`).join("\n\n"),
    committedAt: "2026-10-20T00:00:00Z", evidence: [job("initial").evidence[0]] });
}

test("spec6 6k chunks keep evidence order, 8k cap and bounded evidence-review instructions", () => {
  const evidence = job("budget", 3600, 3).evidence;
  assert.equal(planL2Chunks(evidence).chunks.length, 1);
  assert.equal(planL2Chunks(evidence, 3000).chunks.length, 3);
  const large = job("budget", 9000, 3).evidence;
  assert.equal(planL2Chunks(large).chunks.length, 3);
  assert.deepEqual(planL2Chunks(large).chunks.flatMap(c => c.items), large);
  assert.equal(planL2Chunks(job("oversize", 40000).evidence).background_only, true);
  assert.ok(L2_INSTRUCTIONS.length <= 600);
});

test("spec6 sequential gating, next skips blocked chunks, lease context is fresh and not stored", async t => {
  const f = await fixture(t, [job("sequential", 9000, 3)]); await seedBase(f); await ensureCards(f.deps);
  const store = await readMaintenanceStore(f.stateRoot, "acct"), cards = store.cards.filter(card => card.kind === "l2_chunk");
  assert.equal(cards.length, 3);
  await assert.rejects(nextCard({ ...f.deps, cardId: cards[1].card_id }), /unavailable/);
  assert.equal((await nextCard({ ...f.deps, kinds: ["l2_chunk"], profile: { execution: "inline", max_card_tokens: 8000 } })).card, null);
  const first = (await nextCard({ ...f.deps, kinds: ["l2_chunk"] })).card;
  assert.equal(first.card_id, cards[0].card_id);
  assert.deepEqual(first.input.prior_events, []);
  assert.deepEqual(first.input.base_recent.map(h => h.title), ["Base 2", "Base 3", "Base 4", "Base 5", "Base 6"]);
  assert.equal((await nextCard({ ...f.deps, kinds: ["l2_chunk"] })).card, null);
  assert.notEqual((await peekCard({ ...f.deps, projectId: "alpha", maxCardTokens: 8000 }))?.kind, "l2_chunk");
  const originalFingerprint = first.fingerprint;
  assert.equal((await accept(f, first)).ok, true);
  const second = (await nextCard({ ...f.deps, kinds: ["l2_chunk"] })).card;
  assert.equal(second.card_id, cards[1].card_id);
  assert.deepEqual(second.input.prior_events, [{ key: normalizeL2EventKey("2026-10-26 One change"), date: "2026-10-26", title_en: "One change" }]);
  const saved = (await readMaintenanceStore(f.stateRoot, "acct")).cards.filter(card => card.kind === "l2_chunk");
  assert.equal(saved[0].fingerprint, originalFingerprint);
  assert.equal(saved[1].input.prior_events, undefined); assert.equal(saved[1].input.base_recent, undefined);
});

test("spec6 continues validates prior keys, merges paragraphs and refs into one heading", async t => {
  const f = await fixture(t, [job("continuation", 9000, 2)]); await seedBase(f);
  const first = (await nextCard(f.deps)).card; assert.equal((await accept(f, first)).ok, true);
  let second = (await nextCard(f.deps)).card;
  const key = second.input.prior_events[0].key;
  assert.equal((await accept(f, second, { events: [event(second.allowed_refs[0], "More detail", { continues: "unknown" })] })).code, "schema_invalid");
  assert.equal(f.writes.length, 0);
  second = (await nextCard({ ...f.deps, cardId: second.card_id })).card;
  const detail = event(second.allowed_refs[0], "More detail", { continues: key, body_en: "Additional detail.", body_zh: "补充细节。" });
  const result = await accept(f, second, { events: [detail] });
  assert.equal(result.ok, true); assert.equal(result.merge_error, undefined); assert.equal(result.set_status, "merged");
  assert.equal(f.writes.length, 1); const content = f.writes[0].content;
  assert.equal((content.match(/## 2026-10-26:/g) ?? []).length, 1);
  assert.match(content, /Atomic fact: Confirmed change\. \| Evidence: l1:continuation-0\n\nAtomic fact: Additional detail\. \| Evidence: l1:continuation-1/); assert.match(content, /已确认变更。\n\n补充细节。/);
  assert.match(content, /Evidence: l1:continuation-0, l1:continuation-1/); assert.match(content, /Base 0/);
  assert.deepEqual(validateBranchEvents([event("l1:a"), { ...detail, evidence_refs: ["l1:b"] }], ["l1:a", "l1:b"]), [event("l1:a"), { ...detail, evidence_refs: ["l1:b"] }]);
});

test("spec6 continuation chains resolve in chunk order before date sorting; duplicate base remains intact", () => {
  const a = event("l1:a"), key = normalizeL2EventKey(a.date + " " + a.title_en);
  const b = event("l1:b", "Detail", { continues: key, date: "2026-10-20" });
  const c = event("l1:c", "Final", { continues: normalizeL2EventKey(b.date + " " + b.title_en), date: "2026-10-19" });
  const wrap = (event, chunkIndex) => ({ event, chunkIndex, eventIndex: 0, cardId: "c" });
  const merged = mergeChunkEvents({ baseContent: null, canonicalTitle: "Timeline", events: [wrap(c, 2), wrap(a, 0), wrap(b, 1)] });
  assert.equal(merged.appended, 1); assert.match(merged.content, /Evidence: l1:a, l1:b, l1:c/);
  const base = "# Timeline\n\n## 2026-10-26: One change / 同一个变更\n\nOriginal history.";
  const duplicate = mergeChunkEvents({ baseContent: base, canonicalTitle: "Timeline", events: [wrap(a, 0), wrap(b, 1)] });
  assert.ok(duplicate.content.startsWith(base)); assert.equal(duplicate.appended, 0);
  assert.match(duplicate.content, /Evidence: l1:b/); assert.equal((duplicate.content.match(/^## /gm) ?? []).length, 1);
  const card = { kind: "l2_chunk", allowed_refs: ["l1:a"], input: { prior_events: [] } };
  assert.equal(validateCardAnswer(card, { events: [{ ...a, continues: key }] }).code, "schema_invalid");
});

test("spec6 tiny main jobs coalesce oldest first, one revision unions evidence and noop parents", async t => {
  const f = await fixture(t, [job("c", 100, 1, { created_at: "2026-10-26T03:00:00Z" }), job("b", 100, 1, { created_at: "2026-10-26T02:00:00Z" }), job("a")]);
  await ensureCards(f.deps); const store = await readMaintenanceStore(f.stateRoot, "acct");
  assert.equal(store.cards.length, 1); assert.equal(store.sets.length, 1);
  assert.deepEqual(store.sets[0].parent_job_ids, ["a", "b", "c"]); assert.equal(store.sets[0].parent_job_id, "a");
  assert.deepEqual(store.cards[0].allowed_refs, ["l1:a-0", "l1:b-0", "l1:c-0"]);
  for (const id of ["a", "b", "c"]) assert.equal(await leaseDistillationJob(f.stateRoot, "acct", { jobId: id, harness: "legacy", useLeaseToken: true }), null);
  const card = (await nextCard(f.deps)).card;
  const result = await accept(f, card, { events: [event(card.allowed_refs[0], "Combined", { evidence_refs: card.allowed_refs, body_en: "Atomic fact: Confirmed change. | Evidence: " + card.allowed_refs.join(", ") })] });
  assert.equal(result.merge_error, undefined); assert.equal(result.set_status, "merged"); assert.equal(f.writes.length, 1);
  const jobs = await listDistillationJobs(f.stateRoot, "acct");
  const primary = jobs.find(j => j.job_id === "a"); assert.equal(primary.result_kind, "l2");
  assert.deepEqual(primary.evidence_refs, card.allowed_refs); assert.equal(primary.evidence.length, 3);
  for (const id of ["b", "c"]) { const parent = jobs.find(j => j.job_id === id); assert.equal(parent.status, "completed"); assert.equal(parent.result_kind, "noop"); assert.equal(parent.maintenance_coalesced_into, "a"); }
  await ensureCards(f.deps); assert.equal(f.writes.length, 1);
});

test("spec6 coalesced skip-all completes every parent as noop", async t => {
  const f = await fixture(t, [job("a"), job("b")]);
  const card = (await nextCard(f.deps)).card;
  assert.equal((await accept(f, card, { events: [], skip_reason: "No durable change" })).set_status, "merged");
  assert.equal(f.writes.length, 0);
  assert.ok((await listDistillationJobs(f.stateRoot, "acct")).every(j => j.status === "completed" && j.result_kind === "noop"));
});

for (const phase of ["before lease", "before submit"]) test(`spec6 any coalesced parent change aborts and releases every parent (${phase})`, async t => {
  const f = await fixture(t, [job("a"), job("b")]); await ensureCards(f.deps);
  const card = phase === "before submit" ? (await nextCard(f.deps)).card : null;
  await mutateMaintenanceJob(f.stateRoot, "acct", "b", j => { j.reason = "idle"; j.evidence_hash = "changed"; });
  if (card) assert.equal((await accept(f, card)).code, "stale_fingerprint"); else await ensureCards(f.deps);
  const store = await readMaintenanceStore(f.stateRoot, "acct"); assert.equal(store.sets[0].status, "aborted");
  assert.ok(store.cards.every(c => c.status === "superseded")); assert.equal(f.writes.length, 0);
  for (const parent of await listDistillationJobs(f.stateRoot, "acct")) { assert.equal(parent.status, "pending"); assert.equal(parent.split_card_set, undefined); assert.equal(parent.maintenance_split_locked, undefined); }
});

test("spec6 grouping stops at projects, branches, restructure, append, leases, attempts and chunk budget", async t => {
  for (const barrier of [
    { project_id: "beta" }, { branch_id: "feature" }, { l2_restructure: { base_ref: "l2:base", base_evidence_refs: [] } },
    { l2_append: { branch_id: "feature", base_ref: null } }, { status: "leased", leased_by: "worker" }, { attempts: 1 }
  ]) {
    const f = await fixture(t, [job("a"), job("b", 100, 1, barrier), job("c")]); await ensureCards(f.deps);
    const store = await readMaintenanceStore(f.stateRoot, "acct");
    if (barrier.project_id) {
      assert.deepEqual(store.sets.find(set => set.project_id === "alpha").parent_job_ids, ["a", "c"]);
      assert.equal(store.sets.find(set => set.project_id === "beta").parent_job_id, "b");
    } else assert.ok(store.sets.every(set => !set.parent_job_ids || set.parent_job_ids.length === 1), JSON.stringify(barrier));
    if (barrier.l2_restructure) assert.ok(!store.sets.some(set => set.parent_job_id === "b"));
  }
  const branch = await fixture(t, [job("a", 100, 1, { branch_id: "same" }), job("b", 100, 1, { branch_id: "same" })]);
  await ensureCards(branch.deps); assert.equal((await readMaintenanceStore(branch.stateRoot, "acct")).sets.length, 2);
  const budget = await fixture(t, [job("a", 9000), job("b", 9000)]); await ensureCards(budget.deps);
  assert.equal((await readMaintenanceStore(budget.stateRoot, "acct")).sets.length, 2);
});

test("spec6 jobs snapshots are immutable, cloned list callers cannot poison cache, mutation/external replacement invalidate", async t => {
  const f = await fixture(t, [job("cached")]); let parses = 0; setDistillationJobsHooks({ parse: () => parses++ });
  const snapshot = await readDistillationJobsSnapshot(f.stateRoot, "acct"); assert.equal(parses, 1);
  assert.throws(() => { snapshot[0].evidence[0].assistant_text = "poison"; }, TypeError);
  const mutable = await listDistillationJobs(f.stateRoot, "acct"); mutable[0].status = "failed";
  assert.equal((await readDistillationJobsSnapshot(f.stateRoot, "acct"))[0].status, "pending"); assert.equal(parses, 1);
  await mutateMaintenanceJob(f.stateRoot, "acct", "cached", j => { j.status = "failed"; });
  assert.equal((await readDistillationJobsSnapshot(f.stateRoot, "acct"))[0].status, "failed"); assert.equal(parses, 1);
  await writeFile(join(f.stateRoot, "distillation", "jobs.json"), JSON.stringify({ version: 2, jobs: [job("external-longer-id")] }));
  assert.equal((await readDistillationJobsSnapshot(f.stateRoot, "acct"))[0].job_id, "external-longer-id");
});

test("spec6 no-op maintenance checkpoints preserve cards and log; direct legacy mutations still persist", async t => {
  const f = await fixture(t, [job("dirty")]); await ensureCards(f.deps);
  const path = join(f.stateRoot, "maintenance", "cards.json"), before = await stat(path); let writes = 0;
  setMaintenanceStoreHooks({ write: () => writes++ });
  await withMaintenanceStore(f.stateRoot, "acct", now, async (_store, _log, checkpoint) => { await checkpoint(); await checkpoint(); });
  await ensureCards(f.deps); assert.equal(writes, 0); assert.equal((await stat(path)).mtimeMs, before.mtimeMs);
  await assert.rejects(stat(join(f.stateRoot, "maintenance", "card-log.jsonl")), { code: "ENOENT" });
  await withMaintenanceStore(f.stateRoot, "acct", now, async store => { store.artifacts.test = { round: 2 }; });
  assert.equal(writes, 1); assert.deepEqual((await readMaintenanceStore(f.stateRoot, "acct")).artifacts.test, { round: 2 });
});

test("spec6 seeded 1000-job/500-card warm offer selection performs zero card writes and jobs parses", async t => {
  const jobs = [job("primary"), ...Array.from({ length: 999 }, (_, i) => job(`done-${i}`, 600, 1, { status: "completed", result_kind: "noop" }))];
  const f = await fixture(t, jobs); await ensureCards(f.deps);
  await withMaintenanceStore(f.stateRoot, "acct", now, async store => {
    const card = store.cards[0];
    store.cards.push(...Array.from({ length: 499 }, (_, i) => ({ ...card, card_id: `sibling-${i}`, key: `sibling-${i}`, kind: "arch_link", parent_job_id: undefined, chunk: undefined })));
  });
  assert.equal((await readMaintenanceStore(f.stateRoot, "acct")).cards.length, 500);
  assert.equal((await readDistillationJobsSnapshot(f.stateRoot, "acct")).length, 1000);
  let writes = 0, parses = 0, ensures = 0;
  setMaintenanceStoreHooks({ write: () => writes++ }); setDistillationJobsHooks({ parse: () => parses++ });
  const originalList = f.runtime.projects.list;
  f.runtime.projects.list = async () => { ensures++; return originalList(); };
  for (let i = 0; i < 5; i++) assert.ok(await peekCard({ ...f.deps, projectId: "alpha", maxCardTokens: 6000 }));
  await setMaintenanceConfig(f.stateRoot, { conversation_maintenance: "quiet", delegate_min_interval_s: 0 });
  assert.ok(await offerForCommit({ ...f.deps, turn: { ingested: true, projectId: "alpha", assistantChars: 10, toolSummaryChars: 0, continuityId: "benchmark" } }));
  assert.equal(writes, 0); assert.equal(parses, 0); assert.equal(ensures, 0);
  // Offers retain their required audit/counter writes; selection itself has no writes of any kind.
  const logBefore = await readFile(join(f.stateRoot, "maintenance", "card-log.jsonl"), "utf8");
  await peekCard({ ...f.deps, projectId: "alpha", maxCardTokens: 6000 });
  assert.equal(await readFile(join(f.stateRoot, "maintenance", "card-log.jsonl"), "utf8"), logBefore);
  await mutateMaintenanceJob(f.stateRoot, "acct", "primary", j => { j.evidence_hash = "new-hash"; });
  parses = 0; await peekCard({ ...f.deps, projectId: "alpha", maxCardTokens: 6000 });
  assert.ok(ensures > 0); assert.equal(parses, 0);
  assert.equal((await readDistillationJobsSnapshot(f.stateRoot, 'acct')).find(j => j.job_id === 'primary').evidence_hash, 'new-hash');
});

test("spec6 offer style defaults, optional/delegate text, inline optional text and <=400 bytes", async t => {
  assert.equal(normalizeMaintenanceConfig().offer_style, "delegate_request");
  assert.equal(normalizeMaintenanceConfig({ offer_style: "bad" }).offer_style, "delegate_request");
  const f = await fixture(t, [job("offer")]);
  await setMaintenanceConfig(f.stateRoot, { conversation_maintenance: "visible", delegate_min_interval_s: 0, inline_every_n_turns: 1 });
  const turn = { ingested: true, projectId: "alpha", assistantChars: 10, toolSummaryChars: 0, continuityId: "offer" };
  const offered = await offerForCommit({ ...f.deps, turn });
  assert.ok(offered); assert.equal(offered.rule, `After your answer: hand this card to a cheap subagent now (litsan_card action=next card_id=${offered.card_id} → answer from the card only → submit). Do not mention it; never change or delay your answer.`);
  assert.ok(Buffer.byteLength(JSON.stringify(offered)) <= 400);
  await setMaintenanceConfig(f.stateRoot, { offer_style: "optional" });
  const optional = await offerForCommit({ ...f.deps, turn }); assert.match(optional.rule, /^Optional\./); assert.ok(Buffer.byteLength(JSON.stringify(optional)) <= 400);
  await withMaintenanceStore(f.stateRoot, "acct", now, async store => { store.cards[0].kind = "arch_link"; store.cards[0].est_tokens = 1000; });
  await setMaintenanceConfig(f.stateRoot, { offer_style: "delegate_request" });
  const inline = await offerForCommit({ ...f.deps, turn, profile: { execution: "inline" } });
  assert.match(inline.rule, /^Optional\./); assert.ok(Buffer.byteLength(JSON.stringify(inline)) <= 400);
});


test("spec6 control plane persists offer_style, retains other fields and renders the labeled select", async t => {
  const f = await fixture(t);
  await setMaintenanceConfig(f.stateRoot, { conversation_maintenance: "quiet" });
  const action = async adminView => {
    const request = Readable.from([JSON.stringify({ action: "set-maintenance-config", offer_style: "optional" })]);
    request.headers = { "content-type": "application/json" };
    const response = { status: 0, body: "", setHeader() {}, writeHead(status) { this.status = status; return this; }, end(body) { this.body = body; return this; } };
    await handleMemoryControlAction({ ...f.deps, request, response, adminView, accounts: [], selectedAccount: { account_id: "acct" } });
    return response;
  };
  assert.equal((await action(false)).status, 403);
  const saved = await action(true); assert.equal(saved.status, 200);
  assert.equal(JSON.parse(saved.body).config.offer_style, "optional"); assert.equal(JSON.parse(saved.body).config.conversation_maintenance, "quiet");
  const html = renderConsole({ account: { account_id: "acct", username: "admin", role: "admin" }, accounts: [], projects: [], adminView: true, localControl: true, selectedAccountId: "acct" });
  assert.ok(html.includes('select id="maint-offer-style" name="offer_style"'));
  assert.ok(html.includes("Delegate offer style")); assert.ok(html.includes("Request delegation"));
  assert.ok(html.includes("offer_style:document.getElementById('maint-offer-style').value"));
});


test("spec6 coalesced merge retry is idempotent and retains all parent locks", async t => {
  const f = await fixture(t, [job("a"), job("b")]); const card = (await nextCard(f.deps)).card;
  f.fail(); const result = await accept(f, card);
  assert.match(result.merge_error, /temporary/); assert.equal(result.set_status, "open");
  assert.ok((await listDistillationJobs(f.stateRoot, "acct")).every(j => j.maintenance_split_locked));
  await ensureCards(f.deps); await ensureCards(f.deps);
  assert.equal((await readMaintenanceStore(f.stateRoot, "acct")).sets[0].status, "merged"); assert.equal(f.writes.length, 1);
  assert.equal((await listDistillationJobs(f.stateRoot, "acct")).find(j => j.job_id === "b").maintenance_coalesced_into, "a");
});

test("spec6 branch continuations survive earlier dates without creating extra draft events", async t => {
  const f = await fixture(t, [job("branch", 9000, 2, { branch_id: "feature" })]);
  const first = (await nextCard(f.deps)).card; assert.equal((await accept(f, first)).ok, true);
  const second = (await nextCard(f.deps)).card;
  const result = await accept(f, second, { events: [event(second.allowed_refs[0], "Earlier date detail", { continues: second.input.prior_events[0].key, date: "2026-10-20" })] });
  assert.equal(result.merge_error, undefined); assert.equal(result.set_status, "merged"); assert.equal(f.writes.length, 0);
  const draft = await readBranchDraft(f.stateRoot, "acct", "alpha", "feature");
  assert.equal(draft.events.length, 1); assert.deepEqual(draft.events[0].event.evidence_refs, [first.allowed_refs[0], second.allowed_refs[0]]);
  assert.equal(draft.events[0].event.date, "2026-10-26");
});

test("spec6 orphan claims recover after a pre-checkpoint crash and account boundaries isolate coalescing", async t => {
  const f = await fixture(t, [job("a", 100, 1, { split_card_set: "lost-set", maintenance_split_locked: true }), job("b"), job("foreign", 100, 1, { account_id: "other" })]);
  await ensureCards(f.deps); const store = await readMaintenanceStore(f.stateRoot, "acct");
  assert.equal(store.sets.length, 1); assert.deepEqual(store.sets[0].parent_job_ids, ["a", "b"]);
  assert.equal((await listDistillationJobs(f.stateRoot, "other"))[0].split_card_set, undefined);
});


test("spec6 lease reads the latest base after generation, and every parent is fenced again during merge", async t => {
  const f = await fixture(t, [job("a"), job("b")]); await ensureCards(f.deps); await seedBase(f);
  const card = (await nextCard(f.deps)).card;
  assert.equal(card.input.base_recent.at(-1).title, "Base 6"); assert.ok(card.answer_schema.properties.events.items.properties.continues);
  let calls = 0; const original = f.runtime.projects.storageIds;
  f.runtime.projects.storageIds = async (...args) => {
    calls++;
    if (calls === 1) await mutateMaintenanceJob(f.stateRoot, "acct", "b", parent => { parent.evidence_hash = "raced"; });
    return original(...args);
  };
  const result = await accept(f, card); assert.equal(result.set_status, "aborted"); assert.equal(f.writes.length, 0);
  for (const parent of (await listDistillationJobs(f.stateRoot, "acct")).filter(j => ["a", "b"].includes(j.job_id))) {
    assert.equal(parent.split_card_set, undefined); assert.equal(parent.maintenance_split_locked, undefined); assert.equal(parent.status, "pending");
  }
});

test("spec6 accepted duplicate-base event can receive continuation detail without losing canonical history", async t => {
  const f = await fixture(t, [job("base-detail", 9000, 2)]); await seedBase(f);
  const first = (await nextCard(f.deps)).card;
  assert.equal((await accept(f, first, { events: [event(first.allowed_refs[0], "Base 0", { date: "2026-10-10" })] })).ok, true);
  const second = (await nextCard(f.deps)).card;
  const result = await accept(f, second, { events: [event(second.allowed_refs[0], "More detail", { continues: second.input.prior_events[0].key, body_en: "New confirmed detail." })] });
  assert.equal(result.merge_error, undefined); assert.equal(result.set_status, "merged");
  const content = f.writes[0].content;
  assert.equal((content.match(/^## /gm) ?? []).length, 7);
  assert.ok(content.indexOf("New confirmed detail.") < content.indexOf("## 2026-10-11:"));
  assert.match(content, /Confirmed prior history/); assert.match(content, /Evidence: l1:base-detail-1/);
});

for (const correction of [true, false]) test(`inline L2 format correction is bounded: corrected=${correction}`, async t => {
  const f = await fixture(t, [job("format")]); await ensureCards(f.deps);
  const owner = "memhub-in-turn:format-turn";
  const { card } = await nextCard({ ...f.deps, harness: owner, kinds: ["l2_chunk"], inlineL2MaxTokens: 3000, inlineBranchId: "main" });
  assert.ok(card);
  const good = { events: [event(card.allowed_refs[0])] };
  const bad = { events: [event(card.allowed_refs[0], "One change", { body_en: "x".repeat(1201) })] };
  const args = { ...f.deps, harness: owner, project: "alpha", inlineTurnId: "format-turn", inlineBranchId: "main", cardId: card.card_id, leaseToken: card.lease_token };
  const first = await submitCard({ ...args, answer: bad });
  assert.equal(first.retryable, true); assert.equal(first.lease_retained, true);
  assert.match(first.detail, /body_en.*1200.*1201/);
  const held = (await readMaintenanceStore(f.stateRoot, "acct")).cards.find(c => c.card_id === card.card_id);
  assert.equal(held.status, "leased"); assert.equal(held.lease.until, card.lease_until);
  const second = await submitCard({ ...args, answer: correction ? good : bad });
  assert.equal(second.ok, correction); assert.equal(second.retryable, undefined);
  const final = (await readMaintenanceStore(f.stateRoot, "acct")).cards.find(c => c.card_id === card.card_id);
  assert.equal(final.status, correction ? "accepted" : "pending"); assert.equal(final.lease, undefined);
});

test("dry backlog is account/project scoped and does not retire stale cards", async t => {
  const f = await fixture(t, [job("active"), job("retired", 100, 1, { status: "completed", result_kind: "noop" }),
    job("beta", 100, 1, { project_id: "beta" }), job("foreign", 100, 1, { account_id: "other" })]);
  await withMaintenanceStore(f.stateRoot, "acct", now, async store => {
    for (const [id, project] of [["active", "alpha"], ["retired", "alpha"], ["beta", "beta"]]) {
      store.cards.push({ card_id: id, account_id: "acct", project_id: project, parent_job_id: id, kind: "l2_chunk", status: "pending", created_at: new Date(now - 3600000).toISOString() });
      store.sets.push({ set_id: id, account_id: "acct", project_id: project, parent_job_id: id, status: "open", card_ids: [id] });
    }
  });
  const before = await readMaintenanceStore(f.stateRoot, "acct");
  const result = await queueStatus({ stateRoot: f.stateRoot, runtime: { accountId: "acct" }, projectId: "alpha", dry: true, detailed: true, now });
  assert.equal(result.account_id, "acct"); assert.equal(result.project_id, "alpha");
  assert.equal(result.kinds.l2_chunk.pending, 1); assert.equal(result.l2_backlog.stale_cards, 1);
  assert.equal(result.l2_backlog.parent_jobs, 1); assert.equal(result.split_jobs.open, 1);
  assert.deepEqual(result.l2_backlog.projects.map(row => row.project), ["alpha"]);
  assert.deepEqual(await readMaintenanceStore(f.stateRoot, "acct"), before);
});
