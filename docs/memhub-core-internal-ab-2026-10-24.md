# Memhub Core 内部 A/B 报告

日期：2026-10-24  
对比：`memhub_v1` vs `memhub_core`  
生产默认：仍为 `memhub_v1`，本报告没有触发部署或切换。

## 1. 对比目的

本轮不是继续寻找新的 ranking policy，而是回答一个更基础的问题：

> 在 Memory Core 已经完成 candidate generation、channel ranking、threshold 与 MMR 之后，Memhub 是否还需要第二套 BM25 / fusion / diversity rerank？

为避免历史实验中“不同 Core 版本互相比”的混淆，本轮 A/B 强制使用**同一最终 Memory Core 代码**：

```text
A / old
final Memory Core
→ Memhub Retrieval v1 second-stage rerank
→ TKP

B / candidate
final Memory Core
→ memhub_core preserve-Core-order adapter
→ TKP
```

两边的 scope、fixtures、query、limit、TKP policy 均相同。

## 2. 测试集

### P0 real pipeline

- 6 cases
- 真实 `EmbeddedMemoryCore` add/index/search
- Current Truth replacement
- historical fact
- global-only
- explicit cross-project Skill
- project isolation
- account isolation

### Chinese / mixed-language

- 10 cases
- 中文 current state
- provenance / source
- temporal latest
- mixed Chinese + English identifiers
- Skill
- project isolation
- distractor pressure

### Internal stress

- 12 cases
- provenance / temporal / current-state / workflow / mixed-language
- dense lexical distractors
- 中文 case

Stress suite 当前来自 `.review-runtime/benchmarks/core-order-stress-suite.json`，属于内部实验 snapshot，不视为长期 authoritative benchmark。

## 3. Retrieval 层结果

| Suite | Cases | Grounded Accuracy old → new | Critical Recall old → new | Precision old → new | Context bytes old → new | Selection Jaccard | Exact order |
|---|---:|---:|---:|---:|---:|---:|---:|
| P0 | 6 | 1.000 → **1.000** | 1.000 → **1.000** | 1.000 → **1.000** | 214 → 214 | 1.0000 | 1.0000 |
| Chinese | 10 | 1.000 → **1.000** | 1.000 → **1.000** | 0.2857 → **0.2857** | 1209 → 1213 | 0.9667 | 0.4000 |
| Stress | 12 | 1.000 → **1.000** | 1.000 → **1.000** | 0.4054 → **0.4054** | 590 → 592 | 0.9206 | 0.6667 |

三组 suite 的：

- Current Truth Precision 都保持 `1.000`
- Superseded Leakage 都保持 `0`
- Recall 都保持 `1.000`
- Critical Recall 都保持 `1.000`

因此 candidate 并没有因为删除第二次 rerank 而丢失必须证据。

### Raw Retrieval 为什么顺序会不同

Chinese 与 Stress 中 old/new 的 raw selected set 并非完全相同，这是预期现象。

`memhub_v1` 会在 Core 输出之后重新执行 BM25/fusion/diversity，因此它本来就会改变 Core order。`memhub_core` 则保留 Core 最终排序。

实际发生变化的 case：

- Chinese：`zh-distractor-current-state`
- Stress：`stress-mixed-a`
- Stress：`stress-mixed-b`
- Stress：`stress-workflow-a`

Chinese 的一个具体变化是：

```text
old selected: zh:temporal-old@current
new selected: zh:temporal-latest@current
```

新链没有降低任何 required / critical 指标。

## 4. TKP 最终知识集结果

比 raw retrieval 更重要的是：经过 TKP 后真正交给 Harness 的 required/supporting evidence 是否变化。

| Suite | TKP Accuracy old → new | TKP Critical Recall old → new | TKP Precision old → new | TKP bytes old → new | Selection Jaccard | Exact order |
|---|---:|---:|---:|---:|---:|---:|
| P0 | 1.000 → **1.000** | 1.000 → **1.000** | 1.000 → **1.000** | 186 → 186 | **1.0000** | **1.0000** |
| Chinese | 1.000 → **1.000** | 1.000 → **1.000** | 0.3333 → **0.3333** | 960 → 960 | **1.0000** | **1.0000** |
| Stress | 1.000 → **1.000** | 1.000 → **1.000** | 1.000 → **1.000** | 175 → 175 | **1.0000** | **1.0000** |

