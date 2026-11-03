import { brand } from "../../brand.mjs";
import { initiatorFromEnv } from "./config.js";
import { Recorder } from "./state.js";
import { classify } from "./classify.js";
import { inlineCardContext } from "./inline-card.js";
import { randomUUID } from "node:crypto";

export async function codexNotify(payload: Record<string, unknown>, recorder: Recorder): Promise<void> {
  if (payload.type !== "agent-turn-complete") return;
  if (typeof payload["thread-id"] !== "string" || typeof payload["turn-id"] !== "string" ||
      !Array.isArray(payload["input-messages"]) || payload["input-messages"].some(message => typeof message !== "string") ||
      typeof payload["last-assistant-message"] !== "string") throw new Error("Invalid Codex notify payload");
  const base = await recorder.base(typeof payload.cwd === "string" ? payload.cwd : process.cwd());
  if (!base) return;
  const initiator = initiatorFromEnv();
  await recorder.call({ ...base, action: "record", inline_maintenance: false, user_text: payload["input-messages"].join("\n"),
    assistant_text: payload["last-assistant-message"], turn_id: `codex:${payload["turn-id"]}`,
    conversation_id: `codex:${payload["thread-id"]}`, origin: initiator ? "agent" : "user",
    trigger: initiator ? "delegate" : "user_prompt", ...(initiator ? { initiator } : {}) });
}

export async function codexInlineHook(event: string, payload: Record<string, unknown>, recorder: Recorder): Promise<void> {
  if (!["UserPromptSubmit", "Stop"].includes(event)) throw new Error("Unknown Codex inline hook");
  const session = payload.session_id, turn = payload.turn_id;
  if (typeof session !== "string" || !session || typeof turn !== "string" || !turn) throw new Error("Codex hook requires session_id and turn_id");
  if (event === "Stop" && payload.stop_hook_active === true) return;
  const key = `codex-inline:${session}`, turnId = `codex:${turn}`;
  await recorder.locked(key, async () => {
    const state = await recorder.load(key);
    if (event === "UserPromptSubmit") {
      if (typeof payload.prompt !== "string" || initiatorFromEnv()) return;
      const prompt = classify(payload.prompt), base = await recorder.base(typeof payload.cwd === "string" ? payload.cwd : process.cwd());
      if (!prompt || prompt.origin !== "user" || !base) return;
      if (state.turn && state.turn.args.turn_id !== turnId) {
        const previous = state.turn;
        await recorder.call({ ...previous.args, ...(previous.event_id ? { event_id: previous.event_id } : {}),
          action: "failed", tool_summary: "Superseded by a new user turn", inline_maintenance: false });
      }
      const args = { ...base, user_text: prompt.userText, conversation_id: `codex:${session}`, turn_id: turnId,
        origin: "user", trigger: "user_prompt", inline_maintenance: false };
      const allocated = `l1_${randomUUID().replaceAll("-", "")}`;
      state.sequence++; state.turn = { prompt, args, event_id: allocated }; await recorder.save(key, state);
      const opened = await recorder.call({ ...args, action: "open", event_id: allocated });
      const data = opened && typeof opened === "object" ? opened as Record<string, unknown> : {};
      const eventId = typeof data.event_id === "string" ? data.event_id : allocated;
      if (eventId) { state.turn.event_id = eventId; await recorder.save(key, state); }
      const context = `${brand.displayName} recorder active: the hook records this turn; do not call litsan_turn open or commit yourself.` + inlineCardContext(eventId);
      recorder.io.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context } }) + "\n");
      return;
    }
    if (!state.turn || state.turn.args.turn_id !== turnId) return;
    const saved = state.turn, answer = payload.last_assistant_message;
    const base = { ...saved.args, ...(saved.event_id ? { event_id: saved.event_id } : {}), inline_maintenance: false };
    if (typeof answer === "string" && answer.trim()) await recorder.call({ ...base, action: "commit", assistant_text: answer });
    else await recorder.call({ ...base, action: "failed", tool_summary: "Codex turn ended without a final answer" });
    delete state.turn; await recorder.save(key, state);
    recorder.io.stdout.write("{}\n");
  });
}
