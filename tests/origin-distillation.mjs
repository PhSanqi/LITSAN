import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rm } from 'node:fs/promises';
import { createLitsanRuntime } from '../dist/runtime.js';
import { registerTurnTools } from '../dist/shell/mcp/register-turn.js';
import { closeCaptureIndexDb, listCaptureEvents, markCaptureIngested, storeCaptureEvent } from '../dist/capture.js';
import { enqueueDistillationJob, leaseDistillationJob, listDistillationJobs, setDistillationConfig } from '../dist/distillation-jobs.js';
import { discoverDistillationJobs } from '../dist/distillation-discovery.js';
import { auditDistillationPipeline } from '../dist/distillation-audit.js';
import { distillationExclusion } from '../dist/core/lifecycle/distillation-eligibility.js';
import { ensureCards, nextCard } from '../dist/maintenance-control.js';
import { readMaintenanceStore } from '../dist/maintenance-store.js';
import { completeBranchJobWithEvents, readBranchDraft } from '../dist/branch-drafts.js';
import { closeWorkstreamBranch, mergeBranch, sweepWorkstreamBranches } from '../dist/workstream.js';
import { setWorkstreamEnabled } from '../dist/workstream-config.js';
import { architectureCognitiveMapFingerprint } from '../dist/architecture-cognitive-map.js';
import { createTestRoot, isolateTestEnvironment } from './test-isolation.mjs';

const requestedTmpdir = process.env.TMPDIR;
const accountId = 'origin-distillation-account';
const harness = 'origin-distillation-test';

async function fixture(run) {
  const root = await createTestRoot('origin-distillation-');
  isolateTestEnvironment(root, root);
  if (requestedTmpdir) process.env.TMPDIR = requestedTmpdir;
  const runtime = createLitsanRuntime({ accountId, controlRoot: root, disableArchitecture: true,
    memoryEndpoint: 'http://127.0.0.1:1', memoryToken: '', source: { platform: harness, transport: 'local' } });
  const writes = [];
  runtime.memoryClient.openSession = async () => ({});
  runtime.memoryClient.completeTurn = async () => ({});
  runtime.memoryClient.search = async () => ({ hits: [] });
  runtime.memoryClient.viewerGet = async path => path.startsWith('/api/v1/memory/')
    ? { id: 'timeline-demo', status: 'activated' } : { items: [], hasNext: false };
  runtime.memory.distill = async input => { writes.push(structuredClone(input)); return { id: 'timeline-demo', body: input.content }; };
  runtime.architecture.inspectProjectCognitiveMap = async ({ projectId }) => ({ projectId, path: '', exists: false,
    map: null, fingerprint: architectureCognitiveMapFingerprint(null) });
  runtime.architecture.getProjectArchitecture = async () => [];
  runtime.architecture.listProjectArchitectureMarkdown = async () => [];
  let turnHandler;
  registerTurnTools({ registerTool(_name, _schema, callback) { turnHandler = callback; } },
    { runtime, context: { stateRoot: root, jsonResult: value => value } });
  const deps = { stateRoot: root, runtime };
  const scan = { stateRoot: root, accountId, resolveProject: hint => runtime.projects.resolve(accountId, hint) };
  const events = () => listCaptureEvents(root, accountId);
  const record = (id, extra = {}) => turnHandler({ action: 'record', project: 'demo', turn_id: id,
    conversation_id: 'transport', user_text: `request ${id}`, assistant_text: `answer ${id}`, ...extra });
  const add = async (id, extra = {}) => {
    const stored = await storeCaptureEvent(root, { account_id: accountId, actor_id: harness }, {
      event_id: id, host: 'test', conversation_id: 'transport', continuity_id: id, project_hint: 'demo',
      timestamp: new Date().toISOString(), user_text: `request ${id}`, assistant_text: `answer ${id}`,
      capture_status: 'complete', ...extra
    });
    await markCaptureIngested(root, accountId, id);
    return stored.event;
  };
  const queue = async (eventId, branchId) => (await enqueueDistillationJob({ stateRoot: root, accountId,
    projectId: 'demo', ...(branchId ? { branchId } : {}),
    captures: (await events()).filter(e => e.event_id === eventId), reason: 'manual' })).job;
  const branch = name => runtime.branches.create(accountId, 'demo', { name, goal: `${name} changes` });
  try {
    await runtime.projects.create(accountId, { projectId: 'demo', name: 'Demo', description: 'Origin distillation tests' });
    await setDistillationConfig(root, { auto_enabled: false });
    await run({ root, runtime, deps, scan, writes, events, record, add, queue, branch });
  } finally {
    runtime.dispose();
    closeCaptureIndexDb(root);
    await rm(root, { recursive: true, force: true });
  }
}

test('distillation exclusion only recognizes relay and duplicate relations', () => {
  for (const [relation, reason] of [['relays', 'relation_relays'], ['duplicate_of', 'relation_duplicate_of'],
    ['continues', undefined], ['unknown', undefined], [null, undefined]]) {
    assert.equal(distillationExclusion({ provenance: { relates_to: { event_id: 'target', relation } } }), reason);
  }
  for (const provenance of [undefined, {}, { relates_to: null }, { relates_to: 'relays' },
    { relates_to: [] }, { relates_to: 1 }, { origin: 'agent' }]) {
    assert.equal(distillationExclusion({ provenance }), undefined);
  }
});

