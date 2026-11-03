import { join } from "node:path";
import { createHash } from "node:crypto";
import { withFileMutationLock } from "./file-mutation-lock.js";
import { readBranchDraft, mutateBranchDraft } from "./branch-drafts.js";
import { commitL2Append } from "./l2-append.js";
import type { DistillationSubmitDeps } from "./distillation-submit.js";
import { architectureCognitiveMapFingerprint } from "./architecture-cognitive-map.js";
import type { BranchBinding, ProjectBranch, WorkstreamHint } from "./contracts/branches.js";
import type { JsonProjectBranchStore } from "./branch-store.js";
import { deriveWorkstreamKey } from "./core/workstream/binding.js";
import { pickBranchToEvict } from "./core/workstream/cap.js";
import { discoverySkipReason } from "./core/lifecycle/distillation-eligibility.js";
import { assignEventBranch, effectiveBranches, eventBranchAssignment, listEventsByKey } from "./capture-branch-assignments.js";
import { captureIngestedAt, captureIsFullyExcludedFromMemory, listCaptureEvents } from "./capture.js";
import { resolveCaptureProject } from "./capture-project-resolution.js";
import { getDistillationConfig, listDistillationJobs, type DistillationJob } from "./distillation-jobs.js";
import { buildProjectModel, type ProjectModelBuilderDeps } from "./shell/archify/project-model.js";
import { isWorkstreamEnabled } from "./workstream-config.js";
import type { ProjectReader } from "./core/ports/projects.js";

export type WorkstreamDeps = ProjectModelBuilderDeps & {
  branches: JsonProjectBranchStore; projects: Pick<ProjectReader, "resolve" | "storageIds">;
};
export async function readBranchBase(runtime: ProjectModelBuilderDeps, stateRoot: string, projectId: string) {
  const model = await buildProjectModel(runtime, { stateRoot, projectId, l2: [], todos: [] });
  const head = model.revisions.filter(r => r.project_id === projectId).sort((a, b) =>
    a.committed_at.localeCompare(b.committed_at) || a.ref.localeCompare(b.ref)).at(-1);
  return { base_map_fingerprint: architectureCognitiveMapFingerprint(model.architecture.map), base_l2_revision: head?.ref ?? null };
}

/** Same read-only claimed-evidence lookup as discovery; no distillation policy changes. */
export async function claimedBranchEvents(stateRoot: string, account: string): Promise<Set<string>> {
  const jobs = await listDistillationJobs(stateRoot, account);
  return new Set(jobs.filter(j => j.target === "l2")
    .flatMap(j => j.evidence_refs.filter(ref => ref.startsWith("l1:")).map(ref => ref.slice(3))));
}

