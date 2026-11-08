# Raw-turn retrieval experiments: findings / 原始轮次检索实验：结论

Rounds P0–P7 (2026-11-07 to 2026-11-08) plus the answer-side study in `research/answer-side/`. Numbers per round: `RESULTS.md`; frozen criteria: `*-CRITERIA.md` with `.sha256`. This is the public summary; the detailed internal review notes are not published.
P0–P7 轮次（2026-11-07 至 2026-11-08）以及 `research/answer-side/` 中的回答层研究。各轮数字见 `RESULTS.md`；冻结标准见 `*-CRITERIA.md` 及其 `.sha256`。本文是公开摘要；详细的内部评审记录不公开。

## 1. What was measured / 测量对象

- EN: Whether the gold evidence turns of a LoCoMo question reach the agent through the real `litsan_context` path: an isolated stack, real `litsan_turn` captures, L2 revisions written through Core, facts used as retrieval keys and the raw turns behind them returned as values. No model is called in the retrieval loop; every arm is a set of environment flags on the same ingested state.
- 中文：LoCoMo 题目的金标证据轮次能否经真实 `litsan_context` 路径到达 Agent：隔离栈、真实 `litsan_turn` 捕获、经 Core 写入的 L2 修订，以事实作为检索键、以其背后的原始轮次作为返回值。检索循环中不调用模型；每个实验组都是同一份已导入状态上的一组环境开关。
- EN: Primary metric: "complete raw", the number of questions for which the text of every gold turn is delivered. Secondary: "raw or cited" (text delivered or the turn reference appears), response bytes, p95 latency.
- 中文：主指标"原文完整"：所有金标轮次的文本都被交付的题数。次要指标："原文或引用"（文本被交付或轮次引用出现）、响应字节数、p95 延迟。

## 2. Method / 方法

- EN: Criteria, arms and selection rules were written and hashed (`.sha256`) before any arm ran. Parameters were chosen on a tuning pool (649 questions) and confirmed once on questions no earlier round had used; every reuse of a confirm set is disclosed in the criteria and in `sets/LEDGER.json`.
- 中文：标准、实验组与选择规则在任何组运行之前写定并计算哈希（`.sha256`）。参数在调参池（649 题）上选定，并在此前各轮均未使用的题上只确认一次；确认集的每次复用都在标准文件与 `sets/LEDGER.json` 中披露。
- EN: Paired exact McNemar tests with 95% intervals; from P7 also conversation-clustered intervals, a determinism check and a power analysis written down before the final run (it predicted correctly that the smallest pick could not be validated).
- 中文：使用配对精确 McNemar 检验与 95% 区间；自 P7 起另加按对话聚类的区间、确定性检查，以及在最终运行前写下的功效分析（它正确预言了最小的入选组无法被验证）。

## 3. Validated / 已验证

| Change / 改动 | Evidence / 证据 | Status / 状态 |
|---|---|---|
| P1: always return the raw turns behind selected facts (`LITSAN_DERIVED_RAW_EVIDENCE=always`) / P1：始终返回所选事实背后的原始轮次 | Holdout complete evidence 27 → 39 of 57 (12 gained, 0 lost, p = 0.0005) / holdout 完整证据 27 → 39（增 12、减 0） | In production / 已在生产 |
| L2 timeline reserved in the brief capsule (`LITSAN_CONTEXT_RESERVE_L2`, on by default) / brief 胶囊中为 L2 时间线预留预算 | Fixes a defect where fresh undistilled turns used up the budget before the L2 timeline, which silently disabled P1. On a private project-history set: questions with every gold turn delivered 2 → 14 of 60 (+12/−0); median latency cost +16 ms when not triggered / 修复新鲜未蒸馏轮次先耗尽预算、使 L2 时间线被挤出并悄悄关闭 P1 的缺陷。在私有项目历史题集上：全部金标轮次到位 2 → 14/60（增 12、减 0）；未触发时延迟中位数 +16 ms | In production / 已在生产 |
| P4: one compact raw-evidence entry under a byte budget instead of a slot count / P4：用字节预算下的单个紧凑原始证据条目取代位数 | Confirm set: complete raw 280 → 350 (70/0) at the same size as production / 确认集：原文完整 280 → 350（增 70、减 0），体积与生产相同 | Flag, default off / 开关，默认关闭 |
| P5: lean output (`LITSAN_CONTEXT_LEAN=1`) / P5：精简输出 | Confirm set: −30% bytes with no loss (B = 3000), or +9/−0 at −23% bytes (B = 4200) / 确认集：字节 −30% 且无损失（B = 3000），或在 −23% 字节下增 9、减 0（B = 4200） | Flag, default off / 开关，默认关闭 |
| P7 "Mid": first-call setting `ci8-b6000` / P7 "Mid"：首次调用设置 | 183 untouched questions: complete raw 122 → 137 (15/0, p = 6e-5) for +3.2 KB over the P5 pick; "Max" 145 (23/0) at about 15.5 KB / 183 道未使用题：原文完整 122 → 137（增 15、减 0），比 P5 选中组多 3.2 KB；"Max" 为 145（增 23、减 0），约 15.5 KB | Release candidate, not deployed / 发布候选，未部署 |
| Answer side: sufficiency gate / 回答层：充分性门控 | 90.2% accuracy when answering at 78% coverage vs 79.0% without the gate (p = 6e-17); replicated on 220 new questions; the answering model's own confidence does not replace it / 在 78% 覆盖率下回答准确率 90.2%，无门控为 79.0%；在 220 道新题上复现；回答模型自报的置信度不能替代门控 | Evaluation-harness finding; LITSAN ships no answerer / 评测 harness 结论；LITSAN 不内置回答器 |

