import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTestRoot } from "../test-isolation.mjs";

/** @returns {import('../../dist/contracts/project-model.js').ProjectModel} */
export function emptyProjectModel(projectId = null) {
  return { projectId, l2: [], revisions: [], architecture: { map: null, fingerprint: null }, todos: [] };
}

export function architectureCandidate() {
  return {
    nodes: [
      { id: "alpha", kind: "project", label: "Alpha", summary: "Alpha project", parent_id: null, order: 0, evidence_refs: ["l1:turn-1"], confidence: 1 },
      { id: "capture", kind: "domain", label: "Capture", summary: "Capture pipeline", parent_id: "alpha", order: 1, evidence_refs: ["l1:turn-1", "l1:turn-2"], confidence: 0.9 }
    ],
    edges: [{ from: "alpha", to: "capture", type: "contains", evidence_refs: ["l1:turn-1"], confidence: 1 }],
    timeline_links: [{ event_date: "2026-10-02", event_title: "[Capture] v2 deployed", architecture_refs: ["capture"], architecture_level: "domain", change_kind: "refine", evidence_refs: ["l1:turn-2"], confidence: 0.9 }]
  };
}

/** @returns {import('../../dist/contracts/project-model.js').ProjectModel} */
export function timelineProjectModel(withArchitecture = false) {
  const initial = "# Timeline\n\n## 2026-10-01：[Capture] v1 candidate\nCapture validation started.";
  const current = initial + "\n\n## 2026-10-02：[Capture] v2 deployed\nCapture passed.\n\n## 2026-10-03：[Dashboard] v2 pending\nBrowser acceptance pending.";
  const revision = (id, memoryId, content, date) => ({ ref: `l2:${memoryId}:${id}`, layer: "L2", memory_id: memoryId,
    project_id: "alpha", committed_at: date, content, evidence_refs: ["l1:turn-1", "l1:turn-2"] });
  const candidate = architectureCandidate();
  return {
    projectId: "alpha",
    l2: [{ id: "timeline-alpha", body: current, updatedAt: "2026-10-03T09:00:00.000Z", tags: ["evidence:l1:turn-2"] }],
    revisions: [
      revision("revision-2", "timeline-alpha", current, "2026-10-03T08:00:00.000Z"),
      revision("revision-1", "timeline-alpha", initial, "2026-10-01T08:00:00.000Z"),
      revision("stale", "timeline-stale", "# Timeline\n\n## 2026-09-25：Retired unique event\nOnly in historical provenance.", "2026-09-25T08:00:00.000Z")
    ],
    architecture: withArchitecture ? {
      map: { schema_version: 1, contract: "memhub-architecture-cognitive-map-v1", project_id: "alpha", authority: "derived",
        abstraction_cutoff: "method", generated_at: "2026-10-03T10:00:00.000Z", source_evidence_refs: ["l1:turn-1", "l1:turn-2"], ...candidate },
      fingerprint: "fixture-map-fingerprint"
    } : { map: null, fingerprint: null },
    todos: [
      { id: "pending", text: "Finish browser acceptance", status: "pending", createdAt: "2026-10-03T08:30:00.000Z" },
      { id: "done", text: "Deploy capture", status: "done", completedAt: "2026-10-02T08:30:00.000Z" }
    ]
  };
}

