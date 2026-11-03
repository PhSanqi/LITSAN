import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rm, stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLitsanRuntime } from '../dist/runtime.js';
import { registerTurnTools } from '../dist/shell/mcp/register-turn.js';
import { closeCaptureIndexDb, listCaptureEvents, storeCaptureEvent } from '../dist/capture.js';
import { listL1Turns, upsertL1Turn } from '../dist/turn-log.js';
import { recordingDecision, SKIP_ASSISTANT_CHARS } from '../dist/core/lifecycle/recording-policy.js';
import { setDistillationConfig, listDistillationJobs, setDistillationJobsHooks } from '../dist/distillation-jobs.js';
import { setMaintenanceConfig, setMaintenanceStoreHooks, readMaintenanceStore } from '../dist/maintenance-store.js';
import { ensureCards } from '../dist/maintenance-control.js';
import { setWorkstreamEnabled } from '../dist/workstream-config.js';
import { effectiveBranches } from '../dist/capture-branch-assignments.js';
import { createTestRoot, isolateTestEnvironment } from './test-isolation.mjs';

const requestedTmpdir = process.env.TMPDIR;

for (const action of ['commit', 'record']) test(`latency ${action}: enqueue and split use one ledger write; replay changes no stores`, () => fixture(async ({ root, runtime, call, write }) => {
  await setDistillationConfig(root, { auto_enabled: true, auto_since: '2020-01-01T00:00:00.000Z', turn_threshold: 2 });
  await setMaintenanceConfig(root, { conversation_maintenance: 'quiet', delegate_min_interval_s: 0 });
  await ensureCards({ stateRoot: root, runtime, projectId: 'demo' });
  for (let i = 0; i < 6; i++) await write({ event_id: `waiting-${i}`, project_hint: 'demo',
    assistant_text: 'a'.repeat(9000), capture_status: 'complete' });
  const opened = action === 'commit' ? await call({ action: 'open', project: 'demo', user_text: 'request' }) : undefined;
  const args = { action, project: 'demo', assistant_text: 'done', client_profile: { execution: 'delegate' },
    ...(opened ? { event_id: opened.event_id } : { turn_id: 'stable-record', user_text: 'request' }) };
  let writes = 0, cardWrites = 0;
  setDistillationJobsHooks({ write: () => writes++ });
  setMaintenanceStoreHooks({ write: () => cardWrites++ });
  const ack = await call(args);
  assert.equal(ack.ingested, true); assert.equal(ack.distillation_queue_error, undefined);
  assert.equal(writes, 1);
  assert.equal((await listDistillationJobs(root, runtime.accountId)).length, 3);
  assert.equal((await readMaintenanceStore(root, runtime.accountId)).sets.length, 3);
  assert.equal(cardWrites, 1);
  const ledger = join(root, 'distillation', 'jobs.json'), cards = join(root, 'maintenance', 'cards.json');
  const before = await Promise.all([stat(ledger), stat(cards)]);
  const offers = await readFile(join(root, 'maintenance', 'offer-state.json'), 'utf8');
  await call(args);
  assert.equal(writes, 1); assert.equal(cardWrites, 1);
  assert.deepEqual((await Promise.all([stat(ledger), stat(cards)])).map(s => s.mtimeMs), before.map(s => s.mtimeMs));
  assert.equal(await readFile(join(root, 'maintenance', 'offer-state.json'), 'utf8'), offers);
}));

test('latency a previously stored but failed ingestion still queues on successful retry', () => fixture(async ({ root, runtime, call }) => {
  await setDistillationConfig(root, { auto_enabled: true, auto_since: '2020-01-01T00:00:00.000Z', turn_threshold: 2 });
  const args = { action: 'record', project: 'demo', turn_id: 'retry-ingest', user_text: 'request', assistant_text: 'done' };
  const complete = runtime.memoryClient.completeTurn;
  runtime.memoryClient.completeTurn = async () => { throw Error('ingestion unavailable'); };
  await assert.rejects(call(args), /ingestion unavailable/);
  runtime.memoryClient.completeTurn = complete;
  const result = await call(args);
  assert.equal(result.ingested, true);
  assert.deepEqual(result.distillation, { queued: false });
}));

async function fixture(run) {
  const root = await createTestRoot('origin-recording-');
  isolateTestEnvironment(root, root);
  // Keep the user-requested temp directory even though the isolation helper supplies its own default.
  if (requestedTmpdir) process.env.TMPDIR = requestedTmpdir;
  const runtime = createLitsanRuntime({ accountId: 'origin-account', controlRoot: root, disableArchitecture: true,
    memoryEndpoint: 'http://127.0.0.1:1', memoryToken: '', source: { platform: 'test', transport: 'local' } });
  const completed = [];
  runtime.memoryClient.openSession = async () => ({});
  runtime.memoryClient.completeTurn = async (...args) => { completed.push(args); return {}; };
  runtime.memoryClient.search = async () => ({ hits: [] });
  runtime.memoryClient.viewerGet = async () => ({ items: [], hasNext: false });
  let handler;
  registerTurnTools({ registerTool(_name, _schema, callback) { handler = callback; } },
    { runtime, context: { stateRoot: root, jsonResult: value => value } });
  const events = account => listCaptureEvents(root, account ?? runtime.accountId);
  const write = turn => upsertL1Turn({ stateRoot: root, runtime, actorId: 'test', turn: {
    host: 'test', conversation_id: 'conversation', user_text: 'request', ...turn
  } });
  try {
    await runtime.projects.create(runtime.accountId, { projectId: 'demo', name: 'Demo', description: 'Origin tests' });
    await setDistillationConfig(root, { auto_enabled: false });
    await run({ root, runtime, completed, events, write, call: args => handler(args) });
  } finally {
    setDistillationJobsHooks(); setMaintenanceStoreHooks();
    runtime.dispose();
    closeCaptureIndexDb(root);
    await rm(root, { recursive: true, force: true });
  }
}

