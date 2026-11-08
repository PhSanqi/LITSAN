# First-call retrieval sweep and test-process v2: frozen criteria / 首次调用检索扫描与测试流程 v2：冻结标准

Date: 2026-11-08. Written before any P7 arm was run (`sweep/grid.py` exists; no arm, no analysis ran). Frozen by `P7-FIRST-CALL-SWEEP-CRITERIA.sha256`.
日期：2026-11-08。在运行任何 P7 实验组之前写定（`sweep/grid.py` 已存在；没有运行任何实验组或分析）。由 `P7-FIRST-CALL-SWEEP-CRITERIA.sha256` 冻结。

## Question / 问题
- EN: P6 showed that raising the raw-turn cap (`_MAX`) buys complete-raw recall without a model call (+43/0 for +1.6 KB, +91/0 for +7.5 KB on the tuning pool), and that follow-up queries do not beat the same bytes spent in the first call. P7 asks: with the byte budget as the primary knob, which model-free first-call setting gives the most complete raw per byte, where is the knee, and does it replicate on untouched questions?
- 中文：P6 表明提高原始轮次上限（`_MAX`）无需模型调用即可提升原文完整召回（调参池上 +1.6 KB 得 +43/0，+7.5 KB 得 +91/0），且补查并不优于把同样字节用在首次调用上。P7 要问：以字节预算为主要旋钮，哪种无模型的首次调用设置每字节能得到最多的原文完整，拐点在哪，能否在未用过的题上复现？

## Test-process changes (v2) / 测试流程改动（v2）
- EN: **M1 Set ledger.** `sets/LEDGER.json` records every use of a question set (set sha256, criteria file, date, purpose `tune|final|confirm`). `sweep/ledger.py check <set> <purpose>` refuses a `final` or `confirm` use of a set that already has one, unless the user approved in chat and `--user-approved` is passed. Earlier uses (P0–P6) are back-filled from the READMEs and reviews.
- 中文：**M1 题集台账。** `sets/LEDGER.json` 记录每个题集的每次使用（题集 sha256、标准文件、日期、用途 `tune|final|confirm`）。`sweep/ledger.py check <set> <purpose>` 对已有一次 `final` 或 `confirm` 使用的题集拒绝再次作为这两种用途，除非用户已在对话中批准并传入 `--user-approved`。此前（P0–P6）的使用据 README 与评审文档补记。
- EN: **M2 Cluster-aware statistics.** LoCoMo questions share 10 conversations, so questions are not independent. Every paired comparison reports exact McNemar (as before) and a conversation-cluster bootstrap 95% CI of the net difference (10,000 resamples of conversations, fixed seed). A result needs both to count as significant.
- 中文：**M2 考虑聚类的统计。** LoCoMo 的题目共享 10 个对话，题目并不独立。每个配对比较除精确 McNemar 外，还报告净差的按对话聚类自助法 95% 区间（对话重采样 10,000 次，固定随机种子）。两者都显著才算显著。
- EN: **M3 Multiplicity.** Tuning picks are by effect size, not p. Any p-value quoted across the K arms of a sweep is Holm-adjusted over all K−1 comparisons against the baseline; K is declared here (stage 1: 61 arms; stage 2: at most 19 more, total ≤ 80).
- 中文：**M3 多重比较。** 调参选择依据效应量而非 p 值。对一次扫描的 K 个组所引用的任何 p 值，均对与基线的全部 K−1 个比较做 Holm 校正；K 在此声明（第一阶段 61 组；第二阶段最多再 19 组，总数 ≤ 80）。
- EN: **M4 Frontier instead of rungs.** Matched control = the piecewise-linear upper envelope of complete raw against mean bytes over the sweep's own arms (leave-one-out for the arm being judged), so a small-byte arm is compared with a control at its own bytes. Report **excess over frontier** and **gain per extra KB** over the baseline.
- 中文：**M4 用前沿线代替档位。** 匹配对照 = 本次扫描各组的"原文完整对平均字节"分段线性上包络（对被评判的组做留一），这样小字节的组与同字节的对照比较。报告**相对前沿的超额**与相对基线的**每多 1 KB 增益**。
- EN: **M5 Determinism and power.** (a) The stage-1 `N4200` arm must reproduce the stored P6 `N4200w-tp` responses exactly (text identical; latency ignored); if not, the sweep is flagged non-deterministic and differences below 5 questions are treated as noise. (b) Before the final run the minimum detectable net gain for n = 184 is computed from the tuning-pool discordance rate and written next to the result.
- 中文：**M5 确定性与功效。** (a) 第一阶段的 `N4200` 必须与已存的 P6 `N4200w-tp` 响应完全一致（文本相同，忽略延迟）；否则该次扫描标记为非确定，小于 5 题的差异视为噪声。(b) 最终运行前，用调参池的不一致率算出 n = 184 的最小可检测净增益，并写在结果旁。
- EN: **M6 Breakdowns.** Report complete raw by number of gold turns (1, 2, 3+) and by category, and the number of questions the baseline had right that an arm lost (harm), so a total gain cannot hide regressions.
- 中文：**M6 分解。** 按金标轮次数（1、2、3+）与类别报告原文完整，并报告基线答对而某组丢失的题数（退步），避免总增益掩盖退步。

