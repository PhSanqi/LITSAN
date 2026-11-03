# Control Plane and distillation

## Product taxonomy

The management surface exposes durable memory, project-map and processing state as:

```text
Overview / Projects / L1 / L2 / L3 / L4 / Global State / Skills / Project Map / Processing
```

L1 is raw/auditable turn evidence. L2 is project chronology. L3 is durable project rules/experience. L4 is account-wide durable profile/rules. Skill is an orthogonal reusable procedure layer.

Global State is an account-scoped derived sidecar for explicit `keep_global` L1 evidence. It is **not** L2, L4, or a fifth numbered memory layer. It keeps a compact current-state snapshot, recent transitions, and non-authoritative profile signals for information that legitimately belongs to the person/account but not to one durable project. Unresolved routing never falls into Global State automatically: a turn enters this path only after an explicit `keep_global` decision. L4 remains the stable cross-project profile; Global State is lower-authority supporting context and does not directly promote one-off state into L4.

Project Map is not a memory layer. It is a disposable UI/export projection that combines canonical L2 chronology with the derived Project Architecture Cognitive Map. L2 remains the chronology source of truth; the map remains derived structural context.

A first Architecture Cognitive Map (or an explicit rebuild) may be produced through `litsan_project map_bootstrap_next/submit`, citing exact Hard Architecture document refs and L2 revision refs. The same candidate validation and fingerprint fence apply. Its derived authority is unchanged, and it is never promoted to a Hard Architecture Contract.

## Runtime topology

One LITSAN installation has one Memory Core and one MCP runtime:

```text
Memory Core        127.0.0.1:18960
     ^
     |
LITSAN MCP runtime 127.0.0.1:3001/mcp
```

Local clients connect directly to loopback. A Server deployment may expose the same MCP runtime through Cloudflare Access/Tunnel or another authenticated reverse proxy. Local and remote clients therefore use one tool schema, one control state and one Memory Core.

## L1 turn contract

`litsan_turn` is the model-facing L1 lifecycle:

- `open` records the user turn;
- `checkpoint` may store bounded audit-safe reasoning/tool summaries;
- `commit` records the assistant final and completes the turn;
- `failed` / `truncated` preserve terminal incomplete state;
- `resume` is an explicit continuity read when the caller provides a stable continuity/conversation key.

Project scope is explicit current-turn evidence. A host session identifier is not a routing key. When no stable host conversation ID exists, the MCP layer uses an event-scoped internal storage key so the durable capture schema can remain backward-compatible without creating a binding.

Memory Core still requires a session envelope for its write API, but LITSAN creates that envelope deterministically from `account_id + L1 event_id`. Each L1 event therefore has its own Core session; host conversation/continuity identifiers do not group Core writes or distillation batches.

## Project resolution

The routing order is:

```text
explicit project/workspace
  > exact registered alias
  > unique semantic project candidate
  > global-only
```

Conflicting or unknown current-turn project evidence fails closed to global-only. Business memory and Project Architecture are recalled only from the one resolved primary project. Cross-project retrieval is limited to explicit reusable Skills.

`litsan_project` does not bind or unbind conversations. It provides project listing/current explicit scope plus Project Architecture read/plan/execute/history. Project create/update/delete/merge governance remains in `litsan_project_manage`.

## Branch Context

`litsan_branch` manages project-local workstreams through `list`, `create`, `close`, `reopen` and `retag`. A Branch narrows retrieval within the resolved Project; it never broadens Project scope, does not duplicate L1, and never writes L3/L4.

Workstream branches are enabled per project (default off). When enabled, a conversation is bound to a Branch only through an explicit `workstream` hint on `litsan_turn open` and `litsan_context` (`git_branch`, `worktree`, `continuity_id`, `label`). LITSAN derives one stable key in the order non-default `git_branch` > `worktree` path > explicit `continuity_id`, and finds or creates an `active` auto Branch for it. A `continuity_id` key creates a Branch only on its second turn. At most 8 auto Branches are active per project; creating another closes the most idle one. No hint, the default git branch, or a disabled project means `main`, which behaves exactly as before. A Branch is never guessed, and a host session or conversation identifier alone never selects one.

Each L1 event records its `branch_id`. A wrong binding is corrected with a logged `retag` that moves only undistilled events. At fork time a Branch records `base_map_fingerprint` and `base_l2_revision`.

Inside a Branch, `litsan_context` returns `main` distilled truth (L2/L3/L4, Architecture and map), that Branch's own undistilled L1, and an `in_flight` block. The `in_flight` block lists at most 5 other open Branches (name, goal, last activity, touched map nodes) and is built deterministically from Branch records, never from raw turns. Other Branches' turns and drafts are never recalled as content. In `main`, retrieval is unchanged apart from the same `in_flight` block.

## Distillation jobs

