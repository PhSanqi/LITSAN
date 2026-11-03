import { toolName } from "../../brand.mjs";
import { jsonResult, type ToolDefinition } from "./shared.js";
import { bindWorkstreamTurn, type WorkstreamDeps } from "../../workstream.js";
import { isWorkstreamEnabled } from "../../workstream-config.js";
import { parseWorkstreamHint, WORKSTREAM_SCHEMA } from "./shared.js";
import { randomUUID } from "node:crypto";
import { listCaptureEvents } from "../../capture.js";
import { resolveExplicitProjectEvidence } from "../../context-router.js";
import { maybeQueueThresholdDistillation } from "../../distillation-scheduling.js";
import * as maintenanceControl from "../../maintenance-control.js";
import { readMaintenanceStore, withTurnCommitMaintenance } from "../../maintenance-store.js";
import { eventBranchAssignment } from "../../capture-branch-assignments.js";
import { recentL1Continuity, upsertL1Turn } from "../../turn-log.js";
import { assignCaptureProjects, projectClarification } from "../../capture-project-assignments.js";
import { resolveCaptureProject } from "../../capture-project-resolution.js";
import type { SourceContext } from "../../contracts/identity.js";
import type { ContextRouterDeps } from "../../context-router.js";
import type { TurnLogDeps } from "../../turn-log.js";
import { requiredString, optionalString, objectRecord, optionalInteger, type CatalogContext, CLIENT_PROFILE_SCHEMA } from "./shared.js";

export interface TurnToolDeps {
  runtime: WorkstreamDeps & TurnLogDeps & ContextRouterDeps & maintenanceControl.MaintenanceDeps["runtime"] & { source: SourceContext };
  context: CatalogContext;
}

