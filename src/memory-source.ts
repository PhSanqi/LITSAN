import { filterBranchL1Hits, listFreshBranchEvidence } from "./workstream-retrieval.js";
import type { DistilledArtifactKind } from "./contracts/memory.js";
export type { DistilledArtifactKind } from "./contracts/memory.js";
import { createHash } from "node:crypto";
import type { ContextItem } from "./context-capsule.js";
import { listExplicitGlobalCaptureEvents, listFreshCaptureEvidence } from "./capture.js";
import { captureCoreRawTurnId, captureTurnId } from "./capture-ingest.js";
import { latestCompletedL3ByProject, listDistillationJobs, type DistillationJob } from "./distillation-jobs.js";
import type { LocalMemoryRestClient, RecallHit, RuntimeNamespace } from "./local-memory-client.js";
import { latestCanonicalL2 } from "./core/lifecycle/l2-restructure.js";
import { selectLitsanCoreHits } from "./litsan-core.js";
import {
  rankRecallHits,
  tokenizeRetrievalText,
  type RankedRecallHit,
  type RetrievalCandidateDecision,
  type RetrievalRankDiagnostics
} from "./retrieval-ranker.js";
import { compactSkillContextItem } from "./skill-router.js";
import { buildRetrievalScopeEnvelope, type RetrievalScopeEnvelope } from "./project-scope.js";
import { globalStateAdmission, globalStateContextItem, latestCompletedGlobalState } from "./global-state.js";
import { distillationExclusion } from "./core/lifecycle/distillation-eligibility.js";

interface SearchResponseLike {
  hits?: RecallHit[];
  status?: string[];
  debug?: {
    hits?: RecallHit[];
    status?: string[];
  };
}

export interface ContextMemorySource {
  recall(input: ContextRecallInput): Promise<{
    globalMemory: ContextItem[];
    globalState: ContextItem[];
    projectMemory: ContextItem[];
    reusableSkills: ContextItem[];
    diagnostics?: ContextRecallDiagnostics;
  }>;
}

export interface ContextRecallInput {
    accountId: string;
    userId: string;
    query: string;
    scope?: RetrievalScopeEnvelope;
    /** @deprecated compatibility adapter; production routing supplies scope. */
    projectId?: string | null;
    /** @deprecated compatibility adapter; production routing supplies scope. */
    projectStorageIds?: readonly string[];
    conversationId?: string;
    continuityId?: string;
    workstreamBranchId?: string;
    limit: number;
    /** @deprecated compatibility adapter; production routing supplies scope. */
    reusableSkillProjectIds?: readonly string[];
}

import type { ContextRecallDiagnostics, RetrievalRankingMode } from "./contracts/retrieval.js";
export type { ContextRecallDiagnostics, RetrievalRankingMode } from "./contracts/retrieval.js";

export const FRESH_L1_MAX = 4;
const FRESH_L1_CHARS = 600;

export class MemoryRestContextSource implements ContextMemorySource {
  constructor(
    private readonly client: LocalMemoryRestClient,
    private readonly stateRoot?: string,
    private readonly rankingMode: RetrievalRankingMode = "memhub_v1"
  ) {}

