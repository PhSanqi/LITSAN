# Memory Arena local backend status

Status date: 2026-10-23

All third-party source checkouts are review/runtime artifacts under `.review-runtime/memory-arena/backends/`; they are not production dependencies and are not shipped with Memhub.

| Backend | Local source | Runtime shape | Unified DeepSeek answer/judge | Internal DeepSeek candidate | Current Arena status |
| --- | --- | --- | --- | --- | --- |
| Memhub | canonical workspace | isolated Memhub stack | yes | Harness-owned | adapter pending |
| MemOS | cloned | Python + local service / Docker | yes | likely via universal/OpenAI-compatible API | source pinned |
| EverOS | cloned | Python local server + SQLite/LanceDB | yes | yes, OpenAI-compatible LLM | source pinned; local env setup in progress |
| mem9 | cloned | Go/service + SQL backend | yes | adapter-dependent | source pinned; runtime later |
| MemMachine | cloned | Python + PostgreSQL/Neo4j stack | yes | configurable | source pinned; DB stack later |
| Graphiti | cloned | Python + Neo4j/FalkorDB | yes | OpenAI-compatible possible; structured-output compatibility must be measured | source pinned; DB stack later |
| Hindsight | cloned | Python/API + PostgreSQL or local package | yes | yes, explicit DeepSeek/OpenAI-compatible providers | source pinned |
| Mem0 | cloned | FastAPI + PostgreSQL/pgvector stack | yes | yes/configurable | source pinned |
| Letta | cloned | agent runtime | yes | OpenAI-compatible/provider-dependent | source pinned; semantic integration later |
| Cognee | cloned | Python + graph/vector stack | yes | configurable | source pinned; DB/model stack later |
| Supermemory Local | cloned public repo; self-host server distributed separately | local binary/service | yes | OpenAI-compatible | source pinned; report separately from pure OSS |

## Common evaluation model

All final answer and judge requests in one Arena run are routed through the local `memory-arena-deepseek-proxy.mjs`, which enforces:

```text
model = deepseek-flash
thinking.type = disabled
reasoning_effort = none
```

The proxy records prompt/cache/completion token usage and latency per run tag. The benchmark-only DeepSeek key is not passed to the memory backends for answer/judge calls.

## Primary leaderboard

The first reproducible leaderboard will contain only locally reproduced results. Vendor/cloud published scores are reference annotations, not leaderboard rows.

Primary datasets:

- LoCoMo
- LongMemEval-S
- HaluMem
- Memora/FAMA weekly (Arena extension; state validity / forgetting)

Secondary datasets after the main lane is stable:

- PersonaMem v2
- BEAM 100K subset before larger scales

