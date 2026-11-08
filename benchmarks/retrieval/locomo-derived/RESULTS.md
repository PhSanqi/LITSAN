# P0 results: derived-fact retrieval through the production path / P0 结果：经生产路径的派生事实检索

Date: 2026-11-07. Criteria: `CRITERIA.md` (sha256 `22869b72…`, frozen before the harness). Harness: `run.mjs`, `paired.py`, `ref-resolution.py`. Branch `experiment/p0-derived-fact-eval-20261107` from `c47c56a7`.
日期：2026-11-07。标准：`CRITERIA.md`（sha256 `22869b72…`，在评测代码前冻结）。评测：`run.mjs`、`paired.py`、`ref-resolution.py`。分支 `experiment/p0-derived-fact-eval-20261107`，基于 `c47c56a7`。

## Setup / 设置
- EN: Isolated stack (`scripts/run-stack.mjs`, ports 19210/19211). All 5,882 LoCoMo turns were captured one per L1 event through `litsan_turn`. Each conversation then got one L2 written through `MemoryRestContextSource.distill`, the same Core write distillation submit uses, and recorded as the completed revision. Its atomic facts are the 2,369 extracted records, each citing its source `l1:` events. Questions went through `litsan_context`: arm A without `DERIVED_FACT_RETRIEVAL` (today's production), arm B with `semantic`.
- 中文：隔离栈（`scripts/run-stack.mjs`，端口 19210/19211）。全部 5,882 个 LoCoMo 轮次经 `litsan_turn` 逐条写为 L1 事件；每段对话再通过 `MemoryRestContextSource.distill`（与蒸馏提交相同的 Core 写入）写入一个 L2，并登记为已完成修订；其原子事实为 2,369 条抽取记录，各自引用来源 `l1:` 事件。问题经 `litsan_context` 提问：A 组不设 `DERIVED_FACT_RETRIEVAL`（即当前生产），B 组设为 `semantic`。
- EN: Two recall measures. "Raw" means the turn's own words are in the response. "Raw or cited" means the turn's words are present, or a delivered fact cites that turn. After distillation arm A delivers no raw turns, so "raw or cited" is the meaningful comparison.
- 中文：两种召回口径。"原文"指响应中包含该轮次原话；"原文或引用"指原话在场，或某条交付的事实引用了该轮次。蒸馏后 A 组不交付任何原始轮次，因此"原文或引用"才是有意义的比较。

## Results / 结果

| | dev A | dev B | holdout A | holdout B |
|---|---|---|---|---|
| raw recall / 原文召回 | 0.000 | 0.060 | 0.000 | 0.061 |
| raw-or-cited recall / 原文或引用召回 | 0.506 | 0.576 | 0.597 | 0.799 |
| complete evidence / 完整证据题数 | 19/50 | 24/50 | 27/57 | 37/57 |
| gained / lost (paired) / 配对增减 | | 8 / 3 (p = 0.23) | | 10 / 0 (p = 0.002) |
| mean bytes / 平均字节 | 5,112 | 7,352 | 5,148 | 7,340 |
| p95 latency / p95 延迟 | 165 ms | 220 ms | 165 ms | 161 ms |

## Criteria / 标准判定
- EN: (1) Holdout recall B − A: +0.20 raw-or-cited, +0.061 raw; ≥ 0.05 → **pass**.
- 中文：(1) holdout 召回 B − A：原文或引用 +0.20，原文 +0.061；≥ 0.05 → **通过**。
- EN: (2) Existing suites: `p0-real-pipeline-suite` scores 6/6 grounded with critical recall 1.0, identical to baseline with the flag off and on. Both it and the Chinese A/B suite use `buildContextCapsule` directly, a path the flag does not reach, so no regression is possible → **pass**. Coverage gap: neither suite exercises the derived branch in `src/shell/catalog/context.ts`.
- 中文：(2) 现有测试集：`p0-real-pipeline-suite` 无论开关开否均为 6/6 grounded、关键召回 1.0，与基线一致；它与中文 A/B 测试集都直接调用 `buildContextCapsule`，开关不会触及该路径，因此不可能退步 → **通过**。覆盖缺口：两套测试都没有覆盖 `src/shell/catalog/context.ts` 中的派生分支。
- EN: (3) Real LITSAN L2 (`memhub`, 1,033 facts, committed 2026-11-07): 50/50 sampled facts cite L1 events with text (rate 1.0), and 34 of them cite exactly one turn → **pass**.
- 中文：(3) 真实 LITSAN L2（`memhub`，1,033 条事实，2026-11-07 提交）：抽样 50/50 条事实引用的 L1 事件均有原文（解析率 1.0），其中 34 条只引用一个轮次 → **通过**。
- EN: (4) p95 latency +55 ms dev, −4 ms holdout; ≤ 300 ms → **pass**.
- 中文：(4) p95 延迟 dev +55 ms，holdout −4 ms；≤ 300 ms → **通过**。

## What this means for P1 / 对 P1 的含义
- EN: Correction to BUILD-PLAN §0: before a conversation has an L2, raw turns do come back (Core indexes each capture). Once an L2 exists, `litsan_context` returns fact passages only (arm A raw recall 0.000). So after distillation the answering agent sees facts, not text.
- 中文：对 BUILD-PLAN §0 的更正：对话尚无 L2 时，原始轮次确实会被召回（Core 为每条捕获建索引）；一旦存在 L2，`litsan_context` 只返回事实片段（A 组原文召回 0.000）。因此蒸馏后回答方看到的是事实而非原文。
- EN: The flag raises how often the needed turns are reached (holdout complete evidence 27 → 37), but mostly as facts citing them. Raw text arrives for only about 6% of gold turns, because raw evidence is fetched only when sufficiency is below "sufficient" or for temporal queries, and is capped at 4–8 passages. P1's change, always returning fact-keyed raw passages within the byte budget, targets exactly this gap. Its gate is raw recall on this same harness.
- 中文：开关提高了所需轮次被触达的比例（holdout 完整证据 27 → 37），但多以引用它们的事实形式出现；原文只覆盖约 6% 的金标轮次，因为原始证据只在充分性低于"sufficient"或时间类查询时才获取，且上限为 4–8 段。P1 的改动（在字节预算内始终返回按事实键找到的原文片段）正是针对这一缺口，其门槛是同一评测上的原文召回。
- EN: Caveat: the facts are our LoCoMo extractor's records, not production distillation output. On real data, criterion 3 shows the citations needed for this path are present.
- 中文：注意：事实来自我们的 LoCoMo 抽取器，而非生产蒸馏输出；在真实数据上，标准 3 表明该路径所需的引用是存在的。

## P1: raw turns behind facts (`LITSAN_DERIVED_RAW_EVIDENCE=always`) / P1：事实背后的原始轮次

- EN: Criteria: `P1-CRITERIA.md` (sha256 `88579865…`, frozen before the change). Code: `src/shell/catalog/context.ts`. With the flag set, raw evidence is fetched on every derived query (up to 8 passages) instead of only when the fact bundle looks insufficient. Default off.
- 中文：标准：`P1-CRITERIA.md`（sha256 `88579865…`，改动前冻结）。代码：`src/shell/catalog/context.ts`。设置开关后，每次派生查询都获取原始证据（最多 8 段），而不是只在事实集合看似不足时获取；默认关闭。
- EN: Diagnosis before the change: in arm B raw evidence was admitted for only 28 of 107 questions (about 1.6 passages each), while 126 gold turns were reached only as citing facts.
- 中文：改动前的诊断：B 组只有 107 题中的 28 题获得了原始证据（平均约 1.6 段），另有 126 个金标轮次只以引用它们的事实形式出现。

| | dev B | dev C | holdout B | holdout C |
|---|---|---|---|---|
| raw recall / 原文召回 | 0.060 | 0.413 | 0.061 | 0.564 |
| complete raw evidence / 原文完整证据 | 1 | 14 (13 / 0, p = 0.0002) | 2 | 27 (25 / 0, p < 0.0001) |
| raw-or-cited complete / 原文或引用完整 | 24 | 24 | 37 | 39 |
| mean bytes / 平均字节 | 7,352 | 10,621 | 7,340 | 10,760 |
| p95 latency / p95 延迟 | 220 ms | 226 ms | 161 ms | 160 ms |

- EN: Criteria: (1) holdout raw recall +0.50 ≥ 0.10 → pass; (2) raw-or-cited complete 39 ≥ 36 → pass; (3) 10.8 KB ≤ 12 KB → pass; (4) p95 160 ms vs A 165 ms → pass; (5) `npm run context:check` → see below.
- 中文：判定：(1) holdout 原文召回 +0.50 ≥ 0.10 → 通过；(2) 原文或引用完整 39 ≥ 36 → 通过；(3) 10.8 KB ≤ 12 KB → 通过；(4) p95 160 ms，A 组为 165 ms → 通过；(5) `npm run context:check` → 见下。
- EN: Versus today's production (A → C), holdout questions with all their evidence reached rise from 27 to 39 of 57 (12 gained, 0 lost, p = 0.0005), and for 27 of them the evidence is delivered as raw text rather than as citing facts.
- 中文：相对当前生产（A → C），holdout 中证据全部被触达的题目由 57 题中的 27 题升至 39 题（增 12、减 0，p = 0.0005），其中 27 题的证据以原文而非引用事实的形式交付。
- EN: (5) `npm run context:check` on the changed tree: exit 0, `# fail 0` in all 11 node-test groups, all e2e scripts passed → **pass**. All five P1 criteria pass. Not yet covered: a dedicated test for the flag itself.
- 中文：(5) 在改动后的代码上运行 `npm run context:check`：退出码 0，11 组 node 测试均为 `# fail 0`，所有 e2e 脚本通过 → **通过**。P1 五条标准全部通过。尚未覆盖：针对该开关本身的专门测试。

## P2: raw-evidence packing (cited first) — rejected / P2：原始证据打包（引用优先）——否决

- EN: Criteria: `P2-PACKING-CRITERIA.md` (sha256 `2af66fb3…`, frozen before the code). Code tested: `p2-packing-experiment.patch` (flags `LITSAN_DERIVED_RAW_EVIDENCE_ORDER=cited_first|fused`, `LITSAN_DERIVED_RAW_EVIDENCE_MAX`), not kept in `src/`. Stats: `paired-p2.py` → `.review-runtime/locomo-derived/paired-p2.json`.
- 中文：标准：`P2-PACKING-CRITERIA.md`（sha256 `2af66fb3…`，在代码前冻结）。测试代码：`p2-packing-experiment.patch`（开关 `LITSAN_DERIVED_RAW_EVIDENCE_ORDER=cited_first|fused`、`LITSAN_DERIVED_RAW_EVIDENCE_MAX`），未保留在 `src/` 中。统计：`paired-p2.py` → `.review-runtime/locomo-derived/paired-p2.json`。
- EN: Tuning on dev (50): C2 complete raw 14, D8 22, D12 22, E8 21, E12 21. D8 was chosen (tie with D12, higher raw recall 0.558 vs 0.550). The 12-slot arms did not test a larger budget: the Turn Knowledge Plan admits at most 8 supporting entries (1 fact chronology + 7 raw turns), so every arm delivered exactly 7 raw turns.
- 中文：dev（50 题）调参：C2 原文完整证据 14，D8 22，D12 22，E8 21，E12 21。选中 D8（与 D12 持平，原文召回更高 0.558 对 0.550）。12 位上限的组并未测到更大预算：Turn Knowledge Plan 最多接纳 8 个 supporting 条目（1 个事实时间线 + 7 个原始轮次），因此所有组都恰好交付 7 个原始轮次。

| C2 → D8 | dev (50) | holdout (57) | fresh (85) |
|---|---|---|---|
| raw recall / 原文召回 | 0.413 → 0.558 | 0.564 → 0.648 | 0.472 → 0.458 |
| complete raw / 原文完整证据 | 14 → 22 (+9/−1, p = 0.02) | 27 → 30 (+7/−4, p = 0.55) | 25 → 24 (+8/−9, p = 1.0) |
| complete raw or cited / 原文或引用完整 | 24 → 26 (+2/−0) | 39 → 38 (+0/−1) | 39 → 33 (+0/−6, p = 0.03) |
| mean bytes / 平均字节 | 10,495 → 10,816 | 10,634 → 10,927 | 10,500 → 10,796 |
| p95 / p95 延迟 | 207 → 207 ms | 225 → 210 ms | 207 → 216 ms |

- EN: Criteria: (1) fresh: complete raw −1, raw recall −0.014 → **fail**. (2) holdout: raw-or-cited 38 ≥ 38, raw not worse → pass. (3) ≤ 12 KB, p95 within +50 ms → pass. (4) not run, because the change is not kept. **Rejected; nothing to roll out.**
- 中文：判定：(1) fresh：原文完整证据 −1，原文召回 −0.014 → **未通过**。(2) holdout：原文或引用完整 38 ≥ 38，原文未变差 → 通过。(3) ≤ 12 KB，p95 在 +50 ms 以内 → 通过。(4) 因改动未保留而未运行。**否决，无可上线内容。**
- EN: Why it failed: the uncited raw slots are not low-value fill. They come from a semantic search over every source turn of the conversation and often find gold turns that no selected fact cites. On fresh, D8 dropped 31 gold turns that C2 had delivered raw, and 16 of them were cited by no delivered fact, which is why raw-or-cited completeness fell by 6. Giving the slots to cited turns trades one source of hits for another; with 7 slots the trade is a wash at best. The dev gain did not transfer.
- 中文：失败原因：未被引用的原始证据位并非低价值填充。它们来自对整段对话所有来源轮次的语义搜索，常能找到没有任何选中事实引用的金标轮次。在 fresh 上，D8 丢掉了 C2 已原文交付的 31 个金标轮次，其中 16 个不被任何交付的事实引用，这就是原文或引用完整证据下降 6 题的原因。把证据位让给被引用轮次，只是用一种命中来源换另一种；在 7 个位置下，这种交换最多持平。dev 上的增益没有迁移。
- EN: Correction to the earlier rollout note: the "low-value admitted turns" seen live are this same semantic lane; on this evidence they should stay.
- 中文：对此前上线说明的更正：线上看到的"低价值被接纳轮次"正是这条语义通道；按本次证据，应予保留。
- EN: What is left: the binding limit is the 8-entry supporting cap, not the order. A test that keeps the 7 semantic turns and adds cited turns on top (for example 7 + 4, about +2.5 KB) needs a TKP change and a new untouched question set, since `fresh` has now been used once.
- 中文：剩余方向：真正的约束是 8 个 supporting 条目的上限，而不是排序。保留 7 个语义轮次、再额外加入被引用轮次（例如 7 + 4，约 +2.5 KB）的测试需要修改 TKP，并需要一套新的未使用题集，因为 `fresh` 已使用过一次。

## P3: more raw slots (tuning pool only) / P3：更多原始证据位（仅调参池）

- EN: Criteria: `P3-SLOTS-CRITERIA.md` (sha256 `851e8630…`). Tuning pool `sets/p3-tune-pool.json` (649). Paired vs C2 (`paired-p3.py` → `.review-runtime/locomo-derived/paired-p3-tp.json`). The confirm set was not run: the user stopped that run and redirected to P4, which supersedes P3's pick.
- 中文：标准：`P3-SLOTS-CRITERIA.md`（sha256 `851e8630…`）。调参池 `sets/p3-tune-pool.json`（649 题）。与 C2 配对（`paired-p3.py` → `.review-runtime/locomo-derived/paired-p3-tp.json`）。确认集未运行：用户中止了该运行并转向 P4，P4 取代了 P3 的选择。

| arm / 组 | mean bytes / 平均字节 | complete raw / 原文完整 | gained / lost | complete raw or cited / 原文或引用完整 |
|---|---|---|---|---|
| C2 (7 raw) | 10,498 | 339 | | 472 |
| S12 | 13,322 | 387 | 48 / 0 | 488 |
| S16 | 15,558 | 406 | 67 / 0 | 496 |
| L8C12 | 13,525 | 426 | 87 / 0 | 476 |
| L8C16 | 15,961 | 448 | 109 / 0 | 488 |

- EN: Reading: more slots help when the semantic lane is kept and cited turns are added on top (L8C16), unlike P2's trade within 7 slots. Every added slot cost about 0.35 KB, mostly entry overhead.
- 中文：解读：保留语义通道并在其上追加被引用轮次（L8C16）时，更多证据位有用，这与 P2 在 7 个位置内的互换不同。每增加一位约 0.35 KB，大部分是条目开销。

## P4: compact raw entry under a byte budget (tuning pool) / P4：字节预算下的紧凑原始证据条目（调参池）

- EN: Criteria: `P4-BUDGET-CRITERIA.md` (sha256 in `P4-BUDGET-CRITERIA.sha256`). Same pool and control. `KL` = 8 semantic turns first, then cited; `KI` = alternate; number = raw text budget in bytes. Stats: `.review-runtime/locomo-derived/paired-p4-tp.json`.
- 中文：标准：`P4-BUDGET-CRITERIA.md`（sha256 见 `P4-BUDGET-CRITERIA.sha256`）。调参池与对照相同。`KL` = 先 8 个语义轮次、再被引用轮次；`KI` = 交替；数字为原始文本字节预算。统计：`.review-runtime/locomo-derived/paired-p4-tp.json`。

| arm / 组 | mean bytes / 平均字节 | p95 | raw recall / 原文召回 | complete raw / 原文完整 (gained / lost, 95% CI) | complete raw or cited / 原文或引用完整 (gained / lost) |
|---|---|---|---|---|---|
| C2 | 10,498 | 172 ms | 0.582 | 339 | 472 |
| L8C16 (P3) | 15,961 | 181 ms | 0.755 | 448 (109 / 0) | 488 (16 / 0) |
| KL2400 | 9,911 | 152 ms | 0.713 | 424 (85 / 0, +10.5 to +15.7 pp) | 477 (5 / 0) |
| KL3000 | 10,631 | 149 ms | 0.735 | 436 (97 / 0, +12.2 to +17.7 pp) | 480 (8 / 0) |
| KL3600 | 11,218 | 155 ms | 0.751 | 445 (106 / 0, +13.5 to +19.2 pp) | 485 (13 / 0) |
| KI2400 | 9,900 | 157 ms | 0.713 | 420 (86 / 5) | 472 (4 / 4) |
| KI3000 | 10,635 | 149 ms | 0.731 | 435 (97 / 1) | 482 (11 / 1) |
| KI3600 | 11,198 | 154 ms | 0.748 | 445 (106 / 0) | 488 (16 / 0) |

- EN: Picks under the frozen rule: tier A (≤ 11,000 B) **KL3000**; tier B (≤ 13,000 B) **KL3600** (ties KI3600 on complete raw, higher raw recall). Tuning signal is strongly positive (the 1% bar is 7 questions; KL3000 gains 97 and loses 0).
- 中文：按冻结规则的选择：A 档（≤ 11,000 B）**KL3000**；B 档（≤ 13,000 B）**KL3600**（原文完整与 KI3600 持平，原文召回更高）。调参信号强烈为正（1% 门槛为 7 题；KL3000 增 97、减 0）。
- EN: Mechanism: the compact entry removes about 370 bytes of repeated overhead per raw turn, so the same 10.5 KB carries about 13 turns instead of 7, and the two lanes no longer compete for the same slots. KL3000 recovers 89% of L8C16's gain at 0.13 KB more than today instead of 5.5 KB, and is faster. Lead order (KL) never loses a question; interleave (KI) loses a few at small budgets, because the top semantic turns are the ones most often unique to that lane.
- 中文：机制：紧凑条目使每个原始轮次少约 370 字节的重复开销，相同的 10.5 KB 可容纳约 13 个而非 7 个轮次，两条通道不再争抢同一批位置。KL3000 以比当前仅多 0.13 KB（而非 5.5 KB）的代价取得 L8C16 增益的 89%，且更快。先语义顺序（KL）从未丢题；交替顺序（KI）在小预算下丢失少数题，因为排名靠前的语义轮次最常是该通道独有的。
- EN: Not yet done at tuning time: the confirm set (run below after the user's go-ahead); an answer-level check. Caveats: LoCoMo only; the facts come from our extractor, not production distillation; the compact entry changes the TKP shape that Harness prompts see, which needs a consumer check before any release.
- 中文：调参时尚未完成：确认集（经用户同意后已在下文运行）；回答层检验。注意：仅 LoCoMo；事实来自我们的抽取器而非生产蒸馏；紧凑条目改变了 Harness 看到的 TKP 结构，发布前需检查下游使用方。

### P4 confirm set (run once, 2026-11-07) / P4 确认集（只运行一次，2026-11-07）

- EN: `confirm` part of `sets/signal-set.json` (468; 465 have gold turns in the corpus), untouched until this run; C2, KL3000 and KL3600 only, no parameter changes. Stats: `.review-runtime/locomo-derived/paired-p4-confirm.json`.
- 中文：`sets/signal-set.json` 的 `confirm` 部分（468 题，其中 465 题的金标轮次在语料中），在本次运行前从未使用；只运行 C2、KL3000、KL3600，未改参数。统计：`.review-runtime/locomo-derived/paired-p4-confirm.json`。

| arm / 组 | mean bytes / 平均字节 | p95 | raw recall / 原文召回 | complete raw / 原文完整 (gained / lost, p, 95% CI) | complete raw or cited / 原文或引用完整 (gained / lost, p) |
|---|---|---|---|---|---|
| C2 | 10,473 | 183 ms | 0.620 | 280 | 386 |
| KL3000 | 10,652 | 170 ms | 0.774 | 350 (70 / 0, p < 1e-20, +11.8 to +18.3 pp) | 391 (5 / 0, p = 0.06) |
| KL3600 | 11,207 | 170 ms | 0.781 | 354 (74 / 0, p < 1e-21, +12.6 to +19.2 pp) | 393 (7 / 0, p = 0.016) |

- EN: Verdict under `P4-BUDGET-CRITERIA.md`: **KL3000 useful** (tier A: p ≤ 0.01, raw-or-cited not lower, 10,652 ≤ 11,000 B, p95 −13 ms). **KL3600 useful** (tier B: 11,207 ≤ 13,000 B). The tuning result replicated on unseen questions with no losses. KL3600 adds only 4 more questions for +0.55 KB, so KL3000 is the release candidate. Gains are mostly single-hop (category 4: +61 of 70), the only untouched category; on the tuning pool KL3000's 97 gains split as multi-hop +18, temporal +12, open-domain +9, single-hop +58.
- 中文：按 `P4-BUDGET-CRITERIA.md` 判定：**KL3000 有用**（A 档：p ≤ 0.01，原文或引用未下降，10,652 ≤ 11,000 B，p95 −13 ms）。**KL3600 有用**（B 档：11,207 ≤ 13,000 B）。调参结果在未见过的题目上复现且无任何减少。KL3600 仅多 4 题却多 0.55 KB，因此 KL3000 为发布候选。增益主要来自单跳（类别 4：70 题中 +61），这是唯一未使用的类别；在调参池上，KL3000 的 97 题增益分布为多跳 +18、时间 +12、开放域 +9、单跳 +58。
- EN: Before any release (separate approval): check every consumer of the TKP shape (Harness prompts, card or diet tests, Console) against the single compact `adaptive:raw-evidence` entry; build a delta release from live `20261107-derived-raw-evidence`; an answer-level paired check would show whether verbatim evidence changes answers, which LoCoMo has not shown so far.
- 中文：发布前（需另行批准）：逐一检查 TKP 结构的使用方（Harness 提示、卡片与 diet 测试、Console）是否兼容单个紧凑的 `adaptive:raw-evidence` 条目；从线上 `20261107-derived-raw-evidence` 构建增量发布；回答层配对检验可说明原文证据是否改变回答，而 LoCoMo 迄今尚未显示这一点。

## P5: lean output and adaptive raw budget (tuning pool) / P5：精简输出与自适应原始证据预算（调参池）

- EN: Criteria: `P5-LEAN-ADAPTIVE-CRITERIA.md` (sha256 in `P5-LEAN-ADAPTIVE-CRITERIA.sha256`). Pool 649; all new arms use KL order and `LITSAN_CONTEXT_LEAN=1`; paired vs KL3000. Stats: `.review-runtime/locomo-derived/paired-p5-tp.json`.
- 中文：标准：`P5-LEAN-ADAPTIVE-CRITERIA.md`（sha256 见 `P5-LEAN-ADAPTIVE-CRITERIA.sha256`）。调参池 649 题；新组均使用 KL 顺序与 `LITSAN_CONTEXT_LEAN=1`；与 KL3000 配对。统计：`.review-runtime/locomo-derived/paired-p5-tp.json`。

| arm / 组 | mean bytes / 平均字节 | p95 | complete raw vs KL3000 / 原文完整（对 KL3000） | raw or cited / 原文或引用 |
|---|---|---|---|---|
| C2 (live / 线上) | 10,498 | 172 ms | 339 | 472 |
| KL3000 | 10,631 | 149 ms | 436 | 480 |
| **N3000** (lean, B 3000) | **7,437** | 179 ms | 436 (0 / 0) | 479 (0 / 1) |
| **N4200** (lean, B 4200) | **8,236** | 172 ms | 446 (+10 / −0, p = 0.002) | 485 (+6 / −1) |
| NR60 (B 4200, τ 0.60) | 8,197 | 166 ms | 445 (+10 / −1) | 485 (+6 / −1) |
| NR75 (B 4200, τ 0.75) | 7,935 | 167 ms | 427 (+10 / −19) | 483 (+6 / −3) |
| NS1500 (sufficient → 1500) | 6,372 | 160 ms | 380 (+4 / −60) | 476 (+3 / −7) |
| NS1200 (B 3000, sufficient → 1200) | 5,892 | 160 ms | 356 (+0 / −80) | 469 (+0 / −11) |

- EN: Picks: **efficiency = N3000** (−30% bytes, same evidence); **coverage = N4200** (+10 questions at −23% bytes vs KL3000). Confirm results below.
- 中文：选择：**效率 = N3000**（字节 −30%，证据相同）；**覆盖 = N4200**（相对 KL3000 多 10 题，字节 −23%）。确认集结果见下。
- EN: What worked: lean output is lossless for raw evidence; the only change is one question whose citation sat in the untargeted `projectMemory` excerpt. Spending part of the saved bytes on more raw text (B 4200) still leaves the response 23% smaller than KL3000, with diminishing returns: +1,200 bytes of raw text buys 10 more questions, after 3,000 bytes bought 97.
- 中文：有效：精简输出对原文证据无损；唯一变化是一道题的引用原本位于无针对性的 `projectMemory` 摘录中。把节省的部分字节用于更多原文（B 4200）后，响应仍比 KL3000 小 23%，且收益递减：原文再增加 1,200 字节只多 10 题，而前 3,000 字节带来 97 题。
- EN: What failed and why: (1) The derived-fact sufficiency heuristic is a poor stop signal: when it says "sufficient", the raw turns are still needed (−60 / −80 questions). It measures whether facts lexically cover the query, not whether the facts carry the detail the gold evidence holds. (2) A relative score floor on the semantic lane loses questions once it bites (τ 0.75: −19): gold turns often score well below the top semantic hit. Cheap, model-free signals did not predict when more evidence stops helping; budget by bytes is better than by stop rules here.
- 中文：失败及原因：(1) 派生事实充分性启发式不适合作为停止信号：它判为"sufficient"时原始轮次仍然需要（−60 / −80 题）。它衡量的是事实是否在词面上覆盖查询，而不是事实是否承载金标证据中的细节。(2) 语义通道的相对分数下限一旦生效就会丢题（τ 0.75：−19）：金标轮次的得分常远低于最高语义命中。廉价、无模型的信号无法预测何时更多证据不再有用；在这里按字节预算优于按停止规则。

### P5 confirm set (second retrieval use, run once) / P5 确认集（第二次检索用途，只运行一次）

- EN: Same 465 scored questions as P4 confirm; second retrieval use as disclosed in the criteria; 150 of them were also answered once by the answer-side session (`experiment/answer-side-20261107`), which tunes nothing here. KL3000 was rerun and reproduced its P4 run exactly (468 / 468 identical plans). Stats: `.review-runtime/locomo-derived/paired-p5-confirm.json`.
- 中文：与 P4 确认集相同的 465 道计分题；按标准中的披露为第二次检索用途；其中 150 题也曾被回答侧会话（`experiment/answer-side-20261107`）回答过一次，那里没有调任何本处参数。KL3000 重跑后与其 P4 运行完全一致（468 / 468 计划相同）。统计：`.review-runtime/locomo-derived/paired-p5-confirm.json`。

| arm / 组 | mean bytes / 平均字节 | vs KL3000 | p95 | complete raw / 原文完整 (vs KL3000) | raw or cited / 原文或引用 |
|---|---|---|---|---|---|
| KL3000 | 10,652 | | 169 ms | 350 | 391 |
| N3000 | 7,455 | −30.0% | 154 ms | 350 (0 / 0) | 391 (0 / 0) |
| N4200 | 8,189 | −23.1% | 151 ms | 359 (+9 / −0, p = 0.004, +0.7 to +3.2 pp) | 396 (+5 / −0, p = 0.06) |

- EN: Verdicts under `P5-LEAN-ADAPTIVE-CRITERIA.md`: **N3000 useful** (efficiency: −30% bytes, no loss on either measure). **N4200 useful** (coverage: +9 / −0 at p ≤ 0.01, and smaller than KL3000). N4200 dominates KL3000 on evidence, size and latency, so it replaces KL3000 as the release candidate: flags `LITSAN_DERIVED_RAW_EVIDENCE=always`, `_MAX=16`, `_ORDER=cited_first`, `_SEMANTIC_LEAD=8`, `_BYTES=4200`, `LITSAN_CONTEXT_LEAN=1`. Against today's live behaviour on this set (P4 C2: 280 complete raw at 10,473 B), N4200 is 359 at 8,189 B.
- 中文：按 `P5-LEAN-ADAPTIVE-CRITERIA.md` 判定：**N3000 有用**（效率：字节 −30%，两项指标均无损失）。**N4200 有用**（覆盖：+9 / −0，p ≤ 0.01，且比 KL3000 更小）。N4200 在证据、体积和延迟上均优于 KL3000，因此取代 KL3000 成为发布候选：开关 `LITSAN_DERIVED_RAW_EVIDENCE=always`、`_MAX=16`、`_ORDER=cited_first`、`_SEMANTIC_LEAD=8`、`_BYTES=4200`、`LITSAN_CONTEXT_LEAN=1`。在该集合上相对当前线上行为（P4 C2：10,473 B 下原文完整 280），N4200 为 8,189 B 下 359。
- EN: Release prerequisites unchanged: consumer check of the compact raw entry and of the lean payload (`projectMemory` pointer, no `retrievalDiagnostics` in brief mode), a delta release from live `20261107-derived-raw-evidence`, backup and auto-rollback.
- 中文：发布前提不变：检查紧凑原始证据条目与精简载荷（`projectMemory` 指针、brief 模式无 `retrievalDiagnostics`）的使用方，从线上 `20261107-derived-raw-evidence` 构建增量发布，备份并自动回滚。