  async recall(input: ContextRecallInput): Promise<{
    globalMemory: ContextItem[];
    globalState: ContextItem[];
    projectMemory: ContextItem[];
    reusableSkills: ContextItem[];
    diagnostics: ContextRecallDiagnostics;
  }> {
    const requestedLimit = Math.max(1, Math.min(50, input.limit));
    const finalLimit = Math.min(12, requestedLimit);
    const unifiedCore = this.rankingMode === "memhub_core";
    const candidateLimit = unifiedCore
      ? finalLimit
      : Math.min(50, Math.max(12, finalLimit * 4));
    const rankLane = (hits: readonly RecallHit[]) => unifiedCore
      ? selectLitsanCoreHits(hits, input.query, finalLimit)
      : rankRecallHits(hits, input.query, finalLimit);
    const coreStatus: string[] = [];
    const search = async (projectId: string | null, filters: {
      layers?: string[];
      tags?: string[];
      limit?: number;
      accountWide?: boolean;
      projectIds?: readonly string[];
    } = {}) => {
      const response = await this.search({
        accountId: input.accountId,
        userId: input.userId,
        query: input.query,
        projectId,
        conversationId: input.conversationId,
        limit: input.limit
      }, projectId, filters);
      coreStatus.push(...statusFromResponse(response));
      return response;
    };
    const globalResponse = await search(null, { layers: ["L4"], limit: candidateLimit });
    const globalHits = hitsFromResponse(globalResponse)
      .filter((hit) => hit.tags.includes("global"));
    const rankedGlobal = rankLane(globalHits);
    const globalIds = new Set(rankedGlobal.hits.map(({ hit }) => hit.id));
    const globalMemory = rankedGlobal.hits.map((ranked) => contextItemFromRankedHit(ranked, "global", undefined, rankedGlobal.diagnostics));
    const scope = input.scope ?? buildRetrievalScopeEnvelope({
      accountId: input.accountId,
      resolution: input.projectId
        ? { projectId: input.projectId, source: "deterministic_binding", recallScope: "global_and_project", candidates: [input.projectId], evidence: ["legacy recall adapter"] }
        : { projectId: null, source: "none", recallScope: "global_only", candidates: [], evidence: ["legacy recall adapter"] },
      projectStorageIds: input.projectStorageIds,
      reusableSkillProjectIds: input.reusableSkillProjectIds,
      crossProjectSkillAllowed: (input.reusableSkillProjectIds?.length ?? 0) > 0
    });
    if (scope.accountId !== input.accountId) throw new Error("retrieval scope/account mismatch");
    const queryTerms = tokenizeRetrievalText(input.query).slice(0, 32);
    const globalState: ContextItem[] = [];
    const explicitGlobalIds = new Set<string>();
    let globalStateDiagnostics = emptyGlobalStateDiagnostics(queryTerms, unifiedCore ? "memhub_core" : "memhub_v1");
    if (this.stateRoot) {
      const jobs = await listDistillationJobs(this.stateRoot, input.accountId);
      const currentGlobalState = latestCompletedGlobalState(jobs);
      if (currentGlobalState) {
        const matched = matchedQueryTerms(currentGlobalState.result_content ?? "", queryTerms);
        globalState.push(globalStateContextItem(currentGlobalState, matched));
      }
      if (scope.primaryProject === null) {
        const claimed = new Set(jobs.filter((job) => job.target === "global_state")
          .flatMap((job) => job.evidence_refs.filter((ref) => ref.startsWith("l1:"))));
        const explicitGlobal = await listExplicitGlobalCaptureEvents(this.stateRoot, input.accountId, 200);
        for (const event of explicitGlobal) explicitGlobalIds.add(event.event_id);
        const freshGlobal = explicitGlobal
          .filter((event) => !claimed.has(`l1:${event.event_id}`) && !distillationExclusion(event) &&
            globalStateAdmission(event) === "admit")
          .slice(0, 2);
        for (const event of freshGlobal) {
          const user = event.user_text?.trim() ?? "";
          const assistant = event.assistant_text?.trim() ?? "";
          const userLimit = Math.min(user.length, 290);
          const assistantLimit = FRESH_L1_CHARS - "User: \nAssistant: ".length - userLimit;
          const content = `User: ${clipFreshText(user, userLimit)}\nAssistant: ${clipFreshText(assistant, assistantLimit)}`;
          globalState.push({
            id: event.event_id,
            evidenceRef: `l1:${event.event_id}`,
            content,
            authority: "evidence",
            scope: "global",
            source: "memhub-capture",
            createdAt: event.timestamp,
            updatedAt: event.timestamp,
            provenance: {
              memoryLayer: "L1",
              freshness: "undistilled",
              globalRouting: "explicit_keep_global",
              continuityId: event.continuity_id,
              retrievalV1: { matchedTerms: matchedQueryTerms(content, queryTerms) }
            }
          });
        }
      }
      globalStateDiagnostics = diagnosticsForGlobalState(globalState, queryTerms, unifiedCore ? "memhub_core" : "memhub_v1");
    }
    const projectId = scope.primaryProject;
    const projectStorageIds = projectId === null
      ? []
      : unique(scope.projectStorageIds.length ? scope.projectStorageIds : [projectId]);
    const branchDrops: RetrievalCandidateDecision[] = [];
    const branchView = this.stateRoot && input.workstreamBranchId && input.workstreamBranchId !== "main"
      ? input.workstreamBranchId : undefined;
    let projectHits: RecallHit[] = [];
    let canonicalFallbackHits: RecallHit[] = [];
    if (projectId !== null) {
      const canonicalProjectId = projectId;
      const historicalStorageIds = projectStorageIds.filter((projectId) => projectId !== canonicalProjectId);
      const [canonicalHits, historicalL2Hits] = await Promise.all([
        search(canonicalProjectId, { layers: ["L3", "L2"], limit: candidateLimit })
          .then((response) => hitsFromResponse(response)
            .filter((hit) => hit.tags.includes(`project:${canonicalProjectId}`))),
        Promise.all(historicalStorageIds.map(async (storageProjectId) =>
          hitsFromResponse(await search(storageProjectId, { layers: ["L2"], limit: candidateLimit }))
            .filter((hit) => hit.tags.includes(`project:${storageProjectId}`))
        )).then((hits) => hits.flat())
      ]);
      // storageIds intentionally includes merged project ids and historical
      // aliases so chronology/provenance stays discoverable after a merge.
      // L3 is different: it is Current Truth for the active canonical project.
      // A merged project's historical L3 must therefore remain durable/auditable
      // in its original namespace, but must not re-enter normal Current Truth
      // ranking merely because that namespace is now an alias of the canonical
      // project. Only canonical L3 participates in project recall; historical
      // namespaces contribute L2 chronology.
      projectHits = dedupeHits([...canonicalHits, ...historicalL2Hits]);
      if (this.stateRoot) {
        const presentCanonicalLayers = new Set(canonicalHits.map((hit) => hit.memoryLayer));
        if (!presentCanonicalLayers.has("L2") || !presentCanonicalLayers.has("L3")) {
          canonicalFallbackHits = (await canonicalRevisionFallbackHits(
            this.stateRoot,
            input.accountId,
            canonicalProjectId
          )).filter((hit) => !presentCanonicalLayers.has(hit.memoryLayer));
          if (canonicalFallbackHits.length > 0) coreStatus.push("canonical_revision_fallback");
        }
      }
      // Preserve Core's L1-only fallback for bootstrap projects.
      if (projectHits.length === 0) {
        projectHits = dedupeHits((await Promise.all(projectStorageIds.map(async (storageProjectId) =>
          hitsFromResponse(await search(storageProjectId, { layers: ["L1"], limit: candidateLimit }))
            .filter((hit) => hit.tags.includes(`project:${storageProjectId}`))
        ))).flat());
      }
    }
    if (branchView) projectHits = await filterBranchL1Hits(this.stateRoot!, input.accountId, branchView, projectHits, branchDrops);
    const rankedProject = rankLane(projectHits.filter((hit) => !globalIds.has(hit.id)));
    let projectMemory = rankedProject.hits
      .map((ranked) => contextItemFromRankedHit(ranked, "project", projectId ?? undefined, rankedProject.diagnostics));
    if (projectId !== null && canonicalFallbackHits.length > 0) {
      const fallbackItems = canonicalFallbackHits.map((hit) => contextItemFromHit(hit, "project", projectId));
      const fallbackIds = new Set(fallbackItems.map((item) => item.id));
      projectMemory = [
        ...projectMemory.filter((item) => item.provenance?.memoryLayer === "L3"),
        ...fallbackItems.filter((item) => item.provenance?.memoryLayer === "L3"),
        ...fallbackItems.filter((item) => item.provenance?.memoryLayer === "L2"),
        ...projectMemory.filter((item) => item.provenance?.memoryLayer !== "L3" && !fallbackIds.has(item.id))
      ].slice(0, finalLimit);
      const fallbackDecisions: RetrievalCandidateDecision[] = fallbackItems.map((item) => {
        const keptRank = projectMemory.findIndex((candidate) => candidate.id === item.id);
        return {
          id: item.id,
          memoryLayer: typeof item.provenance?.memoryLayer === "string" ? item.provenance.memoryLayer : undefined,
          source: "distillation-ledger-fallback",
          ...(keptRank >= 0 ? { rank: keptRank + 1 } : {}),
          matchedTerms: [],
          result: keptRank >= 0 ? "kept" : "dropped",
          reason: keptRank >= 0 ? "canonical_revision_fallback" : "top_k"
        };
      });
      rankedProject.diagnostics.decisions.push(...fallbackDecisions);
      rankedProject.diagnostics.candidateCount += fallbackItems.length;
      rankedProject.diagnostics.dedupedCount += fallbackItems.length;
      rankedProject.diagnostics.emittedCount = projectMemory.length;
    }

    if (this.stateRoot && (projectId !== null || input.continuityId?.trim())) {
      const watermark = [...projectHits, ...canonicalFallbackHits]
        .filter((hit) => hit.memoryLayer === "L2")
        .map((hit) => Date.parse(hit.updatedAt ?? ""))
        .filter(Number.isFinite)
        .reduce((latest, timestamp) => Math.max(latest, timestamp), Number.NEGATIVE_INFINITY);
      const freshOptions = {
        ...(projectId !== null ? { projectIds: projectStorageIds } : { continuityId: input.continuityId }),
        ...(Number.isFinite(watermark) ? { afterTimestamp: new Date(watermark).toISOString() } : {}),
        limit: projectId !== null ? FRESH_L1_MAX : 2
      };
      const captures = (branchView
        ? await listFreshBranchEvidence(this.stateRoot, input.accountId, branchView, freshOptions, branchDrops)
        : await listFreshCaptureEvidence(this.stateRoot, input.accountId, freshOptions))
        .filter((event) => projectId !== null || !explicitGlobalIds.has(event.event_id));
      const freshItems = captures.map((event): ContextItem => {
        const user = event.user_text?.trim() ?? "";
        const assistant = event.assistant_text?.trim() ?? "";
        const userLimit = Math.min(user.length, 290);
        const assistantLimit = FRESH_L1_CHARS - "User: \nAssistant: ".length - userLimit;
        const content = `User: ${clipFreshText(user, userLimit)}\nAssistant: ${clipFreshText(assistant, assistantLimit)}`;
        const tokens = new Set(tokenizeRetrievalText(content));
        const matchedTerms = queryTerms.filter((term) => tokens.has(term));
        return {
          id: event.event_id,
          evidenceRef: `l1:${event.event_id}`,
          content,
          authority: "evidence",
          scope: "project",
          source: "memhub-capture",
          ...(projectId !== null ? { projectId } : {}),
          createdAt: event.timestamp,
          updatedAt: event.timestamp,
          provenance: {
            memoryLayer: "L1",
            freshness: "undistilled",
            continuityId: event.continuity_id,
            captureProjectId: event.project_hint,
            retrievalV1: { matchedTerms }
          }
        };
      });
      if (freshItems.length > 0) {
        const relevant = (item: ContextItem) => {
          const matched = (item.provenance!.retrievalV1 as { matchedTerms: string[] }).matchedTerms;
          return queryTerms.length === 0 || matched.length / queryTerms.length >= 0.1;
        };
        const freshIds = new Set(captures.flatMap((event) => [
          event.event_id,
          captureTurnId(input.accountId, event.host, event.event_id),
          captureCoreRawTurnId(input.accountId, event.host, event.event_id)
        ]));
        const older = projectMemory.filter((item) => item.provenance?.memoryLayer !== "L1" || !freshIds.has(item.id));
        const replacedCount = projectMemory.length - older.length;
        projectMemory = [
          ...older.filter((item) => item.provenance?.memoryLayer === "L3"),
          ...freshItems.filter(relevant),
          ...older.filter((item) => item.provenance?.memoryLayer !== "L3"),
          ...freshItems.filter((item) => !relevant(item))
        ].slice(0, finalLimit);
        const finalProjectIds = new Set(projectMemory.map((item) => item.id));
        rankedProject.diagnostics.decisions = rankedProject.diagnostics.decisions.map((decision) =>
          decision.result === "kept" && !finalProjectIds.has(decision.id)
            ? { ...decision, result: "dropped", reason: "fresh_l1_merge_limit" }
            : decision
        );
        const freshDecisions: RetrievalCandidateDecision[] = freshItems.map((item) => {
          const matchedTerms = ((item.provenance?.retrievalV1 as { matchedTerms?: string[] } | undefined)?.matchedTerms ?? []).slice(0, 16);
          const keptRank = projectMemory.findIndex((candidate) => candidate.id === item.id);
          return {
            id: item.id,
            memoryLayer: "L1",
            source: "memhub-capture",
            ...(keptRank >= 0 ? { rank: keptRank + 1 } : {}),
            matchedTerms,
            result: keptRank >= 0 ? "kept" : "dropped",
            reason: keptRank >= 0 ? "fresh_l1_injected" : "fresh_l1_merge_limit"
          };
        });
        rankedProject.diagnostics.decisions.push(...freshDecisions);
        rankedProject.diagnostics.candidateCount += freshItems.length;
        rankedProject.diagnostics.dedupedCount += freshItems.length - replacedCount;
        rankedProject.diagnostics.emittedCount = projectMemory.length;
      }
    }

    if (branchDrops.length) {
      rankedProject.diagnostics.decisions.push(...branchDrops);
      rankedProject.diagnostics.candidateCount += branchDrops.length;
    }
    const reusableSkillProjectIds = unique([
      ...(projectId ? [projectId] : []),
      ...scope.reusableSkillProjectIds
    ])
      .slice(0, 32);
    const perProjectSkillLimit = candidateLimit;
    const singleSkillProject = (reusableSkillProjectIds.length === 1 ? reusableSkillProjectIds[0] : null) ?? null;
    let rawReusableHits: Array<{ hit: RecallHit; projectId: string }> = [];
    if (reusableSkillProjectIds.length > 0) {
      const response = await search(singleSkillProject, {
        layers: ["Skill"],
        tags: ["artifact:skill"],
        limit: perProjectSkillLimit,
        accountWide: true,
        projectIds: reusableSkillProjectIds
      });
      const hits = hitsFromResponse(response);
      for (const projectId of reusableSkillProjectIds) {
        for (const hit of hits) {
          if (isReusableSkillHit(hit, projectId)) {
            rawReusableHits.push({ hit, projectId });
          }
        }
      }
    }
    const reusableHits = rawReusableHits
      .filter(({ hit }) => !globalIds.has(hit.id))
      .sort((left, right) => right.hit.score - left.hit.score);
    const skillProjectById = new Map<string, string>();
    for (const { hit, projectId } of reusableHits) {
      if (!skillProjectById.has(hit.id)) skillProjectById.set(hit.id, projectId);
    }
    const dedupedReusableHits = dedupeHits(reusableHits.map(({ hit }) => hit));
    const rankedSkills = rankLane(dedupedReusableHits);
    const reusableSkills = rankedSkills.hits
      .map((ranked) => compactSkillContextItem(contextItemFromRankedHit(
          ranked,
          "capability",
          skillProjectById.get(ranked.hit.id),
          rankedSkills.diagnostics
        )));

    return {
      globalMemory,
      globalState,
      projectMemory,
      reusableSkills,
      diagnostics: {
        version: "retrieval-v1",
        rankingMode: unifiedCore ? "memhub_core" : "memhub_v1",
        requestedLimit,
        finalLimit,
        candidateLimit,
        coreStatus: unique(coreStatus),
        lanes: {
          global: rankedGlobal.diagnostics,
          globalState: globalStateDiagnostics,
          project: rankedProject.diagnostics,
          skills: rankedSkills.diagnostics
        }
      }
    };
  }

