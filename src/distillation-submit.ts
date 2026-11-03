import { completeBranchJobWithEvents, validateBranchEvents } from "./branch-drafts.js";
import type { AccountId, UserId, SourceContext } from "./contracts/identity.js";
import type { ProjectReader, ProjectWriter } from "./core/ports/projects.js";
import type { MemoryViewerReader, MemoryDistiller } from "./core/ports/memory.js";
import type { ArchitectureReader, ArchitectureWriter } from "./core/ports/architecture.js";
import { createHash, randomUUID } from "node:crypto";
import commitFs, { mkdir, readFile, readdir, stat, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { withFileMutationLock } from "./file-mutation-lock.js";
import { MemoryCoreHttpError, withCoreMemoryReconciliation } from "./local-memory-client.js";
import { DISTILLATION_CONTRACT_VERSION, validateBilingualDistillationContent, validateDistillationCandidate } from "./distillation-contract.js";
import { assertL2RestructureCandidate, latestCanonicalL2 } from "./core/lifecycle/l2-restructure.js";
import {
  getDistillationConfig,
  assertActiveDistillationLease,
  completeDistillationLocalArtifact,
  completeDistillationJobAfterCoreCommit,
  enqueueDerivedDistillationJob,
  failDistillationJobForLeaseGeneration,
  latestCompletedL3ByProject,
  listDistillationJobs,
  prepareDistillationLeaseForExternalWrite,
  quarantineDistillationJobAfterCoreCommit,
  recordCompletedDistillationRevision,
  type DistillationEvidenceItem,
  type DistillationJob
} from "./distillation-jobs.js";
import { globalStateArtifactId, globalStateEvidenceRef, GLOBAL_STATE_TITLE } from "./global-state.js";

import { assertSkillVersion } from "./skill-version.js";
import { parseDistillationClaimTraces, recordDistillationTrace, validateDistillationTraceSpans } from "./distillation-trace.js";
import { extractDistilledFactMetadata, factMetadataSummary, filterFactMetadataEvidence, verifiedFactEvidenceRefs } from "./fact-metadata.js";
import {
  buildArchitectureCognitiveMap,
  parseArchitectureCognitiveMapCandidate,
  type ArchitectureCognitiveMap,
  type ArchitectureCognitiveMapCandidate
} from "./architecture-cognitive-map.js";

export interface DistillationSubmitDeps {
  accountId: AccountId;
  projects: ProjectReader & Pick<ProjectWriter, "updateDistilledDescription">;
  memoryClient: MemoryViewerReader;
  architecture: Pick<ArchitectureReader, "inspectProjectCognitiveMap"> & Pick<ArchitectureWriter, "writeProjectCognitiveMap">;
  userId: UserId;
  source: SourceContext;
  memory: MemoryDistiller;
}

export async function submitDistillationControl(input: {
  args: Record<string, unknown>;
  stateRoot: string;
  runtime: DistillationSubmitDeps;
  sourceHarness: string;
  leaseToken?: string;
  enqueueDerived?: typeof enqueueDerivedDistillationJob;
  resolveToolScope: (runtime: DistillationSubmitDeps, input: { scope: string; project?: string; workspaceProject?: string; conversationId?: string }) => Promise<{ projectId: string | null; conversationId?: string; resolutionSource: string }>;
  validateDistillationEvidenceChain: (input: { stateRoot: string; runtime: DistillationSubmitDeps; kind: "l2" | "l3" | "l4" | "global_state" | "skill"; projectId: string | null; evidenceRefs: string[]; job?: DistillationJob }) => Promise<DistillationEvidenceItem[]>;
}): Promise<Record<string, unknown>> {
  const { args, stateRoot, runtime, sourceHarness, leaseToken, resolveToolScope, validateDistillationEvidenceChain } = input;
    const jobId = optionalString(args.job_id);
    let jobs = jobId ? await listDistillationJobs(stateRoot, runtime.accountId) : [];
    let job = jobId
      ? jobs.find((item) => item.job_id === jobId)
      : undefined;
    if (jobId && !job) throw new Error("distillation job not found for account");
    if (job?.branch_id && job.l2_restructure) throw new Error("restructure_job_not_branch");
    if (job?.l2_restructure && args.operator_confirmation !== `restructure:${job.l2_restructure.base_ref}`) {
      throw new Error(`L2 restructure requires explicit operator_confirmation: restructure:${job.l2_restructure.base_ref}`);
    }
    const kind = (optionalString(args.kind) ?? job?.target) as "l2" | "l3" | "l4" | "global_state" | "skill" | undefined;
    if (!kind || !["l2", "l3", "l4", "global_state", "skill"].includes(kind)) {
      throw new TypeError("kind must be l2, l3, l4, global_state, or skill");
    }
    if (job && job.target !== kind) throw new Error(`distillation target mismatch: job expects ${job.target}`);
    const scope = optionalString(args.scope) ?? job?.scope;
    if (!scope) throw new TypeError("scope is required");
    if (scope !== "account" && scope !== "project") throw new TypeError("scope must be account or project");
    if ((kind === "l2" || kind === "l3") && scope !== "project") {
      throw new TypeError(`${kind.toUpperCase()} requires project scope`);
    }
    if (kind === "l4" && scope !== "account") throw new TypeError("L4 requires account scope");
    if (kind === "global_state" && scope !== "account") throw new TypeError("Global State requires account scope");
    const title = optionalString(args.title);
    const artifactId = optionalString(args.artifact_id);
    const version = optionalString(args.version);
    if (kind === "skill") {
      if (!title) throw new TypeError("title is required for skill distillation");
      if (!artifactId) throw new TypeError("artifact_id is required for Skill distillation and must remain stable across revisions");
      if (!version) throw new TypeError("version is required for Skill distillation");
      assertSkillVersion(version);
    }
    const { projectId, conversationId } = await resolveToolScope(runtime, {
      scope: scope === "account" ? "global" : "project",
      project: optionalString(args.project) ?? job?.project_id ?? undefined,
      workspaceProject: optionalString(args.workspace_project),
      conversationId: optionalString(args.conversation_id) ?? job?.conversation_id
    });
    if (kind === "l4" && projectId !== null) throw new Error("L4 cannot be project-scoped");
    if (kind === "global_state" && projectId !== null) throw new Error("Global State cannot be project-scoped");
    const canonicalJobProjectId = job?.project_id
      ? await runtime.projects.resolve(runtime.accountId, job.project_id)
      : job?.project_id ?? null;
    if (job && (job.scope !== scope || canonicalJobProjectId !== projectId)) {
      throw new Error("distillation job scope mismatch");
    }
    const explicitEvidenceRefs = stringArray(args.evidence_refs) ?? [];
    if (job && explicitEvidenceRefs.some((ref) => !job!.evidence_refs.includes(ref))) {
      throw new Error("job-backed distillation cannot add evidence outside the leased job");
    }
    const evidenceRefs = uniqueStrings(job && !job.l2_restructure ? job.evidence_refs : explicitEvidenceRefs) ?? [];
    const claimTraces = parseDistillationClaimTraces(args.claim_traces, evidenceRefs);
    const sourceConversations = uniqueStrings([
      ...(job?.conversation_id ? [job.conversation_id] : []),
      ...(stringArray(args.source_conversations) ?? [])
    ]);
    const confidence = optionalNumber(args.confidence);
    if (job?.branch_id && (args.content !== undefined || args.events === undefined)) throw new Error("branch_job_requires_events");
    if (!job?.branch_id && args.events !== undefined) throw new Error("events_only_for_branch_jobs");
    const content = job?.branch_id ? "" : requiredString(args.content, "content");
    const projectDescription = optionalString(args.project_description);
    if (projectDescription && kind !== "l2") throw new TypeError("project_description is only valid for L2 distillation");
    if (projectDescription && projectDescription.length > 1200) throw new TypeError("project_description must be at most 1200 characters");
    const architectureMapBaseFingerprint = optionalString(args.architecture_map_base_fingerprint);
    const architectureMapCandidate: ArchitectureCognitiveMapCandidate | undefined = args.architecture_map === undefined
      ? undefined
      : parseArchitectureCognitiveMapCandidate(args.architecture_map);
    if (architectureMapCandidate && kind !== "l2") throw new TypeError("architecture_map is only valid for L2 distillation");
    if (architectureMapBaseFingerprint && kind !== "l2") throw new TypeError("architecture_map_base_fingerprint is only valid for L2 distillation");
    if (architectureMapCandidate && !architectureMapBaseFingerprint) {
      throw new TypeError("architecture_map requires architecture_map_base_fingerprint from action=next");
    }
    if (!architectureMapCandidate && architectureMapBaseFingerprint) {
      throw new TypeError("architecture_map_base_fingerprint requires architecture_map");
    }
    if (job?.branch_id) {
      const events = validateBranchEvents(args.events, job.evidence_refs);
      if (job.status === "completed" && job.result_kind === "branch_draft") {
        return { ok: true, job_id: job.job_id, ...await completeBranchJobWithEvents({ stateRoot, accountId: runtime.accountId,
          jobId: job.job_id, leaseOwner: sourceHarness, leaseToken, events, projects: runtime.projects }) };
      }
      assertActiveDistillationLease(job, sourceHarness, leaseToken);
      const resolvedEvidence = await validateDistillationEvidenceChain({ stateRoot, runtime, kind, projectId, evidenceRefs, job });
      let architectureMapResult: unknown, architectureMapError: string | undefined;
      if (architectureMapCandidate && projectId) {
        const current = await runtime.architecture.inspectProjectCognitiveMap({ accountId: runtime.accountId, projectId });
        if (current.fingerprint !== architectureMapBaseFingerprint) throw new Error("Project Architecture Cognitive Map changed after action=next; reload the latest architecture_context and submit a fresh full map");
        const map = buildArchitectureCognitiveMap({ projectId, candidate: architectureMapCandidate,
          sourceEvidenceRefs: resolvedEvidence.map(e => e.ref), previousMap: current.map });
        if (args.dry_run !== true) try {
          const write = await runtime.architecture.writeProjectCognitiveMap({ accountId: runtime.accountId, projectId,
            expectedFingerprint: architectureMapBaseFingerprint!, map });
          architectureMapResult = { fingerprint: write.after.fingerprint, generated_at: write.after.map!.generated_at,
            nodes: write.after.map!.nodes.length, edges: write.after.map!.edges.length, timeline_links: write.after.map!.timeline_links.length };
        } catch (error) { architectureMapError = error instanceof Error ? error.message : String(error); }
      }
      if (args.dry_run === true) return { ok: true, dryRun: true, job_id: job.job_id, events };
      const completed = await completeBranchJobWithEvents({ stateRoot, accountId: runtime.accountId, jobId: job.job_id,
        leaseOwner: sourceHarness, leaseToken, events, projects: runtime.projects });
      return { ok: true, job_id: job.job_id, ...completed,
        ...(architectureMapResult ? { architecture_map: architectureMapResult } : {}),
        ...(architectureMapError ? { architecture_map_error: architectureMapError } : {}) };
    }
    const canonicalArtifactId = artifactId ??
      (kind === "l2"
        ? `project-timeline:${projectId}`
        : kind === "l3"
          ? `project-profile:${projectId}`
          : kind === "l4"
            ? `user-profile:${runtime.accountId}`
            : kind === "global_state"
              ? globalStateArtifactId(runtime.accountId)
            : undefined);
    const canonicalTitle = title ??
      (kind === "l2"
        ? `Project Timeline · ${projectId}`
        : kind === "l3"
          ? `Project Rules & Experience · ${projectId}`
          : kind === "l4"
            ? "Cross-project User Profile"
            : kind === "global_state"
              ? GLOBAL_STATE_TITLE
            : undefined);

    if (kind === "global_state") {
      if (!jobId || !job) throw new Error("Global State submission requires a leased discovery job");
      if (claimTraces.length > 0) throw new TypeError("claim_traces are not yet supported for Global State");
      if (job.status === "completed") {
        if (job.result_kind !== "global_state" || job.result_id !== canonicalArtifactId || job.result_content !== content) {
          throw new Error("completed Global State job cannot be replaced by a different candidate");
        }
        return {
          ok: true,
          kind,
          scope,
          project: null,
          sourceHarness,
          contract: DISTILLATION_CONTRACT_VERSION,
          job_id: job.job_id,
          artifact: { id: job.result_id, title: canonicalTitle, content: job.result_content },
          result_evidence_ref: globalStateEvidenceRef(job)
        };
      }
      assertActiveDistillationLease(job, sourceHarness, leaseToken);
      validateDistillationCandidate({ kind, content, evidence: { evidenceRefs, sourceConversations, confidence } });
      const resolvedEvidence = await validateDistillationEvidenceChain({
        stateRoot,
        runtime,
        kind,
        projectId: null,
        evidenceRefs,
        job
      });
      if (args.dry_run === true) {
        return {
          ok: true,
          dryRun: true,
          kind,
          scope,
          project: null,
          sourceHarness,
          contract: DISTILLATION_CONTRACT_VERSION,
          evidenceRefs: resolvedEvidence.map((item) => item.ref),
          artifact_id: canonicalArtifactId
        };
      }
      const completed = await completeDistillationLocalArtifact(
        stateRoot,
        runtime.accountId,
        job.job_id,
        { kind: "global_state", resultId: canonicalArtifactId!, content },
        sourceHarness,
        leaseToken
      );
      return {
        ok: true,
        kind,
        scope,
        project: null,
        sourceHarness,
        nativeEvolution: false,
        contract: DISTILLATION_CONTRACT_VERSION,
        job_id: completed.job_id,
        artifact: {
          id: completed.result_id,
          title: canonicalTitle,
          content: completed.result_content,
          updatedAt: completed.result_committed_at
        },
        result_evidence_ref: globalStateEvidenceRef(completed)
      };
    }
    const commitPath = join(resolve(stateRoot), "distillation", "commits", hashJson([runtime.accountId, kind, projectId, canonicalArtifactId]) + ".json");
    const response = await withArtifactCommitLock(commitPath, async () => {
    const candidateHash = hashJson({ jobId, kind, projectId, conversationId, content, title: canonicalTitle,
      artifactId: canonicalArtifactId, version, evidenceRefs, sourceConversations, confidence,
      tags: stringArray(args.tags), projectDescription, architectureMapCandidate, architectureMapBaseFingerprint, sourceHarness });
    let commit: ArtifactCommit | undefined;
    try { commit = JSON.parse(await readFile(commitPath, "utf8")) as ArtifactCommit; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    jobs = await listDistillationJobs(stateRoot, runtime.accountId);
    job = jobId ? jobs.find((item) => item.job_id === jobId) : undefined;
    if (jobId && !job) throw new Error("distillation job not found for account");
    const replay = commit?.candidateHash === candidateHash && !commit.rejected;
    if (job?.l2_restructure && projectId) {
      const base = latestCanonicalL2(jobs, projectId, job.project_id);
      // A retry of the exact committed operation must remain idempotent.
      // An exact replay of an already-committed restructure stays idempotent even if a newer L2 landed since.
      if (!(replay && commit?.coreResult) &&
          (!base || `l2:${base.result_id}:${base.job_id}` !== job.l2_restructure.base_ref)) {
        throw new Error("L2 restructure base changed; re-run restructure_l2");
      }
      assertL2RestructureCandidate(job, content, evidenceRefs);
    }
    if (replay && commit?.response && args.dry_run !== true) {
      const resultId = memoryResultId(commit.coreResult);
      const retired = (await listDistillationJobs(stateRoot, runtime.accountId, true))
        .some(item => item.result_id === resultId && item.result_retirement);
      if (retired) throw new Error("recorded artifact result is retired; replay cannot restore it; submit a new approved candidate");
      if (runtime.memoryClient && resultId) {
        const payload = await runtime.memoryClient.viewerGet(`/api/v1/memory/${encodeURIComponent(resultId)}`) as Record<string, unknown>;
        const memory = (payload.item ?? payload) as Record<string, unknown>;
        if (memory.id !== resultId || memory.status === "deleted" || memory.status === "archived") {
          throw new Error("recorded artifact result is no longer live; replay cannot restore it");
        }
      }
      return commit.response;
    }
    if (commit && !commit.response && !commit.rejected && !replay) {
      throw new Error("artifact has an unresolved commit; retry the exact frozen candidate before replacing it");
    }
    if (job && !(replay && commit?.coreResult && job.status === "completed")) {
      assertActiveDistillationLease(job, sourceHarness, leaseToken);
    }
    validateDistillationCandidate({
      kind,
      content,
      evidence: { evidenceRefs, sourceConversations, confidence }
    });
    const resolvedEvidence = replay && commit?.evidence ? commit.evidence : await validateDistillationEvidenceChain({
      stateRoot,
      runtime,
      kind,
      projectId,
      evidenceRefs: evidenceRefs ?? [],
      job
    });
    if (!Array.isArray(resolvedEvidence)) throw new Error("distillation evidence validation returned no evidence list");
    validateDistillationTraceSpans(claimTraces, resolvedEvidence);
    if (!replay && (kind === "l3" || kind === "l4")) validateBilingualDistillationContent(content, kind);
    // Promotion is a candidate, never implied consent. Preserve exact sources and reuse the existing human-governed writer.
    if ((kind === "l3" || kind === "l4") && !(replay && commit?.coreResult) &&
      (await getDistillationConfig(stateRoot)).promotion_review_accounts?.includes(runtime.accountId)) {
      const current = jobs.filter(j => j.status === "completed" && j.result_kind === kind && j.project_id === projectId &&
        j.result_id && j.result_content && !j.result_retirement).sort((a, b) =>
        Date.parse(b.result_committed_at ?? b.completed_at ?? "") - Date.parse(a.result_committed_at ?? a.completed_at ?? ""))[0];
      const baseRef = current ? `${kind}:${current.result_id}:${current.job_id}` : undefined;
      return { ok: true, status: "awaiting_user_review", written: false, kind, scope, project: projectId, job_id: jobId,
        notification: "晋升候选待人工审核；尚未写入长期记忆。请展示候选、来源和变化，用户明确确认后才执行。",
        review: { current_evidence_ref: baseRef ?? null, proposed_content: content, proposed_sha256: hashJson(content),
          evidence_refs: resolvedEvidence.map(item => item.ref),
          criteria: kind === "l3" ? ["Exact same-project L2 evidence", "Durable project rule or repeated experience", "Preserve current truth; resolve conflicts and supersession"]
            : ["Exact L3 evidence from multiple projects", "Stable cross-project principle, not one incident", "Do not globalize project-local facts"],
          next_action: { tool: "litsan_memory", action: "plan", kind, ...(projectId ? { project: projectId } : {}),
            content, ...(baseRef ? { base_evidence_ref: baseRef } : {}), note: `Promotion candidate from ${jobId ?? "manual distillation"}; sources: ${resolvedEvidence.map(item => item.ref).join(", ")}` },
          instructions: ["Prepare the governed plan and show its full proposed_content to the user.",
            "Only a later explicit human confirmation permits litsan_memory execute with its one-time authorization_id and confirmation_evidence_ref.",
            "Keep this source job pending until approval and canonical readback are reconciled; do not mark it successful or skip it to hide review backlog."] } };
    }
    const factStorageIds = kind === "l2" && projectId && typeof runtime.projects.storageIds === "function"
      ? await runtime.projects.storageIds(runtime.accountId, projectId)
      : projectId ? [projectId] : [];
    let preparedArchitectureMap: ArchitectureCognitiveMap | undefined;
    if (architectureMapCandidate && projectId) {
      const currentArchitectureMap = await runtime.architecture.inspectProjectCognitiveMap({
        accountId: runtime.accountId,
        projectId
      });
      if (currentArchitectureMap.fingerprint !== architectureMapBaseFingerprint) {
        throw new Error("Project Architecture Cognitive Map changed after action=next; reload the latest architecture_context and submit a fresh full map");
      }
      preparedArchitectureMap = buildArchitectureCognitiveMap({
        projectId,
        candidate: architectureMapCandidate,
        sourceEvidenceRefs: resolvedEvidence.map((item) => item.ref),
        previousMap: currentArchitectureMap.map
      });
    }
    if (kind === "l2" && projectId && job && !job.l2_restructure) {
      assertRoutineL2PreservesCanonicalTimeline({
        jobs,
        projectId,
        jobProjectId: job.project_id,
        content
      });
    }
    if (args.dry_run === true) {
      return {
        ok: true,
        dryRun: true,
        kind,
        scope,
        project: projectId,
        sourceHarness,
        contract: DISTILLATION_CONTRACT_VERSION,
        evidenceRefs,
        sourceConversations,
        confidence,
        ...(preparedArchitectureMap ? {
          architecture_map: {
            valid: true,
            base_fingerprint: architectureMapBaseFingerprint,
            nodes: preparedArchitectureMap.nodes.length,
            edges: preparedArchitectureMap.edges.length,
            timeline_links: preparedArchitectureMap.timeline_links.length
          }
        } : {})
      };
    }
    // Evidence validation can take time; fence enough remaining lease budget
    // immediately before the external write. Local preparation failures are
    // not Memory Core failures and must not be recorded as such.
    if (jobId && job?.status !== "completed") {
      await prepareDistillationLeaseForExternalWrite(
        stateRoot,
        runtime.accountId,
        jobId,
        sourceHarness,
        leaseToken
      );
    }
    const operation: ArtifactCommit = replay && commit ? commit : { candidateHash, generation: randomUUID() };
    const saveCommit = () => writeDistillationCommitFile(commitPath, operation);
    operation.evidence ??= resolvedEvidence;
    operation.args ??= { ...args, source_harness: sourceHarness, dry_run: false };
    operation.createdAt ??= new Date().toISOString();
    if (!operation.payload) operation.payload = {
        accountId: runtime.accountId,
        userId: runtime.userId,
        kind,
        content,
        projectId,
        conversationId,
        title: canonicalTitle,
        tags: uniqueStrings(["memory-v2", `layer:${kind}`, `commit-operation:${operation.generation}`, ...(stringArray(args.tags) ?? []),
          ...(job?.l2_restructure ? ["l2-restructure", `restructure-base:${job.l2_restructure.base_ref}`] : [])]),
        sourceHarness,
        artifactId: canonicalArtifactId,
        version,
        evidenceRefs,
        sourceConversations,
        confidence,
        contractVersion: DISTILLATION_CONTRACT_VERSION,
        provenance: {
          platform: runtime.source.platform,
          transport: runtime.source.transport,
          principal: runtime.source.principalId,
          connection: runtime.source.connectionId,
          account: runtime.accountId,
          authenticated_account: runtime.source.authenticatedAccount
        }
      };
    await saveCommit();
    let result = operation.coreResult;
    let coreCommittedAt = operation.committedAt;
    try {
      if (!result) {
        if (replay) {
          result = await withCoreMemoryReconciliation(() => runtime.memory.distill(operation.payload!));
        } else {
          operation.sentAt = new Date().toISOString();
          await saveCommit();
          result = await runtime.memory.distill(operation.payload!);
        }
        coreCommittedAt = new Date().toISOString();
        operation.coreResult = result;
        operation.committedAt = coreCommittedAt;
        await saveCommit();
      }
    } catch (error) {
      const ambiguous = !(error instanceof MemoryCoreHttpError && [400, 401, 403, 409, 422].includes(error.status));
      if (!ambiguous) { operation.rejected = true; operation.terminalAt = new Date().toISOString(); await saveCommit(); }
      if (jobId && !ambiguous) {
        await failDistillationJobForLeaseGeneration(
          stateRoot,
          runtime.accountId,
          jobId,
          error instanceof Error ? error.message : String(error),
          sourceHarness,
          leaseToken
        ).catch(() => undefined);
      }
      throw error;
    }
    let resultId: string;
    try {
      resultId = requireMemoryResultId(result);
    } catch (error) {
      if (jobId) {
        await quarantineDistillationJobAfterCoreCommit(
          stateRoot,
          runtime.accountId,
          jobId,
          "Memory Core returned success without a stable result id; ambiguous commit requires manual reconciliation before retry",
          sourceHarness,
          leaseToken,
          coreCommittedAt
        ).catch((quarantineError) => {
          throw new Error(
            `Memory Core returned an ambiguous success and the lease generation could not be quarantined: ${String(quarantineError)}`
          );
        });
      }
      throw error;
    }
    const committedContent = result && typeof result === "object" && typeof (result as { body?: unknown }).body === "string"
      ? (result as { body: string }).body : content;
    const factMetadata = filterFactMetadataEvidence(
      extractDistilledFactMetadata(kind, committedContent, kind === "l3" ? resolvedEvidence.map((item) => item.ref) : []),
      verifiedFactEvidenceRefs({ kind, accountId: runtime.accountId, projectId, projectStorageIds: factStorageIds,
        evidence: resolvedEvidence, jobs, asOf: coreCommittedAt ?? "" })
    );
    let projectDescriptionError: string | undefined;
    let architectureMapResult: { fingerprint: string; generated_at: string; nodes: number; edges: number; timeline_links: number } | undefined;
    let architectureMapError: string | undefined;
    let queuedNext: unknown;
    let nextLayerEnqueueError: string | undefined;
    let completedRevision: DistillationJob | undefined;
    if (jobId) {
      completedRevision = job?.status === "completed" ? job : await completeDistillationJobAfterCoreCommit(stateRoot, runtime.accountId, jobId, {
        kind,
        resultId,
        content: committedContent,
        committedAt: coreCommittedAt!,
        coreBody: result && typeof result === "object" && typeof (result as { body?: unknown }).body === "string" ? committedContent : undefined,
        ...(factMetadata ? { factMetadata } : {})
      }, sourceHarness, leaseToken);
      try {
      if (kind === "l2" && projectId) {
        queuedNext = await (input.enqueueDerived ?? enqueueDerivedDistillationJob)({
          stateRoot,
          accountId: runtime.accountId,
          target: "l3",
          projectId,
          evidence: [{
            ref: `l2:${resultId}:${completedRevision.job_id}`,
            kind: "artifact",
            layer: "L2",
            timestamp: completedRevision.result_committed_at ?? completedRevision.completed_at ?? new Date().toISOString(),
            project_id: projectId,
            title: canonicalLayerTitle("l2", projectId),
            content: committedContent
          }]
        });
      } else if (kind === "l3") {
        const latestByProject = latestCompletedL3ByProject(
          await listDistillationJobs(stateRoot, runtime.accountId)
        );
        if (latestByProject.length >= 2) {
          queuedNext = await (input.enqueueDerived ?? enqueueDerivedDistillationJob)({
            stateRoot,
            accountId: runtime.accountId,
            target: "l4",
            projectId: null,
            evidence: latestByProject.map((item) => ({
              ref: `l3:${item.result_id}:${item.job_id}`,
              kind: "artifact",
              layer: "L3",
              timestamp: item.result_committed_at ?? item.completed_at ?? item.updated_at,
              project_id: item.project_id!,
              title: canonicalLayerTitle("l3", item.project_id!),
              content: item.result_content!
            }))
          });
        }
      }
      } catch (error) {
        // Upstream L2/L3 and the completed job are durable. Queue failure
        // is a separate recoverable condition, not permission to replay Core.
        nextLayerEnqueueError = error instanceof Error ? error.message : String(error);
        console.error("[litsan] next-layer distillation enqueue failed:", nextLayerEnqueueError);
      }
    } else if (kind !== "skill") {
      try {
        completedRevision = await recordCompletedDistillationRevision({
          stateRoot,
          accountId: runtime.accountId,
          target: kind,
          projectId,
          ...(conversationId ? { conversationId } : {}),
          evidence: resolvedEvidence,
          resultId,
          content: committedContent,
          committedAt: coreCommittedAt!,
          operationId: operation.generation,
          coreBody: result && typeof result === "object" && typeof (result as { body?: unknown }).body === "string" ? committedContent : undefined,
          ...(factMetadata ? { factMetadata } : {})
        });
      } catch (error) {
        throw new Error(
          `Memory Core committed ${kind.toUpperCase()} but its immutable revision ledger could not be recorded; retry the same idempotent submit for reconciliation: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    if (!jobId && kind === "l2" && projectId && completedRevision) {
      try {
        queuedNext = await (input.enqueueDerived ?? enqueueDerivedDistillationJob)({
          stateRoot,
          accountId: runtime.accountId,
          target: "l3",
          projectId,
          evidence: [{
            ref: `l2:${resultId}:${completedRevision.job_id}`,
            kind: "artifact",
            layer: "L2",
            timestamp: completedRevision.result_committed_at ?? completedRevision.completed_at ?? new Date().toISOString(),
            project_id: projectId,
            title: canonicalLayerTitle("l2", projectId),
            content: committedContent
          }]
        });
      } catch (error) {
        // The canonical L2 revision is already durable. A downstream queue
        // failure must remain recoverable through reconcile_derived and must
        // never cause the L2 Core write to be replayed.
        nextLayerEnqueueError = error instanceof Error ? error.message : String(error);
        console.error("[litsan] next-layer distillation enqueue failed:", nextLayerEnqueueError);
      }
    }
    if (kind === "l2" && projectId && preparedArchitectureMap) {
      try {
        const write = await runtime.architecture.writeProjectCognitiveMap({
          accountId: runtime.accountId,
          projectId,
          expectedFingerprint: architectureMapBaseFingerprint!,
          map: preparedArchitectureMap
        });
        architectureMapResult = {
          fingerprint: write.after.fingerprint,
          generated_at: write.after.map!.generated_at,
          nodes: write.after.map!.nodes.length,
          edges: write.after.map!.edges.length,
          timeline_links: write.after.map!.timeline_links.length
        };
      } catch (error) {
        // L2 is already durable. Architecture Cognitive Map is a separate
        // derived Project Architecture artifact and cannot retroactively turn
        // a successful L2 write into a failed memory commit.
        architectureMapError = error instanceof Error ? error.message : String(error);
        console.error("[litsan] architecture cognitive map update failed:", architectureMapError);
      }
    }
    const resultEvidenceRef = completedRevision && kind !== "skill"
      ? `${kind}:${resultId}:${completedRevision.job_id}`
      : undefined;
    let distillationTrace: Awaited<ReturnType<typeof recordDistillationTrace>> | undefined;
    let distillationTraceError: string | undefined;
    if (claimTraces.length > 0) {
      try {
        distillationTrace = await recordDistillationTrace({
          stateRoot,
          accountId: runtime.accountId,
          jobId,
          targetLayer: kind,
          projectId,
          commitRevision: resultEvidenceRef,
          claims: claimTraces
        });
      } catch (error) {
        // The canonical Memory/ledger commit already succeeded. Audit telemetry
        // must not turn that durable success into an ambiguous write/retry path.
        distillationTraceError = error instanceof Error ? error.message : String(error);
        console.error("[litsan] distillation trace:", distillationTraceError);
      }
    }
    if (kind === "l2" && projectId && projectDescription) {
      // Complete the source job before optional routing metadata: a slow or
      // failed secondary update must not hold a live distillation lease open
      // after the Core artifact has already been committed.
      try {
        await runtime.projects.updateDistilledDescription(
          runtime.accountId,
          projectId,
          projectDescription,
          evidenceRefs ?? []
        );
      } catch (error) {
        projectDescriptionError = error instanceof Error ? error.message : String(error);
        console.error("[litsan] distilled project description update failed:", projectDescriptionError);
      }
    }
    const response = {
      ok: true,
      kind,
      scope,
      project: projectId,
      sourceHarness,
      nativeEvolution: false,
      contract: DISTILLATION_CONTRACT_VERSION,
      job_id: jobId,
      memory: result,
      ...(resultEvidenceRef ? { result_evidence_ref: resultEvidenceRef } : {}),
      ...(factMetadata ? { fact_metadata: factMetadataSummary(factMetadata) } : {}),
      ...(distillationTrace ? { distillation_trace: distillationTrace } : {}),
      ...(distillationTraceError ? { distillation_trace_error: distillationTraceError } : {}),
      ...(projectDescriptionError ? { project_description_error: projectDescriptionError } : {}),
      ...(architectureMapResult ? { architecture_map: architectureMapResult } : {}),
      ...(architectureMapError ? { architecture_map_error: architectureMapError } : {}),
      ...(nextLayerEnqueueError ? { next_layer_enqueue_error: nextLayerEnqueueError } : {}),
      ...(queuedNext ? { next_layer_job: queuedNext } : {})
    };
    operation.terminalAt = new Date().toISOString();
    operation.response = JSON.parse(JSON.stringify(response)) as Record<string, unknown>;
    await saveCommit();
    return operation.response;
    });
    if (args.dry_run !== true) await pruneDistillationCommitRecords(stateRoot, runtime.accountId);
    return response;
}

function requiredString(value: unknown, field: string): string {
  const normalized = optionalString(value);
  if (!normalized) throw new TypeError(`${field} is required`);
  return normalized;
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized ? normalized : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
  return values.length ? [...new Set(values)] : undefined;
}

function uniqueStrings(values: string[]): string[] | undefined {
  const normalized = values.map((value) => value.trim()).filter(Boolean);
  return normalized.length ? [...new Set(normalized)] : undefined;
}

function canonicalLayerTitle(kind: "l2" | "l3", projectId: string): string {
  return kind === "l2"
    ? `Project Timeline · ${projectId}`
    : `Project Rules & Experience · ${projectId}`;
}

function assertRoutineL2PreservesCanonicalTimeline(input: {
  jobs: DistillationJob[];
  projectId: string;
  jobProjectId: string | null;
  content: string;
}): void {
  const base = latestCanonicalL2(input.jobs, input.projectId, input.jobProjectId, { includeRetired: true });
  if (!base?.result_content?.trim() || !base.result_id) return;

  const baseHeadings = timelineHeadingKeys(base.result_content);
  if (baseHeadings.length === 0) return;
  const candidateHeadings = new Set(timelineHeadingKeys(input.content));
  const missing = baseHeadings.filter((heading) => !candidateHeadings.has(heading));
  if (missing.length === 0) return;

  const baseRef = `l2:${base.result_id}:${base.job_id}`;
  const examples = missing.slice(0, 3).join(" | ");
  throw new Error(
    `L2 candidate would drop canonical timeline history: ${missing.length}/${baseHeadings.length} prior event headings are missing. ` +
    `Load current canonical L2 ${baseRef} and submit a full timeline replacement, not a delta.` +
    (examples ? ` Missing examples: ${examples}` : "")
  );
}

function timelineHeadingKeys(content: string): string[] {
  const values = [...content.matchAll(/^##\s+(.+?)\s*$/gm)]
    .map((match) => normalizeTimelineHeading(match[1] ?? ""))
    .filter(Boolean);
  return [...new Set(values)];
}

function normalizeTimelineHeading(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase("en-US");
}

function memoryResultId(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["id", "memoryId", "skillId"] as const) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return undefined;
}

function requireMemoryResultId(value: unknown): string {
  const id = memoryResultId(value);
  if (!id) throw new Error("Memory Core did not return a stable result id for history distillation");
  return id;
}

function optionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError("value must be a finite number");
  return value;
}

export interface ArtifactCommit {
  createdAt?: string;
  sentAt?: string;
  terminalAt?: string;
  args?: Record<string, unknown>;
  evidence?: DistillationEvidenceItem[];
  operatorResolution?: { reason: string; at: string };
  candidateHash: string;
  generation: string;
  payload?: Parameters<DistillationSubmitDeps["memory"]["distill"]>[0];
  coreResult?: unknown;
  committedAt?: string;
  rejected?: boolean;
  response?: Record<string, unknown>;
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

// Independent 60-second acquisition budget; the shared jobs lock remains short.
async function withArtifactCommitLock<T>(path: string, run: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    let acquired = false;
    try { return await withFileMutationLock(path, () => { acquired = true; return run(); }); }
    catch (error) {
      if (acquired || attempt === 3 || !(error instanceof Error) ||
          error.message !== `timed out waiting for state lock: ${resolve(path)}`) throw error;
    }
  }
}

export async function writeDistillationCommitFile(path: string, record: ArtifactCommit): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${randomUUID()}`;
  try {
    const handle = await commitFs.open(temporary, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(record) + "\n", "utf8"); await handle.sync(); }
    finally { await handle.close(); }
    for (let attempt = 0; ; attempt++) {
      try { await commitFs.rename(temporary, path); break; }
      catch (error) {
        if (process.platform !== "win32" || attempt === 5 ||
            !["EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        await new Promise(done => setTimeout(done, 20 * 2 ** attempt));
      }
    }
    if (process.platform !== "win32") {
      const directory = await commitFs.open(dirname(path), "r");
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } finally {
    await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
  }
}

/** Only answered/rejected operations are collectible; unknown/corrupt records stay protected. */
export async function pruneDistillationCommitRecords(stateRoot: string, accountId: string): Promise<void> {
  const directory = join(resolve(stateRoot), "distillation", "commits");
  let names: string[];
  try { names = await readdir(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  const terminal: { path: string; generation: string; at: number }[] = [];
  for (const name of names.filter(name => /^[a-f0-9]{64}\.json$/.test(name))) {
    const path = join(directory, name);
    try {
      const record = JSON.parse(await readFile(path, "utf8")) as ArtifactCommit;
      if (!record || typeof record.generation !== "string") continue;
      if (record.payload?.accountId === accountId && (record.response || record.rejected)) {
        const at = record.terminalAt ? Date.parse(record.terminalAt) : (await stat(path)).mtimeMs;
        if (Number.isFinite(at)) terminal.push({ path, generation: record.generation, at });
      }
    } catch (error) {
      if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  terminal.sort((a, b) => b.at - a.at);
  for (const [index, entry] of terminal.entries()) {
    if (index < 256 && Date.now() - entry.at < 7 * 24 * 60 * 60 * 1000) continue;
    await withArtifactCommitLock(entry.path, async () => {
      try {
        const record = JSON.parse(await readFile(entry.path, "utf8")) as ArtifactCommit;
        if (record.generation === entry.generation && (record.response || record.rejected)) await unlink(entry.path);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    });
  }
}

export async function reconcileDistillationCommit(input: {
  stateRoot: string; runtime: DistillationSubmitDeps; commitId?: string;
  mode: "inspect" | "reconcile" | "abandon"; generation?: string; confirmation?: string; reason?: string;
}): Promise<Record<string, unknown>> {
  const directory = join(resolve(input.stateRoot), "distillation", "commits");
  if (!input.commitId) {
    if (input.mode !== "inspect") throw new Error("commit_id is required");
    let names: string[];
    try { names = await readdir(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { commits: [] }; throw error; }
    const commits = [];
    for (const name of names.filter(name => /^[a-f0-9]{64}\.json$/.test(name))) {
      const record = JSON.parse(await readFile(join(directory, name), "utf8")) as ArtifactCommit;
      if (record.payload?.accountId === input.runtime.accountId) commits.push({ commit_id: name.slice(0, -5), ...record });
    }
    return { commits };
  }
  if (!/^[a-f0-9]{64}$/.test(input.commitId)) throw new Error("invalid commit_id");
  const path = join(directory, input.commitId + ".json");
  const response = await withArtifactCommitLock(path, async () => {
    const record = JSON.parse(await readFile(path, "utf8")) as ArtifactCommit;
    if (record.payload?.accountId !== input.runtime.accountId) throw new Error("commit belongs to another account");
    if (input.mode === "inspect") return { commit_id: input.commitId, ...record };
    if (record.generation !== input.generation) throw new Error("commit generation changed; inspect again");
    if (record.response || record.rejected) throw new Error("commit is already terminal");
    if (input.mode === "reconcile") {
      const result = record.coreResult ?? await withCoreMemoryReconciliation(() => input.runtime.memory.distill(record.payload!));
      requireMemoryResultId(result);
      record.coreResult = result;
      record.committedAt ??= new Date().toISOString();
      await writeDistillationCommitFile(path, record);
      return { outcome: "committed", memory: result, frozen_args: record.args,
        next: "Resubmit frozen_args using the current lease token to finish the local ledger; Core will not be written again." };
    }
    if (!input.reason?.trim() || input.confirmation !== `abandon:${record.generation}`) {
      throw new Error("abandon requires a reason and explicit operator confirmation abandon:<generation>; Core may already contain this operation");
    }
    record.rejected = true;
    record.terminalAt = new Date().toISOString();
    record.operatorResolution = { reason: input.reason.trim(), at: record.terminalAt };
    await writeDistillationCommitFile(path, record);
    return { outcome: "abandoned", generation: record.generation, core_mutated: false };
  });
  if (input.mode === "abandon") await pruneDistillationCommitRecords(input.stateRoot, input.runtime.accountId);
  return response;
}