这是本轮最关键的结果：

> raw Retrieval 层允许存在小范围候选顺序差异，但三组 suite 经过 TKP 后，old/new 的最终知识选择完全一致。

三组 TKP 均达到：

```text
average selection Jaccard = 1.0
exact order rate          = 1.0
```

并且没有任何 case 出现 candidate 比 old 多漏 required evidence。

Chinese TKP Precision 的 `0.3333` 是两条链共同存在的 TKP selection 特征，本轮没有恶化，因此不能归因于 `memhub_core`。如果后续要优化，它应作为 TKP / Typed Admission 的独立问题处理，而不是恢复第二套 retrieval rerank。

## 5. 中文修复的贡献

本轮最终 Memory Core 只保留一项中文/lexical candidate 修复：

```text
pattern fallback
  any fragment match
  → match_count DESC
  → updated_at DESC
```

即候选先按命中的 query fragment 数量排序，再按更新时间 tie-break。

此前实验过但最终删除的内容包括：

- 手写中文 provenance / temporal 同义词扩展
- trigram / 长中文 lexical 特权
- 额外中文 MMR tokenizer 修改
- query pattern term 均匀采样修改

删除这些规则后，P0 / Chinese / Stress 的最终结果仍保持通过，因此当前实现没有依赖 case-specific 中文词典。

## 6. Latency

单次本轮观测：

| Suite | Retrieval latency old → new |
|---|---:|
| P0 | 30.97 ms → 28.15 ms |
| Chinese | 36.30 ms → 33.89 ms |
| Stress | 24.22 ms → 21.57 ms |

TKP 自身约为亚毫秒级：

- P0：0.30 ms → 0.30 ms
- Chinese：0.36 ms → 0.35 ms
- Stress：0.28 ms → 0.24 ms

**不把 latency 改善作为本轮结论。** 之前重复实测已经证明本地 Embedded Core 的毫秒级结果存在明显噪声。本轮架构判断只依赖质量非劣与重复计算删除。

## 7. Internal gate

本轮 gate：**PASS**。

规则：

- Grounded Task Accuracy 不下降
- Critical Recall 不下降
- Current Truth Precision 不下降
- Superseded Leakage 不增加
- Precision 不出现大于 `0.01` 的退化
- 任一 case 的 TKP required evidence 不得比 old 多漏

结果：

```text
P0      PASS
Chinese PASS
Stress  PASS
Overall PASS
```

机器可读结果：

```text
.review-runtime/benchmarks/memhub-core-internal-ab.json
```

可重复命令：

```bash
npm run benchmark:memhub-core:internal
```

## 8. 当前结论

这轮内部证据支持下面的判断：

1. **Memory Core + Memhub Retrieval v1 的双相关性排序可以收敛。**
2. 修复底层 pattern candidate ranking 后，旧 second-stage rerank 在当前三组 real-Core 内部 suite 上没有提供额外 Grounded Accuracy、Critical Recall、Precision 或 Current Truth safety 收益。
3. raw candidate 顺序虽然有变化，但 TKP 最终知识集完全一致，说明 TKP 能吸收无害的候选排序差异。
4. Typed Admission / TKP 仍然需要保留。这里删除的是重复 relevance rerank，不是知识类型与 authority 编排。
5. 中文应该继续在 `memhub_core` 内解决，不应恢复上层中文补丁 reranker。

## 9. 还不能据此直接上线

Internal gate 通过意味着 `memhub_core` 已经达到下一阶段候选门槛，但生产切换前仍建议：

1. 用最终候选跑 Memora / LongMemEval-S / LoCoMo 等外部 benchmark。
2. 补真实 `memmy_context` production-like smoke，包括中文、Current Truth、Fresh L1、Skill 与 cross-project isolation。
3. 保留 rollback / ranking-mode 开关，完成一次真实运行态 A/B 后再删除 `memhub_v1` 代码。

因此当前决策仍是：

```text
candidate validated internally = yes
production default switched    = no
legacy reranker deleted        = no
```