export async function bindWorkstreamTurn(input: {
  runtime: WorkstreamDeps; stateRoot: string; projectId: string; eventId: string;
  branch?: string; hint?: WorkstreamHint; now: string;
}): Promise<{ id: string; name: string; source: BranchBinding["source"]; reason: BranchBinding["reason"]; created?: boolean; evicted?: { id: string; name: string } }> {
  const { runtime, stateRoot, projectId, eventId, now } = input, account = runtime.accountId;
  const bound = await runtime.branches.withProjectLock<Awaited<ReturnType<typeof bindWorkstreamTurn>>>(account, projectId, async store => {
    const prior = await eventBranchAssignment(stateRoot, account, eventId);
    if (prior) {
      const existing = prior.branch_id === "main" ? null : await store.resolve(account, projectId, prior.branch_id, { includeClosed: true });
      if (existing?.status === "closing") {
        const victim = pickBranchToEvict(await store.list(account, projectId));
        if (victim) await store.closeForCap(victim.branchId, true);
        await store.transition(account, projectId, existing.branchId, { status: "active", closing_since: undefined, closed_reason: undefined }, now);
      }
      if (existing) await store.touch(existing.branchId, now);
      return { id: prior.branch_id, name: existing?.name ?? "main",
        source: prior.workstream_key ? "workstream" : existing ? "explicit" : "main",
        reason: prior.reason === "retag" || prior.reason === "auto_promote"
          ? !existing ? "no_hint" : existing.workstream_key?.startsWith("git:") ? "git_branch"
            : existing?.workstream_key?.startsWith("wt:") ? "worktree"
            : existing?.workstream_key?.startsWith("cont:") ? "continuity" : "explicit_branch"
          : prior.reason as BranchBinding["reason"] };
    }
    let branch: ProjectBranch | null = null;
    let source: BranchBinding["source"] = "main", reason: BranchBinding["reason"] = "no_hint";
    let key: string | undefined, created = false, evicted: { id: string; name: string } | undefined;
    if (input.branch) {
      branch = await store.resolve(account, projectId, input.branch, { includeClosed: true });
      if (branch && !["active", "closing"].includes(branch.status)) branch = null;
      if (!branch) throw new Error(`unknown active branch for project ${projectId}: ${input.branch}`);
      if (branch.status === "closing") {
        const victim = pickBranchToEvict(await store.list(account, projectId));
        if (victim) { await store.closeForCap(victim.branchId, true); evicted = { id: victim.branchId, name: victim.name }; }
        branch = await store.transition(account, projectId, branch.branchId,
          { status: "active", closing_since: undefined, closed_reason: undefined }, now);
      }
      source = "explicit"; reason = "explicit_branch";
    } else {
      const derived = deriveWorkstreamKey(input.hint);
      if (derived.key === null) reason = derived.reason;
      else {
        key = derived.key; source = "workstream"; reason = derived.kind;
        branch = await store.findActiveByKey(account, projectId, key);
        const earlier = await listEventsByKey(stateRoot, account, projectId, key);
        if (!branch) {
          const closed = await store.findByKey(account, projectId, key, { includeClosed: true });
          if (!closed && derived.kind === "continuity" && earlier.length === 0) reason = "continuity_first_turn";
          else {
            const base = closed?.status === "closing"
              ? { base_map_fingerprint: closed.base_map_fingerprint!, base_l2_revision: closed.base_l2_revision ?? null }
              : await readBranchBase(runtime, stateRoot, projectId);
            const victim = pickBranchToEvict(await store.list(account, projectId));
            branch = closed
              ? await store.refreshBase(account, projectId, closed.branchId, base, now)
              : await store.createAuto(account, projectId, { key, name: derived.display,
                  goal: input.hint?.label ?? derived.display, ...base, now });
            if (victim) {
              await store.closeForCap(victim.branchId, true);
              evicted = { id: victim.branchId, name: victim.name };
            }
            if (closed) await mutateBranchDraft(stateRoot, account, projectId, branch.branchId, async draft => { if (draft.status === "merged") draft.merged_event_count = draft.events.length; draft.status = "open"; delete draft.merged_at; delete draft.merge_job_id; delete draft.archived_at; });
            created = !closed;
            if (derived.kind === "continuity") {
              const claimed = await claimedBranchEvents(stateRoot, account);
              const effective = await effectiveBranches(stateRoot, account, earlier);
              for (const id of earlier) if (!claimed.has(id) && effective.get(id) !== branch.branchId) {
                const event = (await listCaptureEvents(stateRoot, account, { eventId: id, limit: 1 }))[0];
                const resolved = event && await resolveCaptureProject(event, ref => runtime.projects.resolve(account, ref), stateRoot);
                if (resolved?.projectId !== projectId) continue;
                await assignEventBranch(stateRoot, { account_id: account, project_id: projectId, event_id: id,
                  branch_id: branch.branchId, workstream_key: key, reason: "auto_promote", actor: "host", created_at: now });
              }
            }
          }
        }
      }
    }
    await assignEventBranch(stateRoot, { account_id: account, project_id: projectId, event_id: eventId,
      branch_id: branch?.branchId ?? "main", workstream_key: key ?? null, reason, actor: "host", created_at: now }, true);
    if (branch) await store.touch(branch.branchId, now);
    return { id: branch?.branchId ?? "main", name: branch?.name ?? "main", source, reason,
      ...(created ? { created: true } : {}), ...(evicted ? { evicted } : {}) };
  });
  return bound;
}

export async function retagBranchEvents(input: { runtime: WorkstreamDeps; stateRoot: string; projectId: string; eventIds: string[]; target: string }) {
  const { runtime, stateRoot, projectId } = input, account = runtime.accountId;
  if (!await isWorkstreamEnabled(stateRoot, account, projectId)) throw new Error("workstream_disabled");
  return runtime.branches.withProjectLock(account, projectId, async store => {
    const target = input.target === "main" ? null : await store.resolve(account, projectId, input.target);
    if (input.target !== "main" && !target) return { moved: 0,
      refused: [...new Set(input.eventIds)].map(event_id => ({ event_id, code: "target_not_active" as const })) };
    const claimed = await claimedBranchEvents(stateRoot, account);
    let moved = 0;
    const refused: { event_id: string; code: "wrong_project" | "already_distilled" | "already_on_target" }[] = [];
    const effective = await effectiveBranches(stateRoot, account, input.eventIds);
    for (const id of new Set(input.eventIds)) {
      const event = (await listCaptureEvents(stateRoot, account, { eventId: id, limit: 1 }))[0];
      const resolution = event && await resolveCaptureProject(event, ref => runtime.projects.resolve(account, ref), stateRoot);
      if (resolution?.projectId !== projectId) { refused.push({ event_id: id, code: "wrong_project" }); continue; }
      if (effective.get(id) === (target?.branchId ?? "main")) { refused.push({ event_id: id, code: "already_on_target" }); continue; }
      if (claimed.has(id)) { refused.push({ event_id: id, code: "already_distilled" }); continue; }
      if (await assignEventBranch(stateRoot, { account_id: account, project_id: projectId, event_id: id,
        branch_id: target?.branchId ?? "main", workstream_key: target?.workstream_key ?? null,
        reason: "retag", actor: "host", created_at: new Date().toISOString() })) moved++;
    }
    return { moved, refused };
  });
}

