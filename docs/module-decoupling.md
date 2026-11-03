# Module decoupling / 模块解耦

- **Scope:** Phase 2 introduces contracts and ports; Phase 3 removes domain imports of the composition root; Phase 4 moves domain policy into core; Phase 5 splits MCP tool registration into shell modules; Phase 6 makes Archify projectors consume a ProjectModel built by the shell; Phase 7 splits contracts/core/Archify into composite projects — all without changing behavior, MCP tools/schemas/outputs or HTTP routes.
  **范围：** 第二阶段引入契约与端口；第三阶段移除领域模块对组合根的导入；第四阶段将领域策略迁入核心层；第五阶段将 MCP 工具注册拆分为外壳模块；第六阶段使 Archify 投影器只消费由外壳构建的 ProjectModel；第七阶段将 contracts／core／Archify 拆分为 composite 工程——均不改变行为、MCP 工具／模式／输出或 HTTP 路由。

- **Contracts (`src/contracts/`):** Pure types for identity, ProjectModel, project records/todos, branches, architecture inspection documents, context items and distilled artifact kinds. Original modules re-export moved types; `LitsanSourceContext` remains an alias.
  **契约层（`src/contracts/`）：** 身份、ProjectModel、项目记录／待办、分支、架构检查文档、上下文条目与蒸馏产物类别均为纯类型。原模块重导出迁移类型，`LitsanSourceContext` 保留为别名。

- **Core (`src/core/`):** Domain policy depends on contracts and read/write ports. Ports describe existing adapter methods; `runtime.ts` checks concrete adapters against them at compile time.
  **核心层（`src/core/`）：** 领域策略依赖契约与读写端口。端口描述现有适配器方法；`runtime.ts` 在编译时检查具体适配器是否满足端口。

- **Archify:** `architecture-cognitive-map.ts` and `memory-visualization.ts` parse/project models without shell or concrete storage imports. ProjectModel types live in contracts and the projectors take a ProjectModel (Phase 6).
  **Archify 层：** `architecture-cognitive-map.ts` 与 `memory-visualization.ts` 解析／投影模型，不导入外壳或具体存储模块。ProjectModel 类型位于契约层，投影器接收 ProjectModel（第六阶段）。

- **Shell + Memory Engine:** MCP/HTTP entry points and `runtime.ts` compose adapters. JSON registries, architecture storage and the local Memory Engine client remain concrete I/O adapters outside core.
  **外壳层与 Memory Engine：** MCP／HTTP 入口和 `runtime.ts` 负责组合适配器。JSON 注册表、架构存储与本地 Memory Engine 客户端仍是核心层之外的具体 I/O 适配器。

- **Project ports:** `ProjectReader` = resolve/list/suggest/storageIds; `ProjectWriter` = create/update/delete/merge/archive/unarchive/addTodo/setTodoStatus/updateDistilledDescription.
  **项目端口：** `ProjectReader` 提供解析／列表／建议／存储标识；`ProjectWriter` 提供创建／更新／删除／合并／归档／取消归档／添加待办／设置待办状态／更新蒸馏描述。

- **Branch ports:** `BranchReader` = list; `BranchWriter` = create/close/reopen.
  **分支端口：** `BranchReader` 提供列表；`BranchWriter` 提供创建／关闭／重新打开。

- **Architecture ports:** `ArchitectureReader` = getProjectArchitecture/inspectProjectArchitecture/inspectProjectCognitiveMap; `ArchitectureWriter` = writeProjectArchitecture/writeProjectCognitiveMap.
  **架构端口：** `ArchitectureReader` 提供架构读取／架构检查／认知地图检查；`ArchitectureWriter` 提供架构写入／认知地图写入。

- **Memory ports:** `MemoryViewerReader` = viewerGet; `MemoryViewerWriter` = viewerPost/viewerDelete; `TurnSessionWriter` = openSession/completeTurn; `MemoryDistiller` = distill. No ContextRouterPort is needed for this phase.
  **记忆端口：** `MemoryViewerReader` 提供查看；`MemoryViewerWriter` 提供提交／删除；`TurnSessionWriter` 提供会话打开／回合完成；`MemoryDistiller` 提供蒸馏。本阶段无需 ContextRouterPort。

- **Guard — contracts:** `tests/module-boundaries.mjs` recursively scans `.ts`, `.mts` and `.mjs` import/re-export/dynamic-import specifiers. Contracts allow only type imports from contracts and forbid `process.env`.
  **守卫——契约层：** `tests/module-boundaries.mjs` 递归扫描 `.ts`、`.mts`、`.mjs` 的导入／重导出／动态导入路径。契约层只允许从契约层导入类型，禁止 `process.env`。

