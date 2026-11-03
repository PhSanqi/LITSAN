# Semantic Benchmark Validation 2026-10-23 / 真实语义 Benchmark 验证 2026-10-23

## Scope / 范围

EN: This report validates the frozen `Shared Knowledge Demand → Conditional Knowledge Admission → Aligned TKP → Role-aware Context Packing` direction on public long-memory data. It is an offline development evaluation only. Production Memhub Core and the active immutable runtime were not switched to these experiments.

中文：本报告使用公开长期记忆数据验证已冻结的 `Shared Knowledge Demand → Conditional Knowledge Admission → Aligned TKP → Role-aware Context Packing` 方向。所有测试均为开发环境离线实验，未把 production Memhub Core 或当前 immutable runtime 切换到实验实现。

## Machine / 机器

- 16 vCPU
- 22 GiB RAM, about 13 GiB available at inspection time
- no NVIDIA GPU
- local CPU embedding: `Xenova/all-MiniLM-L6-v2`, q8

EN: The machine is sufficient for full LoCoMo retrieval, Memora/FAMA weekly retrieval/state tests, and stratified LongMemEval-S retrieval. Large generator sweeps should use an API rather than a local LLM.

中文：当前机器足以运行 LoCoMo 全量 retrieval、Memora/FAMA weekly 全量检索/状态测试和 LongMemEval-S 分层 retrieval。大规模生成式评测应使用 API，而不是在本机运行大型 LLM。

## LoCoMo retrieval / LoCoMo 检索

Full 1,986-question run:

| Mode | Any@1 | Any@3 | Any@5 | Any@10 | All@5 | All@10 | MRR |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Lexical | 0.616 | 0.814 | 0.870 | 0.943 | 0.773 | 0.857 | 0.723 |
| Local hybrid | 0.643 | 0.825 | 0.885 | 0.954 | 0.791 | 0.873 | 0.743 |

EN: Local semantic fusion improves the ordinary retrieval baseline, but the gain is incremental rather than architectural.

中文：本地 semantic fusion 能稳定改善普通检索基线，但提升属于增量优化，并非架构级变化。

## LongMemEval-S retrieval / LongMemEval-S 检索

The full 500-question lexical run reached `Any@5=0.946`, `All@5=0.762`, `MRR=0.868`. On the same stratified 120-question subset, lexical reached `Any@1=0.792`, `Any@5=0.917`, `All@5=0.758`, `MRR=0.842`, while local hybrid reached `Any@1=0.842`, `Any@5=0.975`, `All@5=0.850`, `MRR=0.890`. The 60-question matched smoke also improved under hybrid retrieval.

中文：LongMemEval-S 500 题 lexical 全量达到 `Any@5=0.946`、`All@5=0.762`、`MRR=0.868`。在完全相同的 120 题分层样本上，lexical 为 `Any@1=0.792`、`Any@5=0.917`、`All@5=0.758`、`MRR=0.842`，local-hybrid 提升到 `Any@1=0.842`、`Any@5=0.975`、`All@5=0.850`、`MRR=0.890`；60 题同分层 smoke 中 hybrid 也表现出稳定改善。

EN: This benchmark is practical on the server, but full local-hybrid evaluation is substantially more CPU-expensive than lexical retrieval. Stratified retrieval runs plus generator subsets are the preferred development loop.

中文：该 benchmark 可以在服务器运行，但全量 local-hybrid 的 CPU 成本明显高于 lexical。开发阶段更适合使用分层 retrieval + 少量 generator subset。

## Memora/FAMA: timeline retrieval is not enough / Memora/FAMA：仅检索历史时间线不够

The weekly set contains 10 personas, about 1,500 conversation sessions and 150 main evaluation questions. Selection never reads the benchmark gold `memory_evidence`, `forgetting_evidence` or task labels; those fields are used only after retrieval for scoring.

Weekly 数据包含 10 个 persona、约 1,500 个 conversation session 和 150 个主评测问题。选择阶段不读取 benchmark 的 gold `memory_evidence`、`forgetting_evidence` 或 task label；这些字段仅用于检索完成后的评分。

Raw timeline retrieval at session level:

| Mode | Current Any@5 | Current All@5 | Forgotten pollution@5 |
| --- | ---: | ---: | ---: |
| Raw lexical timeline | 0.773 | 0.287 | 0.387 |
| Raw hybrid timeline | 0.813 | 0.300 | 0.433 |

EN: Semantic retrieval improves current-memory recall but can retrieve stale history even more aggressively. Better embedding/ranking alone does not solve memory validity.

中文：Semantic retrieval 提高了当前记忆的召回，却可能更积极地召回已经失效的历史。单纯提升 embedding/ranking 不能解决记忆有效性问题。

