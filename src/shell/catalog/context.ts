import { toolName } from "../../brand.mjs";
import { jsonResult, type ToolDefinition } from "./shared.js";
import { maintenanceWaiting } from "../../maintenance-control.js";
import { branchDraftContext } from "../../workstream-retrieval.js";
import { WORKSTREAM_SCHEMA } from "./shared.js";
import { randomUUID } from "node:crypto";
import { attachExactEvidenceRefsToContext, hydrateMemoryEvidence } from "../../memory-hydration.js";
import { relevantProjectTodos } from "../../context-router.js";
import { utf8Prefix, compactContextMetadata } from "../../context-capsule.js";
import { projectClarification } from "../../capture-project-assignments.js";
import { resolveCaptureProject } from "../../capture-project-resolution.js";
import { skillTelemetrySummary } from "../../skill-telemetry.js";
import { enrichSkillCandidateReliability } from "../../skill-router.js";
import { buildTurnKnowledgePlan } from "../../turn-knowledge-plan.js";
import { recordRetrievalDecisionTrace } from "../../retrieval-trace.js";
import type { ContextRouter, ContextRouterDeps } from "../../context-router.js";
import type { MemoryHydrationDeps } from "../../memory-hydration.js";
import type { UserId } from "../../contracts/identity.js";
import { requiredString, optionalString, stringArray, uniqueStrings, knownProjectRecords, optionalInteger, optionalBoolean, type CatalogContext } from "./shared.js";

export interface ContextToolDeps {
  runtime: ContextRouterDeps & MemoryHydrationDeps & { userId: UserId; router: Pick<ContextRouter, "context"> };
  context: CatalogContext;
}