- **Guard — core:** Core imports only contracts/core and forbids environment reads and Node I/O modules (including fs/http/https/net/child_process/sqlite). The documented type-only exception list is empty.
  **守卫——核心层：** 核心层仅导入契约层／核心层，禁止环境读取与 Node I/O 模块（包括 fs/http/https/net/child_process/sqlite）。已记录的仅类型导入例外清单为空。

- **Guard — shell/model:** Runtime importer allowlist is runtime.ts/mcp.ts/gateway-http.ts/index.ts and may only shrink. Archify/model modules forbid runtime/mcp/gateway-http/local-memory-client/project-registry/branch-store/capture*/distillation-jobs and Node fs/http; Node crypto remains allowed.
  **守卫——外壳／模型：** Runtime 导入白名单为 runtime.ts／mcp.ts／gateway-http.ts／index.ts，只能缩减。Archify／模型模块禁止上述外壳、具体存储、capture*、distillation-jobs 与 Node fs/http 导入；允许 Node crypto。

- **Phase 3:** Every former domain runtime importer declares its own `XxxDeps` using ports or `Pick`. Helper chains include dependencies they forward (capture recovery/ingestion, evidence validation, console reads/actions); callers still pass the structurally compatible runtime.
  **第三阶段：** 原先导入 Runtime 的每个领域模块均以端口或 `Pick` 声明自身 `XxxDeps`。辅助调用链涵盖其传递的依赖（捕获恢复／摄取、证据验证、控制台读写）；调用方继续传入结构兼容的 Runtime。

- **Compatibility:** Entry points `dist/mcp.js` / `dist/index.js`, existing module export names and adapter signatures stay stable. Phase 4 leaves re-export shims at moved paths and thin concrete adapters at governance/evidence paths; callers need no changes.
  **兼容性：** 入口 `dist/mcp.js`／`dist/index.js`、现有模块导出名称与适配器签名保持稳定。第四阶段在迁移路径保留重导出兼容层，在治理／证据路径保留薄适配器；调用方无需修改。

- **Next phases:** Phase 7 physical project splitting is implemented below; Windows build and release acceptance remain pending. Further package distribution changes are deferred.
  **后续阶段：** 第七阶段物理工程拆分已在下文实现；Windows 构建与发行验收仍待完成。进一步的包分发改动延后。

- **Platforms:** The contracts, ports and guard are shared by Ubuntu (@Server) and Windows (@Group); path comparisons normalize platform separators. Validation availability and remaining platform work are recorded in the review report.
  **平台：** Ubuntu（@Server）与 Windows（@Group）共用契约、端口和守卫；路径比较统一平台分隔符。验证可用性与未完成的平台工作记录于审查报告。

## Phase 4 / 第四阶段

- **Core areas and moves (paths relative to `src/`):** `project-scope.ts` → `core/scope/project-scope.ts`; `litsan-core.ts` → `core/retrieval/litsan-core.ts`; `retrieval-ranker.ts` → `core/retrieval/ranker.ts`; `core-interfaces.ts` → `core/retrieval/interfaces.ts`; `context-capsule.ts` → `core/context/context-capsule.ts`; `turn-knowledge-plan.ts` → `core/context/turn-knowledge-plan.ts`.
  **核心区域与迁移（路径相对于 `src/`）：** 作用域 `project-scope.ts` → `core/scope/project-scope.ts`；检索 `litsan-core.ts` → `core/retrieval/litsan-core.ts`、`retrieval-ranker.ts` → `core/retrieval/ranker.ts`、`core-interfaces.ts` → `core/retrieval/interfaces.ts`；上下文 `context-capsule.ts` → `core/context/context-capsule.ts`、`turn-knowledge-plan.ts` → `core/context/turn-knowledge-plan.ts`。

- **Lifecycle and governance:** Pure evidence helpers from `distillation-evidence.ts` and `distillationResultTimestamp` from `distillation-jobs.ts` → `core/lifecycle/evidence-refs.ts`; both evidence validators → `core/lifecycle/distillation-evidence.ts`; `project-governance.ts` / `architecture-governance.ts` → `core/governance/` with the same filenames. `context-router.ts`, capture/job I/O and architecture-history persistence remain shell adapters.
  **生命周期与治理：** `distillation-evidence.ts` 中的纯证据辅助函数及 `distillation-jobs.ts` 中的 `distillationResultTimestamp` → `core/lifecycle/evidence-refs.ts`；两个证据验证器 → `core/lifecycle/distillation-evidence.ts`；`project-governance.ts`／`architecture-governance.ts` → `core/governance/` 下同名文件。`context-router.ts`、捕获／任务 I/O 和架构历史持久化保留在外壳适配层。

