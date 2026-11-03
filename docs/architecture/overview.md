# LITSAN architecture

LITSAN is a self-hosted account/project memory control layer exposed through one MCP runtime. The authoritative runtime topology is intentionally small:

```text
Local client ───────────────> 127.0.0.1:3001/mcp ──┐
                                                   ├─ LITSAN MCP Runtime ─> Memory Core :18960
Remote client -> Cloudflare -> 127.0.0.1:3001/mcp ─┘
```

Cloudflare is an authenticated transport boundary, not a second LITSAN implementation. Local and remote callers use the same tool schema, project registry, L1 evidence, distillation jobs and Memory Core.

## Durable memory model

```text
L1 original turn evidence
        |
        v
L2 project timeline
        |
        v
L3 project durable profile
        |
        v
L4 account-wide durable profile

Skill  = orthogonal reusable capability
Todo   = project registry state
Branch = explicit project-local workstream scope
```

- L1 is append-oriented source evidence. `litsan_turn open/checkpoint/commit` is the normal write contract.
- L2 is canonical project chronology.
- L3 is canonical project-scoped durable rules, preferences and experience.
- L4 is canonical account-scoped durable profile supported by cross-project evidence.
- Skill is a separately governed reusable procedure.
- Todo and Branch are control concepts, not memory layers.

A first Architecture Cognitive Map (or an explicit rebuild) may be produced through `litsan_project map_bootstrap_next/submit`, citing exact Hard Architecture document refs and L2 revision refs. The same candidate validation and fingerprint fence apply. Its derived authority is unchanged, and it is never promoted to a Hard Architecture Contract.

## Identity and transport

The product user boundary is the stable LITSAN `account_id`. A model, host application, OS, connection and transport are provenance only.

- Loopback MCP uses the explicitly configured local account.
- Remote MCP validates Cloudflare identity and resolves it to the same LITSAN account model.
- Client-supplied account identity is never trusted as authorization.
- Different `account_id` values are strict tenant boundaries across Project Registry/Todos, L1 evidence, L2/L3/L4, Skills, Branches, Architecture and distillation state. Ordinary users cannot select another account; cross-account administration is Admin-only.
- Host conversation/session identifiers may be retained as historical provenance, but they do not select project or distillation scope. They select a Branch only when passed explicitly as `continuity_id` in a `workstream` hint.

## Project routing

Project scope is resolved from current-turn evidence only:

1. explicit `project` / authenticated namespace;
2. explicit `workspace_project`;
3. exact registered alias;
4. one unambiguous semantic candidate;
5. otherwise global-only recall.

LITSAN does not persist conversation-to-project routing. If project and workspace evidence conflict, the operation fails closed rather than guessing.

Branch is also explicit. `litsan_branch` manages `create/list/close/reopen/retag`; `litsan_context` receives a Branch id/name, or a `workstream` hint (`git_branch` > `worktree` > `continuity_id`) from which LITSAN derives an auto Branch when the project has workstream branches enabled. No hint means `main`. Branches are never guessed.

## MCP runtime responsibilities

The runtime owns:

- authentication and account resolution;
- Project Registry, Todo and Branch metadata;
- L1 turn storage and ingest idempotency;
- Context Router and bounded retrieval;
- Skill selection/telemetry;
- L2/L3/L4 distillation job control and evidence validation;
- Project Architecture governance;
- Control Plane HTTP views;
- MCP result chunking for large responses.

Memory Core owns durable memory storage/search/read models. The connected Harness/model owns semantic synthesis. LITSAN validates scope, evidence and revision fences; it does not invent semantic conclusions when no model executor is present.

## L1 durability

The authoritative L1 body is stored as per-event JSON under the LITSAN state root. `capture-index.sqlite` is a rebuildable index used for pagination, project filtering, counts and scheduling. The historical field names remain storage compatibility details; they are not a second HTTP ingestion API.

