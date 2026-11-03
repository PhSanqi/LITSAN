import { toolName } from "../../brand.mjs";
import { jsonResult, type ToolDefinition } from "./shared.js";
import { ARCHITECTURE_NODE_KINDS } from "../../core/architecture/node-kinds.js";
import { JsonProjectBranchStore } from "../../branch-store.js";
import { join } from "node:path";
import { L2_ANSWER_SCHEMA } from "../../core/maintenance/answers.js";
import { resolveToolScope } from "../../context-router.js";
import { auditDistillationControl, discoverDistillationControl, nextDistillationControl, recoverDistillationControl, renewDistillationControl, skipDistillationControl } from "../../distillation-control.js";
import { validateDistillationEvidenceChain } from "../../distillation-evidence.js";
import { distillationContract } from "../../distillation-contract.js";
import { distillationNextPayload } from "../../distillation-transport.js";
import { submitDistillationControl } from "../../distillation-submit.js";
import { reconcileCompletedL2DerivedJob, reconcileCurrentL4DerivedJob } from "../../distillation-derived-recovery.js";
import { planDistillationConsolidation } from "../../distillation-consolidation.js";
import { restructureL2Control } from "../../distillation-restructure.js";
import { architectureCognitiveMapFingerprint } from "../../architecture-cognitive-map.js";
import type { DistillationControlDeps } from "../../distillation-control.js";
import type { DistillationSubmitDeps } from "../../distillation-submit.js";
import type { ArchitectureReader } from "../../core/ports/architecture.js";
import { requiredString, optionalString, optionalInteger, type CatalogContext } from "./shared.js";

export interface DistillToolDeps {
  runtime: DistillationControlDeps & DistillationSubmitDeps & { architecture: Pick<ArchitectureReader, "getProjectArchitecture">; branches?: JsonProjectBranchStore };
  context: CatalogContext;
}

