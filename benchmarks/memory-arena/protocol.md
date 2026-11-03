# Memory Arena adapter protocol

Every adapter must support these logical operations:

```text
health() -> backend/version/config summary
reset(namespace) -> empty isolated benchmark state
ingest(namespace, record[]) -> ingestion result + timing/usage
retrieve(namespace, query, limits) -> Evidence[] + timing
stats(namespace) -> object count / storage / backend-specific diagnostics
shutdown() -> release processes/containers owned by this adapter
```

Canonical evidence object:

```json
{
  "id": "backend-local stable id",
  "text": "evidence text",
  "score": 0.0,
  "source_ids": ["benchmark source/session id"],
  "kind": "fact|episode|profile|graph|document|other",
  "valid_from": null,
  "valid_to": null,
  "metadata": {}
}
```

`source_ids` are mandatory whenever the backend can preserve source lineage. Benchmark labels are never passed into retrieval. They are used only after retrieval for scoring.

## Isolation

Each backend gets:

```text
.review-runtime/memory-arena/backends/<id>/   source checkout or binary metadata
.review-runtime/memory-arena/state/<id>/      databases, volumes, caches
.review-runtime/memory-arena/results/<run>/   immutable run output
```

No adapter may read Memhub production databases, runtime secrets or production ports.


## Memory Quality primary leaderboard

The primary memory-layer-only evaluation is specified in [`memory-quality-protocol.md`](./memory-quality-protocol.md). End-to-end answer/judge runs are secondary appendix evidence and are not required to complete the primary Memory Quality leaderboard.
