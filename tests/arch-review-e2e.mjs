import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { FileProjectArchitectureSource } from '../dist/architecture-source.js';
import { JsonProjectRegistry } from '../dist/project-registry.js';
import { registerProjectsTools } from '../dist/shell/mcp/register-projects.js';
import { registerCardTools } from '../dist/shell/mcp/register-card.js';
import { inlineJsonResult } from '../dist/shell/mcp/shared.js';
import { readMaintenanceStore, withMaintenanceStore } from '../dist/maintenance-store.js';
import { recordCompletedDistillationRevision } from '../dist/distillation-jobs.js';
import { readMemoryControlData } from '../dist/memory-control-plane.js';
import { aggregateArchReviews } from '../dist/core/maintenance/arch-review.js';
import { createTestRoot } from './test-isolation.mjs';

test('arch review MCP bootstrap, worker next/submit, immediate round-2 regeneration, artifacts, fences and quality', async () => {
  const root = await createTestRoot('arch-review-e2e-');
  const server = new McpServer({ name: 'arch-review-test', version: '1' });
  const client = new Client({ name: 'arch-review-worker', version: '1' });
  try {
    const projectDir = join(root, 'repos', 'alpha');
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, 'ARCHITECTURE.md'), '# Alpha\nAlpha owns Capture and Dashboard.\n\n# Capture\nCapture validates and persists input.\n\n# Dashboard\nDashboard displays memory state.');
    const architecture = new FileProjectArchitectureSource({ rootDir: join(root, 'repos'), managedRootDir: join(root, 'managed') });
    const projects = new JsonProjectRegistry(join(root, 'projects.json'));
    await projects.create('acct', { projectId: 'alpha', name: 'Alpha', description: 'Review fixture', aliases: ['alpha-alias'] });
    await projects.create('acct', { projectId: 'other', name: 'Other', description: 'Other project' });
    let content = '# Timeline\n\n## 2026-10-25: Capture validation\n\nCapture validates and persists input.';
    const seedRevision = committedAt => recordCompletedDistillationRevision({ stateRoot: root, accountId: 'acct', target: 'l2', projectId: 'alpha',
      resultId: 'timeline-alpha', content, committedAt,
      evidence: [{ ref: 'l1:input', kind: 'turn', layer: 'L1', timestamp: committedAt, project_id: 'alpha', user_text: 'Capture', assistant_text: 'Validation' }] });
    await seedRevision('2026-10-25T00:00:00Z');
    const runtime = { accountId: 'acct', userId: 'user-acct', source: { platform: 'review-harness', transport: 'test' }, architecture, projects,
      memoryClient: { async viewerGet(path) {
        const url = new URL(path, 'http://test.invalid');
        assert.equal(url.pathname, '/api/v1/l2');
        return { items: url.searchParams.get('projectId') === 'alpha' ? [{ id: 'timeline-alpha', projectId: 'alpha', body: content, status: 'activated' }] : [], hasNext: false };
      } } };
    const context = { stateRoot: root, jsonResult: inlineJsonResult, inlineJsonResult };
    registerProjectsTools(server, { runtime, context });
    registerCardTools(server, { runtime, context });
    const [ct, st] = InMemoryTransport.createLinkedPair(); await server.connect(st); await client.connect(ct);
    const call = async (name, args) => {
      const response = await client.callTool({ name, arguments: args });
      assert.ok(!response.isError, JSON.stringify(response));
      return JSON.parse(response.content[0].text);
    };
    const project = (action, args = {}) => call('litsan_project', { action, project: 'alpha', ...args });
    const profile = { execution: 'background', max_card_tokens: 8000, model: 'review-model-1' };
    const queue = (action, args = {}) => call('litsan_card', { action, project: 'alpha', client_profile: profile, ...args });
    const store = () => readMaintenanceStore(root, 'acct');
    const reviewCards = async () => (await store()).cards.filter(c => c.kind === 'arch_review');
    const artifacts = async key => (await store()).artifacts[JSON.stringify(['alpha', key])];
    const lease = async id => (await queue('next', { card_id: id })).card;
    const answer = (card, faithfulness = 4, clarity = 4) => ({ faithfulness, clarity, cited_refs: card.allowed_refs.slice(0, 1), issues: [] });
    const submit = (card, value, args = {}) => queue('submit', { card_id: card.card_id, lease_token: card.lease_token, answer: value, ...args });
    assert.equal((await project('map_quality')).judged, null);
    const pkg = await project('map_bootstrap_next');
    const docRef = pkg.architecture_sources[0].ref, l2Ref = pkg.l2_events[0].evidence_ref;
    const candidate = { nodes: [
      { id: 'alpha', kind: 'project', label: 'Alpha', summary: 'Alpha project', parent_id: null, evidence_refs: [docRef], confidence: 1 },
      { id: 'capture', kind: 'domain', label: 'Capture', summary: 'Capture validates and persists input', parent_id: 'alpha', evidence_refs: [docRef, l2Ref], confidence: 0.9 },
      { id: 'dashboard', kind: 'capability', label: 'Dashboard', summary: 'Displays memory state', parent_id: 'alpha', evidence_refs: [docRef], confidence: 0.9 }
    ], edges: [{ from: 'alpha', to: 'capture', type: 'contains', evidence_refs: [docRef], confidence: 1 }], timeline_links: [
      { event_date: pkg.l2_events[0].date, event_title: pkg.l2_events[0].title, architecture_refs: ['capture'], architecture_level: 'domain',
        change_kind: 'refine', evidence_refs: [l2Ref], confidence: 0.9 }
    ] };
    assert.equal((await project('map_bootstrap_submit', { base_fingerprint: pkg.base_fingerprint, architecture_map: candidate })).ok, true);
    await queue('queue_status');
    let reviews = await reviewCards();
    assert.equal(reviews.length, 3);
    const captureDraft = reviews.find(c => c.input.node_id === 'capture');
    assert.ok(captureDraft.input.evidence.some(e => e.ref === docRef));
    assert.ok(captureDraft.input.evidence.some(e => e.ref === l2Ref));
    assert.ok(captureDraft.est_tokens <= 8000);
    let card = await lease(captureDraft.card_id);
    assert.equal(card.kind, 'arch_review');
    assert.equal((await submit(card, { ...answer(card), cited_refs: ['l2:foreign:revision'] })).code, 'ref_not_allowed');
    card = await lease(captureDraft.card_id);
    assert.equal((await submit(card, answer(card, 1, 2), { client_profile: { execution: 'inline', model: 'replacement' } })).ok, true);
    const index = await artifacts('arch_review:index');
    assert.equal(index.nodes.capture.rounds.length, 1);
    assert.deepEqual([index.nodes.capture.rounds[0].harness, index.nodes.capture.rounds[0].model, index.nodes.capture.rounds[0].profile],
      ['review-harness', 'review-model-1', 'background']);
    assert.equal((await artifacts('arch_review:summary')).map_score, null);
    assert.equal((await artifacts('arch_review:summary')).map_score_unverified, 30);
    await queue('next');
    reviews = await reviewCards();
    const second = reviews.filter(c => c.input.node_id === 'capture' && c.input.review_round === 2);
    assert.equal(second.length, 1); assert.deepEqual(second[0].input.exclude_reviewer_models, ['review-model-1']);
    card = await lease(second[0].card_id);
    assert.equal((await submit(card, answer(card, 5, 5))).ok, true);
    assert.equal((await artifacts('arch_review:index')).nodes.capture.rounds[1].independence, 'unverified');
    content += '\n\n## 2026-10-27: Capture unchanged\n\nCapture validation remains active.';
    await seedRevision('2026-10-27T00:00:00Z');
    await queue('queue_status');
    assert.equal((await reviewCards()).filter(c => c.input.node_id === 'capture').length, 2);
    const quality = await project('map_quality', { project: 'alpha-alias' });
    assert.deepEqual(quality.judged, await artifacts('arch_review:summary'));
    assert.equal(quality.judged.nodes.capture.disputed, true);
    const visual = await readMemoryControlData({ stateRoot: root, runtime, kind: 'visualization', projectId: 'alpha', projects: await projects.list('acct') });
    assert.deepEqual(quality.quality, visual.quality);
    assert.equal((await project('map_quality', { project: 'other' })).judged, null);
    assert.deepEqual((await readMaintenanceStore(root, 'foreign-account')).artifacts, {});
    const rebuildMap = async () => {
      const rebuild = await project('map_bootstrap_next', { rebuild: true });
      assert.equal((await project('map_bootstrap_submit', { rebuild: true, base_fingerprint: rebuild.base_fingerprint, architecture_map: candidate })).ok, true);
      await queue('queue_status');
    };
    const realCapture = c => c.input.node_id === 'capture' && c.input.node.label === candidate.nodes[1].label &&
      c.input.node.summary === candidate.nodes[1].summary && !c.input.relations.some(r => r.type === 'depends_on');
    card = await lease(reviews.find(c => c.input.node_id === 'dashboard').card_id);
    candidate.nodes[2].summary = 'Dashboard displays the current project memory state';
    await rebuildMap();
    assert.equal((await submit(card, answer(card))).code, 'stale_fingerprint');
    await queue('queue_status');
    assert.equal((await reviewCards()).find(c => c.card_id === card.card_id).status, 'superseded');
    const captureReview = (await artifacts('arch_review:index')).nodes.capture;
    candidate.nodes.push({ id: 'unrelated', kind: 'domain', label: 'Unrelated', summary: 'Independent node', parent_id: 'alpha', evidence_refs: [docRef], confidence: 0.9 });
    await rebuildMap();
    assert.deepEqual((await artifacts('arch_review:index')).nodes.capture, captureReview);
    assert.equal(aggregateArchReviews(await artifacts('arch_review:index'), candidate).nodes.capture.disputed, true);
    assert.equal((await reviewCards()).filter(realCapture).length, 2);
    candidate.nodes[1].summary = 'Capture validates input before persisting it';
    await rebuildMap();
    assert.equal(aggregateArchReviews(await artifacts('arch_review:index'), candidate).nodes.capture, undefined);
    const staleSummary = await artifacts('arch_review:summary');
    assert.ok(staleSummary.nodes.capture);
    const refreshedQuality = await project('map_quality');
    assert.equal(refreshedQuality.judged.nodes.capture, undefined);
    assert.equal(refreshedQuality.judged.n, 0);
    assert.deepEqual(await artifacts('arch_review:summary'), staleSummary, 'quality reads do not mutate review history');
    const changedCapture = (await reviewCards()).filter(c => realCapture(c) && c.status === 'pending');
    assert.equal(changedCapture.length, 1);
    assert.equal(changedCapture[0].input.review_round, 1);
    assert.notEqual(changedCapture[0].key, captureDraft.key);
    const flagReview = async id => withMaintenanceStore(root, 'acct', Date.now(), async value => {
      value.artifacts[JSON.stringify(['alpha', 'node_flags'])] = { version: 1, flags: { capture: [{
        id, reason: 'outdated', note: 'Recheck current evidence', created_at: new Date().toISOString(), by: 'acct'
      }] } };
      for (const key of Object.keys(value.generation)) delete value.generation[key];
    });
    for (const leased of [false, true]) {
      const prefix = leased ? 'leased' : 'pending';
      await flagReview(prefix + '-first'); await queue('queue_status');
      const first = (await reviewCards()).find(c => c.status === 'pending' && c.key.endsWith(':r1:f' + prefix + '-first'));
      const firstCard = await lease(first.card_id);
      assert.equal((await submit(firstCard, answer(firstCard, 1, 2))).ok, true);
      await queue('queue_status');
      const old = (await reviewCards()).find(c => c.status === 'pending' && c.key.endsWith(':r2:f' + prefix + '-first'));
      const oldCard = leased ? await lease(old.card_id) : null;
      await flagReview(prefix + '-replacement');
      if (oldCard) assert.equal((await submit(oldCard, answer(oldCard))).code, 'stale_fingerprint');
      await queue('queue_status');
      assert.equal((await reviewCards()).find(c => c.card_id === old.card_id).status, 'superseded');
      await assert.rejects(queue('next', { card_id: old.card_id }), /card unavailable for account/);
      const replacement = (await reviewCards()).find(c => c.status === 'pending' && c.key.endsWith(':r1:f' + prefix + '-replacement'));
      const replacementCard = await lease(replacement.card_id);
      assert.equal((await submit(replacementCard, answer(replacementCard, 4, 5))).ok, true);
      const rounds = (await artifacts('arch_review:index')).nodes.capture.rounds;
      assert.equal(rounds.length, 1); assert.equal(rounds[0].faithfulness, 4);
    }
  } finally {
    await client.close(); await server.close(); await rm(root, { recursive: true, force: true });
  }
});