- **New ports and contracts:** `DistillationJobReader` (`core/ports/distillation.ts`) injects job reads; `CaptureEvidenceReader` (`core/ports/memory.ts`) injects capture evidence reads; `ArchitectureRevisionStore` (`core/ports/architecture.ts`) injects revision preparation/commit. `contracts/retrieval.ts` holds RecallHit and cross-layer ranking/recall diagnostics; `contracts/distillation.ts` holds job/evidence types; `contracts/capture.ts` holds source kinds and the capture evidence projection; `contracts/architecture.ts` also holds ArchitectureRevisionRecord. ProjectDescriptor already lives in `contracts/projects.ts`.
  **新增端口与契约：** `DistillationJobReader`（`core/ports/distillation.ts`）注入任务读取；`CaptureEvidenceReader`（`core/ports/memory.ts`）注入捕获证据读取；`ArchitectureRevisionStore`（`core/ports/architecture.ts`）注入修订准备／提交。`contracts/retrieval.ts` 承载 RecallHit 与跨层排名／召回诊断；`contracts/distillation.ts` 承载任务／证据类型；`contracts/capture.ts` 承载来源类别与捕获证据投影；`contracts/architecture.ts` 新增 ArchitectureRevisionRecord。ProjectDescriptor 已位于 `contracts/projects.ts`。

- **Shim/adapter policy:** The six whole-module moves retain pure re-export shims. `project-governance.ts`, `architecture-governance.ts` and `distillation-evidence.ts` inject concrete functions and re-export core types/helpers while preserving their public signatures. Existing job, capture, history and memory-source modules re-export extracted types/helpers.
  **兼容层／适配器策略：** 六个完整模块迁移保留纯重导出兼容层。`project-governance.ts`、`architecture-governance.ts` 与 `distillation-evidence.ts` 注入具体函数并重导出核心类型／辅助函数，保留公开签名。现有任务、捕获、历史和 memory-source 模块重导出提取出的类型／辅助函数。

- **New guard rules and unit checks:** `movedShims` accepts only comments, blank lines and core/contracts re-exports; `coreAdapters` requires core imports and rejects exported functions absent from the corresponding core module; `requiredCoreAreas` requires TypeScript in scope/retrieval/context/lifecycle/governance and may only grow. Core permits only `node:crypto` among Node builtins, including a ban on `node:path`/`node:url`. `context:check` runs `node --test tests/core-units.mjs` immediately after the boundary guard; in-memory fakes cover scope, retrieval, context/TKP, evidence and governance authorization/fences without services.
  **新增守卫与单元检查：** `movedShims` 仅允许注释、空行及核心／契约重导出；`coreAdapters` 要求核心导入，拒绝对应核心模块中不存在的导出函数；`requiredCoreAreas` 要求 scope／retrieval／context／lifecycle／governance 包含 TypeScript，清单只能增加。核心层的 Node 内建模块仅允许 `node:crypto`，包括禁止 `node:path`／`node:url`。`context:check` 在边界守卫之后立即运行 `node --test tests/core-units.mjs`；内存 fake 无需服务即可覆盖作用域、检索、上下文／TKP、证据及治理授权／围栏。

## Phase 5 / 第五阶段

- **Register modules:** The 11 MCP tools moved from `src/mcp.ts` into `src/shell/mcp/`: `register-result.ts` (litsan_result), `register-turn.ts` (litsan_turn), `register-context.ts` (litsan_context), `register-memory.ts` (litsan_memory), `register-branch.ts` (litsan_branch), `register-skill.ts` (litsan_skill), `register-distill.ts` (litsan_distill), `register-projects.ts` (litsan_project_list, litsan_todo, litsan_project_manage, litsan_project). `shared.ts` holds argument parsing, result serialization and project projection helpers plus the `ToolContext` type.
  **注册模块：** 11 个 MCP 工具从 `src/mcp.ts` 迁入 `src/shell/mcp/`：`register-result.ts`（litsan_result）、`register-turn.ts`（litsan_turn）、`register-context.ts`（litsan_context）、`register-memory.ts`（litsan_memory）、`register-branch.ts`（litsan_branch）、`register-skill.ts`（litsan_skill）、`register-distill.ts`（litsan_distill）、`register-projects.ts`（litsan_project_list、litsan_todo、litsan_project_manage、litsan_project）。`shared.ts` 承载参数解析、结果序列化、项目投影辅助函数及 `ToolContext` 类型。

