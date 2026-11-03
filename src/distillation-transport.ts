import { distillationContract, L2_FORMAT_RULE, L3_CURRENT_TRUTH_RULE } from "./distillation-contract.js";
import type { DistillationJob } from "./distillation-jobs.js";
import { GLOBAL_STATE_REQUIRED_HEADINGS } from "./global-state.js";

/** Preserve legacy inline and chunked MCP evidence payloads across handler refactors. */
export function distillationNextPayload(
  job: DistillationJob,
  evidenceOffset: number,
  evidenceChunkChars: number
): Record<string, unknown> {
  const evidenceDocument = distillationEvidenceDocument(job);
  if (evidenceOffset > evidenceDocument.length) {
    throw new TypeError(`evidence_offset exceeds evidence length ${evidenceDocument.length}`);
  }
  const inline = evidenceOffset === 0 && evidenceDocument.length <= 120_000;
  const l2Guidance = job.target === "l2" ? {
    l2_format: L2_FORMAT_RULE,
    ...(job.l2_restructure ? { restructure: {
      base_ref: job.l2_restructure.base_ref,
      required_confirmation: `restructure:${job.l2_restructure.base_ref}`,
      rules: ["Explicit operator confirmation is required in operator_confirmation; do not infer approval from leasing this job.",
        "Restructure the supplied base into dated events; every ## heading must be dated. Preserve all base_evidence_refs in submitted evidence_refs, including unresolved refs; do not invent their missing content.",
        "The base must still be current at submit. Routine heading preservation is waived only for this confirmed restructure job.", L2_FORMAT_RULE]
    } } : {})
  } : job.target === "l3" ? {
    l3_format: L3_CURRENT_TRUTH_RULE,
    promotion_notice: "This is a promotion candidate. When submit returns awaiting_user_review/written=false, show the review notice and use the governed memory plan/confirmation/execute flow; never report it as committed."
  } : {};
  const globalStateGuidance = job.target === "global_state" ? {
    global_state_format: {
      required_headings: [...GLOBAL_STATE_REQUIRED_HEADINGS],
      authority: "account-state supporting context; below L4 stable profile",
      rules: [
        "Use only the supplied explicit-global L1 evidence plus the exact prior Global State base when present.",
        "Current State Snapshot contains current account-level conditions; Recent Transitions preserves dated superseded changes; Profile Signals are non-authoritative candidates only.",
        "Automation, agent-inferred and tool-output evidence may support operational state but cannot independently establish a stable user trait.",
        "Do not copy synthetic recommendation prompts into the artifact. Do not infer a project or promote one-off state into identity."
      ]
    }
  } : {};
  if (inline) {
    return {
      job,
      ...l2Guidance,
      ...globalStateGuidance,
      contract: distillationContract(),
      evidence_transport: {
        mode: "inline",
        total_chars: evidenceDocument.length,
        complete: true
      },
      instructions: job.l2_restructure
        ? "Read the supplied exact L2 base and resolved L1 evidence, then follow restructure.rules and l2_format. Submit the full dated replacement only after explicit operator confirmation. Inspect architecture_context and use its fingerprint fence for any optional architecture_map."
        : job.target === "l2"
        ? "Produce the requested L2 artifact from the supplied L1 evidence. First load the current canonical L2 from LITSAN, preserve its existing timeline events and superseded history, then merge the new evidence into one full canonical timeline replacement. Never submit a delta-only L2 body. Also inspect architecture_context when present: if the evidence changes the project's structural mental model, submit the complete evidence-backed architecture_map with architecture_map_base_fingerprint. Keep the map above implementation detail and link affected timeline events to architecture nodes. Write the L2 result bilingually (English + Simplified Chinese, paired per section) as the contract requires. For new or changed architecture nodes, write bilingual labels and bilingual summaries; preserve technical terms, IDs, evidence and links. If evidence is insufficient, call action=skip with job_id."
        : job.target === "global_state"
        ? "Update the canonical account Global State from the supplied exact base (when present) plus new explicit-global L1 evidence. Submit one compact bilingual full replacement with exactly the three required Global State sections. Profile Signals are candidates, not L4. If the new evidence adds no durable account state, call action=skip with job_id."
        : job.target === "l3"
        ? "Produce the requested L3 Current Truth from the supplied exact L2 revisions. Follow l3_format: keep durable facts atomic and compact, preserve evidence-supported temporal anchors, and state supersession when an older value/decision is replaced. Do not create a new memory layer; these are structured facts inside L3. Read current LITSAN context first so the result replaces/updates the canonical artifact rather than duplicating it. Write the result bilingually (English + Simplified Chinese, paired per item). If evidence is insufficient, call action=skip with job_id."
        : `Produce only the requested ${job.target.toUpperCase()} artifact from the supplied evidence. Read current LITSAN context first so the result updates the canonical artifact rather than duplicating it. Write the result bilingually (English + Simplified Chinese, paired per item) as the contract requires. If evidence is insufficient for this layer, call action=skip with job_id.`
    };
  }

  const end = Math.min(evidenceDocument.length, evidenceOffset + evidenceChunkChars);
  const nextOffset = end < evidenceDocument.length ? end : null;
  const manifest = job.evidence.map((item) => {
    const { content, user_text, assistant_text, reasoning_summary, tool_summary, ...metadata } = item;
    return {
      ...metadata,
      text_chars: {
        ...(content !== undefined ? { content: content.length } : {}),
        ...(user_text !== undefined ? { user_text: user_text.length } : {}),
        ...(assistant_text !== undefined ? { assistant_text: assistant_text.length } : {}),
        ...(reasoning_summary !== undefined ? { reasoning_summary: reasoning_summary.length } : {}),
        ...(tool_summary !== undefined ? { tool_summary: tool_summary.length } : {})
      }
    };
  });
  return {
    job: { ...job, evidence: manifest },
    ...l2Guidance,
    ...globalStateGuidance,
    contract: distillationContract(),
    evidence_transport: {
      mode: "chunked",
      offset: evidenceOffset,
      next_offset: nextOffset,
      total_chars: evidenceDocument.length,
      chunk_chars: end - evidenceOffset,
      complete: nextOffset === null
    },
    evidence_chunk: evidenceDocument.slice(evidenceOffset, end),
    instructions: nextOffset === null
      ? (job.l2_restructure
        ? "All evidence chunks have been read. Follow restructure.rules and l2_format; submit the full dated replacement with explicit operator_confirmation and all base_evidence_refs."
        : job.target === "l2"
        ? `All evidence chunks for ${job.job_id} have been read. Load the current canonical L2, preserve its prior timeline events, and merge this evidence into one full canonical replacement; never submit a delta-only L2 body. Inspect architecture_context and include a complete architecture_map plus architecture_map_base_fingerprint when structural understanding changed. Write L2 bilingually (English + Simplified Chinese). For new or changed architecture nodes, write bilingual labels and bilingual summaries; preserve technical terms, IDs, evidence and links. Call action=skip if the evidence is insufficient.`
        : job.target === "global_state"
        ? `All evidence chunks for ${job.job_id} have been read. Produce one compact bilingual full Global State replacement with the required Current State Snapshot, Recent Transitions, and non-authoritative Profile Signals sections, or call action=skip if no useful account state is justified.`
        : job.target === "l3"
        ? `All evidence chunks for ${job.job_id} have been read. Produce the requested L3 Current Truth following l3_format: compact atomic current facts, exact immutable L2 evidence refs, temporal anchors when supported, and explicit supersession for replaced states. Do not create another memory layer. Write the result bilingually (English + Simplified Chinese), or call action=skip if the evidence is insufficient.`
        : `All evidence chunks for ${job.job_id} have been read. Produce only the requested ${job.target.toUpperCase()} artifact bilingually (English + Simplified Chinese), or call action=skip if the evidence is insufficient.`)
      : `This job uses chunked evidence. Keep the same lease owner and call action=next with job_id=${job.job_id}, source_harness=${job.leased_by ?? "<same-harness>"}, evidence_offset=${nextOffset}. Do not submit until evidence_transport.complete=true.`
  };
}