export type WorkstreamMergeDeps = { stateRoot: string; runtime: WorkstreamDeps & DistillationSubmitDeps };

async function hasUndistilledBranchL1(deps: WorkstreamMergeDeps, projectId: string, branchId: string, jobs?: DistillationJob[]): Promise<boolean> {
  const { stateRoot, runtime } = deps;
  const config = await getDistillationConfig(stateRoot);
  const claimed = new Set((jobs ?? await listDistillationJobs(stateRoot, runtime.accountId)).filter(j => j.target === "l2")
    .flatMap(j => j.evidence_refs.filter(ref => ref.startsWith("l1:")).map(ref => ref.slice(3))));
  const captures = await listCaptureEvents(stateRoot, runtime.accountId, { completeOnly: true, ingested: true });
  const effective = await effectiveBranches(stateRoot, runtime.accountId, captures.map(e => e.event_id));
  for (const event of captures) {
    if (effective.get(event.event_id) !== branchId || claimed.has(event.event_id)) continue;
    const ingestedAt = await captureIngestedAt(stateRoot, runtime.accountId, event.event_id);
    if (discoverySkipReason(event, {
      autoEnabled: config.auto_enabled, autoSince: config.auto_since, ingestedAt,
      privacyExcluded: captureIsFullyExcludedFromMemory(event)
    })) continue;
    const resolved = await resolveCaptureProject(event, ref => runtime.projects.resolve(runtime.accountId, ref), stateRoot);
    if (resolved.projectId === projectId) return true;
  }
  return false;
}

export async function mergeBranch(deps: WorkstreamMergeDeps, projectId: string, branchId: string, now = new Date(), sweepJobs?: DistillationJob[]) {
  const { stateRoot, runtime } = deps, account = runtime.accountId;
  // Store lock first, including cap/close callers; a separate project mutex also
  // fences independent store instances and serializes the external main commit.
  return runtime.branches.withProjectLock(account, projectId, store => withFileMutationLock(
    join(stateRoot, "workstream-merges", createHash("sha256").update(JSON.stringify([account, projectId])).digest("hex")), async () => {
      const branch = await store.resolve(account, projectId, branchId, { includeClosed: true });
      if (!branch) throw new Error("unknown branch");
      if (branch.status === "merged") return { status: "merged" as const, appended: 0 };
      if (branch.status !== "closing") return { status: "deferred" as const, reason: "not_closing", deferred: "not_closing" as const };
      const allJobs = sweepJobs ?? await listDistillationJobs(stateRoot, account);
      const jobs = allJobs.filter(j => j.project_id === projectId && j.branch_id === branchId);
      await mutateBranchDraft(stateRoot, account, projectId, branchId, async current => {
        const failed = jobs.filter(j => j.status === "failed").map(j => j.job_id).sort();
        if (failed.length) current.failed_job_ids = failed;
      });
      if (jobs.some(j => j.status !== "completed" && j.status !== "failed")) return { status: "deferred" as const, reason: "pending_jobs", deferred: "pending_jobs" as const };
      if (await hasUndistilledBranchL1(deps, projectId, branchId, allJobs)) return { status: "deferred" as const, reason: "undistilled_l1", deferred: "undistilled_l1" as const };
      const draft = await readBranchDraft(stateRoot, account, projectId, branchId);
      if (draft?.status === "archived") return { status: "deferred" as const, reason: "archived", deferred: "archived" as const };
      const completedIds = new Set(jobs.filter(j => j.status === "completed").map(j => j.job_id));
      const result = await commitL2Append(deps, { projectId, events: draft?.events.slice(draft.merged_event_count ?? 0).filter(e => completedIds.has(e.job_id)).map(e => e.event) ?? [], now,
        provenance: { branch_id: branchId, branch_name: branch.name, harness: "memhub-branch-merge", source_job_ids: jobs.filter(j => j.status === "completed").map(j => j.job_id) } });
      await mutateBranchDraft(stateRoot, account, projectId, branchId, async current => {
        current.status = "merged"; current.merged_at = now.toISOString();
        if (result.job_id) current.merge_job_id = result.job_id;
        current.merged_event_count = current.events.length;
      });
      await store.transition(account, projectId, branchId, { status: "merged", merged_at: now.toISOString(),
        ...(result.job_id ? { merge_job_id: result.job_id } : {}) }, now.toISOString());
      return { status: "merged" as const, appended: result.appended, committed: result.committed };
    }));
}