export function distillTools(deps: DistillToolDeps): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  const { runtime, context: { stateRoot } } = deps;
  tools.push({
    name: toolName("distill"),
    description: "统一的 L2/L3/L4/Global State/Skill 蒸馏入口。L2=项目时间线；L3=项目规则/经验；L4=跨项目稳定画像；Global State=显式 keep_global L1 派生的账号级状态 sidecar，不属于 L1-L4；Skill=可执行流程。语义整理由当前 Harness 完成，LITSAN 负责证据边界、scope、版本与提交。",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["audit", "discover", "consolidate", "recover_ingest", "reconcile_derived", "reconcile_l4", "reconcile_commit", "next", "renew", "submit", "skip", "restructure_l2"], description: "audit 审计；discover 扫描；consolidate 整理计划；recover/reconcile 处理缺口；next/renew/submit/skip 蒸馏；restructure_l2 创建需操作员确认的 L2 重组任务" },
        event_id: { type: "string", description: "recover_ingest 必填的完整稳定 Capture event_id，仅恢复此事件" },
        kind: { type: "string", enum: ["l2", "l3", "l4", "global_state", "skill"], description: "目标产物；Global State 必须 account scope 且只能来自显式 keep_global L1 job" },
        content: { type: "string", description: "完整目标层内容" },
        events: { ...((L2_ANSWER_SCHEMA.properties as Record<string, unknown>).events as object), maxItems: 12, description: "Branch L2 only: new durable bilingual dated events; evidence_refs must belong to the job" },
        scope: { type: "string", enum: ["account", "project"], description: "L2/L3 必须 project；L4/Global State 必须 account；Skill 可两者" },
        project: { type: "string", description: "project scope 的明确项目 slug" },
        workspace_project: { type: "string", description: "当前工作区解析出的 project；与 project 不一致时拒绝项目级操作" },
        title: { type: "string", description: "可选标题；Skill 必填" },
        tags: { type: "array", items: { type: "string" }, description: "业务检索标签" },
        source_harness: { type: "string", description: "产生该沉淀的 Harness，例如 codex / claude-code" },
        artifact_id: { type: "string", description: "覆盖默认 canonical artifact id；Skill 必填且同一 workflow 保持稳定" },
        version: { type: "string", description: "Harness 侧产物版本；Skill 必填 numeric dotted 版本，例如 1.1.0" },
        project_description: { type: "string", description: "L2 可附带 1-3 句项目描述，概括目标范围；人工描述存在时不覆盖" },
        architecture_map_base_fingerprint: { type: "string", description: "L2 architecture_map 完整替换的 revision fence；action=next 的 architecture_context.fingerprint 原样回传" },
        architecture_map: {
          type: "object",
          description: "L2 可选架构认知地图完整候选（派生，非 L1-L4）；截止 mechanism，可不等深；参数写 facts；分层须带 layer_evidence_refs。",
          properties: {
            summary: { type: "string" },
            facet_vocab: { type: "object", additionalProperties: false, properties: { layer: { type: "array", minItems: 1, maxItems: 12, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 40 } } } },
            nodes: {
              type: "array", minItems: 1, maxItems: 300,
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  kind: { type: "string", enum: ARCHITECTURE_NODE_KINDS },
                  label: { type: "string" },
                  summary: { type: "string" },
                  parent_id: { type: ["string", "null"] },
                  order: { type: "integer", minimum: 0 },
                  evidence_refs: { type: "array", minItems: 1, items: { type: "string" } },
                  confidence: { type: "number", minimum: 0, maximum: 1 },
                  facts: { type: "array", maxItems: 12, items: { type: "object", additionalProperties: false, required: ["key", "value", "evidence_refs", "confidence"], properties: {
                    key: { type: "string", minLength: 1, maxLength: 60 },
                    value: { anyOf: [{ type: "string", minLength: 1, maxLength: 120 }, { type: "number" }] },
                    unit: { type: "string", minLength: 1, maxLength: 20 },
                    evidence_refs: { type: "array", minItems: 1, maxItems: 40, items: { type: "string", minLength: 1, maxLength: 1000 } },
                    confidence: { type: "number", minimum: 0, maximum: 1 }
                  } } },
                  facets: { type: "object", additionalProperties: false, properties: { layer: { type: "string", minLength: 1, maxLength: 40 }, layer_evidence_refs: { type: "array", minItems: 1, maxItems: 40, items: { type: "string", minLength: 1, maxLength: 1000 } } } }
                },
                required: ["id", "kind", "label", "summary", "parent_id", "evidence_refs", "confidence"],
                additionalProperties: false
              }
            },
            edges: {
              type: "array", maxItems: 800,
              items: {
                type: "object",
                properties: {
                  from: { type: "string" }, to: { type: "string" },
                  type: { type: "string", enum: ["contains", "flows_to", "depends_on", "uses", "constrained_by"] },
                  evidence_refs: { type: "array", minItems: 1, items: { type: "string" } },
                  confidence: { type: "number", minimum: 0, maximum: 1 }
                },
                required: ["from", "to", "type", "evidence_refs", "confidence"],
                additionalProperties: false
              }
            },
            timeline_links: {
              type: "array", maxItems: 500,
              items: {
                type: "object",
                properties: {
                  event_date: { type: "string" }, event_title: { type: "string" },
                  architecture_refs: { type: "array", minItems: 1, items: { type: "string" } },
                  architecture_level: { type: "string", enum: ARCHITECTURE_NODE_KINDS },
                  change_kind: { type: "string", enum: ["add", "refine", "replace", "remove", "reroute"] },
                  evidence_refs: { type: "array", minItems: 1, items: { type: "string" } },
                  confidence: { type: "number", minimum: 0, maximum: 1 }
                },
                required: ["event_date", "event_title", "architecture_refs", "architecture_level", "change_kind", "evidence_refs", "confidence"],
                additionalProperties: false
              }
            }
          },
          required: ["nodes", "edges", "timeline_links"],
          additionalProperties: false
        },
        evidence_refs: { type: "array", items: { type: "string" }, description: "支持产物的精确证据引用。L2 用 L1 ref；L3/L4 须原样使用 exact revision ref" },
        source_conversations: { type: "array", items: { type: "string" }, description: "产物来源对话 ID；与 distilled_by 分开保存" },
        confidence: { type: "number", minimum: 0, maximum: 1, description: "置信度，范围 0-1" },
        claim_traces: {
          type: "array",
          maxItems: 200,
          description: "可选 claim-level 可审计判断；只保存 evidence/transition/简短 reason，不保存自由 CoT。source_evidence_refs 必须属于本次已验证 evidence_refs。",
          items: {
            type: "object",
            properties: {
              claim_id: { type: "string" },
              claim_key: { type: "string" },
              action: { type: "string", enum: ["new", "reinforce", "supersede", "refute", "append_history", "omit", "uncertain"] },
              source_evidence_refs: { type: "array", items: { type: "string" }, minItems: 1 },
              source_spans: { type: "array", items: { type: "string" } },
              previous_claim: { type: "string" },
              new_claim: { type: "string" },
              model_confidence: { type: "number", minimum: 0, maximum: 1 },
              validation_result: { type: "string" },
              repair_count: { type: "integer", minimum: 0 },
              reason: { type: "string" }
            },
            required: ["claim_id", "action", "source_evidence_refs"],
            additionalProperties: false
          }
        },
        job_id: { type: "string", description: "submit/next 的 leased job，或 reconcile 的 source job" },
        lease_seconds: { type: "integer", minimum: 30, maximum: 900, description: "租约秒数，30-900" },
        lease_token_supported: { type: "boolean", description: "新客户端启用 opaque lease token 协议" },
        lease_token: { type: "string", description: "next 返回的 opaque lease token；后续操作须原样提供" },
        evidence_offset: { type: "integer", minimum: 0, description: "大 evidence job 分片读取偏移" },
        evidence_chunk_chars: { type: "integer", minimum: 10000, maximum: 200000, description: "大 evidence 每次最多返回字符数；默认 120000" },
        commit_id: { type: "string", description: "reconcile_commit: inspect 返回的提交 ID；省略时列出本账户记录" },
        reconcile_mode: { type: "string", enum: ["inspect", "reconcile", "abandon"], description: "inspect 查看冻结候选；reconcile 只对账不重写 Core；abandon 须操作员确认" },
        commit_generation: { type: "string", description: "对账或放弃时必须回传 inspect 的 generation" },
        operator_confirmation: { type: "string", description: "操作员确认 abandon:<generation>，或 L2 重组时 restructure:<base_ref>" },
        operator_reason: { type: "string", description: "放弃冻结提交的操作员原因；原记录保留到正常终态清理" },
        inspect_contract: { type: "boolean", description: "只返回 LITSAN 蒸馏规则，不写入任何内容" },
        dry_run: { type: "boolean", description: "按当前契约校验候选与 scope，但不写入 Memory Core" }
      },
      required: [],
      additionalProperties: false
    },
    run: async (args: Record<string, unknown>) => {
      if (args.inspect_contract === true) return jsonResult({ contract: distillationContract() });
      const action = optionalString(args.action);
      const sourceHarness = optionalString(args.source_harness) ?? runtime.source.platform ?? "mcp-harness";
      const leaseToken = optionalString(args.lease_token);
      if (action === "reconcile_commit") {
        const mode = optionalString(args.reconcile_mode) ?? "inspect";
        if (!["inspect", "reconcile", "abandon"].includes(mode)) throw new Error("invalid reconcile_mode");
        const { reconcileDistillationCommit } = await import("../../distillation-submit.js");
        return jsonResult(await reconcileDistillationCommit({ stateRoot, runtime,
          commitId: optionalString(args.commit_id), mode: mode as "inspect" | "reconcile" | "abandon",
          generation: optionalString(args.commit_generation), confirmation: optionalString(args.operator_confirmation),
          reason: optionalString(args.operator_reason) }));
      }
      if (action === "restructure_l2") {
        const { projectId } = await resolveToolScope(runtime, {
          scope: "project", project: requiredString(args.project, "project"),
          workspaceProject: optionalString(args.workspace_project)
        });
        return jsonResult(await restructureL2Control({ stateRoot, runtime, projectId: projectId!, dryRun: args.dry_run === true }));
      }
      if (action === "audit") {
        return jsonResult(await auditDistillationControl({
          stateRoot,
          runtime
        }));
      }
      if (action === "consolidate") {
        const kind = requiredString(args.kind, "kind");
        if (kind !== "l2" && kind !== "l3") throw new TypeError("consolidate kind must be l2 or l3");
        const { projectId } = await resolveToolScope(runtime, {
          scope: "project",
          project: requiredString(args.project, "project"),
          workspaceProject: optionalString(args.workspace_project)
        });
        return jsonResult(await planDistillationConsolidation({
          stateRoot,
          runtime,
          kind,
          projectId: projectId!
        }));
      }
      if (action === "recover_ingest") {
        const eventId = requiredString(args.event_id, "event_id");
        const { projectId } = await resolveToolScope(runtime, {
          scope: "project",
          project: requiredString(args.project, "project"),
          workspaceProject: optionalString(args.workspace_project)
        });
        return jsonResult(await recoverDistillationControl({
          stateRoot, runtime, eventId, projectId: projectId!, dryRun: args.dry_run === true
        }));
      }
      if (action === "reconcile_derived") {
        const jobId = requiredString(args.job_id, "job_id");
        const { projectId } = await resolveToolScope(runtime, {
          scope: "project",
          project: requiredString(args.project, "project"),
          workspaceProject: optionalString(args.workspace_project)
        });
        return jsonResult(await reconcileCompletedL2DerivedJob({
          stateRoot, accountId: runtime.accountId, jobId,
          projectId: projectId!, dryRun: args.dry_run !== false
        }));
      }
      if (action === "reconcile_l4") {
        return jsonResult(await reconcileCurrentL4DerivedJob({
          stateRoot,
          accountId: runtime.accountId,
          jobId: requiredString(args.job_id, "job_id"),
          dryRun: args.dry_run !== false
        }));
      }
      if (action === "discover") {
        return jsonResult(await discoverDistillationControl({
          stateRoot,
          runtime,
          dryRun: args.dry_run === true
        }));
      }
      if (action === "next") {
        return jsonResult(await nextDistillationControl({
          stateRoot,
          runtime,
          sourceHarness,
          leaseToken,
          jobId: optionalString(args.job_id),
          kind: optionalString(args.kind),
          scope: optionalString(args.scope),
          project: optionalString(args.project),
          workspaceProject: optionalString(args.workspace_project),
          evidenceOffset: optionalInteger(args.evidence_offset) ?? 0,
          evidenceChunkChars: optionalInteger(args.evidence_chunk_chars) ?? 120_000,
          leaseSeconds: optionalInteger(args.lease_seconds),
          leaseTokenSupported: args.lease_token_supported === true,
          resolveProjectScope: async (scope) => (await resolveToolScope(runtime, {
            scope: "project", ...scope
          })).projectId,
          renderNext: async (job, evidenceOffset, evidenceChunkChars) => {
            const base = distillationNextPayload(job, evidenceOffset, evidenceChunkChars);
            if (job.branch_id && job.project_id) {
              const branch = await (runtime.branches ?? new JsonProjectBranchStore(join(stateRoot, "project-branches.json"))).resolve(runtime.accountId, job.project_id, job.branch_id, { includeClosed: true });
              const name = branch?.name ?? job.branch_id;
              base.branch = { id: job.branch_id, name };
              const instructions = `This job belongs to Branch ${name}. Submit only the new durable dated events from this evidence as events (same fields as l2_chunk: date, title_en, title_zh, body_en, body_zh, evidence_refs ⊆ job evidence). Do not load or resubmit main L2. Bilingual. architecture_map is optional, as today. 本任务属于 Branch ${name}；仅提交本证据中新增长期事件，中英双语；不要加载或重提 main L2。`;
              base.instructions = (base.evidence_transport as { complete: boolean }).complete ? instructions : `${base.instructions} ${instructions}`;
            }
            if (job.target !== "l2" || !job.project_id) return base;
            const [current, architectureContext] = await Promise.all([
              runtime.architecture.inspectProjectCognitiveMap({
                accountId: runtime.accountId,
                projectId: job.project_id
              }),
              runtime.architecture.getProjectArchitecture({
                accountId: runtime.accountId,
                projectId: job.project_id,
                query: "architecture boundaries ownership capabilities subsystems processes flows methods"
              })
            ]);
            const hardContractContext = architectureContext
              .filter((item) => item.authority === "authoritative")
              .slice(0, 3)
              .map((item) => ({
                id: item.id,
                content: item.content.slice(0, 4_000),
                source: item.source,
                provenance: item.provenance
              }));
            return {
              ...base,
              architecture_context: {
                contract: "memhub-architecture-cognitive-map-v1",
                authority: "derived",
                abstraction_cutoff: "mechanism",
                fingerprint: current.fingerprint || architectureCognitiveMapFingerprint(null),
                map: current.map,
                hard_contract_context: hardContractContext,
                instructions: "This is a derived Project Architecture mental model, not L1-L4 and not the governed hard Architecture contract. Preserve stable IDs and prior evidence when still valid; update only when supplied evidence justifies a structural change. New or changed node labels and summaries must be bilingual (English / 中文, EN: ... ZH: ...); preserve technical terms and identifiers."
              }
            };
          }
        }));
      }
      if (action === "renew") {
        return jsonResult(await renewDistillationControl({
          stateRoot, runtime,
          jobId: requiredString(args.job_id, "job_id"),
          sourceHarness, leaseToken,
          leaseSeconds: optionalInteger(args.lease_seconds) ?? 300
        }));
      }
      if (action === "skip") {
        return jsonResult(await skipDistillationControl({
          stateRoot, runtime,
          jobId: requiredString(args.job_id, "job_id"),
          sourceHarness, leaseToken
        }));
      }
      if (action !== undefined && action !== "submit") throw new TypeError("action must be audit, discover, consolidate, recover_ingest, reconcile_derived, reconcile_l4, next, renew, submit, skip, or restructure_l2");
      return jsonResult(await submitDistillationControl({
        args, stateRoot, runtime, sourceHarness, leaseToken,
        resolveToolScope, validateDistillationEvidenceChain
      }));
    }
  });
  return tools;
}
