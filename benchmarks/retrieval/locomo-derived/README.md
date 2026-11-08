# LoCoMo production-path evidence experiments / LoCoMo 生产路径证据实验

- EN: Measures which LoCoMo gold evidence turns reach the Harness through the real `litsan_context` path (isolated stack, real `litsan_turn` captures, Core-written L2 revisions). No model calls; every arm is a set of environment flags on the same ingested state. Findings across all rounds: `FINDINGS.md` (public summary; the internal review notes under `docs/reviews/` are not published). Numbers per round: `RESULTS.md`.
- 中文：测量 LoCoMo 金标证据轮次中有哪些能经真实 `litsan_context` 路径到达 Harness（隔离栈、真实 `litsan_turn` 捕获、由 Core 写入的 L2 修订）。不调用模型；每个实验组都是同一份已导入状态上的一组环境开关。各轮结论见 `FINDINGS.md`（公开摘要；`docs/reviews/` 下的内部评审记录不公开），各轮数字见 `RESULTS.md`。

## Rounds / 轮次

| Round / 轮次 | Criteria (frozen first) / 标准（先冻结） | Question / 问题 | Outcome / 结果 |
|---|---|---|---|
| P0 | `CRITERIA.md` | Do derived facts reach turns after distillation? / 蒸馏后派生事实能否触达轮次？ | Pass; holdout complete 27 → 37 / 通过 |
| P1 | `P1-CRITERIA.md` | Always return the raw turns behind facts / 始终返回事实背后的原始轮次 | Pass, live since 20261107-derived-raw-evidence / 通过并已上线 |
| P2 | `P2-PACKING-CRITERIA.md` | Reorder the 7 raw slots by citation / 按引用重排 7 个原始证据位 | Rejected (fresh −6 raw-or-cited, p = 0.03); code in `p2-packing-experiment.patch` / 否决 |
| P3 | `P3-SLOTS-CRITERIA.md` | More raw slots, both lanes / 两条通道都增加证据位 | Tuning +109 / −0 at +5.5 KB; confirm not run / 调参 +109/−0，确认集未运行 |
| P5 | `P5-LEAN-ADAPTIVE-CRITERIA.md` | Lean output; model-free adaptive stopping / 精简输出；无模型自适应停止 | N4200 confirm 359 vs KL3000 350 at −23% bytes, new release candidate; stopping rules failed / N4200 为新发布候选；停止规则失败 |
| P4 | `P4-BUDGET-CRITERIA.md` | Compact entry + byte budget instead of slot count / 紧凑条目 + 字节预算替代位数 | Confirm 465: KL3000 complete raw 280 → 350 (70 / 0) at 10.65 KB; useful, release candidate / 确认集通过，发布候选 |
| P6 | `P6-FOLLOWUP-NOVELTY-CRITERIA.md` | Follow-up queries with novelty limits vs byte-matched control / 带新颖性限制的补查对比字节匹配对照 | Failed on tuning (no arm beats its matched control); final set not run; `docs/reviews/2026-11-07-followup-novelty-review.md` / 调参失败，未运行最终集 |
| P7 | `P7-FIRST-CALL-SWEEP-CRITERIA.md` | Model-free first-call sweep (byte budget, ordering, lead, fact lane) and test-process v2 / 无模型首次调用扫描（字节预算、排序、lead、事实通道）与测试流程 v2 | Validated on 183 untouched Qs: `ci8-b6000` 122 → 137 (15 / 0, p = 6e-5) at +3.2 KB; Max 145; Lean failed (underpowered) / 在 183 道未用过的题上已验证 |

