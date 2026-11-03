import type { RecordingDecision, RecordingInput } from "../../contracts/capture.js";
export type { TurnOrigin, RecordingInput, RecordingDecision } from "../../contracts/capture.js";

export const SKIP_ASSISTANT_CHARS = 400;

export function recordingDecision(i: RecordingInput): RecordingDecision {
  if (i.origin === "user") return { action: "record" };
  if (i.relatesToRecorded) return { action: "link" };
  if (i.sideEffects || i.asksUser) return { action: "record" };
  if (i.origin === "automation" && i.assistantChars < SKIP_ASSISTANT_CHARS) {
    return { action: "skip", reason: "status_relay" };
  }
  return { action: "record" };
}
