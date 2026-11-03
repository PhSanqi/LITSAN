import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { archReviewGenerator as g, aggregateArchReviews, registerArchReview } from '../dist/core/maintenance/arch-review.js';
import { maintenanceGenerators, registerMaintenanceGenerator, structureFingerprint, nodeEvidenceHash } from '../dist/core/maintenance/registry.js';
import { cardEstTokens } from '../dist/core/maintenance/estimate.js';

const now = Date.parse('2026-10-27T00:00:00Z');
const hash = text => createHash('sha256').update(text).digest('hex');
function context(counts = [8, 6, 4, 2]) {
  const nodes = [{ id: 'root', kind: 'project', label: 'Project', summary: 'Project architecture', parent_id: null, order: 0, confidence: 1, evidence_refs: [] }];
  for (const [i, count] of counts.entries()) for (let n = 0; n < count; n++) nodes.push({
    id: `n${i}-${String(n).padStart(2, '0')}`, kind: ['domain', 'capability', 'process', 'method'][i], label: 'Capture', summary: 'Capture validation pipeline',
    parent_id: 'root', order: n, confidence: 1, evidence_refs: ['architecture-doc:doc']
  });
  const map = { schema_version: 1, contract: 'memhub-architecture-cognitive-map-v1', project_id: 'p', authority: 'derived', abstraction_cutoff: 'method',
    generated_at: new Date(now).toISOString(), source_evidence_refs: ['architecture-doc:doc'], nodes, edges: [], timeline_links: [] };
  return { accountId: 'a', projectId: 'p', map, jobs: [], gaps: [], events: [], artifacts: { get: () => undefined },
    architectureSources: [{ ref: 'architecture-doc:doc', path: 'doc.md', content: '# Other\nUnrelated facts.\n# Capture\nCapture validation pipeline.' }] };
}
const drafts = ctx => g.ensure(ctx, now);
const cardFor = draft => ({ ...draft, card_id: 'c', instructions: g.instructions, answer_schema: g.answerSchema,
  est_tokens: cardEstTokens({ ...draft, instructions: g.instructions }), status: 'leased', attempts: 1, rejections: 0, created_at: '', updated_at: '' });
const valid = (card, faithfulness = 4, clarity = 4) => ({ faithfulness, clarity, cited_refs: card.allowed_refs.slice(0, 1), issues: [] });
test('new review issues require both English and Chinese', () => {
  const card = cardFor(drafts(context([1, 0, 0, 0])).find(draft => draft.allowed_refs.length));
  assert.equal(g.validate(card, { ...valid(card), issues: ['EN: unclear ZH: 不清晰'] }).ok, true);
  assert.equal(g.validate(card, { ...valid(card), issues: ['EN: unclear'] }).code, 'bilingual_missing');
});
function portsFor(ctx) {
  const artifacts = new Map();
  return { artifacts, ports: { map: { read: async () => ({ map: ctx.map }) },
    artifacts: { read: async key => structuredClone(artifacts.get(key)), write: async (key, value) => artifacts.set(key, structuredClone(value)) } } };
}
async function record(ctx, nodeId, scores = [4, 4], state = portsFor(ctx), extra = {}) {
  const draft = drafts({ ...ctx, artifacts: { get: key => state.artifacts.get(key) } }).find(d => d.input.node_id === nodeId);
  assert.ok(draft, nodeId);
  const card = cardFor(draft), answer = { ...valid(card, ...scores), ...extra };
  assert.equal(g.validate(card, answer).ok, true);
  assert.deepEqual(await g.apply(card, answer, state.ports, { harness: 'test', model: 'm1', profile: 'background' }, now), { ok: true });
  return { ...state, card };
}

test('arch review selection is deterministic, bounded, stratified and fixed after completion', async () => {
  const ctx = context([40, 20, 10, 1]);
  ctx.gaps = ctx.map.nodes.slice(1, 26).map(n => ({ kind: 'node_without_evidence', ref: n.id }));
  const before = JSON.stringify(ctx), first = drafts(ctx).filter(d => !isControl(ctx, d));
  assert.equal(first.filter(d => d.input.selection === 'risk').length, 15);
  assert.equal(first.filter(d => d.input.in_sample).length, 20);
  assert.equal(first.length <= 35, true);
  assert.equal(new Set(first.filter(d => d.input.in_sample).map(d => d.input.stratum)).size, 4);
  assert.ok(!first.find(d => d.input.node_id === 'root')?.input.in_sample);
  assert.deepEqual(drafts(ctx).filter(d => !isControl(ctx, d)), first); assert.equal(JSON.stringify(ctx), before);
  const reordered = { ...ctx, map: { ...ctx.map, nodes: [...ctx.map.nodes].reverse() }, gaps: [...ctx.gaps].reverse() };
  assert.deepEqual(drafts(reordered).filter(d => !isControl(reordered, d)), first);
  const state = portsFor(ctx);
  for (const draft of first) {
    const card = cardFor(draft);
    await g.apply(card, valid(card, card.allowed_refs.length ? 4 : 2), state.ports, { harness: 'h', profile: 'inline' }, now);
  }
  const remaining = drafts({ ...ctx, artifacts: { get: key => state.artifacts.get(key) } }).filter(d => !isControl(ctx, d));
  assert.ok(remaining.every(d => d.input.review_round === 2 && d.input.node_id === 'root'));
  assert.equal(drafts({ ...ctx, map: null }).length, 0);
});

test('arch review proportional allocation and hash ordering without risk overfill', () => {
  const ctx = context([40, 20, 10, 1]), result = drafts(ctx).filter(d => !isControl(ctx, d) && d.input.in_sample);
  const counts = Object.fromEntries(['domain', 'capability', 'process', 'method'].map(kind => [kind, result.filter(d => d.input.stratum === kind).length]));
  assert.deepEqual(counts, { domain: 11, capability: 5, process: 3, method: 1 });
  for (const [kind, quota] of Object.entries(counts)) {
    const expected = ctx.map.nodes.filter(n => n.kind === kind)
      .sort((a, b) => hash(ctx.projectId + ':' + a.id).localeCompare(hash(ctx.projectId + ':' + b.id)))
      .slice(0, quota).map(n => n.id).sort();
    assert.deepEqual(result.filter(d => d.input.stratum === kind).map(d => d.input.node_id).sort(), expected);
  }
  const sampleIds = c => drafts(c).filter(d => !isControl(c, d) && d.input.in_sample).map(d => d.input.node_id).sort();
  const baseline = sampleIds(ctx);
  ctx.gaps = ctx.map.nodes.slice(10, 35).map(n => ({ kind: 'low_confidence_node', ref: n.id }));
  assert.deepEqual(sampleIds(ctx), baseline);
  ctx.map.nodes[1].summary += ' changed';
  ctx.map.nodes[2].label += ' changed';
  assert.deepEqual(sampleIds(ctx), baseline);
  assert.notDeepEqual(sampleIds({ ...ctx, projectId: 'another-project' }), baseline);
});

