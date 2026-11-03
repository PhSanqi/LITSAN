import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  enqueueLegacyL1DistillationJob, recordCompletedDistillationRevision,
  leaseDistillationJob,
  listDistillationJobs
} from "../dist/distillation-jobs.js";
import { submitDistillationControl } from "../dist/distillation-submit.js";
import { hydrateMemoryEvidence } from "../dist/memory-hydration.js";

const root = await mkdtemp(join(tmpdir(), "memhub-fact-metadata-submit-"));
const accountId = "fact-metadata-submit-account";
const projectId = "fact-metadata-submit-project";
const harness = "fact-metadata-submit-harness";
const writes = [];
const runtime = {
  accountId,
  userId: "local-user",
  source: { platform: "test", transport: "test", principalId: "test", connectionId: "test", authenticatedAccount: accountId },
  memory: { distill: async (payload) => { writes.push(payload); return { id: `canonical-${payload.kind}-fact-metadata` }; } },
  projects: { resolve: async () => projectId, updateDistilledDescription: async () => undefined }
};
const evidence = ["move-1", "trip-1", "home-1"].map((id) => ({
  ref: `l1:${id}`, kind: "turn", layer: "L1", timestamp: "2023-08-17T00:00:00.000Z", project_id: projectId,
  user_text: `user evidence ${id}`, assistant_text: `assistant evidence ${id}`
}));
const content = [
  "# Timeline / 时间线",
  "## Chronology / 时间顺序",
  "### 9–17 August 2023 — Relocation and settling in",
  "### 2023年8月9日至17日——搬家与安顿",
  "- Alex moved from Seattle to Portland during the trip.",
  "  Alex 在旅途中从西雅图搬到了波特兰。",
  "  **Refs:** `l1:move-1`, `l1:trip-1`, `l1:foreign-project`",
  "- Alex now considers Portland home.",
  "  Alex 现在把波特兰视为家。",
  "  **Ref:** `l1:home-1`"
].join("\n");