- **Deps:** Each module exports `register<Area>Tools(server, deps)` and its own `<Area>ToolDeps = { runtime, context }`, where `runtime` is an intersection of ports, `Pick`s and the existing `XxxDeps` of the functions it calls (e.g. `TurnLogDeps & ContextRouterDeps`); `litsan_result` receives only `Pick<JsonResultTransport, "read">`. None imports `runtime.ts`; TypeScript checks that the concrete runtime satisfies every Deps where `mcp.ts` passes it.
  **依赖：** 每个模块导出 `register<Area>Tools(server, deps)` 及其自身的 `<Area>ToolDeps = { runtime, context }`，其中 `runtime` 由端口、`Pick` 与被调用函数已有的 `XxxDeps`（如 `TurnLogDeps & ContextRouterDeps`）交叉组成；`litsan_result` 只接收 `Pick<JsonResultTransport, "read">`。所有模块均不导入 `runtime.ts`；`mcp.ts` 传参处由 TypeScript 检查具体 runtime 满足各 Deps。

- **Entry:** `src/mcp.ts` (1520 → 185 lines) keeps the exports, CLI, McpServer construction and self-run block, builds `ToolContext` once and calls the register functions in the original tool order, so `tools/list` and `tests/fixtures/p6-md-surface.json` are unchanged. `dist/mcp.js` and `src/index.ts` are unchanged.
  **入口：** `src/mcp.ts`（1520 → 185 行）保留导出、CLI、McpServer 构造与自启动代码块，只构建一次 `ToolContext`，并按原工具顺序调用注册函数，因此 `tools/list` 与 `tests/fixtures/p6-md-surface.json` 不变。`dist/mcp.js` 与 `src/index.ts` 不变。

- **Guard:** `tests/module-boundaries.mjs` now requires `shell/mcp` to contain register modules (list may only grow), each exporting `register*Tools`; forbids `shell/**` from importing `runtime` or `mcp` and register modules from importing each other; forbids `registerTool(` in `mcp.ts`; and caps `mcp.ts` at `mcpEntryMaxLines = 190` (may only decrease). The runtime allowlist stays runtime.ts/mcp.ts/gateway-http.ts/index.ts because `mcp.ts` still composes the runtime.
  **守卫：** `tests/module-boundaries.mjs` 现要求 `shell/mcp` 含注册模块（清单只能增加）且每个模块导出 `register*Tools`；禁止 `shell/**` 导入 `runtime` 或 `mcp`，禁止注册模块相互导入；禁止 `mcp.ts` 中出现 `registerTool(`；并以 `mcpEntryMaxLines = 190` 限制 `mcp.ts` 行数（只能减少）。由于 `mcp.ts` 仍负责组合 runtime，Runtime 白名单保持 runtime.ts／mcp.ts／gateway-http.ts／index.ts。

## Phase 6 / 第六阶段

- **ProjectModel contract:** `src/contracts/project-model.ts` adds `ProjectModel` (`projectId`, `l2`, `revisions: ProjectModelL2Revision[]`, `architecture: { map, fingerprint }`, `todos: ProjectModelTodo[]`) — the canonical read model handed to Archify projectors. `src/contracts/project-map.ts` now holds `MemoryVisualizationPayload` and the `ProjectState*` types; `memory-visualization.ts` re-exports them under the same names.
  **ProjectModel 契约：** `src/contracts/project-model.ts` 新增 `ProjectModel`（`projectId`、`l2`、`revisions: ProjectModelL2Revision[]`、`architecture: { map, fingerprint }`、`todos: ProjectModelTodo[]`），即交给 Archify 投影器的规范读模型。`src/contracts/project-map.ts` 现承载 `MemoryVisualizationPayload` 与 `ProjectState*` 类型；`memory-visualization.ts` 以同名重导出。

