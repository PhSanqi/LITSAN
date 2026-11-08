# Lean output and adaptive raw budget: frozen criteria / 精简输出与自适应原始证据预算：冻结标准

Date: 2026-11-07. Written after building the flags (build only, no arm run). Baseline: P4 candidate KL3000 (`P4-BUDGET-CRITERIA.md`, confirm 280 → 350 vs live).
日期：2026-11-07。在实现开关之后（仅构建，未运行任何组）写定。基线：P4 候选 KL3000（`P4-BUDGET-CRITERIA.md`，确认集相对线上 280 → 350）。

## Questions / 问题
- EN: (1) Lean output: in KL3000's 10.6 KB response only about 4.0 KB is evidence text. A duplicate untargeted L2 excerpt in `projectMemory` (1.6 KB), retrieval diagnostics (0.5 KB), repeated headings, parent ids, matched terms and scores (about 1.4 KB) carry no evidence. How much can be removed without losing evidence? (2) Adaptive budget: instead of the same raw budget for every question, spend less when the evidence already looks sufficient or when further turns score low. Does that keep evidence while saving bytes, or buy more evidence at the same size?
- 中文：(1) 精简输出：KL3000 的 10.6 KB 响应中只有约 4.0 KB 是证据文本。`projectMemory` 中重复且无针对性的 L2 摘录（1.6 KB）、检索诊断（0.5 KB）、重复的标题、parent id、匹配词与分数（约 1.4 KB）不承载证据。能在不丢证据的前提下去掉多少？(2) 自适应预算：不再对每道题使用同样的原始证据预算，而是在证据看似已足够或后续轮次得分较低时少花。能否在保留证据的同时节省字节，或在相同体积下换来更多证据？

## Flags (default off) / 开关（默认关闭）
- EN: `LITSAN_CONTEXT_LEAN=1` (brief mode only): drop `retrievalDiagnostics`; project memory items already expanded as a plan entry become a pointer; plan passages drop `matched_terms`, `score`, `parent_id`, and `passage_headings` when every passage has a heading. `LITSAN_DERIVED_RAW_EVIDENCE_BYTES_SUFFICIENT=B1`: raw budget B1 when the derived-fact sufficiency heuristic says "sufficient" (no model call). `LITSAN_DERIVED_RAW_EVIDENCE_MIN_RATIO=τ`: semantic-lane candidates below τ × the top semantic score are skipped (cited turns are not affected).
- 中文：`LITSAN_CONTEXT_LEAN=1`（仅 brief 模式）：去掉 `retrievalDiagnostics`；已作为计划条目展开的项目记忆改为指针；计划段落去掉 `matched_terms`、`score`、`parent_id`，并在每段都有标题时去掉 `passage_headings`。`LITSAN_DERIVED_RAW_EVIDENCE_BYTES_SUFFICIENT=B1`：派生事实充分性启发式判为"sufficient"时原始证据预算为 B1（无模型调用）。`LITSAN_DERIVED_RAW_EVIDENCE_MIN_RATIO=τ`：语义通道中得分低于最高语义得分 τ 倍的候选被跳过（被引用轮次不受影响）。

## Arms (tuning pool 649, `sets/p3-tune-pool.json`) / 实验组（调参池 649 题）
- EN: All use KL order (`MAX=16`, `cited_first`, `SEMANTIC_LEAD=8`). References: `C2`, `KL3000` (existing responses). New, all with `CONTEXT_LEAN=1`: `N3000` (B = 3000), `N4200` (B = 4200), `NR60` / `NR75` (B = 4200, τ = 0.60 / 0.75), `NS1500` (B = 4200, sufficient → 1500), `NS1200` (B = 3000, sufficient → 1200).
- 中文：均使用 KL 顺序（`MAX=16`、`cited_first`、`SEMANTIC_LEAD=8`）。参照：`C2`、`KL3000`（已有响应）。新组均设 `CONTEXT_LEAN=1`：`N3000`（B = 3000）、`N4200`（B = 4200）、`NR60` / `NR75`（B = 4200，τ = 0.60 / 0.75）、`NS1500`（B = 4200，sufficient → 1500）、`NS1200`（B = 3000，sufficient → 1200）。

## Selection (tuning pool only) / 选择（仅调参池）
- EN: **Efficiency pick**: among new arms with complete raw ≥ KL3000 − 3 and complete raw-or-cited ≥ KL3000 − 3, the lowest mean bytes. **Coverage pick**: among new arms with mean bytes ≤ KL3000's, the highest complete raw (ties: higher raw recall, then fewer bytes). Report every arm's bytes, p95, complete raw, raw-or-cited, paired vs KL3000, and the evidence-vs-bytes frontier.
- 中文：**效率选择**：在原文完整 ≥ KL3000 − 3 且原文或引用完整 ≥ KL3000 − 3 的新组中，选平均字节最少者。**覆盖选择**：在平均字节 ≤ KL3000 的新组中，选原文完整最高者（并列时比原文召回，再比字节）。报告每组的字节、p95、原文完整、原文或引用完整、与 KL3000 的配对比较以及证据-字节前沿。

## Confirm (only with the user's go-ahead) / 确认（仅在用户同意后）
- EN: The `confirm` set (468) was used once, for P4. A second use for this different question is disclosed here; nothing in P5 is tuned on it. Run once for KL3000 and the picks. Verdicts vs KL3000: **efficiency pick useful** if mean bytes are ≥ 15% lower and complete raw loses at most 1% of n net (lost − gained ≤ 5) with no loss significant at p ≤ 0.05, and the same for raw-or-cited; **coverage pick useful** if complete raw gained > lost with exact McNemar p ≤ 0.01 and mean bytes ≤ KL3000 + 2%; p95 ≤ KL3000 + 50 ms for both. Otherwise not useful. Answer accuracy is not measured here; the separate answer-level session tests the sufficiency gate.
- 中文：`confirm` 集（468 题）已为 P4 使用过一次。此处披露为不同问题的第二次使用；P5 不在其上调任何参数。只对 KL3000 与选中组运行一次。相对 KL3000 的判定：**效率选择有用**：平均字节降低 ≥ 15%，原文完整净损失不超过 n 的 1%（减 − 增 ≤ 5）且没有 p ≤ 0.05 的显著损失，原文或引用完整同样如此；**覆盖选择有用**：原文完整增多于减，精确 McNemar p ≤ 0.01，且平均字节 ≤ KL3000 + 2%；两者 p95 均 ≤ KL3000 + 50 ms。否则判为无用。此处不测回答准确率；充分性门控由另一个回答层会话检验。
