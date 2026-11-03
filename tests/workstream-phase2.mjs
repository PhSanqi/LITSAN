import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile, stat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { MemoryCoreHttpError } from '../dist/local-memory-client.js';
import { createLitsanRuntime } from '../dist/runtime.js';
import { createLitsanMcpServerForRuntime } from '../dist/mcp.js';
import { listCaptureEvents, closeCaptureIndexDb, storeCaptureEvent, markCaptureIngested, captureIngestedAt, captureIsFullyExcludedFromMemory } from '../dist/capture.js';
import { captureTurnId, captureCoreRawTurnId } from '../dist/capture-ingest.js';
import { enqueueDistillationJob, listDistillationJobs, leaseDistillationJob, mutateMaintenanceJob, recordCompletedDistillationRevision, setDistillationConfig, enqueueDerivedDistillationJob } from '../dist/distillation-jobs.js';
import { discoverySkipReason, discoveryWouldClaim } from '../dist/core/lifecycle/distillation-eligibility.js';
import { assignEventBranch } from '../dist/capture-branch-assignments.js';
import { discoverDistillationJobs } from '../dist/distillation-discovery.js';
import { readBranchDraft, branchDraftPath, mutateBranchDraft, completeBranchJobWithEvents } from '../dist/branch-drafts.js';
import { commitL2Append } from '../dist/l2-append.js';
import { mergeBranch, sweepWorkstreamBranches, readBranchBase, claimedBranchEvents } from '../dist/workstream.js';
import { branchDraftContext, filterBranchL1Hits } from '../dist/workstream-retrieval.js';
import { buildProjectModel } from '../dist/shell/archify/project-model.js';
import { exactDistillationRevisionForMemory } from '../dist/distillation-contract.js';
import { reconcileCompletedL2DerivedJob } from '../dist/distillation-derived-recovery.js';
import { validL3EvidenceBatch } from '../dist/distillation-derived-provenance.js';
import { planDistillationConsolidation } from '../dist/distillation-consolidation.js';
import { ensureCards, nextCard, submitCard } from '../dist/maintenance-control.js';
import { readMaintenanceStore } from '../dist/maintenance-store.js';
import { setWorkstreamEnabled } from '../dist/workstream-config.js';
import { architectureCognitiveMapFingerprint } from '../dist/architecture-cognitive-map.js';
import { createTestRoot, isolateTestEnvironment } from './test-isolation.mjs';

const hash = s => createHash('sha256').update(s).digest('hex');
const harness = 'phase2-test';
const event = (ref, title = 'Durable decision', date = '2026-10-27') => ({ date, title_en: title, title_zh: `决定 ${title}`,
  body_en: `Durable event ${title}.`, body_zh: `长期事件 ${title}。`, evidence_refs: [ref] });
async function fixture(t, enabled = true) {
  const root = await createTestRoot('workstream-phase2-');
  isolateTestEnvironment(root, root);
  const runtime = createLitsanRuntime({ accountId: 'acct', controlRoot: root, disableArchitecture: true,
    memoryEndpoint: 'http://127.0.0.1:1', memoryToken: '', source: { platform: harness, transport: 'local' } });
  const writes = []; let hits = [], map = null;
  runtime.memoryClient.search = async req => ({ hits: hits.filter(h => req.layers.includes(h.memoryLayer)) });
  runtime.memoryClient.openSession = async () => ({});
  runtime.memoryClient.completeTurn = async () => ({});
  runtime.memoryClient.viewerGet = async path => {
    if (path.startsWith('/api/v1/memory/')) return { id: 'timeline-demo', status: 'activated' };
    const head = (await listDistillationJobs(root, 'acct')).filter(j => j.result_kind === 'l2').at(-1);
    return { items: head ? [{ id: head.result_id, body: head.result_content, projectId: 'demo', updatedAt: head.result_committed_at }] : [], hasNext: false };
  };
  runtime.memory.distill = async input => { writes.push(structuredClone(input)); return { id: 'timeline-demo', body: input.content }; };
  runtime.architecture.inspectProjectCognitiveMap = async ({ projectId }) => ({ projectId, path: '', exists: !!map, map,
    fingerprint: architectureCognitiveMapFingerprint(map) });
  runtime.architecture.getProjectArchitecture = async () => [];
  runtime.architecture.listProjectArchitectureMarkdown = async () => [];
  runtime.architecture.writeProjectCognitiveMap = async input => { map = input.map; return { after: { map, fingerprint: architectureCognitiveMapFingerprint(map) } }; };
  await runtime.projects.create('acct', { projectId: 'demo', name: 'Demo', description: 'Workstream project' });
  await setDistillationConfig(root, { auto_enabled: false });
  await setWorkstreamEnabled(root, 'acct', 'demo', enabled);
  const server = createLitsanMcpServerForRuntime(runtime, root);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'phase2-test', version: '1' });
  await server.server.connect(st); await client.connect(ct);
  t.after(async () => { await client.close(); await server.close(); runtime.dispose(); closeCaptureIndexDb(root); });
  const call = async (name, args, error) => {
    const response = await client.callTool({ name, arguments: args });
    if (error) { assert.equal(response.isError, true); assert.match(response.content[0].text, error); return; }
    assert.ok(!response.isError, response.content[0]?.text); return JSON.parse(response.content[0].text);
  };
  const branch = args => call('litsan_branch', { project: 'demo', ...args });
  const complete = async (id, extra = {}, chars = 80) => {
    const opened = await call('litsan_turn', { action: 'open', project: 'demo', turn_id: id, conversation_id: 'transport', user_text: `request ${id}`, ...extra });
    await call('litsan_turn', { action: 'commit', conversation_id: 'transport', event_id: opened.event_id, assistant_text: `answer ${id} ${'a'.repeat(chars)}` });
    return opened.event_id;
  };
  const createBranch = async name => (await branch({ action: 'create', name, goal: `${name} durable project changes` })).branch;
  const jobs = () => listDistillationJobs(root, 'acct');
  const queue = async (id, b, chars) => {
    const eventId = await complete(id, b ? { branch: b.branchId } : {}, chars);
    return (await enqueueDistillationJob({ stateRoot: root, accountId: 'acct', projectId: 'demo', branchId: b?.branchId,
      captures: await listCaptureEvents(root, 'acct', { eventId }), reason: 'manual' })).job;
  };
  const lease = job => leaseDistillationJob(root, 'acct', { jobId: job.job_id, harness, useLeaseToken: true });
  const submit = (job, events, extra = {}, error) => call('litsan_distill', { action: 'submit', job_id: job.job_id, source_harness: harness,
    lease_token: job.lease_token, events, ...extra }, error);
  const deps = { stateRoot: root, runtime };
  return { root, runtime, writes, call, branch, complete, createBranch, jobs, queue, lease, submit, deps, setHits: value => { hits = value; } };
}
async function seedMain(f) {
  return recordCompletedDistillationRevision({ stateRoot: f.root, accountId: 'acct', projectId: 'demo', target: 'l2',
    resultId: 'timeline-demo', content: '# Timeline\n\n## 2026-10-01: Prior / 先前\n\nPrior durable event.\n\n先前事件。', committedAt: '2026-10-01T00:00:00Z',
    evidence: [{ ref: 'l1:prior', kind: 'turn', layer: 'L1', timestamp: '2026-10-01T00:00:00Z', project_id: 'demo', user_text: 'prior', assistant_text: '先前' }] });
}
async function finished(f, b, id, title = id, date) {
  const job = await f.lease(await f.queue(id, b));
  await f.submit(job, [event(job.evidence_refs[0], title, date)]);
  return job;
}

