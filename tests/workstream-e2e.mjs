import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile, mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createLitsanRuntime } from '../dist/runtime.js';
import { createLitsanMcpServerForRuntime } from '../dist/mcp.js';
import { listCaptureEvents, closeCaptureIndexDb } from '../dist/capture.js';
import { effectiveBranches } from '../dist/capture-branch-assignments.js';
import { captureTurnId, captureCoreRawTurnId } from '../dist/capture-ingest.js';
import { JsonProjectBranchStore } from '../dist/branch-store.js';
import { setDistillationConfig, enqueueDistillationJob, listDistillationJobs, recordCompletedDistillationRevision } from '../dist/distillation-jobs.js';
import { discoverDistillationJobs } from '../dist/distillation-discovery.js';
import { architectureCognitiveMapFingerprint } from '../dist/architecture-cognitive-map.js';
import { createTestRoot, isolateTestEnvironment } from './test-isolation.mjs';

const hash = s => createHash('sha256').update(s).digest('hex');
const l1 = data => data.projectMemory.filter(i => i.provenance?.memoryLayer === 'L1');
const cleanVolatile = data => {
  const copy = structuredClone(data);
  if (copy.retrievalTrace) delete copy.retrievalTrace.trace_id;
  return copy;
};
async function fixture(run) {
  const root = await createTestRoot('workstream-');
  isolateTestEnvironment(root, root);
  const clients = [];
  const connect = async (account = 'acct') => {
    const runtime = createLitsanRuntime({ accountId: account, controlRoot: root, disableArchitecture: true,
      memoryEndpoint: 'http://127.0.0.1:1', memoryToken: '', source: { platform: 'test', transport: 'local' } });
    let hits = [], map = null;
    runtime.memoryClient.search = async req => ({ hits: hits.filter(h => req.layers.includes(h.memoryLayer)) });
    runtime.memoryClient.openSession = async () => ({});
    runtime.memoryClient.completeTurn = async () => ({});
    runtime.memoryClient.viewerGet = async () => ({ items: [], hasNext: false });
    runtime.architecture.inspectProjectCognitiveMap = async ({ projectId }) => ({ projectId, path: '', exists: !!map, map,
      fingerprint: architectureCognitiveMapFingerprint(map) });
    await runtime.projects.create(account, { projectId: 'demo', name: 'Demo', description: 'Workstream project', aliases: ['alias'] });
    await runtime.projects.create(account, { projectId: 'other', name: 'Other', description: 'Other project' });
    const server = createLitsanMcpServerForRuntime(runtime, root);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'workstream-test', version: '1' });
    await server.server.connect(st); await client.connect(ct);
    clients.push({ runtime, server, client });
    const call = async (name, args, error) => {
      const response = await client.callTool({ name, arguments: args });
      if (error) { assert.equal(response.isError, true); assert.match(response.content[0].text, error); return; }
      assert.ok(!response.isError, response.content[0]?.text);
      return JSON.parse(response.content[0].text);
    };
    const branch = args => call('litsan_branch', { project: 'demo', ...args });
    const open = (id, extra = {}) => call('litsan_turn', { action: 'open', project: 'demo', turn_id: id,
      conversation_id: 'transport', user_text: `request ${id}`, ...extra });
    const complete = async (id, extra = {}) => {
      const opened = await open(id, extra);
      await call('litsan_turn', { action: 'commit', conversation_id: 'transport', event_id: opened.event_id, assistant_text: `answer ${id}` });
      return opened;
    };
    const context = extra => call('litsan_context', { query: 'request answer', project: 'demo', cross_project_skills: false,
      detail: 'full', limit: 12, ...extra });
    return { runtime, call, branch, open, complete, context, setHits: value => { hits = value; }, setMap: value => { map = value; } };
  };
  try { await setDistillationConfig(root, { auto_enabled: false }); await run({ root, connect }); }
  finally {
    for (const { client, server, runtime } of clients.reverse()) { await client.close(); await server.close(); runtime.dispose(); }
    closeCaptureIndexDb(root); await rm(root, { recursive: true, force: true });
  }
}
const rows = async root => {
  const db = new Database(join(root, 'capture-index.sqlite'), { readonly: true });
  try {
    return db.prepare("SELECT 1 FROM sqlite_master WHERE name='capture_branch_assignments'").get()
      ? db.prepare('SELECT * FROM capture_branch_assignments ORDER BY id').all() : [];
  } finally { db.close(); }
};
const mapFixture = () => ({ schema_version: 1, contract: 'memhub-architecture-cognitive-map-v1', project_id: 'demo',
  authority: 'derived', abstraction_cutoff: 'method', generated_at: '2026-10-27T00:00:00Z', source_evidence_refs: [],
  nodes: [{ id: 'capture', kind: 'project', label: 'capture', summary: 'repair', parent_id: null, order: 0, evidence_refs: [], confidence: 1 }],
  edges: [], timeline_links: [] });