test('arch review skips unresolved evidence but reviews genuinely evidence-free nodes', () => {
  const ctx = context([4, 0, 0, 0]);
  ctx.map.nodes[1].evidence_refs = ['architecture-doc:missing'];
  ctx.map.nodes[2].evidence_refs = ['l2:missing'];
  ctx.map.nodes[3].evidence_refs = [];
  ctx.architectureSources.push({ ref: 'architecture-doc:blank', content: '   ' });
  ctx.map.nodes[4].evidence_refs = ['architecture-doc:blank', 'l1:unavailable'];
  const result = drafts(ctx);
  assert.deepEqual(result.map(d => d.input.node_id).sort(), ['n0-02', 'root']);
  const card = cardFor(result.find(d => d.input.node_id === 'n0-02'));
  assert.deepEqual(card.allowed_refs, []);
  assert.equal(g.validate(card, valid(card, 2)).ok, true);
  assert.equal(g.validate(card, valid(card, 3)).code, 'schema_invalid');
});

test('arch review identity survives unrelated changes and invalidates only node content evidence or relations', async () => {
  const ctx = context([2, 0, 0, 0]), state = await record(ctx, 'n0-00');
  const index = state.artifacts.get('arch_review:index'), node = ctx.map.nodes[1];
  const updated = { ...ctx, artifacts: { get: key => state.artifacts.get(key) } };
  const originalMap = structuredClone(ctx.map), sfp = structureFingerprint(ctx.map);
  const expected = hash(JSON.stringify({ id: node.id, kind: node.kind, label: node.label, summary: node.summary, parent_id: node.parent_id }) + nodeEvidenceHash(node) + '[]').slice(0, 32);
  assert.equal(index.nodes[node.id].review_fp, expected);
  ctx.map.nodes.push({ ...ctx.map.nodes[2], id: 'unrelated' });
  ctx.map.nodes[2].summary += ' changed';
  ctx.map.edges.push({ from: 'root', to: 'unrelated', type: 'contains' });
  assert.notEqual(structureFingerprint(ctx.map), sfp);
  assert.ok(aggregateArchReviews(index, ctx.map).nodes[node.id]);
  assert.ok(!drafts(updated).some(d => d.input.node_id === node.id && !isControl(updated, d)));
  for (const change of [
    n => n.id += '-new', n => n.kind = 'capability', n => n.label += ' changed',
    n => n.summary += ' changed', n => n.parent_id = 'n0-01', n => n.evidence_refs.push('new')
  ]) {
    ctx.map = structuredClone(originalMap); change(ctx.map.nodes[1]); updated.map = ctx.map;
    assert.ok(!aggregateArchReviews(index, ctx.map).nodes[ctx.map.nodes[1].id]);
    assert.equal(drafts(updated).find(d => d.input.node_id === ctx.map.nodes[1].id).input.review_round, 1);
  }
  ctx.map = structuredClone(originalMap); updated.map = ctx.map;
  ctx.map.edges.push({ from: node.id, to: 'n0-01', type: 'uses' });
  assert.ok(!aggregateArchReviews(index, ctx.map).nodes[node.id]);
  assert.equal(drafts(updated).find(d => d.input.node_id === node.id).input.review_round, 1);
});

test('arch review risk priorities use gaps, newest ten events and impact', () => {
  const ctx = context([30, 0, 0, 0]);
  ctx.gaps = [{ kind: 'low_confidence_node', ref: 'n0-28' }];
  ctx.events = Array.from({ length: 11 }, (_, i) => ({ id: String(i), date: `2026-10-${String(i + 1).padStart(2, '0')}`, order: i,
    architecture_refs: [`n0-${String(i).padStart(2, '0')}`] }));
  const result = drafts(ctx);
  assert.ok(result.find(d => d.input.node_id === 'n0-28').input.risk_reasons.includes('low_confidence_node'));
  assert.ok(result.find(d => d.input.node_id === 'n0-10').input.risk_reasons.includes('recent_event'));
  assert.ok(!result.find(d => d.input.node_id === 'n0-00')?.input.risk_reasons.includes('recent_event'));
  assert.ok(result.find(d => d.input.node_id === 'root').input.risk_reasons.includes('high_impact'));
});

test('arch review second round triggers on either low score or contradiction, never third', async () => {
  for (const [scores, issues, expected] of [[[2, 5], [], true], [[5, 2], [], true], [[5, 5], ['contradiction: EN: source differs ZH: 来源不符'], true], [[3, 3], [], false], [[5, 5], ['EN: unclear ZH: 不清晰'], false]]) {
    const ctx = context([1, 0, 0, 0]);
    const state = await record(ctx, 'n0-00', scores, portsFor(ctx), { issues });
    const updated = { ...ctx, artifacts: { get: key => state.artifacts.get(key) } };
    const second = drafts(updated).find(d => d.input.node_id === 'n0-00');
    assert.equal(!!second, expected);
    if (!expected) continue;
    assert.equal(second.input.review_round, 2); assert.deepEqual(second.input.exclude_reviewer_models, ['m1']);
    await record(ctx, 'n0-00', [1, 1], state);
    const entry = state.artifacts.get('arch_review:index').nodes['n0-00'];
    assert.equal(entry.rounds.length, 2); assert.equal(entry.rounds[1].independence, 'unverified');
    assert.equal(drafts(updated).some(d => d.input.node_id === 'n0-00'), false);
  }
});

test('old round two cannot contaminate a flag-triggered replacement first round', async () => {
  for (const scores of [[4, 5], [1, 2]]) {
    const ctx = context([1, 0, 0, 0]), id = 'n0-00';
    const state = await record(ctx, id, [1, 2]);
    const updated = withState(ctx, state);
    const stale = cardFor(drafts(updated).find(d => d.input.node_id === id));
    assert.equal(stale.input.review_round, 2);
    state.artifacts.set('node_flags', { version: 1, flags: { [id]: [flag('replacement')] } });
    const fresh = cardFor(drafts(updated).find(d => d.input.node_id === id));
    await g.apply(fresh, valid(fresh, ...scores), state.ports, { harness: 'h', model: 'new-model', profile: 'background' }, now + 2);
    const before = structuredClone(state.artifacts.get('arch_review:index'));
    const result = await g.apply(stale, valid(stale, 1, 1), state.ports, { harness: 'h', model: 'old-model', profile: 'background' }, now + 3);
    assert.equal(result.code, 'stale_fingerprint');
    assert.deepEqual(state.artifacts.get('arch_review:index'), before);
    assert.notEqual(g.fence(stale, ctx.map, updated.artifacts), stale.fingerprint);
    if (scores[0] === 1) {
      const second = cardFor(drafts(updated).find(d => d.input.node_id === id));
      assert.equal(g.fence(second, ctx.map, updated.artifacts), second.fingerprint);
      assert.deepEqual(second.input.exclude_reviewer_models, ['new-model']);
      assert.equal((await g.apply(second, valid(second), state.ports, { harness: 'h', model: 'other-model', profile: 'background' }, now + 4)).ok, true);
    }
  }
});

