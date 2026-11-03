import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { ContextBudgetDecision, ContextCapsule } from "./context-capsule.js";
import type {
  RetrievalCandidateDecision,
  RetrievalCutoffDiagnostics,
  RetrievalRankDiagnostics
} from "./retrieval-ranker.js";
import type { TurnKnowledgePlan } from "./turn-knowledge-plan.js";

export interface RetrievalDecisionTrace {
  version: "retrieval-decision-trace-v1";
  trace_id: string;
  timestamp: string;
  project_id: string | null;
  branch_id: string | null;
  query_hash: string;
  scope: ContextCapsule["retrievalScope"] | null;
  pipeline_order: ["scope_gate", "candidate_recall", "retrieval_ranking", "context_budget", "turn_knowledge_plan"];
  limits: {
    requested: number | null;
    final: number | null;
    candidate: number | null;
  };
  core_status: string[];
  lanes: Record<"global" | "globalState" | "project" | "skills", {
    candidate_count: number;
    deduped_count: number;
    emitted_count: number;
    cutoff?: RetrievalCutoffDiagnostics;
    decisions: RetrievalCandidateDecision[];
  }>;
  context_budget: ContextCapsule["contextBudget"] & {
    decisions: ContextBudgetDecision[];
  };
  turn_knowledge_plan: {
    required: Array<{ id: string; kind: string; reason: string }>;
    supporting: Array<{ id: string; kind: string; reason: string }>;
    omitted_items: number;
    sufficiency: TurnKnowledgePlan["sufficiency"];
  };
}

export interface RetrievalTraceReceipt {
  version: RetrievalDecisionTrace["version"];
  trace_id: string;
  stored: true;
  candidate_decisions: number;
  query_stored: false;
}

export interface RetrievalExplainTarget {
  evidence_ref: string;
  memory_id: string;
  layer: string;
  project_id: string | null;
}

export async function recordRetrievalDecisionTrace(input: {
  stateRoot: string;
  accountId: string;
  query: string;
  capsule: ContextCapsule;
  plan: TurnKnowledgePlan;
}): Promise<RetrievalTraceReceipt> {
  const diagnostics = input.capsule.retrievalDiagnostics;
  const trace: RetrievalDecisionTrace = {
    version: "retrieval-decision-trace-v1",
    trace_id: `rt_${randomUUID().replaceAll("-", "")}`,
    timestamp: new Date().toISOString(),
    project_id: input.capsule.resolvedProjectId,
    branch_id: input.capsule.branchContext?.branchId ?? null,
    query_hash: createHash("sha256").update(input.query, "utf8").digest("hex"),
    scope: input.capsule.retrievalScope ?? null,
    pipeline_order: ["scope_gate", "candidate_recall", "retrieval_ranking", "context_budget", "turn_knowledge_plan"],
    limits: {
      requested: diagnostics?.requestedLimit ?? null,
      final: diagnostics?.finalLimit ?? null,
      candidate: diagnostics?.candidateLimit ?? null
    },
    core_status: diagnostics?.coreStatus?.slice() ?? [],
    lanes: {
      global: laneTrace(diagnostics?.lanes.global),
      globalState: laneTrace(diagnostics?.lanes.globalState),
      project: laneTrace(diagnostics?.lanes.project),
      skills: laneTrace(diagnostics?.lanes.skills)
    },
    context_budget: {
      ...input.capsule.contextBudget,
      decisions: input.capsule.contextBudgetTrace?.decisions.slice() ?? []
    },
    turn_knowledge_plan: {
      required: input.plan.required.map((entry) => ({ id: entry.id, kind: entry.kind, reason: entry.reason })),
      supporting: input.plan.supporting.map((entry) => ({ id: entry.id, kind: entry.kind, reason: entry.reason })),
      omitted_items: input.plan.coverage.omitted_items,
      sufficiency: input.plan.sufficiency
    }
  };
  const path = retrievalTracePath(input.stateRoot, input.accountId);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await appendFile(path, `${JSON.stringify(trace)}\n`, { encoding: "utf8", mode: 0o600 });
  return {
    version: trace.version,
    trace_id: trace.trace_id,
    stored: true,
    candidate_decisions: Object.values(trace.lanes).reduce((sum, lane) => sum + lane.decisions.length, 0),
    query_stored: false
  };
}