for (const [origin, sourceKind] of [['user', 'user_said'], ['agent', 'agent_inferred'], ['automation', 'tool_output']]) {
  test(`${origin} source kinds survive durable job evidence and l2_chunk card input`, () => fixture(async f => {
    const ack = await f.record(origin, { origin, reasoning_summary: 'Decision rationale', tool_summary: 'Local check passed' });
    const queued = await f.queue(ack.event_id);
    const job = (await listDistillationJobs(f.root, accountId)).find(j => j.job_id === queued.job_id);
    const expected = { user_text: sourceKind, assistant_text: 'agent_inferred',
      reasoning_summary: 'agent_inferred', tool_summary: 'tool_output' };
    assert.deepEqual(job.evidence[0].source_kinds, expected);
    const deps = { ...f.deps, harness, profile: { execution: 'delegate' } };
    await ensureCards(deps);
    const store = await readMaintenanceStore(f.root, accountId);
    const set = store.sets.find(s => s.parent_job_id === job.job_id);
    assert.ok(set);
    assert.equal(set.card_ids.length, 1);
    const { card } = await nextCard({ ...deps, cardId: set.card_ids[0] });
    assert.equal(card.kind, 'l2_chunk');
    assert.deepEqual(card.input.items[0].source_kinds, expected);
    assert.deepEqual(card.input.items, job.evidence);
  }));
}

test('source kinds validate each field and preserve the existing optional field set', () => fixture(async f => {
  const defaults = { user_text: 'user_said', assistant_text: 'agent_inferred',
    reasoning_summary: 'agent_inferred', tool_summary: 'tool_output' };
  const captures = [];
  for (const [index, kinds] of [undefined, null, 'invalid', 42, [], {},
    { user_text: 'invalid', assistant_text: null, reasoning_summary: 1, tool_summary: {} },
    { user_text: 'imported', assistant_text: 'user_said', reasoning_summary: 'tool_output', tool_summary: 'agent_inferred' },
    { user_text: 'tool_output', assistant_text: 'imported' }].entries()) {
    const event = await f.add(`kinds-${index}`, { reasoning_summary: 'reasoning', tool_summary: 'tools',
      provenance: { source_kinds: kinds } });
    captures.push(event);
  }
  captures.push(await f.add('absent-sections', { provenance: { source_kinds: defaults } }));
  captures.push(await f.add('blank-sections', { reasoning_summary: '  ', tool_summary: '\n', provenance: { source_kinds: defaults } }));
  const { job } = await enqueueDistillationJob({ stateRoot: f.root, accountId, projectId: 'demo', captures, reason: 'manual' });
  for (const item of job.evidence) {
    if (item.ref === 'l1:kinds-7') assert.deepEqual(item.source_kinds,
      { user_text: 'imported', assistant_text: 'user_said', reasoning_summary: 'tool_output', tool_summary: 'agent_inferred' });
    else if (item.ref === 'l1:kinds-8') assert.deepEqual(item.source_kinds,
      { ...defaults, user_text: 'tool_output', assistant_text: 'imported' });
    else if (['l1:absent-sections', 'l1:blank-sections'].includes(item.ref)) {
      assert.deepEqual(item.source_kinds, { user_text: 'user_said', assistant_text: 'agent_inferred' });
      assert.equal(Object.hasOwn(item, 'reasoning_summary'), false);
      assert.equal(Object.hasOwn(item, 'tool_summary'), false);
    } else assert.deepEqual(item.source_kinds, defaults);
  }
  assert.equal(job.evidence.length, captures.length);
}));