`litsan_distill` is the semantic distillation work queue. `action=next` leases evidence to the connected Harness/model; the Harness then calls `submit` or `skip`. LITSAN validates account/project scope, evidence references, canonical artifact identity and lease ownership before commit.

### L1 -> L2

Discovery scans complete, ingested, project-resolved L1 evidence and groups unconsumed events by account + canonical project. Host conversations do not partition a batch. Threshold/idle policy decides when a project batch is ready.

Staged (workstream branches phase 2): for a project with branches enabled, grouping becomes account + canonical project + Branch, so each Branch gets non-interleaved jobs. Accepted L2 events of a non-`main` Branch form a Branch draft that reaches main L2 only through a merge (date-ordered append with `Branch:` provenance). Phase 3 adds a map delta against `base_map_fingerprint`, a deterministic 3-way merge, and `branch_merge` cards only for real conflicts. L3 is enqueued only from main L2 revisions. For `main` and disabled projects, grouping stays account + canonical project. Disabling the flag stops new branch grouping; existing branch jobs retain their draft routing, and background sweeps and merges continue to drain existing drafts. Close and cap eviction enter `closing`; merges serialize per project through a derived L2 job, lease and normal submit. Idle branches close after 3 days. Cap eviction only schedules closing; turn binding never waits for a merge. New activity cancels closing while preserving the base and draft. Each sweep tries merging before expiry, and only a still-blocked closing branch expires after 14 days from max(last activity, closing since); its draft is archived without deletion. Failed branch jobs are terminal, recorded in failed_job_ids, and excluded from merge sources. Merged events remain in a historical prefix (merged_event_count); retrieval and the next merge use only the fresh segment. Append jobs carry an exact L2 base through the same evidence envelope as restructure jobs, and hash the branch, base ref, normalized event contents and sorted source ids. A changed base supersedes an unsubmitted candidate; ambiguous external commits retain the frozen-candidate reconciliation fence. Map deltas and conflict cards remain phase 3.

中文：阶段 2 按分支发现 L2 任务，分支事件先进入草稿，仅经带 `Branch:` 来源的日期排序追加进入 main。关闭开关后停止新增分支分组；已有分支任务保持草稿路由，后台扫描和合并继续排空已有草稿。关闭和上限逐出先进入 `closing`，每项目串行合并，经派生 L2 任务、租约和正常提交写入 main，只有 main 修订触发 L3。空闲 3 天关闭。上限逐出仅置 closing，turn 绑定不等待合并；新活动取消关闭并保留基线与草稿。扫描先尝试合并，仅仍受阻且从 max(最后活动时间, closing_since) 起满 14 天的 closing 分支才过期归档，不删除内容。失败任务记入 failed_job_ids，但不作为合并证据源。merged_event_count 划分保留的历史前缀，检索与下一次合并只使用新段。追加任务复用 restructure 的精确 L2 基线证据路径，哈希包含分支、基线引用、规范化事件内容和排序后的源任务编号。基线变化后替换尚未提交的旧候选；外部提交结果不明时保留冻结候选的对账保护。地图增量与冲突卡保留到阶段 3。

An L2 lease also exposes the current Architecture Cognitive Map plus its exact fingerprint. The Harness may omit a map update when the evidence changes chronology without changing structural understanding. When structure does change, the Harness submits the complete current map together with the L2 candidate and the fingerprint it read. LITSAN validates hierarchy, stable references, evidence provenance, confidence and the revision fence before persisting the map as a separate Project Architecture sidecar. A sidecar write failure is reported separately and never turns an already-durable L2 Core write into a failed memory commit.

The Cognitive Map stops at method/mechanism level and may link an L2 event to affected architecture nodes. It does not contain function/file/API-detail graphs; repository-analysis tools may supply such details only as evidence for semantic lifting.

### L1 -> Global State

Complete, ingested L1 evidence whose current governed routing is explicitly `keep_global` is eligible for a separate account-scoped Global State queue. Missing/unknown project evidence remains unresolved and is never silently reclassified as global. Synthetic automation prompts that add no user-authored fact are terminal routing evidence but are omitted from Global State content.

Global State uses one canonical account artifact with exact immutable revision refs (`global_state:<artifact-id>:<job-id>`). Jobs are serialized: only one account Global State synthesis may be pending/leased at a time, and each later job carries the exact completed Global State revision as its base plus newly admitted L1 refs. The Harness submits a complete bilingual replacement with `Current State Snapshot / 当前状态快照`, `Recent Transitions / 近期变化`, and `Profile Signals / 画像信号`. The revision is committed in the LITSAN distillation ledger rather than being encoded as a fake null-project L2 or a new Memory Core numbered layer.

