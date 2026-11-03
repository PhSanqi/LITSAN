import type { NodeFlagsArtifact } from "./project-model.js";
import type { ArchitectureChangeKind, ArchitectureCognitiveMap, ArchitectureNodeKind, ArchitectureRelationType } from "./project-model.js";
import type { ProjectMapQuality } from "./project-map-quality.js";

export interface ArchitectureGraphNode {
  facts?: ArchitectureCognitiveMap["nodes"][number]["facts"];
  facets?: { layer?: string };
  id: string;
  kind: ArchitectureNodeKind;
  level: number;
  parent_id: string | null;
  depth: number;
  x: number;
  y: number;
  label: string;
  summary: string;
  confidence: number;
  change_count: number;
  latest_change_kind: ArchitectureChangeKind | null;
  event_ids: string[];
}

export interface ArchitectureGraphRelation {
  from: string;
  to: string;
  type: Exclude<ArchitectureRelationType, "contains">;
  confidence: number;
  from_label: string;
  to_label: string;
  strong_coupling?: boolean;
}

export interface ArchitectureGraph {
  levels: ArchitectureNodeKind[];
  width: number;
  height: number;
  nodes: ArchitectureGraphNode[];
  relations: ArchitectureGraphRelation[];
}

export type ProjectStateStage = "active" | "completed" | "pending" | "blocked" | "rollback" | "superseded";

export interface ProjectStateEvent {
  id: string;
  memory_id: string;
  date: string;
  date_label: string;
  title: string;
  summary: string;
  detail?: string;
  order: number;
  workstream_id: string;
  workstream_label: string;
  workstream_basis: "explicit" | "inferred" | "main";
  stage: ProjectStateStage;
  version: string | null;
  current_head: boolean;
  workstream_head: boolean;
  revision_count: number;
  first_revision_ref: string | null;
  latest_revision_ref: string | null;
  first_seen_at: string;
  last_seen_at: string;
  architecture_refs: string[];
  architecture_level: ArchitectureNodeKind | null;
  architecture_change_kind: ArchitectureChangeKind | null;
  architecture_confidence: number | null;
}

export interface ProjectStateWorkstream {
  id: string;
  label: string;
  basis: "explicit" | "inferred" | "main";
  event_count: number;
  current_event_id: string | null;
  versions: string[];
}

export interface ProjectTimelineBranch {
  id: string;
  name: string;
  goal: string;
  status: string;
  created_at: string;
  base_l2_revision: string | null;
  merged_at: string | null;
  merge_revision_ref: string | null;
  events: Array<{ date: string; title: string; summary: string; evidence_refs: string[]; appended_at: string; merged: boolean }>;
}

export interface TimelineMilestone {
  kind: "main" | "topic";
  title_en: string; title_zh: string; summary_en: string; summary_zh: string;
  topic_en?: string; topic_zh?: string; source_ids: string[];
}

export interface ProjectStateRevision {
  ref: string;
  memory_id: string;
  committed_at: string;
  current: boolean;
  event_ids: string[];
  evidence_refs: string[];
}

export interface ProjectStateTodo {
  id: string;
  text: string;
  status: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface MemoryVisualizationPayload {
  schema_version: 3;
  visualization_contract: "memhub-project-map-ir-v1";
  source_of_truth: "canonical-l2";
  revision_source: "exact-l2-revision-ledger";
  projection_only: true;
  project_id: string | null;
  requires_project: boolean;
  maintenance_status?: {
    pending: number;
    leased: number;
    requested: number;
    by_kind: Record<string, number>;
    oldest_pending_at: string | null;
    last_accepted_at: string | null;
  };
  state: {
    current_head_event_id: string | null;
    latest_l2_revision_at: string | null;
    current_l2_memory_ids: string[];
    workstreams: ProjectStateWorkstream[];
    events: ProjectStateEvent[];
    branches?: ProjectTimelineBranch[];
    timeline_digest?: { milestones: TimelineMilestone[]; processed_ids: string[]; processed: number; total: number };
  };
  architecture: {
    node_flags?: NodeFlagsArtifact | null;
    graph: ArchitectureGraph | null;
    available: boolean;
    contract: string | null;
    authority: "derived" | null;
    abstraction_cutoff: "method" | "mechanism" | null;
    facet_vocab?: ArchitectureCognitiveMap["facet_vocab"];
    generated_at: string | null;
    fingerprint: string | null;
    nodes: Array<ArchitectureCognitiveMap["nodes"][number] & { event_ids: string[] }>;
    edges: ArchitectureCognitiveMap["edges"];
    timeline_links: ArchitectureCognitiveMap["timeline_links"];
  };
  drilldown: {
    revisions: ProjectStateRevision[];
    todos: ProjectStateTodo[];
  };
  stats: {
    events: number;
    workstreams: number;
    l2_revisions: number;
    versions: number;
    pending_todos: number;
    architecture_nodes: number;
    architecture_links: number;
  };
  archify: {
    role: "optional_export_and_design_reference";
    exportable: boolean;
    compatible_diagram_types: ["lifecycle", "architecture"];
    invariant: string;
    lifecycle_ir: {
      schema_version: 2;
      diagram_type: "lifecycle";
      meta: { title: string; subtitle: string; output: string };
      lanes: Array<{ id: string; label: string }>;
      states: Array<{ id: string; type: "active" | "success" | "waiting" | "failure" | "neutral"; label: string; sublabel: string; lane: string; col: number; width: number }>;
      transitions: Array<{ from: string; to: string }>;
      cards: [];
    };
    architecture_ir: {
      schema_version: 1;
      diagram_type: "architecture";
      meta: { title: string; subtitle: string; output: string };
      nodes: Array<{ id: string; kind: ArchitectureNodeKind; label: string; parent_id: string | null; order: number; confidence: number }>;
      edges: Array<{ from: string; to: string; type: string; confidence: number }>;
    };
  };
  quality: ProjectMapQuality;
}
