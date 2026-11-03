# LITSAN Memory Arena

Purpose: run local, reproducible, apples-to-apples comparisons of long-term memory systems on the same server and datasets.

The primary upstream evaluation engine is **OmniMemEval**. It already implements a common memory-backend adapter layer and the LoCoMo / LongMemEval / BEAM / PersonaMem / HaluMem pipelines. LITSAN's Arena adds a LITSAN adapter, DeepSeek-only answer/judge routing, local-backend orchestration, Memora/FAMA state-validity evaluation, and stricter grounded metrics rather than forking the benchmark logic unnecessarily.

The Arena separates memory quality from answer-model quality. Every backend gets the same benchmark inputs. Retrieval/context is produced by the backend under test; final answer generation and blind judging use the same benchmark-only DeepSeek configuration.

## Tracks

1. `native`
   - Use the backend's native retrieval/context API.
   - Preserve its native ranking and memory representation.
   - Apply only a common hard maximum context-token budget before final answer generation.

2. `normalized`
   - Convert retrieved evidence to the Arena evidence schema.
   - Pack all systems to the same context-token budget.
   - This isolates memory-state/retrieval quality from systems that simply emit much larger prompts.

3. `provider-unified` (optional)
   - Use `deepseek-flash` with thinking disabled for ingestion/extraction when a backend supports a compatible provider cleanly.
   - Where the backend accepts an OpenAI-compatible embedding endpoint, use the Arena CPU embedding proxy (`BAAI/bge-small-en-v1.5`, 384 dimensions) so cloud embedding quality/cost is not a hidden variable.
   - This track is reported separately because some memory systems depend on provider-specific structured-output behavior.

## Datasets

- LoCoMo: long-conversation factual, temporal and multi-hop recall.
- LongMemEval-S: long-session retrieval and final QA.
- Memora/FAMA weekly: current-memory recall plus explicit forgetting/stale-memory tests.
- LITSAN semantic suite: authority, freshness, provenance, current-vs-history, workflow and passage-tail cases.

## Required metrics

- ingest wall time and backend peak memory where measurable
- stored/indexed object count and disk bytes
- retrieval p50/p95 latency
- retrieved/context tokens
- evidence Recall@K / All@K where benchmark labels permit it
- forgotten/stale fact pollution where labels permit it
- answer accuracy
- factual correctness
- critical omission rate
- strict grounded success
- constructive breadth
- answer outcome repeatability
- DeepSeek prompt/cache/output tokens and estimated API cost

## Fairness rules

- Production LITSAN is never used as an installation target for competing backends.
- All external backends live under `.review-runtime/memory-arena/backends/` and use isolated state directories/containers.
- Backends run serially by default. Do not keep graph DBs, Postgres stacks and local embedding models resident together.
- Do not use vendor-published scores as Arena results.
- Answer model and judge must be identical across systems inside one Arena run.
- Record exact backend git SHA/version and configuration with every run.
- `native` and `normalized` results must never be merged into one score.
- If a backend cannot run with DeepSeek for its internal ingestion model, keep its native/local ingestion path and record that difference explicitly rather than silently substituting behavior.
- The common answer and judge model is `deepseek-flash` with `thinking.type=disabled`. The Arena proxy enforces this regardless of a benchmark client's default model value.
- The benchmark-only DeepSeek credential is read only by the local Arena proxy. Backend processes receive the proxy URL or provider-specific credentials only when an ingestion track explicitly requires DeepSeek.

## Backend adapter contract

Each adapter must expose the operations documented in `protocol.md` and emit a backend-neutral evidence list. An adapter may call a local HTTP service, CLI, Python library or Docker stack, but the Arena runner sees one contract.

