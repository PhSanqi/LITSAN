import { listDistillationJobs } from "./distillation-jobs.js";
import * as core from "./core/governance/project-governance.js";
export type { ProjectGovernanceDeps } from "./core/governance/project-governance.js";

export function planProjectMutation(input: Parameters<typeof core.planProjectMutation>[0]): ReturnType<typeof core.planProjectMutation> {
  return core.planProjectMutation(input, { listDistillationJobs });
}

export function executeProjectMutation(input: Parameters<typeof core.executeProjectMutation>[0]): ReturnType<typeof core.executeProjectMutation> {
  return core.executeProjectMutation(input, { listDistillationJobs });
}

export function unfinishedDistillationJobsForProject(
  stateRoot: string,
  runtime: Parameters<typeof core.unfinishedDistillationJobsForProject>[1],
  projectId: string
): ReturnType<typeof core.unfinishedDistillationJobsForProject> {
  return core.unfinishedDistillationJobsForProject(stateRoot, runtime, projectId, { listDistillationJobs });
}
