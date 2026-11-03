# LITSAN Retrieval / TKP Evaluation Standard

This document defines the canonical evaluation vocabulary for LITSAN retrieval, Conditional Knowledge Admission, Turn Knowledge Plan (TKP), and final context packing experiments. These terms must be used consistently in implementation notes, experiment reports, review discussions, dashboards, and future optimization work.

本文件定义 LITSAN 在 Retrieval、Conditional Knowledge Admission、Turn Knowledge Plan（TKP）以及最终 Context Packing 实验中的长期统一评价术语。实现说明、实验报告、review 讨论、监控面板与后续优化工作应持续使用同一套定义，避免把“准确”“精确”“稳定”“多样”等概念混为一个分数。

## Canonical metrics / 规范指标

### 1. Accuracy / Grounded Task Accuracy

**EN:** Whether the final supplied context is sufficient to support the correct task conclusion: all must-not-miss knowledge is available, authority ordering is respected, and no stale, conflicting, or otherwise harmful evidence contaminates the conclusion. This is a scenario/task-level success metric rather than ordinary retrieval precision.

**中文：准确度 / Grounded Task Accuracy。** 最终提供给模型的上下文是否足以支持正确结论：绝对不能漏的关键知识已经出现、authority hierarchy 没有被破坏，并且 stale、冲突或其他 harmful evidence 没有污染结论。这是任务/场景级成功指标，不等同于普通 Retrieval Precision。

### 2. Factual Correctness

**EN:** Among factual memory objects selected into the usable context, the fraction that are current, valid, and factually correct rather than stale, superseded, conflicting, or known-harmful. When truth status is not labelled or verifiable, the item must not be silently counted as correct.

**中文：事实正确性 / Factual Correctness。** 被选入可用上下文的事实型记忆中，当前有效且事实正确的比例；stale、已 superseded、冲突或已知 harmful 的内容不计为正确。若某项没有可验证 truth status，不得默认为正确。

### 3. Precision / Retrieval Precision / 查准率

**EN:** Among the context objects delivered for the current turn, the fraction that are directly relevant to the query or task. In LITSAN reports, use the explicit name `Retrieval Precision` or `Context Precision` when referring to this information-retrieval meaning, so it is not confused with measurement repeatability.

**中文：查准率 / Retrieval Precision。** 本轮送给模型的上下文对象中，真正与当前问题或任务直接相关的比例。LITSAN 报告中应明确写作 `Retrieval Precision` 或 `Context Precision`，避免与测量学意义上的“精密度/重复性”混淆。

### 4. Recall / Context Recall / 查全率

**EN:** Among all knowledge objects labelled relevant for the current turn, the fraction actually represented in the delivered context. Recall measures breadth of useful evidence coverage, not authority or correctness by itself.

**中文：查全率 / Context Recall。** 本轮所有应当相关的知识对象中，最终真正出现在上下文里的比例。Recall 衡量有用证据覆盖广度，本身不代表 authority 或事实正确性。

### 5. Critical Recall

**EN:** Recall computed only over must-not-miss knowledge, such as applicable L3 Current Truth, critical Fresh L1 evidence, query-relevant authoritative Project Architecture, required timeline evidence, or a required Skill. Critical Recall is a guardrail metric and should normally dominate ordinary Recall in policy selection.

**中文：关键召回率 / Critical Recall。** 只针对“绝对不能漏”的知识计算 Recall，例如适用的 L3 Current Truth、关键 Fresh L1、与本轮相关的 authoritative Project Architecture、必须出现的时间线证据或必要 Skill。Critical Recall 属于安全护栏指标，策略选择时通常应优先于普通 Recall。

### 6. Repeatability / Selection Repeatability / 精密度

**EN:** Stability of the selected knowledge set for the same semantic task under bounded score jitter, candidate-order changes, minor budget changes, or equivalent non-semantic perturbations. This is the measurement-style notion of precision/repeatability. LITSAN should report it as `Selection Repeatability`, not simply `Precision`.

**中文：精密度 / 选择重复性。** 对同一个语义任务，在有界 score jitter、候选顺序变化、轻微 budget 变化等不改变任务语义的扰动下，所选知识集合是否稳定。这对应测量学意义上的 precision/repeatability。LITSAN 应写作 `Selection Repeatability`，不要只写 `Precision`。

### 7. Constructive Diversity

**EN:** Coverage of relevant context that contributes genuinely different, useful perspectives beyond the minimum grounding set. Diversity receives credit only when the lateral item remains relevant and potentially useful to reasoning; random, stale, contradictory, or merely dissimilar noise receives no diversity reward.