/** Shared graph/demo fixture: five levels, two workstreams, all relation/change kinds. */
export function graphProjectModel() {
  const model = emptyProjectModel("alpha");
  const node = (id, kind, label, parent_id, order = 0, confidence = 0.9) =>
    ({ id, kind, label, summary: `${label} responsibility`, parent_id, order, confidence, evidence_refs: ["l1:demo"] });
  const nodes = [node("alpha", "project", "Alpha", null),
    node("capture", "domain", "Capture", "alpha", 1), node("dashboard", "domain", "Dashboard", "alpha", 2),
    node("ingest", "capability", "Ingestion", "capture"), node("browse", "capability", "Browsing", "dashboard"),
    node("validate", "process", "Validation", "ingest"), node("render", "process", "Rendering", "browse"),
    node("decode", "method", "Decode", "validate", 1), node("normalize", "method", "Normalize", "validate", 2),
    node("persist", "method", "Persist", "validate", 3), node("layout", "method", "Layout", "render", 1),
    node("filter", "method", "Filter", "render", 2), node("export", "method", "Export", "render", 3, 0.5)];
  const edge = (from, to, type) => ({ from, to, type, confidence: 0.9, evidence_refs: ["l1:demo"] });
  const edges = [...nodes.filter(n => n.parent_id).map(n => edge(n.parent_id, n.id, "contains")),
    edge("decode", "normalize", "flows_to"), edge("normalize", "persist", "flows_to"),
    edge("layout", "persist", "depends_on"), edge("filter", "normalize", "uses"),
    edge("export", "persist", "constrained_by"), edge("browse", "ingest", "uses")];
  const ids = ["decode", "normalize", "persist", "layout", "filter", "export", "ingest", "browse"];
  const kinds = ["add", "refine", "replace", "remove", "reroute"];
  const timeline_links = ids.map((id, i) => ({ event_date: `2026-10-${String(i + 1).padStart(2, "0")}`,
    event_title: `[${i < 3 || i === 6 ? "Capture" : "Dashboard"}] ${nodes.find(n => n.id === id).label} v${i + 1} deployed`,
    architecture_refs: [id], architecture_level: nodes.find(n => n.id === id).kind,
    change_kind: kinds[i % kinds.length], evidence_refs: ["l1:demo"], confidence: 0.9 }));
  model.l2 = [{ id: "timeline-alpha", body: "# Alpha timeline\n\n" + timeline_links.map(link =>
    `## ${link.event_date}：${link.event_title}\n${link.change_kind} validated for the local demo.`).join("\n\n"),
    updatedAt: "2026-10-08T09:00:00.000Z" }];
  model.architecture = { map: { schema_version: 1, contract: "memhub-architecture-cognitive-map-v1", project_id: "alpha",
    authority: "derived", abstraction_cutoff: "method", generated_at: "2026-10-26T00:00:00.000Z",
    source_evidence_refs: ["l1:demo"], nodes, edges, timeline_links }, fingerprint: "demo-fingerprint" };
  return model;
}

/** @returns {import('../../dist/shell/archify/project-model.js').ProjectModelBuilderDeps & { calls: object[] }} */
export function fakeProjectModelBuilderDeps(model = emptyProjectModel("alpha"), storageIds = ["alpha", "legacy-alpha"]) {
  const calls = [];
  return {
    accountId: "acct", calls,
    projects: { async storageIds(accountId, projectId) {
      calls.push({ method: "storageIds", accountId, projectId });
      return [...storageIds];
    } },
    architecture: { async inspectProjectCognitiveMap(input) {
      calls.push({ method: "inspectProjectCognitiveMap", ...input });
      return { projectId: input.projectId, path: "in-memory", exists: Boolean(model.architecture.map), ...structuredClone(model.architecture) };
    } }
  };
}

export function completedJob(overrides = {}) {
  return { job_id: "job-1", account_id: "acct", target: "l2", scope: "project", project_id: "alpha", status: "completed", reason: "manual",
    created_at: "2026-10-01T08:00:00.000Z", updated_at: "2026-10-01T09:00:00.000Z", completed_at: "2026-10-01T08:30:00.000Z",
    result_committed_at: "2026-10-01T08:45:00.000Z", result_kind: "l2", result_id: "timeline-alpha", result_content: "  # Timeline\n  ",
    evidence_refs: ["l1:turn-1"], evidence_hash: "fixture", evidence: [], ...overrides };
}

export async function projectModelStateRoot(jobs) {
  const root = await createTestRoot("archify-units-");
  await mkdir(join(root, "distillation"));
  await writeFile(join(root, "distillation", "jobs.json"), JSON.stringify({ version: 2, jobs }));
  return root;
}
