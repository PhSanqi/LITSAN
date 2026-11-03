export type CaptureSourceKind = "user_said" | "agent_inferred" | "tool_output" | "imported";

export type TurnOrigin = "user" | "agent" | "automation";
export type TurnTrigger = "user_prompt" | "hook" | "task_notification" | "side_session_note" |
  "session_message" | "scheduled_wakeup" | "ci_event" | "delegate" | "cli_run" | "other";
export interface TurnInitiator {
  harness?: string;
  session_id?: string;
  event_id?: string;
}
export interface TurnRelation {
  event_id: string;
  relation: "relays" | "duplicate_of" | "continues";
}
export interface TurnProvenance {
  origin?: TurnOrigin;
  trigger?: TurnTrigger;
  initiator?: TurnInitiator;
  relates_to?: TurnRelation;
}
export interface RecordingInput {
  origin: TurnOrigin;
  trigger?: string;
  assistantChars: number;
  sideEffects: boolean;
  asksUser?: boolean;
  relatesToRecorded?: boolean;
}
export type RecordingDecision = { action: "record" } | { action: "link" } | { action: "skip"; reason: string };

export interface CaptureSectionSourceKinds {
  user_text?: CaptureSourceKind;
  assistant_text?: CaptureSourceKind;
  reasoning_summary?: CaptureSourceKind;
  tool_summary?: CaptureSourceKind;
  content?: CaptureSourceKind;
}

/** Capture fields used to validate project-scoped L1 evidence. */
export interface CaptureEvidence {
  event_id: string;
  ingested: boolean;
  capture_status: "partial" | "truncated" | "complete" | "open" | "failed";
  user_text?: string;
  assistant_text?: string;
  reasoning_summary?: string;
  project_hint?: string;
  timestamp: string;
  conversation_id?: string;
}
