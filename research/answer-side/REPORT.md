# Answer-side tests: sufficiency gate and no-hedged-counts rule / 回答侧测试：充分性门控与"禁止含糊计数"规则 (2026-11-07)

- EN: Scope: evaluation only, no production change. Criteria frozen and committed before any code or model call (`CRITERIA.md`, sha256 `388001d6…`, commit `071de7b2`); sets frozen next (`sets.json`, sha256 `145cc305…`, commit `cba28ade`); one pre-run addendum about the curve ranking (`ADDENDUM-1.md`, commit `10199333`). Each set was run once. Model `gpt-5.6-luna` low; judge `memory-judge-v4` (fingerprint asserted against the 2026-11-06 calibration). Numbers: `results-main.json` (from `analyze.py main`); raw answers, gate verdicts and grades: `run-main-results.json`.
- 中文：范围：仅评测，不改生产。标准在编写任何代码、发起任何模型调用之前冻结并提交（`CRITERIA.md`，sha256 `388001d6…`，提交 `071de7b2`）；随后冻结题集（`sets.json`，sha256 `145cc305…`，提交 `cba28ade`）；运行前写入一份关于曲线排序的附录（`ADDENDUM-1.md`，提交 `10199333`）。每个题集只运行一次。模型 `gpt-5.6-luna` low；判分器 `memory-judge-v4`（运行时断言其指纹与 2026-11-06 校准一致）。数字见 `results-main.json`（由 `analyze.py main` 生成）；原始答案、门控结论与判分见 `run-main-results.json`。

## Verdicts / 结论

| Idea / 想法 | Verdict / 判定 | One line / 一句话 |
|---|---|---|
| 1. Sufficiency gate / 充分性门控 | **VALIDATED** as a selective-answer signal / 作为选择性回答信号**验证通过** | EN: 90.2% accuracy when answering at 78% coverage vs 79.0% with no gate (Fisher p = 6e-17), on both datasets and on top of the answerer's own refusals. Not net-positive under equal cost (40 vs 25, p = 0.08). 中文：覆盖率 78% 时作答准确率 90.2%，无门控为 79.0%（Fisher p = 6e-17）；两个数据集均成立，且在回答者自身拒答之外仍有增益。等代价下不是净收益（40 对 25，p = 0.08）。 |
| 2. No hedged counts / 禁止含糊计数 | **PROMISING** / **有希望** | EN: Exact match 104 vs 96 of 131 (11 vs 3, McNemar p = 0.057); hedged answers 10 → 0; no harm elsewhere. Misses the frozen p < 0.05 bar. 中文：精确匹配 131 题中 104 对 96（11 对 3，McNemar p = 0.057）；含糊答案 10 → 0；其他题无伤害。未达到冻结的 p < 0.05 门槛。 |
| 3. Answerer's own confidence instead of the gate (experiment 2, 2026-11-08) / 用回答者自报置信度替代门控（实验 2） | **GATE NEEDED**; gate **REPLICATED** / **需要门控**；门控**已复现** | EN: At the gate's coverage (79%), ranking by the answerer's own confidence gives 84.2% vs the gate's 91.3% (Δ −7.2 points, CI −11.8 to −2.4). The gate replicates on 220 new questions: 91.3% vs 77.3% with no gate, p = 8e-19, and now net-positive at equal cost (35 vs 12, p = 0.001). Post hoc only: withholding the answerer's own refusals and then ranking by confidence ties the gate (+1.1, CI −2.8 to +4.6) with no extra call. 中文：在门控的覆盖率（79%）下，按回答者自报置信度排序得到 84.2%，门控为 91.3%（Δ −7.2 个百分点，置信区间 −11.8 至 −2.4）。门控在 220 道新题上复现：91.3% 对无门控 77.3%，p = 8e-19，且这次在等代价下为净收益（35 对 12，p = 0.001）。仅为事后分析：先扣下回答者自己的拒答、再按置信度排序，可与门控打平（+1.1，置信区间 −2.8 至 +4.6），且不需要额外调用。 |

## Sets / 题集

