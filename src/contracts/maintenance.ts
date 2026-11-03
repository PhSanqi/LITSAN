import type { DistillationJob, DistillationEvidenceItem } from "./distillation.js";
import type { ArchitectureNodeKind, ArchitectureChangeKind, ArchitectureCognitiveMap, ArchitectureCognitiveMapDocument, ProjectModel } from "./project-model.js";
import type { ProjectMapQuality } from "./project-map-quality.js";

export type MaintenanceCardKind = "l2_chunk" | "arch_link" | "gap_check" | "arch_review" | "timeline_digest";
export type MaintenanceCardStatus = "pending" | "leased" | "accepted" | "rejected" | "superseded";
export type ClientExecution = "inline" | "delegate" | "background";
export interface ClientProfile { execution: ClientExecution; max_card_tokens?: number; cards_per_turn?: number; model?: string }
export interface L2ChunkEvent { date: string; title_en: string; title_zh: string; body_en: string; body_zh: string; evidence_refs: string[]; continues?: string }
export interface L2ChunkInput { items: DistillationEvidenceItem[]; prior_events?: { key: string; date: string; title_en: string }[]; base_recent?: { date: string; title: string }[] }
export interface L2ChunkAnswer { events: L2ChunkEvent[]; skip_reason?: string }
export interface ArchLink { architecture_refs: string[]; architecture_level: ArchitectureNodeKind; change_kind: ArchitectureChangeKind; confidence: number }
export type ArchLinkAnswer = { links: ArchLink[] } | { no_fit: true; reason: string };
export interface GapCheckAnswer { verdict: "supported" | "still_gap" | "possibly_obsolete"; evidence_refs: string[]; confidence: number; note: string }
export type ExtensionCardInput = { readonly [key: string]: unknown };
export type ExtensionAnswer = { readonly [key: string]: unknown };
export type MaintenanceAnswer = L2ChunkAnswer | ArchLinkAnswer | GapCheckAnswer | ExtensionAnswer;
export interface MaintenanceCandidate { id: string; kind: ArchitectureNodeKind; label: string; summary: string }
export interface GapCheckInput {
  gap: Pick<ProjectMapQuality["gaps"][number], "id" | "kind" | "reason_en">;
  node: { id: string; kind: ArchitectureNodeKind; label: string; summary: string; confidence: number;
    evidence_refs: string[]; parent_label: string | null; child_labels: string[] };
  events: { id: string; date: string; title: string; summary: string; ref: string | null }[];
}
export interface ArchLinkInput { event: { id: string; date: string; title: string; summary: string }; candidates: MaintenanceCandidate[] }
export interface MaintenanceActor { harness: string; model?: string; profile: ClientExecution }
export interface MaintenanceCard {
  card_id: string; key: string; kind: MaintenanceCardKind; account_id: string; project_id: string;
  branch_id?: string;
  parent_job_id?: string; chunk?: { index: number; of: number }; est_tokens: number; fingerprint: string;
  instructions: string;
  input: L2ChunkInput | ArchLinkInput | GapCheckInput | ExtensionCardInput;
  allowed_refs: string[]; answer_schema: Record<string, unknown>; status: MaintenanceCardStatus;
  lease?: { token: string; owner: string; until: string; model?: string; profile?: ClientExecution; inline_token_budget?: number }; attempts: number; rejections: number;
  inline_receipt?: { event_id: string; lease_hash: string };
  inline_skips?: number; inline_retry_after?: string;
  created_at: string; updated_at: string; requested_at?: string; accepted_at?: string; result?: MaintenanceAnswer;
}
export interface MaintenanceCardSet {
  set_id: string; parent_job_id: string; parent_job_ids?: string[]; parent_fingerprints?: Record<string, string>; account_id: string; project_id: string; card_ids: string[];
  branch_id?: string;
  status: "open" | "merged" | "aborted"; created_at: string; merged_at?: string; result_job_id?: string;
}
export type MaintenanceRejectCode = "wrong_account" | "wrong_project" | "lease_expired" | "lease_token_stale" |
  "stale_fingerprint" | "schema_invalid" | "oversize" | "ref_not_allowed" | "node_not_allowed" |
  "contaminated" | "bilingual_missing" | "unsupported_kind" | "card_not_leased";
