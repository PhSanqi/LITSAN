import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Readable } from 'node:stream';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { handleMemoryControlAction } from '../dist/memory-control-actions.js';
import { readMaintenanceStore } from '../dist/maintenance-store.js';
import { JsonProjectRegistry } from '../dist/project-registry.js';
import { buildProjectModel } from '../dist/shell/archify/project-model.js';
import { projectMemoryVisualization } from '../dist/archify/memory-visualization.js';
import { storeCaptureEvent } from '../dist/capture.js';
import { timelineProjectModel, completedJob } from './fakes/project-model-fakes.mjs';
import { createTestRoot } from './test-isolation.mjs';

test('map actions: account ownership, validation, durable flags, clearing, queue generation and no model call', async () => {
  const root = await createTestRoot('map-actions-');
  try {
    const projects = new JsonProjectRegistry(join(root, 'projects.json'));
    await projects.create('acct', { projectId: 'alpha', name: 'Alpha', description: 'Test', aliases: ['alias'] });
    const model = timelineProjectModel(true);
    let modelCalls = 0;
    const runtime = { accountId: 'acct', userId: 'user', projects,
      architecture: { async inspectProjectCognitiveMap() { return { map: model.architecture.map, fingerprint: model.architecture.fingerprint }; },
        async listProjectArchitectureMarkdown() { return [{ path: 'project-repo/ARCHITECTURE.md', content: '# Alpha' }]; } },
      memoryClient: { async viewerGet() { return { items: model.l2, hasNext: false }; } },
      memory: { async distill() { modelCalls++; throw Error('No model call allowed'); } } };
    await mkdir(join(root, 'distillation'));
    await writeFile(join(root, 'distillation/jobs.json'), JSON.stringify({ version: 2, jobs: model.revisions.map((r, i) => completedJob({
      job_id: 'revision-' + i, result_id: r.memory_id, result_content: r.content, result_committed_at: r.committed_at
    })) }));
    const account = { account_id: 'acct', username: 'test', role: 'user' };
    const action = async (body, options = {}) => {
      const request = Readable.from([JSON.stringify(body)]);
      request.headers = { 'content-type': options.contentType ?? 'application/json' };
      let status = 0, raw = '';
      const response = { setHeader() {}, writeHead(code) { status = code; return this; }, end(value) { raw = value || ''; } };
      await handleMemoryControlAction({ request, response, stateRoot: root, runtime, accounts: [account], selectedAccount: account,
        adminView: false, callerAccountId: 'acct', unfinishedDistillationJobsForProject: async () => [], assertManagedMemory: async () => {}, ...options });
      return { status, body: raw ? JSON.parse(raw) : null };
    };
    const flag = { action: 'map-flag-node', project: 'alias', node_id: 'capture', reason: 'wrong', note: 'Check evidence' };
    for (const name of ['map-flag-node', 'map-clear-flag', 'map-link-unmapped']) {
      assert.equal((await action({ ...flag, action: name }, { callerAccountId: 'foreign', adminView: true })).status, 403);
      assert.equal((await action({ ...flag, action: name }, { callerAccountId: undefined })).status, 403);
      assert.equal((await action({ ...flag, action: name, account_id: 'foreign' })).status, 403);
      assert.equal((await action({ ...flag, action: name }, { selectedAccount: { ...account, account_id: 'foreign' } })).status, 403);
      assert.equal((await action({ ...flag, action: name }, { contentType: 'text/plain' })).status, 415);
      assert.equal((await action({ ...flag, action: name, project: '' })).status, 400);
      assert.equal((await action({ ...flag, action: name, project: 'missing' })).status, 404);
    }
    for (const patch of [{ reason: 'other' }, { reason: ['wrong'] }, { note: 'x'.repeat(301) }, { note: 123 }, { node_id: '' }])
      assert.equal((await action({ ...flag, ...patch })).status, 400);
    assert.equal((await action({ ...flag, node_id: 'missing' })).status, 404);
    const saved = await action(flag);
    assert.equal(saved.status, 200);
    const entry = saved.body.node_flags.flags.capture[0];
    assert.equal(entry.by, 'acct');
    assert.equal(entry.id, createHash('sha256').update('capture' + entry.created_at + flag.note).digest('hex').slice(0, 16));
    assert.ok(Number.isFinite(Date.parse(entry.created_at)));
    const key = JSON.stringify(['alpha', 'node_flags']);
    assert.deepEqual((await readMaintenanceStore(root, 'acct')).artifacts[key], saved.body.node_flags);
    assert.equal((await readMaintenanceStore(root, 'foreign')).artifacts?.[key], undefined);
    const built = await buildProjectModel(runtime, { stateRoot: root, projectId: 'alpha', l2: model.l2, todos: [], as_of: '2026-10-27T00:00:00Z', includeArchitectureDocs: true });
    assert.deepEqual(built.node_flags, saved.body.node_flags);
    assert.equal(built.architecture_docs[0].path, 'project-repo/ARCHITECTURE.md');
    assert.equal(projectMemoryVisualization(built).quality.gaps.filter(g => g.kind === 'user_flag').length, 1);
    const clear = { action: 'map-clear-flag', project: 'alpha', node_id: 'capture', flag_id: entry.id };
    assert.equal((await action({ ...clear, flag_id: '' })).status, 400);
    assert.equal((await action({ ...clear, flag_id: 'missing' })).status, 404);
    assert.equal((await action({ ...clear, node_id: 'missing' })).status, 404);
    const cleared = await action(clear);
    assert.equal(cleared.status, 200);
    assert.ok(cleared.body.node_flags.flags.capture[0].cleared_at);
    assert.deepEqual((await action(clear)).body.node_flags, cleared.body.node_flags);
    assert.equal(cleared.body.node_flags.flags.capture.length, 1);
    for (const reason of ['unclear', 'outdated', 'missing_part']) assert.equal((await action({ ...flag, reason, note: 'x'.repeat(300) })).status, 200);
    const linked = await action({ action: 'map-link-unmapped', project: 'alias' });
    assert.equal(linked.status, 200);
    assert.ok(linked.body.open_arch_link_count > 0);
    const store = await readMaintenanceStore(root, 'acct');
    assert.equal(linked.body.open_arch_link_count, store.cards.filter(c => c.kind === 'arch_link' && ['pending', 'leased'].includes(c.status)).length);
    assert.equal((await action({ action: 'map-link-unmapped', project: 'alpha' })).body.open_arch_link_count, linked.body.open_arch_link_count);
    assert.ok((await readMaintenanceStore(root, 'acct')).generation.alpha, 'generation marker set after link');
    assert.equal((await action({ ...flag, note: 'regenerate' })).status, 200);
    assert.equal((await readMaintenanceStore(root, 'acct')).generation.alpha, undefined, 'flag write clears the generation marker');
    assert.equal(modelCalls, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('shell activity uses capture index, project aliases and pending/leased L2 job metadata', async () => {
  const root = await createTestRoot('map-activity-');
  try {
    for (const [id, project, date, complete] of [['old', 'alpha', '2026-10-01', true], ['alias', 'old-alpha', '2026-10-05', true],
      ['foreign', 'other', '2026-10-20', true], ['incomplete', 'alpha', '2026-10-25', false]]) {
      await storeCaptureEvent(root, { account_id: 'acct', actor_id: 'test' }, { event_id: id, host: "test", conversation_id: 'test', project_hint: project,
        timestamp: date + 'T00:00:00Z', user_text: 'User', assistant_text: complete ? 'Assistant' : '', capture_status: complete ? 'complete' : 'partial' });
    }
    // Remove all payloads: the model must still build from the metadata index.
    const { readdir } = await import('node:fs/promises');
    const removePayloads = async path => { for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name); if (entry.isDirectory()) await removePayloads(child); else if (entry.name.endsWith('.json')) await rm(child);
    } };
    await removePayloads(join(root, 'captures'));
    const evidence = [{ ref: 'l1:one', kind: 'turn', timestamp: '2026-10-01T00:00:00Z' }, { ref: 'l1:two', kind: 'turn', timestamp: '2026-10-01T00:00:00Z' }];
    const jobs = [completedJob({ job_id: 'pending', status: 'pending', created_at: '2026-10-02T00:00:00Z', evidence }),
      completedJob({ job_id: 'leased', project_id: 'old-alpha', status: 'leased', created_at: '2026-10-03T00:00:00Z', evidence }),
      completedJob({ job_id: 'foreign', status: 'pending', project_id: 'other' }), completedJob({ job_id: 'l3', status: 'pending', target: 'l3' })];
    await mkdir(join(root, 'distillation'));
    await writeFile(join(root, 'distillation/jobs.json'), JSON.stringify({ version: 2, jobs }));
    const model = await buildProjectModel({ accountId: 'acct', projects: { storageIds: async () => ['alpha', 'old-alpha'] },
      architecture: { inspectProjectCognitiveMap: async () => ({ map: null, fingerprint: null }) } },
      { stateRoot: root, projectId: 'alpha', l2: [], todos: [], as_of: '2026-10-27T00:00:00Z', includeArchitectureDocs: true });
    assert.equal(model.as_of, '2026-10-27T00:00:00Z');
    assert.deepEqual(model.activity, { latest_l1_at: '2026-10-05T00:00:00.000Z', pending_l2_jobs: 2, pending_l2_turns: 2, oldest_pending_at: '2026-10-02T00:00:00Z' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