## Materialized Current Truth / 物化 Current Truth

An offline adapter replays only runtime-visible Memora operations (`add`, `update`, `delete`, completion semantics and content state) into a canonical current-state view before retrieval. It does not use gold evaluation labels.

离线适配器仅依据运行时可见的 Memora 操作语义（`add`、`update`、`delete`、完成状态与 content state）先物化 canonical Current Truth，再执行检索，不使用 gold 评测标签。

Fact-level evaluation is required because one storage session may contain both an active fact and a forgotten fact. Session id is therefore not a valid fact-level evaluation unit.

必须使用 fact-level 评价，因为同一个 storage session 可能同时包含一个仍有效事实和一个已失效事实。Session id 不能直接充当事实级评价单元。

| System | Fact Recall@5 | Fact Recall@10 | Forgotten Fact Pollution@5 | Pollution@10 |
| --- | ---: | ---: | ---: | ---: |
| Raw lexical timeline | 0.472 | 0.532 | 0.480 | 0.507 |
| Raw hybrid timeline | 0.483 | 0.575 | 0.500 | 0.533 |
| Current Truth + lexical | 0.506 | 0.615 | 0.007 | 0.013 |
| Current Truth + hybrid | 0.626 | 0.725 | 0.027 | 0.027 |
| **Current Truth + hybrid + typed Admission** | **0.890** | **0.987** | **0.027** | **0.027** |

Typed Admission is derived from observable query wording and state metadata, not the benchmark task label. Examples include meeting-note, project-proposal, email, todo, calendar, expense, steps, preference and goal demand.

Typed Admission 只使用 query 文本和 state metadata 识别需求类型，不使用 benchmark task label。例如 meeting-note、project-proposal、email、todo、calendar、expense、steps、preference、goal 等需求。

Per task for the strongest tested system:

| Task | Fact Recall@5 | Fact Recall@10 | Forgotten Pollution@5 |
| --- | ---: | ---: | ---: |
| Reasoning | 0.821 | 0.985 | 0.000 |
| Recommending | 0.858 | 0.977 | 0.080 |
| Remembering | 0.990 | 1.000 | 0.000 |

## Important ablations discovered by semantic tasks / 真实任务发现的关键消融

EN:

1. Replacing lexical retrieval with embeddings improves recall but does not enforce current truth; stale pollution can increase.
2. Filtering invalidated raw sessions is weaker than materializing canonical current state first.
3. `completed` is type-dependent. Completed todos should leave the active todo state, while completed meeting notes/proposals/emails are finalized durable content and must remain current truth.
4. Blindly hydrating the raw provenance session after a Current Truth hit is harmful: it barely improves recall while reintroducing forgotten facts. Evidence-on-demand must be query-specific and bounded.
5. Query-conditioned typed Admission materially improves current-state retrieval without increasing stale-fact pollution.
6. Storage object, retrieval unit, knowledge unit and evaluation fact must remain separate. A single source session can contain both current and obsolete facts.

中文：

1. 从 lexical 换成 embedding 能改善召回，但不会自动维护 Current Truth；stale pollution 甚至可能上升。
2. 在原始历史 session 上过滤失效项，明显弱于先物化 canonical Current Truth 再检索。
3. `completed` 必须按知识类型解释。完成的 todo 应离开 active todo；完成的会议纪要、proposal、email 则是已经定稿的长期内容，应保留在 Current Truth。
4. Current Truth 命中后盲目 hydrate 整个 raw provenance session 会重新带回失效事实，收益很小。Evidence-on-demand 必须 query-specific 且受限。
5. Query-conditioned typed Admission 在不增加 stale-fact pollution 的情况下显著改善 current-state retrieval。
6. Storage object、retrieval unit、knowledge unit、evaluation fact 必须分离。同一 source session 可以同时包含当前事实与失效事实。

## DeepSeek answer-level A/B / DeepSeek 最终回答层 A/B

EN: A benchmark-only API credential is isolated in `~/.config/memhub/mem-benchmark-ds.env` through the `MEM_BENCH_DS_*` namespace and is not consumed by Memhub production Core, DSH or distillation. The answer runner uses `curl` with bounded IPv4 retry because the server's Node/undici path to DeepSeek is unreliable. The stored base URL contained `api.deepseek.comv1`; tests therefore used a process-local correction to `https://api.deepseek.com/v1` without rewriting the private credential file.

