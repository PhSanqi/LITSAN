# Memory Systems Comparison 2026-10-23 / 记忆系统横向对比 2026-10-23

This comparison deliberately separates public same-harness answer scores from Memhub's local evidence. Different answer models, judges, prompts and context budgets can move memory benchmark scores materially, so incompatible metrics are not merged into one leaderboard.

本对比刻意把“统一第三方 harness 的公开 Answer Accuracy”与“Memhub 当前本地证据”分开。Answer model、judge、prompt、context budget 都会显著影响记忆 benchmark，不能把不同口径强行合并成一个排行榜。

## 1. Public same-harness answer benchmark / 统一第三方 Answer Benchmark

Source: OmniMemEval reproduced snapshot, answer model `gpt-4.1-mini-2025-04-14`, judge `gpt-4o-mini-2024-07-18`.

来源：OmniMemEval reproduced snapshot，统一使用 `gpt-4.1-mini-2025-04-14` 作为 answer model、`gpt-4o-mini-2024-07-18` 作为 judge。

| System | LoCoMo Answer Accuracy | LongMemEval Answer Accuracy | LoCoMo avg context | LongMemEval avg context |
| --- | ---: | ---: | ---: | ---: |
| **MemOS** | **88.83%** | **89.20%** | 5,400 | 4,151 |
| EverOS | 82.75% | 80.40% | 8,559 | 12,379 |
| Zep / Graphiti | 63.83% | 79.80% | **1,862** | 117,106 |
| mem9 | 73.64% | 78.00% | **1,597** | 3,805 |
| Letta | 77.12% | 77.67% | 14,188 | 49,431 |
| Hindsight | 81.99% | 72.20% | 24,683 | 29,755 |
| Supermemory | 73.53% | 66.07% | 15,238 | 6,635 |
| MemMachine | 73.90% | 63.60% | 2,577 | 2,803 |
| Mem0 | 77.68% | 56.00% | 17,395 | **856** |
| Cognee | 83.48% | 51.80% | 32,532 | 10,305 |
| **Memhub** | **not same-harness yet** | **not same-harness yet** | — | — |

Reference: https://github.com/MemTensor/OmniMemEval/blob/main/docs/user_memory/results.md

## 2. Memhub evidence already measured / Memhub 当前已有实测证据

| Evidence | Current-style baseline | Frozen Shared-Demand architecture | Change |
| --- | ---: | ---: | ---: |
| Memora/FAMA Fact Recall@5 | 48.3% | **89.0%** | **+40.7 pp** |
| Memora/FAMA Fact Recall@10 | 57.5% | **98.7%** | **+41.2 pp** |
| Forgotten Fact Pollution@5 | 50.0% | **2.7%** | **-47.3 pp** |
| Forgotten Fact Pollution@10 | 53.3% | **2.7%** | **-50.6 pp** |
| Internal answer Strict Grounded Success, DeepSeek-chat, 3 repeats | 47.2% | **91.7%** | **+44.5 pp** |
| Internal answer Factual Correctness | 88.9% | **100%** | **+11.1 pp** |
| Internal answer Critical Omission | 52.8% | **8.3%** | **-44.5 pp** |

These Memhub rows are not a replacement for the public same-harness Answer Accuracy table. They answer a different question: whether the frozen architecture improves the same Memhub workload relative to the current-style baseline.

这些 Memhub 数据不是公开统一 Answer Accuracy 表的替代品，而是在回答另一个问题：冻结架构相对于当前式 Memhub baseline，到底改善了多少。

## 3. Architecture at a glance / 架构一眼对比

| System | Core representation | Update / stale handling | Retrieval / planning characteristic | Closest Memhub overlap |
| --- | --- | --- | --- | --- |
| **Memhub** | L1 evidence → L2 timeline → L3 Current Truth → L4 stable profile + Architecture + Skill | Explicit current-vs-history authority; typed lifecycle semantics | Shared Knowledge Demand → Conditional Admission → Aligned TKP → role-aware packing | Current Truth governance + typed turn allocation |
| **MemOS** | Plaintext / activation / parametric memory, MemCube containers | Update, merge, archive and lifecycle management | MemScheduler coordinates memory types; vector/graph retrieval; configurable Top-K/Top-N | Closest on cross-type scheduling, but Memhub uses one turn-local typed demand contract across Admission + TKP |
| **Zep / Graphiti** | Temporal context graph: entities, relationships, episodes | Old facts are explicitly invalidated while temporal history is retained | Vector + full-text + graph traversal | Closest on temporal validity/current-vs-history semantics |
| **Hindsight** | World facts + experiences + observations + mental models + knowledge pages | Observations are refined with evidence/history; freshness-aware consolidation | Semantic + keyword + graph + temporal retrieval; token-budgeted Recall/Reflect | Closest on layered durable beliefs + evidence-grounded synthesis |
| **Supermemory** | Atomic facts connected to entities/time; documents remain source material | Graph updates, derives and forgets as inputs change | Profile/search/SMFS retrieval surfaces | Closest on atomic state over time and explicit forgetting |
| **Mem0** | Extracted memories in vector storage, optional graph relations | Memory management updates and resolves contradictions | Semantic vector search; optional graph context and reranking | Closest on compact fact extraction and simple retrieval integration |
| **Letta** | Agent-editable git-backed MemFS | Agent decides where durable knowledge belongs and edits memory over time | Agent reads/edits filesystem memory as part of its workflow | Closest on explicit editable durable state; less deterministic retrieval governance |

Public architecture references:

- MemOS: https://memos-docs.openmem.net/open_source/home/architecture/
- Zep / Graphiti: https://www.getzep.com/platform/graphiti/
- Hindsight: https://docs.hindsight.vectorize.io/enterprise/how-hindsight-works/
- Supermemory: https://supermemory.ai/product/
- Mem0: https://docs.mem0.ai/open-source/features/graph-memory
- Letta: https://docs.letta.com/configuration/memory

## 4. Practical reading / 怎么看这张表

EN: Memhub is not currently justified as "better than MemOS/Zep/etc." on a public answer leaderboard because the same-harness Answer Accuracy run has not been executed. What is already justified is narrower but important: on the same Memhub workloads, materialized Current Truth + typed Conditional Admission sharply improves valid-fact recall, suppresses obsolete memory, and produces substantially more grounded final answers than the current-style context pipeline.

中文：当前还不能把 Memhub 宣称为“公开 leaderboard 上优于 MemOS/Zep 等”，因为尚未跑同一套 Answer harness。现在已经可以成立的结论更窄，但更扎实：在同一 Memhub workload 上，Materialized Current Truth + typed Conditional Admission 显著提高有效事实召回、压制失效记忆，并且相比当前式 context pipeline 明显提高最终回答的 grounded success。
