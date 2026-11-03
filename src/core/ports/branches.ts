import type { ProjectBranch } from "../../contracts/branches.js";

export interface BranchReader {
  list(accountId: string, projectId: string, options?: { includeClosed?: boolean }): Promise<ProjectBranch[]>;
}

export interface BranchWriter {
  create(accountId: string, projectId: string, input: { name: string; goal: string }): Promise<ProjectBranch>;
  close(accountId: string, projectId: string, reference: string): Promise<ProjectBranch>;
  reopen(accountId: string, projectId: string, reference: string): Promise<ProjectBranch>;
}