  distill(input: {
    accountId: string;
    userId: string;
    kind: DistilledArtifactKind;
    content: string;
    projectId: string | null;
    conversationId?: string;
    title?: string;
    tags?: string[];
    sourceHarness: string;
    artifactId?: string;
    version?: string;
    provenance?: Record<string, string | undefined>;
    evidenceRefs?: string[];
    sourceConversations?: string[];
    confidence?: number;
    contractVersion?: string;
  }): Promise<unknown> {
    const namespace = namespaceFor(input, input.projectId);
    const skill = input.kind === "skill";
    const layer = input.kind === "l2"
      ? "L2"
      : input.kind === "l3"
        ? "L3"
        : input.kind === "l4"
          ? "L4"
          : "Skill";
    const sourceHarness = requireNonEmpty(input.sourceHarness, "sourceHarness");
    const stableArtifactId = input.artifactId?.trim() || stableDistillId(input);
    const tags = unique([
      "memhub",
      "distilled",
      ...(input.contractVersion ? [`distill-contract:${input.contractVersion}`] : []),
      ...(input.confidence !== undefined ? [`confidence:${input.confidence}`] : []),
      ...(input.evidenceRefs ?? []).map((ref) => `evidence:${ref}`),
      ...(input.sourceConversations ?? []).map((ref) => `source-conversation:${ref}`),
      ...provenanceTags(input.provenance),
      `artifact:${input.kind}`,
      ...(input.projectId ? [`project:${input.projectId}`] : ["global"]),
      ...(input.tags ?? [])
    ]);
    const requestBody = {
      namespace,
      source: `memhub:${sourceHarness}:${provenanceSource(input.provenance)}`,
      content: input.content,
      title: input.title,
      layer,
      tags,
      sourceArtifactId: stableArtifactId,
      ...(skill ? {
        sourceAgentId: sourceHarness,
        sourceSkillId: stableArtifactId,
        ...(input.version?.trim() ? { sourceSkillVersion: input.version.trim() } : {})
      } : {})
    };
    // requestId is retry-stable for an identical write, but changes when the
    // canonical artifact evolves. Memory Core upserts by memory key/title;
    // using only the artifact identity here would turn legitimate revisions
    // into idempotency conflicts (same key, different request body).
    const request = {
      requestId: stableRequestId("distill", [
        input.accountId,
        input.projectId ?? "global",
        input.kind,
        sourceHarness,
        stableArtifactId,
        stableHashJson(requestBody)
      ]),
      adapterId: "memhub-distill",
      ...requestBody
    };
    return this.client.addMemory(request);
  }

