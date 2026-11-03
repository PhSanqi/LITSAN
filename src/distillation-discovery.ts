import { hasWorkstreamProjects } from "./workstream-config.js";
import { effectiveBranches } from "./capture-branch-assignments.js";
import { isWorkstreamEnabled } from "./workstream-config.js";
import { JsonProjectBranchStore } from "./branch-store.js";
import { join, resolve } from "node:path";
import { captureIndexWatermark, captureIndexStats, captureIngestedAt, captureIsFullyExcludedFromMemory, listCaptureEvents, listCaptureIndexEntries, type StoredCaptureEvent } from "./capture.js";
import { resolveCaptureProject } from "./capture-project-resolution.js";
import { discoverySkipReason } from "./core/lifecycle/distillation-eligibility.js";
import {
  effectiveDistillationFailureKind,
  enqueueDistillationJob,
  enqueueGlobalStateDistillationJob,
  getDistillationConfig,
  listDistillationJobs
} from "./distillation-jobs.js";
import { globalStateAdmission } from "./global-state.js";

export interface DiscoveryReport {
  auto_enabled: boolean;
  auto_since: string | null;
  source: "complete_ingested_capture_only";
  captured_total: number;
  complete_uningested: number;
  incomplete: number;
  pending_jobs: number;
  leased_jobs: number;
  failed_jobs: number;
  actionable_failed_jobs: number;
  historical_failed_jobs: number;
  scanned: number;
  eligible: number;
  unresolved: number;
  privacy_excluded: number;
  skipped_relation: number;
  workspace_resolved: number;
  explicit_global_waiting: number;
  explicit_global_represented: number;
  explicit_global_skipped_noise: number;
  explicit_global_would_enqueue: number;
  explicit_global_queued: number;
  already_queued: number;
  waiting: number;
  would_enqueue: number;
  queued: number;
  duplicates: number;
  cutover_missing: boolean;
}

const successfulScans = new Map<string, { watermark: string; config: string; fullAt: number; nextScanAt: number; report: DiscoveryReport }>();

