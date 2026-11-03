import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { createTestRoot, isolateTestEnvironment } from "./test-isolation.mjs";
import { closeCaptureIndexDb, markCaptureIngested, storeCaptureEvent } from "../dist/capture.js";
import { assignCaptureProjects } from "../dist/capture-project-assignments.js";
import { auditDistillationPipeline } from "../dist/distillation-audit.js";
import { discoverDistillationJobs } from "../dist/distillation-discovery.js";
import { completeDistillationLocalArtifact, enqueueGlobalStateDistillationJob, leaseDistillationJob, listDistillationJobs, setDistillationConfig } from "../dist/distillation-jobs.js";
import { validateDistillationEvidenceChain } from "../dist/distillation-evidence.js";
import { submitDistillationControl } from "../dist/distillation-submit.js";
import { hydrateMemoryEvidence } from "../dist/memory-hydration.js";
import { MemoryRestContextSource } from "../dist/memory-source.js";
import { globalStateAdmission } from "../dist/global-state.js";

for (const text of [
  "Generate up to 3 hyperpersonalized Projectless Codex suggestions based on recent connected-app activity.",
  "Generate fresh hyperpersonalized Codex task suggestions for Projectless based on connected app activity.",
  "Generate Projectless suggestions grounded in recent connected-app activity."
]) {
  assert.equal(globalStateAdmission({ user_text: text, provenance: {} }), "skip_noise",
    "historical synthetic Projectless prompts must be excluded even without automation provenance");
}
assert.equal(globalStateAdmission({
  user_text: "Can you explain the Projectless Codex suggestions we generated?",
  provenance: {}
}), "admit", "ordinary user discussion of Projectless suggestions must remain admissible");

const root = await createTestRoot("memhub-global-state-");
isolateTestEnvironment(root, root);
const accountId = "acct-global-state";
const actor = { account_id: accountId, actor_id: "global-state-test" };
const projects = {
  async resolve(_account, ref) { return ref === "alpha" ? "alpha" : null; },
  async storageIds(_account, project) { return [project]; },
  async updateDistilledDescription() { return undefined; }
};

async function add(id, { origin = "user", trigger = "user_prompt", text = `state ${id}` } = {}) {
  const stored = await storeCaptureEvent(root, actor, {
    event_id: id,
    host: "test",
    conversation_id: `chat-${id}`,
    continuity_id: `continuity-${id}`,
    timestamp: new Date().toISOString(),
    user_text: text,
    assistant_text: `assistant ${id}`,
    capture_status: "complete",
    provenance: { origin, trigger }
  });
  await markCaptureIngested(root, accountId, id);
  return stored.event;
}

async function keepGlobal(ids) {
  return assignCaptureProjects({
    stateRoot: root,
    accountId,
    projects,
    assignedBy: "host",
    keepGlobal: true,
    eventIds: ids
  });
}

const resolveProject = (hint) => projects.resolve(accountId, hint);
const discover = (enqueue = true, now = new Date(Date.now() + 60_000)) => discoverDistillationJobs({
  stateRoot: root,
  accountId,
  resolveProject,
  enqueue,
  now
});

const globalStateContent = `# Account Global State / 账号全局状态

## Current State Snapshot / 当前状态快照
EN: The account is currently testing an explicit global-state memory path.
ZH: 当前账号正在测试显式全局状态记忆链路。

## Recent Transitions / 近期变化
EN: Explicit keep-global evidence entered the account state queue.
ZH: 显式 keep-global 证据进入了账号状态队列。

## Profile Signals / 画像信号
EN: No stable profile trait is promoted by this fixture.
ZH: 此测试不提升任何稳定用户画像特征。`;

