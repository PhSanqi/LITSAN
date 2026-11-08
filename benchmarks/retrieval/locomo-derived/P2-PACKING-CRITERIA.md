# Raw-evidence packing: frozen criteria / 原始证据打包：冻结标准

Date: 2026-11-07. Written before any packing code or arm run. Branch `experiment/p0-derived-fact-eval-20261107` at `042d6b54`.
日期：2026-11-07。在编写任何打包代码、运行任何组之前写定。分支 `experiment/p0-derived-fact-eval-20261107`，`042d6b54`。

## Why / 动机
- EN: The typed-graph study (`research/typed-graph-20261107`, REPORT §7) found that spending the budget on context around every hit cost more than any graph gained. Production does not add neighbour turns, so that exact fix does not apply. The production analogue, measured on the P1 arm C responses, is the raw slots: every question gets 7 raw turns. 497 of 749 (66%) are turns that no delivered fact cites, chosen by a semantic search over all of the conversation's turns, while 38 holdout gold turns are cited by a delivered fact but never returned as raw text. In `directEvidenceFromFacts` fact citation only adds candidates; it never affects their rank.
- 中文：类型化图研究（`research/typed-graph-20261107`，REPORT §7）发现，把预算花在每个命中项周围的上下文上，损失超过任何图带来的增益。生产不添加邻居轮次，因此该修正不能直接套用。在 P1 C 组响应上测得的生产对应问题是原始证据位：每题固定得到 7 个原始轮次，其中 749 个中有 497 个（66%）不被任何交付的事实引用，而是由对整段对话所有轮次的语义搜索选出；与此同时，holdout 有 38 个金标轮次被交付的事实引用，却从未以原文返回。在 `directEvidenceFromFacts` 中，事实引用只增加候选，从不影响排序。

## Arms / 实验组
- EN: All arms run with `LITSAN_DERIVED_FACT_RETRIEVAL=semantic` and `LITSAN_DERIVED_RAW_EVIDENCE=always` on the existing P0 state (same L1 captures, same L2 revisions). `C2` = current code (control, equal to the live release apart from the use text). Candidates, set by `LITSAN_DERIVED_RAW_EVIDENCE_ORDER` and `LITSAN_DERIVED_RAW_EVIDENCE_MAX`:
  - `D8` / `D12`: cited first. Turns cited by the selected facts, in fact-score order (round-robin over each fact's refs), fill the slots first; remaining slots keep today's semantic order. Max 8 / 12.
  - `E8` / `E12`: fused. Reciprocal-rank fusion (k = 60) of the semantic rank and the citation rank (uncited turns get only the semantic term). Max 8 / 12.
- 中文：所有组均在现有 P0 状态（相同 L1 捕获、相同 L2 修订）上运行，设置 `LITSAN_DERIVED_FACT_RETRIEVAL=semantic` 与 `LITSAN_DERIVED_RAW_EVIDENCE=always`。`C2` = 当前代码（对照，除 use 文案外与线上版本一致）。候选组由 `LITSAN_DERIVED_RAW_EVIDENCE_ORDER` 和 `LITSAN_DERIVED_RAW_EVIDENCE_MAX` 设定：
  - `D8` / `D12`：引用优先。被选中事实引用的轮次按事实得分顺序（对每条事实的引用轮转）先占位，剩余位置保留当前语义顺序。上限 8 / 12。
  - `E8` / `E12`：融合。语义排名与引用排名做倒数排名融合（k = 60），未被引用的轮次只有语义项。上限 8 / 12。

## Procedure / 流程
- EN: (1) Tune on `dev` (50) only: run C2 and the four candidates, pick one by complete raw evidence, then raw recall, then smaller bytes. Holdout scores are not looked at during selection. (2) Run C2 and the chosen arm once on `holdout` (57; used as P1's gate, never for tuning) and once on `fresh` = the LoCoMo part of `data/graph-holdout.json` (85 questions, sha256 of the exported file `b392b3b3…`, disjoint from `questions.json` and `fresh-set.json`, never run on this production-path harness). (3) No parameter changes after step 2.
- 中文：(1) 只在 `dev`（50 题）上调参：运行 C2 与四个候选组，按原文完整证据、再按原文召回、再按更小字节数选出一个。选择期间不看 holdout 分数。(2) 对 C2 与选中组在 `holdout`（57 题；曾作 P1 门槛，从未用于调参）和 `fresh`（`data/graph-holdout.json` 的 LoCoMo 部分，85 题，导出文件 sha256 `b392b3b3…`，与 `questions.json`、`fresh-set.json` 不相交，从未在本生产路径评测上运行）上各运行一次。(3) 第 2 步之后不再改动任何参数。

## Pass criteria (chosen arm vs C2) / 通过标准（选中组对 C2）
- EN: (1) `fresh`: complete raw evidence gained > lost with exact McNemar p ≤ 0.05, and raw recall +0.03 or more.
- 中文：(1) `fresh`：原文完整证据增多于减，精确 McNemar p ≤ 0.05，且原文召回提高 ≥ 0.03。
- EN: (2) `holdout`: complete raw-or-cited evidence ≥ C2 − 1, and complete raw evidence not lower with p ≤ 0.05.
- 中文：(2) `holdout`：原文或引用完整证据 ≥ C2 − 1，且原文完整证据没有出现 p ≤ 0.05 的下降。
- EN: (3) Mean response ≤ 12 KB on both sets; p95 latency ≤ C2 + 50 ms.
- 中文：(3) 两个数据集平均响应 ≤ 12 KB；p95 延迟 ≤ C2 + 50 ms。
- EN: (4) `npm run context:check` passes with the change built in, default off.
- 中文：(4) 包含改动（默认关闭）时 `npm run context:check` 通过。
- EN: Failing any criterion means no rollout. Passing all means a candidate for a later, separately approved release. Evidence recall is not answer accuracy (REPORT §9).
- 中文：任一标准未通过即不上线；全部通过只意味着成为候选，之后的发布需另行批准。证据召回不等于回答准确率（REPORT §9）。