- EN: G (300) = all 150 LongMemEval questions of the frozen-split holdout (no earlier run had used them; checked by id search over all runtime results) + 150 LoCoMo category 3/4 questions sampled from `signal-set.json` `confirm` (used once for the P4 retrieval check, never answered). C1 = the 42 G questions that start with "how many" (all LongMemEval). C2 = the 95 LongMemEval count questions of `fresh-set.json` `frozen` (answered in §11 of the attribution report, never used to write or tune the rule). The 8-question smoke slice came from unused LongMemEval dev questions and changed nothing.
- 中文：G（300 题）= frozen-split holdout 中全部 150 道 LongMemEval 题（此前没有任何运行使用过；已对所有运行结果按 id 检索确认）+ 从 `signal-set.json` `confirm` 抽取的 150 道 LoCoMo 类别 3/4 题（仅在 P4 检索检查中使用过一次，从未作答）。C1 = G 中以 "how many" 开头的 42 题（均为 LongMemEval）。C2 = `fresh-set.json` `frozen` 中 95 道 LongMemEval 计数题（曾在归因报告 §11 中作答，从未用于编写或调优该规则）。8 题冒烟切片取自未使用的 LongMemEval dev 题，未据此修改任何内容。
- EN: Contexts were built once (LongMemEval text-only hybrid, LoCoMo text+records, 16 KB cap); complete gold evidence in 346 of 392 contexts with annotated evidence. Run health: 0 missing answers or gate verdicts, 1 retried call, 2 judge assessment errors (left as uncertain), uncertain grades A 15 / R 13 (counted as not correct).
- 中文：上下文只构建一次（LongMemEval 纯文本混合检索，LoCoMo 文本+记录，上限 16 KB）；在有证据标注的 392 个上下文中，346 个含完整金标证据。运行状况：答案与门控结论缺失 0，重试调用 1 次，判分评估错误 2 个（保留为 uncertain），uncertain 判分 A 15 / R 13（计为非正确）。

## 1. Sufficiency gate / 充分性门控

- EN: Setup: arm A answers every G question with the plain contract. A separate gate call sees only the question and the same context and returns `sufficient` and `confidence`; the answerer never sees it. The system answers when `sufficient` is true and abstains otherwise.
- 中文：设置：A 组用普通契约回答 G 中每题。门控为独立调用，只看到题目与同一上下文，返回 `sufficient` 与 `confidence`；回答者看不到门控结果。`sufficient` 为真则作答，否则弃答。

| Slice / 切片 | n | Coverage / 覆盖率 | Acc. no gate / 无门控准确率 | Acc. when answering / 作答准确率 | Acc. when gate says insufficient / 门控判不充分时准确率 | Δ [95% CI] | Fisher p (one-sided / 单侧) |
|---|---|---|---|---|---|---|---|
| All / 全部 | 300 | 78.3% | 79.0% [74.0, 83.5] | 90.2% [85.7, 93.7] | 38.5% | +11.2 [+7.7, +15.0] | 5.9e-17 |
| LongMemEval | 150 | 67.3% | 70.0% | 87.1% | 34.7% | +17.1 [+11.3, +23.7] | 1.3e-10 |
| LoCoMo | 150 | 89.3% | 88.0% | 92.5% | 50.0% | +4.5 [+1.5, +8.2] | 6.3e-05 |
| H1b: A did not refuse / A 未拒答 | 263 | 87.8% | 86.3% | 90.9% | 53.1% | +4.6 [+2.2, +7.3] | 7.3e-07 |

