# Answer-side experiment 2: can the answerer's own confidence replace the separate gate? / 回答侧实验 2：回答者自报置信度能否替代独立门控？

Frozen 2026-11-08 before any code, set or model call of this experiment. sha256 in `CRITERIA-2.sha256`.
2026-11-08 冻结，早于本实验的任何代码、题集与模型调用。sha256 见 `CRITERIA-2.sha256`。

## 0. Question / 问题

- EN: Experiment 1 (CRITERIA.md) validated a separate sufficiency-gate call as a selective-answer gate, but its mechanism looked like "how hard is this question", which the answerer may already know. If the answerer's own confidence, returned in the same call, ranks answers as well as the gate, the extra call is not needed. This experiment also checks whether the gate result replicates on questions it has never seen.
- 中文：实验 1（CRITERIA.md）验证了独立的充分性门控调用可作为选择性回答门控，但其机制更像"这道题有多难"，而回答者自己可能已经知道这一点。如果回答者在同一次调用中自报的置信度对答案的排序与门控一样好，就不需要额外调用。本实验同时检查门控结果在从未见过的题目上能否复现。

## 1. Sets / 题集

- EN: G3 = 70 LongMemEval dev questions sampled (seed 20261110) from the 93 that no run has used at any level (excluding `used-ids.txt`, `fresh-set.json` tune/frozen, experiment 1's sets, and every LongMemEval id appearing in the typed-graph worktree data) + 150 LoCoMo `confirm` questions of `signal-set.json` sampled (seed 20261111) from the 318 that experiment 1 did not use (they were used only for retrieval-level runs, never answered). Frozen as `sets2.json` with sha256 before any context is built. Smoke uses experiment 1's smoke set S (smoke-only, never scored).
- 中文：G3 = 70 道 LongMemEval dev 题（种子 20261110），抽自从未在任何层级被使用过的 93 题（排除 `used-ids.txt`、`fresh-set.json` 的 tune/frozen、实验 1 的题集，以及 typed-graph worktree 数据中出现的所有 LongMemEval id）+ 150 道 `signal-set.json` 的 LoCoMo `confirm` 题（种子 20261111），抽自实验 1 未使用的 318 题（它们只用于检索层级运行，从未被作答）。在构建任何上下文之前冻结为 `sets2.json` 并记录 sha256。冒烟测试使用实验 1 的冒烟集 S（只用于冒烟，从不计分）。

## 2. Contexts and arms / 上下文与实验组

- EN: Contexts are built exactly as in experiment 1 (`contexts.py` functions: LoCoMo text+records RRF, LongMemEval text-only hybrid, 16 KB cap). Model, effort, cache, batching (4 per batch, seeded shuffle 20261107) and judge (`memory-judge-v4`, calibrated fingerprint asserted) are unchanged.
  - A: the plain contract of experiment 1 (memory-answer-contract.txt + progressive-answer-guidance.txt).
  - gate: the gate prompt of CRITERIA.md, verbatim, on the same contexts; the answerer never sees it.
  - SC: the plain contract plus the confidence line below, appended verbatim; same batches.
- 中文：上下文的构建方式与实验 1 完全相同（`contexts.py` 中的函数：LoCoMo text+records RRF、LongMemEval 纯文本混合检索、16 KB 上限）。模型、推理强度、缓存、分批（每批 4 题，种子 20261107 洗牌）与判分器（`memory-judge-v4`，断言已校准的指纹）均不变。
  - A：实验 1 的普通契约（memory-answer-contract.txt + progressive-answer-guidance.txt）。
  - gate：CRITERIA.md 中的门控提示词原文，作用于相同上下文；回答者看不到它。
  - SC：普通契约末尾原样追加下面的置信度行；批次相同。

```text
Confidence field (overrides the output format above): in each returned object also include "confidence", an integer from 0 to 100 giving your estimated probability that your answer is correct and complete for the question asked, so each object is {"id":string,"answer":string,"confidence":integer}. The user never sees this field.
```

- EN: The judge grades pairs (A, SC). An SC object with a missing or non-numeric confidence gets confidence 50.
- 中文：判分器对 (A, SC) 成对判分。SC 对象若缺少置信度或置信度非数字，记为 50。

## 3. Policies and metrics / 策略与指标

- EN: Policy G answers A's answer when the gate says sufficient (missing verdict = answer); its coverage is k_G answers out of n. Policy S answers SC's answers with the k_G highest confidences; ties at the cut get fractional credit (expected accuracy if the tied group were drawn at random). Correct = judge correct (uncertain = not correct), as in experiment 1.
  - Primary: Δ = selective accuracy of S at coverage k_G − selective accuracy of G. 95% paired bootstrap CI (10,000 resamples of questions, seed 20261108; k_G recomputed in each resample).
  - Secondary (each reported, none changes the primary verdict):
    1. Gate replication on G3: experiment 1's H1 (one-sided Fisher on A, gate answered vs withheld) and Δ_gate CI, all and per dataset.
    2. AURC of the gate ranking on A (ADDENDUM-1 score) vs AURC of the confidence ranking on SC, with the paired bootstrap CI of the difference.
    3. Cost of the field: SC vs A unselected judge accuracy (exact two-sided McNemar).
    4. Calibration of SC confidence: 10-bin expected calibration error and mean confidence vs accuracy.
    5. Descriptive: S and G per dataset; S excluding self-refusals; the combination "gate sufficient and confidence ranked" at k_G.
- 中文：策略 G 在门控判定充分时给出 A 的答案（缺少判定 = 作答）；其覆盖率为 n 题中作答 k_G 题。策略 S 给出置信度最高的 k_G 个 SC 答案；切点处的并列按比例计分（并列组随机抽取时的期望准确率）。正确 = 判分器判为正确（不确定 = 不正确），与实验 1 相同。
  - 主指标：Δ = S 在覆盖 k_G 时的选择性准确率 − G 的选择性准确率。95% 配对 bootstrap 置信区间（按题重抽样 10,000 次，种子 20261108；每次重抽样重新计算 k_G）。
  - 次要指标（均报告，均不改变主结论）：
    1. 门控在 G3 上的复现：实验 1 的 H1（A 上的单侧 Fisher 检验，门控作答 vs 不作答）与 Δ_gate 置信区间，整体及分数据集。
    2. 门控排序在 A 上的 AURC（ADDENDUM-1 的分数）与置信度排序在 SC 上的 AURC，及两者差值的配对 bootstrap 置信区间。
    3. 该字段的代价：SC 与 A 不做选择时的判分准确率（精确双侧 McNemar）。
    4. SC 置信度的校准：10 分箱的期望校准误差（ECE），以及平均置信度与准确率的对比。
    5. 描述性：S 与 G 分数据集；排除自我拒答后的 S；"门控充分且按置信度排序"在 k_G 处的组合。

## 4. Verdict / 结论规则

- EN:
  - INLINE ADEQUATE (the gate call can be dropped): Δ CI lower bound > −0.03, and SC is not worse than A unselected (SC ≥ A, or McNemar p ≥ 0.05).
  - INLINE BETTER (stronger form of adequate): adequate and Δ CI lower bound > 0.
  - GATE NEEDED: Δ CI upper bound < 0.
  - INCONCLUSIVE: anything else.
  - Gate REPLICATED: H1 p < 0.05 and Δ_gate CI excludes 0 on G3; otherwise NOT REPLICATED (reported with its numbers).
- 中文：
  - 自报置信度足够（可去掉门控调用）：Δ 置信区间下界 > −0.03，且 SC 在不做选择时不劣于 A（SC ≥ A，或 McNemar p ≥ 0.05）。
  - 自报置信度更好（足够的更强形式）：满足足够，且 Δ 置信区间下界 > 0。
  - 需要门控：Δ 置信区间上界 < 0。
  - 无定论：其余情况。
  - 门控已复现：G3 上 H1 p < 0.05 且 Δ_gate 置信区间不含 0；否则为未复现（附数字报告）。

## 5. Procedure / 流程

- EN: commit this file and its hash → freeze `sets2.json` and commit → build contexts → smoke on S (checks parsing and that SC returns confidences; not scored) → one main run on G3 → analysis by the script committed before the main run → bilingual report section. Any deviation goes in a dated addendum committed before the main run; after the main run nothing is re-run or re-tuned on G3.
- 中文：提交本文件及其哈希 → 冻结 `sets2.json` 并提交 → 构建上下文 → 在 S 上冒烟（检查解析，以及 SC 是否返回置信度；不计分）→ 在 G3 上只运行一次主实验 → 用主实验前提交的脚本分析 → 双语报告章节。任何偏离写入主实验前提交的带日期附录；主实验之后不在 G3 上重跑或重调。