export async function closeWorkstreamBranch(deps: WorkstreamMergeDeps, projectId: string, reference: string, now = new Date()) {
  const { runtime, stateRoot } = deps;
  const branch = await runtime.branches.resolve(runtime.accountId, projectId, reference, { includeClosed: true });
  if (!branch) throw new Error("unknown branch");
  const draft = await readBranchDraft(stateRoot, runtime.accountId, projectId, branch.branchId);
  const hasBranchJobs = (await listDistillationJobs(stateRoot, runtime.accountId)).some(j => j.project_id === projectId && j.branch_id === branch.branchId);
  if (!await isWorkstreamEnabled(stateRoot, runtime.accountId, projectId) && !draft && !hasBranchJobs) {
    return { branch: await runtime.branches.close(runtime.accountId, projectId, reference) };
  }
  if (branch.status !== "merged" && branch.status !== "expired") await runtime.branches.transition(runtime.accountId, projectId, branch.branchId,
    { status: "closing", closing_since: branch.closing_since ?? now.toISOString(), closed_reason: "user" }, now.toISOString());
  const merge = await mergeBranch(deps, projectId, branch.branchId, now);
  return { branch: (await runtime.branches.resolve(runtime.accountId, projectId, branch.branchId, { includeClosed: true }))!, merge };
}

export async function sweepWorkstreamBranches(deps: WorkstreamMergeDeps, now = new Date()): Promise<void> {
  const { runtime, stateRoot } = deps, account = runtime.accountId;
  // Read the account ledger once; reuse its claimed/pending snapshot per branch.
  const allJobs = await listDistillationJobs(stateRoot, account);
  for (const project of await runtime.projects.list(account)) {
    const projectId = project.projectId, enabled = await isWorkstreamEnabled(stateRoot, account, projectId);
    for (const branch of await runtime.branches.list(account, projectId, { includeClosed: true })) {
      if (branch.status !== "active" && branch.status !== "closing") continue;
      try {
        const draft = await readBranchDraft(stateRoot, account, projectId, branch.branchId);
        const jobs = allJobs.filter(j => j.branch_id === branch.branchId && j.project_id === projectId);
        if (!enabled && !draft && !jobs.length) continue;
        const idle = now.getTime() - Date.parse(branch.last_activity_at ?? branch.updatedAt);
        if (branch.status === "active" && idle >= 3 * 86400_000 && !await hasUndistilledBranchL1(deps, projectId, branch.branchId, allJobs)) {
          await runtime.branches.withProjectLock(account, projectId, async store => {
            const current = await store.resolve(account, projectId, branch.branchId, { includeClosed: true });
            if (current?.status === "active" && current.last_activity_at === branch.last_activity_at) {
              await store.transition(account, projectId, branch.branchId,
                { status: "closing", closing_since: now.toISOString(), closed_reason: "idle" }, now.toISOString());
            }
          });
        }
        let merged = false;
        try { merged = (await mergeBranch(deps, projectId, branch.branchId, now, allJobs)).status === "merged"; }
        catch (error) { console.error("[litsan] workstream sweep:", projectId, branch.branchId, error); }
        if (merged) continue;
        await runtime.branches.withProjectLock(account, projectId, async store => {
          const current = await store.resolve(account, projectId, branch.branchId, { includeClosed: true });
          if (current?.status !== "closing" || !current.closing_since) return;
          const since = Math.max(Date.parse(current.last_activity_at ?? current.updatedAt), Date.parse(current.closing_since));
          if (now.getTime() - since < 14 * 86400_000) return;
          await mutateBranchDraft(stateRoot, account, projectId, branch.branchId, async d => { d.status = "archived"; d.archived_at = now.toISOString(); });
          await store.transition(account, projectId, branch.branchId, { status: "expired", expired_at: now.toISOString() }, now.toISOString());
        });
      } catch (error) {
        console.error("[litsan] workstream sweep:", projectId, branch.branchId, error);
      }
    }
  }
}