test('discovery eligibility applies disabled, cutover, privacy, relation, then empty text', () => {
  const ctx = { autoEnabled: true, autoSince: '2026-10-01', ingestedAt: '2026-10-02', privacyExcluded: false };
  const normal = { user_text: 'request', assistant_text: 'answer' };
  const relay = { provenance: { relates_to: { relation: 'relays' } } };
  assert.equal(discoverySkipReason(relay, { ...ctx, autoEnabled: false, ingestedAt: null, privacyExcluded: true }), 'auto_disabled');
  assert.equal(discoverySkipReason(relay, { ...ctx, autoSince: null }), 'auto_disabled');
  assert.equal(discoverySkipReason(relay, { ...ctx, ingestedAt: null, privacyExcluded: true }), 'before_cutover');
  assert.equal(discoverySkipReason(relay, { ...ctx, ingestedAt: '2026-09-30', privacyExcluded: true }), 'before_cutover');
  assert.equal(discoverySkipReason(relay, { ...ctx, privacyExcluded: true }), 'privacy_excluded');
  assert.equal(discoverySkipReason(relay, ctx), 'relation_relays');
  assert.equal(discoverySkipReason({ provenance: { relates_to: { relation: 'duplicate_of' } } }, ctx), 'relation_duplicate_of');
  assert.equal(discoverySkipReason({ ...normal, assistant_text: '  ' }, ctx), 'empty_text');
  assert.equal(discoverySkipReason({ ...normal, user_text: '' }, ctx), 'empty_text');
  assert.equal(discoverySkipReason(normal, ctx), undefined);
  assert.equal(discoveryWouldClaim(normal, { ...ctx, ingestedAt: ctx.autoSince }), true);
  assert.equal(discoveryWouldClaim(relay, ctx), false);
});

for (const kind of ['privacy-excluded', 'empty-assistant', 'before-cutover']) {
  test(`${kind} unclaimed turn permits explicit close and 3-day idle merge`, async t => {
    const f = await fixture(t);
    await setDistillationConfig(f.root, { auto_enabled: true });
    await setDistillationConfig(f.root, { auto_since: kind === 'before-cutover' ? '2099-01-01T00:00:00.000Z' : '2000-01-01T00:00:00.000Z' });
    const branches = [await f.createBranch('Explicit'), await f.createBranch('Idle')];
    for (const b of branches) {
      const { event: capture } = await storeCaptureEvent(f.root, { account_id: 'acct', actor_id: 'test', name: harness }, {
        event_id: `${kind}-${b.branchId}`, host: harness, conversation_id: 'eligibility',
        timestamp: new Date().toISOString(), project_hint: 'demo', capture_status: 'complete',
        user_text: kind === 'privacy-excluded' ? '<private>private request</private>' : 'request',
        assistant_text: kind === 'privacy-excluded' ? '<no-memory>private answer</no-memory>' : 'answer'
      });
      await markCaptureIngested(f.root, 'acct', capture.event_id);
      if (kind === 'empty-assistant') {
        // Simulate a legacy complete capture: current writes reject missing text.
        const path = join(f.root, 'captures', hash('acct'), `${hash(capture.event_id)}.json`);
        await writeFile(path, JSON.stringify({ ...capture, assistant_text: '' }));
      }
      const [stored] = await listCaptureEvents(f.root, 'acct', { eventId: capture.event_id, completeOnly: true, ingested: true });
      assert.ok(stored);
      if (kind === 'empty-assistant') assert.ok(!stored.assistant_text?.trim());
      await assignEventBranch(f.root, { account_id: 'acct', project_id: 'demo', event_id: capture.event_id,
        branch_id: b.branchId, reason: 'explicit_branch', actor: 'host', created_at: new Date().toISOString() });
      assert.ok(await captureIngestedAt(f.root, 'acct', capture.event_id));
      assert.equal(captureIsFullyExcludedFromMemory(capture), kind === 'privacy-excluded');
    }
    assert.equal((await f.jobs()).length, 0);
    const closed = await f.branch({ action: 'close', branch: branches[0].branchId });
    assert.equal(closed.branch.status, 'merged'); assert.equal(closed.merge.status, 'merged');
    await age(f, branches[1], 3.1); await sweepWorkstreamBranches(f.deps);
    const idle = await f.runtime.branches.resolve('acct', 'demo', branches[1].branchId, { includeClosed: true });
    assert.equal(idle.status, 'merged'); assert.equal(idle.closed_reason, 'idle');
  });
}

test('eligible unclaimed turn still blocks explicit merge and 3-day idle close', async t => {
  const f = await fixture(t), b = await f.createBranch('Eligible');
  await setDistillationConfig(f.root, { auto_enabled: true });
  await f.complete('eligible', { branch: b.branchId });
  assert.equal((await f.jobs()).length, 0);
  await age(f, b, 3.1); await sweepWorkstreamBranches(f.deps);
  assert.equal((await f.runtime.branches.resolve('acct', 'demo', b.branchId)).status, 'active');
  const result = await f.branch({ action: 'close', branch: b.branchId });
  assert.equal(result.merge.status, 'deferred'); assert.equal(result.merge.reason, 'undistilled_l1');
  assert.equal(result.branch.status, 'closing');
});

test('discovery groups interleaved main and two branches; flag-off retains exact legacy evidence hash', async t => {
  const f = await fixture(t); const a = await f.createBranch('A'), b = await f.createBranch('B');
  await setDistillationConfig(f.root, { auto_enabled: true, turn_threshold: 100 });
  for (const [id, branch] of [['a1', a], ['m1'], ['b1', b], ['a2', a], ['m2'], ['b2', b]]) await f.complete(id, branch ? { branch: branch.branchId } : {});
  const report = await discoverDistillationJobs({ ...f.deps, accountId: 'acct', resolveProject: async p => p === 'demo' ? p : null,
    enqueue: true, now: new Date(Date.now() + 3600_000) });
  assert.equal(report.queued, 3);
  const jobs = await f.jobs(); assert.deepEqual(new Set(jobs.map(j => j.branch_id ?? 'main')), new Set(['main', a.branchId, b.branchId]));
  assert.ok(jobs.every(j => j.evidence.length === 2));
  for (const j of jobs.filter(j => !j.branch_id)) assert.equal(j.evidence_hash, hash(JSON.stringify({ target: 'l2', project: 'demo', evidence: j.evidence })));
  const off = await fixture(t, false);
  await setDistillationConfig(off.root, { auto_enabled: true, turn_threshold: 100 });
  await off.complete('one', { workstream: { git_branch: 'feature/a' } }); await off.complete('two', { workstream: { git_branch: 'feature/b' } });
  const old = await discoverDistillationJobs({ stateRoot: off.root, accountId: 'acct', resolveProject: async () => 'demo', enqueue: true, now: new Date(Date.now() + 3600_000) });
  assert.equal(old.queued, 1); const [job] = await off.jobs(); assert.equal(Object.hasOwn(job, 'branch_id'), false);
  assert.equal(job.evidence_hash, hash(JSON.stringify({ target: 'l2', project: 'demo', evidence: job.evidence })));
});

