# Memory Arena — Memory Quality Report

> Draft status: methodology and Memhub frozen-snapshot A/B validated; Mem0 and Hindsight full memory-only lanes are still in progress. Numbers marked as complete below are backed by saved artifacts and checks.

## 1. Executive scope

This report evaluates **memory-system quality**, not the quality of a downstream answer model.

The primary question is:

> Given a long conversation history, did the memory system retain the information required by a future question, and can it retrieve useful evidence within a bounded context budget?

The primary leaderboard therefore stops after memory construction and retrieval. Reader generation and LLM judging are reported only as optional appendix evidence.

Full protocol: [`memory-quality-protocol.md`](./memory-quality-protocol.md).

## 2. What was removed from the primary benchmark

The original end-to-end LoCoMo lane was:

`memory construction → retrieval → answer generation → LLM-as-Judge → aggregate QA score`

The Memory Quality primary lane is:

`memory construction → retrieval → evidence evaluation`

Removed from the primary ranking:

- downstream answer generation;
- LLM-as-a-Judge;
- answer BLEU/F1 wording metrics;
- reader-model reasoning quality;
- judge-model variability;
- answer-model prompt and completion tokens.

These are removed because they mix retrieval failure with reader failure. They remain eligible for an **End-to-End QA appendix**, clearly labeled as a different metric family.

## 3. Gold standard

Dataset: LoCoMo, 10 conversations.

Primary evaluation lane: 1,540 questions, matching the existing OmniMemEval LoCoMo lane and excluding category 5 (adversarial).

LoCoMo category mapping used by the evaluator:

| JSON category | Meaning |
|---:|---|
| 1 | multi-hop |
| 2 | temporal |
| 3 | open-domain |
| 4 | single-hop |
| 5 | adversarial, excluded from the primary 1,540-question lane |

Each QA record contains dataset-provided source evidence IDs such as `D1:3`. These IDs resolve to original conversation turns and are the strict retrieval gold.

The evaluator currently resolves 2,361 of 2,363 extracted evidence references; two source IDs in the dataset do not resolve to conversation turns after safe normalization. Four evaluation questions have no resolvable source-evidence turn. These exceptions are surfaced explicitly rather than silently dropped.

## 4. Primary metric families

### 4.1 Provenance evidence retrieval

When a backend exposes source-turn provenance that can be resolved to LoCoMo evidence IDs:

- Evidence Recall@1 / @5 / @10 / @20
- Evidence Hit@1 / @5 / @10 / @20
- MRR, or per-lane MRR for LoCoMo's two independently ranked speaker lanes

Missing provenance is reported as **unsupported**, not inferred from semantic similarity and not scored as zero.

### 4.2 Semantic gold-evidence coverage

Many memory systems rewrite dialogue into facts, summaries, profiles, or other abstractions. Exact source-string matching would systematically penalize those designs.

For that reason, the report separately publishes **Gold Evidence Similarity**:

- fixed evaluator: `BAAI/bge-small-en-v1.5`;
- local embedding execution;
- no answer LLM;
- no LLM judge;
- cosine similarity between each gold source turn and its best retrieved-memory fragment;
- continuous scores are reported directly;
- no test-set-tuned pass/fail threshold is hidden inside the headline result.

### 4.3 Strict content coverage

Normalized source-text containment is reported as a conservative diagnostic. It is useful for raw-passage systems but is **not** treated as the sole quality metric for abstractive memory systems.

### 4.4 Efficiency and cost

The primary scorecard also reports:

- retrieved-context tokens: mean / P50 / P95 / max;
- search latency: mean / P50 / P95 / max;
- empty and failed retrieval rates;
- ingestion wall-clock time;
- storage footprint where measurable;
- backend-internal LLM prompt/completion tokens where measurable;
- retry/failure counts.

Backend-internal memory-construction tokens are kept separate from answer/judge tokens.

## 5. LoCoMo dual-speaker retrieval semantics

For generic LoCoMo backends, the benchmark stores/searches the two conversation speakers as separate memory identities. The query is searched once against speaker A and once against speaker B.

