import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { assembleMapBootstrapPackage, estimateMapBootstrapTokens, mapBootstrapCitedRefs, MAP_BOOTSTRAP_INSTRUCTIONS } from '../dist/archify/map-bootstrap.js';
import { parseArchitectureCognitiveMapCandidate } from '../dist/archify/architecture-cognitive-map.js';
import { architectureCandidate, emptyProjectModel, timelineProjectModel } from './fakes/project-model-fakes.mjs';

const assemble = (model = emptyProjectModel('alpha'), architectureSources = [], rebuild = false) =>
  assembleMapBootstrapPackage({ model, architectureSources, rebuild });

test('bootstrap refs hash the supplied content and stable paths; inputs stay immutable', () => {
  const sources = [{ path: 'project-repo/docs/z.md', content: '中文\n' }, { path: 'memhub-managed/ARCHITECTURE.md', content: 'Hard contract\n' }];
  const before = structuredClone(sources), first = assemble(undefined, sources);
  assert.deepEqual(first, assemble(undefined, sources.toReversed()));
  assert.deepEqual(sources, before);
  assert.equal(first.architecture_sources[0].ref, 'architecture-doc:alpha:' + createHash('sha256').update(sources[1].content).digest('hex').slice(0, 16) + ':' + sources[1].path);
  assert.notEqual(first.architecture_sources[0].ref, assemble(undefined, [{ ...sources[1], content: 'Changed' }]).architecture_sources[0].ref);
  assert.equal(first.mode, 'bootstrap');
  assert.equal(first.truncated, false);
});

test('bootstrap caps architecture text at 80000, clips only the tail and reports omissions', () => {
  const pkg = assemble(undefined, [{ path: 'a', content: 'a'.repeat(70_000) }, { path: 'b', content: 'b'.repeat(20_000) }, { path: 'c', content: 'tail' }]);
  assert.deepEqual(pkg.architecture_sources.map(source => source.content.length), [70_000, 10_000]);
  assert.equal(pkg.truncated, true);
  const tail = pkg.architecture_sources[1];
  assert.equal(tail.ref, 'architecture-doc:alpha:' + createHash('sha256').update(tail.content).digest('hex').slice(0, 16) + ':b');
  assert.equal(assemble(undefined, [{ path: 'a', content: 'x'.repeat(80_000) }]).truncated, false);
  assert.equal(assemble(undefined, [{ path: 'a', content: 'x'.repeat(80_000) }, { path: 'b', content: 'y' }]).truncated, true);
});

test('bootstrap uses canonical Project Map events, newest first, exact revisions and capped summaries', () => {
  const model = timelineProjectModel();
  model.l2[0].body += '\n\n## 2026-10-04 12:00–13:00：[Capture] refinement\n' + 'Long summary '.repeat(80);
  model.revisions[0].content = model.l2[0].body;
  const pkg = assemble(model);
  assert.equal(pkg.l2_events.length, 4);
  assert.equal(pkg.l2_events[0].date, '2026-10-04 12:00–13:00');
  assert.equal(pkg.l2_events[0].summary.length, 300);
  assert.ok(pkg.l2_events.every(event => event.evidence_ref === 'l2:timeline-alpha:revision-2'));
  assert.ok(!pkg.l2_events.some(event => event.title.includes('Retired')));
  assert.deepEqual(pkg.allowed_refs, ['l2:timeline-alpha:revision-2']);
  const body = '# Timeline\n' + Array.from({ length: 205 }, (_, i) => `\n## ${new Date(Date.UTC(2026, 0, i + 1)).toISOString().slice(0, 10)}：Event ${i}\nChange ${i}.`).join('');
  model.l2[0].body = body;
  model.revisions[0].content = body;
  const capped = assemble(model);
  assert.equal(capped.l2_events.length, 200);
  assert.equal(capped.events_truncated, 5);
  assert.deepEqual(capped, assemble(model));
});

test('bootstrap skips and counts events without exact L2 provenance; empty projects remain valid packages', () => {
  const model = timelineProjectModel();
  model.revisions = [];
  const none = assemble(model);
  assert.equal(none.l2_events.length, 0);
  assert.ok(none.events_without_ref > 0);
  assert.ok(none.allowed_refs.every(ref => !ref.startsWith('l2:')));
  const unrecorded = timelineProjectModel();
  unrecorded.l2[0].body += '\n\n## 2026-10-09：Unrecorded change\nNew event absent from every revision.';
  const partial = assemble(unrecorded);
  assert.equal(partial.events_without_ref, 1);
  assert.ok(!partial.l2_events.some(event => event.title.includes('Unrecorded change')));
  assert.equal(assemble().l2_events.length, 0);
});