**中文：建设性多样性 / Constructive Diversity。** 在最小 grounding 集之外，是否覆盖了仍然相关、但能够提供真正不同且有用视角的上下文。只有“相关且可能促进推理”的旁路信息才获得多样性奖励；随机、stale、冲突或只是表面不同的噪声不得因为“不一样”而得分。

### 8. Exploration Precision

**EN:** Among items intentionally admitted through an exploration margin/sidecar, the fraction that are labelled useful lateral context rather than irrelevant noise. Exploration must be evaluated separately from ordinary Retrieval Precision so that bounded cognitive breadth can be rewarded without hiding grounding pollution.

**中文：探索查准率 / Exploration Precision。** 通过 exploration margin/sidecar 有意加入的对象中，真正属于有价值旁路信息而不是无关噪声的比例。Exploration 应与普通 Retrieval Precision 分开评价，使系统可以奖励受控认知宽度，同时不能用“发散性”掩盖 grounding 污染。

## Required interpretation rules / 必须遵守的解释规则

**EN:** LITSAN must not collapse these metrics into one ambiguous word such as “accuracy” or “precision.” `Context Precision` means information-retrieval precision; `Selection Repeatability` means measurement-style precision/stability. Reports that compare retrieval/TKP policies should state both when relevant.

**中文：** LITSAN 不得再用单一“准确/精确”概念混写这些指标。`Context Precision` 表示信息检索查准率，`Selection Repeatability` 表示测量学意义上的精密度/稳定性；比较 Retrieval/TKP 策略时，相关情况下两者都应报告。

**EN:** Policy optimization is guard-railed rather than a free weighted sum. Factual Correctness, Critical Recall, authority safety, and conflict safety form the grounding floor. Precision, Recall, Role Coverage, Repeatability, context bytes and candidate cost are optimized only after that floor is satisfied. Constructive Diversity and Exploration Precision use only bounded remaining capacity and must never compensate for a failure of the grounding floor.

**中文：** 策略优化采用 guard-railed 多目标约束，而不是可以任意互相补偿的加权总分。Factual Correctness、Critical Recall、authority safety 与 conflict safety 构成 grounding floor；只有该底线满足后，才优化 Precision、Recall、Role Coverage、Repeatability、context bytes 与候选成本。Constructive Diversity 和 Exploration Precision 只使用受限剩余容量，不能用高“发散性”补偿 grounding floor 失败。

**EN:** Exploration context is not random novelty. The default exploration candidate classes should be bounded to sources suited to alternative reasoning or stable perspective, such as relevant Project Architecture, reusable Skill, or L4 preference/profile context. L2 chronology should not be treated as an exploration source merely because it differs lexically from the main context.

**中文：** Exploration context 不是随机 novelty。默认 exploration 候选应限制在适合提供替代推理路径或稳定视角的来源，例如相关 Project Architecture、可复用 Skill 或 L4 偏好/画像上下文。L2 chronology 不能仅因为词面不同就被当作“发散信息”。

**EN:** Every reported metric must state its evaluation unit and ground truth source. Object-level recall does not prove passage-level fact retention; passage/window experiments must additionally measure fact-marker or equivalent passage-level recall. Synthetic labels, oracle filters and ground-truth-only signals may be used for evaluation but must never be presented as deployable runtime inputs.

**中文：** 每个指标都必须说明评价单位与 ground-truth 来源。对象级 Recall 不等于 passage 内关键事实被保留；涉及 passage/window 的实验必须额外测量 fact-marker 或等价的 passage-level recall。Synthetic 标签、oracle filter 与仅评测时可见的 ground truth 可以用于评价，但不得伪装成生产运行时可获得的输入信号。

## Minimum reporting set / 最低报告集合

For a serious Retrieval / Conditional Admission / TKP comparison, report at least:

正式比较 Retrieval / Conditional Admission / TKP 策略时，至少报告：

- Grounded Task Accuracy / 任务准确度
- Factual Correctness / 事实正确性
- Context Precision / 查准率
- Context Recall / 查全率
- Critical Recall and worst-case Critical Recall / 关键召回率及最差场景
- Selection Repeatability / 选择重复性（精密度）
- Constructive Diversity / 建设性多样性
- Exploration Precision when exploration is enabled / 启用探索槽时的探索查准率
- Actual admitted item count and P50/P90/P95 / 实际 Admission 数量及分位数
- TKP plan bytes and final context bytes / TKP 与最终上下文字节成本
- Role Coverage, harmful/stale rate, and passage-level fact recall when applicable / 适用时报告角色覆盖、harmful/stale 比例与 passage 级事实召回

