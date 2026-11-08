# Raw turns under a byte budget: frozen criteria / 字节预算下的原始轮次：冻结标准

Date: 2026-11-07. Written after building the flags and one 50-question smoke run (dev, `smoke-k`: 13.3 raw turns at 10.6 KB mean), before any P4 arm on the tuning pool. Context: `docs/reviews/2026-11-07-raw-turn-selection-review.md`.
日期：2026-11-07。在实现开关并做过一次 50 题冒烟运行（dev，`smoke-k`：平均 10.6 KB 中 13.3 个原始轮次）之后、在调参池上运行任何 P4 组之前写定。背景：`docs/reviews/2026-11-07-raw-turn-selection-review.md`。

## Question / 问题
- EN: P3 (tuning only) showed more raw slots help when both lanes are kept, but each extra slot cost about 0.35 KB, mostly not evidence: in today's 10.5 KB response only about 2.6 KB is evidence text, and each raw turn carries about 204 bytes of text inside a 575-byte entry (a repeated 133-byte `use` sentence, ids, scores, matched terms). P4 asks whether a compact encoding plus a byte budget for raw text (instead of a slot count) gets P3's gain without P3's size.
- 中文：P3（仅调参集）表明保留两条通道时更多原始证据位有用，但每多一位约 0.35 KB，且大多不是证据：在当前 10.5 KB 的响应中只有约 2.6 KB 是证据文本，每个原始轮次约 204 字节的文本装在 575 字节的条目里（重复的 133 字节 `use` 句、id、分数、匹配词）。P4 检验：紧凑编码加原始文本字节预算（取代位数）能否在不增加 P3 体积的情况下获得 P3 的增益。

## Arms / 实验组
- EN: All with `LITSAN_DERIVED_FACT_RETRIEVAL=semantic`, `LITSAN_DERIVED_RAW_EVIDENCE=always`, `LITSAN_DERIVED_RAW_EVIDENCE_MAX=16`, on the existing P0 state. `LITSAN_DERIVED_RAW_EVIDENCE_BYTES=B` keeps candidates in priority order while their text fits in B bytes (the first always fits) and emits them as one entry whose passages carry `evidence_ref`.
  - `C2`: control, today's live behaviour (7 raw, about 10.5 KB). `L8C16`: P3 reference.
  - `KL2400` / `KL3000` / `KL3600`: order = first 8 semantic turns, then cited turns (`cited_first` + `SEMANTIC_LEAD=8`), budget B.
  - `KI2400` / `KI3000` / `KI3600`: order = alternate semantic and cited (`interleave`), budget B.
- 中文：均设置 `LITSAN_DERIVED_FACT_RETRIEVAL=semantic`、`LITSAN_DERIVED_RAW_EVIDENCE=always`、`LITSAN_DERIVED_RAW_EVIDENCE_MAX=16`，使用现有 P0 状态。`LITSAN_DERIVED_RAW_EVIDENCE_BYTES=B` 按优先顺序保留文本能放入 B 字节的候选（第一个总会保留），并作为一个条目输出，各段落自带 `evidence_ref`。
  - `C2`：对照，即当前线上行为（7 个原始轮次，约 10.5 KB）。`L8C16`：P3 参照。
  - `KL2400` / `KL3000` / `KL3600`：顺序为前 8 个语义轮次、其后为被引用轮次（`cited_first` + `SEMANTIC_LEAD=8`），预算 B。
  - `KI2400` / `KI3000` / `KI3600`：顺序为语义与被引用交替（`interleave`），预算 B。

## Selection on the tuning pool (649, `sets/p3-tune-pool.json`) / 调参池上的选择
- EN: Two size tiers by mean response bytes: tier A ≤ 11,000 (no growth over live), tier B ≤ 13,000. In each tier, among arms whose complete raw-or-cited count is ≥ C2's, pick the highest complete raw, then higher raw recall, then fewer bytes. Report gain per KB over C2 for every arm.
- 中文：按平均响应字节分两档：A 档 ≤ 11,000（不比线上大），B 档 ≤ 13,000。每档内，在原文或引用完整证据数 ≥ C2 的组中，选原文完整证据最高者，其次原文召回更高者，再次字节更少者。为每个组报告相对 C2 的每 KB 增益。
- EN: Negative signal on tuning: if the tier-A pick beats C2 on complete raw by fewer than 7 questions (1% of the pool), record P4 as not useful at today's size.
- 中文：调参上的负面信号：若 A 档选中组的原文完整证据比 C2 多不足 7 题（调参池的 1%），记录 P4 在当前体积下无用。

## Confirm (468, `confirm` in `sets/signal-set.json`) / 确认集
- EN: Run only after the user approves, once, for C2 and the tier-A pick (plus the tier-B pick if different). Verdict per pick vs C2, as in P3: **useful** = complete raw gained > lost with exact McNemar p ≤ 0.01, complete raw-or-cited not lower at p ≤ 0.05, the tier's byte limit held, p95 ≤ C2 + 50 ms; **clearly useless** = 95% CI upper bound of the paired complete-raw difference below +2 pp, or point estimate ≤ 0; otherwise **inconclusive**. No parameter changes after the confirm run. A useful result is a release candidate only after separate approval, and needs `npm run context:check` to pass.
- 中文：仅在用户批准后运行一次，只运行 C2 与 A 档选中组（若 B 档选中组不同则一并运行）。每个选中组对 C2 的判定同 P3：**有用** = 原文完整证据增多于减，精确 McNemar p ≤ 0.01，原文或引用完整证据没有 p ≤ 0.05 的下降，满足该档字节上限，p95 ≤ C2 + 50 ms；**明确无用** = 原文完整证据配对差的 95% 置信区间上界低于 +2 个百分点，或点估计 ≤ 0；否则为**不确定**。确认集运行后不再改参数。有用的结果需另行批准才成为发布候选，并须通过 `npm run context:check`。
