import type { ProjectDescriptor, ProjectSuggestion, ProjectTodoStatus } from "../../contracts/projects.js";

export interface ProjectReader {
  resolve(accountId: string, reference: string, options?: { includeArchived?: boolean }): Promise<string | null>;
  list(accountId: string, options?: { includeInactive?: boolean; includeArchived?: boolean }): Promise<ProjectDescriptor[]>;
  suggest(accountId: string, query: string, limit?: number, options?: { includeArchived?: boolean }): Promise<ProjectSuggestion[]>;
  storageIds(accountId: string, canonicalProjectId: string): Promise<string[]>;
}

export interface ProjectWriter {
  create(accountId: string, input: {
    projectId: string;
    name?: string;
    description: string;
    aliases?: string[];
  }): Promise<ProjectDescriptor>;
  update(accountId: string, projectRef: string, patch: {
    name?: string;
    description?: string;
    aliases?: string[];
  }): Promise<ProjectDescriptor>;
  delete(accountId: string, projectRef: string): Promise<ProjectDescriptor>;
  merge(accountId: string, sourceRef: string, targetRef: string): Promise<{
    source: ProjectDescriptor;
    target: ProjectDescriptor;
  }>;
  archive(accountId: string, projectRef: string): Promise<ProjectDescriptor>;
  unarchive(accountId: string, projectRef: string): Promise<ProjectDescriptor>;
  addTodo(accountId: string, projectRef: string, textRaw: string, todoId?: string): Promise<ProjectDescriptor>;
  setTodoStatus(accountId: string, projectRef: string, todoIdRaw: string, status: ProjectTodoStatus): Promise<ProjectDescriptor>;
  updateDistilledDescription(accountId: string, projectRef: string, descriptionRaw: string, evidenceRefs?: readonly string[]): Promise<ProjectDescriptor>;
}