export async function explainRetrievalDecisionTrace(input: {
  stateRoot: string;
  accountId: string;
  traceId: string;
  target: RetrievalExplainTarget;
}): Promise<Record<string, unknown>> {
  const trace = await readRetrievalDecisionTrace(input.stateRoot, input.accountId, input.traceId);
  if (!trace) throw new Error(`retrieval trace not found: ${input.traceId}`);
  const candidateDecisions = Object.entries(trace.lanes).flatMap(([lane, value]) =>
    value.decisions
      .filter((decision) => decision.id === input.target.memory_id)
      .map((decision) => ({ lane, ...decision }))
  );
  const contextDecisions = trace.context_budget.decisions.filter((decision) => decision.id === input.target.memory_id);
  const required = trace.turn_knowledge_plan.required.find((entry) => entry.id === input.target.memory_id);
  const supporting = trace.turn_knowledge_plan.supporting.find((entry) => entry.id === input.target.memory_id);
  const traceProjectId = trace.scope?.primaryProject ?? trace.project_id;
  const scopeMismatch = input.target.layer !== "L4" && input.target.project_id !== null &&
    input.target.project_id !== traceProjectId;
  const retrievalDropped = candidateDecisions.find((decision) => decision.result === "dropped");
  const contextDropped = contextDecisions.find((decision) => decision.result === "dropped");
  const contextTruncated = contextDecisions.find((decision) => decision.result === "truncated");

  let firstExclusionStage: string | null = null;
  let reason: string | null = null;
  if (scopeMismatch) {
    firstExclusionStage = "scope_gate";
    reason = "scope_gate";
  } else if (candidateDecisions.length === 0) {
    firstExclusionStage = "candidate_recall";
    reason = "not_in_candidate_pool";
  } else if (retrievalDropped && !candidateDecisions.some((decision) => decision.result === "kept")) {
    firstExclusionStage = "retrieval_ranking";
    reason = retrievalDropped.reason;
  } else if (contextDropped) {
    firstExclusionStage = "context_budget";
    reason = contextDropped.reason;
  }

  return {
    trace_id: trace.trace_id,
    trace_timestamp: trace.timestamp,
    evidence_ref: input.target.evidence_ref,
    memory_id: input.target.memory_id,
    layer: input.target.layer,
    target_project_id: input.target.project_id,
    trace_project_id: trace.project_id,
    pipeline_order: trace.pipeline_order,
    first_exclusion_stage: firstExclusionStage,
    reason,
    retrieval: {
      candidate_seen: candidateDecisions.length > 0,
      decisions: candidateDecisions
    },
    context_budget: contextDecisions,
    turn_knowledge_plan: required
      ? { result: "required", reason: required.reason, kind: required.kind }
      : supporting
        ? { result: "supporting", reason: supporting.reason, kind: supporting.kind }
        : { result: "not_selected", note: "Turn Knowledge Plan is advisory and runs after the current context budget; this is not itself a context-drop decision." },
    ...(contextTruncated ? { context_truncated: true } : {}),
    query_stored: false,
    note: candidateDecisions.length === 0 && !scopeMismatch
      ? "The exact memory existed, but this trace contains no candidate decision for it. This distinguishes a candidate-recall miss from later Top-K/TKP/context-budget cuts; it does not by itself identify the upstream semantic/lexical/Core cause."
      : "Trace explanations report deterministic recorded decisions only; they do not infer hidden model reasoning."
  };
}

function laneTrace(lane: RetrievalRankDiagnostics | undefined) {
  if (!lane) return { candidate_count: 0, deduped_count: 0, emitted_count: 0, decisions: [] };
  return {
    candidate_count: lane.candidateCount,
    deduped_count: lane.dedupedCount,
    emitted_count: lane.emittedCount,
    ...(lane.cutoff ? { cutoff: lane.cutoff } : {}),
    decisions: lane.decisions.map((decision) => ({ ...decision }))
  };
}

async function readRetrievalDecisionTrace(
  stateRoot: string,
  accountId: string,
  traceId: string
): Promise<RetrievalDecisionTrace | null> {
  let text: string;
  try {
    text = await readFile(retrievalTracePath(stateRoot, accountId), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  for (const line of text.split(/\r?\n/).reverse()) {
    if (!line) continue;
    try {
      const value = JSON.parse(line) as Partial<RetrievalDecisionTrace>;
      if (value.trace_id === traceId && value.version === "retrieval-decision-trace-v1") {
        return value as RetrievalDecisionTrace;
      }
    } catch {
      // Skip malformed historical telemetry lines rather than making retrieval diagnostics unavailable.
    }
  }
  return null;
}

function retrievalTracePath(stateRoot: string, accountId: string): string {
  const hash = createHash("sha256").update(accountId, "utf8").digest("hex").slice(0, 24);
  return join(resolve(stateRoot), "telemetry", `retrieval-${hash}.jsonl`);
}