/** Reconcile durable L1 captures into jobs; semantic synthesis remains with the Harness. */
export async function discoverDistillationJobs(input: {
  stateRoot: string;
  accountId: string;
  resolveProject: (projectHint: string) => Promise<string | null>;
  enqueue?: boolean;
  now?: Date;
  skipUnchanged?: boolean;
}): Promise<DiscoveryReport> {
  const config = await getDistillationConfig(input.stateRoot);
  const scanKey = JSON.stringify([resolve(input.stateRoot), input.accountId]);
  const scanTime = (input.now ?? new Date()).getTime();
  const configKey = JSON.stringify(config);
  const branchAware = await hasWorkstreamProjects(input.stateRoot, input.accountId);
  const prior = successfulScans.get(scanKey);
  const pendingOrExpiredLease = (job: Awaited<ReturnType<typeof listDistillationJobs>>[number]) =>
    job.status === "pending" ||
    (job.status === "leased" && Boolean(job.leased_until) && Date.parse(job.leased_until!) <= scanTime);
  const activeOrMalformedLease = (job: Awaited<ReturnType<typeof listDistillationJobs>>[number]) =>
    job.status === "leased" &&
    (!job.leased_until || !Number.isFinite(Date.parse(job.leased_until)) || Date.parse(job.leased_until) > scanTime);

  // Explicit dry runs retain their full report. Only background reconciliation
  // skips unchanged history until the next idle cutover. Unresolved evidence
  // is never cached: new project resolution must take effect immediately.
  if (!branchAware && input.skipUnchanged && input.enqueue && config.auto_enabled && config.auto_since && prior &&
      prior.config === configKey && scanTime < prior.nextScanAt &&
      scanTime >= prior.fullAt && scanTime - prior.fullAt < 15 * 60_000) {
    const watermark = await captureIndexWatermark(input.stateRoot, input.accountId);
    if (prior.watermark === watermark) {
      return {
        ...prior.report,
        scanned: 0,
        eligible: 0,
        unresolved: 0,
        privacy_excluded: 0,
        skipped_relation: 0,
        workspace_resolved: 0,
        explicit_global_waiting: 0,
        explicit_global_represented: 0,
        explicit_global_skipped_noise: 0,
        explicit_global_would_enqueue: 0,
        explicit_global_queued: 0,
        already_queued: 0,
        waiting: 0,
        would_enqueue: 0,
        queued: 0,
        duplicates: 0
      };
    }
  }

  const stats = await captureIndexStats(input.stateRoot, input.accountId);
  const unIngested = await listCaptureIndexEntries(input.stateRoot, input.accountId, { completeOnly: true, ingested: false });
  const jobs = await listDistillationJobs(input.stateRoot, input.accountId);
  const report: DiscoveryReport = {
    auto_enabled: config.auto_enabled,
    auto_since: config.auto_since ?? null,
    source: "complete_ingested_capture_only",
    captured_total: stats.total,
    complete_uningested: unIngested.length,
    incomplete: stats.incomplete,
    pending_jobs: jobs.filter(pendingOrExpiredLease).length,
    leased_jobs: jobs.filter(activeOrMalformedLease).length,
    failed_jobs: jobs.filter((job) => job.status === "failed").length,
    actionable_failed_jobs: jobs.filter((job) =>
      job.status === "failed" && effectiveDistillationFailureKind(job) !== "invalid_legacy_evidence"
    ).length,
    historical_failed_jobs: jobs.filter((job) =>
      job.status === "failed" && effectiveDistillationFailureKind(job) === "invalid_legacy_evidence"
    ).length,
    scanned: 0, eligible: 0, unresolved: 0, privacy_excluded: 0, skipped_relation: 0, workspace_resolved: 0,
    explicit_global_waiting: 0, explicit_global_represented: 0, explicit_global_skipped_noise: 0,
    explicit_global_would_enqueue: 0, explicit_global_queued: 0, already_queued: 0,
    waiting: 0, would_enqueue: 0, queued: 0, duplicates: 0,
    cutover_missing: config.auto_enabled && !config.auto_since
  };
  if (!config.auto_enabled || !config.auto_since) return report;
  const watermark = await captureIndexWatermark(input.stateRoot, input.accountId);
  const captures = await listCaptureEvents(input.stateRoot, input.accountId, {
    ingested: true,
    completeOnly: true
  });
  const assignments = await effectiveBranches(input.stateRoot, input.accountId, captures.map(e => e.event_id));
  const enabled = new Map<string, boolean>();
  const branches = new JsonProjectBranchStore(join(input.stateRoot, "project-branches.json"));
  const used = new Set(jobs.filter((job) => job.target === "l2").flatMap((job) =>
    job.evidence_refs.map((ref) => `${job.project_id ?? ""}\0${ref}`)
  ));
  const usedEvidenceRefs = new Set(jobs.filter((job) => job.target === "l2").flatMap((job) => job.evidence_refs));
  const completedGlobalEvidenceRefs = new Set(jobs.filter((job) =>
    job.target === "global_state" && job.status === "completed" && job.result_kind === "global_state"
  ).flatMap((job) =>
    job.evidence_refs.filter((ref) => ref.startsWith("l1:"))
  ));
  const claimedGlobalEvidenceRefs = new Set(jobs.filter((job) =>
    job.target === "global_state" && !(job.status === "completed" && job.result_kind === "global_state")
  ).flatMap((job) => job.evidence_refs.filter((ref) => ref.startsWith("l1:"))));
  const globalJobInFlight = jobs.some((job) =>
    job.target === "global_state" && (job.status === "pending" || job.status === "leased")
  );
  const groups = new Map<string, { projectId: string; branchId?: string; captures: StoredCaptureEvent[] }>();
  const globalCaptures: StoredCaptureEvent[] = [];
  const resolved = new Map<string, string | null>();
  const ingestedTimes = new Map<string, string>();
  for (const event of captures) {
    const ingestedAt = await captureIngestedAt(input.stateRoot, input.accountId, event.event_id);
    const skip = discoverySkipReason(event, {
      autoEnabled: config.auto_enabled, autoSince: config.auto_since, ingestedAt,
      privacyExcluded: captureIsFullyExcludedFromMemory(event)
    });
    if (skip === "auto_disabled" || skip === "before_cutover") continue;
    ingestedTimes.set(event.event_id, ingestedAt!);
    report.scanned += 1;
    if (skip === "privacy_excluded") {
      report.privacy_excluded += 1;
      continue;
    }
    if (skip === "relation_relays" || skip === "relation_duplicate_of") {
      report.skipped_relation += 1;
      continue;
    }
    if (skip === "empty_text") {
      report.unresolved += 1;
      continue;
    }
    const resolution = await resolveCaptureProject(event, async (hint) => {
      if (!resolved.has(hint)) resolved.set(hint, await input.resolveProject(hint));
      return resolved.get(hint) ?? null;
    }, input.stateRoot);
    const projectId = resolution.projectId;
    if (!projectId) {
      // An explicit keep-global assignment is a resolved terminal routing
      // decision. It must not be reported as unresolved or fed into a
      // project-scoped L2 queue. Instead it enters the separate account-level
      // Global State path when it carries admissible state evidence.
      if (resolution.source === "keep_global") {
        const ref = `l1:${event.event_id}`;
        if (completedGlobalEvidenceRefs.has(ref)) {
          report.explicit_global_represented += 1;
        } else if (claimedGlobalEvidenceRefs.has(ref)) {
          report.explicit_global_waiting += 1;
        } else if (globalStateAdmission(event) === "skip_noise") {
          report.explicit_global_skipped_noise += 1;
        } else {
          globalCaptures.push(event);
        }
        continue;
      }
      if (usedEvidenceRefs.has(`l1:${event.event_id}`)) {
        report.eligible += 1;
        report.already_queued += 1;
        continue;
      }
      report.unresolved += 1;
      continue;
    }
    if (resolution.source === "workspace_path") report.workspace_resolved += 1;
    report.eligible += 1;
    if (used.has(`${projectId}\0l1:${event.event_id}`)) {
      report.already_queued += 1;
      continue;
    }
    if (!enabled.has(projectId)) enabled.set(projectId, await isWorkstreamEnabled(input.stateRoot, input.accountId, projectId));
    const assigned = assignments.get(event.event_id);
    const branchId = enabled.get(projectId) && assigned !== "main" ? assigned : undefined;
    const key = JSON.stringify([projectId, branchId ?? null]);
    const group = groups.get(key) ?? { projectId, ...(branchId ? { branchId } : {}), captures: [] };
    group.captures.push(event);
    groups.set(key, group);
  }
  const now = input.now ?? new Date();
  const cutoff = new Date(now.getTime() - config.idle_minutes * 60_000).toISOString();
  let nextScanAt = Infinity;
  for (const group of groups.values()) {
    group.captures.sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.event_id.localeCompare(b.event_id));
    const closing = group.branchId && (await branches.resolve(input.accountId, group.projectId, group.branchId, { includeClosed: true }))?.status === "closing";
    const idle = closing || group.captures.every((item) => (ingestedTimes.get(item.event_id) ?? "") <= cutoff);
    for (let offset = 0; offset < group.captures.length; offset += config.turn_threshold) {
      const batch = group.captures.slice(offset, offset + config.turn_threshold);
      if (batch.length < config.turn_threshold && !idle) {
        report.waiting += batch.length;
        nextScanAt = Math.min(nextScanAt, group.captures.reduce((latest, item) =>
          Math.max(latest, Date.parse(ingestedTimes.get(item.event_id)!) + config.idle_minutes * 60_000), 0));
        continue;
      }
      report.would_enqueue += 1;
      if (!input.enqueue) continue;
      const result = await enqueueDistillationJob({
        stateRoot: input.stateRoot,
        accountId: input.accountId,
        projectId: group.projectId,
        captures: batch,
        ...(group.branchId ? { branchId: group.branchId } : {}),
        reason: batch.length >= config.turn_threshold ? "turn_threshold" : "idle"
      });
      if (result.created) report.queued += 1;
      else report.duplicates += 1;
    }
  }
  globalCaptures.sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.event_id.localeCompare(b.event_id));
  const globalIdle = globalCaptures.length > 0 && globalCaptures.every((item) => (ingestedTimes.get(item.event_id) ?? "") <= cutoff);
  if (globalJobInFlight) {
    report.explicit_global_waiting += globalCaptures.length;
    return finalizeDiscoveryReport(report, input, pendingOrExpiredLease, activeOrMalformedLease, scanKey, watermark, configKey, scanTime, nextScanAt);
  }
  for (let offset = 0; offset < globalCaptures.length; offset += config.turn_threshold) {
    const batch = globalCaptures.slice(offset, offset + config.turn_threshold);
    if (batch.length < config.turn_threshold && !globalIdle) {
      report.explicit_global_waiting += batch.length;
      nextScanAt = Math.min(nextScanAt, batch.reduce((latest, item) =>
        Math.max(latest, Date.parse(ingestedTimes.get(item.event_id)!) + config.idle_minutes * 60_000), 0));
      continue;
    }
    report.explicit_global_would_enqueue += 1;
    if (!input.enqueue) {
      // Global State is a single canonical account artifact. Discovery may
      // offer only one synthesis batch at a time so every later job carries
      // the exact completed base revision.
      report.explicit_global_waiting += Math.max(0, globalCaptures.length - (offset + batch.length));
      break;
    }
    const result = await enqueueGlobalStateDistillationJob({
      stateRoot: input.stateRoot,
      accountId: input.accountId,
      captures: batch,
      reason: batch.length >= config.turn_threshold ? "turn_threshold" : "idle"
    });
    if (result.created) report.explicit_global_queued += 1;
    report.explicit_global_waiting += Math.max(0, globalCaptures.length - (offset + batch.length));
    break;
  }
  // Report the durable post-reconciliation queue, not only the pre-scan
  // snapshot. A caller must be able to distinguish newly queued work from
  // an idle queue without issuing a second, potentially failing MCP call.
  if (input.enqueue) {
    const currentJobs = await listDistillationJobs(input.stateRoot, input.accountId);
    report.pending_jobs = currentJobs.filter(pendingOrExpiredLease).length;
    report.leased_jobs = currentJobs.filter(activeOrMalformedLease).length;
    report.failed_jobs = currentJobs.filter((job) => job.status === "failed").length;
    report.actionable_failed_jobs = currentJobs.filter((job) =>
      job.status === "failed" && effectiveDistillationFailureKind(job) !== "invalid_legacy_evidence"
    ).length;
    report.historical_failed_jobs = currentJobs.filter((job) =>
      job.status === "failed" && effectiveDistillationFailureKind(job) === "invalid_legacy_evidence"
    ).length;
  }
  if (input.enqueue && report.unresolved === 0) {
    successfulScans.set(scanKey, { watermark, config: configKey, fullAt: scanTime, nextScanAt, report: { ...report } });
  } else if (input.enqueue) successfulScans.delete(scanKey);
  return report;
}