- **Projectors:** `projectMemoryVisualization(model: ProjectModel)` is the primary projector; `buildMemoryVisualization(input)` keeps its old signature as a thin wrapper that maps to a ProjectModel (byte-identical output). `architecture-cognitive-map.ts` is unchanged and already imports only contracts and `node:crypto`.
  **投影器：** `projectMemoryVisualization(model: ProjectModel)` 为主投影器；`buildMemoryVisualization(input)` 保留旧签名，作为映射为 ProjectModel 的薄包装（输出逐字节一致）。`architecture-cognitive-map.ts` 未改动，本已只导入契约层与 `node:crypto`。

- **Shell builder:** `src/shell/archify/project-model.ts` exports `buildProjectModel(deps, input)` with `ProjectModelBuilderDeps` (accountId, `Pick<ProjectReader,"storageIds">`, `Pick<ArchitectureReader,"inspectProjectCognitiveMap">`). It turns completed L2 distillation jobs of the project's storage ids into revisions (`l2:<result_id>:<job_id>`) and reads the cognitive map. `memory-control-plane.ts` fetches the L2 payload and todos, builds the model, then calls the projector; the HTTP response is unchanged.
  **外壳构建器：** `src/shell/archify/project-model.ts` 导出 `buildProjectModel(deps, input)` 及 `ProjectModelBuilderDeps`（accountId、`Pick<ProjectReader,"storageIds">`、`Pick<ArchitectureReader,"inspectProjectCognitiveMap">`）。它把属于项目存储 id 的已完成 L2 蒸馏任务转换为修订（`l2:<result_id>:<job_id>`）并读取认知地图。`memory-control-plane.ts` 获取 L2 载荷与待办，构建模型后调用投影器；HTTP 响应不变。

- **Guard:** `archifyProjectors` (may only grow) replaces the old denylist: projectors may import only `contracts/`, `core/` or `node:crypto` and may not read `process.env`. `requiredShellAreas` adds `shell/archify` (must contain TypeScript); `shell/archify` modules may not import `memory-control-*` or `web-ui`. The summary line prints the projector count.
  **守卫：** `archifyProjectors`（只能增加）取代旧的禁止清单：投影器只能导入 `contracts/`、`core/` 或 `node:crypto`，且不得读取 `process.env`。`requiredShellAreas` 新增 `shell/archify`（须包含 TypeScript）；`shell/archify` 模块不得导入 `memory-control-*` 或 `web-ui`。汇总行输出投影器数量。

- **Tests:** `tests/archify-units.mjs` (run by `context:check` right after `core-units.mjs`) uses ProjectModel fixtures and in-memory port fakes from `tests/fakes/project-model-fakes.mjs`: empty/no-project payload, L2 timeline and revisions, architecture links, wrapper/projector equivalence, cognitive-map parse/fingerprint/evidence/markdown, and builder job filtering.
  **测试：** `tests/archify-units.mjs`（由 `context:check` 在 `core-units.mjs` 之后运行）使用 `tests/fakes/project-model-fakes.mjs` 中的 ProjectModel fixture 与内存端口 fake，覆盖空／无项目载荷、L2 时间线与修订、架构关联、包装函数与投影器等价、认知地图解析／指纹／证据／Markdown，以及构建器的任务过滤。

## Phase 7 / 第七阶段

- **Layout and names:** `src/contracts/`, `src/core/` and `src/archify/` are composite projects named `@phsanqi/litsan-contracts`, `@phsanqi/litsan-core` and `@phsanqi/litsan-archify`. All other source files form the root `litsan` shell project. Child package manifests are private ESM metadata for the guard, never copied to `dist/`.
  **布局与名称：** `src/contracts/`、`src/core/` 与 `src/archify/` 是 composite 工程，名称分别为 `@phsanqi/litsan-contracts`、`@phsanqi/litsan-core` 与 `@phsanqi/litsan-archify`。其余源码组成根 `litsan` 外壳工程。子包清单为守卫使用的私有 ESM 元数据，不复制到 `dist/`。

- **Direction:** contracts has no references; core references contracts; Archify references contracts and core; shell references all three. Project references enforce compilation boundaries. All Archify source imports are limited to contracts/core/archify or `node:crypto`, with no environment reads. The ProjectModel builder stays in `shell/archify/`.
  **方向：** contracts 无引用；core 引用 contracts；Archify 引用 contracts 与 core；外壳引用三者。工程引用强制执行编译边界。所有 Archify 源码仅可导入 contracts／core／archify 或 `node:crypto`，禁止环境读取。ProjectModel 构建器保留在 `shell/archify/`。

