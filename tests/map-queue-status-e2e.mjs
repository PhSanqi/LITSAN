import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { readMemoryControlData } from '../dist/memory-control-plane.js';
import { JsonProjectRegistry } from '../dist/project-registry.js';
import { JsonProjectBranchStore } from '../dist/branch-store.js';
import { mutateBranchDraft } from '../dist/branch-drafts.js';
import { recordCompletedDistillationRevision } from '../dist/distillation-jobs.js';
import { createTestRoot } from './test-isolation.mjs';

test('map queue status: scoped counts, requested_at, aliases, isolation and read-only page views', async () => {
  const root = await createTestRoot('map-queue-status-');
  try {
    const projects = new JsonProjectRegistry(join(root, 'projects.json'));
    await projects.create('acct', { projectId: 'alpha', name: 'Alpha', description: 'Test', aliases: ['old-alpha'] });
    await projects.create('acct', { projectId: 'merged-alpha', name: 'Merged Alpha', description: 'Test', aliases: ['legacy-alpha'] });
    await projects.merge('acct', 'merged-alpha', 'alpha');
    const runtime = { accountId: 'acct', userId: 'user', projects,
      architecture: { async inspectProjectCognitiveMap() { return { map: null, fingerprint: null }; } },
      memoryClient: { async viewerGet() { return { items: [], hasNext: false }; } } };
    const request = { stateRoot: root, runtime, kind: 'visualization', projectId: 'alpha', projects: await projects.list('acct') };
    const view = () => readMemoryControlData(request);
    assert.equal('maintenance_status' in await view(), false, 'absent store omits status');
    await assert.rejects(readFile(join(root, 'maintenance/cards.json')), { code: 'ENOENT' });
    await mkdir(join(root, 'maintenance'));
    const card = (id, status, patch = {}) => ({ card_id: id, kind: 'arch_link', account_id: 'acct', project_id: 'alpha', status,
      created_at: '2026-10-20T00:00:00Z', updated_at: '2026-10-26T00:00:00Z', ...patch });
    const cards = [
      card('pending', 'pending', { requested_at: '2026-10-22T00:00:00Z' }),
      card('alias', 'pending', { kind: 'gap_check', project_id: 'old-alpha', created_at: '2026-10-19T00:00:00Z' }),
      card('leased', 'leased', { kind: 'arch_review', requested_at: '2026-10-23T00:00:00Z', created_at: '2026-10-01T00:00:00Z' }),
      card('merged-storage', 'leased', { project_id: 'merged-alpha' }),
      card('merged-alias', 'pending', { project_id: 'legacy-alpha' }),
      card('legacy-request', 'pending', { kind: 'arch_review', requested_by: 'user', input: { user_flags: ['wrong'] } }),
      card('accepted-old', 'accepted', { accepted_at: '2026-10-24T00:00:00Z' }),
      card('accepted-alias', 'accepted', { project_id: 'old-alpha', accepted_at: '2026-10-25T00:00:00Z', requested_at: '2026-10-20T00:00:00Z' }),
      card('rejected', 'rejected', { requested_at: '2026-10-20T00:00:00Z' }),
      card('superseded', 'superseded', { requested_at: '2026-10-20T00:00:00Z' }),
      card('other-project', 'pending', { project_id: 'beta', requested_at: '2026-10-20T00:00:00Z' }),
      card('foreign-account', 'pending', { account_id: 'foreign', requested_at: '2026-10-20T00:00:00Z' }),
      card('foreign-accepted', 'accepted', { account_id: 'foreign', accepted_at: '2026-10-27T00:00:00Z' })
    ];
    const path = join(root, 'maintenance/cards.json');
    await writeFile(path, JSON.stringify({ version: 1, cards, sets: [] }));
    const before = await readFile(path, 'utf8');
    const expected = { pending: 4, leased: 2, requested: 2, by_kind: { arch_link: 3, gap_check: 1, arch_review: 2 },
      oldest_pending_at: '2026-10-19T00:00:00Z', last_accepted_at: '2026-10-25T00:00:00Z' };
    assert.deepEqual((await view()).maintenance_status, expected);
    // The HTTP boundary resolves an alias to the canonical id before requesting a view.
    request.projectId = await projects.resolve('acct', 'old-alpha');
    assert.equal(request.projectId, 'alpha');
    assert.deepEqual((await view()).maintenance_status, expected);
    assert.equal(await readFile(path, 'utf8'), before, 'page views leave every card byte unchanged');
    assert.equal(JSON.parse(await readFile(path, 'utf8')).cards.length, cards.length);
    request.runtime = { ...runtime, accountId: 'empty-account' };
    assert.deepEqual((await view()).maintenance_status, { pending: 0, leased: 0, requested: 0, by_kind: {}, oldest_pending_at: null, last_accepted_at: null });
    request.projectId = undefined;
    assert.equal('maintenance_status' in await view(), false, 'no selected project omits status');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('timeline exposes only the selected account and project branch records without changing them', async () => {
  const root = await createTestRoot('timeline-branches-');
  try {
    const projects = new JsonProjectRegistry(join(root, 'projects.json'));
    await projects.create('acct', { projectId: 'alpha', name: 'Alpha', description: 'Test' });
    const branches = new JsonProjectBranchStore(join(root, 'project-branches.json'));
    const evidence = [{ ref: 'l1:one', kind: 'turn', layer: 'L1', timestamp: '2026-10-01T00:00:00Z', project_id: 'alpha', user_text: 'u', assistant_text: 'a' }];
    const revision = await recordCompletedDistillationRevision({ stateRoot: root, accountId: 'acct', target: 'l2', projectId: 'alpha', resultId: 'timeline',
      content: '# Timeline\n\n## 2026-10-01: Base\nStarted.', committedAt: '2026-10-01T00:00:00Z', evidence });
    const ref = `l2:timeline:${revision.job_id}`;
    const branch = await branches.create('acct', 'alpha', { name: 'Review', goal: 'Verify change', base_map_fingerprint: 'fp', base_l2_revision: ref });
    await branches.create('other', 'alpha', { name: 'Foreign', goal: 'Other account' });
    await branches.create('acct', 'beta', { name: 'Other project', goal: 'Other project' });
    await mutateBranchDraft(root, 'acct', 'alpha', branch.branchId, async draft => {
      draft.status = 'merged'; draft.merged_at = '2026-10-02T00:00:00Z'; draft.merge_job_id = revision.job_id;
      draft.events.push({ event: { date: '2026-10-01', title_en: 'Test change', title_zh: '测试变更', body_en: 'Verify the fix.', body_zh: '验证修复。', evidence_refs: ['l1:one'] }, job_id: revision.job_id, appended_at: '2026-10-01T01:00:00Z' });
    });
    await branches.transition('acct', 'alpha', branch.branchId, { status: 'merged', merged_at: '2026-10-02T00:00:00Z', merge_job_id: revision.job_id });
    const branchFile = join(root, 'project-branches.json'), before = await readFile(branchFile, 'utf8');
    const runtime = { accountId: 'acct', userId: 'user', projects, branches,
      architecture: { async inspectProjectCognitiveMap() { return { map: null, fingerprint: null }; } },
      memoryClient: { async viewerGet() { return { items: [], hasNext: false }; } } };
    const view = await readMemoryControlData({ stateRoot: root, runtime, kind: 'visualization', projectId: 'alpha', projects: await projects.list('acct') });
    assert.equal(view.state.branches.length, 1);
    assert.equal(view.state.branches[0].base_l2_revision, ref);
    assert.equal(view.state.branches[0].merge_revision_ref, ref);
    assert.equal(view.state.branches[0].events[0].merged, true);
    assert.match(view.state.branches[0].events[0].summary, /验证修复/);
    assert.deepEqual(view.state.branches[0].events[0].evidence_refs, ['l1:one']);
    assert.equal(await readFile(branchFile, 'utf8'), before);
  } finally { await rm(root, { recursive: true, force: true }); }
});