export function contextTools(deps: ContextToolDeps): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  const { runtime, context: { stateRoot } } = deps;
  tools.push({
    name: toolName("context"),
    description: "读取相关记忆后，普通用户回合调用 litsan_turn open 和 commit；quiet 模式可在该回合处理一张独立维护卡。conversation_id 不参与项目选择；不猜测项目，project/workspace 冲突时拒绝，透传 evidenceRef；出现 clarification 时询问用户后调用 litsan_turn action=assign。 / For a relevant user turn, follow with litsan_turn open and commit; quiet mode can provide one separate bounded maintenance card.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "当前用户请求或需要补充上下文的问题" },
        detail: { type: "string", enum: ["brief", "full"], description: "输出模式：brief（默认，精简瘦身）或 full（完整模式）" },
        max_content_bytes: { type: "integer", minimum: 2000, maximum: 512000, description: "总内容字节预算上限，范围 2000-512000" },
        conversation_id: { type: "string", description: "可选 transport provenance；不参与项目选择" },
        continuity_id: { type: "string", description: "Explicit continuity key; user-assigned bindings may select the project" },
        project: { type: "string", description: "明确项目 slug；禁止盲目猜测项目" },
        workspace_project: { type: "string", description: "由工作区/仓库确定的项目 slug；与 project 冲突时拒绝" },
        workstream: WORKSTREAM_SCHEMA,
        branch: { type: "string", description: "可选项目内 Branch id/name；仅收窄任务 retrieval，不建立新记忆层" },
        semantic_projects: {
          type: "array",
          items: { type: "string" },
          description: "语义项目候选列表；非唯一时保持 global-only"
        },
        capability_projects: {
          type: "array",
          items: { type: "string" },
          description: "可复用 Skill 检索候选项目列表；默认检索已知项目"
        },
        cross_project_skills: {
          type: "boolean",
          description: "是否启用跨项目可复用 Skill 召回；默认 true"
        },
        limit: { type: "integer", minimum: 1, maximum: 50, description: "每类记忆最大召回条数" }
      },
      required: ["query"],
      additionalProperties: false
    },
    run: async (args: Record<string, unknown>) => {
      const query = requiredString(args.query, "query");
      const detail = args.detail === "full" ? "full" : "brief";
      const maxContentBytes = optionalInteger(args.max_content_bytes);
      const projectRecords = await knownProjectRecords(runtime);
      const knownProjects = projectRecords.map((project) => project.projectId);
      const requestedCapabilityProjects = stringArray(args.capability_projects) ?? [];
      const crossProjectSkills = optionalBoolean(args.cross_project_skills) ?? true;
      const continuityResolution = !optionalString(args.project) && !optionalString(args.workspace_project) && optionalString(args.continuity_id)
        ? await resolveCaptureProject({ account_id: runtime.accountId, event_id: `context:${randomUUID()}`,
            continuity_id: optionalString(args.continuity_id), timestamp: new Date().toISOString() },
            ref => runtime.projects.resolve(runtime.accountId, ref), stateRoot) : undefined;
      const capsule = await runtime.router.context({
        accountId: runtime.accountId,
        userId: runtime.userId,
        query,
        conversationId: optionalString(args.conversation_id),
        continuityId: optionalString(args.continuity_id),
        projectId: optionalString(args.project) ?? continuityResolution?.projectId ?? undefined,
        workspaceProjectId: optionalString(args.workspace_project),
        branchId: optionalString(args.branch),
        workstream: args.workstream,
        semanticProjectIds: stringArray(args.semantic_projects),
        knownProjectIds: knownProjects,
        reusableSkillProjectIds: crossProjectSkills
          ? (requestedCapabilityProjects.length > 0 ? requestedCapabilityProjects : knownProjects)
          : [],
        limit: optionalInteger(args.limit),
        detail,
        maxContentBytes
      });
      await attachExactEvidenceRefsToContext(stateRoot, runtime, capsule);
      for (const item of [...capsule.globalMemory, ...capsule.globalState, ...capsule.projectMemory]) {
        if (!item.evidenceRef) continue;
        item.provenance = {
          ...(item.provenance ?? {}),
          hydration: {
            contract: "progressive-disclosure-v1",
            tool: "litsan_memory",
            action: "load",
            evidence_ref: item.evidenceRef
          }
        };
      }
      if (capsule.reusableSkills.length > 0) {
        capsule.reusableSkills = await Promise.all(capsule.reusableSkills.map(async (item) => {
          const summary = await skillTelemetrySummary(stateRoot, runtime.accountId, item.id);
          return summary.executions > 0
            ? enrichSkillCandidateReliability(item, summary.reliability)
            : item;
        }));
      }
      const turnKnowledgePlan = await buildTurnKnowledgePlan({
        query,
        capsule,
        detail,
        dedupe: true,
        hydrateEvidence: async (evidenceRef) => {
          const item = await hydrateMemoryEvidence({ stateRoot, accountId: runtime.accountId, evidenceRef, projects: runtime.projects });
          return {
            content: item.content,
            ...(item.fact_metadata ? { factMetadata: item.fact_metadata } : {})
          };
        }
      });
      let retrievalTrace: Record<string, unknown>;
      try {
        retrievalTrace = await recordRetrievalDecisionTrace({
          stateRoot,
          accountId: runtime.accountId,
          query,
          capsule,
          plan: turnKnowledgePlan
        }) as unknown as Record<string, unknown>;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("[litsan] retrieval trace:", message);
        retrievalTrace = {
          version: "retrieval-decision-trace-v1",
          stored: false,
          error: message,
          query_stored: false
        };
      }

      const isExplicitlyResolved = capsule.resolvedProjectId !== null &&
        capsule.recallScope === "global_and_project" &&
        (capsule.resolutionSource === "deterministic_binding" || capsule.resolutionSource === "exact_alias");

      const relevantTodoQuery = capsule.branchContext
        ? `${query}\n${capsule.branchContext.name}\n${capsule.branchContext.goal}`
        : query;

      let finalProjectCandidates: unknown[];
      if (detail !== "full" && isExplicitlyResolved) {
        const resolvedProject = projectRecords.find((p) => p.projectId === capsule.resolvedProjectId);
        if (resolvedProject) {
          const descBytes = Buffer.byteLength(resolvedProject.description, "utf8");
          const description = descBytes <= 240
            ? resolvedProject.description
            : utf8Prefix(resolvedProject.description, 240);
          const relevantTodos = relevantProjectTodos(resolvedProject.todos, relevantTodoQuery, 5, 200);
          finalProjectCandidates = [{
            project: resolvedProject.projectId,
            name: resolvedProject.name,
            description,
            relevantTodos
          }];
        } else {
          finalProjectCandidates = [];
        }
      } else {
        const candidateQuery = optionalString(args.project) ?? optionalString(args.workspace_project) ?? query;
        const candidates = capsule.resolvedProjectId === null || optionalString(args.project) || optionalString(args.workspace_project)
          ? await runtime.projects.suggest(runtime.accountId, candidateQuery, 8)
          : [];
        finalProjectCandidates = candidates.map((project) => ({
          project: project.projectId,
          name: project.name,
          description: project.description,
          aliases: project.aliases,
          similarity: project.similarity,
          matchedBy: project.matchedBy,
          descriptionMissing: !project.description,
          ...(project.projectId === capsule.resolvedProjectId
            ? { relevantTodos: relevantProjectTodos(project.todos, relevantTodoQuery, 1) }
            : {})
        }));
      }

      let finalDiagnostics = capsule.retrievalDiagnostics;
      if (detail !== "full" && capsule.retrievalDiagnostics) {
        const diag = capsule.retrievalDiagnostics;
        const combinedQueryTerms = uniqueStrings([
          ...diag.lanes.global.queryTerms,
          ...diag.lanes.globalState.queryTerms,
          ...diag.lanes.project.queryTerms,
          ...diag.lanes.skills.queryTerms
        ]) ?? [];
        finalDiagnostics = {
          version: diag.version,
          requestedLimit: diag.requestedLimit,
          finalLimit: diag.finalLimit,
          candidateLimit: diag.candidateLimit,
          queryTerms: combinedQueryTerms,
          weights: {
            semanticWeight: diag.lanes.project.semanticWeight,
            lexicalWeight: diag.lanes.project.lexicalWeight,
            diversityPenalty: diag.lanes.project.diversityPenalty
          },
          lanes: {
            global: {
              candidateCount: diag.lanes.global.candidateCount,
              dedupedCount: diag.lanes.global.dedupedCount,
              emittedCount: diag.lanes.global.emittedCount
            },
            globalState: {
              candidateCount: diag.lanes.globalState.candidateCount,
              dedupedCount: diag.lanes.globalState.dedupedCount,
              emittedCount: diag.lanes.globalState.emittedCount
            },
            project: {
              candidateCount: diag.lanes.project.candidateCount,
              dedupedCount: diag.lanes.project.dedupedCount,
              emittedCount: diag.lanes.project.emittedCount
            },
            skills: {
              candidateCount: diag.lanes.skills.candidateCount,
              dedupedCount: diag.lanes.skills.dedupedCount,
              emittedCount: diag.lanes.skills.emittedCount
            }
          },
          ...(diag.coreStatus ? { coreStatus: diag.coreStatus } : {})
        } as unknown as typeof capsule.retrievalDiagnostics;
      }

      if (detail !== "full") compactContextMetadata(capsule);

      const {
        contextBudgetTrace: _contextBudgetTrace,
        retrievalScope: internalRetrievalScope,
        ...publicCapsule
      } = capsule;
      const responsePayload: Record<string, unknown> = {
        ...publicCapsule,
        ...(finalDiagnostics ? { retrievalDiagnostics: finalDiagnostics } : {}),
        retrievalTrace,
        turnKnowledgePlan,
        projectCandidates: finalProjectCandidates
      };
      if (capsule.branchContext && capsule.resolvedProjectId) {
        const draft = await branchDraftContext(stateRoot, runtime.accountId, capsule.resolvedProjectId, capsule.branchContext.branchId);
        if (draft) responsePayload.branchDraft = draft;
      }
      if (detail === "full" && internalRetrievalScope) responsePayload.retrievalScope = internalRetrievalScope;
      if (capsule.resolvedProjectId === null && continuityResolution?.source !== "keep_global") {
        const clarification = await projectClarification({ stateRoot, accountId: runtime.accountId,
          projects: runtime.projects, text: query, continuityId: optionalString(args.continuity_id),
          rateLimit: Boolean(optionalString(args.continuity_id)) });
        if (clarification) responsePayload.clarification = clarification;
      }

      if (detail === "full") {
        responsePayload.progressiveDisclosure = {
          version: "progressive-disclosure-v1",
          discover: "litsan_context",
          contextualize: "litsan_memory action=load evidence_ref=<exact-ref>",
          hydrateSkill: "litsan_skill action=load skill_id=<skill-id>",
          rule: "Load full content only for the selected exact revision or Skill; do not eagerly hydrate all recalled items."
        };
      }

      const waiting = await maintenanceWaiting({ stateRoot, runtime, projectId: capsule.resolvedProjectId });
      if (waiting) responsePayload.maintenance_waiting = waiting;
      return jsonResult(responsePayload, detail === "full");
    }
  });
  return tools;
}
