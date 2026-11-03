import { toolName } from "../../brand.mjs";
import { jsonResult, type ToolDefinition } from "./shared.js";
import { executeSkillMutation, loadSkillForAccount, planSkillMutation } from "../../skill-governance.js";
import { readSkillExecution, recordSkillExecutionEvent, recordSkillLoad, skillTelemetrySummary, type SkillExecutionStage } from "../../skill-telemetry.js";
import { skillSelectionMetadataFromBody } from "../../skill-router.js";
import type { SkillGovernanceDeps } from "../../skill-governance.js";
import { requiredString, optionalString, type CatalogContext } from "./shared.js";

export interface SkillToolDeps {
  runtime: SkillGovernanceDeps;
  context: CatalogContext;
}

export function skillTools(deps: SkillToolDeps): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  const { runtime, context: { stateRoot } } = deps;
  tools.push({
    name: toolName("skill"),
    description: "Skill Router / Execution Lifecycle。litsan_context 返回精简候选；action=load 加载 Skill 与 execution_id，真正执行后 action=record 记录 invoked、success/failure、user_correction；status 查看 telemetry。修订或退役现有 Skill 必须 action=plan（operation=revise/retire）并向用户展示精确影响，取得针对该计划的明确批准后才 action=execute；保留稳定 source_skill_id，版本替换归档旧 memory id，不创建同名并行现行 Skill。",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["load", "record", "status", "plan", "execute"], description: "操作类型：load/record/status/plan/execute" },
        skill_id: { type: "string", description: "litsan_context 返回的 Skill memory id" },
        execution_id: { type: "string", description: "load 返回；record 时必须原样回传" },
        stage: { type: "string", enum: ["invoked", "success", "failure", "user_correction"], description: "action=record 的执行阶段" },
        executor: { type: "string", description: "实际执行 Harness/executor，如 codex/chatgpt/claude-code" },
        note: { type: "string", description: "简短执行结果、修订理由或纠正摘要；不要写隐藏 chain-of-thought" },
        operation: { type: "string", enum: ["revise", "retire"], description: "action=plan 的治理操作" },
        content: { type: "string", description: "revise 时的完整新版 Skill 过程" },
        title: { type: "string", description: "revise 时的 Skill 标题" },
        version: { type: "string", description: "revise 时严格递增的 numeric dotted 版本，如 1.1.0" },
        tags: { type: "array", items: { type: "string" }, description: "新版业务检索标签（不可自行声明 scope/provenance）" },
        authorization_id: { type: "string", description: "plan 返回的一次性治理授权；仅在用户明确批准后执行" }
      },
      required: ["action", "skill_id"],
      additionalProperties: false
    },
    run: async (args: Record<string, unknown>) => {
      const action = requiredString(args.action, "action");
      const skillId = requiredString(args.skill_id, "skill_id");
      const skill = await loadSkillForAccount(runtime, skillId);
      if (action === "status") {
        const summary = await skillTelemetrySummary(stateRoot, runtime.accountId, skillId);
        const executionId = optionalString(args.execution_id);
        const execution = executionId ? await readSkillExecution(stateRoot, runtime.accountId, executionId) : undefined;
        if (execution && execution.some((event) => event.skill_id !== skillId)) {
          throw new Error("skill execution id belongs to another skill");
        }
        return jsonResult({
          summary,
          status: skill.status,
          source_skill_id: skill.sourceSkillId,
          source_skill_version: skill.sourceSkillVersion,
          ...(execution ? { execution } : {})
        });
      }
      if (action === "plan") {
        return jsonResult(await planSkillMutation({ runtime, args, skillId, skill }));
      }
      if (action === "execute") {
        return jsonResult(await executeSkillMutation({ stateRoot, runtime, args, skillId, skill }));
      }
      if (skill.status !== "activated" && action === "load") {
        throw new Error("archived or inactive Skill cannot be loaded for new execution");
      }
      if (action === "load") {
        const before = await skillTelemetrySummary(stateRoot, runtime.accountId, skillId);
        const loaded = await recordSkillLoad({
          stateRoot,
          accountId: runtime.accountId,
          skillId,
          executionId: optionalString(args.execution_id),
          executor: optionalString(args.executor) ?? runtime.source.platform,
          projectId: skill.projectId,
          estimatedTokens: Math.max(1, Math.ceil(Buffer.byteLength(skill.body, "utf8") / 4))
        });
        return jsonResult({
          skill_id: skillId,
          execution_id: loaded.executionId,
          metadata: skillSelectionMetadataFromBody(skill.body, {
            projectId: skill.projectId,
            tags: skill.tags,
            title: skill.title,
            ...(before.executions > 0 ? { telemetryReliability: before.reliability } : {})
          }),
          content: skill.body,
          telemetry: before
        });
      }
      if (action === "record") {
        const stage = requiredString(args.stage, "stage") as SkillExecutionStage;
        if (!(["invoked", "success", "failure", "user_correction"] as const).includes(stage as never)) {
          throw new TypeError("stage must be invoked, success, failure, or user_correction");
        }
        const event = await recordSkillExecutionEvent({
          stateRoot,
          accountId: runtime.accountId,
          skillId,
          executionId: requiredString(args.execution_id, "execution_id"),
          stage: stage as Exclude<SkillExecutionStage, "selected" | "loaded">,
          executor: optionalString(args.executor) ?? runtime.source.platform,
          projectId: skill.projectId,
          note: optionalString(args.note)
        });
        return jsonResult({
          event,
          summary: await skillTelemetrySummary(stateRoot, runtime.accountId, skillId)
        });
      }
      throw new TypeError("action must be load, record, or status");
    }
  });
  return tools;
}
