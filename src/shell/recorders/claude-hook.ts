import { brand, legacyToolGuidance } from "../../brand.mjs";
import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import { recordingDecision } from "../../core/lifecycle/recording-policy.js";
import { classify, outsideFences } from "./classify.js";
import { Recorder } from "./state.js";
import { inlineCardContext } from "./inline-card.js";

type HookPayload = { session_id?: string; cwd?: string; prompt?: string; transcript_path?: string; stop_hook_active?: boolean };

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter(block => block?.type === "text" && typeof block.text === "string").map(block => block.text).join("\n");
}

// Read complete JSONL lines backwards, stopping at the last actual user input
// (tool_result messages have role=user too). Large old transcripts stay on disk.
export async function transcriptSummary(path: string, recorder: Recorder): Promise<{
  assistant_text: string; tool_summary: string; sideEffects: boolean; asksUser: boolean;
}> {
  const file = await open(path, "r");
  let assistant: string | undefined;
  let sideEffects = false, asksUser = false, boundary = false;
  const counts = new Map<string, number>();
  const consume = (line: string) => {
    if (!line.trim()) return;
    const row = JSON.parse(line);
    const message = row.message ?? row;
    const role = message.role ?? row.type;
    const content = message.content;
    if (role === "user" && classify(textOf(content))) { boundary = true; return; }
    if (role !== "assistant") return;
    const text = textOf(content);
    if (assistant === undefined && text) assistant = text;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (block?.type !== "tool_use" || typeof block.name !== "string") continue;
      const name: string = block.name;
      counts.set(name, (counts.get(name) ?? 0) + 1);
      if (name === "AskUserQuestion") asksUser = true;
      if (["Edit", "Write", "NotebookEdit", "Bash"].includes(name) ||
          (name.startsWith("mcp__") && !/^(read|list|get|search|query|load|status)/i.test(name.split("__").at(-1)!))) sideEffects = true;
    }
  };
  try {
    let position = (await file.stat()).size;
    let tail = Buffer.alloc(0);
    while (position > 0 && !boundary) {
      if (recorder.remaining() < 150) throw new Error("Transcript exceeded recorder time budget");
      const size = Math.min(64 * 1024, position);
      position -= size;
      const chunk = Buffer.alloc(size);
      const { bytesRead } = await file.read(chunk, 0, size, position);
      const buffer = Buffer.concat([chunk.subarray(0, bytesRead), tail]);
      let end = buffer.length;
      for (let i = buffer.length - 1; i >= 0; i--) {
        if (buffer[i] !== 10) continue;
        consume(buffer.subarray(i + 1, end).toString("utf8"));
        end = i;
        if (boundary) break;
      }
      tail = buffer.subarray(0, end);
      if (position === 0 && !boundary) consume(tail.toString("utf8"));
    }
  } finally { await file.close(); }
  const assistant_text = assistant ?? "";
  return { assistant_text, tool_summary: [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([name, count]) => `${name}: ${count}`).join(", ").slice(0, 1000),
    sideEffects, asksUser: asksUser || assistant_text.trimEnd().endsWith("?") };
}

