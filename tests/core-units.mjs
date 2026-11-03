import assert from "node:assert/strict";
import test from "node:test";
import { resolveProjectScope, buildRetrievalScopeEnvelope } from "../dist/core/scope/project-scope.js";
import { rankRecallHits } from "../dist/core/retrieval/ranker.js";
import { selectLitsanCoreHits } from "../dist/core/retrieval/litsan-core.js";
import { RetrievalV1FusionRanker } from "../dist/core/retrieval/interfaces.js";
import { buildContextCapsule } from "../dist/core/context/context-capsule.js";
import { buildTurnKnowledgePlan } from "../dist/core/context/turn-knowledge-plan.js";
import { completedRevisionCandidates, exactEvidenceRefError, parseLayerEvidenceRef, parseVersionedLayerEvidenceRef } from "../dist/core/lifecycle/evidence-refs.js";
import { validateDistillationEvidenceChain, validateMigrationL1EvidenceScope } from "../dist/core/lifecycle/distillation-evidence.js";
import { planProjectMutation, executeProjectMutation } from "../dist/core/governance/project-governance.js";
import { planArchitectureMutation, executeArchitectureMutation } from "../dist/core/governance/architecture-governance.js";
import { FakeProjectStore, FakeMemoryEngine, FakeDistillationJobReader, FakeArchitectureStore } from "./fakes/core-fakes.mjs";