  private search(input: {
    accountId: string;
    userId: string;
    query: string;
    projectId: string | null;
    conversationId?: string;
    limit: number;
  }, projectId: string | null, filters: {
    layers?: string[];
    tags?: string[];
    limit?: number;
    accountWide?: boolean;
    projectIds?: readonly string[];
  } = {}): Promise<unknown> {
    const namespace = namespaceFor(input, projectId);
    const request = {
      adapterId: "memhub",
      namespace,
      query: input.query,
      limit: filters.limit ?? input.limit,
      ...(filters.layers?.length ? { layers: filters.layers } : {}),
      ...(filters.tags?.length ? { tags: filters.tags } : {}),
      ...(filters.accountWide ? { accountWide: true } : {}),
      ...(filters.projectIds?.length ? { projectIds: filters.projectIds } : {}),
      includeInjectedContext: false,
      // Memory Core's public HTTP contract only exposes structured recall
      // hits under debug.hits when verbose=true. The injected markdown alone
      // is not enough for LITSAN because it must preserve global/project
      // provenance and compose a typed Context Capsule.
      verbose: true
    };
    return this.client.search(request);
  }
}

function emptyGlobalStateDiagnostics(
  queryTerms: string[],
  rankingMode: RetrievalRankingMode
): RetrievalRankDiagnostics {
  return {
    version: "retrieval-v1",
    rankingMode,
    semanticWeight: 0,
    lexicalWeight: 1,
    diversityPenalty: 0,
    candidateCount: 0,
    dedupedCount: 0,
    emittedCount: 0,
    queryTerms,
    decisions: []
  };
}

