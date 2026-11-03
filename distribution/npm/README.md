# LITSAN

LITSAN (formerly Memhub). Legacy `MEMHUB_*` / `MEMMY_*` environment variables still work.

LITSAN is a self-hosted, project-aware AI memory runtime exposed through MCP. The npm package runs on the user's own machine; it does not depend on a creator-hosted memory server.

## Install

Node.js 20.9 or newer is required.

For a CPU/local installation, use:

```bash
npm install -g @phsanqi/litsan --onnxruntime-node-install=skip
```

The install flag skips the optional ONNX Runtime CUDA payload download. It does not disable the CPU runtime used by LITSAN.

## Start

Initialize the local state once:

```bash
litsan init
```

Start the single local LITSAN stack:

```bash
litsan start
```

The default MCP endpoint is:

```text
http://127.0.0.1:3001/mcp
```

Useful checks:

```bash
litsan doctor --json
litsan status --json
litsan stop
```

User state lives outside the npm package under `~/.memmy/memhub` by default. Removing or upgrading the npm package is not permission to delete that state.

For persistent service installation or a user-operated remote deployment, use the corresponding official LITSAN edition installer. The local and remote modes use the same LITSAN MCP runtime; a remote deployment remains owned and operated by the user.