const resolution = resolveProjectScope({ workspaceProjectId: "memhub" });
const stateRoot = "in-memory";
const hit = (id, score, snippet) => ({ id, score, snippet, kind: "project_profile", memoryLayer: "L3", status: "active", tags: ["project:memhub"], source: "search" });
const item = (id, layer, content = "retrieval policy") => ({ id, content, authority: "remembered", scope: "project", projectId: "memhub", source: "memory", provenance: { memoryLayer: layer } });
const job = (overrides = {}) => ({ job_id: "job-1", account_id: "acct", target: "l2", scope: "project", project_id: "memhub", status: "pending",
  reason: "manual", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z", evidence_refs: [], evidence_hash: "hash", evidence: [], ...overrides });
function projectSetup(jobs = []) {
  return { stateRoot, runtime: { accountId: "acct", projects: new FakeProjectStore([{ projectId: "memhub" }, { projectId: "target" }]) },
    jobs: new FakeDistillationJobReader(jobs), projectForModel: project => ({ project_id: project.projectId }) };
}
async function projectPlan(setup, args) { return planProjectMutation({ ...setup, args }, setup.jobs); }
async function projectExecute(setup, plan, args = {}) {
  return executeProjectMutation({ ...setup, args: { authorization_id: plan.authorization_id, ...args } }, setup.jobs);
}
function architectureSetup() {
  const architecture = new FakeArchitectureStore([{ projectId: "memhub", workspaceDir: "memhub", path: "memhub/architecture.md", relativePath: "architecture.md",
    exists: true, content: "# Before\n", fingerprint: "before" }]);
  return { stateRoot, runtime: { accountId: "acct", projects: new FakeProjectStore([{ projectId: "memhub" }]), architecture },
    resolveExplicitProjectEvidence: async (_runtime, input) => ({ projectId: input.project ?? "memhub", resolutionSource: "explicit" }) };
}
async function architecturePlan(setup) { return planArchitectureMutation({ ...setup, args: { project: "memhub", content: "# After\r\n" } }); }
async function architectureExecute(setup, plan, args = {}) {
  return executeArchitectureMutation({ ...setup, args: { authorization_id: plan.authorization_id, ...args } }, setup.runtime.architecture);
}

test("scope rejects conflicting explicit/workspace bindings and falls back to global_only", () => {
  const conflict = resolveProjectScope({ namespaceProjectId: "other", workspaceProjectId: "memhub" });
  assert.equal(conflict.projectId, null);
  assert.equal(conflict.source, "ambiguous");
  assert.equal(conflict.recallScope, "global_only");
  assert.deepEqual(conflict.candidates, ["memhub", "other"]);
  assert.equal(resolveProjectScope({}).recallScope, "global_only");
  assert.equal(resolveProjectScope({ exactAliasProjectIds: ["memhub"] }).source, "exact_alias");
  assert.equal(resolution.source, "deterministic_binding");
});

test("retrieval scope normalizes storage ids and gates cross-project skills and branches", () => {
  const envelope = buildRetrievalScopeEnvelope({ accountId: " acct ", resolution, workspaceProjectId: "memhub", branchId: " feature ",
    projectStorageIds: ["old", "memhub", "old"], reusableSkillProjectIds: ["other"], crossProjectSkillAllowed: false });
  assert.equal(envelope.accountId, "acct");
  assert.equal(envelope.branch, "feature");
  assert.equal(envelope.primaryProject, "memhub");
  assert.deepEqual(envelope.projectStorageIds, ["memhub", "old"]);
  assert.deepEqual(envelope.reusableSkillProjectIds, []);
  assert.deepEqual(buildRetrievalScopeEnvelope({ accountId: "acct", resolution, crossProjectSkillAllowed: true,
    reusableSkillProjectIds: ["other", "other"] }).reusableSkillProjectIds, ["other"]);
  assert.throws(() => buildRetrievalScopeEnvelope({ accountId: "acct", resolution: resolveProjectScope({}), branchId: "feature", crossProjectSkillAllowed: false }), /branch requires/);
});

test("ranker fuses lexical relevance, deduplicates and reports a top-k cutoff", () => {
  const candidates = [hit("semantic", 1.8, "general memory architecture notes"), hit("lexical", 0.55, "BM25 keyword retrieval diagnostics"),
    hit("duplicate", 0.6, "BM25   keyword retrieval diagnostics"), hit("semantic", 2, "duplicate id")];
  const ranked = rankRecallHits(candidates, "BM25 keyword retrieval", 1);
  assert.equal(ranked.hits[0].hit.id, "lexical");
  assert.equal(ranked.diagnostics.dedupedCount, 2);
  assert.deepEqual(new Set(ranked.diagnostics.decisions.map(decision => decision.reason)), new Set(["ranked", "top_k", "duplicate_content", "duplicate_id"]));
  assert.equal(ranked.diagnostics.cutoff.firstDroppedRank, 2);
  assert.deepEqual(new RetrievalV1FusionRanker().rank("BM25 keyword retrieval", candidates, 1), ranked);
});

test("ranker applies diversity while memhub_core preserves upstream diversity order and scores", () => {
  const candidates = [hit("one", 0.9, "retrieval pipeline semantic keyword ranking diagnostics"),
    hit("two", 0.89, "retrieval pipeline semantic keyword ranking diagnostics extra"), hit("three", 0.82, "project current truth evidence governance")];
  const ranked = rankRecallHits(candidates, "retrieval pipeline project current truth", 3);
  assert.ok(ranked.hits.some(candidate => candidate.diversityPenaltyApplied > 0));
  const diverse = rankRecallHits([hit("a", 0.9, "alpha beta gamma"), hit("b", 0.89, "alpha beta gamma extra"),
    hit("c", 0.82, "delta epsilon zeta")], "unmatched", 3);
  assert.deepEqual(diverse.hits.map(candidate => candidate.hit.id), ["a", "c", "b"]);
  const upstream = [candidates[2], candidates[0], candidates[1], candidates[0], hit("copy", 5, candidates[1].snippet)];
  const selected = selectLitsanCoreHits(upstream, "retrieval pipeline", 2);
  assert.deepEqual(selected.hits.map(candidate => candidate.hit.id), ["three", "one"]);
  assert.equal(selected.hits[0].coreScore, 0.82);
  assert.equal(selected.diagnostics.diversityPenalty, 0);
  assert.equal(selected.diagnostics.semanticWeight, 0);
  assert.equal(selected.diagnostics.lexicalWeight, 0);
  assert.equal(selected.diagnostics.dedupedCount, 3);
  assert.equal(selected.diagnostics.cutoff.firstDroppedRank, 3);
});

test("capsule truncates UTF-8 within item/total budgets and filters foreign projects", () => {
  const capsule = buildContextCapsule({ accountId: "acct", resolution, maxContentBytes: 2000, maxItemContentBytes: 1000,
    projectMemory: [item("a", "L3", "记忆😀".repeat(800)), item("b", "L2", "x".repeat(1800)), item("c", "L2", "y".repeat(1800)),
      { ...item("foreign", "L3"), projectId: "other" }] });
  const content = capsule.projectMemory.map(entry => entry.content);
  const bytes = content.reduce((sum, text) => sum + Buffer.byteLength(text), 0);
  assert.ok(bytes <= 2000);
  assert.ok(content.every(text => Buffer.byteLength(text) <= 1000 && !text.includes("\ufffd")));
  assert.equal(capsule.contextBudget.emittedContentBytes, bytes);
  assert.ok(capsule.contextBudget.truncatedItems >= 2);
  assert.ok(capsule.contextBudget.droppedItems >= 1);
  assert.ok(!capsule.projectMemory.some(entry => entry.id === "foreign"));
  assert.ok(capsule.contextBudgetTrace.decisions.some(decision => decision.result === "dropped"));
});

test("TKP classifies L3 and authoritative architecture as required, chronology and derived maps as supporting", async () => {
  const capsule = buildContextCapsule({ accountId: "acct", resolution,
    projectMemory: [item("truth", "L3"), item("history", "L2")], projectArchitecture: [
      { ...item("architecture", "L3"), authority: "authoritative" }, { ...item("map", "L3"), authority: "derived" }
    ] });
  const plan = await buildTurnKnowledgePlan({ query: "retrieval policy", capsule });
  assert.deepEqual(plan.required.map(entry => [entry.id, entry.role]), [["truth", "required"], ["architecture", "required"]]);
  assert.deepEqual(plan.supporting.map(entry => [entry.id, entry.role]), [["map", "supporting"], ["history", "supporting"]]);
  assert.equal(plan.coverage.current_truth_found, true);
  assert.equal(plan.persistence, "none");
});

test("evidence refs enforce prefixes and exact versioned revisions", () => {
  assert.equal(parseLayerEvidenceRef("l1: capture-1 ", "l1"), "capture-1");
  assert.throws(() => parseLayerEvidenceRef("l2:capture-1", "l1"), /expected L1/);
  assert.throws(() => parseLayerEvidenceRef("l1: ", "l1"), /invalid L1/);
  assert.deepEqual(parseVersionedLayerEvidenceRef("l2:namespace:memory:revision", "l2"), { memoryId: "namespace:memory", revisionId: "revision" });
  for (const ref of ["l3:memory:revision", "l2:memory", "l2::revision", "l2:memory:"]) assert.equal(parseVersionedLayerEvidenceRef(ref, "l2"), null);
  const jobs = [job({ job_id: "revision", status: "completed", result_kind: "l2", result_id: "memory", result_content: "history", completed_at: "2026-01-02T00:00:00Z" }),
    job({ job_id: "invalid", status: "completed", result_kind: "l2", result_id: "bad", result_content: "bad", completed_at: "invalid" })];
  assert.deepEqual(completedRevisionCandidates(jobs, "l2", new Set(["memhub"])), ["l2:memory:revision"]);
  assert.deepEqual(completedRevisionCandidates(jobs, "l2", new Set(["other"])), []);
  assert.match(exactEvidenceRefError({ requiredLayer: "L2", expectedPrefix: "l2", received: "l2:memory", projectId: "memhub", candidateRefs: ["l2:memory:revision"] }).message,
    /MEMHUB_EVIDENCE_REF_INVALID.*candidate_evidence_refs: l2:memory:revision/);
});

test("evidence chain validates ingested capture and exact completed revisions through fake readers", async () => {
  const memory = new FakeMemoryEngine();
  memory.captures.push({ account_id: "acct", event_id: "turn", ingested: true, capture_status: "complete", user_text: "user", assistant_text: "agent", project_hint: "memhub", timestamp: "2026-01-01T00:00:00Z" });
  const runtime = { accountId: "acct", userId: "user", projects: new FakeProjectStore([{ projectId: "memhub" }]), memoryClient: memory };
  const jobs = new FakeDistillationJobReader([job({ job_id: "revision", status: "completed", result_kind: "l2", result_id: "memory", result_content: "history", completed_at: "2026-01-02T00:00:00Z" })]);
  const readers = { listCaptureEvents: memory.listCaptureEvents.bind(memory), listDistillationJobs: jobs.listDistillationJobs.bind(jobs) };
  const input = { stateRoot, runtime, kind: "l2", projectId: "memhub", evidenceRefs: ["l1:turn"] };
  assert.deepEqual((await validateDistillationEvidenceChain(input, readers))[0], {
    ref: "l1:turn", kind: "turn", layer: "L1", timestamp: "2026-01-01T00:00:00Z", project_id: "memhub",
    conversation_id: undefined, user_text: "user", assistant_text: "agent"
  });
  assert.equal((await validateDistillationEvidenceChain({ ...input, kind: "l3", evidenceRefs: ["l2:memory:revision"] }, readers))[0].content, "history");
  await assert.rejects(validateDistillationEvidenceChain({ ...input, kind: "l3", evidenceRefs: ["l2:memory"] }, readers), /MEMHUB_EVIDENCE_REF_INVALID/);
  memory.captures[0].project_hint = "other";
  await assert.rejects(validateDistillationEvidenceChain(input, readers), /another or unresolved project/);
  assert.equal(memory.calls.filter(call => call.method === "listCaptureEvents").length, 2);
});

test("migration evidence validates memory and raw-turn membership with a fake memory engine", async () => {
  const memory = new FakeMemoryEngine();
  memory.responses.set("/api/v1/l1?userId=user&projectId=memhub&page=1&limit=200", { items: [{ id: "memory" }], hasNext: false });
  memory.responses.set("/api/v1/raw-turns?userId=user&projectId=memhub&page=1&limit=100", { items: [{ rawTurnId: "turn" }], hasNext: false });
  const runtime = { accountId: "acct", userId: "user", projects: new FakeProjectStore([{ projectId: "memhub" }]), memoryClient: memory };
  await validateMigrationL1EvidenceScope(runtime, "memhub", [{ kind: "memory", ref: "l1-memory:memory" }, { kind: "turn", ref: "raw-turn:turn" }]);
  await assert.rejects(validateMigrationL1EvidenceScope(runtime, "memhub", [{ kind: "memory", ref: "l1-memory:foreign" }]), /outside project scope/);
});

test("project plan waits for authorization; execute uses the planned payload exactly once", async () => {
  const setup = projectSetup();
  const plan = await projectPlan(setup, { operation: "create", project: "new", description: "new project" });
  assert.equal(plan.status, "awaiting_user_authorization");
  assert.equal(await setup.runtime.projects.resolve("acct", "new"), null);
  assert.ok(!setup.runtime.projects.calls.some(call => call.method === "create"));
  const result = await projectExecute(setup, plan, { project: "unplanned", operation: "delete" });
  assert.equal(result.operation, "create");
  assert.equal(result.result.projectId, "new");
  assert.equal(await setup.runtime.projects.resolve("acct", "unplanned"), null);
  await assert.rejects(projectExecute(setup, plan), /invalid or already-used/);
});

test("project execution rejects unknown and wrong-account authorizations", async () => {
  const setup = projectSetup();
  await assert.rejects(projectExecute(setup, { authorization_id: "unknown" }), /invalid or already-used/);
  const plan = await projectPlan(setup, { operation: "archive", project: "memhub" });
  await assert.rejects(projectExecute({ ...setup, runtime: { ...setup.runtime, accountId: "other" } }, plan), /invalid or already-used/);
  assert.equal((await projectExecute(setup, plan)).result.state, "archived");
});

test("project execution rejects expired plans and consumes their authorization", async t => {
  const setup = projectSetup();
  const plan = await projectPlan(setup, { operation: "archive", project: "memhub" });
  t.mock.method(Date, "now", () => Date.parse(plan.expires_at) + 1);
  await assert.rejects(projectExecute(setup, plan), /authorization expired/);
  await assert.rejects(projectExecute(setup, plan), /invalid or already-used/);
  assert.equal((await setup.runtime.projects.list("acct"))[0].state, "active");
});

for (const status of ["pending", "leased", "failed"]) {
  test(`project delete is blocked by ${status} jobs, including jobs added after planning`, async () => {
    const setup = projectSetup();
    const plan = await projectPlan(setup, { operation: "delete", project: "memhub" });
    setup.jobs.jobs.push(job({ status }));
    await assert.rejects(projectExecute(setup, plan), /1 unfinished distillation job/);
    assert.equal((await setup.runtime.projects.list("acct"))[0].state, "active");
  });
}

test("delete reports blockers; completed, retired, account and foreign-project jobs do not block", async () => {
  const setup = projectSetup([job(), job({ status: "completed" }), job({ result_retirement: "archived" }), job({ scope: "account", project_id: null }), job({ project_id: "target" })]);
  const plan = await projectPlan(setup, { operation: "delete", project: "memhub" });
  assert.equal(plan.impact.blockedByDistillationJobs.length, 1);
  setup.jobs.jobs.shift();
  assert.equal((await projectExecute(setup, plan)).result.state, "deleted");
});

test("merge preserves current behavior: unfinished jobs do not block logical merge", async () => {
  const setup = projectSetup([job(), job({ job_id: "failed", status: "failed" })]);
  const plan = await projectPlan(setup, { operation: "merge", project: "memhub", target: "target" });
  assert.equal(plan.impact.logicalMerge, true);
  const result = await projectExecute(setup, plan);
  assert.equal(result.result.source.state, "merged");
  assert.equal(await setup.runtime.projects.resolve("acct", "memhub"), "target");
  assert.equal(setup.jobs.calls.length, 0);
});

test("archive blocks pending jobs but preserves historical failed jobs", async () => {
  const setup = projectSetup([job(), job({ job_id: "failed", status: "failed" })]);
  const blocked = await projectPlan(setup, { operation: "archive", project: "memhub" });
  assert.equal(blocked.impact.blockedByDistillationJobs.length, 1);
  assert.equal(blocked.impact.preservedFailedDistillationJobs.length, 1);
  await assert.rejects(projectExecute(setup, blocked), /active distillation job/);
  setup.jobs.jobs.shift();
  const allowed = await projectPlan(setup, { operation: "archive", project: "memhub" });
  assert.equal((await projectExecute(setup, allowed)).result.state, "archived");
});

test("architecture plan awaits review; execution prepares a revision before write then commits it", async () => {
  const setup = architectureSetup();
  const plan = await architecturePlan(setup);
  const store = setup.runtime.architecture;
  assert.equal(plan.status, "awaiting_user_authorization");
  assert.equal(plan.proposed_content, "# After\n");
  assert.equal(store.revisions.size, 0);
  assert.equal(store.documents.get("acct:memhub").content, "# Before\n");
  const result = await architectureExecute(setup, plan);
  assert.equal(result.history_preserved, true);
  assert.equal(result.rollback_available, true);
  const revision = store.revisions.get(result.revision_id);
  assert.equal(revision.before_content, "# Before\n");
  assert.equal(revision.before_fingerprint, "before");
  assert.equal(revision.proposed_content, "# After\n");
  assert.equal(revision.after_fingerprint, result.fingerprint);
  assert.equal(revision.status, "committed");
  assert.deepEqual(store.calls.map(call => call.method).filter(method => /prepare|write|commit/.test(method)),
    ["prepareArchitectureRevision", "writeProjectArchitecture", "commitArchitectureRevision"]);
  await assert.rejects(architectureExecute(setup, plan), /invalid or already-used/);
});

for (const field of ["path", "fingerprint"]) {
  test(`architecture execution fences changed ${field} before preparing or writing a revision`, async () => {
    const setup = architectureSetup();
    const plan = await architecturePlan(setup);
    const store = setup.runtime.architecture;
    store.documents.get("acct:memhub")[field] = "changed";
    await assert.rejects(architectureExecute(setup, plan), /changed after plan/);
    assert.equal(store.revisions.size, 0);
    assert.ok(!store.calls.some(call => call.method === "writeProjectArchitecture"));
  });
}

test("architecture execution rejects unknown, wrong-account, changed-scope and expired authorizations", async t => {
  const setup = architectureSetup();
  await assert.rejects(architectureExecute(setup, { authorization_id: "unknown" }), /invalid or already-used/);
  const plan = await architecturePlan(setup);
  await assert.rejects(architectureExecute({ ...setup, runtime: { ...setup.runtime, accountId: "other" } }, plan), /invalid or already-used/);
  await assert.rejects(architectureExecute(setup, plan, { project: "other" }), /scope changed/);
  const expired = await architecturePlan(setup);
  t.mock.method(Date, "now", () => Date.parse(expired.expires_at) + 1);
  await assert.rejects(architectureExecute(setup, expired), /authorization expired/);
  assert.equal(setup.runtime.architecture.revisions.size, 0);
});

test("architecture audit commit failure retains a prepared revision for reconciliation", async () => {
  const setup = architectureSetup();
  const plan = await architecturePlan(setup);
  const store = setup.runtime.architecture;
  store.commitError = new Error("fake audit failure");
  await assert.rejects(architectureExecute(setup, plan), /was written but audit commit failed.*remains prepared/);
  assert.equal(store.documents.get("acct:memhub").content, "# After\n");
  assert.equal([...store.revisions.values()][0].status, "prepared");
});

test("latestCanonicalL2 skips retired revisions by default; the routine guard keeps them", async () => {
  const { latestCanonicalL2 } = await import("../dist/core/lifecycle/l2-restructure.js");
  const rev = (job_id, at, extra = {}) => ({ job_id, status: "completed", target: "l2", result_kind: "l2", result_id: "m1",
    result_content: "## 2026-10-01: A\nx", project_id: "p", result_committed_at: at, ...extra });
  const jobs = [rev("old", "2026-10-01T00:00:00Z"), rev("new", "2026-10-02T00:00:00Z", { result_retirement: "archived" })];
  assert.equal(latestCanonicalL2(jobs, "p").job_id, "old");
  assert.equal(latestCanonicalL2(jobs, "p", "p", { includeRetired: true }).job_id, "new");
});
