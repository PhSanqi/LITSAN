import type { TurnInitiator, TurnOrigin, TurnTrigger } from "../../contracts/capture.js";

export interface ClassifiedPrompt {
  origin: TurnOrigin;
  trigger: TurnTrigger;
  userText: string;
  initiator?: TurnInitiator;
}

// Keep quoted examples in the recorded text, but never interpret fenced tags.
export function outsideFences(text: string): string {
  let fence = 0;
  return text.split(/\r?\n/).map(line => {
    const match = /^\s{0,3}(`{3,})/.exec(line);
    if (match) {
      if (!fence) fence = match[1]!.length;
      else if (match[1]!.length >= fence) fence = 0;
      return "";
    }
    return fence ? "" : line;
  }).join("\n");
}

export function classify(raw: string): ClassifiedPrompt | undefined {
  const stripped = raw.replace(/<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder\s*>/gi, "").trim();
  if (!stripped) return undefined;
  const text = outsideFences(stripped).trim();
  const userText = stripped.slice(0, 20_000);
  if (text.includes("<task-notification>")) return { origin: "automation", trigger: "task_notification", userText };
  if (text.includes("<side-sessions-event>")) return { origin: "automation", trigger: "side_session_note", userText };
  if (text.includes("<ci-monitor-event>")) return { origin: "automation", trigger: "ci_event", userText };
  if (text.startsWith("<<autonomous-loop") || text.includes("<scheduled-wakeup"))
    return { origin: "automation", trigger: "scheduled_wakeup", userText };
  if (/<cross-session-message\b/.test(text)) {
    const from = /<cross-session-message\b[^>]*\bfrom=["'](local_[^"']+)["']/.exec(text);
    return { origin: "agent", trigger: "session_message", userText,
      ...(from ? { initiator: { session_id: from[1]! } } : {}) };
  }
  if (/^(?:Task|Background) \(from the session that started this one\)/.test(text))
    return { origin: "agent", trigger: "delegate", userText };
  return { origin: "user", trigger: "user_prompt", userText };
}
