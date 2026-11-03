# LITSAN P0 Engineering Foundation / P0 工程地基

Verified against the canonical private runtime source in `memhubruntime/`. This document records implementation ownership and the P0 observability/test seams. It is not a second architecture source of truth; governed Project Architecture remains under `docs/architecture/`.

## Hub / Core Ownership Map

| Capability | Current Owner | Source File / Function | Should Owner | Duplicate? | Action |
|---|---|---|---|---|---|
| Account identity | Hub | `src/auth.ts`, runtime auth mapping | Hub | No verified duplicate | Keep |
| Project Registry | Hub | `src/project-registry.ts` | Hub | No | Keep canonical registry |
| Project resolution/admission | Hub | `src/context-router.ts`, `src/project-scope.ts` | Hub | Capture has a separate ingest-time resolver, not retrieval ranking | Retrieval uses one `RetrievalScopeEnvelope` |
| workspace_project guard | Hub | `resolveExplicitProjectEvidence`, `resolveProjectScope` | Hub | No | Fail closed on conflict |
| Branch scope | Hub | `src/branch-store.ts`, `ContextRouter.resolveBranchContext` | Hub | No | Branch narrows retrieval only |
| L1 capture / ingest orchestration | Hub | `src/capture*.ts`, `src/turn-log.ts` | Hub | No verified duplicate | Keep |
| Distillation queue / lease | Hub | `src/distillation-jobs.ts`, `src/distillation-control.ts` | Hub | No | Keep |
| Evidence validation | Hub | `src/distillation-evidence.ts`, `src/distillation-contract.ts` | Hub | No | Keep fail-closed |
| Revision governance | Hub | `src/distillation-jobs.ts`, `src/distillation-submit.ts` | Hub | No | Keep immutable evidence refs |
| L2/L3/L4 scope policy | Hub | `src/context-router.ts`, `src/distillation-submit.ts` | Hub | No | Keep outside Core |
| Architecture governance | Hub | `src/architecture-*.ts` | Hub | No | Governed separately; this P0 does not rewrite it |
| Todo | Hub | `src/project-registry.ts` | Hub | No | Keep |
| Context Router / final context | Hub | `src/context-router.ts`, `src/context-capsule.ts`, `src/turn-knowledge-plan.ts` | Hub | No | Keep |
| Durable memory storage | Core | `vendor/memory-core`, accessed by `src/local-memory-client.ts` | Core | Hub stores control-plane ledgers/provenance only | Keep boundary |
| Revision storage/read | Hub + Core by responsibility | Core stores current Memory; Hub immutable distillation ledger proves revisions | Split is intentional | Not duplicate truth | Keep explicit provenance contract |
| Candidate retrieval primitive | Core | `/api/v1/memory/search` via `LocalMemoryRestClient.search` | Core | No second search engine in Hub | Keep |
| Semantic retrieval | Core | `IndexedCandidatePool.searchVectorIds` inside unified Core search | Core | Internal route exists, but no separate public callable primitive | Keep `SemanticRetriever` unbound; do not fake an adapter |
| Lexical retrieval | Core + Hub second-stage | Core `searchFtsIds` / pattern routes inside unified search; Hub BM25 second-stage in `retrieval-ranker.ts` | Core primitive + Hub policy adapter | Internal route exists, but no separate public callable primitive | Keep `LexicalRetriever` unbound; future public split may replace adapter |
| Ranking/fusion | Hub policy over Core candidates | `rankRecallHits` | Replaceable data-plane policy adapter | Single current implementation | `FusionRanker` interface + `RetrievalV1FusionRanker` |
| Hydrate/read | Core read + Hub evidence guard | `LocalMemoryRestClient.viewerGet`, `memory-hydration.ts` | Core primitive, Hub governance | Intentional boundary | `Hydrator` contract only; no duplicated reader |
| Compact/consolidation | Hub orchestration | `distillation-consolidation.ts` | Hub unless Core later exposes a pure primitive | UNKNOWN for Core native compact | No migration now |
| Index rebuild/recovery | Core | Memory Core vendor/runtime | Core | UNKNOWN from Hub public API | Leave unchanged |