try {
  const queued = await enqueueLegacyL1DistillationJob({ stateRoot: root, accountId, projectId, evidence });
  assert.equal(queued.created, true);
  const leased = await leaseDistillationJob(root, accountId, { harness, projectId, target: "l2", useLeaseToken: true });
  assert.ok(leased?.lease_token);
  const response = await submitDistillationControl({
    args: { job_id: leased.job_id, content }, stateRoot: root, runtime, sourceHarness: harness, leaseToken: leased.lease_token,
    resolveToolScope: async () => ({ projectId, resolutionSource: "explicit" }),
    validateDistillationEvidenceChain: async () => evidence
  });
  assert.equal(response.ok, true);
  assert.equal(response.fact_metadata?.fact_count, 2);

  const jobs = await listDistillationJobs(root, accountId, true);
  const completed = jobs.find((job) => job.job_id === leased.job_id);
  assert.ok(completed?.result_fact_metadata);
  assert.equal(completed.result_fact_metadata.facts.length, 2);
  assert.deepEqual(completed.result_fact_metadata.facts[0]?.evidence_refs, ["l1:move-1", "l1:trip-1"]);

  const hydrated = await hydrateMemoryEvidence({
    stateRoot: root, accountId, evidenceRef: `l2:${completed.result_id}:${completed.job_id}`
  });
  assert.equal(hydrated.fact_metadata?.facts.length, 2);
  assert.deepEqual(hydrated.fact_metadata?.facts[0]?.evidence_refs, ["l1:move-1", "l1:trip-1"]);

  const l3Leased = await leaseDistillationJob(root, accountId, { harness, projectId, target: "l3", useLeaseToken: true });
  assert.ok(l3Leased?.lease_token);
  const l2Ref = `l2:${completed.result_id}:${completed.job_id}`, writeCount = writes.length;
  const checkSpan = span => submitDistillationControl({
    args: { job_id: l3Leased.job_id, dry_run: true, content: "Current residence / 当前居住地",
      claim_traces: [{ claim_id: "residence", action: "new", source_evidence_refs: [l2Ref], source_spans: [span] }] },
    stateRoot: root, runtime, sourceHarness: harness, leaseToken: l3Leased.lease_token,
    resolveToolScope: async () => ({ projectId, resolutionSource: "explicit" }),
    validateDistillationEvidenceChain: async () => [{ ref: l2Ref, kind: "artifact", layer: "L2",
      timestamp: completed.result_committed_at ?? completed.completed_at, project_id: projectId, title: "Timeline", content }]
  });
  await assert.rejects(checkSpan("A fabricated source quote."), /source_spans/);
  assert.equal((await checkSpan("Alex moved from Seattle to Portland during the trip.")).dryRun, true);
  assert.equal(writes.length, writeCount, "span checks must not write to Memory Core");
  await submitDistillationControl({
    args: { job_id: l3Leased.job_id, content: [
      "# Current Truth / 当前事实", "## Residence / 居住地",
      `- Alex currently lives in Portland. | Evidence: l2:${completed.result_id}:${completed.job_id}, l2:foreign-project:foreign-revision`,
      "  Alex 目前住在波特兰。"
    ].join("\n") },
    stateRoot: root, runtime, sourceHarness: harness, leaseToken: l3Leased.lease_token,
    resolveToolScope: async () => ({ projectId, resolutionSource: "explicit" }),
    validateDistillationEvidenceChain: async () => [{
      ref: `l2:${completed.result_id}:${completed.job_id}`, kind: "artifact", layer: "L2",
      timestamp: completed.result_committed_at ?? completed.completed_at, project_id: projectId, title: "Timeline", content
    }]
  });
  const afterL3 = await listDistillationJobs(root, accountId, true);
  const l3Completed = afterL3.find((job) => job.job_id === l3Leased.job_id);
  assert.ok(l3Completed?.result_fact_metadata);
  assert.deepEqual(l3Completed.result_fact_metadata.facts[0]?.evidence_refs, [`l2:${completed.result_id}:${completed.job_id}`]);

  const aliasRoot = join(root, "merged-alias");
  const aliasEvidence = { ...evidence[0], ref: "l1:merged-history", project_id: "old-project" };
  await recordCompletedDistillationRevision({
    stateRoot: aliasRoot, accountId, target: "l2", projectId: "old-project", evidence: [aliasEvidence],
    resultId: "old-project-timeline", content: "# Old timeline", committedAt: "2020-01-01T00:00:00Z"
  });
  const aliasRuntime = {
    ...runtime,
    projects: {
      ...runtime.projects,
      storageIds: async () => [projectId, "old-project"]
    }
  };
  await enqueueLegacyL1DistillationJob({ stateRoot: aliasRoot, accountId, projectId, evidence: [evidence[0]] });
  const aliasLease = await leaseDistillationJob(aliasRoot, accountId, { harness, projectId, target: "l2", useLeaseToken: true });
  assert.ok(aliasLease?.lease_token);
  const aliasContent = [
    "# Timeline / 时间线", "## 2026-10-29: Merged history / 合并历史",
    "- Atomic fact: Earlier valid history. | Evidence: l1:merged-history",
    "- Atomic fact: Current valid evidence. | Evidence: l1:move-1"
  ].join("\n");
  await submitDistillationControl({
    args: { job_id: aliasLease.job_id, content: aliasContent }, stateRoot: aliasRoot,
    runtime: aliasRuntime, sourceHarness: harness, leaseToken: aliasLease.lease_token,
    resolveToolScope: async () => ({ projectId, resolutionSource: "explicit" }),
    validateDistillationEvidenceChain: async () => [evidence[0]]
  });
  const aliasJob = (await listDistillationJobs(aliasRoot, accountId, true)).find((item) => item.job_id === aliasLease.job_id);
  assert.deepEqual(aliasJob?.result_fact_metadata?.facts.map((fact) => fact.evidence_refs[0]),
    ["l1:merged-history", "l1:move-1"]);
  const aliasHydrated = await hydrateMemoryEvidence({
    stateRoot: aliasRoot, accountId, evidenceRef: `l2:${aliasJob.result_id}:${aliasJob.job_id}`,
    projects: aliasRuntime.projects
  });
  assert.deepEqual(aliasHydrated.fact_metadata?.facts.map((fact) => fact.evidence_refs[0]),
    ["l1:merged-history", "l1:move-1"]);
  console.log("fact-metadata-submit-e2e: ok");
} finally {
  await rm(root, { recursive: true, force: true });
}