for (const [origin, sourceKind] of [[undefined, 'user_said'], ['agent', 'agent_inferred'], ['automation', 'tool_output']]) {
  test(`origin ${origin ?? 'default user'} stores provenance and source kinds`, () => fixture(async ({ call, events }) => {
    const ack = await call({ action: 'open', user_text: 'request', ...(origin ? { origin } : {}) });
    const [event] = await events();
    assert.equal(event.event_id, ack.event_id);
    assert.equal(event.provenance.origin, origin ?? 'user');
    assert.deepEqual(event.provenance.source_kinds, { user_text: sourceKind, assistant_text: 'agent_inferred',
      reasoning_summary: 'agent_inferred', tool_summary: 'tool_output' });
    for (const key of ['trigger', 'initiator', 'relates_to']) assert.equal(Object.hasOwn(event.provenance, key), false);
  }));
}

for (const action of ['checkpoint', 'commit', 'failed', 'truncated']) {
  for (const byTurnId of [false, true]) test(`${action} inherits provenance (${byTurnId ? 'turn_id' : 'event_id'})`, () => fixture(async ({ call, events, root, runtime }) => {
    const initiator = { harness: 'codex', session_id: 'parent-session', event_id: 'parent-turn' };
    const ack = await call({ action: 'open', user_text: 'request', origin: 'agent', trigger: 'delegate', initiator,
      conversation_id: 'transport', turn_id: 'stable-turn' });
    await call({ action, conversation_id: 'transport', ...(byTurnId ? { turn_id: 'stable-turn' } : { event_id: ack.event_id }),
      ...(action === 'commit' ? { assistant_text: 'done' } : { tool_summary: 'audit' }) });
    const [event] = await events();
    assert.equal(event.provenance.origin, 'agent');
    assert.equal(event.provenance.trigger, 'delegate');
    assert.deepEqual(event.provenance.initiator, initiator);
    const resume = await call({ action: 'resume', event_id: ack.event_id });
    const [view] = await listL1Turns({ stateRoot: root, accountId: runtime.accountId });
    for (const read of [view, resume.turns[0]]) {
      assert.equal(read.origin, 'agent');
      assert.equal(read.trigger, 'delegate');
      assert.deepEqual(read.initiator, initiator);
    }
  }));
}

test('changing origin at commit throws a TypeError without modifying the event', () => fixture(async ({ call, events }) => {
  const ack = await call({ action: 'open', user_text: 'request', origin: 'agent' });
  const before = await events();
  await assert.rejects(call({ action: 'commit', event_id: ack.event_id, assistant_text: 'done', origin: 'user' }),
    { name: 'TypeError', message: 'origin cannot change after open' });
  assert.deepEqual(await events(), before);
}));

test('record writes one complete ingested event and replay ingests once', () => fixture(async ({ call, events, completed }) => {
  const args = { action: 'record', user_text: 'request', assistant_text: 'done', turn_id: 'one-shot',
    conversation_id: 'transport', origin: 'automation', trigger: 'cli_run' };
  const ack = await call(args);
  assert.equal(ack.status, 'complete');
  assert.equal(ack.ingested, true);
  assert.equal((await events()).length, 1);
  assert.equal((await events())[0].provenance.origin, 'automation');
  assert.equal(completed.length, 1);
  await call(args);
  assert.equal(completed.length, 1);
  assert.equal((await events()).length, 1);
}));

test('record binds workstreams and offers threshold distillation like commit', () => fixture(async ({ call, root, runtime, events }) => {
  await setWorkstreamEnabled(root, runtime.accountId, 'demo', true);
  await setDistillationConfig(root, { auto_enabled: true, turn_threshold: 2 });
  await setDistillationConfig(root, { auto_since: '2000-01-01T00:00:00Z' });
  const ack = await call({ action: 'record', project: 'demo', user_text: 'request', assistant_text: 'done',
    workstream: { git_branch: 'feature/origin' } });
  assert.equal(ack.status, 'complete');
  assert.equal(ack.ingested, true);
  assert.equal(ack.branch.reason, 'git_branch');
  assert.equal((await effectiveBranches(root, runtime.accountId, [ack.event_id])).get(ack.event_id), ack.branch.id);
  assert.equal((await events()).length, 1);
  assert.equal(ack.distillation.queued, false);
  const second = await call({ action: 'record', project: 'demo', user_text: 'second request', assistant_text: 'second answer',
    workstream: { git_branch: 'feature/origin' } });
  assert.equal(second.branch.id, ack.branch.id);
  assert.equal(second.distillation.queued, true);
  assert.equal((await listDistillationJobs(root, runtime.accountId)).length, 1);
}));

