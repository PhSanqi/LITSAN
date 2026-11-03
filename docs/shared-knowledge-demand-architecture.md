# Shared Knowledge Demand Architecture / 共享知识需求架构

Status: **frozen candidate architecture for semantic-task validation**. This document freezes the current experimental design so subsequent work evaluates it on real tasks and public benchmarks instead of continuing to add retrieval policies. It does **not** mean the production Core has been switched to this design.

状态：**进入真实语义任务验证阶段的冻结候选架构**。从这里开始，后续工作优先验证实际回答质量与公开 benchmark，不继续无边界增加检索 policy。这里的“冻结”不表示 production Core 已切换到该实现。

Current semantic/public-benchmark evidence is recorded separately in `docs/semantic-benchmark-validation-2026-10-23.md`; benchmark findings may refine implementation details inside this pipeline without silently changing the frozen architecture.

当前真实语义任务与公开 benchmark 证据单独记录在 `docs/semantic-benchmark-validation-2026-10-23.md`。Benchmark 可以修正这条主链内部的实现细节，但不得在没有明确证据时悄悄改变冻结架构。

## Pipeline / 主链路

```text
Query
  ↓
Shared Knowledge Demand
  ↓
Conditional Knowledge Admission
  ↓
Aligned TKP
  ↓
Role-aware Context Packing
  ↓
Harness / Generator
```

## Shared Knowledge Demand / 共享知识需求

EN: One turn-local demand contract is shared by Admission and TKP. It expresses typed knowledge demand with `min / target / max`, uncertainty, and turn signals such as `current_state`, `temporal_history`, architecture, provenance, workflow, preference and open-ended exploration. A single global K is an output of the typed allocation, not the primary control variable.

中文：Admission 与 TKP 共享同一个 turn-local Knowledge Demand contract。它用 `min / target / max`、uncertainty，以及 `current_state`、`temporal_history`、architecture、provenance、workflow、preference、open-ended exploration 等本轮信号表达分类型知识需求。全局 K 只是各类型资源分配后的结果，不再是主要控制变量。

## Conditional Knowledge Admission / 条件知识准入

EN: Admission decides **which knowledge objects are allowed to reach TKP**. It preserves authority floors, uses per-kind targets plus uncertainty slack, distinguishes current-state evidence from historical timeline evidence, and may reserve bounded typed exploration capacity. It does not decide final passages or final byte packing.

中文：Admission 决定**哪些知识对象获得进入 TKP 的资格**。它保护 authority floor，按知识类型使用 target + uncertainty slack，区分当前状态证据与历史时间线证据，并可为受控的 typed exploration 预留少量容量。它不负责最终 passage 和最终字节预算。

## Aligned TKP / 对齐的 TKP

EN: TKP decides **how admitted objects are used**: required/supporting role, passage selection and provenance handling. In shared mode it must not repeat the same hard relevance gate already performed by Admission. Query-anchor matched-window extraction is used where the required fact may live inside a long object.

中文：TKP 决定**已准入对象如何使用**：required/supporting 角色、passage 选择和 provenance 处理。Shared mode 下不得再次重复 Admission 已经执行过的同类硬 relevance gate。关键事实可能位于长对象内部时，使用 query-anchor matched-window 提取。

## Context packing and exploration / 上下文打包与探索

EN: Context packing protects required roles under the byte/token budget. Constructive exploration is not a separate sidecar service: it is a bounded typed resource inside the same Shared Demand and is considered only after grounding requirements are satisfied. Current experiments restrict exploration candidates to knowledge classes that can plausibly provide useful alternative perspectives, such as Architecture, Skill and L4.

中文：Context packing 在 byte/token budget 下优先保护 required 角色。建设性探索不是额外 sidecar service，而是同一个 Shared Demand 中的受限 typed resource，只有 grounding 需求满足后才允许占用资源。当前实验将探索候选限制在更可能提供有用不同视角的 Architecture、Skill、L4 等知识类型。

## Evaluation contract / 评价约束

EN: All evaluation and optimization must follow `docs/retrieval-tkp-evaluation-standard.md`. Grounding safety is a hard floor; retrieval quality and repeatability come next; constructive diversity cannot compensate for factual or critical-recall failure.

中文：所有评价与优化必须遵守 `docs/retrieval-tkp-evaluation-standard.md`。Grounding safety 是硬约束，其次才优化检索质量与重复性；建设性多样性不得补偿事实错误或 Critical Recall 失败。

## Freeze rule / 冻结规则

EN: Until semantic-task and public-benchmark evidence shows a concrete failure mode, do not add a new Admission/TKP policy family. Fixes should target demonstrated failure modes and preserve this minimal pipeline unless evidence requires an architectural change.

中文：在真实语义任务或公开 benchmark 证明具体失败模式之前，不新增 Admission/TKP policy family。后续修正只针对已证实的问题，优先保持这条最小主链，除非直接证据要求架构变化。
