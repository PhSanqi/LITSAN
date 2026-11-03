import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveWorkstreamKey } from '../dist/core/workstream/binding.js';
import { pickBranchToEvict } from '../dist/core/workstream/cap.js';
import { buildInFlightBlock } from '../dist/core/workstream/in-flight.js';
import { l1VisibleInBranch } from '../dist/core/workstream/visibility.js';

const branch = (id, overrides = {}) => ({ accountId: 'acct', projectId: 'demo', branchId: id, name: id, goal: 'capture repair',
  status: 'active', origin: 'auto', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
  last_activity_at: '2026-10-02T00:00:00Z', base_map_fingerprint: 'base', ...overrides });

test('binding precedence and default branches fall through without guessing', () => {
  const hints = { git_branch: 'feature/a', worktree: '/repo/a', continuity_id: 'conversation' };
  assert.equal(deriveWorkstreamKey(hints).key, 'git:feature/a');
  for (const git_branch of ['main', 'master', 'trunk']) {
    const hint = { ...hints, git_branch, ...(git_branch === 'trunk' ? { git_default_branch: 'trunk' } : {}) };
    assert.equal(deriveWorkstreamKey(hint).key, 'wt:/repo/a');
    delete hint.worktree;
    assert.match(deriveWorkstreamKey(hint).key, /^cont:[a-f0-9]{16}$/);
    delete hint.continuity_id;
    assert.deepEqual(deriveWorkstreamKey(hint), { key: null, reason: 'default_git_branch' });
  }
  assert.deepEqual(deriveWorkstreamKey(), { key: null, reason: 'no_hint' });
  assert.equal(deriveWorkstreamKey({ git_branch: 'main', git_default_branch: 'trunk' }).key, 'git:main');
  assert.equal(deriveWorkstreamKey({ continuity_id: 'secret-id', label: 'Test' }).display, 'Test');
  assert.match(deriveWorkstreamKey({ continuity_id: 'secret-id' }).display, /^conv-[a-f0-9]{8}$/);
  assert.ok(!deriveWorkstreamKey({ continuity_id: 'secret-id' }).key.includes('secret-id'));
});

test('Windows and POSIX worktree separators normalize to identical keys', () => {
  assert.equal(deriveWorkstreamKey({ worktree: ' C:\\repo\\linked\\ ' }).key, deriveWorkstreamKey({ worktree: 'c:/repo/linked/' }).key);
  assert.equal(deriveWorkstreamKey({ worktree: '/repo/linked///' }).key, 'wt:/repo/linked');
  assert.equal(deriveWorkstreamKey({ worktree: '/repo/linked/' }).display, 'linked');
});

test('cap excludes manual and closed branches and breaks ties deterministically', () => {
  const auto = Array.from({ length: 8 }, (_, i) => branch(`b${i}`));
  assert.equal(pickBranchToEvict(auto.slice(0, 7)), null);
  assert.equal(pickBranchToEvict([...auto].reverse()).branchId, 'b0');
  auto[3].last_activity_at = '2026-09-01';
  assert.equal(pickBranchToEvict(auto).branchId, 'b3');
  assert.equal(pickBranchToEvict([...auto.slice(0, 7), branch('manual', { origin: 'manual' }), branch('old', { status: 'closed' })]), null);
  assert.equal(pickBranchToEvict([branch('b'), branch('a', { createdAt: '2026-09-01' })], 2).branchId, 'a');
});

test('in-flight is deterministic, bounded, excludes current/closed, and selects map nodes from metadata', () => {
  const branches = Array.from({ length: 8 }, (_, i) => branch(`branch-${i}`, { name: 'capture', goal: 'repair '.repeat(80),
    last_activity_at: `2026-10-0${i + 1}` }));
  const input = { branches: [...branches, branch('closed', { status: 'closed' })], currentBranchId: 'branch-7',
    map: { nodes: [{ id: 'capture', kind: 'project', label: 'capture', summary: 'repair', parent_id: null, order: 0 }], edges: [] },
    currentMapFingerprint: 'changed', now: '2026-10-27' };
  const result = buildInFlightBlock(input);
  assert.deepEqual(result, buildInFlightBlock({ ...input, branches: [...input.branches].reverse() }));
  assert.ok(result.branches.length > 0 && result.branches.length <= 5);
  assert.equal(result.omitted, 7 - result.branches.length);
  assert.ok(JSON.stringify(result).length <= 1500);
  for (const entry of result.branches) {
    assert.ok(JSON.stringify(entry).length <= 300);
    assert.ok(entry.goal.length <= 160);
    assert.notEqual(entry.branch_id, input.currentBranchId);
    assert.deepEqual(entry.likely_nodes, ['capture']);
    assert.equal(entry.base_stale, true);
  }
  assert.equal(buildInFlightBlock({ ...input, currentMapFingerprint: 'base' }).branches[0].base_stale, false);
});

test('L1 main sees all; branch views see only their effective assignment', () => {
  for (const effective of ['main', 'A', 'B']) assert.equal(l1VisibleInBranch(effective, 'main'), true);
  assert.equal(l1VisibleInBranch('A', 'A'), true);
  assert.equal(l1VisibleInBranch('B', 'A'), false);
  assert.equal(l1VisibleInBranch('main', 'A'), false);
});

test('detached HEAD falls through to worktree, continuity, then no hint', () => {
  assert.equal(deriveWorkstreamKey({ git_branch: ' HEAD ', worktree: 'C:\\repo\\linked', continuity_id: 'c' }).key, 'wt:c:/repo/linked');
  assert.equal(deriveWorkstreamKey({ git_branch: 'HEAD', continuity_id: 'c' }).key, deriveWorkstreamKey({ continuity_id: 'c' }).key);
  assert.deepEqual(deriveWorkstreamKey({ git_branch: 'HEAD' }), { key: null, reason: 'no_hint' });
  assert.deepEqual(deriveWorkstreamKey({ git_branch: 'HEAD', git_default_branch: 'HEAD' }), { key: null, reason: 'no_hint' });
});
