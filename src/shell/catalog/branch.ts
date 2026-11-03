import { toolName } from "../../brand.mjs";
import { jsonResult, type ToolDefinition } from "./shared.js";
import { readBranchBase, retagBranchEvents, closeWorkstreamBranch, type WorkstreamDeps } from "../../workstream.js";
import { readBranchDraft, mutateBranchDraft } from "../../branch-drafts.js";
import type { DistillationSubmitDeps } from "../../distillation-submit.js";
import { isWorkstreamEnabled, setWorkstreamEnabled } from "../../workstream-config.js";
import { resolveExplicitProjectEvidence } from "../../context-router.js";
import type { ContextRouterDeps } from "../../context-router.js";
import type { BranchReader, BranchWriter } from "../../core/ports/branches.js";
import { requiredString, optionalString, optionalBoolean, type CatalogContext } from "./shared.js";

export interface BranchToolDeps {
  runtime: WorkstreamDeps & DistillationSubmitDeps & ContextRouterDeps & { branches: BranchReader & BranchWriter };
  context: CatalogContext;
}

export function branchTools(deps: BranchToolDeps): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  const { runtime, context: { stateRoot } } = deps;
  tools.push({
    name: toolName("branch"),
    description: "项目内 Branch Context。Branch 是显式或 workstream-derived scope；不绑定 host conversation；host conversation ids never bind. create/list/close/reopen 管理元数据，settings 控制开关，retag 移动未蒸馏事件。",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "create", "close", "reopen", "retag", "settings"], description: "操作类型：list/create/close/reopen/retag/settings" },
        project: { type: "string", description: "项目 slug/name/alias；与 workspace_project 冲突时拒绝" },
        workspace_project: { type: "string", description: "当前工作区解析出的 project；与 project 冲突时拒绝" },
        branch: { type: "string", description: "Branch id/name；close/reopen 必填" },
        name: { type: "string", description: "create 时的 Branch 名称" },
        goal: { type: "string", description: "create 时明确 workstream 目标，用于检索过滤" },
        enabled: { type: "boolean" },
        event_ids: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1, maxItems: 200 },
        to_branch: { type: "string", description: "Active branch id/name or main" },
        include_closed: { type: "boolean", description: "list 是否包含已关闭 Branch；默认 false" }
      },
      required: ["action"],
      additionalProperties: false
    },
    run: async (args: Record<string, unknown>) => {
      const action = requiredString(args.action, "action");
      const explicit = await resolveExplicitProjectEvidence(runtime, {
        project: optionalString(args.project),
        workspaceProject: optionalString(args.workspace_project)
      });
      const projectId = explicit.projectId;
      if (!projectId) throw new TypeError(`${action} requires one resolved project`);

      if (action === "settings") {
        const enabled = optionalBoolean(args.enabled);
        if (enabled !== undefined) await setWorkstreamEnabled(stateRoot, runtime.accountId, projectId, enabled);
        return jsonResult({ project: projectId, enabled: await isWorkstreamEnabled(stateRoot, runtime.accountId, projectId) });
      }
      if (action === "retag") {
        if (!Array.isArray(args.event_ids) || args.event_ids.length < 1 || args.event_ids.length > 200 ||
            args.event_ids.some(id => typeof id !== "string" || !id.trim())) throw new TypeError("event_ids requires 1-200 ids");
        return jsonResult(await retagBranchEvents({ runtime, stateRoot, projectId,
          eventIds: args.event_ids.map(id => (id as string).trim()), target: requiredString(args.to_branch, "to_branch") }));
      }
      if (action === "list") {
        return jsonResult({
          project: projectId,
          branches: await runtime.branches.list(runtime.accountId, projectId, {
            includeClosed: optionalBoolean(args.include_closed) ?? false
          })
        });
      }
      if (action === "create") {
        const branch = await runtime.branches.create(runtime.accountId, projectId, {
          name: requiredString(args.name, "name"),
          goal: requiredString(args.goal, "goal"),
          ...(await isWorkstreamEnabled(stateRoot, runtime.accountId, projectId)
            ? await readBranchBase(runtime, stateRoot, projectId) : {})
        });
        return jsonResult({ ok: true, project: projectId, branch });
      }
      if (action === "close") {
        return jsonResult({
          ok: true,
          project: projectId,
          ...await closeWorkstreamBranch({ stateRoot, runtime }, projectId, requiredString(args.branch, "branch"))
        });
      }
      if (action === "reopen") {
        const reference = requiredString(args.branch, "branch");
        const existing = await runtime.branches.resolve(runtime.accountId, projectId, reference, { includeClosed: true });
        const draft = existing && await readBranchDraft(stateRoot, runtime.accountId, projectId, existing.branchId);
        if (await isWorkstreamEnabled(stateRoot, runtime.accountId, projectId) || draft) {
          if (!existing || !["closed", "merged", "expired"].includes(existing.status)) throw new Error("branch_not_reopenable");
          const branch = await runtime.branches.refreshBase(runtime.accountId, projectId, existing.branchId,
            await readBranchBase(runtime, stateRoot, projectId), new Date().toISOString());
          if (draft) await mutateBranchDraft(stateRoot, runtime.accountId, projectId, branch.branchId, async d => { if (d.status === "merged") d.merged_event_count = d.events.length; d.status = "open"; delete d.merged_at; delete d.merge_job_id; delete d.archived_at; });
          return jsonResult({ ok: true, project: projectId, branch });
        }
        return jsonResult({
          ok: true,
          project: projectId,
          branch: await runtime.branches.reopen(runtime.accountId, projectId, requiredString(args.branch, "branch"))
        });
      }
      throw new TypeError(`unsupported litsan_branch action: ${action}`);
    }
  });
  return tools;
}