## RetrievalScopeEnvelope

`ContextRouter` resolves project/admission once, canonicalizes storage aliases, resolves explicit Branch scope and reusable Skill projects, then creates `retrieval-scope-envelope-v1`. `MemoryRestContextSource` consumes this envelope. The previous direct-call arguments remain only as a thin compatibility adapter and are immediately normalized into the same envelope, so retrieval channels do not make independent project decisions.

The envelope contains account, primary project, workspace project, branch, global permission, cross-project Skill permission, resolution source/confidence, ambiguity, canonical/historical storage ids, and reusable Skill project ids. Archived projects remain non-routable by default through `JsonProjectRegistry.resolve`; ambiguous deterministic or semantic evidence becomes global-only.

## Retrieval Trace

`retrieval-decision-trace-v1` records the real pipeline only: `scope_gate → candidate_recall → retrieval_ranking → context_budget → turn_knowledge_plan`. It stores a query hash rather than query text. Candidate diagnostics preserve actual semantic/lexical/fusion/diversity values where the current ranker exposes them; absent upstream values are not fabricated. `retrieval_explain` distinguishes scope gate, candidate miss, rank cut and context-budget cut.

## Distillation Trace

`distillation-claim-trace-v1` is optional claim-level audit telemetry supplied by the semantic distillation Harness and committed only with a successful submit. Allowed actions are `new`, `reinforce`, `supersede`, `refute`, `append_history`, `omit`, `uncertain`. Every claim must reference evidence already validated for that submit. LITSAN stores evidence refs, source spans, claim transition, confidence, validation result, repair count and a short reason. Free-form chain-of-thought is neither requested nor stored. The trace receipt links to the exact committed revision when one exists.

## Core interfaces

`src/core-interfaces.ts` introduces narrow contracts for `MemoryStore`, `SemanticRetriever`, `LexicalRetriever`, `FusionRanker`, `Hydrator`, `Compactor`, and `Evaluator`. Only the existing production fusion behavior has a concrete adapter in this P0 (`RetrievalV1FusionRanker`). Semantic and lexical Core internals are deliberately not faked as separate implementations when the current Core HTTP contract does not expose them independently.

## Evaluation Harness

`src/evaluation-harness.ts` provides a deterministic metric layer over fixed benchmark cases and observations. It reports Grounded Task Accuracy, Recall, separately-declared Critical Recall, Precision, Current Truth Precision, Superseded Leakage, Duplicate Ratio, average Context Bytes, Hydrate Count and Latency, and supports baseline-vs-candidate deltas. The harness does not invoke a hidden model or read hidden reasoning. Task Success / First Pass Sufficiency / User Correction Rate remain future metrics because this minimal deterministic layer cannot honestly infer them.

`benchmarks/retrieval/p0-real-pipeline-suite.json` plus `scripts/build-retrieval-pipeline-observations.mjs` close the earlier synthetic-only gap. The checked-in suite uses sanitized representative L2/L3/L4/Skill fixtures, while every observation is generated by a repository-local isolated `EmbeddedMemoryCore` through the real add/index/search path and the real `MemoryRestContextSource`. It covers canonical L3 replacement, historical L2 retrieval, global-only recall, project isolation, tenant isolation and explicit cross-project Skill reuse. It never reads `~/.memmy`. Account-isolation cases deliberately use the same production mapping as LITSAN (`defaultMemoryUserId(accountId)`), because Core retrieval isolation is keyed by the account-derived Core `user_id`; `tenantId` alone is not treated as an alternate isolation implementation. `p0-real-pipeline-baseline.json` freezes the first accepted observation set after three consecutive runs produced identical selections/scope outcomes; latency remains observational rather than an exact reproducibility invariant.