const hit = (id, snippet, layer = 'L1') => ({ id, kind: 'memory', memoryLayer: layer, status: 'activated',
  snippet, score: .9, tags: ['project:demo'], source: 'test', updatedAt: '2020-01-01T00:00:00Z' });

test('flag off matches legacy outputs with hints and writes no branch assignments or branch file', () => fixture(async ({ root, connect }) => {
  const f = await connect();
  const first = await f.open('off');
  const replay = await f.open('off', { workstream: { git_branch: 'feature/off' }, branch: 'unknown' });
  assert.deepEqual(replay, first);
  assert.equal(Object.hasOwn(first, 'branch'), false);
  assert.deepEqual(cleanVolatile(await f.context({ workstream: { git_branch: 'feature/off' } })), cleanVolatile(await f.context({})));
  assert.deepEqual(await rows(root), []);
  await assert.rejects(stat(join(root, 'project-branches.json')), { code: 'ENOENT' });
  assert.deepEqual(await f.branch({ action: 'settings' }), { project: 'demo', enabled: false });
}));

test('binding main fallbacks, explicit precedence, canonical flag and read-only context', () => fixture(async ({ root, connect }) => {
  const f = await connect();
  await f.branch({ action: 'settings', enabled: true, project: 'alias' });
  for (const [id, extra, reason] of [['none', {}, 'no_hint'], ['default', { workstream: { git_branch: 'main' } }, 'default_git_branch'],
    ['transport', { conversation_id: 'feature/never-bind' }, 'no_hint']]) {
    assert.equal((await f.open(id, extra)).branch.reason, reason);
    assert.equal((await f.open(id, extra)).branch.id, 'main');
  }
  const before = await rows(root);
  assert.equal((await f.context({ workstream: { git_branch: 'unknown' } })).branchContext, null);
  assert.deepEqual(await rows(root), before);
  assert.equal((await f.branch({ action: 'list' })).branches.length, 0);
  const auto = await f.open('feature', { workstream: { git_branch: 'feature/a', worktree: '/linked', continuity_id: 'c' } });
  assert.equal(auto.branch.reason, 'git_branch'); assert.equal(auto.branch.created, true);
  const manual = (await f.branch({ action: 'create', name: 'Manual', goal: 'capture repair' })).branch;
  const explicit = await f.open('explicit', { branch: manual.name, workstream: { git_branch: 'feature/a' } });
  assert.equal(explicit.branch.id, manual.branchId); assert.equal(explicit.branch.reason, 'explicit_branch');
  const context = await f.context({ branch: manual.branchId, workstream: { git_branch: 'feature/a' } });
  assert.equal(context.branchContext.branchId, manual.branchId); assert.equal(context.branchContext.source, 'explicit');
  await f.call('litsan_turn', { action: 'open', project: 'demo', user_text: 'bad', branch: 'unknown' }, /unknown active branch/);
  const count = (await rows(root)).length;
  await f.open('feature', { workstream: { git_branch: 'feature/a' } });
  assert.equal((await rows(root)).length, count);
  const unbound = await f.call('litsan_turn', { action: 'open', user_text: 'unbound', turn_id: 'unbound', workstream: { git_branch: 'feature/never' } });
  assert.equal(Object.hasOwn(unbound, 'branch'), false);
}));

test('continuity second turn promotes only unclaimed events and repeated open is idempotent', () => fixture(async ({ root, connect }) => {
  const f = await connect(); await f.branch({ action: 'settings', enabled: true });
  const hint = { continuity_id: 'stable-conversation', label: 'Continuity' };
  const first = await f.complete('continuity-first', { workstream: hint });
  assert.equal(first.branch.id, 'main'); assert.equal(first.branch.reason, 'continuity_first_turn');
  await f.open('continuity-first', { workstream: hint });
  assert.equal((await f.branch({ action: 'list' })).branches.length, 0);
  const second = await f.open('continuity-second', { workstream: hint });
  assert.equal(second.branch.created, true);
  assert.equal((await effectiveBranches(root, 'acct', [first.event_id])).get(first.event_id), second.branch.id);
  assert.ok((await rows(root)).some(r => r.event_id === first.event_id && r.reason === 'auto_promote'));
  const claimedHint = { continuity_id: 'claimed-conversation' };
  const claimed = await f.complete('claimed-first', { workstream: claimedHint });
  await enqueueDistillationJob({ stateRoot: root, accountId: 'acct', projectId: 'demo',
    captures: await listCaptureEvents(root, 'acct', { eventId: claimed.event_id }), reason: 'manual' });
  await f.open('claimed-second', { workstream: claimedHint });
  assert.equal((await effectiveBranches(root, 'acct', [claimed.event_id])).get(claimed.event_id), 'main');
}));