test('branch next/submit validates events, completes draft without Core or L3, and replays idempotently', async t => {
  const f = await fixture(t), b = await f.createBranch('Draft'); const queued = await f.queue('draft', b);
  const next = await f.call('litsan_distill', { action: 'next', kind: 'l2', source_harness: harness, lease_token_supported: true });
  assert.deepEqual(next.branch, { id: b.branchId, name: b.name }); assert.match(next.instructions, /Do not load or resubmit main L2/);
  const job = next.job; assert.equal(job.job_id, queued.job_id);
  await f.submit(job, [], { content: '# wrong' }, /branch_job_requires_events/);
  await f.submit(job, [event('l1:alien')], {}, /ref_not_allowed/);
  await f.submit(job, [event(job.evidence_refs[0], 'Bad', '2026-02-30')], {}, /schema_invalid/);
  const events = [event(job.evidence_refs[0]), event(job.evidence_refs[0])];
  const result = await f.submit(job, events); assert.equal(result.appended, 1); assert.equal(result.dropped_duplicates, 1);
  assert.equal((await f.submit(job, events)).appended, 0);
  const [done] = await f.jobs(); assert.equal(done.result_kind, 'branch_draft'); assert.equal(done.status, 'completed');
  for (const field of ['result_id', 'result_content', 'result_committed_at', 'lease_token', 'leased_by', 'leased_until']) assert.equal(Object.hasOwn(done, field), false);
  assert.equal(f.writes.length, 0); assert.equal((await f.jobs()).some(j => j.target === 'l3'), false);
  assert.equal((await readBranchDraft(f.root, 'acct', 'demo', b.branchId)).events.length, 1);
});

test('main refuses events; empty branch events complete; 12-event direct boundary holds', async t => {
  const f = await fixture(t), b = await f.createBranch('Limits');
  const main = await f.lease(await f.queue('main'));
  await f.submit(main, [], { content: '# Main' }, /events_only_for_branch_jobs/);
  const job = await f.lease(await f.queue('empty', b)); await f.submit(job, []);
  assert.equal((await f.jobs()).find(j => j.job_id === job.job_id).result_kind, 'branch_draft');
  const many = await f.lease(await f.queue('many', b));
  const events = Array.from({ length: 12 }, (_, i) => event(many.evidence_refs[0], `Event ${i}`));
  await f.submit(many, [...events, event(many.evidence_refs[0], 'Extra')], {}, /12/);
  assert.equal((await f.submit(many, events)).appended, 12);
});

test('durable draft append before a crashed ledger completion safely replays the same job', async t => {
  const f = await fixture(t), b = await f.createBranch('Crash'), job = await f.lease(await f.queue('crash', b));
  const first = event(job.evidence_refs[0], 'Frozen after append');
  // Reproduce the exact durable boundary after draft rename, before jobs rename.
  await mutateBranchDraft(f.root, 'acct', 'demo', b.branchId, async draft => {
    draft.events.push({ event: first, job_id: job.job_id, appended_at: new Date().toISOString() });
  });
  const args = { stateRoot: f.root, accountId: 'acct', jobId: job.job_id, leaseOwner: harness, leaseToken: job.lease_token,
    events: [first, event(job.evidence_refs[0], 'Must not replay extra')] };
  const result = await completeBranchJobWithEvents(args); assert.equal(result.appended, 0);
  assert.equal((await readBranchDraft(f.root, 'acct', 'demo', b.branchId)).events.length, 1);
  assert.equal((await f.jobs())[0].result_kind, 'branch_draft');
  assert.equal((await completeBranchJobWithEvents({ ...args, leaseToken: 'old' })).job_completed, true);
});

test('branch_draft never counts as canonical L2 in heads, model, hydration, base, consolidation, recovery or maintenance digest', async t => {
  const f = await fixture(t), main = await seedMain(f), b = await f.createBranch('Consumers');
  await ensureCards(f.deps); const before = (await readMaintenanceStore(f.root, 'acct')).generation.demo;
  const job = await finished(f, b, 'consumer');
  // Even a malformed old draft with revision-looking fields must be excluded.
  await mutateMaintenanceJob(f.root, 'acct', job.job_id, j => { j.result_id = 'forged'; j.result_content = '## 2099-01-01: False revision'; j.result_committed_at = '2099-01-01T00:00:00Z'; });
  const model = await buildProjectModel(f.runtime, { stateRoot: f.root, projectId: 'demo', l2: [], todos: [] });
  assert.deepEqual(model.revisions.map(r => r.ref), [`l2:${main.result_id}:${main.job_id}`]);
  assert.equal((await readBranchBase(f.runtime, f.root, 'demo')).base_l2_revision, model.revisions[0].ref);
  const all = await f.jobs();
  assert.throws(() => exactDistillationRevisionForMemory(all, { id: 'forged', memoryLayer: 'L2', body: '## 2099-01-01: False revision' }), /exact evidenceRef unavailable/);
  await assert.rejects(reconcileCompletedL2DerivedJob({ stateRoot: f.root, accountId: 'acct', projectId: 'demo', jobId: job.job_id, dryRun: true }), /complete.*L2 result/);
  const plan = await planDistillationConsolidation({ ...f.deps, kind: 'l2', projectId: 'demo' });
  assert.ok(!JSON.stringify(plan).includes('False revision'));
  const fake = all.find(j => j.job_id === job.job_id);
  assert.equal(validL3EvidenceBatch({ target: 'l3', scope: 'project', project_id: 'demo', evidence_refs: [`l2:forged:${job.job_id}`],
    evidence: [{ ref: `l2:forged:${job.job_id}`, kind: 'artifact', layer: 'L2', project_id: 'demo', content: fake.result_content, timestamp: fake.result_committed_at }] }, all), false);
  await ensureCards(f.deps); const after = (await readMaintenanceStore(f.root, 'acct')).generation.demo;
  assert.deepEqual(after, before);
  assert.ok((await claimedBranchEvents(f.root, 'acct')).has(job.evidence_refs[0].slice(3)));
  const lease = await f.lease(await f.queue('main-after-draft'));
  await f.call('litsan_distill', { action: 'submit', job_id: lease.job_id, source_harness: harness, lease_token: lease.lease_token, content: main.result_content + '\n\n## 2026-10-28: Main / 主线\n\nNew main event.\n\n新的主线事件。' });
  assert.equal(f.writes.length, 1);
});

