# Memory Arena: Memory Quality Protocol

Status: public benchmark protocol draft, 2026-10-24.

## 1. What this benchmark measures

The primary Memory Arena scorecard measures the **memory layer itself**: whether a system stores useful information, retrieves the evidence required by a later query, and does so with low latency, low context footprint, and auditable cost.

It intentionally separates memory quality from answer-generation quality.

For LoCoMo, each evaluation question includes one or more gold evidence turn IDs such as `D1:3`. These dataset-provided evidence turns are the reference for retrieval evaluation.

## 2. What is excluded from the primary leaderboard

The following stages are **not** part of the Memory Quality primary leaderboard:

1. Reader / answer generation from retrieved context.
2. LLM-as-a-Judge grading of generated answers.
3. BLEU/F1 over generated answer wording.
4. Reflection/agentic answer loops whose output is already a synthesized answer rather than retrieved memory.

These stages may be reported separately as an **End-to-End QA appendix**, but they do not determine the primary Memory Quality ranking.

Why: end-to-end QA mixes at least three variables: memory construction, retrieval quality, and reader/judge model behavior. A retrieval failure and a reader failure are different failures. The primary leaderboard is designed to isolate the former two.

## 3. Dataset scope

Primary dataset: LoCoMo 10-conversation set.

- Evaluation questions: all LoCoMo QA records used by the existing OmniMemEval LoCoMo lane, excluding category 5 exactly as the harness does today.
- Gold evidence: the dataset's `evidence` field, resolved to original conversation turns by `dia_id`.
- Categories are reported separately in addition to the aggregate scorecard.
- LoCoMo JSON category IDs are fixed as: `1=multi-hop`, `2=temporal`, `3=open-domain`, `4=single-hop`, `5=adversarial`. Category 5 is excluded from the 1,540-question primary lane. The mapping is stored in every evaluator output because the JSON IDs do not follow the paper table's display order.

No gold answer text is used to decide strict retrieval success.

## 4. Retrieval contract

Each backend receives the same question text and the same declared retrieval depth `K`.

The existing LoCoMo harness keeps separate memory identities for the two conversation speakers for generic backends and searches both. For those backends, `K` means **K items per speaker lane**, and evidence coverage is computed over the union of both lanes at that depth. The trace preserves both lane rankings. It is not rewritten into a fictitious global rank. A shared-conversation backend that natively searches one bank is reported as a single lane.

Required public run metadata:

- backend name and exact version/commit;
- memory-construction configuration;
- embedding/reranker models;
- retrieval depth;
- whether retrieval is single-query or agentic/multi-query;
- whether returned memories are raw passages, extracted facts, summaries, profiles, or a mixture;
- any filters, thresholds, MMR/diversity settings, temporal reranking, or entity expansion;
- whether the system can return source/provenance references.

A backend may transform memories during ingestion. That is allowed, but transformed memories must not be treated as exact source-turn hits unless provenance supports that claim.

## 5. Primary metrics

### 5.1 Provenance Evidence Recall@K

Applicable when a retrieved item carries auditable source/evidence references.

For a query with gold evidence set `G` and the union of evidence references attached to the first `K` retrieved items `R_K`:

`Recall@K = |G ∩ R_K| / |G|`

Report macro average across questions and micro average across evidence turns.

### 5.2 Evidence Hit@K

`Hit@K = 1` when at least one gold evidence turn is represented by the first `K` retrieved items, otherwise `0`.

Report Hit@1, Hit@5, Hit@10, and Hit@20 where the backend exposes that depth.

### 5.3 MRR

For traceable single-lane retrieval, MRR is the reciprocal rank of the first retrieved item whose provenance intersects the gold evidence set. Queries with no hit contribute zero. For dual-speaker traces, the report labels the statistic `per-lane MRR`: it uses the best first-hit rank across the two independently ranked lanes and does not claim a global rank.

### 5.4 Strict Turn Coverage

A deterministic fallback/diagnostic metric. A gold turn is strictly covered when its normalized source text is contained in the retrieved context or a retrieved item. Normalization is Unicode NFKC, lowercase, punctuation/whitespace canonicalization only. No semantic model is involved.

This metric is intentionally conservative for abstractive memory systems and is never mislabeled as provenance recall.