test('auto cap eight ignores manual, evicts idle, reactivates with preserved base and limits in-flight', () => fixture(async ({ root, connect }) => {
  const f = await connect(); await f.branch({ action: 'settings', enabled: true });
  for (let i = 0; i < 3; i++) await f.branch({ action: 'create', name: `Manual-${i}`, goal: 'capture repair' });
  const first = await f.open('auto-0', { workstream: { git_branch: 'feature/0' } });
  for (let i = 1; i < 8; i++) await f.open(`auto-${i}`, { workstream: { git_branch: `feature/${i}` } });
  // Force a deterministic oldest branch without waiting for the clock.
  const path = join(root, 'project-branches.json'), file = JSON.parse(await readFile(path, 'utf8'));
  file.branches.find(b => b.branchId === first.branch.id).last_activity_at = '2000-01-01T00:00:00Z';
  await writeFile(path, JSON.stringify(file));
  const ninth = await f.open('auto-8', { workstream: { git_branch: 'feature/8' } });
  assert.equal(ninth.branch.evicted.id, first.branch.id);
  let all = (await f.branch({ action: 'list', include_closed: true })).branches;
  assert.equal(all.filter(b => b.origin === 'auto' && b.status === 'active').length, 8);
  assert.equal(all.filter(b => b.origin === 'manual' && b.status === 'active').length, 3);
  assert.equal(all.find(b => b.branchId === first.branch.id).closed_reason, 'cap');
  f.setMap(mapFixture());
  const reopened = await f.open('reopen', { workstream: { git_branch: 'feature/0' } });
  assert.equal(reopened.branch.id, first.branch.id); assert.equal(reopened.branch.created, undefined);
  all = (await f.branch({ action: 'list' })).branches;
  assert.equal(all.find(b => b.branchId === first.branch.id).base_map_fingerprint, architectureCognitiveMapFingerprint(null));
  assert.equal(all.filter(b => b.origin === 'auto').length, 8);
  const context = await f.context({ workstream: { git_branch: 'feature/0' } });
  assert.equal(context.branchContext.base_stale, true);
  assert.ok(context.inFlight.branches.length <= 5 && JSON.stringify(context.inFlight).length <= 1500);
  assert.ok(context.inFlight.branches.every(b => b.branch_id !== first.branch.id && JSON.stringify(b).length <= 300));
}));

test('fork base records exact L2 revision and map drift appears in context and in-flight', () => fixture(async ({ root, connect }) => {
  const f = await connect(); await f.branch({ action: 'settings', enabled: true });
  f.setMap(mapFixture());
  await recordCompletedDistillationRevision({ stateRoot: root, accountId: 'acct', projectId: 'demo', target: 'l2',
    resultId: 'canonical-l2', content: 'Canonical timeline', committedAt: '2026-10-26T00:00:00Z',
    evidence: [{ ref: 'l1:base', kind: 'turn', timestamp: '2026-10-25T00:00:00Z' }] });
  const a = await f.open('base-a', { workstream: { git_branch: 'feature/base-a' } });
  const b = await f.open('base-b', { workstream: { git_branch: 'feature/base-b' } });
  const record = (await f.branch({ action: 'list' })).branches.find(r => r.branchId === a.branch.id);
  const job = (await listDistillationJobs(root, 'acct')).find(j => j.result_id === 'canonical-l2');
  assert.equal(record.base_l2_revision, `l2:canonical-l2:${job.job_id}`);
  assert.equal(record.base_map_fingerprint, architectureCognitiveMapFingerprint(mapFixture()));
  f.setMap({ ...mapFixture(), summary: 'map changed' });
  const ctx = await f.context({ branch: a.branch.id });
  assert.equal(ctx.branchContext.base_stale, true);
  assert.equal(ctx.inFlight.branches.find(r => r.branch_id === b.branch.id).base_stale, true);
}));

