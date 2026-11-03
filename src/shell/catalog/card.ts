import { toolName } from "../../brand.mjs";
import { jsonResult, type ToolDefinition } from "./shared.js";
import type { MaintenanceDeps } from "../../maintenance-control.js";
import type { MaintenanceCardKind } from "../../contracts/maintenance.js";
import { nextCard, queueStatus, submitCard, releaseCard, loadInlineCard, claimInlineMaintenance } from "../../maintenance-control.js";
import { requiredString, optionalString, optionalInteger, type CatalogContext, CLIENT_PROFILE_SCHEMA } from "./shared.js";
import { listCaptureEvents } from "../../capture.js";
import { resolveCaptureProject } from "../../capture-project-resolution.js";
import { eventBranchAssignment } from "../../capture-branch-assignments.js";
import { inlineTurnOwner } from "../../maintenance-control.js";
import { appendMaintenanceCallTiming, type MaintenanceCallTiming } from "../../maintenance-store.js";

export function cardTools(deps: { runtime: MaintenanceDeps["runtime"]; context: CatalogContext }): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  const { runtime, context: { stateRoot } } = deps;
  const runCard = async (args: Record<string, unknown>) => {
      const base = { stateRoot, runtime, harness: runtime.source.platform ?? "mcp-harness", profile: args.client_profile };
      const requestedAction = requiredString(args.action, "action");
      // Cached clients already expose next and inline_turn_event; never let malformed inline claims fall through to worker scope.
      const action = requestedAction === "next" && Object.hasOwn(args, "inline_turn_event") ? "inline_claim" : requestedAction;
      // Submit must report a project mismatch through the card rejection path.
      if (action === "submit" || action === "inline_load" || action === "inline_claim") {
        const canonical = async (value: unknown) => { const ref = optionalString(value); return ref ? await runtime.projects.resolve(runtime.accountId, ref) ?? ref : undefined; };
        const inlineEvent = optionalString(args.inline_turn_event);
        if (inlineEvent) {
          const event = (await listCaptureEvents(stateRoot, runtime.accountId, { eventId: inlineEvent, limit: 1 }))[0];
          if (!event || !["open", "partial", "complete"].includes(event.capture_status ?? ""))
            return jsonResult({ ok: false, code: "turn_unavailable" });
          const resolved = await resolveCaptureProject(event, ref => runtime.projects.resolve(runtime.accountId, ref), stateRoot);
          const project = resolved.projectId, requested = await canonical(args.project), workspace = await canonical(args.workspace_project);
          if (!project || [requested, workspace].some(ref => ref !== undefined && ref !== project))
            return jsonResult({ ok: false, code: "wrong_project" });
          const branch = await eventBranchAssignment(stateRoot, runtime.accountId, inlineEvent);
          if (action === "inline_claim") {
            if (!["open", "partial"].includes(event.capture_status) || ![undefined, "user"].includes(event.provenance?.origin as string | undefined) ||
              ![undefined, "user_prompt"].includes(event.provenance?.trigger as string | undefined)) return jsonResult({ ok: false, code: "turn_unavailable" });
            const selected = await claimInlineMaintenance({ stateRoot, runtime, projectId: project, eventId: inlineEvent,
              branchId: branch?.branch_id ?? "main", profile: args.client_profile, hydrate: true });
            if (selected.card) {
              const latest = (await listCaptureEvents(stateRoot, runtime.accountId, { eventId: inlineEvent, limit: 1 }))[0];
              if (!latest || !["open", "partial"].includes(latest.capture_status)) {
                await releaseCard({ ...base, harness: inlineTurnOwner(inlineEvent), cardId: selected.card.card_id, leaseToken: selected.card.lease_token });
                return jsonResult({ ok: false, code: "turn_unavailable" });
              }
            }
            return jsonResult(selected);
          }
          if (action === "inline_load") return jsonResult(await loadInlineCard({ stateRoot, runtime, projectId: project, inlineTurnId: inlineEvent,
            inlineBranchId: branch?.branch_id ?? "main", cardId: requiredString(args.card_id, "card_id"), leaseToken: requiredString(args.lease_token, "lease_token") }));
          const accepted = await submitCard({ ...base, harness: inlineTurnOwner(inlineEvent), cardId: requiredString(args.card_id, "card_id"),
            leaseToken: requiredString(args.lease_token, "lease_token"), answer: args.answer, project,
            inlineTurnId: inlineEvent, inlineBranchId: branch?.branch_id ?? "main" });
          // Successful submissions advance the queue without asking the AI to report availability.
          if (accepted.ok && !("already_accepted" in accepted) && !("merge_error" in accepted && accepted.merge_error)) {
            const latest = (await listCaptureEvents(stateRoot, runtime.accountId, { eventId: inlineEvent, limit: 1 }))[0];
            if (latest && ["open", "partial"].includes(latest.capture_status) && [undefined, "user"].includes(latest.provenance?.origin as string | undefined) &&
              [undefined, "user_prompt"].includes(latest.provenance?.trigger as string | undefined)) {
              try {
                const next = await claimInlineMaintenance({ stateRoot, runtime, projectId: project, eventId: inlineEvent,
                  branchId: branch?.branch_id ?? "main", profile: args.client_profile, hydrate: true });
                if (next.card) {
                  const current = (await listCaptureEvents(stateRoot, runtime.accountId, { eventId: inlineEvent, limit: 1 }))[0];
                  if (!current || !["open", "partial"].includes(current.capture_status)) {
                    await releaseCard({ ...base, harness: inlineTurnOwner(inlineEvent), cardId: next.card.card_id, leaseToken: next.card.lease_token });
                    return jsonResult(accepted);
                  }
                }
                return jsonResult({ ...accepted, dispatch: next.dispatch, ...(next.card ? { inline_maintenance: next.card } : {}) });
              } catch (error) {
                console.error("[litsan] automatic card continuation:", error);
                return jsonResult({ ...accepted, dispatch_error: "allocation_unavailable" });
              }
            }
          }
          return jsonResult(accepted);
        }
        if (action === "inline_load" || action === "inline_claim") return jsonResult({ ok: false, code: "turn_unavailable" });
        return jsonResult(await submitCard({ ...base, cardId: requiredString(args.card_id, "card_id"), leaseToken: requiredString(args.lease_token, "lease_token"),
          answer: args.answer, project: await canonical(args.project), workspaceProject: await canonical(args.workspace_project) }));
      }
      const refs = [optionalString(args.project), optionalString(args.workspace_project)].filter((p): p is string => Boolean(p));
      const projects = await Promise.all(refs.map(ref => runtime.projects.resolve(runtime.accountId, ref)));
      if (projects.some(p => !p) || new Set(projects).size > 1) throw new Error("wrong_project");
      const projectId = projects[0] ?? undefined;
      if (action === "queue_status") return jsonResult(await queueStatus({ ...base, projectId, detailed: args.detailed === true, dry: args.dry === true }), false);
      if (action === "next") return jsonResult(await nextCard({ ...base, projectId, cardId: optionalString(args.card_id), kinds: args.kinds as MaintenanceCardKind[] | undefined, leaseSeconds: optionalInteger(args.lease_seconds) }));
      if (action === "release") return jsonResult(await releaseCard({ ...base, cardId: requiredString(args.card_id, "card_id"), leaseToken: requiredString(args.lease_token, "lease_token") }));
      throw new Error("unsupported card action");
  };
  tools.push({
    name: toolName("card"),
    description: "Each open user turn: next + inline_turn_event. Server picks 1-3 cards by queue demand, first eligible card reserved. Use returned input; inline_load only if absent. Submit evidence-based answers at once with the same card/lease/turn IDs; follow inline_maintenance until none or error. Keep it out of the user answer. / 服务器按积压分配，首张保底；AI 只做蒸馏。",
    inputSchema: { type: "object", required: ["action"], additionalProperties: false, properties: {
      action: { type: "string", enum: ["queue_status", "next", "submit", "release", "inline_claim", "inline_load"] },
      card_id: { type: "string" }, lease_token: { type: "string" }, answer: { type: "object", additionalProperties: true },
      inline_turn_event: { type: "string", description: "L1 event that owns an in-turn card lease; with next, restricts the claim to this open turn." },
      project: { type: "string" }, workspace_project: { type: "string" },
      client_profile: CLIENT_PROFILE_SCHEMA, kinds: { type: "array", items: { type: "string", enum: ["l2_chunk", "arch_link", "gap_check", "arch_review", "timeline_digest"] } },
      lease_seconds: { type: "integer", minimum: 30, maximum: 900 }, dry: { type: "boolean" }, detailed: { type: "boolean", description: "Include scoped L2 backlog and 24-hour throughput statistics." }
    } },
    run: async (args: Record<string, unknown>) => {
      const started = performance.now();
      const timing: MaintenanceCallTiming = { ts: new Date().toISOString(), account: runtime.accountId,
        action: typeof args.action === "string" ? args.action : "unknown", outcome: "error", duration_ms: 0,
        ...(typeof args.card_id === "string" ? { card_id: args.card_id } : {}),
        ...(typeof args.inline_turn_event === "string" ? { inline_turn_event: args.inline_turn_event } : {}) };
      try {
        const result = await runCard(args);
        const data = (result.kind === "json" ? result.value : {}) as { ok?: boolean; card_id?: string; card?: { card_id?: string }; code?: string; set_status?: string };
        timing.outcome = data.ok === false ? "rejected" : "ok";
        timing.card_id = data.card_id ?? data.card?.card_id ?? timing.card_id;
        timing.code = data.code; timing.set_status = data.set_status;
        return result;
      } finally {
        timing.duration_ms = Math.round((performance.now() - started) * 1000) / 1000;
        // Timing is metadata only; a logging failure must not turn an accepted write into an apparent failure.
        try { await appendMaintenanceCallTiming(stateRoot, timing); }
        catch { console.error("[litsan] maintenance timing log failed"); }
      }

    }
  });
  return tools;
}
