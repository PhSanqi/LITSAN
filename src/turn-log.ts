import type { AccountId, UserId } from "./contracts/identity.js";
import type { ProjectReader } from "./core/ports/projects.js";
import type { TurnSessionWriter } from "./core/ports/memory.js";
import type { TurnProvenance } from "./contracts/capture.js";
import { createHash } from "node:crypto";
import {
  captureIsFullyExcludedFromMemory,
  captureProjectLookup,
  scheduleCaptureProjectBackfill,
  readCaptureProjectIndexPage,
  readIndexedCaptureEvent,
  isCaptureIngested,
  listCaptureEvents,
  markCaptureIngested,
  normalizeCaptureEvent,
  storeCaptureEvent,
  withCaptureIngestAttempt,
  type LitsanCaptureEvent,
  type StoredCaptureEvent,
  TRUSTED_TURN_SOURCE_KINDS
} from "./capture.js";
import { resolveCaptureProject } from "./capture-project-resolution.js";
import { ingestCaptureIntoMemory } from "./capture-ingest.js";

export interface TurnLogDeps {
  accountId: AccountId;
  projects: Pick<ProjectReader, "resolve">;
  userId: UserId;
  memoryClient: TurnSessionWriter;
}

export type L1TurnStatus = LitsanCaptureEvent["capture_status"];

export interface L1TurnInput {
  event_id?: string;
  host: string;
  host_version?: string;
  conversation_id: string;
  continuity_id?: string;
  turn_id?: string;
  previous_event_id?: string;
  timestamp?: string;
  workspace_id?: string;
  workspace_path?: string;
  project_hint?: string;
  user_text?: string;
  assistant_text?: string;
  reasoning_summary?: string;
  tool_summary?: string;
  capture_status?: L1TurnStatus;
  provenance?: Record<string, unknown>;
}

export interface L1TurnView extends TurnProvenance {
  event_id: string;
  account_id: string;
  host: string;
  conversation_id: string;
  continuity_id: string;
  turn_id?: string;
  previous_event_id?: string;
  timestamp: string;
  project_hint?: string;
  resolved_project_id?: string | null;
  user_text?: string;
  assistant_text?: string;
  reasoning_summary?: string;
  tool_summary?: string;
  status: L1TurnStatus;
  ingested: boolean;
}

export async function upsertL1Turn(input: {
  stateRoot: string;
  runtime: TurnLogDeps;
  actorId: string;
  turn: L1TurnInput;
}): Promise<{
  turn: L1TurnView;
  created: boolean;
  updated: boolean;
  ingestion?: unknown;
  project_id: string | null;
}> {
  const eventId = input.turn.event_id ?? stableTurnEventId(
    input.runtime.accountId,
    input.turn.continuity_id ?? input.turn.conversation_id,
    input.turn.turn_id ?? input.turn.timestamp ?? new Date().toISOString()
  );
  const existing = (await listCaptureEvents(input.stateRoot, input.runtime.accountId, { eventId, limit: 1 }))[0];
  const provenance = normalizeTurnProvenance(input.turn.provenance ?? {}, existing?.provenance);
  if (provenance.relates_to && !(await listCaptureEvents(input.stateRoot, input.runtime.accountId,
    { eventId: provenance.relates_to.event_id, limit: 1 })).length) {
    throw new TypeError("relates_to event not found");
  }
  const event = normalizeCaptureEvent({
    ...input.turn,
    provenance: {
      ...provenance,
      source_kinds: {
        ...TRUSTED_TURN_SOURCE_KINDS,
        user_text: provenance.origin === "agent" ? "agent_inferred" :
          provenance.origin === "automation" ? "tool_output" : "user_said"
      }
    },
    event_id: eventId,
    timestamp: input.turn.timestamp ?? new Date().toISOString()
  });

  const stored = await storeCaptureEvent(input.stateRoot, {
    account_id: input.runtime.accountId,
    actor_id: input.actorId
  }, event);
  const projectId = (await resolveCaptureProject(stored.event,
    ref => input.runtime.projects.resolve(input.runtime.accountId, ref), input.stateRoot)).projectId;

  let ingestion: unknown;
  if (stored.event.capture_status === "complete" && captureIsFullyExcludedFromMemory(stored.event)) {
    await markCaptureIngested(input.stateRoot, input.runtime.accountId, stored.event.event_id);
    ingestion = { ingested: false, excluded: true, project_id: projectId };
  }
  if (
    ingestion === undefined &&
    stored.event.capture_status === "complete" &&
    !(await isCaptureIngested(input.stateRoot, input.runtime.accountId, stored.event.event_id))
  ) {
    const attempt = await withCaptureIngestAttempt({
      stateRoot: input.stateRoot,
      accountId: input.runtime.accountId,
      eventId: stored.event.event_id,
      expectedEvent: stored.event,
      ingest: (event) => ingestCaptureIntoMemory({
        event,
        actor: { account_id: input.runtime.accountId, actor_id: input.actorId },
        runtime: input.runtime,
        projectId
      })
    });
    ingestion = attempt.result;
  }

  return {
    turn: turnView(stored.event, await isCaptureIngested(
      input.stateRoot,
      input.runtime.accountId,
      stored.event.event_id
    )),
    created: stored.created,
    updated: stored.updated,
    ...(ingestion === undefined ? {} : { ingestion }),
    project_id: projectId
  };
}

