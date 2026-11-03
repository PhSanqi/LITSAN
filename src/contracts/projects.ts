export type ProjectState = "active" | "archived" | "merged" | "deleted";

export type ProjectTodoStatus = "pending" | "done";

export interface ProjectTodo {
  id: string;
  text: string;
  status: ProjectTodoStatus;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface ProjectDescriptor {
  projectId: string;
  name: string;
  description: string;
  manualDescription?: string;
  distilledDescription?: string;
  descriptionSource?: "manual" | "distilled" | "legacy" | "empty";
  descriptionEvidenceRefs?: string[];
  descriptionUpdatedAt?: string;
  todos?: ProjectTodo[];
  aliases: string[];
  state: ProjectState;
  mergedInto?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectSuggestion extends ProjectDescriptor {
  similarity: number;
  matchedBy: string;
}
