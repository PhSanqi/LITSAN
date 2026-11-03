import type { DistillationSubmitDeps } from "./distillation-submit.js";
import { distillationRevisionBody } from "./distillation-contract.js";
import { enqueueL2RestructureJob, listDistillationJobs, type DistillationEvidenceItem } from "./distillation-jobs.js";
import { validateDistillationEvidenceChain } from "./distillation-evidence.js";
import { latestCanonicalL2 } from "./core/lifecycle/l2-restructure.js";

export async function restructureL2Control(input: {
  stateRoot: string; runtime: DistillationSubmitDeps; projectId: string; dryRun: boolean;
}) {
  const { stateRoot, runtime, projectId } = input;
  const jobs = await listDistillationJobs(stateRoot, runtime.accountId);
  const base = latestCanonicalL2(jobs, projectId);
  if (!base) throw new Error("L2 restructure requires a completed non-retired canonical L2 revision");
  const baseRef = `l2:${base.result_id}:${base.job_id}`;
  const storageIds = new Set(await runtime.projects.storageIds(runtime.accountId, projectId));
  const evidence: DistillationEvidenceItem[] = [{
    ref: baseRef, kind: "memory", layer: "L2", project_id: projectId,
    timestamp: base.result_committed_at ?? base.completed_at ?? base.updated_at,
    content: distillationRevisionBody(base)
  }];
  const savedEvidence = [base, ...jobs].flatMap(job => job.evidence);
  for (const ref of new Set(base.evidence_refs)) {
    // Job evidence also covers legacy L1 Memory/raw-turn refs that have no capture entry.
    const saved = savedEvidence.find(item => item.ref === ref && item.layer === "L1" &&
      Boolean(item.project_id && storageIds.has(item.project_id)) &&
      (item.kind === "turn" ? Boolean(item.user_text?.trim() && item.assistant_text?.trim()) : item.kind === "memory" && Boolean(item.content?.trim())));
    if (saved) { evidence.push(structuredClone(saved)); continue; }
    if (!ref.startsWith("l1:")) continue;
    try {
      evidence.push(...await validateDistillationEvidenceChain({ stateRoot, runtime, kind: "l2", projectId, evidenceRefs: [ref] }));
    } catch (error) {
      if (!(error instanceof Error) || !/^L2 evidence (does not resolve|belongs to another)/.test(error.message)) throw error;
    }
  }
  const { job } = await enqueueL2RestructureJob({ stateRoot, accountId: runtime.accountId, projectId, evidence,
    restructure: { base_ref: baseRef, base_evidence_refs: [...base.evidence_refs] }, dryRun: input.dryRun });
  const resolved = new Set(job.evidence.map(item => item.ref));
  return {
    job_id: job.job_id, base_ref: job.l2_restructure!.base_ref, evidence_items: job.evidence.length,
    est_chars: JSON.stringify(job.evidence).length,
    unresolved_refs: job.l2_restructure!.base_evidence_refs.filter(ref => !resolved.has(ref)),
    next: `litsan_distill action=next job_id=${job.job_id} lease_token_supported=true`
  };
}