export async function listL1Turns(input: {
  stateRoot: string;
  accountId: string;
  continuityId?: string;
  conversationId?: string;
  projectId?: string;
  limit?: number;
  offset?: number;
  resolveProject?: (ref: string) => Promise<string | null>;
}): Promise<L1TurnView[]> {
  const page = { projectIds: input.projectId ? [input.projectId] : [], continuityId: input.continuityId,
    conversationId: input.conversationId, includeAssignments: true,
    limit: Math.max(1, Math.min(500, Math.trunc(input.limit ?? 100))), offset: input.offset };
  const registryLookup = input.resolveProject ?? captureProjectLookup(input.stateRoot, input.accountId);
  const lookups = new Map<string, Promise<string | null>>();
  const lookup = (ref: string) => {
    if (!lookups.has(ref)) lookups.set(ref, registryLookup(ref));
    return lookups.get(ref)!;
  };
  // Resolve a bounded pending probe before SQL pagination; cached nonmatches never consume its window.
  const pendingIds: string[] = [];
  if (input.projectId) {
    const pending = await readCaptureProjectIndexPage(input.stateRoot, input.accountId,
      { ...page, resolution: "pending", offset: 0, limit: 500 });
    for (const entry of pending) {
      const result = await resolveCaptureProject(entry, lookup, undefined, undefined, entry.assignment_snapshot);
      if (result.projectId === input.projectId) pendingIds.push(entry.event_id);
    }
  }
  const entries = await readCaptureProjectIndexPage(input.stateRoot, input.accountId,
    { ...page, resolution: "cached", resolvedPendingIds: pendingIds });
  const views: L1TurnView[] = [];
  for (const entry of entries) {
    const item = await readIndexedCaptureEvent(input.stateRoot, entry);
    const resolution = await resolveCaptureProject(item, lookup, undefined, undefined, entry.assignment_snapshot);
    views.push({ ...turnView(item, entry.ingested), resolved_project_id: resolution.projectId });
  }
  scheduleCaptureProjectBackfill(input.stateRoot, input.accountId);
  return views;
}

export async function recentL1Continuity(input: {
  stateRoot: string;
  accountId: string;
  continuityId: string;
  limit?: number;
}): Promise<L1TurnView[]> {
  const turns = await listL1Turns({
    stateRoot: input.stateRoot,
    accountId: input.accountId,
    continuityId: input.continuityId,
    limit: input.limit ?? 12
  });
  return turns.reverse();
}

function stableTurnEventId(accountId: string, continuityId: string, turnId: string): string {
  return `l1_${createHash("sha256")
    .update([accountId, continuityId, turnId].join("\0"), "utf8")
    .digest("hex")
    .slice(0, 40)}`;
}

function turnView(event: StoredCaptureEvent, ingested: boolean): L1TurnView {
  return {
    ...Object.fromEntries(["origin", "trigger", "initiator", "relates_to"]
      .filter(key => event.provenance?.[key] !== undefined).map(key => [key, event.provenance![key]])),
    event_id: event.event_id,
    account_id: event.account_id,
    host: event.host,
    conversation_id: event.conversation_id,
    continuity_id: event.continuity_id,
    ...(event.turn_id ? { turn_id: event.turn_id } : {}),
    ...(event.previous_event_id ? { previous_event_id: event.previous_event_id } : {}),
    timestamp: event.timestamp,
    ...(event.project_hint ? { project_hint: event.project_hint } : {}),
    ...(event.user_text ? { user_text: event.user_text } : {}),
    ...(event.assistant_text ? { assistant_text: event.assistant_text } : {}),
    ...(event.reasoning_summary ? { reasoning_summary: event.reasoning_summary } : {}),
    ...(event.tool_summary ? { tool_summary: event.tool_summary } : {}),
    status: event.capture_status,
    ingested
  };
}

function normalizeTurnProvenance(incoming: Record<string, unknown>, stored?: Record<string, unknown>): Record<string, unknown> & TurnProvenance {
  const result = { ...incoming };
  for (const key of ["origin", "trigger", "initiator", "relates_to"]) {
    if (result[key] === undefined && stored?.[key] !== undefined) result[key] = stored[key];
  }
  if (result.origin === undefined) result.origin = "user";
  if (!["user", "agent", "automation"].includes(result.origin as string)) {
    throw new TypeError("origin must be user, agent, or automation");
  }
  if (stored?.origin !== undefined && result.origin !== stored.origin) throw new TypeError("origin cannot change after open");
  if (result.trigger !== undefined && !["user_prompt", "hook", "task_notification", "side_session_note", "session_message",
    "scheduled_wakeup", "ci_event", "delegate", "cli_run", "other"].includes(result.trigger as string)) {
    throw new TypeError("trigger must be a supported turn trigger");
  }
  for (const key of ["initiator", "relates_to"] as const) {
    const value = result[key];
    if (value === undefined) continue;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${key} must be an object`);
    const fields = value as Record<string, unknown>;
    const allowed = key === "initiator" ? ["harness", "session_id", "event_id"] : ["event_id", "relation"];
    if (Object.keys(fields).some(field => !allowed.includes(field))) throw new TypeError(`${key} has unknown properties`);
    const normalized: Record<string, string> = {};
    for (const field of allowed) {
      const text = fields[field];
      if (text === undefined && key === "initiator") continue;
      if (typeof text !== "string" || (key === "relates_to" && !text.trim())) {
        throw new TypeError(`${key}.${field} must be a string${key === "relates_to" ? " and is required" : ""}`);
      }
      if (key === "initiator" && text.length > (field === "harness" ? 80 : 300)) {
        throw new TypeError(`initiator.${field} exceeds maximum length ${field === "harness" ? 80 : 300}`);
      }
      normalized[field] = text;
    }
    if (key === "relates_to" && !["relays", "duplicate_of", "continues"].includes(normalized.relation!)) {
      throw new TypeError("relates_to.relation must be relays, duplicate_of, or continues");
    }
    result[key] = normalized;
  }
  return result as Record<string, unknown> & TurnProvenance;
}