- EN: Frozen conditions, all met: H1 p < 0.05; Δ CI excludes 0; Δ > 0 on both datasets; coverage 78% (inside 50–95%); H1b p < 0.05. Verdict VALIDATED.
- 中文：冻结条件全部满足：H1 p < 0.05；Δ 置信区间不含 0；两个数据集 Δ 均 > 0；覆盖率 78%（在 50–95% 内）；H1b p < 0.05。判定为 VALIDATED。
- EN: Risk–coverage (ranking per Addendum 1): accuracy when answering is 96.0% at 50% coverage, 94.4% at 60%, 92.9% at 70%, 90.4% at 80%, 84.4% at 90%, 79.0% at 100%. AURC 0.069 vs 0.210 for random abstention (gain 0.141 [0.106, 0.175]). Per dataset: LongMemEval gain 0.149 [0.083, 0.209], LoCoMo 0.098 [0.058, 0.138]. The alternative reading of `confidence` changes AURC only from 0.069 to 0.073.
- 中文：风险–覆盖（按附录 1 排序）：覆盖率 50% 时作答准确率 96.0%，60% 时 94.4%，70% 时 92.9%，80% 时 90.4%，90% 时 84.4%，100% 时 79.0%。AURC 为 0.069，随机弃答为 0.210（增益 0.141 [0.106, 0.175]）。按数据集：LongMemEval 增益 0.149 [0.083, 0.209]，LoCoMo 0.098 [0.058, 0.138]。对 `confidence` 采用另一种解读，AURC 仅从 0.069 变为 0.073。
- EN: Equal-cost McNemar (secondary, not in the verdict): the gate withheld 40 not-correct and 25 correct answers (p = 0.08); LongMemEval 32 vs 17 (p = 0.044), LoCoMo 8 vs 8 (p = 1.0). So abstaining pays only when a wrong answer costs more than about 0.63 of what a right one gains (25/40). It is a reliable flag, not a free accuracy gain.
- 中文：等代价 McNemar（次要，不计入判定）：门控扣下 40 个非正确答案与 25 个正确答案（p = 0.08）；LongMemEval 32 对 17（p = 0.044），LoCoMo 8 对 8（p = 1.0）。因此只有当错答代价超过答对收益的约 0.63 倍（25/40）时，弃答才划算。它是可靠的标记信号，而不是免费的准确率提升。
- EN: Against the answerer's own refusals (descriptive): A refused on 37 questions (coverage 87.7%, accuracy when answering 86.3%). At that same coverage the gate ranking alone also gives 86.3%, so the gate does not beat self-refusal at the answerer's own operating point. Its value is going further and adding to it: refusals first, then the gate, gives 90.9% at 77% coverage, and H1b shows the gate still separates right from wrong among answers that did not refuse.
- 中文：与回答者自身拒答比较（描述性）：A 在 37 题上拒答（覆盖率 87.7%，作答准确率 86.3%）。在同一覆盖率下，仅用门控排序同样为 86.3%，即在回答者自身的工作点上门控并不优于自我拒答。它的价值在于能走得更远并与之叠加：先按拒答、再按门控，覆盖率 77% 时准确率 90.9%；H1b 也表明，在未拒答的答案中门控仍能区分对错。
- EN: What the gate tracks: 44 of its 63 "insufficient" verdicts were on contexts that contained the complete gold evidence, and 15 "sufficient" verdicts were on incomplete ones. It predicts answer correctness (hard reading, aggregation, missing latest value) better than it predicts evidence completeness, matching §9. On the 7 LongMemEval abstention questions it said insufficient 5 times; those count as withheld correct answers, which slightly penalizes the gate.
- 中文：门控跟踪的是什么：63 个"不充分"结论中有 44 个出现在含完整金标证据的上下文上，另有 15 个"充分"结论出现在证据不完整的上下文上。它预测答案正确性（难读、需聚合、缺最新值）的能力强于预测证据完整性，与 §9 一致。在 7 道 LongMemEval 拒答题上，它 5 次判为不充分；这些计为扣下的正确答案，对门控略有不利。
- EN: Without uncertain grades (288 questions): 92.6% vs 82.3%, Fisher p = 4e-16; the conclusion does not depend on how uncertain is counted.
- 中文：剔除 uncertain 判分后（288 题）：92.6% 对 82.3%，Fisher p = 4e-16；结论不依赖于 uncertain 的计法。

## 2. No hedged counts / 禁止含糊计数

- EN: Setup: arm R = the same contract plus one appended line (exact count, no "at least N", range or "several"; insufficient-evidence rule unchanged). Same contexts and batches. A2 = the plain contract sampled again, as a noise floor.
- 中文：设置：R 组 = 同一契约末尾追加一行（给出精确计数，不用 "at least N"、区间或 "several"；证据不足规则不变）。上下文与批次相同。A2 = 再次采样的普通契约，作为噪声下限。

