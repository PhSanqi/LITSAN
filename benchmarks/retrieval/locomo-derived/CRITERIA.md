# P0 pass criteria (frozen before the harness exists) / P0 通过标准（在评测代码编写前冻结）

Date: 2026-11-07. Plan: `.review-runtime/attribution-20261106/BUILD-PLAN.md` §P0.

- EN: Arms: A = production default (no `DERIVED_FACT_RETRIEVAL`); B = `DERIVED_FACT_RETRIEVAL=semantic`, with fact-keyed raw L1 evidence returned. Same code, data and byte budget.
- 中文：对照组：A = 生产默认（不设 `DERIVED_FACT_RETRIEVAL`）；B = `DERIVED_FACT_RETRIEVAL=semantic`，并返回按事实键找到的 L1 原始证据。代码、数据与字节预算相同。
- EN: Questions: the §9 LoCoMo dev 50 and holdout 57 (`multihop/questions.json`). Gold = the LoCoMo evidence dia_ids, mapped to their L1 events.
- 中文：题目：§9 的 LoCoMo dev 50 题与 holdout 57 题（`multihop/questions.json`）；金标 = LoCoMo 证据 dia_id 对应的 L1 事件。
- EN: Pass, all required:
  1. Holdout gold-evidence recall B − A ≥ 0.05.
  2. No regression on `benchmarks/retrieval/p0-real-pipeline-baseline.json` and the Chinese A/B suite.
  3. ≥ 90% of sampled real LITSAN L2 fact `evidence_refs` resolve to L1 text.
  4. p95 latency increase ≤ 300 ms.
- 中文：通过标准，须全部满足：
  1. holdout 金标证据召回 B − A ≥ 0.05；
  2. `benchmarks/retrieval/p0-real-pipeline-baseline.json` 与中文 A/B 测试集无退步；
  3. 抽样的真实 LITSAN L2 事实中 ≥ 90% 的 `evidence_refs` 能解析到 L1 原文；
  4. p95 延迟增加 ≤ 300 ms。
- EN: Also reported, not gating: recall by category, complete-evidence count, delivered bytes, and whether B's gain comes from facts reaching distilled (excluded) L1 turns.
- 中文：另行报告、不作门槛：按类别召回、完整证据题数、交付字节数，以及 B 的提升是否来自事实触达已蒸馏（被排除）的 L1 轮次。
