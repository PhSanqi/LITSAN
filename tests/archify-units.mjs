import assert from "node:assert/strict";
import test from "node:test";
import { rm, readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { buildMemoryVisualization, projectMemoryVisualization, projectArchitectureGraph } from "../dist/memory-visualization.js";
import {
  parseArchitectureCognitiveMapCandidate, buildArchitectureCognitiveMap, architectureCognitiveMapFingerprint,
  architectureCognitiveMapEvidenceRefs, renderArchitectureCognitiveMapMarkdown
} from "../dist/architecture-cognitive-map.js";
import { readMemoryControlData } from "../dist/memory-control-plane.js";
import { buildProjectModel } from "../dist/shell/archify/project-model.js";
import { emptyProjectModel, timelineProjectModel, architectureCandidate, fakeProjectModelBuilderDeps,
  completedJob, projectModelStateRoot, graphProjectModel } from "./fakes/project-model-fakes.mjs";

const oldInput = model => ({ projectId: model.projectId ?? undefined, l2: model.l2, revisions: model.revisions,
  architectureMap: model.architecture.map, architectureFingerprint: model.architecture.fingerprint, todos: model.todos });

test("Archify package imports resolve and compatibility shims preserve every runtime export", async () => {
  for (const name of ["memory-visualization", "architecture-cognitive-map"]) {
    const legacy = await import(`../dist/${name}.js`);
    const packaged = await import(`../dist/archify/${name}.js`);
    assert.deepEqual(Object.keys(legacy), Object.keys(packaged));
    for (const key of Object.keys(legacy)) assert.equal(legacy[key], packaged[key]);
  }
  const { buildArchitectureGraph } = await import("../dist/archify/architecture-graph.js");
  const model = graphProjectModel();
  assert.deepEqual(buildArchitectureGraph(model, projectMemoryVisualization(model).architecture.nodes), projectArchitectureGraph(model));
});

test("architecture graph is deterministic, integer banded, centred, labelled and projection-only", () => {
  const model = graphProjectModel(), before = structuredClone(model), graph = projectArchitectureGraph(model);
  assert.deepEqual(graph, projectArchitectureGraph(model));
  assert.deepEqual(model, before);
  assert.deepEqual(graph.levels, ["project", "domain", "capability", "process", "method"]);
  const byId = new Map(graph.nodes.map(node => [node.id, node]));
  for (const node of graph.nodes) {
    assert.ok(node.x - 104 >= 140, "band label gutter stays clear of every card");
    assert.equal(node.level, graph.levels.indexOf(node.kind));
    assert.equal(node.y, 68 + node.level * 120);
    assert.ok(Number.isInteger(node.x) && Number.isInteger(node.y));
    assert.equal(node.depth, node.parent_id ? byId.get(node.parent_id).depth + 1 : 0);
    const children = graph.nodes.filter(child => child.parent_id === node.id);
    if (children.length) assert.equal(node.x, Math.round(children.reduce((sum, child) => sum + child.x, 0) / children.length));
  }
  assert.deepEqual(graph.nodes.filter(n => n.kind === "method").map(n => n.x), [244, 484, 724, 964, 1204, 1444]);
  assert.equal(graph.relations.length, 6);
  assert.ok(graph.relations.every(edge => edge.type !== "contains" && edge.from_label === byId.get(edge.from).label && edge.to_label === byId.get(edge.to).label));
  const payload = projectMemoryVisualization(model);
  assert.deepEqual(graph, payload.architecture.graph);
  for (const node of graph.nodes) assert.deepEqual(node.event_ids, payload.architecture.nodes.find(n => n.id === node.id).event_ids);
  assert.equal(graph.nodes.find(n => n.id === "decode").event_ids.length, 1);
  assert.equal(graph.nodes.find(n => n.id === "alpha").latest_change_kind, null);
});

test("architecture graph counts timeline links, latest date then input order, including map-only projects", () => {
  const model = graphProjectModel(), links = model.architecture.map.timeline_links;
  links.push({ ...links[0], event_date: "2026-10-20", change_kind: "remove" },
    { ...links[0], event_date: "2026-10-20", change_kind: "replace" },
    { ...links[0], event_date: "2026-10-02", change_kind: "refine" });
  const node = projectArchitectureGraph(model).nodes.find(n => n.id === "decode");
  assert.equal(node.change_count, 4);
  assert.equal(node.latest_change_kind, "replace");
  model.l2 = [];
  const payload = projectMemoryVisualization(model);
  assert.equal(payload.state.events.length, 0);
  assert.equal(payload.architecture.graph.nodes.length, 13);
  assert.deepEqual(projectArchitectureGraph(model), payload.architecture.graph);
  assert.deepEqual(payload.architecture.graph.nodes.find(n => n.id === "decode").event_ids, []);
  assert.equal(projectArchitectureGraph(emptyProjectModel("alpha")), null);
  assert.equal(projectArchitectureGraph({ ...model, projectId: null }), null);
  assert.equal(projectArchitectureGraph({ ...model, projectId: "foreign" }), null);
});

test("architecture graph orders siblings by order then label independent of input order", () => {
  const model = graphProjectModel();
  const nodes = model.architecture.map.nodes;
  for (const id of ["decode", "normalize", "persist"]) nodes.find(n => n.id === id).order = 1;
  nodes.reverse();
  const graph = projectArchitectureGraph(model);
  assert.deepEqual(graph.nodes.filter(n => n.parent_id === "validate").sort((a, b) => a.x - b.x).map(n => n.label), ["Decode", "Normalize", "Persist"]);
});

test("standalone architecture graph shares canonical identities, matching and revision ordering without projecting todos", () => {
  const model = timelineProjectModel(true);
  model.l2.push({ memoryId: "second", content: model.l2[0].body });
  model.l2[0].body += "\n\n## 2026-10-02：[Capture] v2 deployed\nRepeated canonical section.";
  model.architecture.map.timeline_links.push({ ...model.architecture.map.timeline_links[0], architecture_refs: ["alpha", "capture"] });
  const expected = projectMemoryVisualization(model).architecture.graph;
  Object.defineProperty(model, "todos", { get() { throw new Error("standalone graph must not build the full visualization"); } });
  assert.deepEqual(projectArchitectureGraph(model), expected);
});

test("architecture.graph is the only addition to the Phase 6 fixture payload", async () => {
  const payload = projectMemoryVisualization(timelineProjectModel(true));
  delete payload.architecture.graph;
  delete payload.quality;
  const phase6 = await readFile(new URL("./fakes/phase6-project-map-output.json", import.meta.url), "utf8");
  assert.equal(JSON.stringify(payload), JSON.stringify(JSON.parse(phase6)));
});

test("architecture graph projects 300 nodes and 800 typed edges under 200 ms", () => {
  const model = graphProjectModel(), map = model.architecture.map;
  map.nodes = map.nodes.slice(0, 1);
  for (let i = 1; i < 300; i++) map.nodes.push({ ...map.nodes[0], id: `n${i}`, kind: "domain", label: `Node ${i}`, parent_id: "alpha", order: i });
  map.edges = Array.from({ length: 800 }, (_, i) => ({ from: `n${i % 299 + 1}`, to: `n${(i + 1) % 299 + 1}`, type: ["flows_to", "depends_on", "uses", "constrained_by"][i % 4], confidence: 0.9, evidence_refs: [] }));
  map.timeline_links = [];
  const start = performance.now(), graph = projectArchitectureGraph(model), elapsed = performance.now() - start;
  assert.equal(graph.nodes.length, 300);
  assert.equal(graph.relations.length, 800);
  assert.ok(elapsed < 200, `projection took ${elapsed.toFixed(1)} ms`);
  const leaves = graph.nodes.filter(node => node.parent_id === "alpha").sort((a, b) => a.x - b.x);
  assert.equal(graph.nodes[0].x, Math.round(leaves.reduce((sum, node) => sum + node.x, 0) / leaves.length));
  for (let i = 1; i < leaves.length; i++) assert.ok(leaves[i].x - leaves[i - 1].x >= 240, "leaf cards never overlap");
  for (const node of graph.nodes) {
    assert.ok(node.x - 104 >= 140 && node.x + 104 <= graph.width, "SVG width covers every card");
    assert.ok(node.y - 58 >= 0 && node.y + 36 <= graph.height, "SVG height covers cards and fold controls");
  }
});

test("empty/no-project model requires selection and matches the legacy empty payload", () => {
  const payload = projectMemoryVisualization(emptyProjectModel());
  assert.deepStrictEqual(payload, buildMemoryVisualization({ l2: [] }));
  assert.equal(payload.requires_project, true);
  assert.equal(payload.project_id, null);
  assert.deepEqual(payload.state.events, []);
  assert.deepEqual(payload.drilldown, { revisions: [], todos: [] });
  assert.equal(payload.archify.exportable, false);
  const populated = timelineProjectModel(true);
  assert.deepEqual(projectMemoryVisualization({ ...populated, projectId: null }), payload);
  assert.deepEqual(buildMemoryVisualization({ ...oldInput(populated), projectId: "  " }), payload);
  const selected = projectMemoryVisualization(emptyProjectModel("alpha"));
  assert.deepEqual(Object.keys(payload.architecture), Object.keys(selected.architecture));
  assert.equal(selected.requires_project, false);
  assert.equal(selected.stats.events, 0);
  assert.equal(selected.architecture.available, false);
});

test("canonical L2 owns events, cumulative revisions attach provenance, and superseded memories stay in drilldown", () => {
  const model = timelineProjectModel();
  const before = structuredClone(model);
  const payload = projectMemoryVisualization(model);
  assert.deepEqual(model, before, "projection does not mutate its read model");
  assert.deepEqual(payload.stats, { events: 3, workstreams: 2, l2_revisions: 3, versions: 2,
    pending_todos: 1, architecture_nodes: 0, architecture_links: 0 });
  assert.deepEqual(payload.state.current_l2_memory_ids, ["timeline-alpha"]);
  assert.equal(payload.state.latest_l2_revision_at, "2026-10-03T09:00:00.000Z");
  assert.deepEqual(payload.state.workstreams.map(stream => [stream.label, stream.event_count]), [["Capture", 2], ["Dashboard", 1]]);
  assert.equal(payload.state.events[0].revision_count, 2);
  assert.equal(payload.state.events[0].first_revision_ref, "l2:timeline-alpha:revision-1");
  assert.equal(payload.state.events[0].latest_revision_ref, "l2:timeline-alpha:revision-2");
  assert.equal(payload.state.events.at(-1).current_head, true);
  assert.equal(payload.state.current_head_event_id, payload.state.events.at(-1).id);
  assert.equal(payload.state.events.some(event => event.memory_id === "timeline-stale"), false);
  assert.deepEqual(payload.drilldown.revisions[0].event_ids, []);
  assert.equal(payload.drilldown.revisions[0].ref, "l2:timeline-stale:stale");
  assert.deepEqual(payload.drilldown.revisions.map(revision => revision.current), [true, false, true]);
  assert.deepEqual(payload.drilldown.todos, [{ id: "pending", text: "Finish browser acceptance", status: "pending",
    created_at: "2026-10-03T08:30:00.000Z", updated_at: "2026-10-03T08:30:00.000Z", completed_at: null }]);
  assert.equal(payload.architecture.available, false);
});

test("architecture timeline links attach event ids and surface the fingerprint and contract", () => {
  const model = timelineProjectModel(true);
  const payload = projectMemoryVisualization(model);
  const event = payload.state.events.find(event => event.title === "[Capture] v2 deployed");
  assert.deepEqual(event.architecture_refs, ["capture"]);
  assert.equal(event.architecture_level, "domain");
  assert.equal(event.architecture_change_kind, "refine");
  assert.deepEqual(payload.architecture.nodes.find(node => node.id === "capture").event_ids, [event.id]);
  assert.deepEqual(payload.architecture.nodes.find(node => node.id === "alpha").event_ids, []);
  assert.equal(payload.architecture.available, true);
  assert.equal(payload.architecture.fingerprint, model.architecture.fingerprint);
  assert.equal(payload.architecture.contract, model.architecture.map.contract);
  assert.equal(payload.stats.architecture_nodes, 2);
  assert.equal(payload.stats.architecture_links, 1);
  assert.equal(projectMemoryVisualization({ ...model, projectId: "foreign" }).architecture.available, false);
});

for (const withArchitecture of [false, true]) {
  test(`legacy wrapper equals the ProjectModel projection (architecture=${withArchitecture})`, () => {
    const model = timelineProjectModel(withArchitecture);
    assert.deepStrictEqual(buildMemoryVisualization(oldInput(model)), projectMemoryVisualization(model));
    assert.equal(JSON.stringify(buildMemoryVisualization(oldInput(model))), JSON.stringify(projectMemoryVisualization(model)));
  });
}

test("cognitive map parser rejects two roots, cyclic parents and invalid abstraction levels", () => {
  const candidate = architectureCandidate();
  assert.throws(() => parseArchitectureCognitiveMapCandidate({ ...candidate,
    nodes: [...candidate.nodes, { ...candidate.nodes[0], id: "second-root" }] }), /exactly one project root/);
  assert.throws(() => parseArchitectureCognitiveMapCandidate({ ...candidate,
    nodes: [candidate.nodes[0], { ...candidate.nodes[1], parent_id: "child" },
      { ...candidate.nodes[1], id: "child", kind: "capability", parent_id: "capture" }] }), /parent abstraction level|acyclic/);
  assert.throws(() => parseArchitectureCognitiveMapCandidate({ ...candidate,
    nodes: [candidate.nodes[0], { ...candidate.nodes[1], kind: "function" }] }), /kind must be one of/);
  assert.throws(() => parseArchitectureCognitiveMapCandidate({ ...candidate,
    timeline_links: [{ ...candidate.timeline_links[0], architecture_level: "method" }] }), /architecture_level must match/);
});

test("cognitive map builds with deduplicated evidence, stable fingerprints and nonempty markdown", () => {
  const candidate = parseArchitectureCognitiveMapCandidate(architectureCandidate());
  const input = { projectId: "alpha", candidate, sourceEvidenceRefs: ["l1:turn-1", "l1:turn-2", "l1:turn-1"],
    generatedAt: "2026-10-03T10:00:00.000Z" };
  const map = buildArchitectureCognitiveMap(input);
  assert.equal(map.contract, "memhub-architecture-cognitive-map-v1");
  assert.deepEqual(map.source_evidence_refs, ["l1:turn-1", "l1:turn-2"]);
  assert.deepEqual(architectureCognitiveMapEvidenceRefs(map), ["l1:turn-1", "l1:turn-2"]);
  assert.deepEqual(architectureCognitiveMapEvidenceRefs(null), []);
  assert.equal(architectureCognitiveMapFingerprint(map), architectureCognitiveMapFingerprint(buildArchitectureCognitiveMap(input)));
  assert.match(architectureCognitiveMapFingerprint(null), /^[a-f0-9]{64}$/);
  assert.notEqual(architectureCognitiveMapFingerprint(map), architectureCognitiveMapFingerprint({ ...map, project_id: "other" }));
  assert.match(renderArchitectureCognitiveMapMarkdown(map), /\[project\] Alpha/);
  assert.match(renderArchitectureCognitiveMapMarkdown(map), /Capture.*refine/);
});

test("builder filters jobs by completion, L2 result, account/project, content, id and retirement while preserving ledger order", async t => {
  const jobs = [
    completedJob(),
    completedJob({ job_id: "alias", project_id: "legacy-alpha", created_at: "2026-10-03T08:00:00.000Z", result_committed_at: undefined }),
    completedJob({ job_id: "fallback", created_at: "2026-10-02T08:00:00.000Z", result_committed_at: undefined, completed_at: undefined }),
    ...["pending", "leased", "failed"].map(status => completedJob({ job_id: status, status })),
    completedJob({ job_id: "foreign", project_id: "other" }), completedJob({ job_id: "account", account_id: "other" }),
    completedJob({ job_id: "no-project", project_id: null }), completedJob({ job_id: "empty", result_content: " \n " }),
    completedJob({ job_id: "no-content", result_content: undefined }), completedJob({ job_id: "no-id", result_id: "" }),
    completedJob({ job_id: "target", target: "l3" }), completedJob({ job_id: "result-kind", result_kind: "l3" }),
    completedJob({ job_id: "retired", result_retirement: "archived" })
  ];
  const stateRoot = await projectModelStateRoot(jobs);
  t.after(() => rm(stateRoot, { recursive: true, force: true }));
  const fixture = timelineProjectModel(true);
  const deps = fakeProjectModelBuilderDeps(fixture);
  const model = await buildProjectModel(deps, { stateRoot, projectId: "alpha", l2: fixture.l2, todos: fixture.todos });
  assert.ok(Number.isFinite(Date.parse(model.as_of)));
  assert.deepEqual(model.activity, { latest_l1_at: null, pending_l2_jobs: 2, pending_l2_turns: 0, oldest_pending_at: "2026-10-01T08:00:00.000Z" });
  assert.equal(model.node_flags, null);
  assert.deepEqual(model, { ...fixture, as_of: model.as_of, activity: model.activity, node_flags: null, revisions: [
    { ref: "l2:timeline-alpha:alias", layer: "L2", memory_id: "timeline-alpha", project_id: "legacy-alpha",
      committed_at: "2026-10-01T08:30:00.000Z", content: "# Timeline", evidence_refs: ["l1:turn-1"] },
    { ref: "l2:timeline-alpha:fallback", layer: "L2", memory_id: "timeline-alpha", project_id: "alpha",
      committed_at: "2026-10-01T09:00:00.000Z", content: "# Timeline", evidence_refs: ["l1:turn-1"] },
    { ref: "l2:timeline-alpha:job-1", layer: "L2", memory_id: "timeline-alpha", project_id: "alpha",
      committed_at: "2026-10-01T08:45:00.000Z", content: "# Timeline", evidence_refs: ["l1:turn-1"] }
  ] });
  assert.deepEqual(deps.calls, [
    { method: "storageIds", accountId: "acct", projectId: "alpha" },
    { method: "inspectProjectCognitiveMap", accountId: "acct", projectId: "alpha" }
  ]);
});

test("builder handles an empty ledger and absent architecture", async t => {
  const stateRoot = await projectModelStateRoot([]);
  t.after(() => rm(stateRoot, { recursive: true, force: true }));
  const model = await buildProjectModel(fakeProjectModelBuilderDeps(), { stateRoot, projectId: "alpha", l2: [], todos: [], as_of: "2026-10-27T00:00:00Z" });
  assert.deepEqual(model, { ...emptyProjectModel("alpha"), as_of: "2026-10-27T00:00:00Z", node_flags: null,
    activity: { latest_l1_at: null, pending_l2_jobs: 0, pending_l2_turns: 0, oldest_pending_at: null } });
});

test("shell preserves the L2 read barrier, selected-project todos and response shape", async t => {
  const fixture = timelineProjectModel(true);
  const stateRoot = await projectModelStateRoot([]);
  t.after(() => rm(stateRoot, { recursive: true, force: true }));
  const deps = fakeProjectModelBuilderDeps(fixture);
  let l2ReadComplete = false;
  const inspect = deps.architecture.inspectProjectCognitiveMap;
  const runtime = {
    ...deps, userId: "user",
    memoryClient: { async viewerGet(path) {
      assert.match(path, /^\/api\/v1\/l2\?/);
      await new Promise(resolve => setImmediate(resolve));
      l2ReadComplete = true;
      return { items: fixture.l2, total: 1 };
    } },
    architecture: { async inspectProjectCognitiveMap(scope) {
      assert.equal(l2ReadComplete, true);
      return inspect(scope);
    } }
  };
  const payload = await readMemoryControlData({ stateRoot, runtime, kind: "visualization", projectId: "alpha",
    projects: [{ projectId: " ALPHA ", todos: fixture.todos }, { projectId: "other", todos: [{ id: "foreign", text: "Foreign", status: "pending" }] }] });
  const expected = projectMemoryVisualization({ ...fixture, revisions: [], node_flags: null });
  assert.deepEqual(payload, { ...expected, items: expected.state.events, total: expected.state.events.length });
  assert.deepEqual(deps.calls.map(call => call.method), ["storageIds", "inspectProjectCognitiveMap"]);
  const noProject = await readMemoryControlData({ stateRoot, runtime: {}, kind: "visualization", projects: [] });
  const empty = projectMemoryVisualization(emptyProjectModel());
  assert.deepEqual(noProject, { ...empty, items: [], total: 0 });
});

// Scorecard regressions intentionally share canonical ProjectModel fixtures.
const { projectMapQuality } = await import('../dist/archify/project-map-quality.js');
const qualityFor = model => projectMapQuality(model, projectMemoryVisualization(model));
const componentById = quality => Object.fromEntries(quality.components.map(component => [component.id, component]));

test('quality formulas cover evidence, all L2 events, structure and confidence', () => {
  const model = timelineProjectModel(true), map = model.architecture.map;
  map.nodes[0].evidence_refs = [];
  map.nodes[1].confidence = 0.5;
  map.edges.push({ from: 'alpha', to: 'capture', type: 'uses', evidence_refs: [], confidence: 1 });
  const quality = qualityFor(model), components = componentById(quality);
  assert.equal(components.evidence_coverage.value, 1 / 3);
  assert.equal(components.evidence_coverage.score, 33);
  assert.equal(components.timeline_coverage.value, 1 / 3);
  assert.equal(components.timeline_coverage.score, 33);
  assert.equal(components.freshness.score, 100);
  assert.equal(components.structure.score, 95);
  assert.equal(components.confidence.value, 0.75);
  assert.equal(components.confidence.score, 75);
  assert.equal(quality.score, 62);
  assert.equal(quality.grade, 'fair');
  assert.equal(quality.components.reduce((sum, component) => sum + component.weight, 0), 1);
  assert.equal(quality.gaps.find(gap => gap.kind === 'node_without_evidence').ref, 'alpha');
  assert.equal(quality.gaps.find(gap => gap.kind === 'low_confidence_node').severity, 'low');
  assert.equal(quality.gaps.find(gap => gap.kind === 'empty_branch').ref, 'capture');
});

test('quality omits timeline component with no events and renormalises remaining weights', () => {
  const model = graphProjectModel();
  model.l2 = [];
  const quality = qualityFor(model), components = componentById(quality);
  assert.equal(quality.components.length, 4);
  assert.equal(components.timeline_coverage, undefined);
  assert.equal(components.evidence_coverage.weight, Number((0.25 / 0.75).toFixed(4)));
  assert.ok(Math.abs(quality.components.reduce((sum, component) => sum + component.weight, 0) - 1) <= 0.0001);
  assert.equal(quality.score, Math.round((100 * 0.25 + 100 * 0.2 + 100 * 0.15 + (11.3 / 13 * 100) * 0.15) / 0.75));
  assert.equal(quality.grade, 'good');
});

test('quality no-map and foreign-map states are unavailable with one explicit gap', () => {
  for (const model of [emptyProjectModel(), timelineProjectModel(), { ...graphProjectModel(), projectId: 'foreign' }]) {
    const quality = qualityFor(model);
    assert.equal(quality.score, 0);
    assert.equal(quality.grade, 'unavailable');
    assert.deepEqual(quality.components, []);
    assert.equal(quality.gaps.length, 1);
    assert.equal(quality.gaps[0].kind, 'stale_map');
    assert.equal(quality.gaps[0].reason_en, 'no architecture map yet');
    assert.equal(quality.computed_at_basis.map_generated_at, null);
    assert.equal(quality.computed_at_basis.map_fingerprint, null);
  }
});

test('quality freshness is linear over 30 days and uses revision timestamps, never wall time', () => {
  const model = timelineProjectModel(true);
  model.architecture.map.generated_at = '2026-09-18T08:00:00.000Z';
  let quality = qualityFor(model);
  assert.equal(componentById(quality).freshness.score, 50);
  assert.equal(componentById(quality).freshness.value, 15);
  assert.deepEqual(quality.computed_at_basis, { map_generated_at: '2026-09-18T08:00:00.000Z', latest_l2_revision_at: '2026-10-03T08:00:00.000Z', map_fingerprint: 'fixture-map-fingerprint' });
  assert.equal(quality.gaps.find(gap => gap.kind === 'stale_map').severity, 'high');
  assert.ok(quality.gaps.filter(gap => gap.kind === 'unmapped_change').every(gap => /stale map/.test(gap.reason_en)));
  model.architecture.map.generated_at = '2026-09-01T00:00:00.000Z';
  assert.equal(componentById(qualityFor(model)).freshness.score, 0);
  model.architecture.map.generated_at = '2026-10-03T08:00:00.000Z';
  assert.equal(componentById(qualityFor(model)).freshness.score, 100);
  model.revisions = [];
  model.l2[0].updatedAt = '2099-01-01T00:00:00.000Z';
  quality = qualityFor(model);
  assert.equal(componentById(quality).freshness.score, 100);
  assert.equal(quality.computed_at_basis.latest_l2_revision_at, null);
});

test('quality structure detects missing endpoints, floors penalties and confidence severity boundaries', () => {
  const model = timelineProjectModel(true), map = model.architecture.map;
  map.edges.push({ from: 'capture', to: 'missing-0', type: 'uses', evidence_refs: [], confidence: 0.5 });
  assert.equal(componentById(qualityFor(model)).structure.score, 75);
  map.edges.push(...Array.from({ length: 5 }, (_, i) => ({ from: 'capture', to: 'missing-' + (i + 1), type: 'uses', evidence_refs: [], confidence: 0.5 })));
  map.nodes[0].confidence = 0.39;
  map.nodes[1].confidence = 0.4;
  let quality = qualityFor(model);
  assert.equal(componentById(quality).structure.score, 0);
  assert.equal(quality.gaps.filter(gap => gap.kind === 'dangling_relation').length, 6);
  assert.equal(quality.gaps.find(gap => gap.kind === 'low_confidence_node' && gap.ref === 'alpha').severity, 'medium');
  assert.equal(quality.gaps.find(gap => gap.kind === 'low_confidence_node' && gap.ref === 'capture').severity, 'low');
  map.nodes[1].confidence = 0.6;
  quality = qualityFor(model);
  assert.equal(quality.gaps.filter(gap => gap.kind === 'low_confidence_node').length, 1);
  map.nodes = [];
  map.edges = [];
  quality = qualityFor(model);
  assert.equal(componentById(quality).evidence_coverage.score, 0);
  assert.equal(componentById(quality).confidence.score, 0);
  assert.equal(quality.grade, 'weak');
});

test('quality determinism, input immutability and all integer score bounds', () => {
  const model = timelineProjectModel(true), before = structuredClone(model);
  const quality = qualityFor(model);
  assert.deepEqual(quality, qualityFor(model));
  assert.deepEqual(model, before);
  assert.ok(Number.isInteger(quality.score) && quality.score >= 0 && quality.score <= 100);
  assert.ok(quality.components.every(component => Number.isInteger(component.score) && component.score >= 0 && component.score <= 100));
  assert.equal(Object.keys(projectMemoryVisualization(model)).at(-1), 'quality');
});

test('quality uses every L2 event, caps unmapped, reports todos as info, sorts severity/date/id and counts omissions', () => {
  const model = graphProjectModel();
  model.architecture.map.generated_at = '2026-10-01T00:00:00.000Z';
  model.l2 = [{ id: 'many', body: '# Timeline\n' + Array.from({ length: 65 }, (_, i) => `\n## 2026-10-${String(1 + Math.floor(i / 3)).padStart(2, '0')}：Token${i}\nBody`).join('') }];
  model.todos = Array.from({ length: 25 }, (_, i) => ({ id: 'todo-' + i, text: 'Pending ' + i, status: 'pending' }));
  model.todos.push({ id: 'done', text: 'Done', status: 'done' });
  const visual = projectMemoryVisualization(model), quality = visual.quality;
  assert.equal(visual.state.events.length, 65);
  assert.equal(componentById(quality).timeline_coverage.score, 0);
  const unmapped = quality.gaps.filter(gap => gap.kind === 'unmapped_change');
  assert.equal(unmapped.length, 50);
  assert.equal(unmapped.filter(gap => gap.severity === 'high').length, 10);
  assert.equal(unmapped[0].event_date, '2026-10-22');
  assert.equal(quality.gaps.filter(gap => gap.kind === 'open_todo').length, 0);
  assert.equal(quality.info.pending_todos, 25);
  assert.equal(quality.truncated, 15);
  const severity = { high: 0, medium: 1, low: 2 };
  const textCompare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
  assert.deepEqual(quality.gaps, [...quality.gaps].sort((a, b) => severity[a.severity] - severity[b.severity] || textCompare(b.event_date || '', a.event_date || '') || textCompare(a.id, b.id)));
  model.architecture.map.nodes.push(...Array.from({ length: 130 }, (_, i) => ({ ...model.architecture.map.nodes[0], id: 'extra-' + i, evidence_refs: [] })));
  const capped = qualityFor(model);
  assert.equal(capped.gaps.length, 100);
  assert.equal(capped.truncated, 97);
});

test('quality is strictly additive to every Phase 6/7 baseline payload field', async () => {
  const { createHash } = await import('node:crypto');
  const baseline = [
    "bda905f26b0b201eeed11b334786513a7c43ca7e7269ecd216a215ff3027d485",
    "7b1d50307a86fa2a3a2ae5bc120cf4be2d796cde086744bb3c836781c8be4184",
    "7c970a334b34e558f6f1d74f2293913251fa5a9f9e65041a7c9350426f806755",
    "c1f7cda59c17135c75fec4284bc376836e4715ff995adc6f1ad92d10f6c0319c",
    "a2ca2a9f1279e0328e391cbb106e076aef31e56f27390fa9ee58acb69d5440cf"
];
  const models = [emptyProjectModel(), emptyProjectModel('alpha'), timelineProjectModel(), timelineProjectModel(true), graphProjectModel()];
  models.forEach((model, i) => {
    const { quality, ...visual } = projectMemoryVisualization(model);
    assert.equal(visual.schema_version, 3);
    assert.equal(createHash('sha256').update(JSON.stringify(visual)).digest('hex'), baseline[i]);
    assert.deepEqual(quality, projectMapQuality(model, visual));
  });
});

test('quality grade boundaries include exactly 80 and 60', () => {
  const model = graphProjectModel(), root = model.architecture.map.nodes[0];
  root.confidence = 1;
  model.architecture.map.nodes = [root];
  model.architecture.map.edges = [];
  const event = projectMemoryVisualization(model).state.events[0];
  const visual = { state: { events: Array.from({ length: 5 }, (_, i) => ({ ...event, id: 'grade-' + i, architecture_refs: i ? [] : ['alpha'] })) } };
  let quality = projectMapQuality(model, visual);
  assert.equal(quality.score, 80);
  assert.equal(quality.grade, 'good');
  visual.state.events.forEach(event => event.architecture_refs = []);
  root.confidence = 0;
  quality = projectMapQuality(model, visual);
  assert.equal(quality.score, 60);
  assert.equal(quality.grade, 'fair');
  model.architecture.map.nodes.push({ ...root, id: 'empty', parent_id: 'alpha', kind: 'domain' });
  quality = projectMapQuality(model, visual);
  assert.equal(quality.score, 59);
  assert.equal(quality.grade, 'weak');
});

test('quality recognises precise same-day unmapped changes and tolerates annotated L2 dates', () => {
  const model = timelineProjectModel(true);
  model.architecture.map.generated_at = '2026-10-03T10:00:00.000Z';
  model.revisions = [];
  const visual = projectMemoryVisualization(model);
  const event = visual.state.events.at(-1);
  event.date_label = '2026-10-03T12:00:00.000Z';
  let quality = projectMapQuality(model, visual);
  assert.ok(quality.gaps.some(gap => gap.kind === 'stale_map'));
  assert.match(quality.gaps.find(gap => gap.ref === event.id).reason_en, /stale map/);
  event.date_label = '2026-10-03 12:00–13:00 follow-up';
  quality = projectMapQuality(model, visual);
  assert.ok(!quality.gaps.some(gap => gap.kind === 'stale_map'));
});


test('quality gap dates use canonical dates when display labels disagree', () => {
  const model = timelineProjectModel(true);
  const template = projectMemoryVisualization(model).state.events[0];
  const events = [
    { ...template, id: 'older', date: '2026-10-01', date_label: '2026-10-01–2026-10-31 annotated', architecture_refs: [] },
    { ...template, id: 'newer', date: '2026-10-02', date_label: '2026-09-01–2026-10-02 annotated', architecture_refs: [] }
  ];
  const quality = projectMapQuality(model, { state: { events } });
  assert.deepEqual(quality.gaps.filter(gap => gap.kind === 'unmapped_change').map(gap => [gap.ref, gap.event_date]),
    [['newer', '2026-10-02'], ['older', '2026-10-01']]);
  assert.deepEqual(quality, projectMapQuality(model, { state: { events } }));
});

test('quality rounds fractional freshness and renormalised weights deterministically', () => {
  const model = timelineProjectModel(true);
  model.l2 = [];
  model.architecture.map.generated_at = '2026-09-29T22:00:00.000Z';
  const quality = qualityFor(model), freshness = componentById(quality).freshness;
  assert.equal(freshness.value, 3.42);
  assert.equal(freshness.detail, 'Map lag / 地图滞后 3.4 days; L2 behind L1 / L2 落后 L1 0.0 days; drifted docs / 漂移文档 0');
  assert.deepEqual(quality.components.map(component => component.weight), [0.3333, 0.2667, 0.2, 0.2]);
  assert.deepEqual(quality, qualityFor(model));
});

test('quality v2 L1/L2 lags, backlog boundaries, missing revision and pending work', () => {
  const model = timelineProjectModel(true);
  const base = Date.parse('2026-10-03T08:00:00.000Z');
  model.activity = { latest_l1_at: null, pending_l2_jobs: 0, pending_l2_turns: 0, oldest_pending_at: null };
  for (const [days, severity, score] of [[0, null, 100], [1, null, 97], [1.01, 'medium', 97], [14, 'medium', 53], [14.01, 'high', 53], [15, 'high', 50], [30, 'high', 0], [40, 'high', 0], [-1, null, 100]]) {
    model.activity.latest_l1_at = new Date(base + days * 86400000).toISOString();
    const quality = qualityFor(model);
    assert.equal(quality.gaps.find(g => g.kind === 'l2_backlog')?.severity ?? null, severity, String(days));
    assert.equal(componentById(quality).freshness.score, score, String(days));
  }
  model.activity.latest_l1_at = new Date(base).toISOString();
  model.activity.pending_l2_jobs = 1;
  assert.equal(qualityFor(model).gaps.find(g => g.kind === 'l2_backlog').severity, 'medium');
  model.architecture.map.generated_at = new Date(base - 20 * 86400000).toISOString();
  model.activity.latest_l1_at = new Date(base + 15 * 86400000).toISOString();
  assert.equal(componentById(qualityFor(model)).freshness.value, 20);
  model.revisions = [];
  const quality = qualityFor(model);
  assert.equal(componentById(quality).freshness.score, 0);
  assert.equal(quality.gaps.find(g => g.kind === 'l2_backlog').severity, 'high');
  assert.deepEqual(quality, JSON.parse(JSON.stringify(quality)), 'finite JSON values');
});

test('quality v2 dormancy is strictly over 30 days after latest L1 or L2, independent of score', () => {
  const model = timelineProjectModel(true);
  const active = qualityFor(model);
  assert.equal(active.activity, 'active');
  const base = Date.parse('2026-10-03T08:00:00.000Z');
  model.as_of = new Date(base + 30 * 86400000).toISOString();
  assert.equal(qualityFor(model).activity, 'active');
  model.as_of = new Date(base + 30 * 86400000 + 1).toISOString();
  assert.equal(qualityFor(model).activity, 'dormant');
  assert.equal(qualityFor(model).score, active.score);
  model.activity = { latest_l1_at: new Date(base + 86400000).toISOString(), pending_l2_jobs: 0, pending_l2_turns: 0, oldest_pending_at: null };
  assert.equal(qualityFor(model).activity, 'active');
  delete model.as_of;
  assert.equal(qualityFor(model).activity, 'active');
});

test('quality v2 document drift groups paths, counts citing nodes and distinguishes changed from removed', () => {
  const model = timelineProjectModel(true), map = model.architecture.map;
  const ref = (hash, path) => `architecture-doc:alpha:${hash}:${path}`;
  const path = 'project-repo/docs/design:one.md', removed = 'memhub-managed/OLD.md';
  map.nodes[0].evidence_refs = [ref('old', path), ref('old', path), ref('gone', removed)];
  map.nodes[1].evidence_refs = [ref('old', path)];
  map.edges[0].evidence_refs = [ref('old', path)];
  const baseline = qualityFor(model);
  assert.equal(baseline.gaps.filter(g => g.kind === 'doc_drift').length, 0, 'unsupplied docs preserve legacy behavior');
  model.architecture_docs = [{ ref: ref('new', path), path }];
  const quality = qualityFor(model), gaps = quality.gaps.filter(g => g.kind === 'doc_drift');
  assert.equal(gaps.length, 2);
  assert.equal(gaps.find(g => g.ref === removed).severity, 'high');
  const changed = gaps.find(g => g.ref === path);
  assert.equal(changed.severity, 'medium');
  assert.equal(changed.label, path);
  assert.match(changed.reason_en, /2 nodes/);
  assert.equal(componentById(quality).freshness.score, 80);
  assert.match(componentById(quality).freshness.detail, /drifted docs.*2/);
  model.architecture_docs.push({ ref: ref('old', path), path }, { ref: ref('gone', removed), path: removed });
  assert.equal(qualityFor(model).gaps.filter(g => g.kind === 'doc_drift').length, 0);
  model.architecture_docs = [];
  map.source_evidence_refs = Array.from({ length: 15 }, (_, i) => ref('old', 'doc-' + i));
  assert.equal(componentById(qualityFor(model)).freshness.score, 0);
});

test('quality v2 flags retain individual ids, ignore cleared flags and todos are info only', () => {
  const model = timelineProjectModel(true);
  model.node_flags = { version: 1, flags: { capture: [
    { id: 'a', reason: 'wrong', note: 'Check it', created_at: '2026-10-04T00:00:00Z', by: 'acct' },
    { id: 'b', reason: 'unclear', note: 'Resolved', created_at: '2026-10-04T00:00:00Z', by: 'acct', cleared_at: '2026-10-05T00:00:00Z' },
    { id: 'c', reason: 'outdated', note: 'Old', created_at: '2026-10-04T00:00:00Z', by: 'acct' }
  ], absent: [{ id: 'z', reason: 'wrong', note: '', created_at: '', by: 'acct' }] } };
  const before = JSON.stringify(model), quality = qualityFor(model);
  const flags = quality.gaps.filter(g => g.kind === 'user_flag');
  assert.deepEqual(flags.map(g => g.id), ['user_flag:capture:a', 'user_flag:capture:c']);
  assert.ok(flags.every(g => g.severity === 'high' && g.label === 'Capture'));
  assert.equal(flags[0].reason_en, 'wrong: Check it');
  assert.equal(quality.info.pending_todos, 1);
  assert.equal(quality.gaps.filter(g => g.kind === 'open_todo').length, 0);
  assert.equal(JSON.stringify(model), before);
  assert.deepEqual(quality, qualityFor(structuredClone(model)));
});


test('quality v2 backlog is available before a map exists, with legacy no-map gap identity', () => {
  const model = emptyProjectModel('alpha');
  model.activity = { latest_l1_at: '2026-10-01T00:00:00Z', pending_l2_jobs: 1, pending_l2_turns: 2, oldest_pending_at: '2026-10-01T00:00:00Z' };
  model.as_of = '2026-11-01T00:00:00Z';
  const quality = qualityFor(model);
  assert.equal(quality.grade, 'unavailable');
  assert.equal(quality.activity, 'dormant');
  assert.equal(quality.gaps.find(g => g.kind === 'stale_map').id, 'stale_map:no_map');
  assert.equal(quality.gaps.find(g => g.kind === 'l2_backlog').severity, 'high');
  assert.deepEqual(quality, qualityFor(model));
});

test('quality v2 drift counts all citing nodes even if one already cites the current ref', () => {
  const model = timelineProjectModel(true), path = 'project-repo/ARCHITECTURE.md';
  model.architecture.map.nodes[0].evidence_refs = ['architecture-doc:alpha:old:' + path];
  model.architecture.map.nodes[1].evidence_refs = ['architecture-doc:alpha:new:' + path];
  model.architecture_docs = [{ ref: 'architecture-doc:alpha:new:' + path, path }];
  assert.match(qualityFor(model).gaps.find(g => g.kind === 'doc_drift').reason_en, /2 nodes/);
});

test('architecture graph derives strong coupling for mutual relations and 3+ multi-edges deterministically', () => {
  const model = graphProjectModel(), map = model.architecture.map;
  // Initially, graphProjectModel has 6 non-contains relations, none strongly coupled
  let graph = projectArchitectureGraph(model);
  assert.equal(graph.relations.filter(r => r.strong_coupling).length, 0);

  // Case 1: Mutual relations in both directions (decode -> normalize and normalize -> decode)
  map.edges.push({ from: 'normalize', to: 'decode', type: 'depends_on', confidence: 0.9, evidence_refs: [] });
  graph = projectArchitectureGraph(model);
  const mutual = graph.relations.filter(r => (r.from === 'decode' && r.to === 'normalize') || (r.from === 'normalize' && r.to === 'decode'));
  assert.equal(mutual.length, 2);
  assert.ok(mutual.every(r => r.strong_coupling === true));

  // Case 2: >= 3 non-contains relations between same pair in single direction
  map.edges = map.edges.filter(e => !(e.from === 'normalize' && e.to === 'decode'));
  map.edges.push(
    { from: 'decode', to: 'normalize', type: 'depends_on', confidence: 0.8, evidence_refs: [] },
    { from: 'decode', to: 'normalize', type: 'uses', confidence: 0.7, evidence_refs: [] }
  );
  graph = projectArchitectureGraph(model);
  const multi = graph.relations.filter(r => r.from === 'decode' && r.to === 'normalize');
  assert.equal(multi.length, 3);
  assert.ok(multi.every(r => r.strong_coupling === true));

  // Case 3: 2 non-contains relations in single direction -> NOT strongly coupled
  map.edges.pop();
  graph = projectArchitectureGraph(model);
  const pair = graph.relations.filter(r => r.from === 'decode' && r.to === 'normalize');
  assert.equal(pair.length, 2);
  assert.ok(pair.every(r => !r.strong_coupling));

  // Case 4: contains relations do not count towards strong coupling
  const root = map.nodes[0], child = map.nodes[1];
  map.edges = [
    { from: root.id, to: child.id, type: 'contains', confidence: 1, evidence_refs: [] },
    { from: child.id, to: root.id, type: 'uses', confidence: 0.9, evidence_refs: [] }
  ];
  graph = projectArchitectureGraph(model);
  assert.equal(graph.relations.length, 1);
  assert.equal(graph.relations[0].strong_coupling, undefined);
});

test('static markers: shortcut sheet, display panel, and relation colour tokens with >= 3:1 contrast', async () => {
  const { renderConsole } = await import('../dist/web-ui.js');
  const account = { account_id: 'test', username: 'test', role: 'user' };
  const html = renderConsole({
    account, accounts: [account], projects: [{ projectId: 'alpha', name: 'Alpha', aliases: [], todos: [], state: 'active' }],
    adminView: false, localControl: true, selectedAccountId: 'test'
  });

  // Shortcut sheet static markers
  assert.match(html, /architecture-shortcuts-dialog/);
  assert.match(html, /architecture-shortcuts-sheet/);
  assert.match(html, /data-shortcuts-close/);
  assert.match(html, /data-architecture-shortcuts/);
  assert.match(html, /shortcut-table/);

  // Display panel static markers
  assert.match(html, /data-map-display-toggle/);
  assert.match(html, /map-display-panel/);
  assert.match(html, /architecture-display-panel/);
  assert.match(html, /data-display-close/);
  assert.match(html, /data-display-toggle="flows_to"/);
  assert.match(html, /data-display-toggle="depends_on"/);
  assert.match(html, /data-display-toggle="uses"/);
  assert.match(html, /data-display-toggle="constrained_by"/);
  assert.match(html, /data-display-toggle="strong_coupling"/);
  assert.match(html, /data-display-toggle="layer_badges"/);
  assert.match(html, /data-display-toggle="facts"/);
  assert.match(html, /data-display-toggle="flags"/);
  assert.match(html, /data-display-toggle="timeline_links"/);

  // Zoom controls static markers
  assert.match(html, /data-architecture-zoom-in/);
  assert.match(html, /data-architecture-zoom-out/);
  assert.match(html, /data-architecture-zoom-level/);

  // Colour tokens for light and dark themes
  for (const token of ['--edge-contains', '--edge-flows-to', '--edge-depends-on', '--edge-uses', '--edge-constrained-by']) {
    assert.match(html, new RegExp(token + ':\\s*#[0-9a-fA-F]{6}'));
  }

  // Verify >= 3:1 contrast for all tokens against canvas
  const hexToLuminance = hex => {
    const rgb = hex.replace('#', '').match(/.{2}/g).map(x => parseInt(x, 16) / 255);
    const [r, g, b] = rgb.map(c => c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrastRatio = (hex1, hex2) => {
    const l1 = hexToLuminance(hex1), l2 = hexToLuminance(hex2);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  };

  const lightCanvas = '#f5f6f8';
  const lightTokens = {
    contains: '#526071',
    flows_to: '#0284c7',
    depends_on: '#7c3aed',
    uses: '#059669',
    constrained_by: '#b45309'
  };
  for (const [type, hex] of Object.entries(lightTokens)) {
    const ratio = contrastRatio(hex, lightCanvas);
    assert.ok(ratio >= 3.0, `light token ${type} (${hex}) contrast ${ratio.toFixed(2)} must be >= 3:1`);
  }

  const darkCanvas = '#101216';
  const darkTokens = {
    contains: '#94a3b8',
    flows_to: '#38bdf8',
    depends_on: '#a78bfa',
    uses: '#34d399',
    constrained_by: '#fbbf24'
  };
  for (const [type, hex] of Object.entries(darkTokens)) {
    const ratio = contrastRatio(hex, darkCanvas);
    assert.ok(ratio >= 3.0, `dark token ${type} (${hex}) contrast ${ratio.toFixed(2)} must be >= 3:1`);
  }
});

import { ARCHITECTURE_NODE_KINDS } from '../dist/core/architecture/node-kinds.js';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
function mechanismCandidate() {
  const candidate = architectureCandidate();
  candidate.facet_vocab = { layer: ['shell', 'core'] };
  candidate.nodes.push({ ...candidate.nodes[1], id: 'threshold', kind: 'mechanism', parent_id: 'capture',
    facets: { layer: 'core', layer_evidence_refs: ['l1:turn-1'] }, facts: [{ key: 'top-k', value: 8, unit: 'items', evidence_refs: ['l1:fact'], confidence: 0.8 }] });
  return candidate;
}
test('one runtime kind constant includes mechanism, with no duplicated five-kind lists', async () => {
  assert.equal(ARCHITECTURE_NODE_KINDS.at(-1), 'mechanism');
  async function scan(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) await scan(path);
      else if (entry.name.endsWith('.ts')) assert.doesNotMatch(await readFile(path, 'utf8'), /\[\s*["']project["']\s*,\s*["']domain["']\s*,\s*["']capability["']\s*,\s*["']process["']\s*,\s*["']method["']\s*\]/, path);
    }
  }
  await scan(fileURLToPath(new URL('../src', import.meta.url)));
});
test('mechanism supports uneven depth and rejects peers or ancestors as children', () => {
  const candidate = mechanismCandidate();
  assert.equal(parseArchitectureCognitiveMapCandidate(candidate).nodes.at(-1).kind, 'mechanism');
  candidate.nodes[1].kind = 'method'; candidate.timeline_links = [];
  assert.doesNotThrow(() => parseArchitectureCognitiveMapCandidate(candidate));
  candidate.nodes[1].kind = 'mechanism';
  assert.throws(() => parseArchitectureCognitiveMapCandidate(candidate), /below its parent/);
});
test('facts enforce limits, finite values, unique keys, refs and confidence', () => {
  const invalid = [
    { key: '' }, { key: 'k'.repeat(61) }, { value: 'v'.repeat(121) }, { value: Infinity }, { value: null },
    { unit: 'u'.repeat(21) }, { evidence_refs: [] }, { evidence_refs: Array(41).fill('l1:fact') },
    { evidence_refs: [''] }, { confidence: -0.1 }, { confidence: 1.1 }, { confidence: NaN }
  ];
  for (const patch of invalid) {
    const candidate = mechanismCandidate();Object.assign(candidate.nodes.at(-1).facts[0], patch);
    assert.throws(() => parseArchitectureCognitiveMapCandidate(candidate), undefined, JSON.stringify(patch));
  }
  for (const count of [2, 13]) {
    const candidate = mechanismCandidate();candidate.nodes.at(-1).facts = Array.from({length:count}, () => ({...candidate.nodes.at(-1).facts[0]}));
    assert.throws(() => parseArchitectureCognitiveMapCandidate(candidate), /unique|0-12/);
  }
  const candidate = mechanismCandidate();candidate.nodes.at(-1).facts = Array.from({length:12}, (_,i) => ({...candidate.nodes.at(-1).facts[0],key:`k${i}`}));
  assert.equal(parseArchitectureCognitiveMapCandidate(candidate).nodes.at(-1).facts.length,12);
});
test('fact evidence is admitted from current or previous maps and included in source refs and markdown', () => {
  const candidate = parseArchitectureCognitiveMapCandidate(mechanismCandidate());
  const input = {projectId:'alpha',candidate,sourceEvidenceRefs:['l1:turn-1','l1:turn-2']};
  assert.throws(() => buildArchitectureCognitiveMap(input), /outside the current/);
  const map = buildArchitectureCognitiveMap({...input,sourceEvidenceRefs:[...input.sourceEvidenceRefs,'l1:fact']});
  assert.equal(map.abstraction_cutoff,'mechanism');
  assert.ok(map.source_evidence_refs.includes('l1:fact'));
  const previousMap = {...map,source_evidence_refs:input.sourceEvidenceRefs};
  assert.ok(architectureCognitiveMapEvidenceRefs(previousMap).includes('l1:fact'));
  assert.doesNotThrow(() => buildArchitectureCognitiveMap({...input,previousMap}));
  assert.match(renderArchitectureCognitiveMapMarkdown(map), /\[core\]/);
  assert.match(renderArchitectureCognitiveMapMarkdown(map), /top-k = 8 items/);
  const model = timelineProjectModel();model.architecture.map = map;
  const visual = projectMemoryVisualization(model),node = visual.architecture.graph.nodes.find(n=>n.id==='threshold');
  assert.equal(visual.architecture.graph.levels.at(-1),'mechanism');
  assert.deepEqual(node.facts,candidate.nodes.at(-1).facts);
  assert.deepEqual(node.facets,{layer:'core',layer_evidence_refs:['l1:turn-1']});
  assert.deepEqual(visual.architecture.facet_vocab,map.facet_vocab);
  const old = {...buildArchitectureCognitiveMap({...input,candidate:parseArchitectureCognitiveMapCandidate(architectureCandidate())}),abstraction_cutoff:'method'};
  assert.doesNotThrow(()=>parseArchitectureCognitiveMapCandidate(old));
});
test('layer vocabulary rejects missing, unknown, duplicate, empty and oversized values', () => {
  for (const vocab of [undefined, {layer:[]}, {layer:['shell']}, {layer:['core','core']}, {layer:['x'.repeat(41)]}, {layer:Array.from({length:13},(_,i)=>String(i))}]) {
    const candidate=mechanismCandidate();candidate.facet_vocab=vocab;
    assert.throws(()=>parseArchitectureCognitiveMapCandidate(candidate));
  }
  const candidate=mechanismCandidate();candidate.nodes.at(-1).facets.layer='x'.repeat(41);
  assert.throws(()=>parseArchitectureCognitiveMapCandidate(candidate));
  delete candidate.nodes.at(-1).facets;delete candidate.facet_vocab;
  assert.doesNotThrow(()=>parseArchitectureCognitiveMapCandidate(candidate));
});

test('mechanism candidate ordering keeps ancestors first and arch-link accepts its level', async () => {
  const { selectCandidateNodes } = await import('../dist/core/maintenance/candidates.js');
  const { validateArchLinkAnswer } = await import('../dist/core/maintenance/answers.js');
  const candidate = parseArchitectureCognitiveMapCandidate(mechanismCandidate());
  const map = buildArchitectureCognitiveMap({projectId:'alpha',candidate,sourceEvidenceRefs:['l1:turn-1','l1:turn-2','l1:fact']});
  const nodes = selectCandidateNodes(map,'Capture',20);
  assert.equal(nodes.at(-1).kind,'mechanism');
  assert.ok(nodes.findIndex(n=>n.id==='capture')<nodes.findIndex(n=>n.id==='threshold'));
  const card={kind:'arch_link',input:{candidates:nodes},allowed_refs:[]};
  assert.equal(validateArchLinkAnswer(card,{links:[{architecture_refs:['threshold'],architecture_level:'mechanism',change_kind:'refine',confidence:0.8}]}).ok,true);
});

test('new layer facets require 1–40 allowed refs and retain layer-only provenance', () => {
  const candidate = mechanismCandidate();
  delete candidate.nodes.at(-1).facets.layer_evidence_refs;
  assert.throws(() => parseArchitectureCognitiveMapCandidate(candidate), /layer needs evidence/);
  for (const refs of [[], Array(41).fill('l1:turn-1'), [''], [3]]) {
    candidate.nodes.at(-1).facets.layer_evidence_refs = refs;
    assert.throws(() => parseArchitectureCognitiveMapCandidate(candidate));
  }
  candidate.nodes.at(-1).facets.layer_evidence_refs = ['layer-only'];
  const parsed = parseArchitectureCognitiveMapCandidate(candidate);
  const input = { projectId: 'alpha', candidate: parsed, sourceEvidenceRefs: ['l1:turn-1', 'l1:turn-2', 'l1:fact'] };
  assert.throws(() => buildArchitectureCognitiveMap(input), /layer.*outside the current/);
  const previous = buildArchitectureCognitiveMap({ ...input, sourceEvidenceRefs: [...input.sourceEvidenceRefs, 'layer-only'] });
  assert.ok(previous.source_evidence_refs.includes('layer-only'));
  previous.source_evidence_refs = input.sourceEvidenceRefs;
  assert.ok(architectureCognitiveMapEvidenceRefs(previous).includes('layer-only'));
  assert.ok(buildArchitectureCognitiveMap({ ...input, previousMap: previous }).source_evidence_refs.includes('layer-only'));
});

test('quality strips section anchors for drift including layer-only and fact-only citations', () => {
  const model = timelineProjectModel(true), map = model.architecture.map;
  const ref = 'architecture-doc:alpha:0123456789abcdef:docs/a.md';
  model.architecture_docs = [{ ref, path: 'docs/a.md' }];
  map.nodes[1].evidence_refs = [ref + '#one'];
  map.nodes[1].facets = { layer: 'core', layer_evidence_refs: [ref + '#two'] };
  map.source_evidence_refs.push(ref + '#three');
  assert.equal(qualityFor(model).gaps.filter(g => g.kind === 'doc_drift').length, 0);
  model.architecture_docs[0].ref = ref.replace('0123456789abcdef', 'fedcba9876543210');
  let gaps = qualityFor(model).gaps.filter(g => g.kind === 'doc_drift');
  assert.equal(gaps.length, 1); assert.equal(gaps[0].ref, 'docs/a.md'); assert.equal(gaps[0].severity, 'medium');
  model.architecture_docs = [];
  gaps = qualityFor(model).gaps.filter(g => g.kind === 'doc_drift');
  assert.equal(gaps.length, 1); assert.equal(gaps[0].severity, 'high');
});

test('flat confidence uses non-root population deviation and strict 0.02 / five-node thresholds', () => {
  for (const [values, flat] of [
    [Array(4).fill(0.88), false], [Array(5).fill(0.88), true],
    [[0.88 - 0.01999, 0.88 + 0.01999, 0.88 - 0.01999, 0.88 + 0.01999, 0.88 - 0.01999, 0.88 + 0.01999], true],
    [[0.88 - 0.02001, 0.88 + 0.02001, 0.88 - 0.02001, 0.88 + 0.02001, 0.88 - 0.02001, 0.88 + 0.02001], false],
    [[0, 0.04, 0, 0.04, 0, 0.04], false],
    [Array(5).fill(0.3), true]
  ]) {
    const model = timelineProjectModel(true), map = model.architecture.map;
    const root = map.nodes.find(n => n.kind === 'project'), template = map.nodes.find(n => n.kind !== 'project');
    root.confidence = 0;
    map.nodes = [root, ...values.map((confidence, i) => ({ ...template, id: 'flat-' + i, parent_id: root.id, confidence }))];
    map.edges = []; map.timeline_links = [];
    const quality = qualityFor(model), component = componentById(quality).confidence;
    assert.equal(quality.gaps.some(g => g.kind === 'flat_confidence'), flat);
    assert.equal(component.detail.includes('uniform confidence'), flat);
    const mean = values.reduce((sum, n) => sum + n, 0) / (values.length + 1);
    assert.equal(component.score, Math.round(flat ? Math.min(50, mean * 100) : mean * 100));
    if (flat) { const gap = quality.gaps.find(g => g.kind === 'flat_confidence'); assert.equal(gap.ref, 'alpha'); assert.equal(gap.severity, 'medium'); }
    assert.deepEqual(quality, qualityFor(model));
  }
});