export function childEventId(prompt: string): string | undefined {
  const text = outsideFences(prompt);
  // Only explicit event-id fields link evidence; prose and session IDs do not.
  return /\b(?:child[_-])?event[_-]id["']?\s*[=:]\s*["']?(l1_[A-Za-z0-9_-]+)\b/i.exec(text)?.[1] ??
    /<event[_-]id>\s*(l1_[A-Za-z0-9_-]+)\s*<\/event[_-]id>/i.exec(text)?.[1];
}

export async function claudeHook(event: string, payload: HookPayload, recorder: Recorder): Promise<void> {
  if (!["UserPromptSubmit", "Stop", "SubagentStop"].includes(event)) throw new Error(`Unknown Claude hook: ${event}`);
  if (event === "Stop" && payload.stop_hook_active === true) return;
  if (typeof payload.session_id !== "string" || !payload.session_id) throw new Error("Claude hook requires session_id");
  const session = payload.session_id;
  const base = event === "UserPromptSubmit" ? await recorder.base(payload.cwd ?? process.cwd()) : undefined;
  if (event === "UserPromptSubmit" && !base) return;
  if (event !== "UserPromptSubmit" && !(await recorder.load(session)).turn) return;
  await recorder.locked(`claude:${session}`, async () => {
    const state = await recorder.load(session);
    if (event === "UserPromptSubmit") {
      if (typeof payload.prompt !== "string") throw new Error("Claude hook requires prompt");
      const prompt = classify(payload.prompt);
      if (!prompt) { delete state.turn; await recorder.save(session, state); return; }
      state.sequence++;
      const args: Record<string, unknown> = { ...base, origin: prompt.origin, trigger: prompt.trigger,
        ...(prompt.initiator ? { initiator: prompt.initiator } : {}), user_text: prompt.userText,
        conversation_id: `claude:${session}`, turn_id: `claude:${session}:${state.sequence}`, inline_maintenance: false };
      // Allocate the event id before sending: a lost open response must still
      // allow Stop to commit and replay the exact same event.
      const eventId = prompt.origin === "user" ? `l1_${randomUUID().replaceAll("-", "")}` : undefined;
      state.turn = { prompt, args, ...(eventId ? { event_id: eventId } : {}), transcript_path: payload.transcript_path };
      await recorder.save(session, state);
      if (eventId) {
        const result = await recorder.call({ ...args, action: "open", event_id: eventId });
        const confirmed = result && typeof result === "object" && "event_id" in result && typeof result.event_id === "string" && result.event_id
          ? result.event_id : eventId;
        if (confirmed !== eventId) { state.turn.event_id = confirmed; await recorder.save(session, state); }
        const context = `${brand.displayName} recorder active: this turn is L1 event ${confirmed}. Do not call litsan_turn open/commit/record yourself; use litsan_turn checkpoint with event_id=${confirmed} only if needed.` + inlineCardContext(confirmed);
        recorder.io.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context } }) + "\n");
      } else {
        recorder.io.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit",
          additionalContext: `${brand.displayName} recorder active: this ${prompt.origin}-started turn (${prompt.trigger}) is recorded or skipped by the hook when you stop. Do not call litsan_turn open/commit/record for it.` + legacyToolGuidance } }) + "\n");
      }
      return;
    }
    if (!state.turn) return;
    if (event === "SubagentStop") {
      const path = payload.transcript_path ?? state.turn.transcript_path;
      const chars = path ? (await transcriptSummary(path, recorder)).assistant_text.length : 0;
      state.turn.tool_summary = [state.turn.tool_summary, `subagent: ${chars} chars`].filter(Boolean).join(", ").slice(0, 1000);
      await recorder.save(session, state);
      return;
    }
    const path = payload.transcript_path ?? state.turn.transcript_path;
    const turn = state.turn;
    let summary: Awaited<ReturnType<typeof transcriptSummary>>;
    try {
      if (!path) throw new Error("Claude Stop requires transcript_path");
      summary = await transcriptSummary(path, recorder);
    } catch (error) {
      // Never leave an opened turn dangling: close it as failed and move on.
      delete state.turn;
      await recorder.save(session, state);
      if (turn.event_id) await recorder.call({ ...turn.args, action: "failed", event_id: turn.event_id,
        tool_summary: `recorder: transcript unavailable (${error instanceof Error ? error.message : String(error)})`.slice(0, 1000) });
      throw error;
    }
    const tool_summary = [summary.tool_summary, turn.tool_summary].filter(Boolean).join(", ").slice(0, 1000);
    const relates = childEventId(turn.prompt.userText);
    const decision = recordingDecision({ origin: turn.prompt.origin, trigger: turn.prompt.trigger,
      assistantChars: summary.assistant_text.length, sideEffects: summary.sideEffects, asksUser: summary.asksUser,
      relatesToRecorded: Boolean(relates) });
    if (turn.event_id) {
      await recorder.call({ ...turn.args, action: "commit", event_id: turn.event_id,
        assistant_text: summary.assistant_text, tool_summary });
    } else if (decision.action !== "skip") {
      await recorder.call({ ...turn.args, action: "record", inline_maintenance: false, assistant_text: summary.assistant_text, tool_summary,
        ...(decision.action === "link" && relates ? { relates_to: { event_id: relates, relation: "relays" } } : {}) });
    } else {
      const date = new Date().toISOString().slice(0, 10);
      state.skipped[date] = (state.skipped[date] ?? 0) + 1;
    }
    delete state.turn;
    await recorder.save(session, state);
  });
}