| Comparison / 比较 | n | A | R (or A2) | W→C | C→W | McNemar p | Diff [95% CI] / 差值 |
|---|---|---|---|---|---|---|---|
| Primary: exact, C / 主要：精确匹配，C | 131 | 96 | 104 | 11 | 3 | 0.057 | +6.1 [+0.8, +11.5] |
| C1 (untouched) / C1（未触及） | 40 | 30 | 34 | 4 | 0 | 0.125 | +10.0 [+2.5, +20.0] |
| C2 (secondary) / C2（次要） | 91 | 66 | 70 | 7 | 3 | 0.34 | +4.4 [−2.2, +11.0] |
| Noise floor: A2 vs A / 噪声下限：A2 对 A | 131 | 96 | 96 | 6 | 6 | 1.0 | 0.0 [−5.3, +5.3] |
| Judge on C / C 上判分 | 137 | 105 | 111 | 8 | 2 | 0.11 | +4.4 [0.0, +8.8] |
| Harm: judge, non-count G / 伤害：G 非计数题判分 | 258 | 205 | 207 | 11 | 9 | 0.82 | +0.8 [−2.7, +4.3] |

- EN: Frozen conditions: R > A yes; p < 0.05 no (0.057); R ≥ A on C1 and C2 yes; no harm yes; hedge rate falls yes (10/137 in A, 10/137 in A2, 0/137 in R). Verdict PROMISING. (The bootstrap CI excludes 0 but the frozen rule uses McNemar p.)
- 中文：冻结条件：R > A 满足；p < 0.05 不满足（0.057）；C1 与 C2 上 R ≥ A 满足；无伤害满足；含糊率下降满足（A 10/137，A2 10/137，R 0/137）。判定为 PROMISING。（bootstrap 置信区间不含 0，但冻结规则以 McNemar p 为准。）
- EN: Mechanism (post hoc reading of the 14 discordant pairs, not a test): of the 10 hedged A answers, 5 became exact-correct in R, 2 were already correct, 3 stayed wrong, and none got worse. The other 6 gains and 3 losses look like ordinary sampling noise (A vs A2 is 6 vs 6) plus grader format effects: R's answers are terser, and the exact grader misreads wordier A answers ("on 15 March 2023, which was 10 days ago" read as 15; "2 weeks" vs a gold of 14 days). Two R gains came from committing to a number where A said "Insufficient evidence"; both were right here, but that is the overcommitment risk to watch.
- 中文：机制（对 14 个不一致对的事后解读，非检验）：A 的 10 个含糊答案中，5 个在 R 中变为精确正确，2 个本已正确，3 个仍错误，没有一个变差。其余 6 个改善与 3 个退化看起来是普通采样噪声（A 对 A2 为 6 对 6）加上评分格式效应：R 的答案更简短，而精确匹配评分器会误读较冗长的 A 答案（"on 15 March 2023, which was 10 days ago" 被读成 15；"2 weeks" 对金标 14 days）。R 有两个改善来自 A 回答 "Insufficient evidence" 而 R 给出了具体数字；这里两者都答对了，但这正是需要警惕的过度承诺风险。
- EN: Interpretation: the rule does what it says (hedges disappear, about 5 of 137 count answers fixed, no measurable harm on 258 other questions or on refusals), and the judge agrees in direction (8 vs 2). The effect is small because hedging is rare (7%), so n ≈ 130 cannot reach p < 0.05; about 300 count questions would be needed at this effect size.
- 中文：解读：该规则按其设计起作用（含糊表述消失，137 个计数答案中约 5 个被纠正，在其余 258 题与拒答题上无可测伤害），判分器结果方向一致（8 对 2）。效应小是因为含糊表述本身少见（7%），因此 n ≈ 130 无法达到 p < 0.05；在此效应量下约需 300 道计数题。

## 3. Experiment 2: the answerer's own confidence instead of the gate / 实验 2：用回答者自报置信度替代门控 (2026-11-08)