- EN: The Mid setting is `LITSAN_DERIVED_FACT_RETRIEVAL=semantic`, `LITSAN_DERIVED_RAW_EVIDENCE=always`, `LITSAN_DERIVED_RAW_EVIDENCE_MAX=48`, `LITSAN_DERIVED_RAW_EVIDENCE_ORDER=cited_first`, `LITSAN_DERIVED_RAW_EVIDENCE_SEMANTIC_LEAD=8`, `LITSAN_DERIVED_RAW_EVIDENCE_BYTES=6000`, `LITSAN_CONTEXT_LEAN=1`. A secondary end-to-end answer check on the same 184 questions moved correct answers 128 → 135 (p = 0.14), the same direction but not significant.
- 中文：Mid 设置为上列环境变量。在同样 184 题上的次要端到端回答检查中，正确数 128 → 135（p = 0.14），方向一致但不显著。

## 4. Promising, not confirmed / 有希望但未确认

- EN: No hedged counts (answer exact counts instead of "at least N"): exact match 104 vs 96 of 131 (11 vs 3, p = 0.057), hedged answers 10 → 0, no harm elsewhere; misses the frozen p < 0.05 bar. A cheaper answer policy (treat the model's own "insufficient evidence" replies as abstentions, then rank by its confidence) was found after the fact and is untested.
- 中文：禁止含糊计数（给出确切数而非"至少 N"）：精确匹配 104 对 96（共 131 题，11 对 3，p = 0.057），含糊回答 10 → 0，其他方面无伤害；未达到冻结的 p < 0.05。一个更便宜的回答策略（把模型自己的"证据不足"回答视为弃答，再按其置信度排序）是事后发现的，尚未检验。
- EN: P3 (more raw slots in both lanes) gained 109/0 on tuning at +5.5 KB but was superseded by the byte-budget form of P4 before its confirm run.
- 中文：P3（两条通道都增加证据位）在调参池上增 109、减 0，多 5.5 KB，但在确认前已被 P4 的字节预算形式取代。

## 5. Failed, kept as records / 失败，作为记录保留

- EN: P2, reordering the seven raw slots by citation: −6 raw-or-cited on a fresh set (p = 0.03). The two retrieval lanes (semantic over all turns, and turns cited by selected facts) find different gold turns; reordering only traded one lane for the other.
- 中文：P2，按引用重排 7 个原始证据位：在新题集上原文或引用 −6（p = 0.03）。两条检索通道（全部轮次上的语义检索，以及所选事实引用的轮次）找到的金标轮次不同；重排只是用一条通道换另一条。
- EN: P5 model-free adaptive stopping. Cutting the raw budget when the derived-fact sufficiency heuristic says "sufficient" lost 60–80 questions on tuning: the heuristic checks whether facts cover the query's words, not whether they carry the detail the gold turns hold. A relative score floor at 0.75 lost 19; at 0.60 it was near-neutral (+10/−1 vs the P4 pick) and was not selected under the frozen rules.
- 中文：P5 无模型自适应停止。派生事实充分性启发式判为"充分"时削减原始预算，在调参池上丢失 60–80 题：该启发式检查的是事实是否覆盖查询用词，而不是事实是否带有金标轮次中的细节。相对分数下限取 0.75 时丢失 19 题；取 0.60 时接近持平（相对 P4 选中组增 10、减 1），按冻结规则未被选中。
- EN: P6, follow-up queries with overlap and novelty limits: they found genuinely new turns, but no arm beat simply spending the same extra bytes in the first call.
- 中文：P6，带重叠与新颖性限制的补查：确实找到了新轮次，但没有任何组胜过把同样多的额外字节直接用在首次调用上。
- EN: P7 "Lean" (`ci8-b4200-r0.5`): +5/−0, p = 0.0625, as the power analysis predicted.
- 中文：P7 "Lean"：增 5、减 0，p = 0.0625，与功效分析的预言一致。
- EN: Two related studies on unpublished branches: a typed-relation graph (about 160 variants; none beat using the same extracted data as a plain retrieval key) and concept labels as a second fact key (no gain through the production path, 39 vs 39).
- 中文：两项相关研究在未公开分支上：类型化关系图（约 160 个变体；没有一个胜过把同样的抽取结果当作普通检索键）与把概念标签作为第二个事实键（经生产路径无增益，39 对 39）。

## 6. Why the successes worked / 成功的原因

- EN: Most of a raw-evidence entry was not evidence: about 204 bytes of turn text sat in a 575-byte entry (a repeated instruction sentence, ids, scores, matched terms). One compact entry and a byte budget turned the same size into more turns.
- 中文：原始证据条目的大部分并不是证据：约 204 字节的轮次文本装在 575 字节的条目里（重复的说明句、id、分数、匹配词）。单个紧凑条目加字节预算，让同样的体积装下更多轮次。
- EN: Keep both lanes: the first semantic turns, then the cited turns. Ordering inside the delivered set matters less than which turns are selected, because the context is re-sorted by score.
- 中文：两条通道都保留：先放前若干个语义轮次，再放被引用的轮次。交付集合内部的顺序不如选中哪些轮次重要，因为上下文会按分数重新排序。
- EN: Without a model, the first call is the best place to spend extra bytes; a follow-up only helps if it brings turns the first call could not reach.
- 中文：在不调用模型的情况下，额外字节最好花在首次调用上；补查只有在带来首次调用够不到的轮次时才有用。
- EN: Check that the item a feature depends on survives the context budget. The L2 defect was invisible in the metrics until the delivered capsule was inspected.
- 中文：要检查功能所依赖的条目能否在上下文预算中保留下来。L2 缺陷在检查实际交付的胶囊之前，在指标上是看不出来的。

## 7. Data and reproduction / 数据与复现

- EN: Questions and gold answers in `sets/` and `research/answer-side/sets*.json` are taken from the LoCoMo benchmark (Maharana et al., 2024) and, for the answer side, LongMemEval (Wu et al., 2024); they are subject to those datasets' licences.
- 中文：`sets/` 与 `research/answer-side/sets*.json` 中的题目与金标答案取自 LoCoMo 基准（Maharana 等，2024），回答层部分另取自 LongMemEval（Wu 等，2024）；须遵守相应数据集的许可。
- EN: Scripts read the benchmark data from `LITSAN_BENCH_DATA` (default `<repo>/.review-runtime`, git-ignored): `benchmarks/data/locomo10.json` and `attribution-20261106/multihop/questions.json`. Run `node benchmarks/retrieval/locomo-derived/run.mjs ingest`, then `query` with `P0_ARMS` and `P0_QUESTIONS`, then the `paired*.py` and `sweep/analyze.py` scripts.
- 中文：脚本从 `LITSAN_BENCH_DATA`（默认 `<repo>/.review-runtime`，已被 git 忽略）读取基准数据：`benchmarks/data/locomo10.json` 与 `attribution-20261106/multihop/questions.json`。先运行 `run.mjs ingest`，再带 `P0_ARMS` 与 `P0_QUESTIONS` 运行 `query`，然后运行 `paired*.py` 与 `sweep/analyze.py`。