export interface MaintenanceLogEntry {
  ts: string; account: string; card_id: string; kind: MaintenanceCardKind; project: string; parent_job_id?: string;
  harness: string; model?: string; profile: ClientExecution; via: "offer" | "direct" | "worker";
  outcome: "leased" | "loaded" | "accepted" | "rejected" | "released" | "expired" | "superseded" | "merge_failed" | "offered";
  reason_code?: MaintenanceRejectCode; detail?: string; est_tokens: number; answer_chars: number;
}

export interface MaintenanceConfig {
  conversation_maintenance: "off" | "quiet" | "visible";
  offer_style?: "optional" | "delegate_request";
  daily_card_cap: number; daily_est_token_cap: number; inline_every_n_turns: number;
  delegate_min_interval_s: number; heavy_turn_chars: number; cross_project: boolean; opted_out_projects: string[];
}
export interface ContinuityOfferState { committed_turns_since_offer: number; last_offer_at: string | null }
export interface MaintenanceOfferState {
  day: string; cards_offered: number; est_tokens_offered: number;
  by_continuity: Record<string, ContinuityOfferState>;
}
export interface MaintenanceOfferTurn {
  ingested: boolean; projectId?: string | null; assistantChars: number; toolSummaryChars: number; continuityId: string;
}
export type MaintenanceOfferReason = "setting_off" | "not_ingested" | "no_project" | "opted_out" | "heavy_turn" | "background_profile" | "daily_cap" | "throttled";
export interface MaintenanceOffer {
  card_id: string; kind: MaintenanceCardKind; project: string; est_tokens: number; call: string; mode: "quiet" | "visible"; rule: string;
}
export type CardDraft = Pick<MaintenanceCard, "key" | "kind" | "account_id" | "project_id" | "fingerprint" | "input" | "allowed_refs"> &
  Partial<Pick<MaintenanceCard, "parent_job_id" | "chunk" | "branch_id">> & { requested?: boolean };
export type CardValidationResult = { ok: true; normalized: MaintenanceAnswer } | { ok: false; code: MaintenanceRejectCode; detail: string };
export type ApplyResult = { ok: true } | { ok: false; code: MaintenanceRejectCode; detail: string };
export type MaintenanceReadonly<T> = T extends object ? { readonly [K in keyof T]: MaintenanceReadonly<T[K]> } : T;
export interface MaintenanceGeneratorContext {
  accountId: string; projectId: string;
  l2ChunkBudget?: number;
  artifacts: { get(key: string): unknown };
  architectureSources?: readonly { ref: string; path: string; content: string }[];
  codeEvidence?: readonly { ref: string; snippet: string; path: string; kind: string; bytes?: number; language?: string }[];
  model?: MaintenanceReadonly<ProjectModel>; map: MaintenanceReadonly<ArchitectureCognitiveMap> | null;
  jobs: MaintenanceReadonly<DistillationJob[]>;
  gaps?: readonly ProjectMapQuality["gaps"][number][];
  events: readonly { id: string; date: string; date_label?: string; link_date: string; order: number; title: string; summary: string;
    architecture_refs: readonly string[]; latest_revision_ref: string | null; first_revision_ref: string | null }[];
}
/** Adapters own validation/writes and the L2 acceptance fence + subsequent merge. */
export interface MaintenanceApplyPorts {
  map: { read(): Promise<ArchitectureCognitiveMapDocument>; write(map: ArchitectureCognitiveMap, expectedFingerprint: string): Promise<void> };
  submitL2Chunk(card: MaintenanceCard, answer: L2ChunkAnswer): Promise<ApplyResult>;
  artifacts: { read(key: string): Promise<unknown>; write(key: string, value: unknown): Promise<void> };
}
export interface MaintenanceCardGenerator {
  kind: MaintenanceCardKind; needs?: readonly ("architectureSources")[]; answerSchema: Record<string, unknown>; instructions: string;
  ensure(ctx: MaintenanceGeneratorContext, now: number): CardDraft[];
  /** Current fence for an open card of this kind; defaults to the map structure fingerprint. */
  fence?(card: MaintenanceCard, map: MaintenanceReadonly<ArchitectureCognitiveMap> | null, artifacts: MaintenanceGeneratorContext["artifacts"]): string;
  validate(card: MaintenanceCard, answer: unknown): CardValidationResult;
  apply(card: MaintenanceCard, normalized: MaintenanceAnswer, ports: MaintenanceApplyPorts, actor: MaintenanceActor, now: number): Promise<ApplyResult>;
}