- EN: Question: experiment 1's gate looked like a difficulty signal, which the answerer might already have. If the answerer's own confidence, returned in the same call, ranks answers as well, the extra gate call can go. Criteria frozen before any code (`CRITERIA-2.md`, sha256 `0905ae56…`, commit `14cf9973`); set frozen next (`sets2.json`, commit `65246710`); contexts, run and analysis scripts committed before the main run (`35d9ed83`). One main run; numbers in `results2-main.json`, raw data in `run2-main-results.json`.
- 中文：问题：实验 1 的门控看起来是"难度"信号，而回答者可能本来就掌握这一信号。如果回答者在同一次调用中自报的置信度能同样好地给答案排序，就可以去掉额外的门控调用。标准在任何代码之前冻结（`CRITERIA-2.md`，sha256 `0905ae56…`，提交 `14cf9973`）；随后冻结题集（`sets2.json`，提交 `65246710`）；上下文、运行与分析脚本在主实验前提交（`35d9ed83`）。主实验只运行一次；数字见 `results2-main.json`，原始数据见 `run2-main-results.json`。
- EN: Set G3 (220, never answered by any run): 70 LongMemEval dev questions drawn from the 93 no run had used at any level (all LongMemEval ids in the typed-graph data excluded), and 150 LoCoMo `confirm` questions that experiment 1 did not use (retrieval-level runs only). Limitation: this clean LongMemEval pool holds no multi-session or temporal-reasoning questions (single-session-assistant 28, single-session-user 19, knowledge-update 12, preference 11), and LoCoMo is categories 4 (132) and 3 (18). Complete gold evidence in 197 of 216 contexts. Run health: 0 missing answers, verdicts or confidences; 12 retried calls; 2 judge errors; uncertain grades A 5 / SC 7. 292 Codex calls, 8.3 M input tokens.
- 中文：题集 G3（220 题，从未被任何运行作答）：70 道 LongMemEval dev 题，抽自从未在任何层级被使用过的 93 题（已排除 typed-graph 数据中出现的所有 LongMemEval id）；150 道实验 1 未使用的 LoCoMo `confirm` 题（只在检索层级使用过）。局限：这个干净的 LongMemEval 题池中没有多会话或时间推理题（single-session-assistant 28、single-session-user 19、knowledge-update 12、preference 11），LoCoMo 为类别 4（132）与类别 3（18）。216 个上下文中 197 个含完整金标证据。运行状况：答案、门控结论与置信度缺失均为 0；重试调用 12 次；判分错误 2 个；uncertain 判分 A 5 / SC 7。共 292 次 Codex 调用，输入 830 万 token。

