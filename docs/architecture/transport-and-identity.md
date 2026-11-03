# Transport and identity

LITSAN has one product identity boundary and two transport entries. Each entry serves two protocols from the same gateway.

```text
Local:  127.0.0.1:3001/mcp                (MCP)
        127.0.0.1:3001/memhub/api/tools   (HTTP JSON tool route; used by the `litsan` CLI)
Remote: Cloudflare Access/Tunnel -> the same two paths
```

Both protocols are thin adapters over one transport-neutral tool catalog (`src/shell/catalog`). They expose the same tools with the same input schemas; a parity test fails if an MCP tool, a catalog entry or a CLI command diverges. Neither protocol depends on the other.

A stable LITSAN `account_id` is authoritative. `platform`, `transport`, authenticated principal and connection identifiers are provenance fields only.

Loopback requests (MCP or HTTP tools) are accepted only from a loopback peer with a loopback host header and without Cloudflare forwarding headers. When a public host is configured, all non-loopback public-host requests require valid Cloudflare authentication before they resolve to an account. The CLI currently targets loopback only.

Project and Branch routing never derive from connection or conversation identity. Callers provide current `project` / `workspace_project` evidence and, when needed, an explicit Branch or `workstream` hint.

L1 provenance records an `actor_id` for the submitting Harness. Historical L1 files that contain `device_id` are normalized on read, but current identity authority remains the authenticated LITSAN account, not a device registry.

A turn reaches L1 only when a recorder calls `litsan_turn`: the agent itself (over MCP or the CLI), or a passive recorder that runs inside a harness the user already runs (Claude Code hook, Codex notify, the `litsan run` wrapper). Each session has one recorder. Every L1 turn carries `origin` (`user` | `agent` | `automation`), a `trigger`, and optionally an `initiator` and an explicit `relates_to` link. `origin` fixes the `user_text` source kind (`user_said` / `agent_inferred` / `tool_output`), and `relays` / `duplicate_of` links keep a turn in L1 but out of L2 discovery. LITSAN runs no worker, timer or model call to record turns.
