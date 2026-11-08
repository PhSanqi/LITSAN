# P1 pass criteria (frozen before the code change) / P1 通过标准（代码修改前冻结）

Date: 2026-11-07. Change: with `LITSAN_DERIVED_RAW_EVIDENCE=always`, derived retrieval always fetches the raw L1 turns behind the selected facts (up to 8), not only when the fact bundle looks insufficient. Default off; production stays unchanged until the flag is set.
日期：2026-11-07。改动：设置 `LITSAN_DERIVED_RAW_EVIDENCE=always` 时，派生检索总是获取所选事实背后的 L1 原始轮次（最多 8 条），而不是只在事实集合看似不足时获取。默认关闭；在设置该开关前生产不变。

- EN: Arm C = B (`DERIVED_FACT_RETRIEVAL=semantic`) + `DERIVED_RAW_EVIDENCE=always`, on the same P0 harness, state and questions.
- 中文：C 组 = B 组（`DERIVED_FACT_RETRIEVAL=semantic`）+ `DERIVED_RAW_EVIDENCE=always`，使用同一 P0 评测、状态与题目。
- EN: Pass, all required:
  1. Holdout raw recall C − B ≥ 0.10.
  2. Holdout raw-or-cited complete evidence C ≥ B − 1.
  3. Mean response ≤ 12 KB.
  4. p95 latency increase vs A ≤ 300 ms.
  5. `npm run context:check` passes.
- 中文：通过标准，须全部满足：
  1. holdout 原文召回 C − B ≥ 0.10；
  2. holdout 原文或引用完整证据题数 C ≥ B − 1；
  3. 平均响应 ≤ 12 KB；
  4. 相对 A 的 p95 延迟增加 ≤ 300 ms；
  5. `npm run context:check` 通过。
