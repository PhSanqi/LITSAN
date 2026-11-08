# More raw-evidence slots: frozen criteria and stop rule / 更多原始证据位：冻结标准与停止规则

Date: 2026-11-07. Written after building the flags and before running any P3 arm. Follows P2 (`P2-PACKING-CRITERIA.md`, rejected).
日期：2026-11-07。在实现开关之后、运行任何 P3 组之前写定。承接 P2（`P2-PACKING-CRITERIA.md`，已否决）。

## Question / 问题
- EN: P2 showed that reordering the 7 raw slots only trades one source of hits for another, and that the Turn Knowledge Plan caps supporting entries at 8 (1 fact chronology + 7 raw turns). P3 asks whether more slots help: more semantic turns, or the same semantic turns plus the cited turns that do not fit today. The user asked to keep exploring until there is a clear signal either way.
- 中文：P2 表明，对 7 个原始证据位重新排序只是用一种命中来源换另一种；且 Turn Knowledge Plan 将 supporting 条目上限设为 8（1 个事实时间线 + 7 个原始轮次）。P3 检验更多证据位是否有用：更多语义轮次，或在保留语义轮次的同时加入目前放不下的被引用轮次。用户要求持续探索，直到出现明确的正面或负面信号。

## Arms / 实验组
- EN: All with `LITSAN_DERIVED_FACT_RETRIEVAL=semantic`, `LITSAN_DERIVED_RAW_EVIDENCE=always`, on the existing P0 state. When `LITSAN_DERIVED_RAW_EVIDENCE_MAX` > 8, the plan admits MAX + 1 supporting entries.
  - `C2`: current code (7 raw).
  - `S12` / `S16`: MAX 12 / 16, semantic order.
  - `L8C12` / `L8C16`: MAX 12 / 16, `ORDER=cited_first`, `SEMANTIC_LEAD=8`: the first 8 semantic turns, then cited turns for the remaining 4 / 8 slots.
- 中文：均设置 `LITSAN_DERIVED_FACT_RETRIEVAL=semantic`、`LITSAN_DERIVED_RAW_EVIDENCE=always`，使用现有 P0 状态。当 `LITSAN_DERIVED_RAW_EVIDENCE_MAX` > 8 时，计划接纳 MAX + 1 个 supporting 条目。
  - `C2`：当前代码（7 个原始轮次）。
  - `S12` / `S16`：上限 12 / 16，语义顺序。
  - `L8C12` / `L8C16`：上限 12 / 16，`ORDER=cited_first`，`SEMANTIC_LEAD=8`：前 8 个语义轮次，其余 4 / 8 个位置给被引用轮次。

## Sets / 数据集
- EN: Tuning pool `sets/p3-tune-pool.json` (sha256 `55de0d92…`, 649 questions): dev 50, holdout 57, fresh 85 (all already seen) and `signal_tune` 457. Confirm set: `confirm` part of `sets/signal-set.json` (sha256 `27e8088d…`, 468 questions). The signal set is every LoCoMo question with evidence that no earlier experiment used (category 4 single-hop and category 3 open-domain; categories 1/2 are exhausted), split in half by conversation and category, seed 20261107. Confirm is run once, for C2 and the chosen arm only.
- 中文：调参池 `sets/p3-tune-pool.json`（sha256 `55de0d92…`，649 题）：dev 50、holdout 57、fresh 85（均已见过）和 `signal_tune` 457。确认集：`sets/signal-set.json` 的 `confirm` 部分（sha256 `27e8088d…`，468 题）。信号集为此前任何实验都未用过、且带证据的全部 LoCoMo 题（类别 4 单跳与类别 3 开放域；类别 1/2 已用尽），按对话与类别对半划分，种子 20261107。确认集只运行一次，且只运行 C2 与选中组。

## Selection on the tuning pool / 调参池上的选择
- EN: Among arms whose complete raw-or-cited count is ≥ C2's, pick the highest complete raw count, then higher raw recall, then fewer bytes. If no arm beats C2 on complete raw by more than 1% of the pool (7 questions), record that as a negative signal and still run the confirm set for the best arm.
- 中文：在原文或引用完整证据数 ≥ C2 的组中，选原文完整证据数最高者，其次原文召回更高者，再次字节更少者。若没有任何组在原文完整证据上超过 C2 达调参池的 1%（7 题），记录为负面信号，但仍对最佳组运行确认集。

## Verdict on the confirm set (chosen arm vs C2) / 确认集判定（选中组对 C2）
- EN: **Useful**: complete raw gained > lost with exact McNemar p ≤ 0.01; complete raw-or-cited not lower with p ≤ 0.05; mean response ≤ 16 KB; p95 latency ≤ C2 + 50 ms. A useful result is a release candidate only after a separate approval.
- 中文：**有用**：原文完整证据增多于减，精确 McNemar p ≤ 0.01；原文或引用完整证据没有 p ≤ 0.05 的下降；平均响应 ≤ 16 KB；p95 延迟 ≤ C2 + 50 ms。有用的结果需另行批准才成为发布候选。
- EN: **Clearly useless**: the 95% confidence interval of the paired difference in complete raw (normal approximation, (gained − lost) / n) has an upper bound below +2 percentage points, or the point estimate is ≤ 0.
- 中文：**明确无用**：原文完整证据配对差（正态近似，(增 − 减) / n）的 95% 置信区间上界低于 +2 个百分点，或点估计 ≤ 0。
- EN: **Inconclusive**: anything else; report the interval and do not roll out.
- 中文：**不确定**：其他情况；报告区间，不上线。
- EN: No parameter changes after the confirm run.
- 中文：确认集运行之后不再改动任何参数。
