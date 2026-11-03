import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  architectureCognitiveMapFingerprint,
  buildArchitectureCognitiveMap,
  parseArchitectureCognitiveMapCandidate
} from "../dist/architecture-cognitive-map.js";
import { FileProjectArchitectureSource } from "../dist/architecture-source.js";
import { buildMemoryVisualization } from "../dist/memory-visualization.js";
import { buildTurnKnowledgePlan } from "../dist/turn-knowledge-plan.js";
import { submitDistillationControl } from "../dist/distillation-submit.js";

const evidence = ["l1:tkp-design", "l1:tkp-refine"];
const candidate = parseArchitectureCognitiveMapCandidate({
  summary: "LITSAN mental model down to method-level mechanisms.",
  nodes: [
    { id: "memhub", kind: "project", label: "LITSAN", summary: "Account/project memory control layer.", parent_id: null, order: 0, evidence_refs: [evidence[0]], confidence: 0.99 },
    { id: "core", kind: "domain", label: "LITSAN Core", summary: "Durable memory semantics and retrieval planning.", parent_id: "memhub", order: 1, evidence_refs: [evidence[0]], confidence: 0.96 },
    { id: "retrieval", kind: "capability", label: "Retrieval", summary: "Build bounded project-aware context.", parent_id: "core", order: 1, evidence_refs: [evidence[0]], confidence: 0.98 },
    { id: "tkp", kind: "process", label: "Turn Knowledge Plan", summary: "Select required, supporting and on-demand knowledge.", parent_id: "retrieval", order: 1, evidence_refs: [evidence[0], evidence[1]], confidence: 0.99 },
    { id: "tkp.required", kind: "method", label: "Required Knowledge Selection", summary: "Prefer project Current Truth and governed architecture constraints.", parent_id: "tkp", order: 1, evidence_refs: [evidence[1]], confidence: 0.97 },
    { id: "tkp.supporting", kind: "method", label: "Supporting Knowledge Selection", summary: "Add chronology and relevant stable context without overriding required knowledge.", parent_id: "tkp", order: 2, evidence_refs: [evidence[1]], confidence: 0.97 },
    { id: "tkp.evidence", kind: "method", label: "Evidence On Demand", summary: "Descend to WHY/L1 only when provenance or causality matters.", parent_id: "tkp", order: 3, evidence_refs: [evidence[1]], confidence: 0.98 }
  ],
  edges: [
    { from: "tkp", to: "retrieval", type: "uses", evidence_refs: [evidence[0]], confidence: 0.9 },
    { from: "tkp.evidence", to: "tkp.required", type: "depends_on", evidence_refs: [evidence[1]], confidence: 0.86 }
  ],
  timeline_links: [{
    event_date: "2026-10-11",
    event_title: "Turn Knowledge Plan retrieval refinement",
    architecture_refs: ["tkp", "tkp.required", "tkp.supporting", "tkp.evidence"],
    architecture_level: "process",
    change_kind: "refine",
    evidence_refs: [evidence[1]],
    confidence: 0.96
  }]
});

const map = buildArchitectureCognitiveMap({
  projectId: "memhub",
  candidate,
  sourceEvidenceRefs: evidence,
  generatedAt: "2026-10-26T03:30:00.000Z"
});
assert.equal(map.authority, "derived");
assert.equal(map.abstraction_cutoff, "mechanism"); // new builds use the mechanism cutoff; stored "method" maps still parse
assert.equal(map.nodes.at(-1).kind, "method");
assert.equal(map.timeline_links[0].architecture_level, "process");
assert.throws(() => parseArchitectureCognitiveMapCandidate({
  ...candidate,
  nodes: [...candidate.nodes, {
    id: "src.function", kind: "function", label: "Implementation function", summary: "Too deep",
    parent_id: "tkp.required", evidence_refs: [evidence[1]], confidence: 1
  }]
}), /kind must be one of/);