## Files / 文件
- EN: `run.mjs` ingest / query / score (flags: `P0_ARMS`, `P0_QUESTIONS`, `P0_PARTS`, `P0_SCORE_ARMS`, `P0_SCORE_FILE`, `P0_CORE_PORT`, `P0_OUT`); `paired.py`, `paired-p2.py`, `paired-p3.py` paired exact McNemar and 95% CI; `ref-resolution.py` P0 criterion 3 on the real L2.
- 中文：`run.mjs` 导入/查询/评分（开关：`P0_ARMS`、`P0_QUESTIONS`、`P0_PARTS`、`P0_SCORE_ARMS`、`P0_SCORE_FILE`、`P0_CORE_PORT`、`P0_OUT`）；`paired.py`、`paired-p2.py`、`paired-p3.py` 为配对精确 McNemar 与 95% 置信区间；`ref-resolution.py` 为 P0 标准 3 在真实 L2 上的检查。
- EN: `sets/graph-holdout-locomo.json` (85, the LoCoMo part of the typed-graph study's frozen holdout, used once as P2 `fresh`); `sets/signal-set.json` (925 LoCoMo category 3/4 questions no earlier experiment used, split `tune` 457 / `confirm` 468, seed 20261107; `confirm` used once for P4); `sets/p3-tune-pool.json` (649 = dev 50 + holdout 57 + fresh 85 + signal tune 457).
- 中文：`sets/graph-holdout-locomo.json`（85 题，类型化图研究冻结 holdout 的 LoCoMo 部分，作为 P2 的 `fresh` 使用过一次）；`sets/signal-set.json`（925 道此前实验均未使用的 LoCoMo 类别 3/4 题，按种子 20261107 分为 `tune` 457 / `confirm` 468；`confirm` 已为 P4 使用一次）；`sets/p3-tune-pool.json`（649 = dev 50 + holdout 57 + fresh 85 + signal tune 457）。
- EN: Benchmark data is read from `LITSAN_BENCH_DATA` (default `<repo>/.review-runtime`): `benchmarks/data/locomo10.json`, `attribution-20261106/multihop/questions.json`. Responses and state are under `.review-runtime/locomo-derived/` (git-ignored; regenerate with `run.mjs ingest` then `query`).
- 中文：基准数据从 `LITSAN_BENCH_DATA`（默认 `<repo>/.review-runtime`）读取：`benchmarks/data/locomo10.json`、`attribution-20261106/multihop/questions.json`。响应与状态位于 `.review-runtime/locomo-derived/`（已被 git 忽略；可通过 `run.mjs ingest` 再 `query` 重新生成）。

## Flags added on this branch (all default off) / 本分支新增开关（均默认关闭）
- EN: `LITSAN_DERIVED_RAW_EVIDENCE_ORDER` = `cited_first` | `fused` | `interleave`; `LITSAN_DERIVED_RAW_EVIDENCE_SEMANTIC_LEAD` = N semantic turns kept first; `LITSAN_DERIVED_RAW_EVIDENCE_MAX` = 1–16 (above 8 the plan admits MAX + 1 supporting entries); `LITSAN_DERIVED_RAW_EVIDENCE_BYTES` = byte budget for raw text, emitted as one compact entry. None is in production.
- 中文：`LITSAN_DERIVED_RAW_EVIDENCE_ORDER` = `cited_first` | `fused` | `interleave`；`LITSAN_DERIVED_RAW_EVIDENCE_SEMANTIC_LEAD` = 优先保留的语义轮次数 N；`LITSAN_DERIVED_RAW_EVIDENCE_MAX` = 1–16（大于 8 时计划接纳 MAX + 1 个 supporting 条目）；`LITSAN_DERIVED_RAW_EVIDENCE_BYTES` = 原始文本字节预算，作为一个紧凑条目输出。均未进入生产。

## Related branches / 相关分支
- EN: `research/typed-graph-20261107` (typed-relation graph study, `research/typed-graph/REPORT.md`; carries about 3,200 cached model responses, not for merging). `experiment/concept-key-20261107` (concept-label key, `LITSAN_CONCEPT_KEY`, not shown).
- 中文：`research/typed-graph-20261107`（类型化关系图研究，`research/typed-graph/REPORT.md`；含约 3,200 份缓存的模型响应，不用于合并）。`experiment/concept-key-20261107`（概念标签键 `LITSAN_CONCEPT_KEY`，未显示收益）。