test('bootstrap requires explicit rebuild and allows previous map refs only in rebuild', () => {
  const model = timelineProjectModel(true);
  assert.throws(() => assemble(model), /rebuild=true/);
  const pkg = assemble(model, [], true);
  assert.equal(pkg.mode, 'rebuild');
  assert.deepEqual(pkg.current_map, model.architecture.map);
  assert.ok(!Object.hasOwn(assemble(timelineProjectModel()), 'current_map'));
  assert.ok(pkg.allowed_refs.includes('l1:turn-1'));
  assert.ok(!assemble(timelineProjectModel()).allowed_refs.includes('l1:turn-1'));
});

test('bootstrap citation validation checks nodes, edges and links and returns only actual unique citations', () => {
  const candidate = parseArchitectureCognitiveMapCandidate(architectureCandidate());
  assert.deepEqual(mapBootstrapCitedRefs(candidate, ['l1:turn-1', 'l1:turn-2', 'unused']), ['l1:turn-1', 'l1:turn-2']);
  for (const field of ['nodes', 'edges', 'timeline_links']) {
    const foreign = structuredClone(candidate);
    foreign[field][0].evidence_refs.push('foreign:' + field);
    assert.throws(() => mapBootstrapCitedRefs(foreign, ['l1:turn-1', 'l1:turn-2']), new RegExp('foreign:' + field));
  }
});

test('bootstrap token estimates count ASCII and Unicode deterministically; fixed bilingual instructions', () => {
  assert.equal(estimateMapBootstrapTokens('abc中文'), Math.ceil(5 / 4 + 2 / 1.5) + 6400);
  const pkg = assemble(timelineProjectModel());
  const { est_tokens, ...body } = pkg;
  assert.equal(est_tokens, estimateMapBootstrapTokens(body));
  assert.equal(pkg.instructions, MAP_BOOTSTRAP_INSTRUCTIONS);
  assert.ok(pkg.instructions.length <= 1500);
  assert.match(pkg.instructions, /project → domain → capability → process → method/);
  assert.match(pkg.instructions, /中文：/);
  assert.match(pkg.instructions, /chronology adjacency is not causality/i);
  assert.match(pkg.instructions, /code evidence/);
  assert.match(pkg.instructions, /action \+ object/);
  assert.match(pkg.instructions, /input → action → result/);
  assert.match(pkg.instructions, /Method with code evidence/);
  assert.match(pkg.instructions, /flows_to only where execution order is proven/);
  assert.match(pkg.instructions, /ranking score is not confidence/);
  assert.match(pkg.instructions, /并行输入保持并列/);
  assert.match(pkg.instructions, /bilingual labels 'English \/ 中文'/);
  assert.match(pkg.instructions, /preserve IDs, code and terms/);
  assert.equal(createHash('sha256').update(pkg.instructions).digest('hex'), '6db5752a41d0dfd2fa5f37c73ff18c28bdf1b1aef4ef5ddd4ad1a0ed478ec0be');
});

test('shared Project Map L2 loader preserves hydration, pagination, filtering and item cap', async () => {
  const { loadLayerPayload } = await import('../dist/shell/archify/layer-payload.js');
  const calls = [];
  const memoryClient = { async viewerGet(path) {
    const url = new URL(path, 'http://test.invalid');
    calls.push(url);
    const page = Number(url.searchParams.get('page'));
    return { total: 300, hasNext: true, items: Array.from({ length: 100 }, (_, i) => ({ id: `${page}-${i}`, keep: page > 1 })) };
  } };
  const input = { memoryClient, userId: 'acct-user', projectId: 'alpha', kind: 'l2', hydrateBody: true, includeItem: item => item.keep };
  const loaded = await loadLayerPayload(input);
  assert.equal(loaded.payload.total, 300);
  assert.equal(loaded.items.length, 100);
  assert.equal(calls.length, 2);
  assert.equal(loaded.items[0].id, '2-0');
  assert.equal(calls[0].searchParams.get('includeBody'), '1');
  assert.equal(calls[0].searchParams.get('projectId'), 'alpha');
  calls.length = 0;
  await loadLayerPayload({ ...input, hydrateBody: false });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].searchParams.get('includeBody'), null);
  calls.length = 0;
  await loadLayerPayload({ ...input, kind: 'l4' });
  assert.equal(calls[0].searchParams.get('projectId'), null);
});