Core ingestion uses stable event-derived request ids. If a process dies after Core commits but before the local marker or downstream queue update, recovery replays the same deterministic request and then reconciles the durable marker/job state. This behavior is covered by the real two-process stack smoke test.

## Distillation

Automatic distillation groups complete, ingested L1 evidence by account + project, not by host conversation. L2 completion may enqueue L3. L3 can contribute to L4 only through exact, validated project evidence.

L2 remains the canonical project chronology, but one L2 semantic pass may also return a separate **Project Architecture Cognitive Map** when the supplied evidence materially changes structural understanding. This is an orthogonal Project Architecture artifact, not an additional memory layer and not a second chronology. The map is a complete evidence-backed structural model with stable node IDs and the abstraction ladder:

```text
Project
  -> Domain / Layer
    -> Capability / Subsystem
      -> Process / Flow
        -> Method / Mechanism
```

`Method / Mechanism` is the intentional cutoff. Functions, API parameters, concrete files and code remain implementation evidence for the Harness to inspect on demand rather than permanent nodes in the human-facing project mental model.

Timeline events may reference the architecture nodes they changed together with the architecture level, change kind (`add`, `refine`, `replace`, `remove`, or `reroute`), exact evidence refs and model confidence. These links support two projections from the same evidence: chronology can highlight the architecture surface affected by a change, while an architecture node can expose its L2 evolution history. Temporal adjacency alone is never treated as causal proof.

Explicit user-authored L3/L4 mutation is separate from automatic distillation: `litsan_memory plan` produces the complete resulting body, the user approves that exact text, the confirmation is captured as L1, and `execute` commits only if the base revision and confirmation evidence are still valid.

## Project Architecture

Project Architecture is stable structural context: ownership, source-of-truth declarations, interfaces and hard constraints. The writable canonical document lives in LITSAN private state. Repository Markdown and legacy architecture sources may be read as migration/context inputs but are never silently mutated.

`litsan_project architecture_plan -> explicit approval -> architecture_execute` performs a full-document replacement with fingerprint fencing and revision history.

Project Architecture has two different authority classes:

- **Hard Architecture Contract** — authoritative ownership, boundaries, interfaces, source-of-truth declarations and hard constraints. It is changed only through the governed full-document `architecture_plan -> explicit approval -> architecture_execute` path.
- **Architecture Cognitive Map** — derived, evidence-backed project mental model used for navigation, explanation and Archify projections. It is stored separately with its own fingerprint fence, carries evidence/confidence on every node/relation/evolution link, and may be refreshed during L2 semantic distillation. It never silently upgrades a model inference into an authoritative hard constraint.

Both are recalled under the Project Architecture context collection, but downstream knowledge planning preserves their authority distinction: hard Architecture can be required implementation guidance; the derived Cognitive Map is supporting structural context and cannot override the hard contract or L3 Current Truth.

## Runtime layout

A managed installation uses one logical stack:

- `memhub-core.service` — Memory Core on loopback `18960`;
- `memhub.service` — MCP runtime on loopback `3001`;
- `memhub-stack.target` — stack ownership on Linux;
- `Memhub-Stack` — equivalent single Windows scheduled task wrapper;
- `memhub.env` — one runtime environment file.

Server exposure is configuration (`LITSAN_PUBLIC_HOST` plus Cloudflare), not a second runtime mode.

The derived Project Map supports uneven branches down to `mechanism`, optional evidence-backed node facts, and an optional declared layer vocabulary for display grouping. New maps use the `mechanism` cutoff; stored `method` maps remain readable. Contracts remain type-only, while `core/architecture/node-kinds.ts` supplies the shared runtime level list; review inputs include facts and layer without changing the queue's structure fingerprint or governed architecture authority. 中文：派生项目地图允许分支不等深并深入机制层，参数以带证据的事实保存，代码分层使用可选词表；旧方法层地图仍可读取，契约保持纯类型，队列结构指纹与受治理架构权威不变。
