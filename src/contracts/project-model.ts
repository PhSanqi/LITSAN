export type ArchitectureNodeKind = "project" | "domain" | "capability" | "process" | "method" | "mechanism";

export type ArchitectureRelationType = "contains" | "flows_to" | "depends_on" | "uses" | "constrained_by";

export type ArchitectureChangeKind = "add" | "refine" | "replace" | "remove" | "reroute";

export interface ArchitectureNodeFact {
  key: string;
  value: string | number;
  unit?: string;
  evidence_refs: string[];
  confidence: number;
}

export interface ArchitectureCognitiveNode {
  facts?: ArchitectureNodeFact[];
  facets?: { layer?: string; layer_evidence_refs?: string[] };
  id: string;
  kind: ArchitectureNodeKind;
  label: string;
  summary: string;
  parent_id: string | null;
  order: number;
  evidence_refs: string[];
  confidence: number;
}

export interface ArchitectureCognitiveEdge {
  from: string;
  to: string;
  type: ArchitectureRelationType;
  evidence_refs: string[];
  confidence: number;
}

export interface ArchitectureTimelineLink {
  event_date: string;
  event_title: string;
  architecture_refs: string[];
  architecture_level: ArchitectureNodeKind;
  change_kind: ArchitectureChangeKind;
  evidence_refs: string[];
  confidence: number;
}

export interface ArchitectureCognitiveMapCandidate {
  facet_vocab?: { layer?: string[] };
  summary?: string;
  nodes: ArchitectureCognitiveNode[];
  edges: ArchitectureCognitiveEdge[];
  timeline_links: ArchitectureTimelineLink[];
}

export interface ArchitectureCognitiveMap extends ArchitectureCognitiveMapCandidate {
  schema_version: 1;
  contract: "memhub-architecture-cognitive-map-v1";
  project_id: string;
  authority: "derived";
  abstraction_cutoff: "method" | "mechanism";
  generated_at: string;
  source_evidence_refs: string[];
}

export interface ArchitectureCognitiveMapDocument {
  projectId: string;
  path: string;
  exists: boolean;
  map: ArchitectureCognitiveMap | null;
  fingerprint: string;
}

export interface ProjectModelL2Revision {
  ref: string;
  layer: "L2";
  memory_id: string;
  project_id: string | null;
  committed_at: string;
  content: string;
  evidence_refs: string[];
}

export interface ProjectModelTodo {
  id: string;
  text: string;
  status: string;
  createdAt?: string;
  updatedAt?: string;
  completedAt?: string;
}

export interface NodeFlagsArtifact {
  version: 1;
  flags: Record<string, Array<{
    id: string;
    reason: "wrong" | "unclear" | "outdated" | "missing_part";
    note: string;
    created_at: string;
    by: string;
    cleared_at?: string;
  }>>;
}

/** canonical read model handed to Archify projectors; built by the shell */
export interface ProjectModel {
  readonly as_of?: string;
  readonly activity?: { latest_l1_at: string | null; pending_l2_jobs: number; pending_l2_turns: number; oldest_pending_at: string | null };
  readonly architecture_docs?: { ref: string; path: string }[];
  readonly node_flags?: NodeFlagsArtifact | null;
  readonly projectId: string | null;
  readonly l2: Record<string, unknown>[];
  readonly revisions: ProjectModelL2Revision[];
  readonly architecture: { readonly map: ArchitectureCognitiveMap | null; readonly fingerprint: string | null };
  readonly todos: ProjectModelTodo[];
}