function diagnosticsForGlobalState(
  items: readonly ContextItem[],
  queryTerms: string[],
  rankingMode: RetrievalRankingMode
): RetrievalRankDiagnostics {
  const diagnostics = emptyGlobalStateDiagnostics(queryTerms, rankingMode);
  diagnostics.candidateCount = items.length;
  diagnostics.dedupedCount = items.length;
  diagnostics.emittedCount = items.length;
  diagnostics.decisions = items.map((item, index) => ({
    id: item.id,
    memoryLayer: typeof item.provenance?.memoryLayer === "string" ? item.provenance.memoryLayer : undefined,
    source: item.source,
    rank: index + 1,
    lexicalScore: matchedQueryTerms(item.content, queryTerms).length,
    matchedTerms: matchedQueryTerms(item.content, queryTerms),
    result: "kept" as const,
    reason: item.provenance?.memoryLayer === "L1" ? "fresh_l1_injected" as const : "ranked" as const
  }));
  return diagnostics;
}

function matchedQueryTerms(content: string, queryTerms: readonly string[]): string[] {
  const tokens = new Set(tokenizeRetrievalText(content));
  return queryTerms.filter((term) => tokens.has(term)).slice(0, 32);
}

export function clipFreshText(value: string, limit: number): string {
  if (limit <= 0) return "";
  if (value.length <= limit) return value;
  let end = Math.max(0, limit - 1);
  if (end > 0 && /[\uD800-\uDBFF]/.test(value[end - 1]!)) end -= 1;
  return `${value.slice(0, end)}…`;
}