export function turnTools(deps: TurnToolDeps): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  const { runtime, context: { stateRoot } } = deps;
  tools.push({
    name: toolName("turn"),
    description: "For each relevant user turn, open with user_text and known project. Process offered inline_maintenance, or automatically check litsan_card next with event_id as inline_turn_event if open returned no card. The server sets card count from queue demand; do not self-report busy or skip the check. Submit card answers separately and follow any returned next card until the server stops. Commit normal assistant_text before final response; commit releases leftover leases. Do not invent conversation IDs. Ask on project_resolution. / 每轮自动领取，积压决定数量，首张保底；无需 AI 判断忙闲。",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["open", "checkpoint", "commit", "failed", "truncated", "resume", "assign", "record"], description: "open/checkpoint/commit/failed/truncated/resume/assign/record (record = open+commit in one call)" },
        origin: { type: "string", enum: ["user", "agent", "automation"], description: "Turn origin; defaults to user on open/record." },
        trigger: { type: "string", enum: ["user_prompt", "hook", "task_notification", "side_session_note", "session_message", "scheduled_wakeup", "ci_event", "delegate", "cli_run", "other"] },
        initiator: { type: "object", additionalProperties: false, properties: {
          harness: { type: "string", maxLength: 80 },
          session_id: { type: "string", maxLength: 300 },
          event_id: { type: "string", maxLength: 300 }
        } },
        relates_to: { type: "object", additionalProperties: false, properties: {
          event_id: { type: "string" },
          relation: { type: "string", enum: ["relays", "duplicate_of", "continues"] }
        }, required: ["event_id", "relation"] },
        event_ids: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 200 },
        keep_global: { type: "boolean" },
        event_id: { type: "string", description: "open 返回的稳定 L1 event id；后续 checkpoint/commit/resume 原样回传" },
        conversation_id: { type: "string", description: "可选 transport provenance；不用于 project/branch 路由" },
        continuity_id: { type: "string", description: "Explicit continuity key; assign binds later turns" },
        turn_id: { type: "string", description: "Harness 原生 turn id；可替代 event_id 做幂等定位" },
        previous_event_id: { type: "string", description: "显式前序 L1 event id" },
        project: { type: "string", description: "明确 canonical project；与 workspace_project 冲突时拒绝" },
        workspace_project: { type: "string", description: "当前工作区解析出的 project；与 project 冲突时拒绝" },
        workstream: WORKSTREAM_SCHEMA,
        branch: { type: "string", description: "Explicit active project branch id/name; used only by open" },
        user_text: { type: "string", description: "用户原始输入文本" },
        assistant_text: { type: "string", description: "助手最终回答文本" },
        reasoning_summary: { type: "string", description: "可公开审计的决策摘要，不得包含隐藏 chain-of-thought" },
        tool_summary: { type: "string", description: "关键工具动作与结果摘要" },
        client_profile: CLIENT_PROFILE_SCHEMA,
        inline_maintenance: { type: "boolean", description: "quiet mode offers a queue-selected card on open; false defers to the same-turn next check; true opts in visible mode." },
        maintenance_answer: { type: "object", additionalProperties: true, description: "Separate {card_id, lease_token, answer} from the offered card; never include it in assistant_text." },
        limit: { type: "integer", minimum: 1, maximum: 50, description: "resume 最大返回轮数，默认 12" }
      },
      required: ["action"],
      additionalProperties: false
    },
    run: async (args: Record<string, unknown>) => {
      const action = requiredString(args.action, "action");
      if (!["open", "checkpoint", "commit", "failed", "truncated", "resume", "assign", "record"].includes(action)) {
        throw new TypeError("unsupported turn action");
      }
      const opens = action === "open" || action === "record";
      const completes = action === "commit" || action === "record";
      const transportConversationId = optionalString(args.conversation_id);
      const requestedContinuityId = optionalString(args.continuity_id);
      if (action === "assign") {
        return jsonResult({ ok: true, ...await assignCaptureProjects({
          stateRoot, accountId: runtime.accountId, projects: runtime.projects, assignedBy: "host",
          project: args.project, keepGlobal: args.keep_global, continuityId: args.continuity_id, eventIds: args.event_ids
        }) });
      }
      if (action === "resume") {
        const resumeEventId = optionalString(args.event_id);
        const event = resumeEventId
          ? (await listCaptureEvents(stateRoot, runtime.accountId, { eventId: resumeEventId, limit: 1 }))[0]
          : undefined;
        if (resumeEventId && !event) throw new Error("capture event not found for account");
        const continuityId = requestedContinuityId ?? transportConversationId ?? event?.continuity_id;
        if (!continuityId) throw new TypeError("resume requires continuity_id, conversation_id, or event_id");
        const turns = await recentL1Continuity({
          stateRoot,
          accountId: runtime.accountId,
          continuityId,
          limit: optionalInteger(args.limit) ?? 12
        });
        return jsonResult({
          continuity_id: continuityId,
          turns,
          incomplete: turns.filter((turn) => turn.status !== "complete")
        });
      }

      const projectEvidence = await resolveExplicitProjectEvidence(runtime, {
        project: optionalString(args.project),
        workspaceProject: optionalString(args.workspace_project)
      });
      const projectId = projectEvidence.projectId ?? undefined;

      const enabled = opens && projectId && await isWorkstreamEnabled(stateRoot, runtime.accountId, projectId);
      const hint = enabled ? parseWorkstreamHint(args.workstream) : undefined;
      if (enabled && projectId && optionalString(args.branch)) {
        const branch = await runtime.branches.resolve(runtime.accountId, projectId, optionalString(args.branch)!, { includeClosed: true });
        if (!branch || !["active", "closing"].includes(branch.status)) throw new Error("unknown active branch");
      }
      const eventId = optionalString(args.event_id);
      const turnId = optionalString(args.turn_id);
      if (!opens && !eventId && !turnId) {
        throw new TypeError(`${action} requires event_id or turn_id`);
      }
      const userText = optionalString(args.user_text);
      const assistantText = optionalString(args.assistant_text);
      const reasoningSummary = optionalString(args.reasoning_summary);
      const toolSummary = optionalString(args.tool_summary);
      if (opens && !userText) throw new TypeError(`${action} requires user_text`);
      if (action === "checkpoint" && !reasoningSummary && !toolSummary) {
        throw new TypeError("checkpoint requires reasoning_summary or tool_summary");
      }
      if (completes && !assistantText) throw new TypeError(`${action} requires assistant_text`);

      const stableEventId = eventId ?? (
        opens && !turnId
          ? `l1_${randomUUID().replaceAll("-", "")}`
          : undefined
      );
      const syntheticConversationId = transportConversationId
        ? undefined
        : stableEventId
          ? `memhub-unbound:${stableEventId}`
          : turnId
            ? `memhub-unbound-turn:${turnId}`
            : undefined;
      const conversationId = transportConversationId ?? syntheticConversationId;
      if (!conversationId) throw new TypeError(`${action} requires conversation_id, event_id, or turn_id`);
      const existingEvent = eventId ? (await listCaptureEvents(stateRoot, runtime.accountId, { eventId, limit: 1 }))[0] : undefined;
      if (existingEvent && transportConversationId && existingEvent.conversation_id !== transportConversationId) {
        throw new Error("conversation_id does not match the existing event");
      }
      const continuityId = requestedContinuityId ?? existingEvent?.continuity_id ?? conversationId;

      const status =
        completes ? "complete" :
        action === "failed" ? "failed" :
        action === "truncated" ? "truncated" :
        action === "checkpoint" ? "partial" :
        "open";
      const result = await upsertL1Turn({
        stateRoot,
        runtime,
        actorId: `mcp:${runtime.source.transport}`,
        turn: {
          ...(stableEventId ? { event_id: stableEventId } : {}),
          host: runtime.source.platform,
          conversation_id: existingEvent?.conversation_id ?? conversationId,
          continuity_id: continuityId,
          ...(turnId ? { turn_id: turnId } : {}),
          ...(optionalString(args.previous_event_id) ? { previous_event_id: optionalString(args.previous_event_id) } : {}),
          ...(projectId ? { project_hint: projectId } : {}),
          ...(userText ? { user_text: userText } : {}),
          ...(assistantText ? { assistant_text: assistantText } : {}),
          ...(reasoningSummary ? { reasoning_summary: reasoningSummary } : {}),
          ...(toolSummary ? { tool_summary: toolSummary } : {}),
          capture_status: status,
          provenance: {
            ...Object.fromEntries(["origin", "trigger", "initiator", "relates_to"]
              .filter(key => args[key] !== undefined).map(key => [key, args[key]])),
            platform: runtime.source.platform,
            transport: runtime.source.transport,
            principal: runtime.source.principalId,
            connection: runtime.source.connectionId,
            transport_conversation_id_available: existingEvent?.provenance?.transport_conversation_id_available ?? Boolean(transportConversationId)
          }
        }
      });
      const bindingProject = result.project_id ?? projectId;
      const binding = opens && bindingProject && await isWorkstreamEnabled(stateRoot, runtime.accountId, bindingProject)
        ? await bindWorkstreamTurn({ runtime, stateRoot, projectId: bindingProject, eventId: result.turn.event_id,
            branch: optionalString(args.branch), hint: enabled ? hint : parseWorkstreamHint(args.workstream), now: new Date().toISOString() }) : undefined;
      const inlineOwner = maintenanceControl.inlineTurnOwner(result.turn.event_id);
      let inlineMaintenance: unknown;
      if (action === "open" && args.inline_maintenance !== false && result.project_id && (args.origin ?? "user") === "user" &&
        (args.inline_maintenance === true || args.trigger === undefined || args.trigger === "user_prompt")) {
        try {
          const selected = await maintenanceControl.claimInlineMaintenance({ stateRoot, runtime, projectId: result.project_id!,
            eventId: result.turn.event_id, branchId: binding?.id ?? "main",
            profile: args.client_profile, allowVisible: args.inline_maintenance === true, resumeOnly: !result.created });
          inlineMaintenance = selected.card ?? undefined;
        } catch (error) { console.error("[litsan] inline maintenance open:", error); }
      }
      let distillation: unknown;
      let distillation_queue_error: string | undefined;
      let maintenance: Awaited<ReturnType<typeof maintenanceControl.offerForCommit>>;
      let hadInlineCard = false;
      if (completes || action === "failed" || action === "truncated") {
        try {
          hadInlineCard = (await readMaintenanceStore(stateRoot, runtime.accountId)).cards.some(c =>
            c.lease?.owner === inlineOwner || c.inline_receipt?.event_id === result.turn.event_id);
        } catch (error) { console.error("[litsan] inline maintenance lookup:", error); }
      }
      const changedCommit = completes && (result.created || result.updated || result.ingestion !== undefined);
      if (changedCommit) {
        try {
          await withTurnCommitMaintenance(stateRoot, runtime.accountId, async () => {
            if (result.turn.ingested && result.project_id) {
              try {
                distillation = await maybeQueueThresholdDistillation({
                  stateRoot,
                  accountId: runtime.accountId,
                  projectId: result.project_id
                });
              } catch (error) {
                distillation_queue_error = error instanceof Error ? error.message : String(error);
                console.error("[litsan] turn distillation queue:", distillation_queue_error);
              }
            }
            if (args.maintenance_answer === undefined && args.inline_maintenance === undefined && !hadInlineCard) maintenance = await maintenanceControl.offerForCommit({
              stateRoot, runtime, harness: runtime.source.platform ?? "mcp-harness", profile: args.client_profile,
              turn: { ingested: Boolean(result.turn.ingested), projectId: result.project_id, assistantChars: (result.turn.assistant_text ?? "").length,
                toolSummaryChars: (result.turn.tool_summary ?? "").length, continuityId: result.turn.continuity_id }
            });
          });
        } catch (error) {
          distillation = undefined;
          maintenance = undefined;
          distillation_queue_error = error instanceof Error ? error.message : String(error);
          console.error("[litsan] turn distillation queue:", distillation_queue_error);
        }
      }
      let maintenanceResult: unknown;
      if (completes && args.maintenance_answer !== undefined) {
        const sidecar = objectRecord(args.maintenance_answer);
        try {
          const cardId = optionalString(sidecar.card_id), leaseToken = optionalString(sidecar.lease_token);
          if (!result.turn.ingested || !result.project_id) maintenanceResult = { ok: false, code: "turn_not_ingested" };
          else if (!cardId || !leaseToken || !Object.hasOwn(sidecar, "answer")) maintenanceResult = { ok: false, code: "schema_invalid" };
          else {
            const branch = await eventBranchAssignment(stateRoot, runtime.accountId, result.turn.event_id);
            maintenanceResult = await maintenanceControl.submitCard({ stateRoot, runtime, harness: inlineOwner,
              profile: { execution: "inline" }, cardId, leaseToken, answer: sidecar.answer, project: result.project_id,
              inlineTurnId: result.turn.event_id, inlineBranchId: branch?.branch_id ?? "main" });
          }
        } catch (error) {
          console.error("[litsan] inline maintenance submit:", error);
          maintenanceResult = { ok: false, code: "processing_error" };
        }
      }
      if (completes || action === "failed" || action === "truncated") {
        try {
          const card = (await readMaintenanceStore(stateRoot, runtime.accountId)).cards.find(c => c.status === "leased" && c.lease?.owner === inlineOwner);
          if (card?.lease) await maintenanceControl.releaseCard({ stateRoot, runtime, harness: inlineOwner, profile: { execution: "inline" },
            cardId: card.card_id, leaseToken: card.lease.token });
        } catch (error) { console.error("[litsan] inline maintenance release:", error); }
      }
      const maintenanceWaiting = completes ? await maintenanceControl.maintenanceWaiting({
        stateRoot, runtime, projectId: result.project_id
      }) : undefined;
      let distillationAck: { queued: boolean; job_id?: string } | undefined;
      if (distillation) {
        const rec = objectRecord(distillation);
        const jobs = Array.isArray(rec.jobs) ? rec.jobs : [];
        const firstJob = jobs.length > 0 ? objectRecord(jobs[0]) : undefined;
        const jobId = typeof firstJob?.job_id === "string" ? firstJob.job_id : undefined;
        distillationAck = {
          queued: Boolean(rec.queued || jobs.length > 0),
          ...(jobId ? { job_id: jobId } : {})
        };
      }
      const storedEvent = (opens || completes) && !result.project_id
        ? (await listCaptureEvents(stateRoot, runtime.accountId, { eventId: result.turn.event_id, limit: 1 }))[0] : undefined;
      const resolution = storedEvent ? await resolveCaptureProject(storedEvent,
        ref => runtime.projects.resolve(runtime.accountId, ref), stateRoot) : undefined;
      const clarification = storedEvent && resolution?.source !== "keep_global"
        ? await projectClarification({ stateRoot, accountId: runtime.accountId, projects: runtime.projects,
            text: storedEvent.user_text ?? "", candidate: resolution?.candidate,
            continuityId: storedEvent.continuity_id, rateLimit: true }) : undefined;
      return jsonResult({
        ok: true,
        action,
        turn_id: turnId ?? result.turn.turn_id ?? null,
        event_id: result.turn.event_id ?? stableEventId ?? null,
        continuity_id: result.turn.continuity_id,
        status: result.turn.status,
        project_id: result.project_id ?? projectId ?? null,
        ingested: Boolean(result.turn.ingested),
        ...(binding ? { branch: binding } : {}),
        ...(clarification ? { project_resolution: clarification } : {}),
        ...(distillationAck ? { distillation: distillationAck } : {}),
        ...(distillation_queue_error ? { distillation_queue_error } : {}),
        ...(maintenance ? { maintenance } : {}),
        ...(inlineMaintenance ? { inline_maintenance: inlineMaintenance } : {}),
        ...(maintenanceResult ? { maintenance_result: maintenanceResult } : {}),
        transport_conversation_id: transportConversationId ?? null,
        ...(maintenanceWaiting ? { maintenance_waiting: maintenanceWaiting } : {})
      });
    }
  });
  return tools;
}
