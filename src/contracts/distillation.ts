import type { CaptureSectionSourceKinds, TurnOrigin, TurnTrigger } from "./capture.js";

export type DistillationTarget = "l2" | "l3" | "l4" | "global_state" | "skill";
export type DistillationFailureKind =
  | "core_error"
  | "ambiguous_core_commit"
  | "invalid_legacy_evidence";

export interface DistilledCanonicalTime {
  raw: string;
  precision: "date" | "month" | "year" | "range" | "unknown";
  start?: string;
  end?: string;
  original_expression?: string;
}

export interface DistilledFactMetadata {
  fact_id: string;
  ordinal: number;
  text: string;
  parent_id: string;
  parent_heading?: string;
  canonical_time?: DistilledCanonicalTime;
  supersedes?: {
    text: string;
    fact_id?: string;
  };
  evidence_refs: string[];
}

export interface DistilledFactParent {
  parent_id: string;
  heading?: string;
  canonical_time?: DistilledCanonicalTime;
  evidence_refs: string[];
  fact_ids: string[];
}

export interface DistilledFactMetadataSet {
  version: "memhub-fact-metadata-v1";
  layer: "L2" | "L3";
  facts: DistilledFactMetadata[];
  parents: DistilledFactParent[];
}

export interface DistillationEvidenceItem {
  ref: string;
  kind: "turn" | "memory" | "artifact";
  timestamp: string;
  project_id?: string;
  conversation_id?: string;
  layer?: "L1" | "L2" | "L3" | "L4" | "GlobalState" | "Skill";
  title?: string;
  content?: string;
  user_text?: string;
  assistant_text?: string;
  reasoning_summary?: string;
  tool_summary?: string;
  source_kinds?: CaptureSectionSourceKinds;
  origin?: TurnOrigin;
  trigger?: TurnTrigger;
}

export interface DistillationJob {
  job_id: string;
  account_id: string;
  target: DistillationTarget;
  scope: "account" | "project";
  project_id: string | null;
  conversation_id?: string;
  status: "pending" | "leased" | "completed" | "failed";
  reason: "manual" | "turn_threshold" | "idle" | "upstream" | "migration";
  created_at: string;
  updated_at: string;
  leased_until?: string;
  leased_by?: string;
  lease_token?: string;
  completed_at?: string;
  failure?: string;
  failure_kind?: DistillationFailureKind;
  failed_at?: string;
  attempts?: number;
  branch_id?: string;
  split_card_set?: string;
  maintenance_split_locked?: boolean;
  maintenance_background_only?: boolean;
  maintenance_coalesced_into?: string;
  l2_restructure?: { base_ref: string; base_evidence_refs: string[] };
  l2_append?: { branch_id: string; base_ref: string | null };
  maintenance_merge_content?: string;
  maintenance_cards?: { card_id: string; evidence_refs: string[] }[];
  result_kind?: DistillationTarget | "noop" | "branch_draft";
  result_id?: string;
  result_retirement?: "pending" | "archived" | "deleted";
  result_retirement_generation?: string;
  result_retirement_operation?: "archived" | "deleted";
  result_content?: string;
  result_fact_metadata?: DistilledFactMetadataSet;
  result_committed_at?: string;
  result_operation_id?: string;
  result_core_content_hash?: string;
  evidence_refs: string[];
  evidence_hash: string;
  evidence: DistillationEvidenceItem[];
}