function isReusableSkillHit(hit: RecallHit, projectId: string): boolean {
  return hit.memoryLayer === "Skill" &&
    hit.tags.includes("artifact:skill") &&
    hit.tags.includes(`project:${projectId}`);
}

function provenanceTags(provenance?: Record<string, string | undefined>): string[] {
  if (!provenance) return [];
  return Object.entries(provenance)
    .filter((entry): entry is [string, string] => Boolean(entry[1]?.trim()))
    .map(([key, value]) => `provenance:${key}:${value.trim()}`);
}

function provenanceSource(provenance?: Record<string, string | undefined>): string {
  const platform = provenance?.platform?.trim() || "unknown";
  const transport = provenance?.transport?.trim() || "unknown";
  return `memhub:${platform}:${transport}`;
}

export function defaultMemoryUserId(accountId: string, ownerAccountId?: string, ownerUserId = "local-user"): string {
  const normalized = requireNonEmpty(accountId, "accountId");
  if (normalized === "local" || (ownerAccountId && normalized === ownerAccountId.trim())) return ownerUserId;
  return `acct_${createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, 32)}`;
}

function namespaceFor(
  input: { accountId: string; userId: string; conversationId?: string },
  projectId: string | null
): RuntimeNamespace {
  return {
    source: "memhub",
    profileId: "default",
    userId: requireNonEmpty(input.userId, "userId"),
    tenantId: requireNonEmpty(input.accountId, "accountId"),
    ...(projectId ? { projectId } : {}),
    ...(input.conversationId?.trim() ? { sessionKey: input.conversationId.trim() } : {})
  };
}