Therefore `K=5` means **five retrieved items per speaker lane**, with evidence coverage computed over the union of those two lane prefixes. The benchmark preserves both ordered lanes and does not invent a fictitious global rank.

## 6. Memhub v1 vs memhub_core — frozen-snapshot A/B

### 6.1 A/B isolation contract

A public A/B was created from one frozen Memhub Arena state.

Before the run, the state was stopped and copied into three directories:

- frozen baseline;
- `memhub_v1` test copy;
- `memhub_core` test copy.

The `memory.sqlite` SHA256 was identical across all three copies before testing:

`23022f07f60a3a38825db18803c3bd435c842ad8b52b38b327a843452a3dd777`

Logical checksums of the relevant memory/content tables were also identical before retrieval. The same logical checksums were rechecked after the 1,540-query retrieval run and remained identical across v1/core, so no background memory evolution occurred during the A/B.

The only intended experimental variable was retrieval ranking mode:

- legacy: `memhub_v1`
- candidate: `memhub_core`

Same memory snapshot, same questions, same code revision, same evaluator.

### 6.2 Current result

| Metric | memhub_v1 | memhub_core | Observation |
|---|---:|---:|---|
| Gold Evidence Similarity, query macro | 0.686125 | 0.686125 | no quality change |
| Strict content Recall@1 | 0.002638 | 0.002638 | unchanged |
| Strict content Recall@5 | 0.019421 | 0.019421 | unchanged |
| Strict content Hit@5 | 0.029297 | 0.029297 | unchanged |
| Mean retrieved context tokens | 631.779 | 631.779 | identical footprint |
| Mean search latency | 714.725 ms | 713.546 ms | essentially equal |
| Search latency P50 | 648.689 ms | 636.873 ms | core ~1.8% lower |
| Search latency P95 | 1136.053 ms | 1115.303 ms | core ~1.8% lower |
| Empty retrieval rate | 0 | 0 | unchanged |
| Failed retrieval rate | 0 | 0 | unchanged |

Candidate-set comparison across all 1,540 queries:

- candidate set identical: **1,540 / 1,540 queries**;
- order identical: **1,439 / 1,540 queries**;
- order changed: **101 / 1,540 queries** (~6.6%);
- no query gained or lost a candidate item in this snapshot.

Interpretation:

`memhub_core` currently behaves as an architectural consolidation rather than a retrieval-quality redesign on this LoCoMo snapshot. It removes duplicated ranking responsibility and preserves Core ordering, while producing no measured Memory Quality regression. The current A/B does **not** support claiming a significant quality gain. Small latency differences should be treated as secondary unless replicated across multiple runs.

### 6.3 Provenance limitation

Memhub's Arena search response currently exposes canonical Memhub evidence references (for example L2/L3 artifact references), not LoCoMo `D#:turn` source IDs. Therefore strict LoCoMo **provenance Recall@K/MRR is marked unsupported for this run** rather than inferred from semantic similarity.

This limitation is itself useful benchmark evidence: public source-turn traceability is a separate capability from semantic retrieval quality.

## 7. Historical context-only baselines

These historical results are useful diagnostics but are not used for the frozen v1/core causal A/B because the live memory store may have evolved after the original run.

### Memhub historical context-only search

- Gold Evidence Similarity macro: `0.710484`
- context tokens P50: `654`
- context tokens P95: `1067`
- search latency P50: `137.11 ms`
- search latency P95: `189.37 ms`

### EverOS corrected context-only search

- Gold Evidence Similarity macro: `0.702156`
- context tokens P50: `942`
- context tokens P95: `1219.05`
- search latency P50: `705.95 ms`
- search latency P95: `912.44 ms`

These figures should not be used to claim a final cross-system winner until Mem0/Hindsight are scored under the same Memory Quality protocol and the retrieval-trace differences are disclosed.

### EverOS structured retrieval replay

To avoid treating the formatter blob as a ranked list, EverOS was replayed search-only against its completed local memory state. No answer/judge LLM was used. The collector preserves the hybrid-selected atomic facts as ranked items, retains true episode-only hits, and records the native EverOS `session_id`. Profiles are excluded from the ranked trace because they are KV profile context rather than query-ranked retrieval hits.

