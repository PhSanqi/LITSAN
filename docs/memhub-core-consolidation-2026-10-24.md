# Memhub Core 检索收敛说明与内部 A/B 方案

日期：2026-10-24  
状态：候选实现，**未切换 production 默认**。

## 1. 为什么要收敛

当前 Memhub 的检索链长期存在两层相关性排序：

```text
Memory Core
  vector / FTS / pattern
  RRF / threshold / MMR / tier candidate budgets
        ↓
Memhub Retrieval v1
  semantic score + BM25
  phrase boost
  Jaccard diversity penalty
  second Top-K
        ↓
TKP
```

这造成三个问题：

1. Core 与 Memhub 都在判断“什么相关”，职责重复。
2. Top-K、diversity、lexical relevance 在两层分别存在，调参空间被人为放大。
3. 当中文或 temporal/provenance 召回失败时，上层 rerank 容易变成补丁层，而不是修复真正的候选召回问题。

目标不是删除所有上层控制，而是把**相关性检索收敛为一套**。

## 2. 目标边界

```text
Query
  ↓
Memhub scope / account / project / branch
  ↓
memhub_core
  storage / index
  vector / FTS / pattern
  channel fusion / threshold
  candidate budgets
  dedupe / MMR
  one relevance ordering
  retrieval trace
  ↓
TKP
  Query Demand
  Typed Admission
  authority / role
  passage selection
  evidence coverage
  context budget
  exploration margin
  ↓
Harness
  semantic interpretation
  answer sufficiency
  reasoning / synthesis
```

核心原则：

> `memhub_core` 判断“哪些记忆与 query 相关”。

> TKP 判断“这些相关记忆本轮应该以什么身份、多少容量、哪些 passage 进入上下文”。

因此 **Typed Admission 不删除**。此前实验已经证明只保留 raw Core order + TKP、完全删除 Admission 会明显退化。Admission 应作为 TKP 内部的知识容量与类型分配阶段存在，而不是另一套 Retrieval Top-K。

## 3. 删除哪些重复工作

`memhub_core` 候选路径不再执行 Memhub Retrieval v1 的第二遍：

- BM25 second-stage rerank
- `0.68 * semantic + 0.32 * lexical` fusion
- exact phrase boost
- Jaccard diversity penalty
- second relevance Top-K

候选路径只对 Memory Core 的最终 hits 做：

- bounded ID/content dedupe
- structured diagnostics
- cutoff / decision trace
- 原样保留 Core 最终顺序

特别是不能把 Core 的 MMR 输出重新按 `hit.score` 排序，否则只是把“第二层 rerank”换了一个名字。

## 4. 中文能力放在哪里

中文不是 Memhub 上层补丁，而是 `memhub_core` 的一等 retrieval primitive。

本轮真实 Core 压力测试最初暴露了中文 provenance、temporal、source-reason 等漏召回。逐项消融后，最终不需要维护中文同义词词典、trigram 规则或额外中文 MMR。

最终保留的最小修复只有一项：

```text
pattern fallback candidates
  old: any fragment match → updated_at DESC
  new: query fragment match_count DESC → updated_at DESC
```

也就是让 pattern fallback 先按“命中了多少 query fragment”排序，再使用时间作为 tie-break。

这一改动把原先二次 lexical rerank 真正有价值的部分下沉到了候选层，而不是继续维护两套相关性排序。

## 5. Top-K 如何重新理解

收敛后只保留两类容量参数：

### Core retrieval depth

属于 `memhub_core`：

- tier candidate depth
- keyword/vector candidate pool
- threshold
- MMR / diversity
- per-channel recall depth

这些参数决定“候选搜多深”。

### TKP knowledge capacity

属于 TKP：

- required / supporting 容量
- per-kind `min / target / max`
- Fresh L1 / L2 / L3 / L4 / Skill / Architecture admission
- passage 数量与字节预算
- exploration margin

这些参数决定“本轮知识怎么用”。

不再在两者之间维护独立的固定 Admission Top-K operator。

## 6. 当前实现状态

候选模式：`memhub_core`  
生产默认：`memhub_v1`

当前候选包含：

- `src/memhub-core.ts`：统一 Core 输出适配器，只保留 Core order + dedupe + diagnostics。
- `MemoryRestContextSource(..., rankingMode)`：支持 `memhub_v1` / `memhub_core` A/B。
- Memory Core pattern fallback：按 query fragment `match_count` 排序。
- 中文与 mixed-language benchmark。
- vendor manifest 更新和 vendor regression。

当前没有部署，也没有切 production 默认。

## 7. 内部 A/B 协议

内部对比必须使用**同一最终代码版本**。不同版本 Core 的结果不能直接拿来证明 second-stage rerank 是否有价值。

每个 suite 分别运行：

```text
A = final Memory Core + memhub_v1 second-stage rerank
B = final Memory Core + memhub_core single-ranking path
```

对比两层输出：

1. Retrieval selected evidence
2. TKP required + supporting final knowledge set

最低指标：

- Grounded Task Accuracy
- Context Precision
- Context Recall
- Critical Recall
- Current Truth Precision
- Superseded Leakage
- duplicate ratio
- raw context bytes
- TKP context bytes
- old/new selection Jaccard
- exact-order match rate
- latency，仅作观察，不作为本轮架构结论

内部 suites：

- P0 representative real EmbeddedMemoryCore suite
- Chinese / mixed-language suite
- local stress suite（存在时加入，当前位于 `.review-runtime`，属于实验 fixture，不是长期 authoritative benchmark）

## 8. 切换候选门槛

本轮内部 gate 采用 grounding-first：

1. Grounded Task Accuracy 不得下降。
2. Critical Recall 不得下降。
3. Current Truth Precision 不得下降。
4. Superseded Leakage 不得增加。
5. Retrieval/TKP Precision 允许最大 `0.01` 的观测误差，但不能出现明显退化。
6. 任一 case 的 TKP required evidence 不得比旧链多漏。

通过内部 gate 只表示“值得进入下一阶段”，**不等于可以直接生产切换**。后续仍需要公开/外部 benchmark 与真实 `memmy_context` smoke。

## 9. 可重复运行

```bash
npm run benchmark:memhub-core:internal
```

机器可读结果默认写入：

```text
.review-runtime/benchmarks/memhub-core-internal-ab.json
```

正式讨论时必须同时引用 Retrieval 和 TKP 两层结果，不能只用 raw recall 的漂亮数字替代最终上下文质量。