export function distillationEvidenceDocument(job: DistillationJob): string {
  return job.evidence.map((item, index) => {
    const lines = [
      `--- evidence ${index + 1}/${job.evidence.length} ---`,
      `ref: ${item.ref}`,
      `kind: ${item.kind}`,
      `timestamp: ${item.timestamp}`,
      ...(item.layer ? [`layer: ${item.layer}`] : []),
      ...(item.project_id ? [`project_id: ${item.project_id}`] : []),
      ...(item.conversation_id ? [`conversation_id: ${item.conversation_id}`] : []),
      ...(item.title ? [`title: ${item.title}`] : []),
      ...(item.source_kinds?.user_text ? [`source_kind.user_text: ${item.source_kinds.user_text}`] : []),
      ...(item.source_kinds?.assistant_text ? [`source_kind.assistant_text: ${item.source_kinds.assistant_text}`] : []),
      ...(item.source_kinds?.reasoning_summary ? [`source_kind.reasoning_summary: ${item.source_kinds.reasoning_summary}`] : []),
      ...(item.source_kinds?.tool_summary ? [`source_kind.tool_summary: ${item.source_kinds.tool_summary}`] : []),
      ...(item.source_kinds?.content ? [`source_kind.content: ${item.source_kinds.content}`] : []),
      ...(item.origin ? [`origin: ${item.origin}`] : []),
      ...(item.trigger ? [`trigger: ${item.trigger}`] : [])
    ];
    if (item.content !== undefined) lines.push("content:", item.content);
    if (item.user_text !== undefined) lines.push("user_text:", item.user_text);
    if (item.assistant_text !== undefined) lines.push("assistant_text:", item.assistant_text);
    if (item.reasoning_summary !== undefined) lines.push("reasoning_summary:", item.reasoning_summary);
    if (item.tool_summary !== undefined) lines.push("tool_summary:", item.tool_summary);
    return lines.join("\n");
  }).join("\n\n");
}