async function finalizeDiscoveryReport(
  report: DiscoveryReport,
  input: Parameters<typeof discoverDistillationJobs>[0],
  pendingOrExpiredLease: (job: Awaited<ReturnType<typeof listDistillationJobs>>[number]) => boolean,
  activeOrMalformedLease: (job: Awaited<ReturnType<typeof listDistillationJobs>>[number]) => boolean,
  scanKey: string,
  watermark: string,
  configKey: string,
  scanTime: number,
  nextScanAt: number
): Promise<DiscoveryReport> {
  if (input.enqueue) {
    const currentJobs = await listDistillationJobs(input.stateRoot, input.accountId);
    report.pending_jobs = currentJobs.filter(pendingOrExpiredLease).length;
    report.leased_jobs = currentJobs.filter(activeOrMalformedLease).length;
    report.failed_jobs = currentJobs.filter((job) => job.status === "failed").length;
    report.actionable_failed_jobs = currentJobs.filter((job) =>
      job.status === "failed" && effectiveDistillationFailureKind(job) !== "invalid_legacy_evidence"
    ).length;
    report.historical_failed_jobs = currentJobs.filter((job) =>
      job.status === "failed" && effectiveDistillationFailureKind(job) === "invalid_legacy_evidence"
    ).length;
  }
  if (input.enqueue && report.unresolved === 0) {
    successfulScans.set(scanKey, { watermark, config: configKey, fullAt: scanTime, nextScanAt, report: { ...report } });
  } else if (input.enqueue) successfulScans.delete(scanKey);
  return report;
}