try {
  await setDistillationConfig(root, { auto_enabled: true, turn_threshold: 2, idle_minutes: 30 });
  await setDistillationConfig(root, { auto_since: "2000-01-01T00:00:00.000Z" });

  await add("global-1");
  await add("global-2");
  await add("unresolved");
  await add("synthetic", {
    origin: "automation",
    trigger: "scheduled_wakeup",
    text: "Generate 0 to 3 hyperpersonalized suggestions for Projectless Codex suggestions"
  });
  await keepGlobal(["global-1", "global-2", "synthetic"]);

  const dry = await discover(false);
  assert.equal(dry.unresolved, 1, "missing project/global routing must remain unresolved");
  assert.equal(dry.explicit_global_would_enqueue, 1);
  assert.equal(dry.explicit_global_skipped_noise, 1);
  assert.equal(dry.explicit_global_queued, 0);

  const queued = await discover(true);
  assert.equal(queued.explicit_global_queued, 1);
  let jobs = await listDistillationJobs(root, accountId);
  const firstJob = jobs.find((job) => job.target === "global_state");
  assert.ok(firstJob);
  assert.equal(firstJob.scope, "account");
  assert.equal(firstJob.project_id, null);
  assert.deepEqual(firstJob.evidence_refs.sort(), ["l1:global-1", "l1:global-2"]);
  assert.ok(firstJob.evidence.every((item) => item.origin === "user" && item.trigger === "user_prompt"));

  await add("global-3");
  await add("global-4");
  await keepGlobal(["global-3", "global-4"]);
  const serialized = await discover(true);
  assert.equal(serialized.explicit_global_queued, 0, "a canonical Global State job must serialize behind the current job");
  assert.equal(serialized.explicit_global_waiting, 4,
    "claimed and newly waiting explicit-global evidence should remain visible while one job is active");
  assert.equal((await listDistillationJobs(root, accountId)).filter((job) => job.target === "global_state").length, 1);

  const harness = "global-state-harness";
  const leased = await leaseDistillationJob(root, accountId, {
    jobId: firstJob.job_id,
    harness,
    leaseSeconds: 300,
    useLeaseToken: true
  });
  assert.ok(leased?.lease_token);
  const runtime = {
    accountId,
    userId: "global-state-user",
    projects,
    memoryClient: { viewerGet: async () => ({}) },
    architecture: {
      inspectProjectCognitiveMap: async () => ({ map: null, fingerprint: "" }),
      writeProjectCognitiveMap: async () => ({})
    },
    source: { platform: "test", transport: "local" },
    memory: { distill: async () => { throw new Error("Global State must not call Memory Core distill"); } }
  };
  const resolveToolScope = async (_runtime, input) => ({
    projectId: input.scope === "global" ? null : await projects.resolve(accountId, input.project ?? ""),
    resolutionSource: input.scope === "global" ? "global" : "explicit_project"
  });
  const submitted = await submitDistillationControl({
    args: {
      action: "submit",
      job_id: firstJob.job_id,
      kind: "global_state",
      scope: "account",
      content: globalStateContent
    },
    stateRoot: root,
    runtime,
    sourceHarness: harness,
    leaseToken: leased.lease_token,
    resolveToolScope,
    validateDistillationEvidenceChain
  });
  assert.equal(submitted.kind, "global_state");
  assert.match(submitted.result_evidence_ref, /^global_state:account_state_[a-f0-9]{24}:/);

  const hydrated = await hydrateMemoryEvidence({
    stateRoot: root,
    accountId,
    evidenceRef: submitted.result_evidence_ref
  });
  assert.equal(hydrated.layer, "GlobalState");
  assert.equal(hydrated.project_id, null);
  assert.equal(hydrated.content, globalStateContent);
  assert.equal(hydrated.fact_metadata, undefined, "Global State must not be interpreted as L2/L3 fact metadata");
  assert.deepEqual(hydrated.source_evidence_refs.sort(), ["l1:global-1", "l1:global-2"]);

  const secondQueued = await discover(true);
  assert.equal(secondQueued.explicit_global_queued, 1);
  jobs = await listDistillationJobs(root, accountId);
  const secondJob = jobs.find((job) => job.target === "global_state" && job.status === "pending");
  assert.ok(secondJob);
  assert.equal(secondJob.evidence[0].layer, "GlobalState");
  assert.equal(secondJob.evidence[0].ref, submitted.result_evidence_ref,
    "the next Global State synthesis must carry the exact completed base revision");
  assert.deepEqual(secondJob.evidence_refs.filter((ref) => ref.startsWith("l1:")).sort(),
    ["l1:global-3", "l1:global-4"]);

  const audit = await auditDistillationPipeline({ stateRoot: root, accountId, resolveProject });
  assert.equal(audit.evidence.unresolved_project, 1);
  assert.equal(audit.evidence.explicit_global_represented, 2);
  assert.equal(audit.evidence.explicit_global_waiting, 2);
  assert.equal(audit.evidence.explicit_global_skipped_noise, 1);

  const requests = [];
  const source = new MemoryRestContextSource({
    async search(request) { requests.push(request); return { debug: { hits: [] } }; }
  }, root);
  const recalled = await source.recall({
    accountId,
    userId: "global-state-user",
    query: "global state current account status",
    projectId: null,
    limit: 6,
    reusableSkillProjectIds: []
  });
  assert.equal(recalled.globalMemory.length, 0, "Global State must not masquerade as L4 globalMemory");
  assert.equal(recalled.globalState[0].provenance.memoryLayer, "GlobalState");
  assert.equal(recalled.globalState[0].evidenceRef, submitted.result_evidence_ref);
  assert.equal(recalled.globalState.some((item) => item.id === "synthetic"), false);
  assert.equal(recalled.diagnostics.lanes.globalState.emittedCount, recalled.globalState.length);
  assert.ok(requests.some((request) => (request.layers ?? []).includes("L4")),
    "existing L4 retrieval remains intact and separate");

  const concurrentRoot = `${root}/concurrent`;
  const turns = [await add("race-1"), await add("race-2")];
  const raced = await Promise.all(turns.map((turn) => enqueueGlobalStateDistillationJob({
    stateRoot: concurrentRoot, accountId, captures: [turn], reason: "manual"
  })));
  assert.equal(raced.filter((result) => result.created).length, 1,
    "concurrent disjoint Global State batches must serialize under the ledger lock");
  assert.equal(new Set(raced.map((result) => result.job.job_id)).size, 1);
  const firstRace = raced.find((result) => result.created).job;
  const otherAccount = await enqueueGlobalStateDistillationJob({
    stateRoot: concurrentRoot, accountId: "other-account",
    captures: [{ ...turns[0], account_id: "other-account" }], reason: "manual"
  });
  assert.equal(otherAccount.created, true, "serialization must be account-scoped");
  assert.equal(otherAccount.job.evidence.some((item) => item.layer === "GlobalState"), false);
  const raceLease = await leaseDistillationJob(concurrentRoot, accountId, {
    jobId: firstRace.job_id, harness, leaseSeconds: 300, useLeaseToken: true
  });
  const raceCompleted = await completeDistillationLocalArtifact(concurrentRoot, accountId, firstRace.job_id,
    { kind: "global_state", resultId: submitted.artifact.id, content: globalStateContent }, harness, raceLease.lease_token);
  const nextRace = await enqueueGlobalStateDistillationJob({
    stateRoot: concurrentRoot, accountId,
    captures: turns.filter((turn) => !firstRace.evidence_refs.includes(`l1:${turn.event_id}`)), reason: "manual"
  });
  assert.equal(nextRace.created, true, "the deferred disjoint batch remains eligible after completion");
  assert.equal(nextRace.job.evidence[0].ref, `global_state:${raceCompleted.result_id}:${raceCompleted.job_id}`,
    "the next batch must select its completed base under the same ledger lock");

  console.log("memhub-global-state-e2e: ok");
} finally {
  closeCaptureIndexDb(root);
  await rm(root, { recursive: true, force: true });
}
