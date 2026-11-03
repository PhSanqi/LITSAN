export type QualityComponentId = "evidence_coverage" | "timeline_coverage" | "freshness" | "structure" | "confidence";
export type GapKind = "unmapped_change" | "stale_map" | "node_without_evidence" | "low_confidence_node" | "empty_branch" | "dangling_relation" | "open_todo" | "l2_backlog" | "doc_drift" | "user_flag" | "flat_confidence";

export interface ProjectMapQuality {
  version: 1;
  info: { pending_todos: number };
  activity: "active" | "dormant";
  score: number;
  grade: "good" | "fair" | "weak" | "unavailable";
  computed_at_basis: {
    map_generated_at: string | null;
    latest_l2_revision_at: string | null;
    map_fingerprint: string | null;
  };
  components: Array<{
    id: QualityComponentId;
    label_en: string;
    label_zh: string;
    score: number;
    weight: number;
    value: number;
    detail: string;
  }>;
  gaps: Array<{
    id: string;
    kind: GapKind;
    severity: "high" | "medium" | "low";
    ref: string;
    label: string;
    reason_en: string;
    reason_zh: string;
    event_date?: string;
  }>;
  /** Number omitted by per-kind limits and/or the total 100-gap limit. */
  truncated?: number;
}