function statusFromResponse(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const response = value as SearchResponseLike;
  const status = Array.isArray(response.debug?.status) ? response.debug.status : response.status;
  return Array.isArray(status) ? unique(status.filter((item): item is string => typeof item === "string")) : [];
}

function hitsFromResponse(value: unknown): RecallHit[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const response = value as SearchResponseLike;
  const hits = Array.isArray(response.debug?.hits)
    ? response.debug.hits
    : response.hits;
  return Array.isArray(hits) ? hits.filter(isRecallHit) : [];
}

function isRecallHit(value: unknown): value is RecallHit {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const hit = value as Partial<RecallHit>;
  return typeof hit.id === "string" && typeof hit.snippet === "string" && typeof hit.score === "number";
}

function dedupeHits(hits: readonly RecallHit[]): RecallHit[] {
  const seen = new Set<string>();
  return hits.filter((hit) => {
    if (seen.has(hit.id)) return false;
    seen.add(hit.id);
    return true;
  });
}

async function canonicalRevisionFallbackHits(
  stateRoot: string,
  accountId: string,
  projectId: string
): Promise<RecallHit[]> {
  const jobs = await listDistillationJobs(stateRoot, accountId);
  const l3 = latestCompletedL3ByProject(jobs).find((job) => job.project_id === projectId);
  const l2 = latestCanonicalL2(jobs, projectId);
  return [l3, l2]
    .filter((job): job is DistillationJob => Boolean(job))
    .map((job) => canonicalRevisionFallbackHit(job));
}