## Arms (declared) / 实验组（已声明）
- EN: Baseline `N4200` (as P6). Stage 1 = `sweep/grid.py stage1`: `MAX=48` for all (so the byte budget binds), `BYTES` ∈ {3000, 4200, 6000, 8000, 11000, 16000}; ordering ∈ {unset, `cited_first`, `fused`, `interleave`}; for the three set orderings `SEMANTIC_LEAD` ∈ {4, 8, 16}; 6 × (1 + 3×3) = 60 arms plus the baseline. Stage 2 = `MIN_RATIO` ∈ {0.3, 0.5} on at most the top 3 frontier configs of stage 1 (≤ 6 arms). All with `LITSAN_DERIVED_FACT_RETRIEVAL=semantic`, `RAW_EVIDENCE=always`, `CONTEXT_LEAN=1`. No other knob or value is added after the first result.
- 中文：基线 `N4200`（同 P6）。第一阶段 = `sweep/grid.py stage1`：全部 `MAX=48`（使字节预算起约束作用），`BYTES` ∈ {3000, 4200, 6000, 8000, 11000, 16000}；排序 ∈ {未设置、`cited_first`、`fused`、`interleave`}；三种已设置排序的 `SEMANTIC_LEAD` ∈ {4, 8, 16}；6 × (1 + 3×3) = 60 组加基线。第二阶段 = 对第一阶段前沿上最多前 3 个配置加 `MIN_RATIO` ∈ {0.3, 0.5}（≤ 6 组）。全部使用 `LITSAN_DERIVED_FACT_RETRIEVAL=semantic`、`RAW_EVIDENCE=always`、`CONTEXT_LEAN=1`。看到首个结果之后不得增加其他旋钮或取值。

## Tuning and picks / 调参与入选
- EN: Pool: `sets/p3-tune-pool.json` only (649). Primary measure: complete raw (same scorer as `run.mjs`). Three **operating points** by mean-response-byte budget: **Lean** ≤ 10,000 B, **Mid** ≤ 13,000 B, **Max** ≤ 17,000 B. Each pick = the arm with the highest complete raw whose mean bytes fit the budget; ties → fewer bytes → higher complete raw-or-cited → simpler config (unset ordering first). A pick must also have lost ≤ 2 baseline-correct questions (harm check, M6) or the next best arm is taken.
- 中文：题集：仅 `sets/p3-tune-pool.json`（649）。主指标：原文完整（评分器同 `run.mjs`）。按平均响应字节预算设三个**工作点**：**精简** ≤ 10,000 B、**中档** ≤ 13,000 B、**最大** ≤ 17,000 B。每个入选 = 平均字节在预算内、原文完整最高的组；并列则取字节少者 → 原文或引用完整更高者 → 配置更简单者（优先未设置排序）。入选还须在基线答对的题中至多丢失 2 题（退步检查，M6），否则取次优组。

## Final check / 最终检验
- EN: Run once on `sets/followup-residual.json` (184 LoCoMo category 1/2 questions, never used by any experiment; ledger-checked): baseline `N4200`, the three picks, and the P6 reference `R4` (MAX 48, BYTES 9200). Verdict per pick:
  - **Validated**: gain vs baseline with exact McNemar p ≤ 0.01 after Holm over the three picks **and** conversation-cluster bootstrap 95% CI of the net difference above 0 **and** mean bytes within the operating-point budget **and** harm ≤ max(2, 10% of gained) **and** the gain per extra KB at least half of the tuning-pool value.
  - **Promising**: not validated, but unadjusted exact McNemar p ≤ 0.05 and mean bytes within budget.
  - **Failed**: otherwise.
  The overall verdict is the best pick's verdict; if the final set shows a pick below baseline, the overall verdict is failed regardless.
- 中文：在 `sets/followup-residual.json`（184 道 LoCoMo 类别 1/2 题，任何实验均未使用过；经台账检查）上只运行一次：基线 `N4200`、三个入选组，以及 P6 参照 `R4`（MAX 48、BYTES 9200）。每个入选组的结论：
  - **已验证**：相对基线增益的精确 McNemar p ≤ 0.01（对三个入选组做 Holm 校正）**且**净差的按对话聚类自助法 95% 区间高于 0 **且**平均字节在工作点预算内 **且**退步 ≤ max(2, 增益的 10%) **且**每多 1 KB 增益至少为调参池数值的一半。
  - **有希望**：未达已验证，但未校正的精确 McNemar p ≤ 0.05 且平均字节在预算内。
  - **失败**：其他情形。
  总体结论取最佳入选组的结论；若最终集上有入选组低于基线，则总体判为失败。
