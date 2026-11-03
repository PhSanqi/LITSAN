import { toolName } from "../../brand.mjs";
import { jsonResult, type ToolDefinition } from "./shared.js";
import type { MaintenanceDeps } from "../../maintenance-control.js";
import type { MaintenanceCardKind } from "../../contracts/maintenance.js";
import { nextCard, queueStatus, submitCard, releaseCard, loadInlineCard } from "../../maintenance-control.js";
import { requiredString, optionalString, optionalInteger, type CatalogContext, CLIENT_PROFILE_SCHEMA } from "./shared.js";
import { listCaptureEvents } from "../../capture.js";
import { resolveCaptureProject } from "../../capture-project-resolution.js";
import { eventBranchAssignment } from "../../capture-branch-assignments.js";
import { inlineTurnOwner } from "../../maintenance-control.js";
import { appendMaintenanceCallTiming, type MaintenanceCallTiming, getMaintenanceConfig, readMaintenanceStore, withMaintenanceOfferState } from "../../maintenance-store.js";

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
            const config = await getMaintenanceConfig(stateRoot), now = Date.now();
            if (config.conversation_maintenance !== "quiet" || config.opted_out_projects.includes(project) ||
              (event.user_text?.length ?? 0) > config.heavy_turn_chars) return jsonResult({ ok: true, card: null });
            const selected = await withMaintenanceOfferState(stateRoot, runtime.accountId, now, async state => {
              const requestedCap = optionalInteger((args.client_profile as Record<string, unknown> | undefined)?.max_card_tokens) ?? 3000;
              const held = (await readMaintenanceStore(stateRoot, runtime.accountId)).cards.some(c => c.project_id === project &&
                (c.branch_id ?? "main") === (branch?.branch_id ?? "main") && c.status === "leased" &&
                c.lease?.owner === inlineTurnOwner(inlineEvent) && Date.parse(c.lease.until) > now);
              const cap = Math.min(8000, requestedCap, held ? 8000 : config.daily_est_token_cap - state.est_tokens_offered);
              if ((!held && state.cards_offered >= config.daily_card_cap) || cap < 500) return { card: null };
              const result = await nextCard({ ...base, projectId: project, harness: inlineTurnOwner(inlineEvent), profile: { execution: "inline" },
                kinds: ["l2_chunk", "timeline_digest", "arch_review"], leaseSeconds: 900, inlineL2MaxTokens: cap,
                inlineBranchId: branch?.branch_id ?? "main", resumeInlineOnly: held });
              if (result.card && !result.resumed) { state.cards_offered++; state.est_tokens_offered += result.card.est_tokens; }
              return result;
            });
            if (selected.card) {
              const latest = (await listCaptureEvents(stateRoot, runtime.accountId, { eventId: inlineEvent, limit: 1 }))[0];
              if (!latest || !["open", "partial"].includes(latest.capture_status)) {
                await releaseCard({ ...base, harness: inlineTurnOwner(inlineEvent), cardId: selected.card.card_id, leaseToken: selected.card.lease_token });
                return jsonResult({ ok: false, code: "turn_unavailable" });
              }
            }
            if (!selected.card) return jsonResult({ ok: true, card: null });
            // Claiming is explicit agent readiness: hydrate once here to avoid a second tool round trip.
            const loaded = await loadInlineCard({ stateRoot, runtime, projectId: project, inlineTurnId: inlineEvent,
              inlineBranchId: branch?.branch_id ?? "main", cardId: selected.card.card_id, leaseToken: selected.card.lease_token });
            if (!loaded.ok) await releaseCard({ ...base, harness: inlineTurnOwner(inlineEvent),
              cardId: selected.card.card_id, leaseToken: selected.card.lease_token });
            return jsonResult(loaded);
          }
          if (action === "inline_load") return jsonResult(await loadInlineCard({ stateRoot, runtime, projectId: project, inlineTurnId: inlineEvent,
            inlineBranchId: branch?.branch_id ?? "main", cardId: requiredString(args.card_id, "card_id"), leaseToken: requiredString(args.lease_token, "lease_token") }));
          return jsonResult(await submitCard({ ...base, harness: inlineTurnOwner(inlineEvent), cardId: requiredString(args.card_id, "card_id"),
            leaseToken: requiredString(args.lease_token, "lease_token"), answer: args.answer, project,
            inlineTurnId: inlineEvent, inlineBranchId: branch?.branch_id ?? "main" }));
        }
        if (action === "inline_load" || action === "inline_claim") return jsonResult({ ok: false, code: "turn_unavailable" });
        return jsonResult(await submitCard({ ...base, cardId: requiredString(args.card_id, "card_id"), leaseToken: requiredString(args.lease_token, "lease_token"),
          answer: args.answer, project: await canonical(args.project), workspaceProject: await canonical(args.workspace_project) }));
      }
      const refs = [optionalString(args.project), optionalString(args.workspace_project)].filter((p): p is string => Boolean(p));
      const projects = await Promise.all(refs.map(ref => runtime.projects.resolve(runtime.accountId, ref)));
      if (projects.some(p => !p) || new Set(projects).size > 1) throw new Error("wrong_project");
      const projectId = projects[0] ?? undefined;
      if (action === "queue_status") return jsonResult(await queueStatus({ ...base, projectId, dry: args.dry === true }), false);
      if (action === "next") return jsonResult(await nextCard({ ...base, projectId, cardId: optionalString(args.card_id), kinds: args.kinds as MaintenanceCardKind[] | undefined, leaseSeconds: optionalInteger(args.lease_seconds) }));
      if (action === "release") return jsonResult(await releaseCard({ ...base, cardId: requiredString(args.card_id, "card_id"), leaseToken: requiredString(args.lease_token, "lease_token") }));
      throw new Error("unsupported card action");
  };
  tools.push({
    name: toolName("card"),
    description: "Open L1: next + inline_turn_event (or inline_claim) claims when ready; existing inline_maintenance offers work. Use validated input; inline_load only if absent. Submit evidence-based answers immediately with the same card/lease/turn IDs; check the result; keep maintenance separate. / 同轮按需领取，缺输入才加载，完成即提交并核对，勿混入用户答复。",
    inputSchema: { type: "object", required: ["action"], additionalProperties: false, properties: {
      action: { type: "string", enum: ["queue_status", "next", "submit", "release", "inline_claim", "inline_load"] },
      card_id: { type: "string" }, lease_token: { type: "string" }, answer: { type: "object", additionalProperties: true },
      inline_turn_event: { type: "string", description: "L1 event that owns an in-turn card lease; with next, restricts the claim to this open turn." },
      project: { type: "string" }, workspace_project: { type: "string" },
      client_profile: CLIENT_PROFILE_SCHEMA, kinds: { type: "array", items: { type: "string", enum: ["l2_chunk", "arch_link", "gap_check", "arch_review", "timeline_digest"] } },
      lease_seconds: { type: "integer", minimum: 30, maximum: 900 }, dry: { type: "boolean" }
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
