import { sweepWorkstreamBranches, type WorkstreamMergeDeps } from "./workstream.js";
import type { ProjectReader } from "./core/ports/projects.js";
import type { AccountId, UserId } from "./contracts/identity.js";
import type { TurnSessionWriter } from "./core/ports/memory.js";
import { listCaptureIndexEntries } from "./capture.js";
import { reconcileFrozenCaptureIngests } from "./capture-recovery.js";
import { discoverDistillationJobs } from "./distillation-discovery.js";
import { getDistillationConfig } from "./distillation-jobs.js";

export interface DistillationSchedulingDeps {
  projects: Pick<ProjectReader, "resolve">;
  accountId: AccountId;
  userId: UserId;
  memoryClient: TurnSessionWriter;
}

/**
 * Automatic distillation scheduling: threshold-triggered discovery after a
 * captured turn, and the periodic idle/startup sweep. Kept separate from the
 * MCP boundary; callers inject the runtime lookup used for recovery.
 */
export async function maybeQueueThresholdDistillation(input: {
  stateRoot: string;
  accountId: string;
  projectId: string | null;
}): Promise<unknown | null> {
  const config = await getDistillationConfig(input.stateRoot);
  if (!config.auto_enabled || !input.projectId) return null;
  return discoverDistillationJobs({
    stateRoot: input.stateRoot,
    accountId: input.accountId,
    resolveProject: async (hint) => hint === input.projectId ? input.projectId : null,
    enqueue: true
  });
}

const captureRecoveryErrorLoggedAt = new Map<string, number>();

export async function queueIdleDistillation(
  stateRoot: string,
  runtimeForAccount: (accountId: string) => DistillationSchedulingDeps
): Promise<void> {
  const config = await getDistillationConfig(stateRoot);
  // Frozen Core intents are a capture durability concern, not a distillation
  // preference, so include complete un-ingested accounts even when automatic
  // distillation is disabled.
  const entries = await listCaptureIndexEntries(stateRoot, undefined, { completeOnly: true });
  const failures: Error[] = [];
  for (const accountId of new Set(entries.map((item) => item.account_id))) {
    try {
      const runtime = runtimeForAccount(accountId);
      const recovery = await reconcileFrozenCaptureIngests({ stateRoot, runtime });
      for (const kind of new Set(recovery.errors.map((error) => error.kind))) {
        const now = Date.now();
        if (now - (captureRecoveryErrorLoggedAt.get(kind) ?? 0) < 60 * 60 * 1000) continue;
        captureRecoveryErrorLoggedAt.set(kind, now);
        console.error("[litsan] capture ingest recovery:", JSON.stringify({
          kind,
          event_ids: recovery.errors.filter((error) => error.kind === kind).map((error) => error.event_id),
          failed: recovery.failed
        }));
      }
      if (config.auto_enabled) await discoverDistillationJobs({
        stateRoot,
        accountId,
        resolveProject: (hint) => runtime.projects.resolve(accountId, hint),
        enqueue: true,
        skipUnchanged: true
      });
      // Lightweight test runtimes need only the original capture ports. Real
      // runtimes also drain drafts after the workstream flag is disabled.
      if ("branches" in runtime && "memory" in runtime && "architecture" in runtime) {
        await sweepWorkstreamBranches({ stateRoot, runtime: runtime as unknown as WorkstreamMergeDeps["runtime"] });
      }
    } catch (error) {
      failures.push(new Error(`account ${accountId}: ${error instanceof Error ? error.message : String(error)}`));
    }
  }
  if (failures.length) throw new AggregateError(failures, "distillation discovery failed for one or more accounts");
}