### 5.5 Gold Evidence Similarity

A model-based but non-generative semantic diagnostic for systems that rewrite or summarize memories.

- evaluator: `BAAI/bge-small-en-v1.5`;
- execution: local embeddings only, no answer LLM and no LLM judge;
- with structured traces, each gold evidence turn is compared with each retrieved memory item;
- for historical context-only artifacts, the formatted context is deterministically split into fragments no longer than 1,200 characters solely for embedding evaluation; these fragments are not treated as retrieved ranks or provenance hits;
- per-evidence score: maximum cosine similarity to any retrieved item;
- per-query score: mean over that query's gold evidence turns;
- aggregate: macro mean over queries plus category breakdown.

The continuous similarity is published directly. The primary report does **not** silently tune a pass/fail threshold on the test set.

If a thresholded semantic recall metric is later added, the threshold and its calibration split must be published separately and frozen before scoring the public test set.

### 5.6 Context footprint

Report retrieved context tokens per query using `cl100k_base` for accounting consistency, irrespective of the backend's own model tokenizer:

- mean;
- median / P50;
- P95;
- maximum.

This is an accounting tokenizer, not a claim about provider billing tokens.

### 5.7 Evidence efficiency

Report useful evidence against retrieved context size, including:

- strict gold evidence turns recovered per 1,000 retrieved tokens;
- provenance-covered gold evidence turns per 1,000 retrieved tokens where provenance is available;
- Gold Evidence Similarity alongside token footprint rather than collapsing both into an opaque composite score.

### 5.8 Gold Session Recall@K (supplementary)

If a backend exposes an unambiguous source **session** for each retrieved item but does not expose the exact source turn, derive the gold session set from LoCoMo evidence IDs (`D7:12` → session 7) and report Gold Session Recall@K / Hit@K. This is a weaker provenance guarantee than source-turn Recall@K: retrieving some memory from the correct session does not prove that the exact gold turn was recovered. Therefore session-level metrics are labeled separately and are never compared numerically as if they were turn-level evidence recall.

For dual-speaker retrieval, K remains **per speaker lane**, and coverage is measured over the union of both lanes at that K.

### 5.9 Search latency

Report wall-clock search latency P50, P95, and mean from the benchmark client. Networked/cloud backends must be labeled as such.

### 5.10 Empty / failed retrieval rate

Report the fraction of queries with an empty retrieval and the fraction with an execution failure separately.

### 5.11 Memory construction cost

Report separately from retrieval:

- ingestion wall-clock time;
- number/size of produced memories where measurable;
- storage footprint where measurable;
- backend-internal LLM prompt/completion tokens where measurable;
- embedding/reranker model and local/cloud execution;
- failed/retried internal operations.

Do not merge memory-construction LLM usage with reader or judge usage.

## 6. Metrics that require a structured retrieval trace

`Recall@K`, `Hit@K`, and `MRR` require ordered retrieved items and source references or an explicitly declared deterministic source mapping.

A formatted context blob is **not** sufficient evidence for a rank-sensitive provenance metric. Existing historical runs that saved only `query/context/duration/status` may be used for context-level coverage, token footprint, and latency, but must not be presented as provenance Recall@K or MRR.

For such historical runs, Memory Arena may perform a search-only trace replay against the already-built memory store. Search-only replay must:

- use the same stored memories;
- use the same query text and retrieval configuration;
- perform no new ingestion;
- perform no answer generation or LLM judging;
- record that the trace was replayed after the original run.

## 7. Retrieval-depth curve

Where practical, report memory quality at `K ∈ {1, 5, 10, 20}` instead of publishing only the best depth. This prevents a system from appearing better merely by returning much more context.

If a backend cannot represent an exact item count because its API is token-budget based, report its native budget and do not pretend it is equivalent to item-K.

## 8. No single hidden composite score

The public primary table is multi-axis. At minimum it shows:

- evidence retrieval quality;
- semantic evidence coverage;
- context footprint;
- latency;
- ingestion cost.

Memory Arena does not publish a weighted "overall" score unless the weighting formula is declared before evaluation and the component values remain visible.

## 9. End-to-End QA appendix

Existing full-pipeline results are retained for external comparability. They must be labeled with:

- answer model;
- judge/scoring method;
- retrieval depth/context size;
- answer tokens;
- judge tokens;
- exact benchmark/harness version.

They are not directly comparable to Memory Quality retrieval-only metrics.

## 10. Fairness rules

1. Same dataset split and query text for every backend.
2. No backend-specific answer hints or hidden gold evidence injection.
3. Backend-native memory construction is allowed and counted as cost.
4. Backend-native retrieval/reranking is allowed and disclosed.
5. Search-only trace replay is allowed only against an already-built store and is labeled.
6. Retries and failures are reported, not silently discarded.
7. Missing provenance is reported as unsupported, not scored as zero provenance accuracy and not inferred from semantic similarity.
8. Public headline numbers from other projects are shown only when their scope matches. Retrieval-only and full-pipeline QA scores are never placed in the same metric column.

## 11. Relationship to public benchmarks

This protocol deliberately follows the decomposition advocated by LongMemEval (indexing, retrieval, reading) and uses LoCoMo's own evidence annotations as the retrieval gold. Recent public memory-system work also reports retrieval-only evidence metrics separately from end-to-end QA. The public report should cite the exact external methodology used for any comparison rather than relying on vendor headline labels alone.

Reference starting points:

- LoCoMo: Maharana et al., ACL 2024, https://aclanthology.org/2024.acl-long.747/
- LongMemEval: Wu et al., ICLR 2025, https://proceedings.iclr.cc/paper_files/paper/2025/hash/d813d324dbf0598bbdc9c8e79740ed01-Abstract-Conference.html
- Hindsight LoCoMo reranker evidence-turn evaluation, 2026-09-24: https://hindsight.vectorize.io/blog/2026/09/24/adding-jev-reranker-what-we-learned
- Mem0 benchmark methodology discussion, 2026-10-08: https://mem0.ai/library/agent-memory/how-to-read-memory-benchmarks

---

## 中文说明

Memory Quality 主榜只回答一个问题：**记忆系统本身有没有把之后回答问题所需的证据记下来，并在有限检索预算内找回来？**

因此主榜去掉回答模型和 LLM Judge。LoCoMo 自带的 `evidence` turn ID 是严格 gold。能追溯来源的系统直接算 Recall@K / Hit@K / MRR；只返回摘要或抽象记忆的系统另外报告固定开源 embedding 的 Gold Evidence Similarity，但不会把语义相似度冒充成严格证据命中。

最终回答质量仍可作为附录保留，用于和公开 LoCoMo headline 分数对照，但不能与 retrieval-only 指标混为同一列。

## 10. Reproducibility artifacts

The machine-readable contract is [`memory-quality-v1.json`](./memory-quality-v1.json). The deterministic evaluator and its unit tests are versioned beside this protocol. Public results MUST name the contract version and state whether strict provenance metrics are available for each backend.

## 11. Relationship to published benchmarks

This protocol is intentionally a **retrieval/memory-layer diagnostic**, not a replacement for the original end-to-end LoCoMo score. The distinction is supported by the benchmark literature:

- LoCoMo (ACL 2024) evaluates long-term conversational memory through downstream tasks including question answering, event summarization, and dialogue generation: <https://aclanthology.org/2024.acl-long.747/>
- LongMemEval (ICLR 2025) explicitly decomposes long-term memory into **indexing, retrieval, and reading**, and reports memory-recall analysis separately from downstream QA: <https://proceedings.iclr.cc/paper_files/paper/2025/hash/d813d324dbf0598bbdc9c8e79740ed01-Abstract-Conference.html>
- Mem0's public work reports full-pipeline LoCoMo quality together with retrieval latency/token footprint, and explicitly distinguishes retrieval efficiency from final answer quality: <https://arxiv.org/abs/2504.19413> and <https://mem0.ai/research>
- Hindsight has published a LoCoMo reranker evaluation where gold is the dataset's own evidence turns and metrics include Recall@1, Recall@5, and NDCG@10: <https://github.com/vectorize-io/hindsight/blob/main/hindsight-docs/blog/2026-09-24-adding-jev-reranker-what-we-learned.md>

Accordingly, any published table from this protocol MUST label Memory Quality metrics as retrieval-only/memory-layer metrics and MUST NOT compare them numerically against full-pipeline LoCoMo answer-accuracy headline scores.

