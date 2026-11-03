import type { ProjectModel, ProjectModelTodo, NodeFlagsArtifact } from "../../contracts/project-model.js";
import type { ProjectReader } from "../../core/ports/projects.js";
import type { ArchitectureReader } from "../../core/ports/architecture.js";
import { listCaptureIndexEntries } from "../../capture.js";
import { readMaintenanceStore } from "../../maintenance-store.js";
import { architectureDocRefs } from "../../archify/map-bootstrap.js";
import type { ProjectArchitectureSource } from "../../architecture-source.js";
import { listDistillationJobs } from "../../distillation-jobs.js";

export interface ProjectModelBuilderDeps {
  accountId: string;
  projects: Pick<ProjectReader, "storageIds">;
  architecture: Pick<ArchitectureReader, "inspectProjectCognitiveMap"> & Partial<Pick<ProjectArchitectureSource, "listProjectArchitectureMarkdown">>;
}

export async function buildProjectModel(deps: ProjectModelBuilderDeps, input: {
  as_of?: string;
  /** Load current architecture doc refs for doc-drift; callers on hot paths leave this off. */
  includeArchitectureDocs?: boolean;
  stateRoot: string;
  projectId: string;
  l2: Record<string, unknown>[];
  todos: ProjectModelTodo[];
}): Promise<ProjectModel> {
  const [allJobs, storageIdsList] = await Promise.all([
    listDistillationJobs(input.stateRoot, deps.accountId),
    deps.projects.storageIds(deps.accountId, input.projectId)
  ]);
  const cognitive = await deps.architecture.inspectProjectCognitiveMap({
    accountId: deps.accountId,
    projectId: input.projectId
  });
  const storageIds = new Set(storageIdsList);
  const revisions = allJobs
    .filter((job) =>
      job.status === "completed" &&
      job.target === "l2" &&
      job.result_kind === "l2" &&
      Boolean(job.result_id) &&
      Boolean(job.result_content?.trim()) &&
      Boolean(job.project_id && storageIds.has(job.project_id))
    )
    .map((job) => ({
      ref: `l2:${job.result_id}:${job.job_id}`,
      layer: "L2" as const,
      memory_id: job.result_id!,
      project_id: job.project_id,
      committed_at: job.result_committed_at ?? job.completed_at ?? job.updated_at,
      content: job.result_content!.trim(),
      evidence_refs: job.evidence_refs.slice()
    }));
  const pending = allJobs.filter(job => job.target === "l2" && (job.status === "pending" || job.status === "leased") && job.project_id && storageIds.has(job.project_id));
  const [latestEntries, docs, store] = await Promise.all([
    Promise.all([...storageIds].map(projectId => listCaptureIndexEntries(input.stateRoot, deps.accountId, { projectId, completeOnly: true, limit: 1 }))),
    input.includeArchitectureDocs ? deps.architecture.listProjectArchitectureMarkdown?.({ accountId: deps.accountId, projectId: input.projectId }) : undefined,
    readMaintenanceStore(input.stateRoot, deps.accountId)
  ]);
  const latest_l1_at = latestEntries.flat().map(entry => entry.timestamp).sort().at(-1) ?? null;
  return {
    as_of: input.as_of ?? new Date().toISOString(),
    activity: { latest_l1_at, pending_l2_jobs: pending.length,
      pending_l2_turns: new Set(pending.flatMap(job => job.evidence.filter(item => item.kind === "turn").map(item => item.ref))).size,
      oldest_pending_at: pending.map(job => job.created_at).sort().at(0) ?? null },
    ...(docs ? { architecture_docs: architectureDocRefs(input.projectId, docs).sources.map(({ ref, path }) => ({ ref, path })) } : {}),
    node_flags: (store.artifacts?.[JSON.stringify([input.projectId, "node_flags"])] as NodeFlagsArtifact | undefined) ?? null,
    projectId: input.projectId,
    l2: input.l2,
    revisions,
    architecture: { map: cognitive.map, fingerprint: cognitive.fingerprint },
    todos: input.todos
  };
}