中文：Answer benchmark 使用独立的 `~/.config/memhub/mem-benchmark-ds.env` 与 `MEM_BENCH_DS_*` 命名空间，不供 Memhub production Core、DSH 或 distillation 使用。由于服务器 Node/undici 到 DeepSeek 的链路不稳定，runner 使用带有界 IPv4 retry 的 `curl`。私有配置中的 base URL 写成了 `api.deepseek.comv1`，因此本轮仅在进程内临时修正为 `https://api.deepseek.com/v1`，没有改写用户的私有 credential 文件。

`deepseek-flash` was not suitable for this answer benchmark: even a four-case batch exhausted an 8,192-token output budget in reasoning (`finish_reason=length`) before producing final content. The same credential successfully exposed `deepseek-chat`, which was therefore used as the non-reasoning answer model and blinded judge. This model choice is an evaluation-harness decision, not a Memhub architecture change.

`deepseek-flash` 不适合本轮 answer benchmark：即使缩小到 4 个 case，一次请求仍会把 8,192-token 输出预算消耗在 reasoning 中，并在最终答案产生前以 `finish_reason=length` 截断。同一 credential 下的 `deepseek-chat` smoke 正常，因此最终使用 `deepseek-chat` 作为非 reasoning answer model 与 blinded judge。这只是评测 harness 选择，不改变 Memhub 架构。

The internal semantic suite contains 12 memory-sensitive cases. Three independent repeats produced 36 judged answers per lane. Because the judge occasionally emitted `grounded_task_accuracy=1` together with `critical_omission=1`, the canonical Memhub guardrail is reported as **Strict Grounded Success**: accuracy=1 AND factual correctness=1 AND critical omission=0 AND stale usage=0.

内部语义套件包含 12 个对记忆质量敏感的 case，独立重复 3 次，因此每条 lane 有 36 个 judged answers。由于 judge 偶尔会同时给出 `grounded_task_accuracy=1` 与 `critical_omission=1`，最终按 Memhub 已固定的 guardrail 使用 **Strict Grounded Success**：必须同时满足 accuracy=1、factual correctness=1、critical omission=0、stale usage=0。

| Answer-level metric | Current-style fixed context | Shared Demand context | Delta |
| --- | ---: | ---: | ---: |
| Judge Grounded Task Accuracy | 0.611 | **1.000** | **+0.389** |
| **Strict Grounded Success** | 0.472 | **0.917** | **+0.445** |
| Factual Correctness | 0.889 | **1.000** | **+0.111** |
| Critical Omission Rate | 0.528 | **0.083** | **-0.445** |
| Stale Fact Usage Rate | 0.000 | 0.000 | 0.000 |
| Constructive Breadth | 0.417 | **0.500** | **+0.083** |
| Strict outcome repeatability | **0.917** | 0.833 | -0.084 |

EN: The lower strict-outcome repeatability of the Shared lane does not mean the old context is more useful: the fixed lane is often *consistently wrong*. Shared context is near the success boundary only on two cases whose omission judgement varied across repeats. This distinction is why repeatability must be reported alongside correctness, not used as a substitute for it.

中文：Shared lane 的 strict-outcome repeatability 较低，不代表旧 context 更好；fixed lane 的一部分“稳定”来自**稳定地答错/漏答**。Shared context 主要在两个接近判定边界的 case 上出现 omission judge 波动。因此 Repeatability 必须与正确性一起解释，不能替代正确性。

EN: This A/B is strong evidence that the retrieval/context improvements survive into final generation, but it is still an internal semantic suite and uses the same `deepseek-chat` model for generation and judging. It must not be presented as directly comparable to OmniMemEval's GPT-4.1-mini/GPT-4o-mini public leaderboard numbers.

中文：这组 A/B 已能证明 Retrieval/Context 的提升确实传递到了最终生成，但它仍然是内部语义套件，并且 generation 与 judge 都使用 `deepseek-chat`。因此不能把 91.7% 直接和 OmniMemEval 使用 GPT-4.1-mini/GPT-4o-mini 得到的公开 leaderboard 数字混为同口径结果。

## Current conclusion / 当前结论

EN: The strongest public-benchmark evidence so far supports the frozen architecture rather than another Top-K policy family. Current Truth materialization handles validity; Conditional Admission uses turn demand to narrow knowledge types; TKP should operate on admitted knowledge units and only hydrate provenance when the turn requires extra detail. Ranking quality remains important, but it is downstream of memory-state correctness.

中文：目前最强的公开 benchmark 证据支持继续保持冻结架构，而不是再增加新的 Top-K policy family。Current Truth materialization 负责有效性，Conditional Admission 根据本轮需求收窄知识类型，TKP 在已准入知识单元上组织角色与 passage，并且仅在本轮确实需要细节时 hydrate provenance。Ranking 质量仍然重要，但它位于“记忆状态是否正确”之后。