test('discovery and audit exclude relations before project resolution and branch grouping', () => fixture(async f => {
  await setWorkstreamEnabled(f.root, accountId, 'demo', true);
  const relayOnly = await f.branch('Relay only'), duplicateOnly = await f.branch('Duplicate only'), mixed = await f.branch('Mixed');
  const target = await f.record('target');
  const excluded = [];
  for (const [id, branch, relation] of [['relay-only', relayOnly, 'relays'], ['duplicate-only', duplicateOnly, 'duplicate_of'],
    ['mixed-relay', mixed, 'relays']]) {
    excluded.push((await f.record(id, { branch: branch.branchId, relates_to: { event_id: target.event_id, relation } })).event_id);
  }
  await f.add('unknown-project-duplicate', { project_hint: 'unknown-project',
    provenance: { relates_to: { event_id: target.event_id, relation: 'duplicate_of' } } });
  excluded.push('unknown-project-duplicate');
  const continued = await f.record('continued', { branch: mixed.branchId,
    relates_to: { event_id: target.event_id, relation: 'continues' } });
  await setDistillationConfig(f.root, { auto_enabled: true, turn_threshold: 100, idle_minutes: 30 });
  await setDistillationConfig(f.root, { auto_since: '2000-01-01T00:00:00Z' });
  const now = new Date(Date.now() + 3600_000);
  const audit = await auditDistillationPipeline({ ...f.scan, now });
  assert.equal(audit.evidence.skipped_relation, 4);
  assert.equal(audit.evidence.eligible_unqueued, 2);
  assert.equal(audit.evidence.ready_to_enqueue, 2);
  assert.equal(audit.evidence.waiting_for_idle_or_threshold, 0);
  assert.equal(audit.evidence.unresolved_project, 0);
  assert.equal(audit.recovery.durable_ingested_reconcilable, 2);
  const dry = await discoverDistillationJobs({ ...f.scan, now, enqueue: false });
  assert.equal(dry.skipped_relation, 4);
  assert.equal(dry.eligible, 2);
  assert.equal(dry.unresolved, 0);
  assert.equal(dry.would_enqueue, 2);
  const report = await discoverDistillationJobs({ ...f.scan, now, enqueue: true });
  assert.equal(report.skipped_relation, 4);
  assert.equal(report.queued, 2);
  const jobs = await listDistillationJobs(f.root, accountId);
  assert.deepEqual(new Set(jobs.map(j => j.branch_id ?? 'main')), new Set(['main', mixed.branchId]));
  assert.deepEqual(new Set(jobs.flatMap(j => j.evidence_refs)), new Set([`l1:${target.event_id}`, `l1:${continued.event_id}`]));
  assert.ok(jobs.every(j => j.evidence_refs.every(ref => !excluded.includes(ref.slice(3)))));
  await leaseDistillationJob(f.root, accountId, { jobId: jobs[0].job_id, harness, leaseSeconds: 30, useLeaseToken: true });
  const after = await auditDistillationPipeline({ ...f.scan, now });
  assert.equal(after.evidence.skipped_relation, 4);
  assert.equal(after.evidence.already_queued, 2);
  assert.equal(after.evidence.eligible_unqueued, 0);
  assert.equal(after.evidence.ready_to_enqueue, 0);
  assert.equal(after.recovery.durable_ingested_reconcilable, 0);
  assert.equal(after.jobs.pending, 2);
  assert.equal(after.jobs.leased, 0);
}));

test('discovery initializes and resets skipped_relation on disabled and unchanged scans', () => fixture(async f => {
  assert.equal((await discoverDistillationJobs(f.scan)).skipped_relation, 0);
  const target = await f.record('cache-target');
  await f.record('cache-relay', { relates_to: { event_id: target.event_id, relation: 'relays' } });
  await setDistillationConfig(f.root, { auto_enabled: true });
  await setDistillationConfig(f.root, { auto_since: '2000-01-01T00:00:00Z' });
  const now = new Date(Date.now() + 3600_000);
  const input = { ...f.scan, now, enqueue: true, skipUnchanged: true };
  assert.equal((await discoverDistillationJobs(input)).skipped_relation, 1);
  const cached = await discoverDistillationJobs(input);
  assert.equal(cached.scanned, 0);
  assert.equal(cached.skipped_relation, 0);
}));

for (const relation of ['relays', 'duplicate_of']) for (const mode of ['close', 'idle sweep']) {
  test(`branch with ${relation} and a completed job merges on ${mode}`, () => fixture(async f => {
    await setWorkstreamEnabled(f.root, accountId, 'demo', true);
    const branch = await f.branch('Merge relations');
    const target = await f.record('durable', { branch: branch.branchId });
    const queued = await f.queue(target.event_id, branch.branchId);
    const leased = await leaseDistillationJob(f.root, accountId, { jobId: queued.job_id, harness, useLeaseToken: true });
    await completeBranchJobWithEvents({ stateRoot: f.root, accountId, jobId: queued.job_id,
      leaseOwner: harness, leaseToken: leased.lease_token, events: [{ date: '2026-10-27',
        title_en: 'Durable change', title_zh: '长期变更', body_en: 'Implemented durable change.', body_zh: '完成长期变更。',
        evidence_refs: [`l1:${target.event_id}`] }] });
    const relay = await f.record('relay', { branch: branch.branchId, relates_to: { event_id: target.event_id, relation } });
    if (mode === 'close') {
      const closed = await closeWorkstreamBranch(f.deps, 'demo', branch.branchId);
      assert.equal(closed.merge.status, 'merged');
      assert.equal(closed.merge.appended, 1);
    } else {
      await sweepWorkstreamBranches(f.deps, new Date(Date.now() + 3.1 * 86400_000));
    }
    const closed = await f.runtime.branches.resolve(accountId, 'demo', branch.branchId, { includeClosed: true });
    assert.equal(closed.status, 'merged');
    assert.equal(closed.closed_reason, mode === 'close' ? 'user' : 'idle');
    assert.equal((await mergeBranch(f.deps, 'demo', branch.branchId)).status, 'merged');
    assert.equal((await readBranchDraft(f.root, accountId, 'demo', branch.branchId)).status, 'merged');
    assert.equal(f.writes.length, 1);
    assert.ok((await listDistillationJobs(f.root, accountId)).every(j => !j.evidence_refs.includes(`l1:${relay.event_id}`)));
  }));
}
