import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { FileProjectArchitectureSource } from '../dist/architecture-source.js';
import { JsonProjectRegistry } from '../dist/project-registry.js';
import { registerProjectsTools } from '../dist/shell/mcp/register-projects.js';
import { inlineJsonResult } from '../dist/shell/mcp/shared.js';
import { readMemoryControlData } from '../dist/memory-control-plane.js';
import { renderArchitectureCognitiveMapMarkdown, architectureCognitiveMapFingerprint } from '../dist/archify/architecture-cognitive-map.js';
import { createTestRoot } from './test-isolation.mjs';
import { completedJob, timelineProjectModel } from './fakes/project-model-fakes.mjs';

test('bootstrap MCP next/submit, Project Map links, rejection fences, dry runs, rebuild and audit', async () => {
  const root = await createTestRoot('map-bootstrap-e2e-');
  const server = new McpServer({ name: 'map-bootstrap-test', version: '1.0.0' });
  const client = new Client({ name: 'map-bootstrap-test', version: '1.0.0' });
  try {
    const projectDir = join(root, 'repos', 'alpha');
    await mkdir(join(projectDir, 'docs', 'architecture'), { recursive: true });
    await writeFile(join(projectDir, 'ARCHITECTURE.md'), '# Alpha\nCapture pipeline and dashboard. Bounded queue belongs to the core layer.\n' + 'Architecture context. '.repeat(900));
    await writeFile(join(projectDir, 'docs', 'architecture', 'capture.md'), '# Capture\nValidation process.');
    const architecture = new FileProjectArchitectureSource({ rootDir: join(root, 'repos'), managedRootDir: join(root, 'managed') });
    const managed = await architecture.inspectProjectArchitecture({ accountId: 'acct', projectId: 'alpha' });
    await architecture.writeProjectArchitecture({ accountId: 'acct', projectId: 'alpha', expectedPath: managed.path,
      expectedFingerprint: managed.fingerprint, content: '# Managed Hard Architecture\nAlpha owns Capture.' });
    const projects = new JsonProjectRegistry(join(root, 'projects.json'));
    await projects.create('acct', { projectId: 'alpha', name: 'Alpha', description: 'Test bootstrap', aliases: ['alpha-alias'] });
    await projects.create('acct', { projectId: 'other', name: 'Other', description: 'Foreign project' });
    const model = timelineProjectModel();
    const jobs = model.revisions.map((revision, i) => completedJob({ job_id: 'revision-' + i, result_id: revision.memory_id,
      result_content: revision.content, result_committed_at: revision.committed_at }));
    jobs.push(completedJob({ job_id: 'foreign', account_id: 'other-account', result_content: model.l2[0].body }));
    await mkdir(join(root, 'distillation'));
    await writeFile(join(root, 'distillation', 'jobs.json'), JSON.stringify({ version: 2, jobs }));
    let requests = 0;
    const runtime = { accountId: 'acct', userId: 'user-acct', architecture, projects, memoryClient: {
      async viewerGet(path) {
        requests++;
        const url = new URL(path, 'http://test.invalid');
        assert.equal(url.pathname, '/api/v1/l2');
        assert.equal(url.searchParams.get('projectId'), 'alpha');
        assert.equal(url.searchParams.get('userId'), 'user-acct');
        assert.equal(url.searchParams.get('includeBody'), '1');
        assert.equal(url.searchParams.get('status'), 'activated');
        return { items: structuredClone(model.l2), total: 1, hasNext: false };
      }
    } };
    registerProjectsTools(server, { runtime, context: { stateRoot: root, inlineJsonResult, jsonResult: inlineJsonResult } });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const listed = await client.listTools();
    const projectTool = listed.tools.find(tool => tool.name === 'litsan_project');
    assert.ok(projectTool.inputSchema.properties.action.enum.includes('map_bootstrap_next'));
    assert.ok(projectTool.inputSchema.properties.action.enum.includes('map_bootstrap_submit'));
    const call = (action, args = {}) => client.callTool({ name: 'litsan_project', arguments: { action, project: 'alpha', ...args } });
    const json = async (action, args) => {
      const response = await call(action, args);
      assert.ok(!response.isError, JSON.stringify(response));
      return JSON.parse(response.content[0].text);
    };
    const rejects = async (action, args, pattern) => {
      const response = await call(action, args);
      assert.equal(response.isError, true);
      assert.match(response.content.map(item => item.text).join(''), pattern);
    };
    const pkg = await json('map_bootstrap_next', { project: 'alpha-alias' });
    assert.equal(pkg.project, 'alpha');
    assert.equal(pkg.mode, 'bootstrap');
    assert.equal(pkg.base_fingerprint, architectureCognitiveMapFingerprint(null));
    assert.equal(pkg.architecture_sources.length, 3);
    assert.ok(pkg.architecture_sources.some(source => source.content.length > 16_000));
    assert.ok(pkg.architecture_sources.some(source => source.path.startsWith('memhub-managed/')));
    assert.ok(pkg.architecture_sources.some(source => source.path.startsWith('project-repo/')));
    assert.equal(pkg.l2_events.length, 3);
    assert.equal(pkg.l2_events[0].date, '2026-10-03');
    assert.ok(!pkg.allowed_refs.some(ref => ref.includes('foreign')));
    const doc = pkg.architecture_sources.find(source => source.path === 'project-repo/ARCHITECTURE.md');
    const docRef = doc.sections[0].ref;
    assert.ok(pkg.allowed_refs.includes(docRef));
    const candidate = { nodes: [
      { id: 'alpha', kind: 'project', label: 'Alpha', summary: 'Alpha project', parent_id: null, evidence_refs: [docRef], confidence: 0.9 },
      { id: 'capture', kind: 'domain', label: 'Capture', summary: 'Capture pipeline', parent_id: 'alpha', evidence_refs: [docRef], confidence: 0.8 }
    ], edges: [{ from: 'alpha', to: 'capture', type: 'contains', evidence_refs: [docRef], confidence: 0.8 }],
    timeline_links: pkg.l2_events.map(event => ({ event_date: event.date, event_title: event.title,
      architecture_refs: ['capture'], architecture_level: 'domain', change_kind: 'refine', evidence_refs: [event.evidence_ref], confidence: 0.7 })) };
    candidate.facet_vocab = { layer: ['core'] };
    candidate.nodes.push({ id: 'bounded-queue', kind: 'mechanism', label: 'Bounded queue', summary: 'Queue admission limit', parent_id: 'capture',
      evidence_refs: [docRef], confidence: 0.9, facets: { layer: 'core', layer_evidence_refs: [docRef] },
      facts: [{ key: 'limit', value: 12, unit: 'items', evidence_refs: [docRef], confidence: 0.9 }] });
    const submit = { base_fingerprint: pkg.base_fingerprint, architecture_map: candidate, source_harness: 'test-harness', model: 'test-model' };
    const unevidenced = structuredClone(candidate);
    delete unevidenced.nodes.at(-1).facets.layer_evidence_refs;
    await rejects('map_bootstrap_submit', { ...submit, architecture_map: unevidenced }, /layer needs evidence/);
    const unknownAnchor = structuredClone(candidate);
    unknownAnchor.nodes.at(-1).facets.layer_evidence_refs = [doc.ref + '#unknown'];
    await rejects('map_bootstrap_submit', { ...submit, architecture_map: unknownAnchor }, /outside allowed_refs/);
    const noMap = await architecture.inspectProjectCognitiveMap({ accountId: 'acct', projectId: 'alpha' });
    await json('map_bootstrap_submit', { ...submit, dry_run: true });
    await assert.rejects(readFile(noMap.path), { code: 'ENOENT' });
    await assert.rejects(readFile(join(dirname(noMap.path), 'COGNITIVE_MAP.bootstrap.jsonl')), { code: 'ENOENT' });
    await rejects('map_bootstrap_submit', { ...submit, base_fingerprint: 'stale' }, /Stale base_fingerprint/);
    const foreign = structuredClone(candidate);
    foreign.nodes[0].evidence_refs = ['l2:foreign:job'];
    await rejects('map_bootstrap_submit', { ...submit, architecture_map: foreign }, /l2:foreign:job/);
    await rejects('map_bootstrap_next', { workspace_project: 'other' }, /conflict|disagree/i);
    const repositoryPath = join(projectDir, 'ARCHITECTURE.md');
    const originalDoc = await readFile(repositoryPath, 'utf8');
    await writeFile(repositoryPath, '# Changed before submit');
    await rejects('map_bootstrap_submit', submit, /outside allowed_refs/);
    await writeFile(repositoryPath, originalDoc);
    const first = await json('map_bootstrap_submit', submit);
    assert.equal(first.ok, true);
    assert.equal(first.nodes, 3);
    assert.equal(first.edges, 1);
    assert.equal(first.timeline_links, 3);
    assert.equal(first.provenance.architecture_refs, 1);
    assert.equal(first.provenance.l2_refs, 1);
    const stored = JSON.parse(await readFile(noMap.path, 'utf8'));
    assert.equal(stored.authority, 'derived');
    assert.equal(stored.abstraction_cutoff, 'mechanism');
    assert.deepEqual(stored.nodes[2].facts, candidate.nodes[2].facts);
    assert.deepEqual(stored.facet_vocab, candidate.facet_vocab);
    assert.match(renderArchitectureCognitiveMapMarkdown(stored), /Bounded queue \[core\]/);
    assert.match(renderArchitectureCognitiveMapMarkdown(stored), /limit = 12 items/);
    assert.deepEqual(stored.source_evidence_refs, [docRef, pkg.l2_events[0].evidence_ref]);
    const visual = await readMemoryControlData({ stateRoot: root, runtime, kind: 'visualization', projectId: 'alpha', projects: await projects.list('acct') });
    assert.equal(visual.architecture.nodes.length, 3);
    assert.ok(visual.architecture.graph.nodes.length >= 3);
    assert.equal(visual.architecture.graph.nodes[2].facets.layer, 'core');
    assert.deepEqual(visual.architecture.graph.nodes[2].facts, candidate.nodes[2].facts);
    assert.ok(visual.state.events.every(event => event.architecture_refs.includes('capture')));
    assert.ok(visual.quality, 'internal quality payload retained');
    await rejects('map_bootstrap_next', {}, /already exists.*rebuild=true/);
    await rejects('map_bootstrap_submit', submit, /already exists.*rebuild=true/);
    await rejects('map_bootstrap_submit', { ...submit, rebuild: true }, /Stale base_fingerprint/);
    // Remove a source: only an explicit rebuild may retain its previous-map citations.
    await writeFile(join(projectDir, 'ARCHITECTURE.md'), '# Alpha changed contract');
    const rebuild = await json('map_bootstrap_next', { rebuild: true });
    assert.equal(rebuild.mode, 'rebuild');
    assert.deepEqual(rebuild.current_map, stored, 'authorized rebuild receives the complete fenced map');
    assert.ok(rebuild.allowed_refs.includes(docRef));
    assert.ok(!rebuild.architecture_sources.some(source => source.ref === docRef), 'old ref is admitted only through previous map');
    const beforeDry = await readFile(noMap.path, 'utf8');
    const auditPath = join(dirname(noMap.path), 'COGNITIVE_MAP.bootstrap.jsonl');
    const auditBeforeDry = await readFile(auditPath, 'utf8');
    const rebuildArgs = { ...submit, rebuild: true, base_fingerprint: rebuild.base_fingerprint };
    await json('map_bootstrap_submit', { ...rebuildArgs, dry_run: true });
    assert.equal(await readFile(noMap.path, 'utf8'), beforeDry);
    assert.equal(await readFile(auditPath, 'utf8'), auditBeforeDry);
    candidate.summary = 'Explicit rebuilt map';
    const second = await json('map_bootstrap_submit', rebuildArgs);
    assert.equal(second.fingerprint_before, first.fingerprint_after);
    assert.notEqual(second.fingerprint_after, second.fingerprint_before);
    const translationBase = await json('map_bootstrap_next', { rebuild: true });
    const translated = structuredClone(translationBase.current_map);
    translated.nodes[1].label += ' / 采集';
    translated.nodes[1].summary = 'EN: ' + translated.nodes[1].summary + ' ZH: 采集流水线。';
    const translationArgs = { ...submit, rebuild: true, base_fingerprint: translationBase.base_fingerprint, architecture_map: translated };
    await json('map_bootstrap_submit', { ...translationArgs, dry_run: true });
    await json('map_bootstrap_submit', translationArgs);
    const afterTranslation = JSON.parse(await readFile(noMap.path, 'utf8'));
    assert.equal(afterTranslation.nodes[1].label, translated.nodes[1].label);
    assert.equal(afterTranslation.nodes[1].summary, translated.nodes[1].summary);
    afterTranslation.nodes[1].label = translationBase.current_map.nodes[1].label;
    afterTranslation.nodes[1].summary = translationBase.current_map.nodes[1].summary;
    afterTranslation.generated_at = translationBase.current_map.generated_at;
    assert.deepEqual(afterTranslation, translationBase.current_map, 'translation preserves the full map and provenance');
    await rejects('map_bootstrap_submit', translationArgs, /Stale base_fingerprint/);
    const audit = (await readFile(auditPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(audit.length, 3);
    assert.deepEqual(audit.map(line => line.mode), ['bootstrap', 'rebuild', 'rebuild']);
    assert.ok(audit.every(line => line.source_harness === 'test-harness' && line.model === 'test-model' && Number.isFinite(Date.parse(line.timestamp))));
    assert.ok(requests > 0);
    assert.ok(!(await readdir(dirname(noMap.path))).some(file => file.includes('.tmp-')));
  } finally {
    await client.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