Accepted baseline metrics on the six-case fixture are: Grounded Task Accuracy 1.0, Recall 1.0, Critical Recall 1.0, Precision 1.0, Current Truth Precision 1.0, Superseded Leakage 0, Duplicate Ratio 0, mean Context Bytes 214, Hydrate Count 0 and observed mean latency 25.55 ms. These numbers validate this bounded fixture and harness only; they are not a claim about production-scale retrieval quality.

### Verified Core public capability boundary (2026-10-23)

- Core internally has vector, FTS, pattern and structural routes in `vendor/memory-core/src/service/retrieval/indexed-candidate-pool.js`.
- The public HTTP contract exposes only unified `POST /api/v1/memory/search`; `verbose=true` returns final hits/status/sections, not separately callable semantic and lexical candidate endpoints.
- Public search hits expose memory id/layer/title/snippet/score/tags/retrieval route data, but not LITSAN's exact immutable `l2:<memory-id>:<revision-id>` / `l3:...` evidence refs.
- Therefore P0 intentionally leaves `SemanticRetriever` and `LexicalRetriever` without concrete HTTP adapters and does not add fabricated revision refs to candidate trace. The interface seams remain ready for a future public Core contract.

## Current implementation questions

1. Current implementation: Hub resolves governance; Core stores/searches; Hub ranks/packs/orchestrates.
2. Source: listed in the ownership map above.
3. Inputs: current request + authenticated account + explicit workspace/project/branch evidence; Core receives already-scoped search requests.
4. Outputs: typed Context Capsule, trace receipt, optional distillation trace, benchmark metrics.
5. Source of Truth: Project Registry for project governance; Memory Core for durable memory; Hub revision ledger/evidence refs for immutable provenance; governed Architecture docs for architecture.
6. Duplicate owner: no verified second durable Memory owner. Capture project resolution is ingest-time evidence handling, not a competing retrieval owner.
7. Failure modes: conflicting project evidence, unknown/archived project, missing candidate, rank/budget omission, invalid evidence chain, ambiguous Core commit.
8. Modified: unified scope envelope, retrieval scope trace, claim-level distillation trace, Core contracts, deterministic evaluation metrics.
9. Why: make behavior observable and algorithms replaceable without moving governance into Core.
10. Verification: typecheck + isolated E2E tests listed below.
11. Benchmark before/after: the synthetic smoke remains a metric-unit check; the representative real-pipeline suite now generates observations through isolated Core. Production-quality improvement still requires running the same frozen suite/snapshot against two candidate algorithms.
12. Current Truth change: implementation behavior changes are documented here; governed Project Architecture was not rewritten by this patch.

## Tests

- `project-scope-envelope-e2e.mjs`: deterministic conflict, semantic ambiguity, global-only, cross-project Skill envelope, alias, archived project, and same project name across two accounts.
- `retrieval-trace-e2e.mjs`: candidate miss vs rank cut and trace receipt.
- `distillation-trace-e2e.mjs`: claim trace validation and evidence-subset fail-closed behavior.
- `core-interfaces-e2e.mjs`: production FusionRanker contract adapter.
- `evaluation-harness-e2e.mjs`: baseline/candidate metrics and deltas.
- `retrieval-pipeline-benchmark-e2e.mjs`: real isolated Core add/index/search pipeline, replacement, project/account isolation and cross-project Skill reuse.

## Remaining P0

- If Memory Core later exposes semantic and lexical candidate primitives separately, bind those concrete adapters to the interfaces instead of inferring internals.
- Expand retrieval candidate trace with revision/evidence refs at candidate-recall time only if Core exposes those fields directly; do not reconstruct them from stable ids.

## Research Candidate

GNN retrieval, Kalman ranking, semantic-wave/complex embeddings, learned neural reranking and full graph rewrites remain experiments only and are not part of this production P0.
