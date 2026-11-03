# Upstream attribution

LITSAN started from the open-source Memmy Agent codebase maintained by MemTensor:

- Upstream repository: `https://github.com/MemTensor/memmy-agent`
- Initial LITSAN work was based on the upstream `v1.1.4` line.

Inherited source code, notices and license obligations remain attributable to the upstream project. LITSAN-specific work adds or changes product boundaries, project/account isolation, privacy defaults, MCP gateway behavior, MCP transport, account/project governance and Local/Server deployment packaging.

EN: The machine-readable baseline lives in the `upstream` block of `vendor/manifest.json` (`repo`, `tag`, `commit`, `memoryServiceVersion`, `reviewedThrough`, `absorbed`); the selection rationale is in `docs/reviews/2026-10-19-upstream-review.md`.
中文：机器可读的基线记录位于 `vendor/manifest.json` 的 `upstream` 块（`repo`、`tag`、`commit`、`memoryServiceVersion`、`reviewedThrough`、`absorbed`）；取舍理由见 `docs/reviews/2026-10-19-upstream-review.md`。

## Replaying upstream changes through the LITSAN rename / 重放上游变更

EN: Apply an upstream diff to the recorded baseline first, then translate its paths and identifiers through `vendor/manifest.json` → `upstream.renameMap` (`paths`, `identifiers`, `prefixes`) before applying it here. The map describes source spelling, not a blanket replacement of stored data. Preserve upstream attribution, copyright and LICENSE bytes, format IDs, database names and stored enum values. Keep the compatibility helper and regression cases: `LITSAN_*` precedes `MEMMY_*` (including empty values); Core accepts both header prefixes; existing config keys and legacy homes remain readable. Generated integration scripts must carry the same compatibility logic as their source. Refresh component hashes with `node tests/vendor-manifest-e2e.mjs --refresh`, then build and run vendor regressions and context checks offline. The old sanitizer path remains a forwarding module for gateway deployments that have not yet adopted the new import.

中文：先在记录的基线上生成上游 diff，再按照 `vendor/manifest.json` 的 `upstream.renameMap`（`paths`、`identifiers`、`prefixes`）转换路径和标识符，最后应用到本仓库。映射只描述源码名称，不可对已存储数据进行全局替换。必须保留上游署名、版权与 LICENSE 原始字节，以及格式 ID、数据库名称和已存储枚举值。保留兼容辅助函数和回归用例：`LITSAN_*` 优先于 `MEMMY_*`（包括空值），Core 接受两种请求头，旧配置键与旧 home 仍可读取。生成的集成脚本必须携带与源码一致的兼容逻辑。使用 `node tests/vendor-manifest-e2e.mjs --refresh` 更新组件摘要，再离线构建并执行 vendor 回归与 context 检查。旧 sanitizer 路径保留转发模块，以兼容尚未更新导入路径的 gateway 部署。