const root = await mkdtemp(join(tmpdir(), "memhub-architecture-map-"));
try {
  const source = new FileProjectArchitectureSource({ rootDir: root, managedRootDir: join(root, "managed") });
  const missing = await source.inspectProjectCognitiveMap({ accountId: "acct", projectId: "memhub" });
  assert.equal(missing.exists, false);
  assert.equal(missing.fingerprint, architectureCognitiveMapFingerprint(null));
  const write = await source.writeProjectCognitiveMap({
    accountId: "acct", projectId: "memhub", expectedFingerprint: missing.fingerprint, map
  });
  assert.equal(write.after.map.nodes.length, 7);
  assert.equal(write.after.map.timeline_links.length, 1);
  await assert.rejects(
    source.writeProjectCognitiveMap({ accountId: "acct", projectId: "memhub", expectedFingerprint: missing.fingerprint, map }),
    /changed after it was read/
  );
  assert.deepEqual(await source.listProjects("acct"), ["memhub"]);
  const context = await source.getProjectArchitecture({ accountId: "acct", projectId: "memhub", query: "TKP retrieval mental model" });
  const derived = context.find((item) => item.source === "project-architecture-cognitive-map");
  assert.ok(derived);
  assert.equal(derived.authority, "derived");
  assert.match(derived.content, /Turn Knowledge Plan/);
  assert.match(derived.content, /Evidence On Demand/);

  const timeline = "# LITSAN timeline\n\n## 2026-10-11：Turn Knowledge Plan retrieval refinement\nTKP now distinguishes required, supporting, and evidence-on-demand knowledge.";
  const projection = buildMemoryVisualization({
    projectId: "memhub",
    l2: [{ id: "timeline-memhub", body: timeline, updatedAt: "2026-10-11T10:00:00.000Z" }],
    architectureMap: map,
    architectureFingerprint: write.after.fingerprint
  });
  assert.equal(projection.visualization_contract, "memhub-project-map-ir-v1");
  assert.equal(projection.architecture.available, true);
  assert.equal(projection.stats.architecture_nodes, 7);
  assert.deepEqual(projection.state.events[0].architecture_refs, ["tkp", "tkp.required", "tkp.supporting", "tkp.evidence"]);
  assert.equal(projection.state.events[0].architecture_change_kind, "refine");
  assert.equal(projection.architecture.nodes.find((node) => node.id === "tkp")?.event_ids.length, 1);
  assert.equal(projection.archify.architecture_ir.nodes.at(-1).kind, "method");

  const capsule = {
    accountId: "acct", conversationId: null, resolvedProjectId: "memhub",
    resolutionSource: "explicit_project", recallScope: "global_and_project",
    globalState: [], globalMemory: [], projectMemory: [], reusableSkills: [],
    projectArchitecture: [derived], ambiguities: [], branchContext: null,
    contextBudget: { maxContentBytes: 96000, maxItemContentBytes: 24000, emittedContentBytes: derived.content.length, truncatedItems: 0, droppedItems: 0 }
  };
  const plan = await buildTurnKnowledgePlan({ query: "TKP retrieval architecture", capsule });
  assert.equal(plan.required.some((entry) => entry.id === derived.id), false, "derived cognitive map cannot become a required hard constraint");
  const supporting = plan.supporting.find((entry) => entry.id === derived.id);
  assert.ok(supporting);
  assert.equal(supporting.reason, "query_relevant_derived_architecture_map");

  const submitSource = new FileProjectArchitectureSource({ rootDir: root, managedRootDir: join(root, "submit-managed") });
  const submitBase = await submitSource.inspectProjectCognitiveMap({ accountId: "acct-submit", projectId: "memhub" });
  let coreWrites = 0;
  const runtime = {
    accountId: "acct-submit",
    userId: "local-user",
    source: { platform: "test", transport: "test", principalId: "test", connectionId: "test", authenticatedAccount: "acct-submit" },
    architecture: submitSource,
    projects: {
      resolve: async () => "memhub",
      updateDistilledDescription: async () => undefined
    },
    memory: {
      distill: async () => ({ id: `l2-result-${++coreWrites}` })
    }
  };
  const submitArgs = {
    kind: "l2", scope: "project", project: "memhub",
    content: "# LITSAN timeline\n\n## 2026-10-11：Turn Knowledge Plan retrieval refinement\nTKP architecture was refined.",
    evidence_refs: evidence,
    architecture_map_base_fingerprint: submitBase.fingerprint,
    architecture_map: candidate
  };
  const submitted = await submitDistillationControl({
    args: submitArgs,
    stateRoot: join(root, "submit-state"),
    runtime,
    sourceHarness: "test-harness",
    resolveToolScope: async () => ({ projectId: "memhub", resolutionSource: "explicit" }),
    validateDistillationEvidenceChain: async () => evidence.map((ref) => ({
      ref, kind: "turn", layer: "L1", timestamp: "2026-10-11T00:00:00.000Z", project_id: "memhub",
      user_text: "source", assistant_text: "response"
    }))
  });
  assert.equal(submitted.ok, true);
  assert.equal(submitted.architecture_map.nodes, 7);
  assert.equal((await submitSource.inspectProjectCognitiveMap({ accountId: "acct-submit", projectId: "memhub" })).map.nodes.length, 7);

  const failingArchitecture = {
    async inspectProjectCognitiveMap() { return submitBase; },
    async writeProjectCognitiveMap() { throw new Error("injected architecture sidecar outage"); }
  };
  const failingRuntime = { ...runtime, architecture: failingArchitecture, memory: { distill: async () => ({ id: `l2-result-${++coreWrites}` }) } };
  const originalError = console.error;
  const diagnostics = [];
  console.error = (...args) => diagnostics.push(args.map(String).join(" "));
  let secondary;
  try {
    secondary = await submitDistillationControl({
      args: { ...submitArgs, content: "# LITSAN timeline\n\n## 2026-10-12：Architecture map sidecar retry semantics\nL2 remains durable if the optional map write fails." },
      stateRoot: join(root, "submit-failure-state"),
      runtime: failingRuntime,
      sourceHarness: "test-harness",
      resolveToolScope: async () => ({ projectId: "memhub", resolutionSource: "explicit" }),
      validateDistillationEvidenceChain: async () => evidence.map((ref) => ({
        ref, kind: "turn", layer: "L1", timestamp: "2026-10-12T00:00:00.000Z", project_id: "memhub",
        user_text: "source", assistant_text: "response"
      }))
    });
  } finally {
    console.error = originalError;
  }
  assert.equal(secondary.ok, true);
  assert.match(secondary.architecture_map_error, /sidecar outage/);
  assert.ok(diagnostics.some((line) => line.includes("architecture cognitive map update failed")));

  // Stored maps predate layer evidence: the unchanged storage caller still reads them.
  const current = await source.inspectProjectCognitiveMap({ accountId: "acct", projectId: "memhub" });
  const legacy = structuredClone(current.map);
  legacy.facet_vocab = { layer: ["core"] };
  legacy.nodes[1].facets = { layer: "core" };
  await writeFile(current.path, JSON.stringify(legacy));
  const stored = await source.inspectProjectCognitiveMap({ accountId: "acct", projectId: "memhub" });
  assert.deepEqual(stored.map.nodes[1].facets, { layer: "core" });
  const legacyVisual = buildMemoryVisualization({ projectId: "memhub", l2: [], architectureMap: stored.map, architectureFingerprint: stored.fingerprint });
  assert.deepEqual(legacyVisual.architecture.graph.nodes[1].facets, { layer: "core" });
  assert.throws(() => buildArchitectureCognitiveMap({ projectId: "memhub", candidate: parseArchitectureCognitiveMapCandidate(legacy), sourceEvidenceRefs: evidence }), /layer needs evidence/);
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("architecture-cognitive-map-e2e: ok");