Retrieval exposes Global State in a distinct bounded `globalState` lane. `globalMemory` remains L4 only. Project turns may receive the derived Global State artifact as supporting account context; global-only turns may additionally receive a very small number of fresh explicit-global L1 turns that have not yet been claimed by a Global State job. Stable authority remains: explicit current user evidence > L4 / project L3 Current Truth > derived Global State > older Global State / raw L1.

### L2 -> L3

Completed L2 evidence can derive a project-scoped L3 job. L3 contains durable project rules, preferences, constraints and learned operating patterns rather than a transcript replay.

### L3 -> L4

L4 is account-scoped and synthesizes durable cross-project evidence. It must preserve evidence provenance and must not infer sensitive traits without appropriate evidence and governance.

Global State does not change this production promotion rule. A future separately governed promotion path may admit repeated independent direct-user Global State signals or explicit user confirmation into L4, but a single state observation, automation/tool result, or temporary condition is never sufficient by itself.

### Skill

Skill stores reusable procedures. `litsan_context` returns compact Skill candidates; `litsan_skill action=load` hydrates the selected procedure and `action=record` stores execution telemetry. Skill revision/retirement uses explicit plan/execute governance.

## Canonical artifacts and evidence

Durable derived artifacts use stable identities and immutable revision evidence references. When `litsan_context` returns an exact L2/L3/L4 `evidenceRef`, downstream tools pass that reference unchanged instead of reconstructing a reference from a stable memory ID.

The connected Harness/model is the semantic executor. The LITSAN server schedules, validates and persists; it does not silently invoke a subscription model session from the background.

The Architecture Cognitive Map has a separate canonical derived identity inside Project Architecture. Every map node, relation and timeline link must cite exact evidence admitted by the current L2 job or evidence already retained by the previous map revision. The map therefore remains auditable without becoming an L1-L4 artifact.

## Automatic processing

Automatic distillation is opt-in. Enabling it records an ingestion-time cutover so existing history is not unexpectedly reprocessed. Discovery is idempotent: evidence already claimed by an existing job is not silently duplicated. Queueing failure is reported separately from successful L1 ingestion and can be reconciled later.

Crash recovery uses durable L1 evidence plus the ingest intent/marker. It does not require a registered device record. Ambiguous legacy evidence without a trustworthy intent remains a review case rather than being guessed into Core.

New L1 files persist the submitting Harness as `actor_id`. The reader accepts historical `device_id` only as a migration-compatible alias and normalizes it to `actor_id`; there is no current device registry or device-token authority behind that field.

## Process ownership

Linux current installs use:

```text
memhub-core.service
memhub.service
memhub-stack.target
```

Windows/direct installs use one `scripts/run-stack.mjs --home <state-root>` owner for Core + MCP runtime. The singleton lock is `.memhub-stack.lock` and configuration is `memhub.env`. Readiness is checked on real loopback health endpoints. Child failure triggers bounded group recovery; stop/status operate only on a verified owner.

## Control Plane invariants

The browser Control Plane and MCP tools must enforce the same state rules. In particular:

- project deletion is blocked while unfinished distillation work references it;
- project merge preserves historical storage aliases/evidence instead of rewriting provenance;
- Todo state lives in Project Registry, not duplicated into L3 or Project Architecture;
- Project Architecture full replacement requires plan -> explicit approval -> execute and keeps revision history;
- the derived Architecture Cognitive Map is stored separately from the governed hard Architecture Contract, uses fingerprint-fenced full-map replacement, and may never be promoted to authoritative constraints merely because a model inferred it;
- Project Map timeline links may identify an affected architecture node/level/change kind, but chronology adjacency alone is not treated as causality;
- direct L3/L4 governance requires explicit user confirmation evidence;
- explicit `keep_global` is a resolved routing decision and feeds only the account Global State sidecar; unresolved evidence remains fail-closed and is not treated as global;
- Global State is supporting account context below L4/project L3 authority, is serialized through exact revision bases, and does not directly promote one-off observations into L4;
- L3/L4 are derived only from `main`; Branch drafts are not Current Truth until merged, and abandoned Branches are archived, never deleted;
- ambiguous project scope never falls back to a remembered chat binding.

## Transport and content boundaries

MCP is the only model/tool ingress. Large tool results use progressive result/evidence transport rather than a separate proxy process. `litsan_context` applies bounded context budgets and progressive disclosure; `litsan_memory action=load` hydrates selected exact revisions.

The durable L1 schema still contains historical conversation/continuity fields for compatibility and explicit resume provenance. Those fields alone are not Project state and are not an L1 -> L2 grouping key. An explicit `continuity_id` inside a `workstream` hint may select a Branch (see Branch Context); grouping then follows the recorded `branch_id`, not the continuity field.

## Legacy state

Historical runtime/configuration artifacts may remain only inside protected recovery evidence. They are not loaded as current runtime authority.
