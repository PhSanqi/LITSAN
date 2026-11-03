export type ProjectResolutionSource =
  | "deterministic_binding"
  | "exact_alias"
  | "semantic"
  | "none"
  | "ambiguous";

export type ProjectRecallScope = "global_only" | "global_and_project";

export interface ProjectScopeInput {
  /** Project scope already enforced by authentication / namespace. */
  namespaceProjectId?: string;
  /** Project derived from a concrete repository/workspace identity. */
  workspaceProjectId?: string;
  /** Exact registry/name aliases extracted from the request. */
  exactAliasProjectIds?: readonly string[];
  /** Semantic classifier output. More than one unique candidate is ambiguous. */
  semanticProjectIds?: readonly string[];
}

export interface ProjectScopeResolution {
  projectId: string | null;
  source: ProjectResolutionSource;
  recallScope: ProjectRecallScope;
  candidates: string[];
  evidence: string[];
}

export interface RetrievalScopeEnvelope {
  version: "retrieval-scope-envelope-v1";
  accountId: string;
  primaryProject: string | null;
  workspaceProject: string | null;
  branch: string | null;
  globalAllowed: true;
  crossProjectSkillAllowed: boolean;
  projectResolutionSource: ProjectResolutionSource;
  projectResolutionConfidence: "deterministic" | "exact" | "semantic" | "none" | "ambiguous";
  ambiguity: string[];
  projectStorageIds: string[];
  reusableSkillProjectIds: string[];
}

export function buildRetrievalScopeEnvelope(input: {
  accountId: string;
  resolution: ProjectScopeResolution;
  workspaceProjectId?: string;
  branchId?: string;
  projectStorageIds?: readonly string[];
  reusableSkillProjectIds?: readonly string[];
  crossProjectSkillAllowed: boolean;
}): RetrievalScopeEnvelope {
  const accountId = requireNonEmpty(input.accountId, "accountId");
  const workspaceProject = normalizeProjectId(input.workspaceProjectId) ?? null;
  const branch = normalizeProjectId(input.branchId) ?? null;
  const primaryProject = input.resolution.projectId;
  if (branch && !primaryProject) throw new Error("retrieval branch requires one resolved primary project");
  const projectStorageIds = primaryProject
    ? uniqueProjectIds(input.projectStorageIds?.length ? input.projectStorageIds : [primaryProject])
    : [];
  const reusableSkillProjectIds = input.crossProjectSkillAllowed
    ? uniqueProjectIds(input.reusableSkillProjectIds ?? [])
    : [];
  return {
    version: "retrieval-scope-envelope-v1",
    accountId,
    primaryProject,
    workspaceProject,
    branch,
    globalAllowed: true,
    crossProjectSkillAllowed: input.crossProjectSkillAllowed,
    projectResolutionSource: input.resolution.source,
    projectResolutionConfidence: resolutionConfidence(input.resolution.source),
    ambiguity: input.resolution.source === "ambiguous" ? [...input.resolution.candidates] : [],
    projectStorageIds,
    reusableSkillProjectIds
  };
}

/**
 * Resolve one project without ever broadening an ambiguous request into
 * cross-project recall. Models may produce candidates; this router owns the
 * filtering decision.
 */
export function resolveProjectScope(input: ProjectScopeInput): ProjectScopeResolution {
  const deterministic = uniqueProjectIds([
    input.namespaceProjectId,
    input.workspaceProjectId
  ]);
  if (deterministic.length > 1) {
    return ambiguous(deterministic, [
      "conflicting deterministic project bindings"
    ]);
  }
  if (deterministic.length === 1) {
    const projectId = deterministic[0]!;
    return resolved(projectId, "deterministic_binding", deterministicEvidence(input, projectId));
  }

  const aliases = uniqueProjectIds(input.exactAliasProjectIds ?? []);
  if (aliases.length > 1) {
    return ambiguous(aliases, ["multiple exact project aliases"]);
  }
  if (aliases.length === 1) {
    return resolved(aliases[0]!, "exact_alias", ["exact project registry alias"]);
  }

  const semantic = uniqueProjectIds(input.semanticProjectIds ?? []);
  if (semantic.length > 1) {
    return ambiguous(semantic, ["semantic project classification is not unique"]);
  }
  if (semantic.length === 1) {
    return resolved(semantic[0]!, "semantic", ["single semantic project candidate"]);
  }

  return {
    projectId: null,
    source: "none",
    recallScope: "global_only",
    candidates: [],
    evidence: ["no project resolved"]
  };
}

function resolved(
  projectId: string,
  source: Exclude<ProjectResolutionSource, "none" | "ambiguous">,
  evidence: string[]
): ProjectScopeResolution {
  return {
    projectId,
    source,
    recallScope: "global_and_project",
    candidates: [projectId],
    evidence
  };
}

function ambiguous(candidates: string[], evidence: string[]): ProjectScopeResolution {
  return {
    projectId: null,
    source: "ambiguous",
    recallScope: "global_only",
    candidates,
    evidence
  };
}

function deterministicEvidence(input: ProjectScopeInput, projectId: string): string[] {
  const evidence: string[] = [];
  if (normalizeProjectId(input.namespaceProjectId) === projectId) evidence.push("authenticated namespace project");
  if (normalizeProjectId(input.workspaceProjectId) === projectId) evidence.push("workspace project identity");
  return evidence;
}

function uniqueProjectIds(values: readonly (string | undefined)[]): string[] {
  return [...new Set(values
    .map(normalizeProjectId)
    .filter((value): value is string => value !== undefined))]
    .sort((left, right) => left.localeCompare(right));
}

function normalizeProjectId(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function resolutionConfidence(source: ProjectResolutionSource): RetrievalScopeEnvelope["projectResolutionConfidence"] {
  if (source === "deterministic_binding") return "deterministic";
  if (source === "exact_alias") return "exact";
  if (source === "semantic") return "semantic";
  return source;
}

function requireNonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${field} must be non-empty`);
  return normalized;
}