| Measure / 指标 | Result / 结果 |
|---|---|
| Primary: S (own confidence, top 173) vs G (gate passes 173) / 主指标：S（自报置信度前 173）对 G（门控放行 173） | 84.2% vs 91.3%, Δ −7.2 [−11.8, −2.4] → **GATE NEEDED / 需要门控** |
| LongMemEval / LoCoMo Δ | −11.0 [−23.7, −1.8] / −3.5 [−8.2, +1.5] |
| Cost of the confidence field: SC vs A unselected / 置信度字段的代价：SC 对 A（不选择） | 172 vs 170 (5 vs 3, p = 0.73): no cost / 无代价 |
| Calibration of own confidence / 自报置信度校准 | mean 98.0% vs accuracy 78.2%, ECE 0.20; 208 of 220 values in 93–100 / 平均 98.0%，准确率 78.2%，ECE 0.20；220 个值中 208 个落在 93–100 |
| AURC gate-on-A vs confidence-on-SC / AURC | 0.061 vs 0.099 (random 0.227 / 0.218); difference +0.038 [−0.004, +0.079] |
| Accuracy at 50 / 70 / 90% coverage / 覆盖率 50 / 70 / 90% 时准确率 | gate 97.4 / 94.4 / 83.7; own confidence 90.4 / 87.6 / 82.4 |
| Gate replication (experiment 1's H1) / 门控复现 | 91.3% at 78.6% coverage vs 77.3% unselected, Δ +14.1 [+9.7, +18.7], Fisher p = 8e-19 → **REPLICATED / 已复现** |
| Gate per dataset / 门控分数据集 | LongMemEval +24.5 [+14.6, +34.9] at 61% coverage; LoCoMo +9.4 [+5.2, +14.2] at 87% |
| Gate at equal cost / 门控等代价 | withheld 35 wrong vs 12 right, p = 0.001 (experiment 1: 40 vs 25, p = 0.08) |

- EN: Why own confidence fails: it does not separate a refusal from an answer. "Insufficient evidence" replies get confidence as high as real answers (the model is sure the evidence is missing), but 26 of its 30 refusals were graded wrong, because the reference does answer them. Ranking by confidence therefore keeps the refusals inside the answered set.
- 中文：自报置信度失败的原因：它不区分拒答与作答。"Insufficient evidence" 的回复得到与真实答案同样高的置信度（模型确信证据缺失），但其 30 个拒答中有 26 个被判为错误，因为参考答案确实回答了这些问题。所以按置信度排序会把拒答留在作答集合中。
- EN: Post hoc (`explore2.py`, written after seeing the results, changes no verdict): treat the answerer's own refusal as abstention, then rank the rest by its confidence. At the gate's coverage this gives 92.4% vs the gate's 91.3% (+1.1 [−2.8, +4.6]); refusals alone (coverage 86%) give 88.4% vs the gate ranking's 86.4% at that coverage (+2.0 [−1.3, +5.5]); gate and no refusal together give 92.9% at 77% coverage (+1.6 [−1.3, +4.7] vs the gate). So with no extra call, "refusal = abstain" plus own confidence matched the gate here, and the gate's remaining edge is control over coverage below about 80% (97% at 50%). The gate flagged 26 of the 30 refusals and 21 other answers.
- 中文：事后分析（`explore2.py`，在看到结果后编写，不改变任何结论）：把回答者自己的拒答视为弃答，再按其置信度对其余答案排序。在门控的覆盖率下得到 92.4%，门控为 91.3%（+1.1 [−2.8, +4.6]）；仅用拒答（覆盖率 86%）得到 88.4%，同一覆盖率下门控排序为 86.4%（+2.0 [−1.3, +5.5]）；门控与"未拒答"同时满足得到 92.9%（覆盖率 77%，相对门控 +1.6 [−1.3, +4.7]）。因此在不增加调用的情况下，"拒答 = 弃答"加自报置信度在本实验中与门控打平；门控剩下的优势是能把覆盖率控制在约 80% 以下（覆盖率 50% 时 97%）。门控标出了 30 个拒答中的 26 个，以及另外 21 个答案。
- EN: Next test, if wanted: freeze "refusal = abstain, then own confidence" vs the gate as a non-inferiority test (margin 3 points) on new questions. Only 23 clean LongMemEval dev and 168 LoCoMo `confirm` questions remain, so it would use the last clean pool; that is the owner's call.
- 中文：若需要，下一项测试：把"拒答 = 弃答，再按自报置信度排序"对门控冻结为非劣效检验（界值 3 个百分点），在新题上运行。干净题池只剩 23 道 LongMemEval dev 与 168 道 LoCoMo `confirm` 题，该测试会用掉最后的干净题池，需由负责人决定。

## Recommendations / 建议

1. EN: Gate: worth building as a flag on the answer (for example "low confidence: context may be incomplete") or an optional abstain mode for callers that prefer silence to a wrong answer. It must run in the Harness or answering agent, not inside LITSAN (LITSAN owns no model calls). Do not use it as a retrieval trigger (§9 showed follow-up rounds add almost no evidence). Experiment 2: the answerer's own confidence cannot replace it, but treating the answerer's own refusals as abstentions comes close at about 80% coverage with no extra call (post hoc); keep the gate where callers want lower coverage and higher accuracy. 中文：门控：值得做成答案上的标记（例如"低置信：上下文可能不完整"），或为宁可不答也不愿答错的调用方提供可选弃答模式。它必须运行在 Harness 或回答 agent 中，而不是 LITSAN 内部（LITSAN 不拥有模型调用）。不要把它用作检索触发器（§9 表明追加检索轮次几乎不增加证据）。实验 2：回答者自报置信度不能替代门控，但把回答者自己的拒答视为弃答，在约 80% 覆盖率下不增加调用即可接近门控（事后分析）；当调用方需要更低覆盖率、更高准确率时保留门控。
2. EN: Rule: safe to adopt in answer-contract guidance (no harm found, removes a known failure), with the claim worded as "removes hedged counts", not as a significant accuracy gain. A confirmation would need a new frozen set of about 300 count questions that no run has used. Where it applies: LITSAN ships no answer contract to agents (checked: `src/` has none); the contract exists only in the eval scripts (`scripts/memory-answer-contract.txt` + `scripts/progressive-answer-guidance.txt`, read by `scripts/evaluate-progressive-followup.py`). That guidance currently says "If only a lower bound is supported, state it", which invites hedged counts. Adopting the rule means replacing that sentence in future eval runs (a change to a shared eval asset, so it needs an owner decision and a new baseline), and offering the line to agent-side answer prompts as optional guidance. 中文：规则：可以安全地写入回答契约指引（未发现伤害，且消除了一个已知失败模式），但措辞应为"消除含糊计数"，而不是"显著提升准确率"。若要确认，需要一个约 300 道、此前从未使用过的计数题新冻结集。适用范围：LITSAN 不向 agent 下发任何回答契约（已核查：`src/` 中没有）；契约只存在于评测脚本中（`scripts/memory-answer-contract.txt` + `scripts/progressive-answer-guidance.txt`，由 `scripts/evaluate-progressive-followup.py` 读取）。该指引目前写有"若只支持下限，就说明下限"，这会诱发含糊计数。采用该规则意味着在今后的评测中替换这句话（属于共享评测资产的改动，需要负责人决定并重建基线），并把这一行作为可选指引提供给 agent 端的回答提示词。
3. EN: Pools now consumed: LongMemEval holdout (150) and 150 of the 468 LoCoMo `confirm` questions are answer-level used; 318 `confirm` questions and 173 LongMemEval dev questions remain unanswered. After experiment 2: 168 `confirm` and 23 clean LongMemEval dev questions remain (70 dev + 150 `confirm` used). 中文：已消耗的题池：LongMemEval holdout（150 题）与 LoCoMo `confirm` 468 题中的 150 题已在回答级使用；`confirm` 剩余 318 题与 LongMemEval dev 173 题尚未作答。实验 2 之后：剩余 `confirm` 168 题与干净的 LongMemEval dev 23 题（已用 dev 70 题、`confirm` 150 题）。

## Files / 文件

- EN: `CRITERIA.md` / `ADDENDUM-1.md` (frozen, with hashes); `freeze_sets.py` → `sets.json`; `contexts.py` (fixed contexts, written to `.review-runtime/answer-side-20261107/contexts.json`); `run.py smoke|main` (model calls, exact-prompt cache under `.review-runtime/answer-side-20261107/run-*`, git-ignored); `analyze.py` → `results-main.json`; `run-main-results.json` (answers, gate verdicts, grades). 525 Codex calls, 14.9 M input tokens. Experiment 2: `CRITERIA-2.md`, `freeze_sets2.py` → `sets2.json`, `contexts2.py`, `run2.py`, `analyze2.py` → `results2-main.json`, `explore2.py` (post hoc) → `explore2-main.json`, `run2-main-results.json`.
- 中文：`CRITERIA.md` / `ADDENDUM-1.md`（已冻结，附哈希）；`freeze_sets.py` → `sets.json`；`contexts.py`（固定上下文，写入 `.review-runtime/answer-side-20261107/contexts.json`）；`run.py smoke|main`（模型调用，精确提示缓存位于 `.review-runtime/answer-side-20261107/run-*`，被 git 忽略）；`analyze.py` → `results-main.json`；`run-main-results.json`（答案、门控结论、判分）。525 次 Codex 调用，输入 1,490 万 token。实验 2：`CRITERIA-2.md`、`freeze_sets2.py` → `sets2.json`、`contexts2.py`、`run2.py`、`analyze2.py` → `results2-main.json`、`explore2.py`（事后分析）→ `explore2-main.json`、`run2-main-results.json`。