for (const withL2 of [false, true]) test(`retrieval isolation covers fresh and Core L1, unmappable hits, main and trace (L2=${withL2})`, () => fixture(async ({ root, connect }) => {
  const f = await connect(); await f.branch({ action: 'settings', enabled: true });
  const a = await f.complete('ALPHA_SECRET_TERM', { workstream: { git_branch: 'feature/a' } });
  const b = await f.complete('BETA_SECRET_TERM', { workstream: { git_branch: 'feature/b' } });
  const main = await f.complete('MAIN_SECRET_TERM');
  const captures = await listCaptureEvents(root, 'acct');
  const hits = captures.flatMap(event => [captureTurnId('acct', event.host, event.event_id), captureCoreRawTurnId('acct', event.host, event.event_id)]
    .map(id => hit(id, `${event.user_text} ${event.assistant_text}`)));
  const core = async hitsToUse => {
    f.setHits(hitsToUse);
    const data = await f.context({ workstream: { git_branch: 'feature/a' } });
    assert.equal(data.branchContext.branchId, a.branch.id); assert.equal(data.branchContext.source, 'workstream');
    assert.ok(l1(data).some(i => i.content.includes('ALPHA_SECRET_TERM')));
    assert.ok(!JSON.stringify(data).includes('BETA_SECRET_TERM'));
    assert.ok(!JSON.stringify(data).includes('MAIN_SECRET_TERM'));
    assert.ok(!JSON.stringify(data.inFlight).includes('SECRET_TERM'));
    return data;
  };
  await core([...hits, hit('unmappable', 'BETA_SECRET_TERM')]);
  // Move capture times before a fake L2 head to exercise Core-only L1 independently of fresh injection.
  if (withL2) {
    // A conforming Core also honors layer filters; unexpected L1 in L2 responses is filtered too.
    const oldSearch = f.runtime.memoryClient.search;
    f.runtime.memoryClient.search = async req => req.layers.includes('L2')
      ? { hits: [...hits, hit('head', 'Main distilled truth', 'L2')] } : oldSearch(req);
    await core(hits);
  }
  const mainContext = await f.context({});
  for (const term of ['ALPHA_SECRET_TERM', 'BETA_SECRET_TERM', 'MAIN_SECRET_TERM']) assert.ok(JSON.stringify(mainContext).includes(term));
  const tracePath = join(root, 'telemetry', `retrieval-${hash('acct').slice(0, 24)}.jsonl`);
  const traces = (await readFile(tracePath, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(traces.some(t => t.branch_id === a.branch.id && t.lanes.project.decisions.some(d => d.reason === 'other_branch')));
  // Fresh over-fetch must reach A beyond the four newest foreign captures.
  f.setHits([]);
  for (let i = 0; i < 6; i++) await f.complete(`BETA_RECENT_${i}`, { workstream: { git_branch: 'feature/b' } });
  const freshOnly = await f.context({ branch: a.branch.id });
  assert.ok(l1(freshOnly).some(i => i.id === a.event_id));
  assert.ok(l1(freshOnly).length <= 4);
  assert.ok(!JSON.stringify(freshOnly).includes('BETA_RECENT_'));
  assert.notEqual(a.branch.id, b.branch.id); assert.equal(main.branch.id, 'main');
}));

test('retag changes retrieval, refuses claimed/foreign/closed, preserves capture bytes and replay rows', () => fixture(async ({ root, connect }) => {
  const f = await connect();
  await f.call('litsan_branch', { action: 'retag', project: 'demo', event_ids: ['x'], to_branch: 'main' }, /workstream_disabled/);
  await f.branch({ action: 'settings', enabled: true });
  const a = await f.complete('move-me', { workstream: { git_branch: 'feature/a' } });
  const b = await f.complete('target', { workstream: { git_branch: 'feature/b' } });
  const foreign = await f.complete('foreign', { project: 'other' });
  const claimed = await f.complete('distilled', { workstream: { git_branch: 'feature/a' } });
  await enqueueDistillationJob({ stateRoot: root, accountId: 'acct', projectId: 'demo',
    captures: await listCaptureEvents(root, 'acct', { eventId: claimed.event_id }), reason: 'manual' });
  const capturePath = join(root, 'captures', hash('acct'), `${hash(a.event_id)}.json`);
  const before = await readFile(capturePath);
  const captureBytes = await Promise.all((await listCaptureEvents(root, 'acct')).map(async event => {
    const path = join(root, 'captures', hash('acct'), `${hash(event.event_id)}.json`);
    return [path, await readFile(path)];
  }));
  const moved = await f.branch({ action: 'retag', event_ids: [a.event_id, claimed.event_id, foreign.event_id, 'missing'], to_branch: b.branch.id });
  assert.equal(moved.moved, 1);
  assert.deepEqual(moved.refused, [{ event_id: claimed.event_id, code: 'already_distilled' }, { event_id: foreign.event_id, code: 'wrong_project' }, { event_id: 'missing', code: 'wrong_project' }]);
  assert.deepEqual(await readFile(capturePath), before);
  for (const [path, bytes] of captureBytes) assert.deepEqual(await readFile(path), bytes);
  assert.ok(!JSON.stringify(await f.context({ branch: a.branch.id })).includes('move-me'));
  assert.ok(JSON.stringify(await f.context({ branch: b.branch.id })).includes('move-me'));
  const count = (await rows(root)).length;
  await f.open('move-me', { workstream: { git_branch: 'feature/a' } });
  assert.equal((await rows(root)).length, count);
  assert.equal((await effectiveBranches(root, 'acct', [a.event_id])).get(a.event_id), b.branch.id);
  await f.branch({ action: 'close', branch: b.branch.id });
  for (const to_branch of [b.branch.id, 'unknown']) {
    const before = await rows(root);
    assert.deepEqual(await f.branch({ action: 'retag', event_ids: [a.event_id, claimed.event_id], to_branch }),
      { moved: 0, refused: [a.event_id, claimed.event_id].map(event_id => ({ event_id, code: 'target_not_active' })) });
    assert.deepEqual(await rows(root), before);
  }
  assert.equal((await f.context({ workstream: { git_branch: 'feature/b' } })).branchContext, null);
  const onMain = await f.branch({ action: 'retag', event_ids: [a.event_id], to_branch: 'main' });
  assert.equal(onMain.moved, 1);
}));

test('distillation discovery uses branch grouping when enabled and legacy grouping when disabled', () => fixture(async ({ root, connect }) => {
  const f = await connect(); await f.branch({ action: 'settings', enabled: true });
  await f.complete('group-a', { workstream: { git_branch: 'feature/a' } });
  await f.complete('group-b', { workstream: { git_branch: 'feature/b' } });
  await f.complete('group-main');
  await setDistillationConfig(root, { auto_enabled: true, turn_threshold: 2, idle_minutes: 1 });
  await setDistillationConfig(root, { auto_since: '2000-01-01T00:00:00Z' });
  const discover = enqueue => discoverDistillationJobs({ stateRoot: root, accountId: 'acct', enqueue,
    resolveProject: ref => f.runtime.projects.resolve('acct', ref), now: new Date('2099-01-01') });
  const branchOn = await discover(false);
  assert.equal(branchOn.would_enqueue, 3);
  await f.branch({ action: 'settings', enabled: false });
  const on = { ...branchOn, would_enqueue: 2 }; // Legacy account/project batches.
  assert.deepEqual(await discover(false), on);
  await f.branch({ action: 'settings', enabled: true }); await discover(true);
  const jobs = await listDistillationJobs(root, 'acct');
  assert.equal(jobs.length, 3);
  assert.ok(jobs.every(j => j.account_id === 'acct' && j.project_id === 'demo'));
  assert.equal(jobs.filter(j => j.branch_id).length, 2);
  assert.equal(jobs.flatMap(j => j.evidence_refs).length, 3);
}));

test('accounts never share flags or same-key branches; legacy branch files list unchanged', () => fixture(async ({ root, connect }) => {
  const a = await connect(), b = await connect('other-account');
  await a.branch({ action: 'settings', enabled: true });
  assert.equal((await b.branch({ action: 'settings' })).enabled, false);
  const one = await a.open('same-key', { workstream: { git_branch: 'same' } });
  await b.branch({ action: 'settings', enabled: true });
  assert.equal((await b.branch({ action: 'list' })).branches.length, 0);
  const two = await b.open('same-key', { workstream: { git_branch: 'same' } });
  assert.notEqual(one.branch.id, two.branch.id);
  assert.deepEqual(await a.branch({ action: 'retag', event_ids: [two.event_id], to_branch: 'main' }),
    { moved: 0, refused: [{ event_id: two.event_id, code: 'wrong_project' }] });
  assert.equal((await a.branch({ action: 'list' })).branches.length, 1);
  assert.equal((await b.branch({ action: 'list' })).branches.length, 1);
  await b.call('litsan_context', { project: 'demo', query: 'request', branch: one.branch.id }, /unknown active branch/);
  const path = join(root, 'legacy.json');
  const legacy = { accountId: 'acct', projectId: 'demo', branchId: 'legacy', name: 'Legacy', goal: 'Original', status: 'active', createdAt: '2026-01-01', updatedAt: '2026-01-01' };
  await writeFile(path, JSON.stringify({ version: 1, branches: [legacy] }));
  assert.deepEqual(await new JsonProjectBranchStore(path).list('acct', 'demo'), [legacy]);
  assert.equal(await readFile(path, 'utf8'), JSON.stringify({ version: 1, branches: [legacy] }));
}));

test('concurrent opens serialize branch creation and cap, touch is throttled, active names get suffixes', () => fixture(async ({ root, connect }) => {
  const f = await connect(); await f.branch({ action: 'settings', enabled: true });
  await f.branch({ action: 'create', name: 'same', goal: 'Manual' });
  const same = await Promise.all(Array.from({ length: 4 }, (_, i) => f.open(`parallel-${i}`, { workstream: { git_branch: 'same' } })));
  assert.equal(new Set(same.map(r => r.branch.id)).size, 1); assert.equal(same[0].branch.name, 'same-2');
  const path = join(root, 'project-branches.json'), before = await stat(path);
  await f.open('touch', { workstream: { git_branch: 'same' } });
  assert.equal((await stat(path)).mtimeMs, before.mtimeMs);
  await Promise.all(Array.from({ length: 10 }, (_, i) => f.open(`cap-parallel-${i}`, { workstream: { git_branch: `parallel/${i}` } })));
  const all = (await f.branch({ action: 'list' })).branches;
  assert.equal(all.filter(b => b.origin === 'auto').length, 8);
  assert.equal(all.filter(b => b.origin === 'manual').length, 1);
}));

for (const withL2 of [false, true]) test(`Core L1 isolation independently of fresh injection (L2=${withL2})`, () => fixture(async ({ root, connect }) => {
  const f = await connect(); await f.branch({ action: 'settings', enabled: true });
  const a = await f.open('CORE_ALPHA', { workstream: { git_branch: 'feature/a' } });
  const b = await f.open('CORE_BETA', { workstream: { git_branch: 'feature/b' } });
  const coreHits = [hit(captureTurnId('acct', 'test', a.event_id), 'CORE_ALPHA'),
    hit(captureCoreRawTurnId('acct', 'test', b.event_id), 'CORE_BETA'), hit('unmappable', 'CORE_BETA')];
  f.runtime.memoryClient.search = async req => ({ hits: req.layers.includes(withL2 ? 'L2' : 'L1')
    ? [...coreHits, ...(withL2 ? [hit('canonical', 'Distilled shared truth', 'L2')] : [])] : [] });
  const data = await f.context({ branch: a.branch.id });
  assert.equal(l1(data).length, 1);
  assert.equal(l1(data)[0].id, captureTurnId('acct', 'test', a.event_id));
  assert.ok(JSON.stringify(data).includes('CORE_ALPHA'));
  assert.ok(!JSON.stringify(data).includes('CORE_BETA'));
  if (withL2) assert.ok(data.projectMemory.some(i => i.id === 'canonical'));
  const before = await readFile(join(root, 'project-branches.json'));
  await f.context({ workstream: { git_branch: 'unknown' } });
  assert.deepEqual(await readFile(join(root, 'project-branches.json')), before);
}));

test('workstream input validates trimmed string limits and other turn actions ignore hints', () => fixture(async ({ connect }) => {
  const f = await connect(); await f.branch({ action: 'settings', enabled: true });
  const turn = await f.open('trimmed', { workstream: { git_branch: ' feature/trimmed ', label: ' Label ' } });
  assert.equal(turn.branch.name, 'feature/trimmed');
  const record = (await f.branch({ action: 'list' })).branches[0];
  assert.equal(record.goal, 'Label');
  await f.call('litsan_turn', { action: 'open', project: 'demo', user_text: 'invalid', workstream: { label: 'x'.repeat(81) } }, /./);
  await f.call('litsan_context', { query: 'invalid', project: 'demo', workstream: { git_branch: 'x'.repeat(301) } }, /./);
  await f.call('litsan_turn', { action: 'commit', conversation_id: 'transport', event_id: turn.event_id,
    assistant_text: 'done', branch: 'unknown', workstream: { git_branch: 'ignored' } });
  assert.equal((await f.branch({ action: 'list' })).branches.length, 1);
}));

test('fresh over-fetch fills all four slots beyond a busy sibling page', () => fixture(async ({ connect }) => {
  const f = await connect(); await f.branch({ action: 'settings', enabled: true });
  const mine = [];
  for (let i = 0; i < 4; i++) mine.push(await f.complete(`ALPHA_FRESH_${i}`, { workstream: { git_branch: 'feature/a' } }));
  for (let i = 0; i < 70; i++) await f.complete(`BETA_NEWER_${i}`, { workstream: { git_branch: 'feature/b' } });
  const data = await f.context({ branch: mine[0].branch.id });
  assert.deepEqual(new Set(l1(data).map(i => i.id)), new Set(mine.map(t => t.event_id)));
  assert.ok(!JSON.stringify(data).includes('BETA_NEWER_'));
}));

test('malformed workstream is ignored with flag off or unresolved project, rejected when enabled', () => fixture(async ({ root, connect }) => {
  const f = await connect();
  const malformed = [null, 'bad', [], { git_branch: 7 }, { unknown: 'bad' }, { label: 'x'.repeat(81) }];
  for (const [i, workstream] of malformed.entries()) {
    const baseline = await f.open(`off-invalid-${i}`);
    assert.deepEqual(await f.open(`off-invalid-${i}`, { workstream }), baseline);
    assert.deepEqual(cleanVolatile(await f.context({ workstream })), cleanVolatile(await f.context({})));
  }
  assert.deepEqual(await rows(root), []);
  await assert.rejects(stat(join(root, 'project-branches.json')), { code: 'ENOENT' });
  await f.branch({ action: 'settings', enabled: true });
  for (const [i, workstream] of malformed.entries()) {
    const unbound = await f.open(`unbound-invalid-${i}`, { project: undefined, workstream });
    assert.equal(Object.hasOwn(unbound, 'branch'), false);
    assert.deepEqual(cleanVolatile(await f.context({ project: undefined, workstream })),
      cleanVolatile(await f.context({ project: undefined })));
    await f.call('litsan_turn', { action: 'open', project: 'demo', user_text: 'invalid', workstream }, /workstream/);
    await f.call('litsan_context', { project: 'demo', query: 'request', workstream }, /workstream/);
  }
}));

for (const unreadable of [false, true]) test(`bad config disables all projects with one warning (unreadable=${unreadable})`, () => fixture(async ({ root, connect }) => {
  const f = await connect();
  const baseline = await f.open('bad-config');
  const baselineContext = cleanVolatile(await f.context({}));
  const path = join(root, 'workstream-branches.json');
  if (unreadable) await mkdir(path); else await writeFile(path, '{broken');
  const warnings = [], warn = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    assert.deepEqual(await f.open('bad-config', { workstream: null }), baseline);
    assert.deepEqual(cleanVolatile(await f.context({ workstream: null })), baselineContext);
    assert.equal(Object.hasOwn(await f.open('other-off', { project: 'other', workstream: null }), 'branch'), false);
    assert.deepEqual(await f.branch({ action: 'settings' }), { project: 'demo', enabled: false });
    await f.call('litsan_branch', { action: 'settings', project: 'demo', enabled: true }, /./);
    assert.equal(warnings.length, 1);
    assert.match(String(warnings[0][0]), /all projects disabled/);
    assert.deepEqual(await rows(root), []);
  } finally { console.warn = warn; }
}));

test('retag already on target refuses branch and implicit main without adding rows', () => fixture(async ({ root, connect }) => {
  const f = await connect();
  const legacy = await f.complete('implicit-main');
  await f.branch({ action: 'settings', enabled: true });
  const a = await f.complete('same-target', { workstream: { git_branch: 'same-target' } });
  for (const [event_id, to_branch] of [[a.event_id, a.branch.id], [a.event_id, a.branch.name], [legacy.event_id, 'main']]) {
    const before = await rows(root);
    assert.deepEqual(await f.branch({ action: 'retag', event_ids: [event_id], to_branch }),
      { moved: 0, refused: [{ event_id, code: 'already_on_target' }] });
    assert.deepEqual(await rows(root), before);
  }
}));

for (const operation of ['createAuto', 'refreshBase']) test(`cap closes nothing when ${operation} fails`, () => fixture(async ({ root, connect }) => {
  const f = await connect(); await f.branch({ action: 'settings', enabled: true });
  if (operation === 'refreshBase') {
    const closed = await f.open('closed', { workstream: { git_branch: 'new' } });
    await f.branch({ action: 'close', branch: closed.branch.id });
  }
  for (let i = 0; i < 8; i++) await f.open(`existing-${i}`, { workstream: { git_branch: `existing-${i}` } });
  const path = join(root, 'project-branches.json'), before = await readFile(path);
  const original = JsonProjectBranchStore.prototype[operation];
  JsonProjectBranchStore.prototype[operation] = async function () {
    assert.deepEqual(await readFile(path), before);
    throw new Error('injected branch write failure');
  };
  try {
    await f.call('litsan_turn', { action: 'open', project: 'demo', user_text: 'new', workstream: { git_branch: 'new' } }, /injected branch write failure/);
    assert.deepEqual(await readFile(path), before);
  } finally { JsonProjectBranchStore.prototype[operation] = original; }
}));

test('reopen suffixes active name collisions and preserves identity and fresh base', () => fixture(async ({ root, connect }) => {
  const f = await connect(); await f.branch({ action: 'settings', enabled: true });
  const first = await f.open('original', { workstream: { git_branch: 'Collision' } });
  await f.branch({ action: 'close', branch: first.branch.id });
  await f.branch({ action: 'create', name: 'COLLISION', goal: 'active holder' });
  await f.branch({ action: 'create', name: 'collision-2', goal: 'suffix holder' });
  f.setMap(mapFixture());
  const reopened = await f.open('renamed', { workstream: { git_branch: 'Collision' } });
  assert.equal(reopened.branch.id, first.branch.id);
  assert.equal(reopened.branch.name, 'Collision-3');
  const branches = (await f.branch({ action: 'list' })).branches;
  assert.equal(branches.length, 3);
  assert.equal(branches.find(b => b.branchId === first.branch.id).base_map_fingerprint, architectureCognitiveMapFingerprint(mapFixture()));
  assert.equal((await f.context({ branch: 'Collision-3' })).branchContext.branchId, first.branch.id);
}));

test('continuity reactivates closing branches and reopens terminal branches without duplicate promotions', () => fixture(async ({ root, connect }) => {
  const f = await connect(); await f.branch({ action: 'settings', enabled: true });
  // Auto-distillation must be on for the branch turns to count as pending L1 that defers the merge.
  await setDistillationConfig(root, { auto_enabled: true, turn_threshold: 100 });
  await setDistillationConfig(root, { auto_since: '2000-01-01T00:00:00Z' });
  const workstream = { continuity_id: 'reopen-continuity' };
  const first = await f.complete('promotion-first', { workstream });
  const second = await f.complete('promotion-second', { workstream });
  await f.branch({ action: 'close', branch: second.branch.id });
  const closing = await f.runtime.branches.resolve('acct', 'demo', second.branch.id, { includeClosed: true });
  assert.equal(closing.status, 'closing');
  const before = await rows(root);
  const reopened = await f.open('promotion-reopen', { workstream });
  assert.equal(reopened.branch.id, second.branch.id);
  const active = await f.runtime.branches.resolve('acct', 'demo', second.branch.id);
  assert.equal(active.status, 'active');
  assert.equal(active.base_l2_revision, closing.base_l2_revision);
  assert.equal(active.closing_since, undefined);
  const after = await rows(root);
  assert.equal(after.length, before.length + 1);
  for (const id of [first.event_id, second.event_id]) {
    assert.deepEqual(after.filter(r => r.event_id === id), before.filter(r => r.event_id === id));
  }
  for (const status of ['merged', 'expired']) {
    await f.runtime.branches.transition('acct', 'demo', second.branch.id, { status });
    f.setMap(mapFixture());
    const terminalBefore = await rows(root);
    const fresh = await f.open(`promotion-${status}`, { workstream });
    assert.equal(fresh.branch.id, second.branch.id);
    const terminalAfter = await rows(root);
    assert.equal(terminalAfter.length, terminalBefore.length + 1);
    for (const id of [first.event_id, second.event_id]) {
      assert.deepEqual(terminalAfter.filter(r => r.event_id === id), terminalBefore.filter(r => r.event_id === id));
    }
    assert.equal((await f.runtime.branches.resolve('acct', 'demo', second.branch.id)).base_map_fingerprint, architectureCognitiveMapFingerprint(mapFixture()));
  }
}));