test('event labels over the 80-char link cap use the ISO date, and such links attach in the Project Map', async () => {
  const { projectMemoryVisualization } = await import('../dist/archify/memory-visualization.js');
  const longLabel = '2026-10-04 12:00–13:00 (' + 'annotated range '.repeat(6) + ')';
  const model = timelineProjectModel();
  model.l2[0].body += `\n\n## ${longLabel}：[Capture] long label refinement\nDetails.`;
  model.revisions[0].content = model.l2[0].body;
  const pkg = assemble(model);
  const event = pkg.l2_events.find(item => item.title.includes('long label refinement'));
  assert.ok(longLabel.length > 80);
  assert.equal(event.date, '2026-10-04');
  const candidate = architectureCandidate();
  const node = candidate.nodes.find(item => item.kind !== 'project');
  candidate.timeline_links = [{ event_date: event.date, event_title: event.title, architecture_refs: [node.id], architecture_level: node.kind,
    change_kind: 'refine', evidence_refs: [event.evidence_ref], confidence: 0.7 }];
  const parsed = parseArchitectureCognitiveMapCandidate(candidate);
  model.architecture = { map: { schema_version: 1, contract: 'memhub-architecture-cognitive-map-v1', project_id: model.projectId, authority: 'derived',
    abstraction_cutoff: 'method', generated_at: '2026-10-05T00:00:00.000Z', source_evidence_refs: [event.evidence_ref], ...parsed }, fingerprint: 'fp' };
  const events = projectMemoryVisualization(model).state.events;
  assert.deepEqual(events.find(item => item.title.includes('long label refinement')).architecture_refs, [node.id]);
  assert.ok(events.filter(item => !item.title.includes('long label refinement')).every(item => !item.architecture_refs.includes(node.id) || item.date !== '2026-10-04'));
});

test('bootstrap citations include and validate fact-only refs', () => {
  const candidate = parseArchitectureCognitiveMapCandidate(architectureCandidate());
  candidate.nodes[0].facts = [{key:'limit',value:12,evidence_refs:['fact-only'],confidence:1}];
  assert.throws(() => mapBootstrapCitedRefs(candidate,['l1:turn-1','l1:turn-2']), /fact-only/);
  assert.ok(mapBootstrapCitedRefs(candidate,['l1:turn-1','l1:turn-2','fact-only']).includes('fact-only'));
});


test('bootstrap lists deterministic deduplicated Markdown section refs and rejects unknown anchors', () => {
  const content = '# Hello, 世界!\r\nIntro\r\n## Hello, 世界!\r\nDetails\r\n## hello-世界-1\r\nCollision\r\n## Hello, 世界!\r\nMore\r\n```md\r\n# Ignored\r\n```\r\nSetext\r\n======\r\nEnd';
  const pkg = assemble(undefined, [{ path: 'docs/a.md', content }]);
  const doc = pkg.architecture_sources[0];
  assert.deepEqual(doc.sections.map(s => s.ref.slice(doc.ref.length)), ['#hello-世界', '#hello-世界-1', '#hello-世界-1-1', '#hello-世界-2', '#setext']);
  assert.equal(doc.sections[0].heading, 'Hello, 世界!');
  assert.deepEqual(pkg, assemble(undefined, [{ path: 'docs/a.md', content }]));
  assert.ok(doc.sections.every(s => pkg.allowed_refs.includes(s.ref)));
  const candidate = architectureCandidate();
  for (const item of [...candidate.nodes, ...candidate.edges, ...candidate.timeline_links]) item.evidence_refs = [doc.sections[1].ref];
  candidate.facet_vocab = { layer: ['core'] };
  candidate.nodes[1].facets = { layer: 'core', layer_evidence_refs: [doc.sections[2].ref] };
  const parsed = parseArchitectureCognitiveMapCandidate(candidate);
  assert.deepEqual(mapBootstrapCitedRefs(parsed, pkg.allowed_refs), [doc.sections[1].ref, doc.sections[2].ref]);
  parsed.nodes[1].facets.layer_evidence_refs = [doc.ref + '#unknown'];
  assert.throws(() => mapBootstrapCitedRefs(parsed, pkg.allowed_refs), /outside allowed_refs/);
});