- EN: **Secondary, not gating:** end-to-end answer correctness on the same final questions for baseline and the Mid pick: one answer call (Codex `gpt-5.6-luna`, low, no tools; harness only) given only the delivered context, graded by a second luna call against the gold answer with a fixed prompt, cached by sha256. Reported as paired McNemar with calls and tokens. It cannot change the verdict but must be shown next to it.
- 中文：**次要、不参与判定：** 在同一最终题集上，对基线与中档入选组做端到端回答正确率：一次回答调用（Codex `gpt-5.6-luna`、low、无工具，仅在评测 harness 中），只给交付的上下文；另一次 luna 调用按固定提示词对照金标答案评分，按 sha256 缓存。以配对 McNemar 报告，并列出调用数与 token。它不能改变结论，但必须与结论并列展示。

## Rules unchanged / 不变的规则
- EN: LITSAN owns no model call; defaults stay unchanged (`_MAX` unset keeps 8; flags default off); `~/.memmy` read-only; nothing pushed or deployed; no change under `src/core/maintenance/**` or `src/distillation-*.ts`; all documents bilingual.
- 中文：LITSAN 不拥有任何模型调用；默认值不变（`_MAX` 未设置仍为 8；开关默认关闭）；`~/.memmy` 只读；不推送、不部署；不改动 `src/core/maintenance/**` 与 `src/distillation-*.ts`；所有文档双语。

## Amendment A1 (2026-11-08, written after the stage-1 tuning results and before any A1 arm ran) / 修订 A1（2026-11-08，在第一阶段调参结果之后、任何 A1 实验组运行之前写定）
- EN: Why: stage 1 (61 arms, tuning pool) saturates at about 537–539 complete raw near 15.6 KB, and the raw-or-cited ceiling is about 543 of 649, so the remaining misses are candidates the first call never retrieved, not packing. Small `SEMANTIC_LEAD` (4) beat large leads at equal bytes. A1 adds two things, both tuned on the tuning pool only; the final set is still untouched, so the final check stays clean even though the grid grew after seeing tuning results.
- 中文：原因：第一阶段（61 组，调参池）在约 15.6 KB 处饱和于 537–539 个原文完整，"原文或引用"上限约为 649 中的 543，所以剩余的失败是首次调用根本没有检索到的候选，而不是打包问题。同等字节下，小的 `SEMANTIC_LEAD`（4）优于大的。A1 增加两项，均只在调参池上调参；最终题集仍未使用，因此即使网格在看到调参结果后扩大，最终检验仍然干净。
- EN: **A1a fact lane.** New experimental knob `LITSAN_DERIVED_FACTS_MAX` (13–24; unset keeps 12; default unchanged), applied to the three stage-1 picks: values 18 and 24 → 6 arms (`sweep/grid.py a1 <stage-1 score>`). **A1b small leads.** `SEMANTIC_LEAD` ∈ {1, 2} × ordering ∈ {`fused`, `interleave`} × `BYTES` ∈ {4200, 6000, 8000} → 12 arms. Stage-2 `MIN_RATIO` stays (≤ 6 arms, on the top 3 frontier configs after A1). Declared total K = 90 for Holm; the picks rule, budgets and final protocol are unchanged and now range over all arms.
- 中文：**A1a 事实通道。** 新增实验开关 `LITSAN_DERIVED_FACTS_MAX`（13–24；未设置保持 12；默认行为不变），用于三个第一阶段入选组：取值 18 与 24 → 6 组（`sweep/grid.py a1 <第一阶段得分>`）。**A1b 小 lead。** `SEMANTIC_LEAD` ∈ {1, 2} × 排序 ∈ {`fused`、`interleave`} × `BYTES` ∈ {4200, 6000, 8000} → 12 组。第二阶段 `MIN_RATIO` 保留（A1 之后对前沿前 3 个配置，≤ 6 组）。为 Holm 声明总数 K = 90；入选规则、预算与最终流程不变，现在覆盖全部组。
- EN: Scorer fix recorded here (before the final run): evidence entries like `D8:6; D9:17` are split on `;` and a question with no scorable gold turn is dropped (affects 1 of 184 final questions, 0 of 649 tuning questions). Stage-1 `N4200` reproduced the stored P6 `N4200w-tp` responses exactly (649/649 identical apart from a random trace id), so the sweep is deterministic.
- 中文：评分器修正在此记录（最终运行之前）：形如 `D8:6; D9:17` 的证据条目按 `;` 拆分，没有可评分金标轮次的题被剔除（影响 184 道最终题中的 1 道、649 道调参题中的 0 道）。第一阶段 `N4200` 完全复现了已存的 P6 `N4200w-tp` 响应（649/649 一致，仅随机 trace id 不同），因此扫描是确定性的。
