import { toolName } from "../../brand.mjs";
import { jsonResult, type ToolDefinition } from "./shared.js";
import { mapBootstrapNext, mapBootstrapSubmit, type MapBootstrapDeps } from "../archify/map-bootstrap.js";
import { registerArchReview, aggregateArchReviews, type ArchReviewIndex } from "../../core/maintenance/arch-review.js";
import { readMaintenanceStore } from "../../maintenance-store.js";
import { readMemoryControlData } from "../../memory-control-plane.js";
import type { MemoryVisualizationPayload } from "../../contracts/project-map.js";
import { resolveExplicitProjectEvidence, resolveToolScope } from "../../context-router.js";
import { executeProjectMutation, planProjectMutation } from "../../project-governance.js";
import { listArchitectureRevisions } from "../../architecture-history.js";
import { executeArchitectureMutation, planArchitectureMutation } from "../../architecture-governance.js";
import type { ProjectGovernanceDeps } from "../../project-governance.js";
import type { ArchitectureGovernanceDeps } from "../../architecture-governance.js";
import type { ProjectWriter } from "../../core/ports/projects.js";
import type { ContextRouter } from "../../context-router.js";
import { requiredString, optionalString, knownProjectRecords, projectSummaryForModel, projectForModel, optionalInteger, optionalBoolean, type CatalogContext } from "./shared.js";
registerArchReview();

export interface ProjectsToolDeps {
  runtime: ProjectGovernanceDeps & ArchitectureGovernanceDeps & MapBootstrapDeps & { projects: Pick<ProjectWriter, "addTodo" | "setTodoStatus">; router: Pick<ContextRouter, "projectArchitecture"> };
  context: CatalogContext;
}

