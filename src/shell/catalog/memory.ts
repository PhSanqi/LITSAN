import { toolName } from "../../brand.mjs";
import { jsonResult, type ToolDefinition } from "./shared.js";
import { explainMemoryWhy, hydrateMemoryEvidence, recordMemoryHydration } from "../../memory-hydration.js";
import { resolveToolScope, resolveExplicitProjectEvidence } from "../../context-router.js";
import { explainRetrievalDecisionTrace } from "../../retrieval-trace.js";
import { executeUserAuthorizedMemory, planUserAuthorizedMemory } from "../../user-authorized-memory.js";
import type { ContextRouterDeps } from "../../context-router.js";
import type { UserAuthorizedMemoryDeps } from "../../user-authorized-memory.js";
import { requiredString, optionalString, optionalInteger, type CatalogContext } from "./shared.js";
import { parseWorkstreamHint, WORKSTREAM_SCHEMA } from "./shared.js";
import { deriveWorkstreamKey } from "../../core/workstream/binding.js";
import { isWorkstreamEnabled } from "../../workstream-config.js";
import type { JsonProjectBranchStore, ProjectBranch } from "../../branch-store.js";

export interface MemoryToolDeps {
  runtime: UserAuthorizedMemoryDeps & ContextRouterDeps & {
    branches?: Pick<JsonProjectBranchStore, "resolve" | "findActiveByKey">;
  };
  context: CatalogContext;
}