test('arch review excerpts match paragraphs, drop missing refs, use canonical dates and bound input', () => {
  const ctx = context([1, 0, 0, 0]), node = ctx.map.nodes[1];
  node.evidence_refs.push('l2:latest', 'l2:first', 'architecture-doc:missing', 'l1:unavailable');
  ctx.events = Array.from({ length: 6 }, (_, i) => ({ id: String(i), title: 'Capture', summary: 'Validation '.repeat(100),
    date: '2026-10-27', link_date: 'canonical-date', order: i, architecture_refs: ['n0-00'], latest_revision_ref: 'l2:latest', first_revision_ref: 'l2:first' }));
  const draft = drafts(ctx).find(d => d.input.node_id === node.id);
  assert.match(draft.input.evidence[0].excerpt, /^# Capture/);
  assert.ok(!draft.allowed_refs.includes('architecture-doc:missing')); assert.ok(!draft.allowed_refs.includes('l1:unavailable'));
  const events = draft.input.evidence.filter(e => e.ref.startsWith('l2:'));
  assert.equal(events.length, 4); assert.ok(events.every(e => e.excerpt.length <= 600 && e.excerpt.startsWith('canonical-date:')));
  assert.ok(draft.input.evidence.reduce((n, e) => n + e.excerpt.length, 0) <= 6000);
  assert.ok(cardFor(draft).est_tokens <= 8000);
  const fallback = drafts({ ...ctx, events: ctx.events.map(e => ({ ...e, architecture_refs: [] })) }).find(d => d.input.node_id === node.id);
  assert.equal(fallback.input.evidence.filter(e => e.ref.startsWith('l2:')).length, 4);
  const preferred = drafts({ ...ctx, events: ctx.events.map((e, i) => ({ ...e, architecture_refs: i ? [] : [node.id] })) }).find(d => d.input.node_id === node.id);
  assert.ok(preferred.input.evidence.filter(e => e.ref.startsWith('l2:')).every(e => e.excerpt.includes('Capture')));
  assert.equal(preferred.input.evidence.filter(e => e.ref === 'l2:first').length, 1);
  ctx.architectureSources = Array.from({ length: 12 }, (_, i) => ({ ref: `architecture-doc:${i}`, path: 'doc', content: '# Capture\n' + '捕获验证'.repeat(2000) }));
  node.evidence_refs = ctx.architectureSources.map(s => s.ref);
  node.label = '捕获'.repeat(80); node.summary = '验证'.repeat(600);
  for (let i = 0; i < 30; i++) ctx.map.edges.push({ from: node.id, to: 'root', type: 'uses' });
  const big = drafts(ctx).find(d => d.input.node_id === node.id);
  assert.ok(big.input.evidence.every(e => e.excerpt.length <= 1500)); assert.ok(cardFor(big).est_tokens <= 8000);
  assert.equal(big.input.relations.length, 20);
});

test('arch review includes a relevant paragraph deep in a long section with its heading', () => {
  const ctx = context([1, 0, 0, 0]);
  ctx.architectureSources[0].content = '## Accounts\n\n' + 'Unrelated background. '.repeat(200) +
    '\n\nCapture validation pipeline isolates each account.';
  const evidence = drafts(ctx).find(d => d.input.node_id === 'n0-00').input.evidence;
  assert.deepEqual(evidence, [{ ref: 'architecture-doc:doc', excerpt: '## Accounts\nCapture validation pipeline isolates each account.' }]);
});

test('arch review ranks paragraphs then emits document order and each heading once', () => {
  const ctx = context([1, 0, 0, 0]);
  ctx.architectureSources[0].content = '## Earlier\n\nCapture first.\n\nCapture validation second.\n\n## Later\n\nCapture validation pipeline third.';
  const excerpt = drafts(ctx).find(d => d.input.node_id === 'n0-00').input.evidence[0].excerpt;
  assert.equal(excerpt, '## Earlier\nCapture first.\n\nCapture validation second.\n\n## Later\nCapture validation pipeline third.');
});

test('arch review equal-score selection is deterministic and prefers document order within the ref cap', () => {
  const ctx = context([1, 0, 0, 0]);
  const first = 'Capture first ' + 'x'.repeat(1470);
  ctx.architectureSources[0].content = '## Owner\n\n' + first + '\n\nCapture second ' + 'y'.repeat(100);
  const before = JSON.stringify(ctx);
  const evidence = () => drafts(ctx).find(d => d.input.node_id === 'n0-00').input.evidence;
  const expected = [{ ref: 'architecture-doc:doc', excerpt: ('## Owner\n' + first + '\n\nCapture second ' + 'y'.repeat(100)).slice(0, 1500) }];
  assert.deepEqual(evidence(), expected);
  assert.deepEqual(evidence(), expected);
  assert.equal(JSON.stringify(ctx), before);
});

test('arch review falls back to first paragraphs when no paragraph overlaps', () => {
  const ctx = context([1, 0, 0, 0]);
  ctx.architectureSources[0].content = 'Opening facts.\r\n\r\n## Background\r\n\r\n- First item\r\n- Second item\r\n\r\nClosing facts. ' + 'z'.repeat(1600);
  const excerpt = drafts(ctx).find(d => d.input.node_id === 'n0-00').input.evidence[0].excerpt;
  assert.equal(excerpt, ('Opening facts.\n\n## Background\n- First item\n- Second item\n\nClosing facts. ' + 'z'.repeat(1600)).slice(0, 1500));
});

test('arch review doc query includes parent and both relation endpoint labels without changing L2 matching', () => {
  const ctx = context([2, 0, 0, 0]), node = ctx.map.nodes[1];
  ctx.map.nodes[0].label = 'Tenancy'; ctx.map.nodes[2].label = 'Accounts';
  node.evidence_refs.push('l2:related');
  ctx.events = [{ id: 'e', title: 'Tenancy Accounts', summary: 'Unrelated', architecture_refs: [], latest_revision_ref: 'l2:related' }];
  ctx.architectureSources[0].content = '## Owners\n\nUnrelated.\n\nTenancy is isolated.\n\nAccounts are separate.';
  for (const [from, to] of [[node.id, ctx.map.nodes[2].id], [ctx.map.nodes[2].id, node.id]]) {
    ctx.map.edges = [{ from, to, type: 'uses' }];
    const evidence = drafts(ctx).find(d => d.input.node_id === node.id).input.evidence;
    assert.deepEqual(evidence, [{ ref: 'architecture-doc:doc', excerpt: '## Owners\nTenancy is isolated.\n\nAccounts are separate.' }]);
  }
});

test('arch review validation rejects malformed scores, extra keys and foreign or missing citations', () => {
  const ctx = context([1, 0, 0, 0]), card = cardFor(drafts(ctx).find(d => d.input.node_id === 'n0-00')), answer = valid(card);
  assert.deepEqual(g.validate(card, answer), { ok: true, normalized: answer });
  for (const invalid of [null, [], {}, { ...answer, extra: 1 }, { ...answer, faithfulness: 0 }, { ...answer, clarity: 6 },
    { ...answer, faithfulness: 2.5 }, { ...answer, clarity: NaN }, { ...answer, issues: Array(6).fill('x') },
    { ...answer, issues: ['x'.repeat(201)] }, { ...answer, issues: [42] }, { ...answer, cited_refs: [42] },
    { ...answer, tokens_in: -1 }, { ...answer, tokens_out: 0.1 }, { ...answer, tokens_out: Infinity }])
    assert.equal(g.validate(card, invalid).code, 'schema_invalid', JSON.stringify(invalid));
  for (const key of Object.keys(answer)) { const invalid = { ...answer }; delete invalid[key]; assert.equal(g.validate(card, invalid).code, 'schema_invalid'); }
  assert.equal(g.validate(card, { ...answer, cited_refs: [] }).code, 'ref_not_allowed');
  assert.equal(g.validate(card, { ...answer, cited_refs: ['foreign'] }).code, 'ref_not_allowed');
  const empty = { ...card, allowed_refs: [], input: { ...card.input, evidence: [] } };
  assert.equal(g.validate(empty, { ...answer, cited_refs: [], faithfulness: 3 }).code, 'schema_invalid');
  assert.equal(g.validate(empty, { ...answer, cited_refs: [], faithfulness: 2 }).ok, true);
  assert.equal(g.validate(card, { ...answer, tokens_in: 0, tokens_out: 10 }).ok, true);
  assert.equal(g.validate({ ...card, input: {} }, answer).code, 'schema_invalid');
});

test('arch review apply deduplicates rounds, fences structure and evidence, and uses supplied clock and actor', async () => {
  const ctx = context([2, 0, 0, 0]), state = await record(ctx, 'n0-00');
  const { card } = state;
  const entry = state.artifacts.get('arch_review:index').nodes['n0-00'];
  assert.deepEqual([entry.rounds[0].accepted_at, entry.rounds[0].harness, entry.rounds[0].model, entry.rounds[0].profile], [new Date(now).toISOString(), 'test', 'm1', 'background']);
  await g.apply(card, valid(card), state.ports, { harness: 'other', profile: 'inline' }, now + 1);
  assert.equal(state.artifacts.get('arch_review:index').nodes['n0-00'].rounds.length, 1);
  assert.equal(g.fence(card, ctx.map), card.fingerprint);
  ctx.map.nodes[2].evidence_refs.push('unrelated'); assert.equal(g.fence(card, ctx.map), card.fingerprint);
  ctx.map.timeline_links.push({}); assert.equal(g.fence(card, ctx.map), card.fingerprint);
  ctx.map.nodes[1].evidence_refs.push('changed');
  assert.equal((await g.apply(card, valid(card), state.ports, {}, now)).code, 'stale_fingerprint');
  assert.notEqual(g.fence(card, ctx.map), card.fingerprint); assert.notEqual(g.fence(card, null), card.fingerprint);
  assert.notEqual(g.fence({ ...card, input: { node_id: 'missing' } }, ctx.map), card.fingerprint);
  const replacement = await record(ctx, 'n0-00', [5, 5], state);
  assert.equal(replacement.artifacts.get('arch_review:index').nodes['n0-00'].rounds.length, 1);
  ctx.map.nodes[1].summary += ' changed';
  assert.equal((await g.apply(replacement.card, valid(replacement.card), state.ports, {}, now)).code, 'stale_fingerprint');
});

test('arch review aggregation uses sample membership, conservative pairs, agreement, gaps and intervals', async () => {
  const ctx = context([2, 0, 0, 0]), state = await record(ctx, 'n0-00', [1, 2]);
  await record(ctx, 'n0-00', [4, 5], state); await record(ctx, 'n0-01', [5, 5], state);
  const index = state.artifacts.get('arch_review:index');
  const summary = aggregateArchReviews(index, ctx.map);
  assert.deepEqual(summary.nodes['n0-00'].agreement, { faithfulness: 0.25, clarity: 0.25 });
  assert.equal(summary.nodes['n0-00'].faithfulness, 2); assert.equal(summary.nodes['n0-00'].clarity, 3);
  assert.equal(summary.nodes['n0-00'].disputed, true); assert.equal(summary.nodes['n0-01'].agreement.faithfulness, 'single');
  assert.equal(summary.map_score, null); assert.equal(summary.map_score_unverified, 75); assert.equal(summary.n, 2); assert.equal(summary.coverage, 1); assert.equal(summary.interval, 41);
  assert.deepEqual(summary.gaps.map(g => g.kind), ['judged_unfaithful', 'review_disputed']);
  assert.equal(summary.token_estimate.cards, 3); assert.ok(summary.token_estimate.est_tokens_total > 0);
  assert.deepEqual(summary.reviewers, [{ model: 'm1', harness: 'test', count: 3 }]);
  assert.equal(summary.last_reviewed_at, new Date(now).toISOString());
  const oldPrompt = structuredClone(index);
  oldPrompt.nodes['n0-00'].rounds[1].prompt_version = 'other';
  const single = aggregateArchReviews(oldPrompt, ctx.map);
  assert.deepEqual(single.gaps.map(g => g.kind), ['judged_unfaithful', 'judged_unclear']);
  assert.equal(single.nodes['n0-00'].agreement.clarity, 'single');
  index.nodes['n0-01'].selection = 'risk'; index.nodes['n0-01'].in_sample = false;
  const riskOnly = aggregateArchReviews(index, ctx.map);
  assert.equal(riskOnly.map_score, null); assert.equal(riskOnly.map_score_unverified, 50); assert.equal(riskOnly.risk.mean, 5); assert.equal(riskOnly.interval, null);
  const before = JSON.stringify(index); assert.deepEqual(aggregateArchReviews(index, ctx.map), riskOnly); assert.equal(JSON.stringify(index), before);
  index.nodes['n0-01'].rounds[0].prompt_version = 'other';
  assert.equal(aggregateArchReviews(index, ctx.map).token_estimate.cards, 2);
  ctx.map.nodes[1].evidence_refs.push('new');
  assert.equal(aggregateArchReviews(index, ctx.map).n, 0);
  assert.equal(aggregateArchReviews(index, ctx.map).map_score, null);
});

test('arch review empty summary and second-round missing model metadata remain deterministic', async () => {
  const ctx = context([1, 0, 0, 0]), state = await record(ctx, 'n0-00', [1, 1]);
  const index = state.artifacts.get('arch_review:index');
  delete index.nodes['n0-00'].rounds[0].model;
  state.artifacts.set('arch_review:index', index);
  const updated = { ...ctx, artifacts: { get: key => state.artifacts.get(key) } };
  const second = drafts(updated).find(d => d.input.node_id === 'n0-00');
  assert.deepEqual(second.input.exclude_reviewer_models, []);
  assert.deepEqual(second.input.exclude_reviewer_families, ['unknown']);
  const summary = aggregateArchReviews(index, ctx.map);
  assert.deepEqual(summary.reviewers, [{ model: null, harness: 'test', count: 1 }]);
  assert.equal(summary.interval, null);
  const empty = aggregateArchReviews({ version: 1, nodes: {} }, { ...ctx.map, nodes: [] });
  assert.deepEqual([empty.map_score, empty.n, empty.coverage, empty.interval, empty.risk.mean, empty.last_reviewed_at], [null, 0, 0, null, null, null]);
  const a = drafts(updated), b = g.ensure(updated, now + 1000);
  assert.deepEqual(a, b);
});

test('arch review registration is idempotent and registry still rejects duplicate registration', () => {
  registerArchReview(); registerArchReview();
  assert.equal(maintenanceGenerators.get('arch_review'), g);
  assert.throws(() => registerMaintenanceGenerator(g), /already registered/);
});

test('doc refs whose content changed since the map fall back to the current doc at the same path', () => {
  const ctx = context([1, 0, 0, 0]);
  const oldRef = 'architecture-doc:p:0000000000000000:project-repo/docs/a.md';
  ctx.map.nodes[1].evidence_refs = [oldRef];
  ctx.architectureSources = [
    { ref: 'architecture-doc:p:1111111111111111:project-repo/docs/a.md', path: 'project-repo/docs/a.md', content: '# Capture\nCapture validation pipeline, edited.' },
    { ref: 'architecture-doc:q:2222222222222222:project-repo/docs/a.md', path: 'project-repo/docs/a.md', content: '# Capture\nOther project.' }];
  const draft = drafts(ctx).find(d => d.input.node_id === ctx.map.nodes[1].id);
  assert.ok(draft);
  assert.deepEqual(draft.allowed_refs, [oldRef]);
  assert.ok(draft.input.evidence[0].excerpt.startsWith('[doc changed since map; current text] '));
  assert.ok(draft.input.evidence[0].excerpt.includes('edited'));
  ctx.architectureSources = [{ ...ctx.architectureSources[0], path: 'project-repo/docs/b.md' }];
  assert.equal(drafts(ctx).filter(d => d.input.node_id === ctx.map.nodes[1].id).length, 0);
});

const flag = (id, created_at = new Date(now + 1).toISOString(), extra = {}) => ({
  id, reason: 'wrong', note: 'Check ownership', created_at, by: 'user', ...extra
});
const withState = (ctx, state) => ({ ...ctx, artifacts: { get: key => state.artifacts.get(key) } });
const controlKey = (ctx, nodeId) => `arch_review:${ctx.projectId}:${nodeId}:${hash(structureFingerprint(ctx.map) + ':c:' + nodeId).slice(0, 32)}:r1`;
const isControl = (ctx, draft) => draft.key === controlKey(ctx, draft.input.node_id);
function controlContext() {
  const ctx = context([60, 0, 0, 0]);
  for (const node of ctx.map.nodes.slice(1)) {
    node.label = `Owner ${node.id}`; node.summary = `Responsibility ${node.id}`;
  }
  return ctx;
}

test('user flags outrank gaps inside the fifteen-node risk cap and cleared flags are ignored', () => {
  const ctx = context([60, 0, 0, 0]);
  ctx.gaps = ctx.map.nodes.slice(1, 31).map(n => ({ kind: 'low_confidence_node', ref: n.id }));
  const flags = Object.fromEntries(ctx.map.nodes.slice(41, 57).map((n, i) => [n.id, [flag(String(i))]]));
  flags['n0-59'] = [flag('cleared', undefined, { cleared_at: new Date(now).toISOString() })];
  ctx.artifacts = { get: key => key === 'node_flags' ? { version: 1, flags } : undefined };
  const result = drafts(ctx), risk = result.filter(d => d.input.selection === 'risk');
  assert.equal(risk.length, 15);
  assert.ok(risk.every(d => d.input.risk_reasons.includes('user_flag')));
  assert.ok(risk.every(d => d.input.user_flags.length === 1));
  assert.ok(!result.find(d => d.input.node_id === 'n0-59')?.input.risk_reasons.includes('user_flag'));
  assert.match(g.instructions, /user_flags/);
});

test('user flags trigger a fresh round, stable per-flag keys, round reset and normal round two', async () => {
  const ctx = context([1, 0, 0, 0]), state = await record(ctx, 'n0-00', [4, 4]);
  const id = 'n0-00', old = state.artifacts.get('arch_review:index').nodes[id];
  const flags = { version: 1, flags: { [id]: [flag('first'), flag('old', new Date(now - 1).toISOString()),
    flag('cleared', undefined, { cleared_at: new Date(now).toISOString() })] } };
  state.artifacts.set('node_flags', flags);
  const updated = withState(ctx, state), before = JSON.stringify(state.artifacts.get('arch_review:index'));
  const draft = drafts(updated).find(d => d.input.node_id === id), card = cardFor(draft);
  assert.match(draft.key, /:r1:ffirst$/);
  assert.equal(draft.input.review_round, 1);
  assert.deepEqual(draft.input.user_flags, [{ reason: 'wrong', note: 'Check ownership' }, { reason: 'wrong', note: 'Check ownership' }]);
  assert.deepEqual(drafts(updated).find(d => d.input.node_id === id), draft);
  assert.equal(JSON.stringify(state.artifacts.get('arch_review:index')), before);
  await g.apply(card, valid(card, 2, 2), state.ports, { harness: 'h', model: 'gpt-6-luna', profile: 'background' }, now + 2);
  let entry = state.artifacts.get('arch_review:index').nodes[id];
  assert.equal(entry.review_fp, old.review_fp); assert.equal(entry.rounds.length, 1);
  assert.equal(entry.rounds[0].trigger, 'user_flag');
  assert.equal(entry.selection, 'risk');
  const second = drafts(updated).find(d => d.input.node_id === id);
  assert.match(second.key, /:r2:ffirst$/);
  assert.deepEqual(second.input.exclude_reviewer_models, ['gpt-6-luna']);
  assert.deepEqual(second.input.exclude_reviewer_families, ['openai']);
  const secondCard = cardFor(second);
  await g.apply(secondCard, valid(secondCard, 3, 3), state.ports, { harness: 'h', model: 'claude-sonnet', profile: 'background' }, now + 3);
  // Replaying the accepted flag card must not erase round two.
  await g.apply(card, valid(card, 2, 2), state.ports, { harness: 'h', profile: 'background' }, now + 4);
  assert.equal(state.artifacts.get('arch_review:index').nodes[id].rounds.length, 2);
  assert.ok(!drafts(updated).some(d => d.input.node_id === id));
  flags.flags[id].push(flag('newest', new Date(now + 5).toISOString(), { reason: 'missing_part', note: 'Missing export' }));
  const next = drafts(updated).find(d => d.input.node_id === id);
  assert.match(next.key, /:r1:fnewest$/);
  await g.apply(cardFor(next), valid(next), state.ports, { harness: 'h', profile: 'background' }, now + 6);
  entry = state.artifacts.get('arch_review:index').nodes[id];
  assert.equal(entry.rounds.length, 1); assert.equal(entry.rounds[0].trigger, 'user_flag');
  assert.ok(!drafts(updated).some(d => d.input.node_id === id));
});

test('same-clock flags require their own review, while older and cleared flags never reopen reviews', async () => {
  const ctx = context([1, 0, 0, 0]), state = await record(ctx, 'n0-00');
  state.artifacts.set('node_flags', { version: 1, flags: { 'n0-00': [flag('older', new Date(now - 1).toISOString())] } });
  assert.ok(!drafts(withState(ctx, state)).some(d => d.input.node_id === 'n0-00'));
  state.artifacts.set('node_flags', { version: 1, flags: { 'n0-00': [flag('equal', new Date(now).toISOString()),
    flag('cleared', undefined, { cleared_at: new Date(now + 2).toISOString() })] } });
  const fresh = cardFor(drafts(withState(ctx, state)).find(d => d.input.node_id === 'n0-00'));
  assert.match(fresh.key, /:r1:fequal$/);
  assert.equal((await g.apply(fresh, valid(fresh), state.ports, { harness: 'h', profile: 'background' }, now)).ok, true);
  assert.ok(!drafts(withState(ctx, state)).some(d => d.input.node_id === 'n0-00'));
});

test('same-clock replacement flags invalidate round two before a fresh review', async () => {
  const ctx = context([1, 0, 0, 0]), id = 'n0-00', state = await record(ctx, id, [1, 2]);
  const updated = withState(ctx, state), old = cardFor(drafts(updated).find(d => d.input.node_id === id));
  state.artifacts.set('node_flags', { version: 1, flags: { [id]: [flag('equal', new Date(now).toISOString())] } });
  const fresh = drafts(updated).find(d => d.input.node_id === id);
  assert.equal(fresh.input.review_round, 1);
  assert.notEqual(g.fence(old, ctx.map, updated.artifacts), old.fingerprint);
  const before = structuredClone(state.artifacts.get('arch_review:index'));
  assert.equal((await g.apply(old, valid(old), state.ports, { harness: 'h', profile: 'background' }, now + 1)).code, 'stale_fingerprint');
  assert.deepEqual(state.artifacts.get('arch_review:index'), before);
  const first = cardFor(fresh);
  await g.apply(first, valid(first, 1, 2), state.ports, { harness: 'h', model: 'current', profile: 'background' }, now);
  let second = cardFor(drafts(updated).find(d => d.input.node_id === id));
  assert.match(second.key, /:r2:fequal$/);
  assert.equal(g.fence(second, ctx.map, updated.artifacts), second.fingerprint);
  const history = state.artifacts.get('node_flags').flags[id];
  history.push(flag('zzz-later', new Date(now).toISOString()));
  const later = cardFor(drafts(updated).find(d => d.input.node_id === id));
  assert.match(later.key, /:r1:fzzz-later$/);
  assert.notEqual(g.fence(second, ctx.map, updated.artifacts), second.fingerprint);
  await g.apply(later, valid(later, 1, 2), state.ports, { harness: 'h', model: 'current', profile: 'background' }, now);
  second = cardFor(drafts(updated).find(d => d.input.node_id === id));
  assert.match(second.key, /:r2:fzzz-later$/);
  history[1].cleared_at = new Date(now + 1).toISOString();
  assert.equal(drafts(updated).find(d => d.input.node_id === id).key, second.key, 'clearing the newest flag does not reopen an earlier same-clock flag');
  assert.equal(g.fence(second, ctx.map, updated.artifacts), second.fingerprint);
  assert.equal((await g.apply(second, valid(second), state.ports, { harness: 'h', model: 'other', profile: 'background' }, now + 2)).ok, true);
});

test('controls use deterministic sources, all three corruptions and indistinguishable payloads', () => {
  const ctx = controlContext(), before = JSON.stringify(ctx), result = drafts(ctx);
  const real = result.filter(d => !isControl(ctx, d)), controls = result.filter(d => isControl(ctx, d));
  assert.equal(controls.length, Math.ceil(real.filter(d => d.input.review_round === 1).length / 5));
  assert.ok(controls.length >= 3);
  const sfp = structureFingerprint(ctx.map);
  const eligible = ctx.map.nodes.filter(n => n.kind !== 'project' && !real.some(d => d.input.node_id === n.id))
    .sort((a, b) => hash(`${ctx.projectId}:canary:${a.id}:${sfp}`).localeCompare(hash(`${ctx.projectId}:canary:${b.id}:${sfp}`)));
  assert.deepEqual(controls.map(d => d.input.node_id), eligible.slice(0, controls.length).map(n => n.id));
  for (const [rank, draft] of controls.entries()) {
    const node = ctx.map.nodes.find(n => n.id === draft.input.node_id), input = draft.input;
    assert.ok(!real.some(d => d.input.node_id === node.id));
    assert.deepEqual(Object.keys(input).sort(), Object.keys(real.find(d => d.input.stratum !== 'project').input).sort());
    assert.deepEqual(Object.keys(draft).sort(), Object.keys(real[0]).sort());
    assert.match(draft.key, /^arch_review:p:[^:]+:[a-f0-9]{32}:r1$/);
    assert.ok(input.selection === 'risk' || input.in_sample);
    assert.deepEqual(draft.allowed_refs, ['architecture-doc:doc']);
    assert.deepEqual(input.evidence, real.find(d => d.input.stratum !== 'project').input.evidence);
    assert.equal(g.fence(cardFor(draft), ctx.map), draft.fingerprint);
    assert.ok(cardFor(draft).est_tokens <= 8000);
    if (rank % 3 === 0) { assert.notEqual(input.node.summary, node.summary); assert.equal(input.node.label, node.label); }
    else if (rank % 3 === 1) { assert.equal(input.relations.at(-1).type, 'depends_on'); assert.equal(input.node.summary, node.summary); }
    else { assert.notEqual(input.node.label, node.label); assert.equal(input.node.summary, node.summary); }
  }
  assert.deepEqual(drafts({ ...ctx, map: { ...ctx.map, nodes: [...ctx.map.nodes].reverse() } }), result);
  assert.deepEqual(drafts(ctx), result); assert.equal(JSON.stringify(ctx), before);
  const unresolved = { ...ctx, map: structuredClone(ctx.map) };
  for (const node of unresolved.map.nodes) if (!real.some(d => d.input.node_id === node.id)) node.evidence_refs = ['architecture-doc:missing'];
  assert.equal(drafts(unresolved).filter(d => isControl(unresolved, d)).length, 0);
  assert.equal(drafts(unresolved).length, real.length);
  assert.equal(drafts(context([1, 0, 0, 0])).filter(d => isControl(context([1, 0, 0, 0]), d)).length, 0);
  // A fully sampled map cannot supply a disjoint control source.
  assert.equal(drafts(context()).filter(d => isControl(context(), d)).length, 0);
});

test('control corruptions stay in different branches and never fabricate an existing relation', () => {
  const ctx = controlContext();
  for (const [i, node] of ctx.map.nodes.slice(1).entries()) {
    if (i % 3) node.parent_id = `n0-${String(i - i % 3).padStart(2, '0')}`;
  }
  const result = drafts(ctx), controls = result.filter(d => isControl(ctx, d));
  const top = node => node.parent_id === 'root' ? node.id : node.parent_id;
  assert.ok(controls.length >= 3);
  for (const [rank, d] of controls.entries()) {
    const node = ctx.map.nodes.find(n => n.id === d.input.node_id);
    const donor = ctx.map.nodes.find(n => rank % 3 === 0 ? n.summary === d.input.node.summary :
      rank % 3 === 2 ? n.label === d.input.node.label : n.id === d.input.relations.at(-1).to);
    assert.notEqual(top(node), top(donor));
  }
});

test('control apply updates only calibration and real bounded relation cards stay real', async () => {
  const ctx = controlContext(), state = portsFor(ctx), initial = drafts(ctx);
  const real = initial.find(d => !isControl(ctx, d) && d.input.stratum !== 'project');
  await g.apply(cardFor(real), valid(real), state.ports, { harness: 'worker', model: 'gpt-6-luna', profile: 'background' }, now);
  const before = structuredClone(state.artifacts.get('arch_review:index').nodes);
  const controls = initial.filter(d => isControl(ctx, d));
  for (const [i, draft] of controls.entries()) {
    const card = cardFor(draft);
    assert.equal(g.validate(card, valid(card, i ? 2 : 5)).ok, true);
    assert.deepEqual(await g.apply(card, valid(card, i ? 2 : 5), state.ports,
      { harness: 'worker', model: 'gpt-6-luna', profile: 'background' }, now + 1), { ok: true });
  }
  const index = state.artifacts.get('arch_review:index');
  assert.deepEqual(index.nodes, before);
  assert.deepEqual(index.canaries['gpt-6-luna'], { harness: 'worker', seen: controls.length, caught: controls.length - 1 });
  assert.equal(state.artifacts.get('arch_review:summary').token_estimate.cards, 1);
  assert.deepEqual(state.artifacts.get('arch_review:summary').gaps, []);
  await g.apply(cardFor(controls[0]), valid(controls[0], 1), state.ports, { harness: 'anonymous', profile: 'background' }, now);
  assert.deepEqual(state.artifacts.get('arch_review:index').canaries.unknown, { harness: 'anonymous', seen: 1, caught: 1 });
  const bounded = context([1, 0, 0, 0]);
  for (let i = 0; i < 30; i++) bounded.map.edges.push({ from: 'n0-00', to: 'root', type: 'uses' });
  const recorded = await record(bounded, 'n0-00');
  assert.ok(recorded.artifacts.get('arch_review:index').nodes['n0-00']);
  assert.equal(recorded.artifacts.get('arch_review:index').canaries, undefined);
  ctx.map.nodes[1].summary += ' changed';
  const previous = structuredClone(state.artifacts.get('arch_review:index'));
  assert.equal((await g.apply(cardFor(controls[0]), valid(controls[0], 1), state.ports,
    { harness: 'worker', model: 'gpt-6-luna', profile: 'background' }, now)).code, 'stale_fingerprint');
  assert.deepEqual(state.artifacts.get('arch_review:index'), previous);
});

test('calibration thresholds gate map score while preserving the legacy estimate', async () => {
  const ctx = context([2, 0, 0, 0]), state = await record(ctx, 'n0-00', [1, 2]);
  await record(ctx, 'n0-00', [4, 5], state); await record(ctx, 'n0-01', [5, 5], state);
  const index = state.artifacts.get('arch_review:index');
  index.nodes['n0-00'].rounds[0].model = 'gpt-6-luna';
  index.nodes['n0-00'].rounds[1].model = 'claude-sonnet';
  index.nodes['n0-01'].rounds[0].model = 'claude-sonnet';
  for (const [seen, caught, calibrated] of [[0, 0, false], [2, 2, false], [3, 2, false], [3, 3, true], [5, 4, true], [6, 4, false]]) {
    index.canaries = { 'gpt-6-luna': { harness: 'h', seen, caught } };
    const summary = aggregateArchReviews(index, ctx.map);
    assert.equal(summary.calibration.find(c => c.model === 'gpt-6-luna').calibrated, calibrated);
    assert.equal(summary.map_score, calibrated ? 30 : null);
    assert.equal(summary.map_score_unverified, 75);
    assert.equal(summary.trust, 'unverified');
  }
  index.canaries = { 'gpt-6-luna': { harness: 'h', seen: 3, caught: 3 }, 'claude-sonnet': { harness: 'h', seen: 5, caught: 4 } };
  assert.equal(aggregateArchReviews(index, ctx.map).map_score, 75);
  assert.equal(aggregateArchReviews(index, ctx.map).trust, 'unverified');
  assert.equal(aggregateArchReviews(index, ctx.map).cross_family_agreement, 0);
});

test('trust requires calibrated reviewers and sampled cross-family agreement, with canonical families', async () => {
  const ctx = context([2, 0, 0, 0]), state = await record(ctx, 'n0-00', [2, 2]);
  await record(ctx, 'n0-00', [3, 3], state); await record(ctx, 'n0-01', [5, 5], state);
  const index = state.artifacts.get('arch_review:index'), entry = index.nodes['n0-00'];
  entry.rounds[0].model = 'gpt-6-luna'; entry.rounds[1].model = 'claude-sonnet';
  index.nodes['n0-01'].rounds[0].model = 'claude-sonnet';
  index.canaries = { 'gpt-6-luna': { harness: 'h', seen: 3, caught: 3 }, 'claude-sonnet': { harness: 'h', seen: 3, caught: 3 } };
  const summary = aggregateArchReviews(index, ctx.map);
  assert.equal(summary.trust, 'calibrated'); assert.equal(summary.cross_family_agreement, 1);
  assert.deepEqual(summary.families, ['anthropic', 'openai']);
  assert.equal(summary.map_score, 70); assert.equal(summary.map_score_unverified, 70);
  const before = JSON.stringify(index); assert.deepEqual(aggregateArchReviews(index, ctx.map), summary); assert.equal(JSON.stringify(index), before);
  entry.in_sample = false;
  assert.equal(aggregateArchReviews(index, ctx.map).trust, 'unverified');
  entry.in_sample = true;
  for (const [model, expected] of [['gpt-6', 'openai'], ['o3', 'openai'], ['o1-mini', 'openai'], ['claude-opus', 'anthropic'], ['gemini-3', 'google'], ['local', 'unknown']]) {
    entry.rounds[1].model = model;
    index.canaries[model] = { harness: 'h', seen: 3, caught: 3 };
    const next = aggregateArchReviews(index, ctx.map);
    assert.equal(next.calibration.find(c => c.model === model).family, expected);
    assert.equal(next.cross_family_agreement, expected !== 'openai' ? 1 : 0);
  }
  entry.rounds[1].model = 'claude-sonnet';
  delete index.canaries['claude-sonnet'];
  assert.equal(aggregateArchReviews(index, ctx.map).trust, 'unverified');
  assert.equal(aggregateArchReviews(index, ctx.map).map_score, 40);
  const second = drafts(withState(ctx, state)).find(d => d.input.node_id === 'root');
  assert.ok(second);
});

test('user-flagged review drafts request maintenance while automatic drafts do not', () => {
  const ctx = context([2, 0, 0, 0]);
  ctx.artifacts = { get: key => key === 'node_flags'
    ? { version: 1, flags: { 'n0-00': [flag('requested')] } } : undefined };
  const result = drafts(ctx);
  assert.equal(result.find(d => d.input.node_id === 'n0-00').requested, true);
  assert.ok(result.filter(d => d.input.node_id !== 'n0-00').every(d => !d.requested));
});

test('mechanism stratum and fact-only citations reach additive review input', () => {
  const ctx=context([0,0,0,1]);const node=ctx.map.nodes[1];node.kind='mechanism';node.facets={layer:'core'};
  node.facts=[{key:'limit',value:12,unit:'items',evidence_refs:['architecture-doc:fact'],confidence:0.9}];
  ctx.architectureSources.push({ref:'architecture-doc:fact',path:'fact.md',content:'Capture limit is 12 items.'});
  const draft=drafts(ctx).find(d=>d.input.node_id===node.id);
  assert.equal(draft.input.stratum,'mechanism');assert.equal(draft.input.in_sample,true);
  assert.equal(draft.input.node.layer,'core');
  assert.deepEqual(draft.input.node.facts,[{key:'limit',value:12,unit:'items'}]);
  assert.ok(draft.allowed_refs.includes('architecture-doc:fact'));
  assert.ok(draft.input.evidence.some(e=>e.ref==='architecture-doc:fact'));
  const before=g.fence(cardFor(draft),ctx.map);node.facts[0].value=13;
  assert.notEqual(g.fence(cardFor(draft),ctx.map),before);
});
test('fourth control corruption changes one fact and is calibrated without recording a real review', async () => {
  const ctx=controlContext();
  for(const node of ctx.map.nodes)node.facts=[{key:'limit',value:12,evidence_refs:['architecture-doc:doc'],confidence:1}];
  const before=JSON.stringify(ctx.map),controls=drafts(ctx).filter(d=>isControl(ctx,d));
  assert.ok(controls.length>=4);
  const draft=controls[3],canonical=ctx.map.nodes.find(n=>n.id===draft.input.node_id);
  assert.notEqual(draft.input.node.facts[0].value,canonical.facts[0].value);
  assert.equal(draft.input.node.summary,canonical.summary);assert.equal(draft.input.node.label,canonical.label);
  assert.equal(JSON.stringify(ctx.map),before);
  const state=portsFor(ctx);await g.apply(cardFor(draft),valid(draft,1),state.ports,{model:'test',harness:'test'},now);
  assert.equal(state.artifacts.get('arch_review:index').canaries.test.caught,1);
  assert.deepEqual(state.artifacts.get('arch_review:index').nodes,{});
});

test('arch review resolves anchored document identity and excerpts the named section first, including layer-only refs', () => {
  const ctx = context([1, 0, 0, 0]);
  const ref = 'architecture-doc:p:0123456789abcdef:docs/a.md';
  ctx.architectureSources = [{ ref, path: 'docs/a.md', content: '# Capture\nCapture validation pipeline.\n\n## Target Layer\nThis module belongs to core.\n\n### Detail\nNested evidence.\n\n## Other\nCapture validation pipeline repeated.' }];
  const node = ctx.map.nodes[1];
  node.evidence_refs = [ref + '#target-layer'];
  node.facets = { layer: 'core', layer_evidence_refs: [ref + '#detail'] };
  let card = drafts(ctx).find(d => d.input.node_id === node.id);
  assert.deepEqual(card.allowed_refs, [ref + '#detail', ref + '#target-layer']);
  const excerpt = card.input.evidence.find(e => e.ref.endsWith('#target-layer')).excerpt;
  assert.match(excerpt, /^## Target Layer/); assert.match(excerpt, /Nested evidence/); assert.doesNotMatch(excerpt, /repeated|# Capture/);
  ctx.architectureSources[0].ref = ref.replace('0123456789abcdef', 'fedcba9876543210');
  card = drafts(ctx).find(d => d.input.node_id === node.id);
  assert.match(card.input.evidence.find(e => e.ref.endsWith('#target-layer')).excerpt, /^\[doc changed since map; current text\] ## Target Layer/);
});

test('arch review keeps late relevant evidence inside a long pinned section and its budget', () => {
  const ctx = context([1, 0, 0, 0]);
  const ref = 'architecture-doc:p:0123456789abcdef:docs/a.md';
  const node = ctx.map.nodes[1];
  node.evidence_refs = [ref + '#target'];
  ctx.architectureSources = [{ ref, path: 'docs/a.md', content:
    '## Target\n\n' + 'Unrelated transport background. '.repeat(80) +
    '\n\nCapture validation pipeline preserves recorder origin.\n\n## Outside\nCapture validation pipeline OUTSIDE-SECTION.' }];
  for (const changed of [false, true]) {
    ctx.architectureSources[0].ref = changed ? ref.replace('0123456789abcdef', 'fedcba9876543210') : ref;
    const card = drafts(ctx).find(d => d.input.node_id === node.id);
    const evidence = card.input.evidence.find(e => e.ref === node.evidence_refs[0]);
    assert.match(evidence.excerpt, /## Target\nCapture validation pipeline preserves recorder origin\./);
    assert.doesNotMatch(evidence.excerpt, /OUTSIDE-SECTION|Unrelated transport background/);
    assert.equal(evidence.excerpt.startsWith('[doc changed since map; current text] '), changed);
    assert.ok(evidence.excerpt.length <= 1500);
  }
});