Structured trace status:

- questions: **1,540 / 1,540 success**;
- retrieval budget: **20 items per speaker lane**;
- mean retrieved items: **40 per query**;
- empty/failure rate: **0%**.

Structured semantic diagnostics (1,536 questions with resolvable gold evidence):

- Gold Evidence Similarity, query macro mean: **0.68763**;
- context-token mean / P50 / P95: **626.24 / 606 / 833.15**;
- search latency mean / P50 / P95: **730.50 / 733.69 / 1,024.78 ms**.

Verbatim strict-content turn Recall@K is near zero for this trace because EverOS deliberately stores abstractive atomic facts rather than verbatim source turns. That number is therefore a representation diagnostic, not a fair provenance score. EverOS currently exposes the originating `session_id`, so a separate **Gold Session** provenance diagnostic is reported:

| Metric | @1 | @5 | @10 | @20 |
|---|---:|---:|---:|---:|
| Gold Session Recall | 66.86% | 83.01% | 87.93% | 92.81% |
| Gold Session Hit | 74.61% | 89.58% | 93.10% | 96.16% |

Per-lane session MRR: **0.8109**.

**Important:** session-level provenance is weaker than source-turn provenance. A hit from the correct conversation session does not prove that the exact LoCoMo evidence turn was recovered. These values MUST be labeled `Gold Session Recall/Hit`, never `Evidence Turn Recall@K`, and must not be directly compared to turn-level retrieval results published by other systems.

## 8. Evaluator validation

The public evaluator includes tests for:

- compound/zero-padded LoCoMo evidence-ID normalization;
- exact 1,540-question evaluation scope;
- unresolved-gold accounting;
- dual-speaker per-lane K semantics;
- LoCoMo evidence-ID → gold-session mapping for supplementary session-level provenance.

Current evaluator test result:

`4 tests, OK`

The benchmark intentionally avoids an opaque weighted overall score. Component metrics remain visible so users can decide whether recall, latency, context efficiency, or construction cost matters most for their deployment.

## 9. Remaining systems and current blocker

Pending under the same primary protocol:

- Mem0: memory construction + retrieval only;
- Hindsight: memory construction + retrieval only;
- final cross-system table with internal memory-construction cost.

No full answer/judge completion is required for these systems in the primary report.

### 9.1 Mem0 transport status (2026-10-24)

The Mem0 OSS adapter and local service are functional: an earlier real add/search smoke completed successfully. During the formal Memory Quality ingestion window, however, the DeepSeek-compatible upstream used for Mem0's **memory extraction** became unstable. This is a construction-time dependency of the tested backend, not an answer/judge dependency.

Observed, separately logged transport failures included:

- `curl 52: Empty reply from server` after approximately 19 s and 30 s;
- Node keep-alive `socket hang up` after approximately 27 s;
- a later small-batch probe failed during TLS setup with `curl 28: SSL connection timeout`.

The harness was tightened to one ingestion worker, one upstream request at a time, bounded retries, a 180 s hard timeout, and failure logging. Because failures persisted across both curl and Node transports and even before request delivery, the formal Mem0 run was stopped rather than allowed to consume repeated extraction calls.

A DNS-pinned transport experiment (`api.deepseek.com` resolved to `183.131.191.171`) showed that a plain zero-token HTTPS request could complete normally and one real Mem0 extraction succeeded (8,019 prompt + 102 completion tokens, 15.97 s). The immediately following pinned-IP extraction still failed with `curl 52: Empty reply from server` after 16.7 s. Therefore DNS pinning was not sufficient to make the extraction path reproducibly healthy, and the formal run remained paused.

These failed probes are **not** scored as Mem0 memory-quality failures. Mem0 remains `pending / upstream transport blocked` until construction can be completed under the same protocol. Hindsight construction is likewise not started while this upstream window is unhealthy, because doing so would confound backend quality with the same external transport failure.

### 9.2 Publication rule for incomplete backends

A backend with incomplete construction/search is shown as `N/A (blocked)` and is excluded from ranking. It is never assigned a zero. The report must state the blocker and the stage at which it occurred.