export function memoryTools(deps: MemoryToolDeps): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  const { runtime, context: { stateRoot } } = deps;
  tools.push({
    name: toolName("memory"),
    description: "Progressive-disclosure 记忆读取、Retrieval Trace 解释与 L3/L4 治理。action=load 支持 L1/L2/L3/L4 与 Global State exact evidenceRef；action=why 查看证据链；action=retrieval_explain 解释某条 exact evidence 在指定 retrieval trace 中是否进入候选、何处被裁切；action=plan/execute 管理用户明确授权的 L3/L4 替换。",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["load", "why", "retrieval_explain", "plan", "execute"], description: "操作类型：load/why/retrieval_explain/plan/execute" },
        evidence_ref: { type: "string", description: "load/why: litsan_context 返回的 exact evidenceRef" },
        trace_id: { type: "string", description: "retrieval_explain: litsan_context 返回的 retrievalTrace.trace_id" },
        query: { type: "string", description: "why: 待审查因果或决策背景的具体问题" },
        max_sources: { type: "integer", minimum: 1, maximum: 8, description: "why: 每节最大证据数；默认 4" },
        kind: { type: "string", enum: ["l3", "l4"], description: "plan: 记忆层级，l3 为项目经验，l4 为全局规则" },
        content: { type: "string", description: "plan: 完整的 L3/L4 正文全文，非增量 patch" },
        base_evidence_ref: { type: "string", description: "plan: 当前层级 exact evidenceRef" },
        project: { type: "string", description: "L3 plan: 明确项目 slug；与 workspace_project 冲突时拒绝" },
        workspace_project: { type: "string", description: "L3 plan: 工作区项目；与 project 冲突时拒绝" },
        branch: { type: "string", description: "Explicit active project branch id/name" },
        workstream: WORKSTREAM_SCHEMA,
        note: { type: "string", description: "plan: 变更原因简述" },
        authorization_id: { type: "string", description: "execute: plan 返回的单次授权标识" },
        confirmation_evidence_ref: { type: "string", description: "execute: 用户明确确认轮的 l1:<event-id>" }
      },
      required: ["action"],
      additionalProperties: false
    },
    run: async (args: Record<string, unknown>) => {
      const action = requiredString(args.action, "action");
      if ((action === "plan" || action === "execute") && (optionalString(args.branch) || args.workstream !== undefined)) {
        const projectEvidence = await resolveExplicitProjectEvidence(runtime, {
          project: optionalString(args.project),
          workspaceProject: optionalString(args.workspace_project)
        });
        const targetProjectId = projectEvidence.projectId ?? undefined;
        if (targetProjectId && runtime.branches && await isWorkstreamEnabled(stateRoot, runtime.accountId, targetProjectId)) {
          const branchArg = optionalString(args.branch);
          let activeBranch: ProjectBranch | null = null;
          if (branchArg && branchArg !== "main") {
            const resolved = await runtime.branches.resolve(runtime.accountId, targetProjectId, branchArg);
            if (resolved && resolved.status === "active" && resolved.branchId !== "main" && resolved.name !== "main") {
              activeBranch = resolved;
            }
          }
          if (!activeBranch && branchArg !== "main") {
            const hint = parseWorkstreamHint(args.workstream);
            if (hint) {
              const derived = deriveWorkstreamKey(hint);
              if (derived.key) {
                const found = await runtime.branches.findActiveByKey(runtime.accountId, targetProjectId, derived.key);
                if (found && found.status === "active" && found.branchId !== "main" && found.name !== "main") {
                  activeBranch = found;
                }
              }
            }
          }
          if (activeBranch) {
            return jsonResult({
              ok: false,
              error: "branch_not_main",
              branch: { id: activeBranch.branchId, name: activeBranch.name },
              message_en: "L3/L4 can be edited only from main; close or merge the branch first",
              message_zh: "只能从 main 修改 L3/L4，请先关闭或合并分支"
            });
          }
        }
      }
      if (action === "load") {
        const item = await hydrateMemoryEvidence({
          stateRoot,
          accountId: runtime.accountId,
          projects: runtime.projects,
          evidenceRef: requiredString(args.evidence_ref, "evidence_ref")
        });
        const telemetry = await recordMemoryHydration({ stateRoot, accountId: runtime.accountId, item });
        return jsonResult({
          item,
          telemetry,
          progressive_disclosure: {
            hydrated: true,
            estimated_tokens: item.estimated_tokens,
            source_of_truth: item.revision_id ? "distillation-revision-ledger" : "durable-l1-capture"
          }
        });
      }
      if (action === "why") {
        return jsonResult(await explainMemoryWhy({
          stateRoot,
          accountId: runtime.accountId,
          evidenceRef: requiredString(args.evidence_ref, "evidence_ref"),
          query: requiredString(args.query, "query"),
          maxSources: optionalInteger(args.max_sources)
        }));
      }
      if (action === "retrieval_explain") {
        const evidenceRef = requiredString(args.evidence_ref, "evidence_ref");
        const item = await hydrateMemoryEvidence({
          stateRoot,
          accountId: runtime.accountId,
          projects: runtime.projects,
          evidenceRef
        });
        return jsonResult(await explainRetrievalDecisionTrace({
          stateRoot,
          accountId: runtime.accountId,
          traceId: requiredString(args.trace_id, "trace_id"),
          target: {
            evidence_ref: item.evidence_ref,
            memory_id: item.memory_id,
            layer: item.layer,
            project_id: item.project_id
          }
        }));
      }
      if (action === "plan") {
        const kind = requiredString(args.kind, "kind");
        if (kind !== "l3" && kind !== "l4") throw new TypeError("kind must be l3 or l4");
        let projectId: string | null = null;
        if (kind === "l3") {
          projectId = (await resolveToolScope(runtime, {
            scope: "project",
            project: optionalString(args.project),
            workspaceProject: optionalString(args.workspace_project)
          })).projectId;
          if (!projectId) throw new Error("L3 plan requires a resolved project");
        }
        return jsonResult(await planUserAuthorizedMemory({
          stateRoot,
          runtime,
          kind,
          projectId,
          content: requiredString(args.content, "content"),
          baseEvidenceRef: optionalString(args.base_evidence_ref),
          note: optionalString(args.note)
        }));
      }
      if (action === "execute") {
        return jsonResult(await executeUserAuthorizedMemory({
          stateRoot,
          runtime,
          authorizationId: requiredString(args.authorization_id, "authorization_id"),
          confirmationEvidenceRef: requiredString(args.confirmation_evidence_ref, "confirmation_evidence_ref")
        }));
      }
      throw new TypeError("action must be load, why, retrieval_explain, plan, or execute");
    }
  });
  return tools;
}