export function projectsTools(deps: ProjectsToolDeps): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  const { runtime, context: { stateRoot } } = deps;
  tools.push({
    name: toolName("project_list"),
    description: "只读列出当前账号项目注册表。默认返回摘要（description 最多 280 字符及 pendingTodoCount）；detail=true 返回完整详情。返回 canonical project slug、显示名、description、aliases 和状态。准备创建项目、绑定不确定项目或发现近似名称时，用相似度 + description 判断是否已有同一项目，禁止盲目新建。",
    inputSchema: {
      type: "object",
      properties: {
        detail: { type: "boolean", description: "是否返回完整项目详情；默认 false，仅返回摘要" },
        query: { type: "string", description: "可选项目名称/slug/关键词，用于查找相似项目候选" },
        include_archived: { type: "boolean", description: "是否显式包含 archived 项目；默认 false" },
        include_inactive: { type: "boolean", description: "是否包含 archived/merged/deleted 历史项目；默认 false" },
        limit: { type: "integer", minimum: 1, maximum: 20, description: "相似候选最大数量；默认 8" }
      },
      additionalProperties: false
    },
    run: async (args: Record<string, unknown>) => {
      await knownProjectRecords(runtime);
      const includeInactive = optionalBoolean(args.include_inactive) ?? false;
      const includeArchived = optionalBoolean(args.include_archived) ?? false;
      const projects = await runtime.projects.list(runtime.accountId, { includeInactive, includeArchived });
      const query = optionalString(args.query);
      const matches = query
        ? await runtime.projects.suggest(runtime.accountId, query, optionalInteger(args.limit) ?? 8, {
            includeArchived: includeInactive || includeArchived
          })
        : [];
      const format = optionalBoolean(args.detail) ? projectForModel : projectSummaryForModel;
      return jsonResult({
        projects: projects.map(format),
        matches: matches.map((project) => ({
          ...format(project),
          similarity: project.similarity,
          matchedBy: project.matchedBy
        })),
        instructions: "Prefer an existing canonical project when name/alias and description describe the same work. If still ambiguous, ask the user. Only create through litsan_project_manage after explicit authorization."
      });
    }
  });
  tools.push({
    name: toolName("todo"),
    description: "项目待办的一等 MCP 工具。使用 Project Registry 作为唯一事实源，支持 list/add/complete/reopen；禁止把待办写进 Project Architecture、项目 description 或 L2/L3。list 在未指定项目时列出所有 active project 待办；写操作必须显式提供 project 或 workspace_project。",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "add", "complete", "reopen"], description: "操作类型：list/add/complete/reopen" },
        project: { type: "string", description: "明确项目 slug/name/alias；与 workspace_project 冲突时拒绝" },
        workspace_project: { type: "string", description: "当前工作区解析出的 project；与 project 冲突时拒绝项目级操作" },
        text: { type: "string", description: "add 时必填的待办内容，最长 2000 字符" },
        todo_id: { type: "string", description: "complete/reopen 必填；add 可提供唯一 UUID 以安全重试" },
        status: { type: "string", enum: ["pending", "done", "all"], description: "list 过滤；默认 pending" }
      },
      required: ["action"],
      additionalProperties: false
    },
    run: async (args: Record<string, unknown>) => {
      const action = requiredString(args.action, "action");
      if (!["list", "add", "complete", "reopen"].includes(action)) throw new TypeError("unsupported todo action");
      await knownProjectRecords(runtime);

      if (action === "list" && !optionalString(args.project) && !optionalString(args.workspace_project)) {
        const status = optionalString(args.status) ?? "pending";
        if (!["pending", "done", "all"].includes(status)) throw new TypeError("todo list status must be pending, done, or all");
        const projects = await runtime.projects.list(runtime.accountId);
        const items = projects.map((project) => {
          const todos = (project.todos ?? []).filter((todo) => status === "all" || todo.status === status);
          return {
            project: project.projectId,
            name: project.name,
            todos,
            pending_count: (project.todos ?? []).filter((todo) => todo.status === "pending").length,
            done_count: (project.todos ?? []).filter((todo) => todo.status === "done").length
          };
        }).filter((project) => project.todos.length > 0 || status === "all");
        return jsonResult({
          scope: "account",
          status,
          projects: items,
          total: items.reduce((count, project) => count + project.todos.length, 0)
        });
      }

      const { projectId } = await resolveToolScope(runtime, {
        scope: "project",
        project: optionalString(args.project),
        workspaceProject: optionalString(args.workspace_project)
      });
      if (!projectId) throw new Error("todo operation requires a resolved project");

      if (action === "add") {
        const todoId = args.todo_id === undefined ? undefined : requiredString(args.todo_id, "todo_id").toLowerCase();
        const project = await runtime.projects.addTodo(runtime.accountId, projectId, requiredString(args.text, "text"), todoId);
        const todo = todoId ? (project.todos ?? []).find(item => item.id === todoId) : (project.todos ?? []).at(-1);
        return jsonResult({
          ok: true,
          action,
          project: project.projectId,
          todo,
          pending_count: (project.todos ?? []).filter((item) => item.status === "pending").length
        });
      }

      if (action === "complete" || action === "reopen") {
        const todoId = requiredString(args.todo_id, "todo_id");
        const project = await runtime.projects.setTodoStatus(
          runtime.accountId,
          projectId,
          todoId,
          action === "complete" ? "done" : "pending"
        );
        const todo = (project.todos ?? []).find((item) => item.id === todoId)
          ?? (project.todos ?? []).find((item) => item.id === todoId.toLowerCase());
        return jsonResult({
          ok: true,
          action,
          project: project.projectId,
          todo,
          pending_count: (project.todos ?? []).filter((item) => item.status === "pending").length
        });
      }

      const status = optionalString(args.status) ?? "pending";
      if (!["pending", "done", "all"].includes(status)) throw new TypeError("todo list status must be pending, done, or all");
      const project = (await runtime.projects.list(runtime.accountId)).find((item) => item.projectId === projectId);
      if (!project) throw new Error(`unknown or inactive project: ${projectId}`);
      const todos = (project.todos ?? []).filter((todo) => status === "all" || todo.status === status);
      return jsonResult({
        scope: "project",
        project: project.projectId,
        status,
        todos,
        total: todos.length,
        pending_count: (project.todos ?? []).filter((todo) => todo.status === "pending").length,
        done_count: (project.todos ?? []).filter((todo) => todo.status === "done").length
      });
    }
  });
  tools.push({
    name: toolName("project_manage"),
    description: "受控项目管理工具。支持 create/update/archive/unarchive/delete/merge。所有修改必须先 action=plan，返回一次性 authorization_id 和影响说明，不修改数据。模型必须把计划展示给用户，并在收到针对该计划的明确授权后才能 action=execute。禁止把 plan 本身、历史授权或模型推断当成授权。",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["plan", "execute"], description: "操作类型：plan/execute" },
        operation: { type: "string", enum: ["create", "update", "archive", "unarchive", "delete", "merge"], description: "操作：create/update/archive/unarchive/delete/merge" },
        project: { type: "string", description: "create 为新 canonical slug；其它为当前项目 ref" },
        target: { type: "string", description: "merge 的目标 canonical project ref" },
        name: { type: "string", description: "create/update 显示名；不改变稳定 canonical slug" },
        description: { type: "string", description: "create 必填；update 可修改。用于项目消歧" },
        aliases: { type: "array", items: { type: "string" }, description: "create/update 显式别名集合" },
        authorization_id: { type: "string", description: "execute 时必须提供刚才 plan 返回的一次性授权 ID" }
      },
      required: ["action"],
      additionalProperties: false
    },
    run: async (args: Record<string, unknown>) => {
      const action = requiredString(args.action, "action");
      if (action === "plan") {
        return jsonResult(await planProjectMutation({ stateRoot, runtime, args, projectForModel }));
      }
      if (action !== "execute") throw new TypeError("action must be plan or execute");
      return jsonResult(await executeProjectMutation({ stateRoot, runtime, args }));
    }
  });
  tools.push({
    name: toolName("project"),
    description: "项目上下文与 Project Architecture。Project 只由显式 project/workspace_project、exact alias 或唯一 semantic evidence 解析，不保存 host conversation binding。current 读当前项目；architecture 读架构；architecture_plan/execute 受控完整替换；architecture_history 读历史；list 读项目摘要；map_bootstrap_next/submit 引导首图或显式重建；map_quality 读内部确定性评分与独立评判分。",
    inputSchema: {
      type: "object",
      properties: {
        detail: { type: "boolean", description: "list 是否返回完整项目详情；默认 false，仅返回摘要" },
        action: { type: "string", enum: ["list", "current", "architecture", "architecture_plan", "architecture_execute", "architecture_history", "map_bootstrap_next", "map_bootstrap_submit", "map_quality"], description: "操作类型：list/current/architecture(_plan/_execute/_history)/map_bootstrap_next/map_bootstrap_submit/map_quality" },
        project: { type: "string", description: "明确项目 slug/alias；与 workspace_project 冲突时拒绝" },
        workspace_project: { type: "string", description: "当前工作区解析出的 project；与 project 冲突时拒绝操作" },
        query: { type: "string", description: "architecture 时用于选择最相关架构模块" },
        content: { type: "string", description: "architecture_plan：完整最终 canonical Architecture 正文，非 patch 片段" },
        authorization_id: { type: "string", description: "architecture_execute：用户批准对应 plan 后使用的一次性 authorization id" },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "architecture_history 返回条数，默认 20" },
        rebuild: { type: "boolean", description: "map_bootstrap_next/submit: explicitly rebuild an existing derived map / 显式重建" },
        base_fingerprint: { type: "string", description: "map_bootstrap_submit: fingerprint returned by next / 首图或重建的写入围栏" },
        architecture_map: { type: "object", description: "map_bootstrap_submit: complete candidate matching next.answer_schema / 完整认知地图候选" },
        dry_run: { type: "boolean", description: "map_bootstrap_submit: validate without writing map or audit / 仅校验" },
        source_harness: { type: "string", description: "map_bootstrap_submit: submitting harness / 来源 Harness" },
        model: { type: "string", description: "map_bootstrap_submit: model provenance / 模型来源" }
      },
      required: ["action"],
      additionalProperties: false
    },
    run: async (args: Record<string, unknown>) => {
      const action = requiredString(args.action, "action");
      if (action === "list") {
        const details = await knownProjectRecords(runtime);
        return jsonResult({ projects: details.map((project) => project.projectId), projectDetails: details.map(optionalBoolean(args.detail) ? projectForModel : projectSummaryForModel) });
      }
      if (action === "current") {
        await knownProjectRecords(runtime);
        const explicitEvidence = await resolveExplicitProjectEvidence(runtime, {
          project: optionalString(args.project),
          workspaceProject: optionalString(args.workspace_project)
        });
        if (explicitEvidence.projectId) {
          return jsonResult({
            project: explicitEvidence.projectId,
            resolution_source: explicitEvidence.resolutionSource,
            persisted: false
          });
        }
        return jsonResult({
          project: null,
          resolution_source: "no_current_turn_project",
          persisted: false,
          note: "Pass project or workspace_project from the current turn; host conversation identity is not project state."
        });
      }
      if (action === "map_quality") {
        const explicit = await resolveExplicitProjectEvidence(runtime, {
          project: optionalString(args.project), workspaceProject: optionalString(args.workspace_project)
        });
        if (!explicit.projectId) throw new TypeError("map_quality requires project or workspace_project");
        const [visual, store, current] = await Promise.all([
          readMemoryControlData({ stateRoot, runtime, kind: "visualization", includeArchitectureDocs: true, projectId: explicit.projectId, projects: await knownProjectRecords(runtime) }),
          readMaintenanceStore(stateRoot, runtime.accountId),
          runtime.architecture.inspectProjectCognitiveMap({ accountId: runtime.accountId, projectId: explicit.projectId })
        ]);
        const index = store.artifacts?.[JSON.stringify([explicit.projectId, "arch_review:index"])] as ArchReviewIndex | undefined;
        return jsonResult({ quality: (visual as MemoryVisualizationPayload).quality,
          judged: index && current.map ? aggregateArchReviews(index, current.map) : null });
      }
      if (action === "map_bootstrap_next" || action === "map_bootstrap_submit") {
        const explicitEvidence = await resolveExplicitProjectEvidence(runtime, {
          project: optionalString(args.project), workspaceProject: optionalString(args.workspace_project)
        });
        if (!explicitEvidence.projectId) throw new TypeError(`${action} requires project or workspace_project`);
        const input = { stateRoot, projectId: explicitEvidence.projectId, rebuild: optionalBoolean(args.rebuild) };
        return jsonResult(action === "map_bootstrap_next"
          ? await mapBootstrapNext(runtime, input)
          : await mapBootstrapSubmit(runtime, { ...input, base_fingerprint: requiredString(args.base_fingerprint, "base_fingerprint"),
              architecture_map: args.architecture_map, dry_run: optionalBoolean(args.dry_run),
              source_harness: optionalString(args.source_harness), model: optionalString(args.model) }));
      }
      if (action === "architecture") {
        const explicitEvidence = await resolveExplicitProjectEvidence(runtime, {
          project: optionalString(args.project),
          workspaceProject: optionalString(args.workspace_project)
        });
        if (!explicitEvidence.projectId) throw new TypeError("architecture requires project or workspace_project");
        const canonical = explicitEvidence.projectId;
        const query = optionalString(args.query) ?? "project architecture, ownership, dependencies and current constraints";
        return jsonResult({
          project: canonical,
          architecture: await runtime.router.projectArchitecture(runtime.accountId, canonical, query)
        });
      }
      if (action === "architecture_history") {
        const explicitEvidence = await resolveExplicitProjectEvidence(runtime, {
          project: optionalString(args.project),
          workspaceProject: optionalString(args.workspace_project)
        });
        if (!explicitEvidence.projectId) throw new TypeError("architecture_history requires project or workspace_project");
        return jsonResult({
          project: explicitEvidence.projectId,
          revisions: await listArchitectureRevisions({
            stateRoot,
            accountId: runtime.accountId,
            projectId: explicitEvidence.projectId,
            limit: optionalInteger(args.limit) ?? 20
          }),
          rollback: "To roll back, take the desired revision's before_content/proposed_content, create a fresh architecture_plan with that complete text, show it to the user, then execute only after approval."
        });
      }
      if (action === "architecture_plan") {
        return jsonResult(await planArchitectureMutation({ runtime, args, resolveExplicitProjectEvidence }));
      }
      if (action === "architecture_execute") {
        return jsonResult(await executeArchitectureMutation({ stateRoot, runtime, args, resolveExplicitProjectEvidence }));
      }
      throw new TypeError(`unsupported litsan_project action: ${action}`);
    }
  });
  return tools;
}