- **Build:** All four projects share `tsconfig.base.json`; shell is also composite and keeps `rootDir: src` plus `allowJs`. Build runs `clean-dist.mjs` then `tsc -b tsconfig.json`; typecheck also uses build mode and may emit. Incremental state lives in ignored `.tsbuild/`; cleaning removes both generated `dist/` and `.tsbuild/`, ensuring repeated clean builds emit everything.
  **构建：** 四个工程共用 `tsconfig.base.json`；外壳也启用 composite，保留 `rootDir: src` 与 `allowJs`。构建先运行 `clean-dist.mjs`，再运行 `tsc -b tsconfig.json`；类型检查同样采用构建模式，可能生成产物。增量状态位于被忽略的 `.tsbuild/`；清理同时移除生成的 `dist/` 与 `.tsbuild/`，确保重复干净构建完整输出。

- **Entry stability:** The two top-level Archify paths are pure re-export shims; `dist/mcp.js`, `dist/index.js` and all 98 retained baseline JS paths remain stable. The untouched build had 99 paths; only unused `dist/core/archify/architecture-graph.js` was removed under the specification's exception, with its implementation now at `dist/archify/architecture-graph.js`. No tests or scripts import the old graph path; no core-to-Archify shim is introduced.
  **入口稳定：** 两个顶层 Archify 路径成为纯重导出兼容层；`dist/mcp.js`、`dist/index.js` 及保留的全部 98 个基线 JS 路径保持稳定。未修改构建有 99 个路径；按规格例外仅移除未被使用的 `dist/core/archify/architecture-graph.js`，实现现位于 `dist/archify/architecture-graph.js`。测试与脚本均未导入旧图路径；不引入 core 到 Archify 的兼容层依赖。

- **Memory Engine:** `vendor/memory-core` remains the fifth unit and a separate package/process. Vendor imports are forbidden in contracts/core/Archify; shell access is limited to `local-memory-client.ts` and `embedded-memory-core.ts`, with the existing `distillation-contract.ts` sanitizer URL import recorded as a legacy exception that may only shrink.
  **Memory Engine：** `vendor/memory-core` 保持为第五个单元及独立包／进程。contracts／core／Archify 禁止 vendor 导入；外壳访问限于 `local-memory-client.ts` 与 `embedded-memory-core.ts`，现有 `distillation-contract.ts` 清洗器 URL 导入记录为只能缩减的历史例外。

- **Guard:** Existing Phase 2–6 rules remain. `requiredPackages` may only grow; manifests and exact project references/internal dependencies must match the direction table. The scanner recognizes URL-based dynamic imports, checks all Archify source files, and verifies `tests/fixtures/p7-dist-paths.json` after builds (with an explicit skip when `dist/` is absent). Unit checks compare every runtime shim export with its `dist/archify/` counterpart and import the relocated graph directly.
  **守卫：** 保留第二至六阶段规则。`requiredPackages` 只能增加；清单及工程引用／内部依赖必须精确匹配方向表。扫描器识别基于 URL 的动态导入，检查所有 Archify 源文件，并在构建后验证 `tests/fixtures/p7-dist-paths.json`（`dist/` 不存在时明确提示跳过）。单元检查比较兼容层与 `dist/archify/` 的全部运行态导出，并直接导入迁移后的图模块。

- **npm:** Packaging still copies `dist/`; no new runtime dependency, npm workspace or installation change is introduced. Internal package manifests and `.tsbuild/` are not shipped. Runtime output adds `dist/archify/` and drops only the unused graph path described above.
  **npm：** 打包仍复制 `dist/`；不增加运行态依赖、npm workspace 或安装改动。内部包清单与 `.tsbuild/` 不进入发行包。运行态产物新增 `dist/archify/`，仅移除上述未使用图路径。

- **Windows:** Shared build configuration and separator-normalized guard apply to Ubuntu (@Server) and Windows (@Group), without new symlinks or junctions. Status is **局部完成**: Linux validation is available here; Windows build/release validation is unavailable on this host and remains pending. There is no intended platform behavior difference to unify; the risk is unverified Windows toolchain behavior, requiring the same clean-build, guard and runtime checks on @Group before platform acceptance.
  **Windows：** 共用构建配置与统一路径分隔符的守卫适用于 Ubuntu（@Server）及 Windows（@Group），不新增软链或 junction。状态为 **局部完成**：本机可进行 Linux 验证，无法进行 Windows 构建／发行验证，后者仍待完成。无需要统一的预期平台行为差异；风险是 Windows 工具链行为尚未验证，双平台验收前需在 @Group 执行同样的干净构建、守卫与运行态检查。
