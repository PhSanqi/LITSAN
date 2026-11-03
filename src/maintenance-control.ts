import { createHash, randomBytes, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { MaintenanceCard, MaintenanceCardSet, MaintenanceLogEntry, MaintenanceRejectCode, L2ChunkAnswer, L2ChunkEvent, L2ChunkInput, MaintenanceReadonly, ClientProfile, MaintenanceCardKind, MaintenanceOfferTurn, MaintenanceOffer, MaintenanceApplyPorts, GapCheckInput } from "./contracts/maintenance.js";
import type { MemoryVisualizationPayload } from "./contracts/project-map.js";
import type { ArchitectureCognitiveMap } from "./contracts/project-model.js";
import type { DistillationJob } from "./contracts/distillation.js";
import type { TurnSessionWriter } from "./core/ports/memory.js";
import { canonicalLayerTitle } from "./core/lifecycle/evidence-refs.js";
import { withMaintenanceStore, readMaintenanceStore, readMaintenanceLog, type MaintenanceStore, getMaintenanceConfig, withMaintenanceOfferState, generationKey, markMaintenanceDirty, appendMaintenanceLog } from "./maintenance-store.js";
import { listDistillationJobs, readDistillationJobsSnapshot, distillationJobsSignature, mutateMaintenanceJob, mutateMaintenanceJobs, withDistillationJobsBatch, outsideDistillationJobsBatch, flushDistillationJobs } from "./distillation-jobs.js";
import { skipDistillationControl } from "./distillation-control.js";
import { submitDistillationControl, type DistillationSubmitDeps } from "./distillation-submit.js";
import { distillationRevisionBody, validateDurableMemoryContent } from "./distillation-contract.js";
import { validateDistillationEvidenceChain } from "./distillation-evidence.js";
import { resolveToolScope } from "./context-router.js";
import { readMemoryControlData } from "./memory-control-plane.js";
import { buildProjectModel } from "./shell/archify/project-model.js";
import { parseArchitectureCognitiveMapCandidate, buildArchitectureCognitiveMap } from "./archify/architecture-cognitive-map.js";
import { architectureDocRefs } from "./archify/map-bootstrap.js";
import { timelineLinkDate } from "./archify/memory-visualization.js";
import type { ProjectArchitectureSource } from "./architecture-source.js";
import { normalizeClientProfile } from "./core/maintenance/profile.js";
import { planL2Chunks, L2_INSTRUCTIONS } from "./core/maintenance/chunk.js";
import { cardEstTokens } from "./core/maintenance/estimate.js";
import { structureFingerprint, chunkFingerprint, gapCheckFingerprint } from "./core/maintenance/structure-fingerprint.js";
import { maintenanceGenerators } from "./core/maintenance/registry.js";
import { currentTimelineBatchHash, TIMELINE_DIGEST_KEY } from "./core/maintenance/timeline-digest.js";
import { decideOffer } from "./core/maintenance/offer-policy.js";
import { validateCardAnswer } from "./core/maintenance/validate.js";
import { completeBranchJobWithEvents } from "./branch-drafts.js";
import { mergeChunkEvents, normalizeL2EventKey, datedL2Headings } from "./core/maintenance/merge-l2.js";

export interface MaintenanceDeps { stateRoot: string; readVisualization?: typeof readMemoryControlData; completeBranchJob?: typeof completeBranchJobWithEvents; runtime: DistillationSubmitDeps & { architecture: DistillationSubmitDeps["architecture"] & Pick<ProjectArchitectureSource, "listProjectArchitectureMarkdown" | "getProjectCodeCitations">; memoryClient: DistillationSubmitDeps["memoryClient"] & TurnSessionWriter } }
interface ClockInput { now?: number }
interface Actor { harness?: string; profile?: ClientProfile | unknown }
type Log = (entry: MaintenanceLogEntry) => void;
const MERGE_HARNESS = "memhub-card-merge";
export const inlineTurnOwner = (eventId: string) => `memhub-in-turn:${eventId}`;

const open = (c: MaintenanceCard) => c.status === "pending" || c.status === "leased";
const cmp = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
function entry(card: MaintenanceCard, now: number, outcome: MaintenanceLogEntry["outcome"], actor: Actor = {}, extra: Partial<MaintenanceLogEntry> = {}): MaintenanceLogEntry {
  const profile = normalizeClientProfile(actor.profile);
  return { ts: new Date(now).toISOString(), account: card.account_id, card_id: card.card_id, kind: card.kind, project: card.project_id,
    ...(card.parent_job_id ? { parent_job_id: card.parent_job_id } : {}), harness: actor.harness ?? "mcp-harness", model: profile.model,
    profile: profile.execution, via: profile.execution === "background" ? "worker" : "direct", outcome, est_tokens: card.est_tokens, answer_chars: 0, ...extra };
}
function supersede(card: MaintenanceCard, now: number, log: Log, store: MaintenanceStore) {
  markMaintenanceDirty(store); card.status = "superseded"; card.updated_at = new Date(now).toISOString(); log(entry(card, now, "superseded"));
}
function makeCard(input: Pick<MaintenanceCard, "key" | "kind" | "account_id" | "project_id" | "fingerprint" | "instructions" | "input" | "allowed_refs" | "answer_schema"> & Partial<Pick<MaintenanceCard, "parent_job_id" | "chunk" | "branch_id">> & { requested?: boolean }, now: number): MaintenanceCard {
  const { requested, ...fields } = input;
  return { ...fields, ...(requested ? { requested_at: new Date(now).toISOString() } : {}), card_id: randomBytes(12).toString("hex"), est_tokens: cardEstTokens(input), status: "pending", attempts: 0, rejections: 0,
    created_at: new Date(now).toISOString(), updated_at: new Date(now).toISOString() };
}

const parentIds = (set: MaintenanceCardSet) => set.parent_job_ids ?? [set.parent_job_id];
function parentFingerprint(job: MaintenanceReadonly<DistillationJob>): string {
  const { split_card_set: _split, maintenance_split_locked: _locked, ...fields } = job;
  return createHash("sha256").update(JSON.stringify(fields)).digest("hex");
}
function parentsMatch(set: MaintenanceCardSet, jobs: readonly MaintenanceReadonly<DistillationJob>[]): boolean {
  return parentIds(set).every(id => {
    const job = jobs.find(j => j.job_id === id);
    return job && job.split_card_set === set.set_id && (job.status === "pending" || job.status === "leased" && job.leased_by === MERGE_HARNESS) &&
      (!set.parent_fingerprints || set.parent_fingerprints[id] === parentFingerprint(job));
  });
}
async function abortSet(deps: MaintenanceDeps, store: MaintenanceStore, set: MaintenanceCardSet, now: number, log: Log, backgroundOnly = false) {
  markMaintenanceDirty(store); set.status = "aborted";
  for (const card of store.cards.filter(c => set.card_ids.includes(c.card_id))) if (card.status !== "superseded") supersede(card, now, log, store);
  const jobs = await readDistillationJobsSnapshot(deps.stateRoot, deps.runtime.accountId);
  const ids = parentIds(set).filter(id => jobs.some(j => j.job_id === id));
  if (ids.length) await mutateMaintenanceJobs(deps.stateRoot, deps.runtime.accountId, ids, parents => {
    for (const parent of parents) if (parent.split_card_set === set.set_id) {
      delete parent.split_card_set; delete parent.maintenance_split_locked;
      if (backgroundOnly) parent.maintenance_background_only = true;
    }
  });
}
async function finishCoalesced(deps: MaintenanceDeps, store: MaintenanceStore, set: MaintenanceCardSet, now: number, log: Log): Promise<boolean> {
  const ids = parentIds(set).slice(1);
  if (!ids.length) return true;
  const done = await mutateMaintenanceJobs(deps.stateRoot, deps.runtime.accountId, ids, parents => {
    if (parents.some(j => !(j.status === "completed" && j.maintenance_coalesced_into === set.parent_job_id) &&
      (j.status !== "pending" || j.split_card_set !== set.set_id || set.parent_fingerprints?.[j.job_id] !== parentFingerprint(j)))) return false;
    for (const job of parents) {
      job.status = "completed"; job.result_kind = "noop"; job.maintenance_coalesced_into = set.parent_job_id;
      job.completed_at = new Date(now).toISOString(); job.updated_at = job.completed_at;
      delete job.split_card_set; delete job.maintenance_split_locked;
    }
    return true;
  });
  if (!done) await abortSet(deps, store, set, now, log);
  return done;
}

async function mergeSet(deps: MaintenanceDeps, store: MaintenanceStore, set: MaintenanceCardSet, now: number, log: Log, checkpoint: () => Promise<void>): Promise<string | undefined> {
  const cards = set.card_ids.map(id => store.cards.find(c => c.card_id === id));
  if (set.status !== "open" || !cards.length || cards.some(c => c?.status !== "accepted")) return;
  try {
    let parent = (await listDistillationJobs(deps.stateRoot, deps.runtime.accountId)).find(j => j.job_id === set.parent_job_id);
    if (!parent) throw new Error("merge parent unavailable");
    if (parent.status === "completed") {
      if (!await finishCoalesced(deps, store, set, now, log)) return "coalesced parent changed";
      markMaintenanceDirty(store);
      set.status = "merged"; set.merged_at = parent.completed_at ?? new Date(now).toISOString(); set.result_job_id = parent.job_id; return;
    }
    if (!parentsMatch(set, await readDistillationJobsSnapshot(deps.stateRoot, deps.runtime.accountId))) {
      await abortSet(deps, store, set, now, log); return "merge parent changed";
    }
    const accepted = cards as MaintenanceCard[];
    if (accepted.some(c => c.fingerprint !== chunkFingerprint(parent!.evidence_hash, c.allowed_refs)) || parent.split_card_set !== set.set_id) throw new Error("merge evidence changed");

    const parentBranchId = parent.branch_id ?? set.branch_id;
    if (parentBranchId) {
      const sortedCards = [...accepted].sort((a, b) => (a.chunk?.index ?? 0) - (b.chunk?.index ?? 0));
      const branchEvents: L2ChunkEvent[] = sortedCards.flatMap(c => ((c.result as L2ChunkAnswer)?.events ?? []));
      const cardIds = sortedCards.map(c => c.card_id);
      parent = await mutateMaintenanceJob(deps.stateRoot, deps.runtime.accountId, parent.job_id, job => {
        if (job.split_card_set !== set.set_id || accepted.some(c => c.fingerprint !== chunkFingerprint(job.evidence_hash, c.allowed_refs))) throw new Error("merge fence changed");
        if (job.status === "completed") return structuredClone(job);
        if (job.status !== "pending" && job.leased_by !== MERGE_HARNESS) throw new Error("parent owned by another worker");
        job.status = "leased"; job.leased_by = MERGE_HARNESS; job.lease_token ??= randomUUID();
        job.leased_until = new Date(now + 900000).toISOString(); job.attempts = Math.max(1, job.attempts ?? 0);
        job.maintenance_cards ??= accepted.map(c => ({ card_id: c.card_id, evidence_refs: c.allowed_refs.slice() }));
        job.updated_at = new Date(now).toISOString();
        if (set.parent_fingerprints) set.parent_fingerprints[job.job_id] = parentFingerprint(job);
        markMaintenanceDirty(store);
        return structuredClone(job);
      });
      await checkpoint();
      if (parent.status !== "completed") {
        const completeBranch = deps.completeBranchJob ?? completeBranchJobWithEvents;
        await completeBranch({
          stateRoot: deps.stateRoot,
          accountId: deps.runtime.accountId,
          jobId: parent.job_id,
          leaseOwner: MERGE_HARNESS,
          leaseToken: parent.lease_token,
          projects: deps.runtime.projects,
          events: branchEvents,
          cardIds,
          now: new Date(now)
        });
      }
      set.status = "merged"; set.merged_at = new Date(now).toISOString(); set.result_job_id = parent.job_id;
      return;
    }

    const model = await buildProjectModel(deps.runtime, { stateRoot: deps.stateRoot, projectId: set.project_id, l2: [], todos: [] });
    const latest = [...model.revisions].sort((a, b) => cmp(a.committed_at, b.committed_at) || cmp(a.ref.split(":").at(-1)!, b.ref.split(":").at(-1)!)).at(-1);
    const jobs = await listDistillationJobs(deps.stateRoot, deps.runtime.accountId);
    const baseJob = latest ? jobs.find(j => `l2:${j.result_id}:${j.job_id}` === latest.ref) : undefined;
    const events = accepted.flatMap(c => (c.result as L2ChunkAnswer).events.map((event, eventIndex) => ({ chunkIndex: c.chunk!.index, eventIndex, event, cardId: c.card_id })));
    const content = parent.maintenance_merge_content ?? mergeChunkEvents({ baseContent: baseJob ? distillationRevisionBody(baseJob) : null,
      canonicalTitle: canonicalLayerTitle("l2", set.project_id), events }).content;
    parent = await mutateMaintenanceJobs(deps.stateRoot, deps.runtime.accountId, parentIds(set), parents => {
      if (!parentsMatch(set, parents)) throw new Error("merge fence changed");
      const job = parents[0]!;
      if (accepted.some(c => c.fingerprint !== chunkFingerprint(job.evidence_hash, c.allowed_refs))) throw new Error("merge evidence changed");
      if (job.status !== "pending" && job.leased_by !== MERGE_HARNESS) throw new Error("parent owned by another worker");
      job.evidence = [...new Map(parents.flatMap(j => j.evidence).map(item => [item.ref, item])).values()];
      job.evidence_refs = [...new Set(parents.flatMap(j => j.evidence_refs))];
      job.status = "leased"; job.leased_by = MERGE_HARNESS; job.lease_token ??= randomUUID();
      job.leased_until = new Date(now + 900000).toISOString(); job.attempts = Math.max(1, job.attempts ?? 0);
      job.maintenance_merge_content ??= content;
      job.maintenance_cards ??= accepted.map(c => ({ card_id: c.card_id, evidence_refs: c.allowed_refs.slice() }));
      job.updated_at = new Date(now).toISOString();
      if (set.parent_fingerprints) set.parent_fingerprints[job.job_id] = parentFingerprint(job);
      markMaintenanceDirty(store);
      return structuredClone(job);
    });
    // Persist every partial before crossing the external Core boundary.
    await checkpoint();
    if (parent.status !== "completed") {
      if (!events.length) await skipDistillationControl({ ...deps, jobId: parent.job_id, sourceHarness: MERGE_HARNESS, leaseToken: parent.lease_token });
      else await submitDistillationControl({ ...deps, sourceHarness: MERGE_HARNESS, leaseToken: parent.lease_token,
        args: { job_id: parent.job_id, kind: "l2", scope: "project", project: set.project_id, content,
          evidence_refs: [...new Set(accepted.flatMap(c => c.allowed_refs))], source_harness: MERGE_HARNESS,
          tags: ["maintenance-cards", `card-set:${set.set_id}`] }, resolveToolScope, validateDistillationEvidenceChain });
    }
    if (!await finishCoalesced(deps, store, set, now, log)) return "coalesced parent changed";
    markMaintenanceDirty(store);
    set.status = "merged"; set.merged_at = new Date(now).toISOString(); set.result_job_id = parent.job_id;
  } catch (error) {
    const current = await readDistillationJobsSnapshot(deps.stateRoot, deps.runtime.accountId);
    if (set.status === "open" && current.find(j => j.job_id === set.parent_job_id)?.status !== "completed" && !parentsMatch(set, current))
      await abortSet(deps, store, set, now, log);
    const detail = error instanceof Error ? error.message : String(error);
    log(entry(cards[0]!, now, "merge_failed", { harness: MERGE_HARNESS, profile: { execution: "background" } }, { detail, est_tokens: 0 }));
    return detail;
  }
}

function artifactSnapshot(store: MaintenanceStore, projectId: string) {
  const snapshot = new Map(Object.entries(store.artifacts ?? {}).flatMap(([key, value]) => {
    const [project, name] = JSON.parse(key) as [string, string];
    return project === projectId ? [[name, structuredClone(value)] as const] : [];
  }));
  return { get: (key: string): unknown => structuredClone(snapshot.get(key)) };
}

function replanUntouchedL2(store: MaintenanceStore, jobs: readonly MaintenanceReadonly<DistillationJob>[], projectId: string, branchId: string, budget: number, now: number, log: Log) {
  const ready = store.cards.some(c => c.kind === "l2_chunk" && c.project_id === projectId && (c.branch_id ?? "main") === branchId &&
    open(c) && (!c.lease || Date.parse(c.lease.until) <= now) && sequentialReady(store, c) && currentCardView(c).est_tokens <= budget);
  if (ready) return;
  const generator = maintenanceGenerators.get("l2_chunk")!;
  for (const set of store.sets.filter(s => s.status === "open" && s.project_id === projectId && (s.branch_id ?? "main") === branchId)
    .sort((a, b) => cmp(a.created_at, b.created_at))) {
    const cards = set.card_ids.map(id => store.cards.find(c => c.card_id === id));
    if (!cards.length || cards.some(c => !c || c.kind !== "l2_chunk" || c.status !== "pending" || c.attempts || c.rejections || c.lease || c.result || c.requested_at)) continue;
    const existing = (cards as MaintenanceCard[]).sort((a, b) => (a.chunk?.index ?? -1) - (b.chunk?.index ?? -1));
    if (existing.some((c, i) => c.chunk?.index !== i || c.chunk.of !== existing.length) ||
      !existing.some(c => currentCardView(c).est_tokens > budget) || !parentsMatch(set, jobs)) continue;
    const parents = parentIds(set).map(id => jobs.find(j => j.job_id === id));
    if (parents.some(j => !j || j.status !== "pending" || j.attempts || j.leased_by || j.leased_until)) continue;
    const evidence = [...new Map(parents.flatMap(j => j!.evidence).map(item => [item.ref, structuredClone(item)])).values()];
    if (!isDeepStrictEqual(existing.flatMap(c => (c.input as L2ChunkInput).items), evidence)) continue;
    const drafts = generator.ensure({ accountId: set.account_id, projectId, map: null,
      jobs: [{ ...parents[0]!, evidence }], events: [], artifacts: artifactSnapshot(store, projectId),
      l2ChunkBudget: Math.max(500, budget - 400) }, now);
    const replacements = drafts.map(draft => makeCard({ ...draft, instructions: generator.instructions, answer_schema: generator.answerSchema }, now));
    if (replacements.length <= existing.length || replacements.some(c => c.est_tokens > budget)) continue;
    for (const card of existing) supersede(card, now, log, store);
    set.card_ids = replacements.map(c => c.card_id);
    store.cards.push(...replacements);
    markMaintenanceDirty(store);
    return;
  }
}

async function ensureLocked(deps: MaintenanceDeps, store: MaintenanceStore, log: Log, checkpoint: () => Promise<void>, projectId: string | undefined, now: number, l2Only = false, l2ChunkBudget?: number, replanBranch?: string): Promise<void> {
  return withDistillationJobsBatch(deps.stateRoot, () => generateLocked(deps, store, log, checkpoint, projectId, now, l2Only, l2ChunkBudget, replanBranch));
}
async function generateLocked(deps: MaintenanceDeps, store: MaintenanceStore, log: Log, checkpoint: () => Promise<void>, projectId: string | undefined, now: number, l2Only: boolean, l2ChunkBudget?: number, replanBranch?: string): Promise<void> {
  const accountId = deps.runtime.accountId;
  // Retire cards created by the reverted code-review experiment without deleting their history.
  for (const card of store.cards) if (String(card.kind) === "code_change_review" && open(card) && (!projectId || card.project_id === projectId))
    supersede(card, now, log, store);
  const initialOpen = new Set(store.sets.filter(s => s.status === "open").map(s => s.set_id));
  for (const set of store.sets.filter(s => s.status === "open" && (!projectId || s.project_id === projectId))) {
    if (set.card_ids.length && set.card_ids.every(id => store.cards.find(c => c.card_id === id)?.status === "accepted")) {
      await outsideDistillationJobsBatch(deps.stateRoot, () => mergeSet(deps, store, set, now, log, checkpoint));
    }
  }
  let jobs = await readDistillationJobsSnapshot(deps.stateRoot, accountId);
  for (const set of store.sets.filter(s => s.status === "open" && (!projectId || s.project_id === projectId))) {
    const parent = jobs.find(j => j.job_id === set.parent_job_id);
    if (!parentsMatch(set, jobs) || store.cards.some(c => set.card_ids.includes(c.card_id) && c.fingerprint !== chunkFingerprint(parent?.evidence_hash ?? "", c.allowed_refs)))
      await abortSet(deps, store, set, now, log);
  }
  // A crash between claiming the ledger and checkpointing a new set must not strand untouched parents.
  const orphanIds = jobs.filter(j => j.status === "pending" && !j.attempts && j.split_card_set &&
    (!projectId || j.project_id === projectId) && !store.sets.some(s => s.set_id === j.split_card_set && s.status === "open")).map(j => j.job_id);
  if (orphanIds.length) await mutateMaintenanceJobs(deps.stateRoot, accountId, orphanIds, parents => {
    for (const parent of parents) if (parent.status === "pending" && !parent.attempts && parent.split_card_set &&
      !store.sets.some(s => s.set_id === parent.split_card_set && s.status === "open")) { delete parent.split_card_set; delete parent.maintenance_split_locked; }
  });
  jobs = await readDistillationJobsSnapshot(deps.stateRoot, accountId);
  if (l2Only && projectId && l2ChunkBudget !== undefined && replanBranch !== undefined)
    replanUntouchedL2(store, jobs, projectId, replanBranch, l2ChunkBudget, now, log);
  // Leave room for prior events and recent timeline headings added during load.
  const chunkBudget = l2ChunkBudget === undefined ? undefined : Math.max(500, l2ChunkBudget - 400);
  const pending = jobs.filter(j => j.target === "l2" && j.project_id && (!projectId || j.project_id === projectId))
    .sort((a, b) => cmp(a.project_id!, b.project_id!) || cmp(a.created_at, b.created_at) || cmp(a.job_id, b.job_id));
  const abortedParents = new Set(store.sets.filter(s => initialOpen.has(s.set_id) && s.status === "aborted").flatMap(parentIds));
  const eligible = (job: MaintenanceReadonly<DistillationJob>) => job.status === "pending" && !job.attempts && !job.leased_by && !job.leased_until &&
    !abortedParents.has(job.job_id) && !job.split_card_set && !job.l2_restructure && !job.maintenance_background_only &&
    !store.sets.some(s => parentIds(s).includes(job.job_id) && s.status !== "aborted");
  for (let index = 0; index < pending.length; index++) {
    const job = pending[index]!;
    if (!eligible(job)) continue;
    const parents = [job];
    let evidence = structuredClone(job.evidence) as DistillationJob["evidence"];
    let plan = planL2Chunks(evidence, chunkBudget);
    if ("background_only" in plan) {
      await mutateMaintenanceJob(deps.stateRoot, accountId, job.job_id, j => { if (j.status === "pending" && !j.split_card_set) j.maintenance_background_only = true; }); continue;
    }
    // Only consecutive main jobs share a set. Branch drafts, restructures and appends are barriers.
    if (!job.branch_id && !job.l2_append) for (let next = index + 1; next < pending.length; next++) {
      const candidate = pending[next]!;
      if (!eligible(candidate) || candidate.l2_append || candidate.project_id !== job.project_id || candidate.branch_id !== job.branch_id) break;
      const union = [...new Map([...evidence, ...structuredClone(candidate.evidence) as DistillationJob["evidence"]].map(item => [item.ref, item])).values()];
      const combined = planL2Chunks(union, chunkBudget);
      if ("background_only" in combined || combined.chunks.length !== 1 || cardEstTokens({ kind: "l2_chunk", instructions: maintenanceGenerators.get("l2_chunk")!.instructions, input: { items: union } }) > (chunkBudget ?? 6000)) break;
      parents.push(candidate); evidence = union; plan = combined; index = next;
    }
    if (!plan.chunks.length) continue;
    const setId = randomUUID(), generator = maintenanceGenerators.get("l2_chunk")!;
    const cards = generator.ensure({ accountId, projectId: job.project_id!, map: null, jobs: [{ ...job, evidence }], events: [], artifacts: artifactSnapshot(store, job.project_id!), ...(chunkBudget === undefined ? {} : { l2ChunkBudget: chunkBudget }) }, now)
      .map(draft => makeCard({ ...draft, instructions: generator.instructions, answer_schema: generator.answerSchema }, now));
    const claimed = await mutateMaintenanceJobs(deps.stateRoot, accountId, parents.map(j => j.job_id), current => {
      if (current.some((j, i) => !eligible(j) || parentFingerprint(j) !== parentFingerprint(parents[i]!))) return false;
      for (const j of current) { j.split_card_set = setId; if (parents.length > 1) j.maintenance_split_locked = true; }
      return true;
    });
    if (!claimed) continue;
    markMaintenanceDirty(store); store.cards.push(...cards);
    store.sets.push({ set_id: setId, parent_job_id: job.job_id, ...(parents.length > 1 ? { parent_job_ids: parents.map(j => j.job_id) } : {}),
      parent_fingerprints: Object.fromEntries(parents.map(j => [j.job_id, parentFingerprint(j)])), account_id: accountId, project_id: job.project_id!,
      ...(job.branch_id ? { branch_id: job.branch_id } : {}), card_ids: cards.map(c => c.card_id), status: "open", created_at: new Date(now).toISOString() });
  }
  jobs = await readDistillationJobsSnapshot(deps.stateRoot, accountId);
  // Claims must be durable before the cards checkpoint and its ledger signature.
  await flushDistillationJobs(deps.stateRoot);
  if (l2Only) return;
  const jobsSignature = await distillationJobsSignature(deps.stateRoot);
  const projects = await deps.runtime.projects.list(accountId);
  for (const project of projects.filter(p => !projectId || p.projectId === projectId)) {
    const current = await deps.runtime.architecture.inspectProjectCognitiveMap({ accountId, projectId: project.projectId });
    const fp = structureFingerprint(current.map);
    const artifacts = artifactSnapshot(store, project.projectId);
    for (const card of store.cards.filter(c => c.project_id === project.projectId && c.kind !== "l2_chunk" && c.kind !== "timeline_digest" && open(c))) {
      const fence = cardFence(card, current.map, fp, artifacts);
      if (card.fingerprint !== fence) supersede(card, now, log, store);
    }
    const storageIds = new Set(await deps.runtime.projects.storageIds(accountId, project.projectId));
    // Digest every completed L2 revision ref: robust to equal commit timestamps.
    const revisionRefs = jobs.filter(j => j.status === "completed" && j.target === "l2" && j.result_kind === "l2" &&
      j.result_id && j.result_content?.trim() && j.project_id && storageIds.has(j.project_id))
      .map(j => `l2:${j.result_id}:${j.job_id}`).sort();
    const headRef = revisionRefs.length ? createHash("sha256").update(revisionRefs.join("\n")).digest("hex") : null;
    const marker = store.generation[generationKey(project.projectId)];
    // Registering a new generator kind (e.g. after a deploy) must rerun generation once.
    const generators = [...maintenanceGenerators.keys()].sort().join(",");
    if (store.generation_jobs?.[generationKey(project.projectId)] !== jobsSignature) {
      markMaintenanceDirty(store); (store.generation_jobs ??= {})[generationKey(project.projectId)] = jobsSignature;
    }
    if (marker?.structure_fp === fp && marker.l2_head_ref === headRef && marker.generators === generators) {
      continue;
    }
    // Reuse the Control Plane's complete model assembly and canonical Core-head selection.
    const visual = await (deps.readVisualization ?? readMemoryControlData)({ ...deps, projects, projectId: project.projectId, kind: "visualization", includeTimelineBranches: false }) as MemoryVisualizationPayload;
    for (const card of store.cards.filter(c => c.project_id === project.projectId && c.kind === "timeline_digest" && open(c)))
      if (card.fingerprint !== currentTimelineBatchHash(card, visual.state.events, artifacts.get(TIMELINE_DIGEST_KEY))) supersede(card, now, log, store);
    const model = await buildProjectModel(deps.runtime, { stateRoot: deps.stateRoot, projectId: project.projectId, l2: [], todos: project.todos ?? [] });
    const architectureSources = current.map && [...maintenanceGenerators.values()].some(g => g.needs?.includes("architectureSources"))
      ? architectureDocRefs(project.projectId, await deps.runtime.architecture.listProjectArchitectureMarkdown({ accountId, projectId: project.projectId })).sources
      : undefined;
    const events = visual.state.events.map(event => ({ ...event, link_date: timelineLinkDate(event) }));
    const codeEvidence = current.map ? await deps.runtime.architecture.getProjectCodeCitations?.({ accountId, projectId: project.projectId,
      refs: current.map.source_evidence_refs }) ?? [] : [];
    for (const generator of maintenanceGenerators.values()) {
      if (generator.kind === "l2_chunk") continue;
      let count = store.cards.filter(c => c.project_id === project.projectId && c.kind === generator.kind && open(c)).length;
      for (const draft of generator.ensure({ accountId, projectId: project.projectId, model, map: current.map, jobs: jobs.filter(j => j.project_id && storageIds.has(j.project_id)), events, gaps: visual.quality.gaps, artifacts, ...(generator.needs?.includes("architectureSources") ? { architectureSources, codeEvidence } : {}) }, now)) {
        if ((generator.kind === "arch_link" && count >= 20) || (generator.kind === "gap_check" && count >= 10)) break;
        if (store.cards.some(c => c.key === draft.key)) continue;
        const card = makeCard({ ...draft, instructions: generator.instructions, answer_schema: generator.answerSchema }, now);
        // The fingerprint may have suffixes (review round/flag); match the target before it.
        const prior = store.cards.filter(c => c.status === "superseded" && c.kind === card.kind &&
          c.project_id === card.project_id && c.branch_id === card.branch_id && logicalTarget(c) === logicalTarget(card) && c.requested_at)
          .map(c => c.requested_at!).sort()[0];
        if (prior && (!card.requested_at || prior < card.requested_at)) card.requested_at = prior;
        if (card.est_tokens <= 8000) { store.cards.push(card); count++; }
      }
    }
    markMaintenanceDirty(store);
    store.generation[generationKey(project.projectId)] = { structure_fp: fp, l2_head_ref: headRef, generators, at: new Date(now).toISOString() };
  }
}
function logicalTarget(card: MaintenanceCard): string {
  const fingerprint = card.key.lastIndexOf(`:${card.fingerprint}`);
  if (fingerprint >= 0) return card.key.slice(0, fingerprint);
  // Reviews use a separate hash before their round/flag suffix.
  const match = /:[a-f0-9]{32,64}(?=(?::r[12](?::f.*)?)?$)/.exec(card.key);
  return match ? card.key.slice(0, match.index) : card.key;
}
export async function markRequested(input: MaintenanceDeps & ClockInput & { projectId: string; kinds: MaintenanceCardKind[] }): Promise<number> {
  const now = input.now ?? Date.now();
  return withMaintenanceStore(input.stateRoot, input.runtime.accountId, now, async (store, log, checkpoint) => {
    await ensureLocked(input, store, log, checkpoint, input.projectId, now);
    let count = 0;
    for (const card of store.cards) if (card.project_id === input.projectId && input.kinds.includes(card.kind) && open(card) && !card.requested_at) {
      markMaintenanceDirty(store); card.requested_at = new Date(now).toISOString(); card.updated_at = card.requested_at; count++;
    }
    return count;
  });
}
/** Informational metadata only: never generate, offer or lease a card. */
export async function maintenanceWaiting(input: { stateRoot: string; runtime: { accountId: string }; projectId?: string | null }) {
  if (!input.projectId) return;
  try {
    if ((await getMaintenanceConfig(input.stateRoot)).conversation_maintenance === "off") return;
    const store = await readMaintenanceStore(input.stateRoot, input.runtime.accountId);
    const requested = store.cards.filter(c => c.project_id === input.projectId && open(c) && c.requested_at).length;
    if (!requested) return;
    const result = { project: input.projectId, requested,
      note: `${requested} maintenance task(s) you requested are waiting; an agent with LITSAN can pick them up after answering (litsan_card action=next).` };
    if (Buffer.byteLength(JSON.stringify(result)) <= 240) return result;
  } catch (error) {
    console.error("[litsan] maintenance waiting:", error instanceof Error ? error.message : String(error));
  }
}
export async function ensureCards(input: MaintenanceDeps & ClockInput & { projectId?: string }) {
  const now = input.now ?? Date.now();
  await withMaintenanceStore(input.stateRoot, input.runtime.accountId, now, (store, log, checkpoint) => ensureLocked(input, store, log, checkpoint, input.projectId, now));
}
async function summary(deps: { stateRoot: string; runtime: { accountId: string } }, store: MaintenanceStore, projectId: string | undefined, now: number) {
  const cards = store.cards.filter(c => !projectId || c.project_id === projectId), sets = store.sets.filter(s => !projectId || s.project_id === projectId);
  const day = new Date(now).toISOString().slice(0, 10);
  const logs = (await readMaintenanceLog(deps.stateRoot, deps.runtime.accountId)).filter(e => e.ts.startsWith(day) && (!projectId || e.project === projectId));
  const kinds = Object.fromEntries((["l2_chunk", "arch_link", "gap_check", "arch_review", "timeline_digest"] as const).map(kind => [kind, {
    pending: cards.filter(c => c.kind === kind && (c.status === "pending" || (c.status === "leased" && Date.parse(c.lease!.until) <= now))).length,
    ...(cards.some(c => c.kind === kind && c.status === "pending" && c.inline_retry_after && Date.parse(c.inline_retry_after) > now)
      ? { inline_deferred: cards.filter(c => c.kind === kind && c.status === "pending" && c.inline_retry_after && Date.parse(c.inline_retry_after) > now).length } : {}),
    requested_pending: cards.filter(c => c.kind === kind && open(c) && c.requested_at).length,
    leased: cards.filter(c => c.kind === kind && c.status === "leased" && Date.parse(c.lease!.until) > now).length,
    accepted_today: logs.filter(e => e.kind === kind && e.outcome === "accepted").length,
    rejected_today: logs.filter(e => e.kind === kind && e.outcome === "rejected").length
  }]));
  const pending = cards.filter(c => c.status === "pending" || (c.status === "leased" && Date.parse(c.lease!.until) <= now));
  const branchSetsOpen = sets.filter(s => s.status === "open" && Boolean(s.branch_id)).length;
  return { kinds, oldest_pending_age_h: pending.length ? Math.round(Math.max(0, now - Math.min(...pending.map(c => Date.parse(c.created_at)))) / 36000) / 100 : 0,
    split_jobs: { open: sets.filter(s => s.status === "open").length, merged_today: sets.filter(s => s.status === "merged" && s.merged_at?.startsWith(day)).length, aborted: sets.filter(s => s.status === "aborted").length },
    ...(branchSetsOpen > 0 ? { branch_sets_open: branchSetsOpen } : {}),
    background_only_jobs: (await readDistillationJobsSnapshot(deps.stateRoot, deps.runtime.accountId)).filter(j => j.status === "pending" && j.maintenance_background_only && (!projectId || j.project_id === projectId)).length,
    est_tokens_today: logs.filter(e => e.outcome === "accepted").reduce((sum, e) => sum + e.est_tokens, 0) };
}
export function queueStatus(input: { stateRoot: string; runtime: { accountId: string }; now?: number; projectId?: string; dry: true }): ReturnType<typeof summary>;
export function queueStatus(input: MaintenanceDeps & ClockInput & { projectId?: string; dry?: boolean }): ReturnType<typeof summary>;
export async function queueStatus(input: { stateRoot: string; runtime: { accountId: string }; now?: number; projectId?: string; dry?: boolean }) {
  const now = input.now ?? Date.now();
  if (!input.dry) await ensureCards({ ...input, now } as MaintenanceDeps & ClockInput);
  return summary(input, await readMaintenanceStore(input.stateRoot, input.runtime.accountId), input.projectId, now);
}
function sequentialReady(store: MaintenanceStore, card: MaintenanceCard): boolean {
  if (card.kind !== "l2_chunk" || !card.chunk?.index) return true;
  const set = store.sets.find(s => s.status === "open" && s.card_ids.includes(card.card_id));
  return Boolean(set && store.cards.some(c => set.card_ids.includes(c.card_id) && c.chunk?.index === card.chunk!.index - 1 && c.status === "accepted"));
}
function priorEvents(store: MaintenanceStore, card: MaintenanceCard): NonNullable<L2ChunkInput["prior_events"]> {
  const set = store.sets.find(s => s.card_ids.includes(card.card_id));
  return store.cards.filter(c => set?.card_ids.includes(c.card_id) && c.status === "accepted" && (c.chunk?.index ?? 0) < (card.chunk?.index ?? 0))
    .sort((a, b) => a.chunk!.index - b.chunk!.index)
    .flatMap(c => ((c.result as L2ChunkAnswer)?.events ?? []).map(event => ({ key: normalizeL2EventKey(event.date + " " + event.title_en), date: event.date, title_en: event.title_en })));
}
async function leaseInput(deps: MaintenanceDeps, store: MaintenanceStore, card: MaintenanceCard): Promise<MaintenanceCard["input"]> {
  if (card.kind !== "l2_chunk") return card.input;
  const model = await buildProjectModel(deps.runtime, { stateRoot: deps.stateRoot, projectId: card.project_id, l2: [], todos: [] });
  const latest = [...model.revisions].sort((a, b) => cmp(a.committed_at, b.committed_at) || cmp(a.ref.split(":").at(-1)!, b.ref.split(":").at(-1)!)).at(-1);
  return { ...card.input, prior_events: priorEvents(store, card), base_recent: datedL2Headings(latest?.content ?? "").slice(-5) };
}
function inlineEligible(card: MaintenanceCard): boolean {
  return card.kind === "l2_chunk" || card.kind === "timeline_digest" || card.kind === "arch_review" && (card.input as { review_round?: number }).review_round === 1;
}
function deferSkippedInline(card: MaintenanceCard, now: number): void {
  card.inline_skips = Math.min((card.inline_skips ?? 0) + 1, 8);
  card.inline_retry_after = new Date(now + Math.min(6 * 3600000, 300000 * 2 ** (card.inline_skips - 1))).toISOString();
}
export async function loadInlineCard(input: MaintenanceDeps & ClockInput & { projectId: string; inlineTurnId: string; inlineBranchId: string; cardId: string; leaseToken: string }) {
  const now = input.now ?? Date.now(), store = await readMaintenanceStore(input.stateRoot, input.runtime.accountId);
  const card = store.cards.find(c => c.card_id === input.cardId);
  if (!card || !inlineEligible(card) || card.project_id !== input.projectId || (card.branch_id ?? "main") !== input.inlineBranchId ||
    card.status !== "leased" || !card.lease || card.lease.owner !== inlineTurnOwner(input.inlineTurnId) ||
    card.lease.token !== input.leaseToken || Date.parse(card.lease.until) <= now || await currentFingerprint(input, card, store) !== card.fingerprint)
    return { ok: false, code: "card_unavailable" };
  const cardInput = await leaseInput(input, store, card);
  const est_tokens = cardEstTokens({ ...card, input: cardInput });
  if (card.lease.inline_token_budget !== undefined && est_tokens > card.lease.inline_token_budget)
    return { ok: false, code: "card_too_large" };
  try {
    await appendMaintenanceLog(input.stateRoot, input.runtime.accountId,
      [entry(card, now, "loaded", { harness: card.lease.owner, profile: { execution: "inline" } }, { est_tokens })], now);
  } catch (error) { console.error("[litsan] inline maintenance load audit:", error instanceof Error ? error.message : String(error)); }
  const { card_id, kind, project_id, fingerprint, instructions, allowed_refs, answer_schema } = card;
  return { ok: true, card: { card_id, kind, project_id, est_tokens, fingerprint, instructions,
    input: cardInput, allowed_refs, answer_schema, lease_token: card.lease.token, lease_until: card.lease.until } };
}
function currentCardView(card: MaintenanceCard): MaintenanceCard {
  if (card.kind === "arch_review" || card.kind === "timeline_digest") {
    const instructions = maintenanceGenerators.get(card.kind)?.instructions;
    if (!instructions || card.instructions === instructions) return card;
    const updated = { ...card, instructions };
    return { ...updated, est_tokens: cardEstTokens(updated) };
  }
  if (card.kind !== "l2_chunk" || card.instructions === L2_INSTRUCTIONS) return card;
  const updated = { ...card, instructions: L2_INSTRUCTIONS };
  const estTokens = cardEstTokens(updated);
  return estTokens <= 8000 ? { ...updated, est_tokens: estTokens } : card;
}
function selectCard(store: MaintenanceStore, input: { cardId?: string; projectId?: string; kinds?: MaintenanceCardKind[]; restrictProject?: boolean; inline?: boolean; inlineBranchId?: string; inlineSameTurn?: boolean }, maxCardTokens: number, now: number) {
  const priority: Record<MaintenanceCardKind, number> = { l2_chunk: 0, arch_link: 1, gap_check: 2, timeline_digest: 3, arch_review: 4 };
  const available = store.cards.filter(c => open(c) && (!c.lease || Date.parse(c.lease.until) <= now) && sequentialReady(store, c) &&
    (input.inlineBranchId === undefined || (c.branch_id ?? "main") === input.inlineBranchId) &&
    (!input.inlineSameTurn || inlineEligible(c) && !(Date.parse(c.inline_retry_after ?? "") > now)));
  let card: MaintenanceCard | undefined;
  if (input.cardId) {
    card = available.find(c => c.card_id === input.cardId);
    if (!card) throw new Error("card unavailable for account");
    if (input.projectId && card.project_id !== input.projectId) throw new Error("wrong_project");
    if (currentCardView(card).est_tokens > maxCardTokens || input.inline && card.kind === "l2_chunk") throw new Error("card_too_large");
  // An explicit project on next() is a filter, never just a preference (offers pass a pre-scoped store instead).
  } else card = available.filter(c => !(input.inline && c.kind === "l2_chunk") && (!input.kinds || input.kinds.includes(c.kind)) && currentCardView(c).est_tokens <= maxCardTokens &&
      (!input.restrictProject || !input.projectId || c.project_id === input.projectId))
    .sort((a, b) => Number(Boolean(b.requested_at)) - Number(Boolean(a.requested_at)) ||
      (a.requested_at && b.requested_at ? cmp(a.requested_at, b.requested_at) : 0) || Number(b.project_id === input.projectId) - Number(a.project_id === input.projectId) ||
      priority[a.kind] - priority[b.kind] || cmp(a.created_at, b.created_at) || cmp(a.card_id, b.card_id))[0];
  return card;
}
export async function nextCard(input: MaintenanceDeps & ClockInput & Actor & { cardId?: string; projectId?: string; kinds?: MaintenanceCardKind[]; leaseSeconds?: number; inlineL2MaxTokens?: number; inlineBranchId?: string; resumeInlineOnly?: boolean }) {
  const now = input.now ?? Date.now(), profile = normalizeClientProfile(input.profile);
  const cap = input.inlineL2MaxTokens === undefined ? profile.max_card_tokens : Math.min(8000, input.inlineL2MaxTokens);
  return withMaintenanceStore(input.stateRoot, input.runtime.accountId, now, async (store, log, checkpoint) => {
    await ensureLocked(input, store, log, checkpoint, input.projectId, now, input.inlineL2MaxTokens !== undefined, input.inlineL2MaxTokens === undefined ? undefined : cap,
      input.resumeInlineOnly ? undefined : input.inlineBranchId);
    if (input.inlineL2MaxTokens !== undefined && !input.resumeInlineOnly) {
      for (const card of store.cards) {
        if (card.project_id !== input.projectId || (card.branch_id ?? "main") !== input.inlineBranchId || card.status !== "leased" ||
          !card.lease?.owner.startsWith("memhub-in-turn:") || Date.parse(card.lease.until) > now) continue;
        log(entry(card, now, "expired", { harness: card.lease.owner, profile: { execution: "inline" } }));
        markMaintenanceDirty(store); deferSkippedInline(card, now); card.status = "pending";
        card.updated_at = new Date(now).toISOString(); delete card.lease;
      }
    }
    const held = input.inlineL2MaxTokens !== undefined && input.harness ? store.cards.find(c => inlineEligible(c) &&
      c.project_id === input.projectId && (c.branch_id ?? "main") === input.inlineBranchId && c.status === "leased" &&
      c.lease && c.lease.owner === input.harness && Date.parse(c.lease.until) > now) : undefined;
    if (held) {
      const budget = Math.min(cap, held.lease!.inline_token_budget ?? 8000);
      if (held.lease!.inline_token_budget !== budget) { markMaintenanceDirty(store); held.lease!.inline_token_budget = budget; }
      if (currentCardView(held).est_tokens > budget) return { card: null, queue: await summary(input, store, input.projectId, now) };
      const { card_id, kind, project_id, est_tokens, fingerprint, instructions, allowed_refs, answer_schema } = held;
      return { card: { card_id, kind, project_id, est_tokens, fingerprint, instructions, allowed_refs, answer_schema, lease_token: held.lease!.token, lease_until: held.lease!.until }, resumed: true };
    }
    const selection = { ...input, restrictProject: true, inlineSameTurn: input.inlineL2MaxTokens !== undefined,
      inline: profile.execution === "inline" && input.inlineL2MaxTokens === undefined };
    let card = input.resumeInlineOnly ? undefined : selectCard(store, selection, cap, now);
    if (!card && !input.resumeInlineOnly && input.inlineL2MaxTokens !== undefined && input.inlineBranchId === "main" && (input.kinds?.includes("arch_review") || input.kinds?.includes("timeline_digest"))) {
      await ensureLocked(input, store, log, checkpoint, input.projectId, now, false, input.inlineL2MaxTokens === undefined ? undefined : cap);
      card = selectCard(store, selection, cap, now);
    }
    if (card?.kind === "timeline_digest" && await currentFingerprint(input, card, store) !== card.fingerprint) {
      supersede(card, now, log, store);
      delete store.generation[generationKey(card.project_id)];
      await ensureLocked(input, store, log, checkpoint, input.projectId, now, false, input.inlineL2MaxTokens === undefined ? undefined : cap);
      card = input.cardId ? undefined : selectCard(store, selection, cap, now);
    }
    if (!card) return { card: null, queue: await summary(input, store, input.projectId, now) };
    const view = currentCardView(card);
    card.instructions = view.instructions; card.est_tokens = view.est_tokens;
    if (card.lease) log(entry(card, now, "expired", input));
    markMaintenanceDirty(store); card.status = "leased"; card.attempts++; card.updated_at = new Date(now).toISOString();
    const seconds = Number.isFinite(input.leaseSeconds) ? Math.max(30, Math.min(900, Math.trunc(input.leaseSeconds!))) : 300;
    card.lease = { token: randomUUID(), owner: input.harness ?? "mcp-harness", model: profile.model, profile: profile.execution,
      ...(input.inlineL2MaxTokens === undefined ? {} : { inline_token_budget: cap }), until: new Date(now + seconds * 1000).toISOString() };
    log(entry(card, now, "leased", input));
    const { card_id, kind, project_id, est_tokens, fingerprint, instructions, allowed_refs, answer_schema } = card;
    return { card: { card_id, kind, project_id, est_tokens, fingerprint, instructions,
      ...(input.inlineL2MaxTokens === undefined ? { input: await leaseInput(input, store, card) } : {}),
      allowed_refs, answer_schema, lease_token: card.lease.token, lease_until: card.lease.until } };
  });
}
function cardFence(card: MaintenanceCard, map: ArchitectureCognitiveMap | null, structureFp: string, artifacts: ReturnType<typeof artifactSnapshot>): string {
  if (card.kind === "gap_check") return gapCheckFingerprint(map, (card.input as GapCheckInput).node.id);
  const generator = maintenanceGenerators.get(card.kind);
  return generator?.fence ? generator.fence(card, map, artifacts) : structureFp;
}
async function currentFingerprint(deps: MaintenanceDeps, card: MaintenanceCard, store: MaintenanceStore): Promise<string> {
  if (card.kind === "timeline_digest") {
    const projects = await deps.runtime.projects.list(deps.runtime.accountId);
    const visual = await (deps.readVisualization ?? readMemoryControlData)({ ...deps, projects, projectId: card.project_id, kind: "visualization", includeTimelineBranches: false }) as MemoryVisualizationPayload;
    return currentTimelineBatchHash(card, visual.state.events, artifactSnapshot(store, card.project_id).get(TIMELINE_DIGEST_KEY));
  }
  if (card.kind !== "l2_chunk") {
    const map = (await deps.runtime.architecture.inspectProjectCognitiveMap({ accountId: deps.runtime.accountId, projectId: card.project_id })).map;
    return cardFence(card, map, structureFingerprint(map), artifactSnapshot(store, card.project_id));
  }
  const jobs = await readDistillationJobsSnapshot(deps.stateRoot, deps.runtime.accountId);
  const set = store.sets.find(s => s.status === "open" && s.card_ids.includes(card.card_id));
  if (!set || !parentsMatch(set, jobs)) return "<stale>";
  const parent = jobs.find(j => j.job_id === card.parent_job_id);
  return parent?.status === "pending" && parent.split_card_set ? chunkFingerprint(parent.evidence_hash, card.allowed_refs) : "<stale>";
}
function textFields(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(textFields);
  if (value && typeof value === "object") return Object.values(value).flatMap(textFields);
  return [];
}
export async function submitCard(input: MaintenanceDeps & ClockInput & Actor & { cardId: string; leaseToken: string; answer: unknown; project?: string; workspaceProject?: string; inlineTurnId?: string; inlineBranchId?: string }) {
  const now = input.now ?? Date.now();
  return withMaintenanceStore(input.stateRoot, input.runtime.accountId, now, async (store, log, checkpoint) => {
    const card = store.cards.find(c => c.card_id === input.cardId);
    // Do not read or mutate another account's card (including its lease or rejection counter).
    if (!card) {
      log({ ts: new Date(now).toISOString(), account: input.runtime.accountId, card_id: input.cardId, kind: "arch_review", project: "<unknown>",
        harness: input.harness ?? "mcp-harness", profile: normalizeClientProfile(input.profile).execution, via: "direct", outcome: "rejected",
        reason_code: "wrong_account", est_tokens: 0, answer_chars: 0 });
      return { ok: false, code: "wrong_account", detail: "card unavailable for account" };
    }
    if (input.inlineTurnId) {
      if (!inlineEligible(card)) return { ok: false, code: "unsupported_kind", detail: "card cannot run inside a user turn" };
      if (!input.project || card.project_id !== input.project || (card.branch_id ?? "main") !== (input.inlineBranchId ?? "main"))
        return { ok: false, code: "wrong_project", detail: "card unavailable for this turn" };
      if (card.status === "accepted" && card.inline_receipt?.event_id === input.inlineTurnId &&
        card.inline_receipt.lease_hash === createHash("sha256").update(input.leaseToken).digest("hex") && isDeepStrictEqual(card.result, input.answer)) {
        const set = store.sets.find(s => s.card_ids.includes(card.card_id));
        return { ok: true, card_id: card.card_id, status: card.status, already_accepted: true, ...(set ? { set_status: set.status } : {}) };
      }
    }
    let answerChars = 0;
    try { answerChars = JSON.stringify(input.answer)?.length ?? 0; } catch { /* validation reports non-JSON */ }
    const reject = async (code: MaintenanceRejectCode, detail: string) => {
      log(entry(card, now, "rejected", input, { reason_code: code, detail, answer_chars: answerChars }));
      if (["wrong_account", "wrong_project", "card_not_leased", "lease_expired", "lease_token_stale"].includes(code)) return { ok: false, code, detail };
      markMaintenanceDirty(store); card.rejections++; card.updated_at = new Date(now).toISOString();
      // One same-turn format correction avoids a new claim; never extend the lease or relax evidence validation.
      if (input.inlineTurnId && card.kind === "l2_chunk" && card.status === "leased" && card.rejections === 1 &&
        ["schema_invalid", "bilingual_missing", "oversize"].includes(code)) {
        return { ok: false, code, detail, retryable: true, lease_retained: true,
          next_action: "Correct the answer using answer_schema and resubmit once with the same identifiers. Do not claim another card.", answer_schema: card.answer_schema };
      }
      if (code === "stale_fingerprint" && card.kind === "l2_chunk") {
        const set = store.sets.find(s => s.status === "open" && s.card_ids.includes(card.card_id));
        if (set) await abortSet(input, store, set, now, log);
      }
      // Terminal answers cannot be erased by a replay or a stale submit.
      if (open(card)) { card.status = "pending"; delete card.lease; }
      if (card.kind === "l2_chunk" && card.rejections >= 3 && open(card)) {
        const set = store.sets.find(s => s.card_ids.includes(card.card_id) && s.status === "open");
        if (set) {
          await abortSet(input, store, set, now, log, true);
        }
      }
      return { ok: false, code, detail };
    };
    const ctx = { accountId: input.runtime.accountId, project: input.project, workspaceProject: input.workspaceProject,
      now, leaseToken: input.leaseToken, harness: input.harness ?? "mcp-harness" };
    // Authenticate project and lease before reading project-specific state.
    // Keep a superseded holder's lease only to authenticate its stale submission.
    const contextualCard = card.kind === "l2_chunk" ? { ...card, input: { ...card.input, prior_events: priorEvents(store, card) } } : card;
    const validationCard = card.status === "superseded" && card.lease ? { ...contextualCard, status: "leased" as const } : contextualCard;
    let checked = validateCardAnswer(validationCard, input.answer, card.status === "superseded" ? { ...ctx, fingerprint: "<stale>" } : ctx);
    if (!checked.ok) return reject(checked.code, checked.detail);
    const fingerprint = await currentFingerprint(input, card, store);
    checked = validateCardAnswer(contextualCard, input.answer, { ...ctx, fingerprint });
    if (!checked.ok) return reject(checked.code, checked.detail);
    try { for (const field of textFields(checked.normalized)) if (field.trim()) validateDurableMemoryContent(field); }
    catch { return reject("contaminated", "answer contains unsafe durable-memory text"); }
    const answer = checked.normalized;
    const generator = maintenanceGenerators.get(card.kind);
    if (!generator) return reject("unsupported_kind", "no generator registered for this kind");
    const ports: MaintenanceApplyPorts = {
      artifacts: {
        read: async key => structuredClone(store.artifacts?.[JSON.stringify([card.project_id, key])]),
        write: async (key, value) => {
          markMaintenanceDirty(store);
          (store.artifacts ??= {})[JSON.stringify([card.project_id, key])] = structuredClone(value);
          // Artifacts can unlock follow-up cards (e.g. review round 2); rerun generation on the next pull.
          delete store.generation[generationKey(card.project_id)];
        }
      },
      map: {
        read: () => input.runtime.architecture.inspectProjectCognitiveMap({ accountId: input.runtime.accountId, projectId: card.project_id }),
        write: async (value, expectedFingerprint) => {
          const candidate = parseArchitectureCognitiveMapCandidate(value);
          const map = buildArchitectureCognitiveMap({ projectId: card.project_id, candidate,
            sourceEvidenceRefs: value.source_evidence_refs, previousMap: value, generatedAt: value.generated_at });
          await input.runtime.architecture.writeProjectCognitiveMap({ accountId: input.runtime.accountId, projectId: card.project_id, expectedFingerprint, map });
        }
      },
      submitL2Chunk: async () => {
        const set = store.sets.find(s => s.status === "open" && s.card_ids.includes(card.card_id));
        if (!set) return { ok: false, code: "stale_fingerprint", detail: "card set is no longer open" };
        const stale = new Error("parent changed before chunk acceptance");
        try {
          await mutateMaintenanceJobs(input.stateRoot, input.runtime.accountId, parentIds(set), parents => {
            if (!parentsMatch(set, parents) || parents.some(p => p.status !== "pending") ||
              card.fingerprint !== chunkFingerprint(parents[0]!.evidence_hash, card.allowed_refs)) throw stale;
            for (const parent of parents) parent.maintenance_split_locked = true;
          });
        } catch (error) {
          if (error !== stale) throw error;
          return { ok: false, code: "stale_fingerprint", detail: stale.message };
        }
        return { ok: true };
      }
    };
    const actor = { harness: card.lease!.owner, model: card.lease!.model, profile: card.lease!.profile ?? "inline" as const };
    const applied = await generator.apply(card, answer, ports, actor, now);
    if (!applied.ok) return reject(applied.code, applied.detail);
    markMaintenanceDirty(store); card.status = "accepted"; card.result = answer; card.accepted_at = new Date(now).toISOString(); card.updated_at = card.accepted_at;
    delete card.inline_skips; delete card.inline_retry_after;
    if (input.inlineTurnId) card.inline_receipt = { event_id: input.inlineTurnId, lease_hash: createHash("sha256").update(input.leaseToken).digest("hex") };
    delete card.lease;
    // Refill the bounded link batch on the next pull, without rebuilding between sibling cards.
    if (card.kind === "arch_link" && !store.cards.some(c => c.project_id === card.project_id && c.kind === "arch_link" && open(c)))
      delete store.generation[generationKey(card.project_id)];
    log(entry(card, now, "accepted", { harness: actor.harness, profile: { execution: actor.profile, model: actor.model } }, { answer_chars: answerChars }));
    // Save acceptance before attempting a merge; recover from a crashed Core call on next/ensure.
    await checkpoint();
    const set = store.sets.find(s => s.card_ids.includes(card.card_id) && s.status === "open");
    const mergeError = set ? await mergeSet(input, store, set, now, log, checkpoint) : undefined;
    return { ok: true, card_id: card.card_id, status: card.status, ...(set ? { set_status: set.status } : {}), ...(mergeError ? { merge_error: mergeError } : {}) };
  });
}
export async function releaseCard(input: MaintenanceDeps & ClockInput & Actor & { cardId: string; leaseToken: string }) {
  const now = input.now ?? Date.now();
  return withMaintenanceStore(input.stateRoot, input.runtime.accountId, now, async (store, log) => {
    const card = store.cards.find(c => c.card_id === input.cardId);
    if (!card) return { ok: false, code: "wrong_account" };
    if (card.status !== "leased" || !card.lease) return { ok: false, code: "card_not_leased" };
    if (card.lease.token !== input.leaseToken || (input.harness !== undefined && card.lease.owner !== input.harness)) return { ok: false, code: "lease_token_stale" };
    markMaintenanceDirty(store);
    if (card.lease.owner.startsWith("memhub-in-turn:")) deferSkippedInline(card, now);
    card.status = "pending"; card.updated_at = new Date(now).toISOString(); delete card.lease;
    log(entry(card, now, "released", input));
    return { ok: true, card_id: card.card_id, status: card.status };
  });
}

interface PeekInput extends MaintenanceDeps, ClockInput {
  projectId: string; maxCardTokens: number; inline?: boolean; crossProject?: boolean; optedOutProjects?: string[];
}
async function warmGeneration(input: PeekInput, store: MaintenanceStore): Promise<boolean> {
  const marker = store.generation[generationKey(input.projectId)];
  if (!marker || store.generation_jobs?.[generationKey(input.projectId)] !== await distillationJobsSignature(input.stateRoot) ||
    marker.generators !== [...maintenanceGenerators.keys()].sort().join(",")) return false;
  if (store.sets.some(s => s.project_id === input.projectId && s.status === "open" &&
    s.card_ids.every(id => store.cards.find(c => c.card_id === id)?.status === "accepted"))) return false;
  const current = await input.runtime.architecture.inspectProjectCognitiveMap({ accountId: input.runtime.accountId, projectId: input.projectId });
  return marker.structure_fp === structureFingerprint(current.map);
}
function selectPeek(input: PeekInput, store: MaintenanceStore, now: number) {
  const scoped = { ...store, cards: store.cards.filter(c => (input.crossProject || c.project_id === input.projectId) && !input.optedOutProjects?.includes(c.project_id)) };
  return selectCard(scoped, { projectId: input.projectId, inline: input.inline ?? input.maxCardTokens <= 2000 }, input.maxCardTokens, now);
}
export async function peekCard(input: PeekInput) {
  const now = input.now ?? Date.now(), existing = await readMaintenanceStore(input.stateRoot, input.runtime.accountId);
  if (await warmGeneration(input, existing)) return selectPeek(input, existing, now) ?? null;
  return withMaintenanceStore(input.stateRoot, input.runtime.accountId, now, async (store, log, checkpoint) => {
    await ensureLocked(input, store, log, checkpoint, input.projectId, now);
    const card = selectPeek(input, store, now);
    return card ? structuredClone(card) : null;
  });
}
export async function offerForCommit(input: MaintenanceDeps & ClockInput & Actor & { turn: MaintenanceOfferTurn }): Promise<MaintenanceOffer | undefined> {
  try {
    const now = input.now ?? Date.now(), config = await getMaintenanceConfig(input.stateRoot);
    if (config.conversation_maintenance === "off") return;
    return await withMaintenanceOfferState(input.stateRoot, input.runtime.accountId, now, async state => {
      const decision = decideOffer({ config, profile: input.profile, turn: input.turn, state, now });
      // Eligible commits advance the inline counter even when there is no fitting card.
      if (!decision.offer && !["throttled", "daily_cap"].includes(decision.reason)) return;
      const key = input.turn.continuityId;
      const continuity = Object.hasOwn(state.by_continuity, key) ? state.by_continuity[key]! : { committed_turns_since_offer: 0, last_offer_at: null };
      delete state.by_continuity[key];
      state.by_continuity = { ...state.by_continuity, [key]: continuity };
      continuity.committed_turns_since_offer++;
      if (!decision.offer) return;
      const mode = config.conversation_maintenance as "quiet" | "visible";
      const card = await peekCard({ ...input, projectId: input.turn.projectId!, maxCardTokens: decision.maxCardTokens,
        inline: normalizeClientProfile(input.profile).execution === "inline", crossProject: decision.projectScope === "any", optedOutProjects: config.opted_out_projects, now });
      let offer: MaintenanceOffer | undefined;
      if (card) {
        const view = currentCardView(card);
        const rule = config.offer_style !== "optional" && normalizeClientProfile(input.profile).execution === "delegate"
          ? `After your answer: hand this card to a cheap subagent now (litsan_card action=next card_id=${card.card_id} → answer from the card only → submit). Do not mention it; never change or delay your answer.`
          : "Optional. After your answer is complete; delegate to a cheap subagent if you can; never change or delay the answer; " +
            (mode === "quiet" ? "do not mention unless asked." : "you may add one short line that you did it.");
        const result: MaintenanceOffer = { card_id: card.card_id, kind: card.kind, project: card.project_id, est_tokens: view.est_tokens,
          call: `litsan_card action=next card_id=${card.card_id}`, mode, rule };
        if (Buffer.byteLength(JSON.stringify(result), "utf8") <= 400) {
          await appendMaintenanceLog(input.stateRoot, input.runtime.accountId, [entry(view, now, "offered", input, { via: "offer" })], now);
          offer = result;
        }
      }
      if (offer) {
        state.cards_offered++; state.est_tokens_offered += offer.est_tokens;
        continuity.committed_turns_since_offer = 0; continuity.last_offer_at = new Date(now).toISOString();
      }
      return offer;
    });
  } catch (error) {
    console.error("[litsan] turn maintenance offer:", error);
    return;
  }
}