test('MCP reviewers that miss controls stay unverified while catching controls unlocks calibrated scores', async () => {
  const root = await createTestRoot('arch-review-calibration-e2e-');
  const server = new McpServer({ name: 'calibration-test', version: '1' });
  const client = new Client({ name: 'calibration-worker', version: '1' });
  try {
    const projectDir = join(root, 'repos', 'alpha');
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, 'ARCHITECTURE.md'), '# Alpha\n' + Array.from({ length: 40 }, (_, i) => `Owner ${i} owns responsibility ${i}.`).join('\n'));
    const architecture = new FileProjectArchitectureSource({ rootDir: join(root, 'repos'), managedRootDir: join(root, 'managed') });
    const projects = new JsonProjectRegistry(join(root, 'projects.json'));
    await projects.create('acct', { projectId: 'alpha', name: 'Alpha', description: 'Calibration fixture' });
    const runtime = { accountId: 'acct', userId: 'user-acct', source: { platform: 'calibration-harness', transport: 'test' },
      architecture, projects, memoryClient: { async viewerGet() { return { items: [], hasNext: false }; } } };
    const context = { stateRoot: root, jsonResult: inlineJsonResult, inlineJsonResult };
    registerProjectsTools(server, { runtime, context }); registerCardTools(server, { runtime, context });
    const [ct, st] = InMemoryTransport.createLinkedPair(); await server.connect(st); await client.connect(ct);
    const call = async (name, args) => {
      const response = await client.callTool({ name, arguments: args });
      assert.ok(!response.isError, JSON.stringify(response)); return JSON.parse(response.content[0].text);
    };
    const project = (action, args = {}) => call('litsan_project', { action, project: 'alpha', ...args });
    let model = 'gpt-6-luna';
    const queue = (action, args = {}) => call('litsan_card', { action, project: 'alpha',
      client_profile: { execution: 'background', max_card_tokens: 8000, model }, ...args });
    const bootstrap = await project('map_bootstrap_next'), ref = bootstrap.architecture_sources[0].ref;
    const candidate = { nodes: [{ id: 'alpha', kind: 'project', label: 'Alpha', summary: 'Alpha project', parent_id: null, evidence_refs: [ref], confidence: 1 },
      ...Array.from({ length: 40 }, (_, i) => ({ id: `owner-${i}`, kind: 'domain', label: `Owner ${i}`,
        summary: `Owns responsibility ${i}`, parent_id: 'alpha', evidence_refs: [ref], confidence: 1 }))], edges: [], timeline_links: [] };
    const install = async pkg => {
      assert.equal((await project('map_bootstrap_submit', { ...(pkg === bootstrap ? {} : { rebuild: true }),
        base_fingerprint: pkg.base_fingerprint, architecture_map: candidate })).ok, true);
      await queue('queue_status');
    };
    const artifact = async key => (await readMaintenanceStore(root, 'acct')).artifacts[JSON.stringify(['alpha', key])];
    const runReviewer = async catches => {
      const cards = (await readMaintenanceStore(root, 'acct')).cards.filter(c => c.kind === 'arch_review' && c.status === 'pending' && c.input.review_round === 1);
      let controls = 0, real = 0;
      for (const draft of cards) {
        const node = candidate.nodes.find(n => n.id === draft.input.node_id);
        const control = draft.input.node.summary !== node.summary || draft.input.node.label !== node.label || draft.input.relations.length > 0;
        if (control) controls++; else real++;
        const card = (await queue('next', { card_id: draft.card_id })).card;
        assert.ok(card, draft.card_id);
        const answer = { faithfulness: control && catches ? 2 : 5, clarity: 5, cited_refs: card.allowed_refs.slice(0, 1), issues: [] };
        assert.equal((await queue('submit', { card_id: card.card_id, lease_token: card.lease_token, answer })).ok, true);
      }
      assert.ok(controls >= 3); assert.ok(real >= 20);
      const index = await artifact('arch_review:index');
      assert.equal(index.canaries[model].seen, controls);
      assert.equal(index.canaries[model].caught, catches ? controls : 0);
      assert.equal(Object.values(index.nodes).reduce((sum, n) => sum + n.rounds.length, 0), real);
      return artifact('arch_review:summary');
    };
    await install(bootstrap);
    let summary = await runReviewer(false);
    assert.equal(summary.map_score, null); assert.equal(summary.map_score_unverified, 100);
    assert.equal(summary.trust, 'unverified');
    assert.equal(summary.calibration.find(c => c.model === model).calibrated, false);
    model = 'claude-sonnet';
    for (const node of candidate.nodes) node.summary += ' Current';
    await install(await project('map_bootstrap_next', { rebuild: true }));
    summary = await runReviewer(true);
    assert.equal(summary.map_score, 100); assert.equal(summary.map_score_unverified, 100);
    assert.equal(summary.calibration.find(c => c.model === model).calibrated, true);
    assert.equal(summary.calibration.find(c => c.model === 'gpt-6-luna').calibrated, false);
    assert.equal(summary.trust, 'unverified'); assert.equal(summary.cross_family_agreement, 0);
    assert.deepEqual(summary.gaps, []);
  } finally {
    await client.close(); await server.close(); await rm(root, { recursive: true, force: true });
  }
});