test('record validates required texts before writing', () => fixture(async ({ call, events }) => {
  for (const args of [{}, { user_text: 'request' }, { assistant_text: 'done' }]) {
    await assert.rejects(call({ action: 'record', ...args }), { name: 'TypeError' });
  }
  assert.deepEqual(await events(), []);
}));

test('relates_to requires a same-account target and is exposed on resume', () => fixture(async ({ call, write, events, root }) => {
  await write({ event_id: 'target', capture_status: 'open' });
  for (const relation of ['relays', 'duplicate_of', 'continues']) {
    const relates_to = { event_id: 'target', relation };
    const ack = await call({ action: 'record', user_text: 'relay request', assistant_text: 'relay answer', relates_to });
    const resume = await call({ action: 'resume', event_id: ack.event_id });
    assert.deepEqual(resume.turns[0].relates_to, relates_to);
  }
  await assert.rejects(call({ action: 'open', user_text: 'request', relates_to: { event_id: 'missing', relation: 'relays' } }),
    { name: 'TypeError', message: 'relates_to event not found' });
  const foreign = { ...((await events())[0]), event_id: 'foreign' };
  // The storage API scopes the target by the actor's account.
  await storeCaptureEvent(root, { account_id: 'foreign-account', actor_id: 'test' }, foreign);
  await assert.rejects(call({ action: 'open', user_text: 'request', relates_to: { event_id: 'foreign', relation: 'relays' } }),
    { name: 'TypeError', message: 'relates_to event not found' });
}));

for (const [name, provenance] of [
  ['origin', { origin: 'robot' }], ['null origin', { origin: null }], ['trigger', { trigger: 'unknown' }],
  ['initiator type', { initiator: [] }], ['initiator extra', { initiator: { extra: true } }],
  ['harness length', { initiator: { harness: 'x'.repeat(81) } }],
  ['session length', { initiator: { session_id: 'x'.repeat(301) } }],
  ['event length', { initiator: { event_id: 'x'.repeat(301) } }],
  ['initiator field type', { initiator: { event_id: 1 } }],
  ['relation required', { relates_to: { event_id: 'target' } }],
  ['relation type', { relates_to: null }], ['relation enum', { relates_to: { event_id: 'target', relation: 'unknown' } }],
  ['relation event required', { relates_to: { relation: 'relays' } }]
]) test(`invalid ${name} throws TypeError`, () => fixture(async ({ write }) => {
  await assert.rejects(write({ provenance }), { name: 'TypeError' });
}));

test('initiator accepts exact length limits', () => fixture(async ({ call, events }) => {
  const initiator = { harness: 'h'.repeat(80), session_id: 's'.repeat(300), event_id: 'e'.repeat(300) };
  await call({ action: 'open', user_text: 'request', initiator });
  assert.deepEqual((await events())[0].provenance.initiator, initiator);
}));

test('identical repeated turns are not auto-linked (relations are explicit only)', () => fixture(async ({ write }) => {
  const base = Date.parse('2026-10-27T00:00:00Z');
  await write({ event_id: 'first', continuity_id: 'same', timestamp: new Date(base).toISOString(),
    capture_status: 'complete', assistant_text: 'Done.' });
  const result = await write({ event_id: 'second', continuity_id: 'same', timestamp: new Date(base + 1000).toISOString(),
    capture_status: 'complete', assistant_text: 'Done.' });
  assert.equal(result.turn.relates_to, undefined);
}));

const policyCases = [
  ['user always records', { origin: 'user', relatesToRecorded: true }, { action: 'record' }],
  ['agent records', { origin: 'agent' }, { action: 'record' }],
  ['automation 399 skips', { origin: 'automation', assistantChars: 399 }, { action: 'skip', reason: 'status_relay' }],
  ['automation 400 records', { origin: 'automation', assistantChars: 400 }, { action: 'record' }],
  ['side effects record', { origin: 'automation', sideEffects: true }, { action: 'record' }],
  ['question records', { origin: 'automation', asksUser: true }, { action: 'record' }],
  ['recorded relay links', { origin: 'automation', relatesToRecorded: true }, { action: 'link' }],
  ['effects with relation link', { origin: 'agent', sideEffects: true, relatesToRecorded: true }, { action: 'link' }],
  ['question with relation links', { origin: 'automation', asksUser: true, relatesToRecorded: true }, { action: 'link' }]
];
for (const [name, input, expected] of policyCases) test(`recording policy: ${name}`, () => {
  assert.equal(SKIP_ASSISTANT_CHARS, 400);
  assert.deepEqual(recordingDecision({ assistantChars: 0, sideEffects: false, ...input }), expected);
});
