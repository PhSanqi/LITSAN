export type ProjectBranchStatus = "active" | "closed" | "closing" | "merged" | "expired";

export interface ProjectBranch {
  accountId: string;
  projectId: string;
  branchId: string;
  name: string;
  goal: string;
  status: ProjectBranchStatus;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
  origin?: "manual" | "auto";
  workstream_key?: string;
  last_activity_at?: string;
  base_map_fingerprint?: string;
  base_l2_revision?: string | null;
  closed_reason?: "user" | "cap" | "manual_close" | "idle";
  merged_at?: string;
  merge_job_id?: string;
  expired_at?: string;
  closing_since?: string;
}

export interface WorkstreamHint {
  git_branch?: string;
  git_default_branch?: string;
  worktree?: string;
  continuity_id?: string;
  label?: string;
}

export type BindingReason = "explicit_branch" | "git_branch" | "worktree" | "continuity" |
  "continuity_first_turn" | "no_hint" | "default_git_branch" | "flag_off" | "unknown_key_no_create";

export interface BranchBinding {
  branch_id: string | "main";
  source: "explicit" | "workstream" | "main";
  reason: BindingReason;
  workstream_key?: string;
  created?: boolean;
  pending_key?: string;
}

export interface InFlightEntry {
  branch_id: string;
  name: string;
  goal: string;
  last_activity_at: string;
  likely_nodes: string[];
  base_stale: boolean;
}

export interface InFlightBlock {
  branches: InFlightEntry[];
  omitted: number;
}