function canonicalRevisionFallbackHit(job: DistillationJob): RecallHit {
  const layer = job.target.toUpperCase();
  if (layer !== "L2" && layer !== "L3") {
    throw new Error(`canonical revision fallback only supports L2/L3, got ${job.target}`);
  }
  return {
    id: job.result_id!,
    kind: layer === "L3" ? "project_profile" : "project_timeline",
    memoryLayer: layer,
    status: "activated",
    // The ledger fallback is an addressable anchor, not a second copy of the
    // canonical artifact. Exact content and typed metadata are hydrated later
    // through the immutable evidence ref, keeping Progressive Disclosure intact.
    snippet: `Canonical ${layer} revision fallback for project ${job.project_id}. Exact content is available through evidence hydration.`,
    score: 0,
    tags: [`artifact:${job.target}`, `project:${job.project_id}`, "canonical-revision-fallback"],
    createdAt: job.created_at,
    updatedAt: job.result_committed_at ?? job.completed_at ?? job.updated_at,
    source: "distillation-ledger-fallback",
    retrievalRoutes: ["canonical_revision_fallback"]
  };
}

function contextItemFromHit(hit: RecallHit, scope: "global" | "project" | "capability", projectId?: string): ContextItem {
  const content = hit.title?.trim() ? `${hit.title.trim()}\n${hit.snippet}` : hit.snippet;
  const tags = hit.tags.slice(0, 32);
  const allRetrievalRoutes = hit.retrievalRoutes ?? [];
  const retrievalRoutes = allRetrievalRoutes.slice(0, 16);
  return {
    id: hit.id,
    content,
    authority: "remembered",
    scope,
    source: "memmy-memory",
    ...(projectId ? { projectId } : {}),
    createdAt: hit.createdAt,
    updatedAt: hit.updatedAt,
    provenance: {
      kind: hit.kind,
      memoryLayer: hit.memoryLayer,
      score: hit.score,
      tags,
      ...(hit.tags.length > tags.length ? { tagsTruncated: true, originalTagCount: hit.tags.length } : {}),
      retrievalSource: hit.source,
      retrievalRoutes,
      ...(allRetrievalRoutes.length > retrievalRoutes.length
        ? { retrievalRoutesTruncated: true, originalRetrievalRouteCount: allRetrievalRoutes.length }
        : {})
    }
  };
}

function contextItemFromRankedHit(
  ranked: RankedRecallHit,
  scope: "global" | "project" | "capability",
  projectId: string | undefined,
  diagnostics: RetrievalRankDiagnostics
): ContextItem {
  const item = contextItemFromHit(ranked.hit, scope, projectId);
  return {
    ...item,
    provenance: {
      ...(item.provenance ?? {}),
      retrievalV1: {
        rank: ranked.rank,
        semanticScore: ranked.semanticScore,
        lexicalScore: ranked.lexicalScore,
        fusedScore: ranked.fusedScore,
        diversityPenaltyApplied: ranked.diversityPenaltyApplied,
        ...(ranked.coreScore !== undefined ? { coreScore: ranked.coreScore } : {}),
        matchedTerms: ranked.matchedTerms,
        candidateCount: diagnostics.candidateCount,
        dedupedCount: diagnostics.dedupedCount,
        ...(diagnostics.rankingMode ? { rankingMode: diagnostics.rankingMode } : {}),
        ...(diagnostics.engineVersion ? { engineVersion: diagnostics.engineVersion } : {})
      }
    }
  };
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function requireNonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${field} must be non-empty`);
  return normalized;
}

function stableDistillId(input: {
  kind: DistilledArtifactKind;
  title?: string;
  content: string;
}): string {
  return `distill_${createHash("sha256")
    .update([input.kind, input.title?.trim() ?? "", input.content.trim()].join("\u0000"), "utf8")
    .digest("hex")
    .slice(0, 32)}`;
}

function stableRequestId(prefix: string, parts: readonly string[]): string {
  return `${prefix}_${createHash("sha256")
    .update(parts.join("\u0000"), "utf8")
    .digest("hex")
    .slice(0, 40)}`;
}

function stableHashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}