test('close merges sorted events through a derived leased submit, keeps provenance and enqueues L3 once', async t => {
  const f = await fixture(t); await seedMain(f); const b = await f.createBranch('Feature');
  const job = await f.lease(await f.queue('merge', b));
  await f.submit(job, [event(job.evidence_refs[0], 'Later', '2026-10-23'), event(job.evidence_refs[0], 'Earlier', '2026-10-20'), event(job.evidence_refs[0], 'Prior', '2026-10-01')]);
  const result = await f.branch({ action: 'close', branch: b.branchId });
  assert.equal(result.branch.status, 'merged'); assert.equal(result.merge.appended, 2); assert.equal(f.writes.length, 1);
  const content = f.writes[0].content; assert.ok(content.indexOf('Earlier') < content.indexOf('Later'));
  assert.match(content, /## 2026-10-20: Earlier \/ 决定 Earlier/); assert.match(content, /Branch: Feature\nEvidence:/);
  assert.equal((content.match(/## 2026-10-01:/g) ?? []).length, 1);
  assert.ok((await f.jobs()).some(j => !j.branch_id && j.leased_by === undefined && j.result_kind === 'l2' && j.reason === 'upstream'));
  assert.equal((await f.jobs()).filter(j => j.target === 'l3').length, 1);
  const draft = await readBranchDraft(f.root, 'acct', 'demo', b.branchId); assert.equal(draft.status, 'merged'); assert.equal(draft.events.length, 2);
  const replay = await commitL2Append(f.deps, { projectId: 'demo', events: draft.events.map(e => e.event), provenance: { branch_id: b.branchId, branch_name: b.name, harness, source_job_ids: [job.job_id] } });
  assert.equal(replay.appended, 2); assert.equal(replay.job_id, draft.merge_job_id); assert.equal(f.writes.length, 1); assert.equal((await f.jobs()).filter(j => j.target === 'l3').length, 1);
  await f.branch({ action: 'reopen', branch: b.branchId });
  assert.equal((await readBranchDraft(f.root, 'acct', 'demo', b.branchId)).status, 'open');
  assert.match((await f.runtime.branches.resolve('acct', 'demo', b.branchId)).base_l2_revision, /^l2:/);
});

test('pending close defers, closing discovery flushes a partial batch, then sweep merges', async t => {
  const f = await fixture(t), b = await f.createBranch('Pending');
  await setDistillationConfig(f.root, { auto_enabled: true, turn_threshold: 100, idle_minutes: 1440 });
  await f.complete('partial', { branch: b.branchId });
  assert.equal((await f.branch({ action: 'close', branch: b.branchId })).merge.reason, 'undistilled_l1');
  const report = await discoverDistillationJobs({ stateRoot: f.root, accountId: 'acct', resolveProject: async () => 'demo', enqueue: true });
  assert.equal(report.queued, 1);
  assert.equal((await mergeBranch(f.deps, 'demo', b.branchId)).reason, 'pending_jobs');
  const job = await f.lease((await f.jobs()).find(j => j.branch_id)); await f.submit(job, [event(job.evidence_refs[0])]);
  await sweepWorkstreamBranches(f.deps);
  assert.equal((await f.runtime.branches.resolve('acct', 'demo', b.branchId, { includeClosed: true })).status, 'merged');
});

async function age(f, b, days) {
  const path = join(f.root, 'project-branches.json'), file = JSON.parse(await readFile(path, 'utf8'));
  const branch = file.branches.find(x => x.branchId === b.branchId);
  branch.last_activity_at = new Date(Date.now() - days * 86400_000).toISOString();
  await writeFile(path, JSON.stringify(file));
}
test('3-day idle closes; closing grace expires after 14 days and late jobs stay archived', async t => {
  const f = await fixture(t), idle = await f.createBranch('Idle'); await finished(f, idle, 'idle');
  await age(f, idle, 3.1); await sweepWorkstreamBranches(f.deps);
  assert.equal((await f.runtime.branches.resolve('acct', 'demo', idle.branchId, { includeClosed: true })).status, 'merged');
  const expired = await f.createBranch('Expired'); const pending = await f.queue('late', expired);
  await age(f, expired, 14.1);
  await f.runtime.branches.transition('acct', 'demo', expired.branchId, { status: 'closing', closing_since: new Date(Date.now() - 14.1 * 86400_000).toISOString() });
  const beforeL1 = (await listCaptureEvents(f.root, 'acct')).length;
  await sweepWorkstreamBranches(f.deps);
  assert.equal((await f.runtime.branches.resolve('acct', 'demo', expired.branchId, { includeClosed: true })).status, 'expired');
  assert.equal((await readBranchDraft(f.root, 'acct', 'demo', expired.branchId)).status, 'archived');
  await stat(branchDraftPath(f.root, 'acct', 'demo', expired.branchId));
  const leased = await f.lease(pending); await f.submit(leased, [event(leased.evidence_refs[0])]);
  const draft = await readBranchDraft(f.root, 'acct', 'demo', expired.branchId); assert.equal(draft.status, 'archived'); assert.equal(draft.events.length, 1);
  assert.equal((await listCaptureEvents(f.root, 'acct')).length, beforeL1); assert.equal(f.writes.length, 1);
  await f.branch({ action: 'reopen', branch: expired.branchId }); assert.equal((await readBranchDraft(f.root, 'acct', 'demo', expired.branchId)).status, 'open');
});

test('two concurrent project merges serialize and preserve both branches', async t => {
  const f = await fixture(t), a = await f.createBranch('One'), b = await f.createBranch('Two');
  await finished(f, a, 'one'); await finished(f, b, 'two');
  for (const branch of [a, b]) await f.runtime.branches.transition('acct', 'demo', branch.branchId, { status: 'closing' });
  let active = 0, peak = 0; const distill = f.runtime.memory.distill;
  f.runtime.memory.distill = async input => { peak = Math.max(peak, ++active); await new Promise(done => setTimeout(done, 30)); try { return await distill(input); } finally { active--; } };
  const results = await Promise.all([mergeBranch(f.deps, 'demo', a.branchId), mergeBranch(f.deps, 'demo', b.branchId)]);
  assert.ok(results.every(r => r.status === 'merged')); assert.equal(peak, 1); assert.equal(f.writes.length, 2);
  assert.match(f.writes.at(-1).content, /Branch: One/); assert.match(f.writes.at(-1).content, /Branch: Two/);
});

test('retrieval isolates open drafts, budgets newest 8, and indexed identity lookup reflects retags', async t => {
  const f = await fixture(t), a = await f.createBranch('Visible'), b = await f.createBranch('Sibling');
  const job = await f.lease(await f.queue('visible', a)); const events = Array.from({ length: 12 }, (_, i) => event(job.evidence_refs[0], `Draft ${i}`, `2026-10-${String(i + 1).padStart(2, '0')}`));
  await f.submit(job, events);
  const context = branch => f.call('litsan_context', { query: 'request answer', project: 'demo', detail: 'full', cross_project_skills: false, ...(branch ? { branch } : {}) });
  const visible = await context(a.branchId); assert.equal(visible.branchDraft.branch_id, a.branchId); assert.equal(visible.branchDraft.events[0].date, '2026-10-12');
  assert.ok(visible.branchDraft.events.length <= 8); assert.ok(JSON.stringify(visible.branchDraft).length <= 2500); assert.ok(visible.branchDraft.omitted >= 4);
  assert.equal(Object.hasOwn(await context(), 'branchDraft'), false); assert.equal(Object.hasOwn(await context(b.branchId), 'branchDraft'), false);
  const captures = await listCaptureEvents(f.root, 'acct'); const capture = captures.find(c => `l1:${c.event_id}` === job.evidence_refs[0]);
  const ids = [captureTurnId('acct', capture.host, capture.event_id), captureCoreRawTurnId('acct', capture.host, capture.event_id)];
  const hits = ids.map(id => ({ id, memoryLayer: 'L1', snippet: 'request answer', score: 1, tags: [], source: 'test' }));
  assert.equal((await filterBranchL1Hits(f.root, 'acct', a.branchId, hits, [])).length, 2);
  assert.equal((await filterBranchL1Hits(f.root, 'acct', b.branchId, hits, [])).length, 0);
  const fresh = await f.complete('retag', { branch: a.branchId });
  const c = (await listCaptureEvents(f.root, 'acct', { eventId: fresh }))[0]; const freshHit = [{ ...hits[0], id: captureCoreRawTurnId('acct', c.host, c.event_id) }];
  assert.equal((await filterBranchL1Hits(f.root, 'acct', a.branchId, freshHit, [])).length, 1);
  await f.branch({ action: 'retag', event_ids: [fresh], to_branch: b.branchId });
  assert.equal((await filterBranchL1Hits(f.root, 'acct', a.branchId, freshHit, [])).length, 0);
  assert.equal((await filterBranchL1Hits(f.root, 'acct', b.branchId, freshHit, [])).length, 1);
  await mutateBranchDraft(f.root, 'acct', 'demo', a.branchId, async d => { d.status = 'archived'; });
  assert.equal(await branchDraftContext(f.root, 'acct', 'demo', a.branchId), undefined);
  await mutateBranchDraft(f.root, 'acct', 'demo', a.branchId, async d => { d.status = 'open'; });
  await setWorkstreamEnabled(f.root, 'acct', 'demo', false);
  assert.equal(Object.hasOwn(await context(a.branchId), 'branchDraft'), false);
});

test('real branch l2_chunk cards → mergeSet → completeBranchJobWithEvents → draft, no Core submit', async t => {
  const f = await fixture(t), b = await f.createBranch('Cards'); const parent = await f.queue('cards', b, 9000);
  const deps = { ...f.deps, harness, profile: { execution: 'delegate' } };
  await ensureCards(deps);
  const store = await readMaintenanceStore(f.root, 'acct'), set = store.sets.find(s => s.parent_job_id === parent.job_id);
  assert.ok(set); assert.equal(set.branch_id, b.branchId);
  for (const id of set.card_ids) {
    const { card } = await nextCard({ ...deps, cardId: id }); assert.equal(store.cards.find(c => c.card_id === id).branch_id, b.branchId);
    const result = await submitCard({ ...deps, cardId: id, leaseToken: card.lease_token, answer: { events: [event(card.allowed_refs[0], `Card ${set.card_ids.indexOf(id)}`)] } });
    assert.equal(result.ok, true, JSON.stringify(result));
  }
  const done = (await f.jobs()).find(j => j.job_id === parent.job_id); assert.equal(done.status, 'completed'); assert.equal(done.result_kind, 'branch_draft');
  const draft = await readBranchDraft(f.root, 'acct', 'demo', b.branchId); assert.equal(draft.events.length, set.card_ids.length);
  assert.ok(draft.events.every(e => set.card_ids.includes(e.card_id))); assert.equal(f.writes.length, 0);
  assert.equal((await readMaintenanceStore(f.root, 'acct')).sets.find(s => s.set_id === set.set_id).status, 'merged');
  assert.equal((await f.jobs()).some(j => j.target === 'l3'), false);
});

test('flag disabled after use retains draft routing and sweep drains existing drafts', async t => {
  const f = await fixture(t), b = await f.createBranch('FlagDrain'), job = await f.lease(await f.queue('drain', b));
  await setWorkstreamEnabled(f.root, 'acct', 'demo', false);
  assert.equal((await f.branch({ action: 'close', branch: b.branchId })).merge.reason, 'pending_jobs');
  await f.submit(job, [event(job.evidence_refs[0])]);
  await sweepWorkstreamBranches(f.deps); assert.equal(f.writes.length, 1);
  assert.equal((await readBranchDraft(f.root, 'acct', 'demo', b.branchId)).status, 'merged');
});

test('restructure_job_not_branch rejects enqueue, submit and completion, including completed replay', async t => {
  const f = await fixture(t), b = await f.createBranch('Restructure');
  await assert.rejects(enqueueDistillationJob({ stateRoot: f.root, accountId: 'acct', projectId: 'demo', branchId: b.branchId, l2_restructure: {}, captures: [], reason: 'manual' }), /restructure_job_not_branch/);
  const job = await f.lease(await f.queue('restructure', b));
  await mutateMaintenanceJob(f.root, 'acct', job.job_id, j => { j.l2_restructure = {}; });
  await f.submit(job, [], {}, /restructure_job_not_branch/);
  await assert.rejects(completeBranchJobWithEvents({ stateRoot: f.root, accountId: 'acct', jobId: job.job_id, leaseOwner: harness, leaseToken: job.lease_token, events: [] }), /restructure_job_not_branch/);
});

test('cap eviction only enters closing; sweep merges and 3-day close respects unclaimed L1', async t => {
  const f = await fixture(t);
  const ids = [];
  for (let i = 0; i < 9; i++) {
    const opened = await f.call('litsan_turn', { action: 'open', project: 'demo', turn_id: `cap-${i}`, user_text: 'cap turn',
      workstream: { git_branch: `feature/cap-${i}` } });
    ids.push(opened.branch.id);
  }
  const all = await f.runtime.branches.list('acct', 'demo', { includeClosed: true });
  assert.equal(all.filter(b => b.status === 'active').length, 8);
  assert.equal(all.find(b => b.branchId === ids[0]).status, 'closing');
  await sweepWorkstreamBranches(f.deps);
  assert.equal((await f.runtime.branches.resolve('acct', 'demo', ids[0], { includeClosed: true })).status, 'merged');
  assert.equal(all.find(b => b.branchId === ids[0]).closed_reason, 'cap');
  await setDistillationConfig(f.root, { auto_enabled: true });
  const unclaimed = await f.createBranch('Unclaimed'); await f.complete('unclaimed', { branch: unclaimed.branchId });
  await age(f, unclaimed, 3.1); await sweepWorkstreamBranches(f.deps);
  assert.equal((await f.runtime.branches.resolve('acct', 'demo', unclaimed.branchId)).status, 'active');
});

test('map write failure is reported separately; stale full-map fingerprint rejects before draft write', async t => {
  const f = await fixture(t), b = await f.createBranch('Map');
  const candidate = { nodes: [{ id: 'demo', kind: 'project', label: 'Demo', summary: 'Project', parent_id: null, order: 0,
    evidence_refs: [], confidence: 1 }], edges: [], timeline_links: [] };
  const job = await f.lease(await f.queue('map', b)); candidate.nodes[0].evidence_refs = [job.evidence_refs[0]];
  const args = { architecture_map: candidate, architecture_map_base_fingerprint: architectureCognitiveMapFingerprint(null) };
  await f.submit(job, [event(job.evidence_refs[0])], { ...args, architecture_map_base_fingerprint: 'stale' }, /changed after action=next/);
  assert.equal(await readBranchDraft(f.root, 'acct', 'demo', b.branchId), null);
  f.runtime.architecture.writeProjectCognitiveMap = async () => { throw Error('map write unavailable'); };
  const result = await f.submit(job, [event(job.evidence_refs[0])], args);
  assert.match(result.architecture_map_error, /map write unavailable/); assert.equal(result.job_completed, true);
  assert.equal((await readBranchDraft(f.root, 'acct', 'demo', b.branchId)).events.length, 1); assert.equal(f.writes.length, 0);
});

test('concurrent branch completion deduplicates under the draft lock and rejects stale leases', async t => {
  const f = await fixture(t), b = await f.createBranch('LeaseFence');
  const job = await f.lease(await f.queue('race', b));
  const args = { stateRoot: f.root, accountId: 'acct', jobId: job.job_id, leaseOwner: harness, leaseToken: job.lease_token,
    events: [event(job.evidence_refs[0])] };
  await assert.rejects(completeBranchJobWithEvents({ ...args, leaseToken: 'stale' }), /lease/);
  const results = await Promise.all([completeBranchJobWithEvents(args), completeBranchJobWithEvents(args)]);
  assert.equal(results.reduce((sum, r) => sum + r.appended, 0), 1);
  assert.equal((await readBranchDraft(f.root, 'acct', 'demo', b.branchId)).events.length, 1);
});

test('completion obeys branches before draft lock and overlaps expiry without deadlock', { timeout: 10000 }, async t => {
  const f = await fixture(t), b = await f.createBranch('LockOrder'), job = await f.lease(await f.queue('lock-order', b));
  let release, acquired;
  const ready = new Promise(resolve => { acquired = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const holder = f.runtime.branches.withProjectLock('acct', 'demo', async () => { acquired(); await gate; });
  await ready;
  const completion = completeBranchJobWithEvents({ stateRoot: f.root, accountId: 'acct', jobId: job.job_id,
    leaseOwner: harness, leaseToken: job.lease_token, events: [event(job.evidence_refs[0])] });
  try {
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(await readBranchDraft(f.root, 'acct', 'demo', b.branchId), null, 'completion must wait for branches before touching draft');
    await mutateBranchDraft(f.root, 'acct', 'demo', b.branchId, async () => {});
  } finally { release(); }
  await Promise.all([holder, completion]);
  await f.runtime.branches.transition('acct', 'demo', b.branchId, { status: 'closing', closing_since: '2000-01-01T00:00:00Z' });
  await age(f, b, 20);
  await Promise.all([sweepWorkstreamBranches(f.deps), completeBranchJobWithEvents({ stateRoot: f.root, accountId: 'acct', jobId: job.job_id,
    leaseOwner: harness, leaseToken: job.lease_token, events: [] })]);
  assert.equal((await readBranchDraft(f.root, 'acct', 'demo', b.branchId)).status, 'merged');
});

test('append uses exact L2 base evidence while ordinary L2 evidence remains strict', async t => {
  const { validateDistillationEvidenceChain } = await import('../dist/distillation-evidence.js');
  const f = await fixture(t), main = await seedMain(f), b = await f.createBranch('Evidence');
  await finished(f, b, 'evidence'); await f.branch({ action: 'close', branch: b.branchId });
  const merge = (await f.jobs()).find(j => j.l2_append);
  assert.equal(merge.evidence[0].kind, 'memory'); assert.equal(merge.evidence[0].layer, 'L2');
  assert.equal(merge.evidence[0].ref, `l2:${main.result_id}:${main.job_id}`);
  await validateDistillationEvidenceChain({ ...f.deps, kind: 'l2', projectId: 'demo', evidenceRefs: merge.evidence_refs, job: merge });
  const ordinary = { ...merge }; delete ordinary.l2_append;
  await assert.rejects(validateDistillationEvidenceChain({ ...f.deps, kind: 'l2', projectId: 'demo', evidenceRefs: ordinary.evidence_refs, job: ordinary }), /must come from L1/);
  const forged = structuredClone(merge); forged.evidence[0].ref = 'l2:unversioned';
  await assert.rejects(validateDistillationEvidenceChain({ ...f.deps, kind: 'l2', projectId: 'demo', evidenceRefs: forged.evidence_refs, job: forged }), /exact project-scoped L2 base/);
});

test('append hashes contents refs source ids and head; completed replay never appends twice', async t => {
  const f = await fixture(t), main = await seedMain(f), b = await f.createBranch('Hash'), job = await finished(f, b, 'hash');
  const events = [event(job.evidence_refs[0], 'Hash first')];
  const provenance = { branch_id: b.branchId, branch_name: b.name, harness, source_job_ids: [job.job_id] };
  const first = await commitL2Append(f.deps, { projectId: 'demo', events, provenance });
  const stored = (await f.jobs()).find(j => j.job_id === first.job_id);
  const expected = hash(JSON.stringify([b.branchId, `l2:${main.result_id}:${main.job_id}`,
    events.map(e => [e.date, e.title_en, e.title_zh, e.body_en, e.body_zh, ...e.evidence_refs.slice().sort()]), [job.job_id]]));
  assert.equal(stored.evidence_hash, expected);
  const replay = await commitL2Append(f.deps, { projectId: 'demo', events, provenance });
  assert.equal(replay.job_id, first.job_id); assert.equal(f.writes.length, 1);
  const changed = await commitL2Append(f.deps, { projectId: 'demo', events: [event(job.evidence_refs[0], 'Same count different event')], provenance });
  assert.notEqual(changed.job_id, first.job_id); assert.equal(f.writes.length, 2);
});

test('stale incomplete append is superseded against current main and sweep retries successfully', async t => {
  const f = await fixture(t); const main = await seedMain(f), b = await f.createBranch('Stale');
  await finished(f, b, 'stale');
  const source = (await f.jobs()).find(j => j.branch_id === b.branchId);
  const baseRef = `l2:${main.result_id}:${main.job_id}`;
  const events = (await readBranchDraft(f.root, 'acct', 'demo', b.branchId)).events.map(e => e.event);
  const candidateHash = hash(JSON.stringify([b.branchId, baseRef,
    events.map(e => [e.date, e.title_en, e.title_zh, e.body_en, e.body_zh, ...e.evidence_refs.slice().sort()]), [source.job_id]]));
  const stale = (await enqueueDerivedDistillationJob({ stateRoot: f.root, accountId: 'acct', target: 'l2', projectId: 'demo',
    evidence: [{ ref: baseRef, kind: 'memory', layer: 'L2', content: main.result_content, project_id: 'demo', timestamp: main.updated_at }, ...source.evidence],
    dedupHash: candidateHash, mergeContent: main.result_content + '\n\n## 2026-10-27: stale / 陈旧\n\nOld candidate.\n\n旧候选。',
    l2Append: { branch_id: b.branchId, base_ref: baseRef } })).job;
  await f.runtime.branches.transition('acct', 'demo', b.branchId, { status: 'closing' });
  const extra = '\n\n## 2026-10-26: Concurrent main / 并发主线\n\nNew main history.\n\n新的主线历史。';
  await recordCompletedDistillationRevision({ stateRoot: f.root, accountId: 'acct', projectId: 'demo', target: 'l2',
    resultId: 'timeline-demo', content: main.result_content + extra, evidence: main.evidence, committedAt: new Date().toISOString() });
  await sweepWorkstreamBranches(f.deps);
  assert.equal((await f.runtime.branches.resolve('acct', 'demo', b.branchId, { includeClosed: true })).status, 'merged');
  assert.match(f.writes.at(-1).content, /Concurrent main/); assert.match(f.writes.at(-1).content, /Branch: Stale/);
  assert.equal((await f.jobs()).find(j => j.job_id === stale.job_id).status, 'failed');
});

test('merge precedes expiry after downtime and newly closing branches get a full grace period', async t => {
  const f = await fixture(t), mergeable = await f.createBranch('Downtime'); await finished(f, mergeable, 'downtime');
  await age(f, mergeable, 20); await sweepWorkstreamBranches(f.deps);
  assert.equal((await f.runtime.branches.resolve('acct', 'demo', mergeable.branchId, { includeClosed: true })).status, 'merged');
  const blocked = await f.createBranch('Grace'); await f.queue('grace', blocked); await age(f, blocked, 20);
  await f.branch({ action: 'close', branch: blocked.branchId }); await sweepWorkstreamBranches(f.deps);
  assert.equal((await f.runtime.branches.resolve('acct', 'demo', blocked.branchId, { includeClosed: true })).status, 'closing');
  await sweepWorkstreamBranches(f.deps, new Date(Date.now() + 14.1 * 86400_000));
  assert.equal((await f.runtime.branches.resolve('acct', 'demo', blocked.branchId, { includeClosed: true })).status, 'expired');
});

test('failed branch jobs are visible but only completed jobs can source an append', async t => {
  const f = await fixture(t), b = await f.createBranch('Failed'); await finished(f, b, 'success');
  const failed = await f.queue('failed', b);
  await mutateMaintenanceJob(f.root, 'acct', failed.job_id, j => { j.status = 'failed'; j.failure = 'permanent'; });
  await mutateBranchDraft(f.root, 'acct', 'demo', b.branchId, async draft => {
    draft.events.push({ event: event(failed.evidence_refs[0], 'Failed crash residue'), job_id: failed.job_id, appended_at: new Date().toISOString() });
  });
  await assert.rejects(commitL2Append(f.deps, { projectId: 'demo', events: [event(failed.evidence_refs[0], 'Invalid source')],
    provenance: { branch_id: b.branchId, branch_name: b.name, harness, source_job_ids: [failed.job_id] } }), /missing or incomplete/);
  const result = await f.branch({ action: 'close', branch: b.branchId }); assert.equal(result.branch.status, 'merged');
  assert.deepEqual((await readBranchDraft(f.root, 'acct', 'demo', b.branchId)).failed_job_ids, [failed.job_id]);
  const append = (await f.jobs()).find(j => j.l2_append); assert.ok(!append.evidence_refs.includes(failed.evidence_refs[0]));
  assert.ok(!f.writes.at(-1).content.includes('Failed crash residue'));
});

test('sweep isolates a merge error and continues with other branches', async t => {
  const f = await fixture(t), a = await f.createBranch('Broken'), b = await f.createBranch('Healthy');
  await finished(f, a, 'broken'); await finished(f, b, 'healthy');
  for (const branch of [a, b]) await f.runtime.branches.transition('acct', 'demo', branch.branchId, { status: 'closing' });
  const distill = f.runtime.memory.distill;
  f.runtime.memory.distill = async input => { if (input.content.includes('Branch: Broken')) throw new MemoryCoreHttpError(422, 'isolated branch failure'); return distill(input); };
  const errors = [], original = console.error; console.error = (...args) => errors.push(args.join(' '));
  try { await sweepWorkstreamBranches(f.deps); } finally { console.error = original; }
  assert.ok(errors.some(e => e.includes('isolated branch failure')));
  assert.equal((await f.runtime.branches.resolve('acct', 'demo', a.branchId, { includeClosed: true })).status, 'closing');
  assert.equal((await f.runtime.branches.resolve('acct', 'demo', b.branchId, { includeClosed: true })).status, 'merged');
});

test('reopened merged draft shows and merges only its fresh segment, including backdated events', async t => {
  const f = await fixture(t), b = await f.createBranch('Segments'); await finished(f, b, 'old-segment');
  await f.branch({ action: 'close', branch: b.branchId }); await f.branch({ action: 'reopen', branch: b.branchId });
  assert.deepEqual((await branchDraftContext(f.root, 'acct', 'demo', b.branchId)).events, []);
  await finished(f, b, 'new-segment', 'Backdated new event', '2026-10-02');
  const context = await branchDraftContext(f.root, 'acct', 'demo', b.branchId);
  assert.deepEqual(context.events.map(e => e.title_en), ['Backdated new event']);
  await f.branch({ action: 'close', branch: b.branchId });
  assert.equal((f.writes.at(-1).content.match(/: old-segment/g) ?? []).length, 1);
  const draft = await readBranchDraft(f.root, 'acct', 'demo', b.branchId); assert.equal(draft.events.length, 2); assert.equal(draft.merged_event_count, 2);
});

test('late completion opens a merged segment and sweep drains it without losing events', async t => {
  const f = await fixture(t), b = await f.createBranch('LateMerged'); await finished(f, b, 'first-merge');
  await f.branch({ action: 'close', branch: b.branchId });
  const capture = await f.complete('late-merged-main');
  const job = await f.lease((await enqueueDistillationJob({ stateRoot: f.root, accountId: 'acct', projectId: 'demo', branchId: b.branchId,
    captures: await listCaptureEvents(f.root, 'acct', { eventId: capture }), reason: 'manual' })).job);
  await f.submit(job, [event(job.evidence_refs[0], 'Late merged event')]);
  assert.equal((await readBranchDraft(f.root, 'acct', 'demo', b.branchId)).status, 'open');
  assert.deepEqual((await branchDraftContext(f.root, 'acct', 'demo', b.branchId)).events.map(e => e.title_en), ['Late merged event']);
  await sweepWorkstreamBranches(f.deps); assert.equal(f.writes.length, 2); assert.match(f.writes.at(-1).content, /Late merged event/);
});

for (const terminal of ['merged', 'closed']) {
  test(`discovery after auto-distillation enable drains ${terminal} branch turns into main L2`, async t => {
    const f = await fixture(t);
    const workstream = { git_branch: `feature/late-${terminal}` };
    const captures = [];
    for (let i = 0; i < 2; i++) captures.push(await f.complete(`late-${terminal}-${i}`, { workstream }));
    const [b] = await f.runtime.branches.list('acct', 'demo');
    assert.equal(b.origin, 'auto');
    assert.equal((await f.jobs()).length, 0);
    if (terminal === 'closed') await setWorkstreamEnabled(f.root, 'acct', 'demo', false);
    const close = await f.branch({ action: 'close', branch: b.branchId });
    if (terminal === 'merged') {
      assert.equal(close.branch.status, 'merged'); assert.equal(close.merge.status, 'merged');
      assert.equal((await readBranchDraft(f.root, 'acct', 'demo', b.branchId)).status, 'merged');
    } else {
      assert.equal(close.branch.status, 'closed');
      await f.runtime.branches.transition('acct', 'demo', b.branchId, { status: 'closed' });
      assert.equal(await readBranchDraft(f.root, 'acct', 'demo', b.branchId), null);
      await setWorkstreamEnabled(f.root, 'acct', 'demo', true);
    }
    assert.equal((await f.jobs()).length, 0, 'close must not wait for disabled auto-distillation');
    assert.equal((await listCaptureEvents(f.root, 'acct', { completeOnly: true, ingested: true })).length, 2);
    await setDistillationConfig(f.root, { auto_enabled: true, turn_threshold: 2 });
    // Enabling resets the cutover; move it back only after enabling.
    await setDistillationConfig(f.root, { auto_since: '2000-01-01T00:00:00.000Z' });
    const report = await discoverDistillationJobs({ ...f.deps, accountId: 'acct', resolveProject: async () => 'demo', enqueue: true });
    assert.equal(report.queued, 1);
    const [queued] = await f.jobs();
    assert.equal(queued.branch_id, b.branchId);
    assert.deepEqual(new Set(queued.evidence_refs), new Set(captures.map(id => `l1:${id}`)));
    const job = await f.lease(queued);
    const events = job.evidence_refs.map((ref, i) => event(ref, `Recovered ${terminal} ${i}`));
    await f.submit(job, events);
    assert.equal((await f.runtime.branches.resolve('acct', 'demo', b.branchId, { includeClosed: true })).status, 'closing',
      'late events must leave a terminal branch so sweep can drain its draft');
    assert.equal((await readBranchDraft(f.root, 'acct', 'demo', b.branchId)).status, 'open');
    await sweepWorkstreamBranches(f.deps);
    assert.equal((await f.runtime.branches.resolve('acct', 'demo', b.branchId, { includeClosed: true })).status, 'merged');
    const draft = await readBranchDraft(f.root, 'acct', 'demo', b.branchId);
    assert.equal(draft.status, 'merged'); assert.equal(draft.merged_event_count, events.length);
    const head = (await f.jobs()).filter(j => j.project_id === 'demo' && j.status === 'completed' && j.result_kind === 'l2')
      .sort((a, b) => a.result_committed_at.localeCompare(b.result_committed_at) || a.job_id.localeCompare(b.job_id)).at(-1);
    assert.ok(head, 'late events must reach a completed main L2 revision');
    for (const e of events) {
      const section = head.result_content.split(/^## /m).find(s => s.startsWith(`${e.date}: ${e.title_en} / `));
      assert.ok(section, `missing main L2 heading: ${e.title_en}`);
      assert.ok(section.includes(`Branch: ${b.name}`), 'each recovered event must retain branch provenance');
    }
    assert.equal((await discoverDistillationJobs({ ...f.deps, accountId: 'acct', resolveProject: async () => 'demo', enqueue: true })).queued, 0);
  });
}

test('draft completion dedupes main storage aliases and scan-time routing survives flag changes', async t => {
  const f = await fixture(t), b = await f.createBranch('Aliases');
  const main = await seedMain(f);
  await mutateMaintenanceJob(f.root, 'acct', main.job_id, j => { j.project_id = 'legacy-demo'; });
  const original = f.runtime.projects.storageIds.bind(f.runtime.projects);
  f.runtime.projects.storageIds = async (account, project) => [...await original(account, project), 'legacy-demo'];
  const capture = await f.complete('alias-dedupe', { branch: b.branchId });
  await setWorkstreamEnabled(f.root, 'acct', 'demo', false);
  const queued = (await enqueueDistillationJob({ stateRoot: f.root, accountId: 'acct', projectId: 'demo', branchId: b.branchId,
    captures: await listCaptureEvents(f.root, 'acct', { eventId: capture }), reason: 'manual' })).job;
  assert.equal(queued.branch_id, b.branchId);
  const job = await f.lease(queued); const result = await f.submit(job, [event(job.evidence_refs[0], 'Prior', '2026-10-01')]);
  assert.equal(result.appended, 0); assert.equal(result.dropped_duplicates, 1);
});

test('unchanged draft mutations preserve bytes and mtime and do not create empty files', async t => {
  const f = await fixture(t), b = await f.createBranch('NoWrite'), path = branchDraftPath(f.root, 'acct', 'demo', b.branchId);
  await mutateBranchDraft(f.root, 'acct', 'demo', b.branchId, async () => {});
  await assert.rejects(stat(path), { code: 'ENOENT' });
  await finished(f, b, 'no-write'); const before = await stat(path), bytes = await readFile(path, 'utf8');
  await mutateBranchDraft(f.root, 'acct', 'demo', b.branchId, async () => {});
  assert.equal((await stat(path)).mtimeMs, before.mtimeMs); assert.equal(await readFile(path, 'utf8'), bytes);
});

test('closing rebind preserves draft and base and cap eviction never attempts Core', async t => {
  const f = await fixture(t);
  const opened = await f.call('litsan_turn', { action: 'open', project: 'demo', turn_id: 'reactivate-auto', user_text: 'work', workstream: { git_branch: 'feature/reactivate' } });
  const id = opened.branch.id, b = await f.runtime.branches.resolve('acct', 'demo', id);
  await finished(f, b, 'reactivate-draft');
  await f.queue('reactivate-pending', b); await f.branch({ action: 'close', branch: id });
  const before = await readBranchDraft(f.root, 'acct', 'demo', id);
  for (let i = 0; i < 8; i++) await f.call('litsan_turn', { action: 'open', project: 'demo', turn_id: `reactivate-cap-${i}`, user_text: 'work', workstream: { git_branch: `feature/reactivate-${i}` } });
  f.runtime.memory.distill = async () => { throw Error('merge must never run inside bind'); };
  const bound = await f.call('litsan_turn', { action: 'open', project: 'demo', turn_id: 'reactivate-new', user_text: 'work', workstream: { git_branch: 'feature/reactivate' } });
  assert.equal(bound.branch.id, id);
  const current = await f.runtime.branches.resolve('acct', 'demo', id);
  assert.equal(current.status, 'active'); assert.equal(current.closing_since, undefined); assert.equal(current.closed_reason, undefined);
  assert.equal(current.base_map_fingerprint, b.base_map_fingerprint); assert.equal(current.base_l2_revision, b.base_l2_revision);
  assert.deepEqual(await readBranchDraft(f.root, 'acct', 'demo', id), before);
  await f.branch({ action: 'close', branch: id });
  const explicit = await f.call('litsan_turn', { action: 'open', project: 'demo', turn_id: 'reactivate-explicit', user_text: 'work', branch: id });
  assert.equal(explicit.branch.id, id); assert.equal((await f.runtime.branches.resolve('acct', 'demo', id)).status, 'active');
  assert.equal((await f.runtime.branches.list('acct', 'demo')).filter(b => b.origin === 'auto').length, 8);
  assert.equal(f.writes.length, 0);
});

test('blocked closing branch can expire after a logged merge error and full grace', async t => {
  const f = await fixture(t), b = await f.createBranch('ErrorExpiry'); await finished(f, b, 'error-expiry');
  await age(f, b, 20);
  await f.runtime.branches.transition('acct', 'demo', b.branchId, { status: 'closing', closing_since: '2000-01-01T00:00:00Z' });
  f.runtime.memory.distill = async () => { throw Error('expired merge failure'); };
  const original = console.error, errors = []; console.error = (...args) => errors.push(args.join(' '));
  try { await sweepWorkstreamBranches(f.deps); } finally { console.error = original; }
  assert.ok(errors.some(e => e.includes('expired merge failure')));
  assert.equal((await f.runtime.branches.resolve('acct', 'demo', b.branchId, { includeClosed: true })).status, 'expired');
  assert.equal((await readBranchDraft(f.root, 'acct', 'demo', b.branchId)).status, 'archived');
});

test('known branch retrieval identities use a read without capture mutation lock', { timeout: 10000 }, async t => {
  const { withCaptureIndexMutation } = await import('../dist/capture.js');
  const f = await fixture(t), b = await f.createBranch('ReadIndex'), capture = await f.complete('read-index', { branch: b.branchId });
  const c = (await listCaptureEvents(f.root, 'acct', { eventId: capture }))[0];
  const hits = [{ id: captureTurnId('acct', c.host, c.event_id), memoryLayer: 'L1', snippet: 'work', score: 1, tags: [], source: 'test' }];
  assert.equal((await filterBranchL1Hits(f.root, 'acct', b.branchId, hits, [])).length, 1);
  await withCaptureIndexMutation(f.root, async () => {
    let timer;
    try {
      const result = await Promise.race([filterBranchL1Hits(f.root, 'acct', b.branchId, hits, []),
        new Promise((_, reject) => { timer = setTimeout(() => reject(Error('retrieval waited for capture mutation lock')), 1000); })]);
      assert.equal(result.length, 1);
    } finally { clearTimeout(timer); }
  });
});

test('unresolved external append keeps its frozen job lease when main advances', async t => {
  const f = await fixture(t), main = await seedMain(f), b = await f.createBranch('Ambiguous'); await finished(f, b, 'ambiguous');
  f.runtime.memory.distill = async () => { throw Error('external result unknown'); };
  await f.call('litsan_branch', { action: 'close', project: 'demo', branch: b.branchId }, /external result unknown/);
  const frozen = (await f.jobs()).find(j => j.l2_append);
  await recordCompletedDistillationRevision({ stateRoot: f.root, accountId: 'acct', target: 'l2', projectId: 'demo',
    resultId: 'timeline-demo', content: main.result_content + '\n\n## 2026-10-26: Advanced / 推进\n\nNew history.\n\n新历史。', evidence: main.evidence, committedAt: new Date().toISOString() });
  await assert.rejects(mergeBranch(f.deps, 'demo', b.branchId), /unresolved external commit/);
  const after = (await f.jobs()).find(j => j.job_id === frozen.job_id);
  assert.equal(after.status, frozen.status); assert.equal(after.lease_token, frozen.lease_token);
  assert.equal((await f.jobs()).filter(j => j.l2_append).length, 1);
});
