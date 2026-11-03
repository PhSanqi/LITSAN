# LITSAN boundaries

## LITSAN owns

- stable account identity and authenticated transport mapping;
- canonical Project Registry, Todo and explicit Branch metadata;
- L1 original-turn evidence and deterministic ingest recovery;
- L2/L3/L4/Skill evidence contracts and canonical artifact identity;
- distillation job control state;
- Memory Core integration and bounded retrieval;
- Project Architecture governance, including a strict authority boundary between the governed hard Architecture Contract and the derived Architecture Cognitive Map;
- Control Plane inspection and authorized mutation.

## Harness/model owns

- semantic interpretation of supplied evidence;
- producing candidate L2/L3/L4/Skill content;
- producing an optional complete Architecture Cognitive Map candidate during L2 semantic work when evidence materially changes project structure;
- deciding, within the contract, whether evidence justifies a semantic update.

LITSAN validates account, project, evidence, layer and revision boundaries. It does not fabricate semantic conclusions.

For Project Architecture, the Harness may infer the derived Cognitive Map, but it cannot write or promote hard constraints. The map must stop at method/mechanism abstraction, carry evidence/confidence, and pass a fingerprint fence. Hard Architecture remains explicit-user-authority content governed by `architecture_plan -> approval -> architecture_execute`.

## Project boundary

At most one primary project contributes ordinary project business memory. Current-turn project/workspace evidence is authoritative. Host conversation identity is not a routing fallback. Ambiguity becomes global-only recall.

Cross-project reuse is limited to explicitly allowed account-level L4 context and reusable Skill capability; one project's L2/L3 is never imported as another project's ordinary context.

## Branch boundary

Branch is explicit project-local workstream metadata. It may narrow retrieval inside an already-resolved project; it never broadens project scope. A conversation is bound to a Branch only through an explicit `workstream` hint, never through transport or session identity.

## Transport boundary

Both local and remote callers terminate at the same MCP runtime. Loopback requests use local identity. Requests arriving through the public host require the authenticated Cloudflare boundary. Transport metadata is provenance, not a memory partition.

## MCP boundary

Current high-level tools:

- `litsan_turn`
- `litsan_context`
- `litsan_memory`
- `litsan_distill`
- `litsan_project_list`
- `litsan_project_manage`
- `litsan_todo`
- `litsan_project`
- `litsan_branch`
- `litsan_skill`
- `litsan_result`

Project mutation and architecture replacement use plan -> explicit authorization -> execute. Explicit L3/L4 user authority uses complete-text review plus L1 confirmation evidence.

## Storage boundary

Persistent user data under `~/.memmy` is protected state. Runtime releases and source trees are replaceable code. A service restart is not proof of a safe migration: schema/data changes require a verified snapshot and preservation checks.
