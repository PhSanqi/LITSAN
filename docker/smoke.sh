#!/usr/bin/env bash
# Smoke-test a running LITSAN container from the host: health + one MCP round trip.
# usage: docker/smoke.sh [base-url]   (default http://127.0.0.1:13001)
set -euo pipefail
BASE="${1:-http://127.0.0.1:13001}"
H=(-H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -H 'mcp-protocol-version: 2025-06-18')
rpc() { curl -fsS "${H[@]}" "$BASE/mcp" -d "$1" | sed -n 's/^data: //p'; }

echo "health: $(curl -fsS "$BASE/memhub/health")"
rpc '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"litsan-docker-smoke","version":"1"}}}' \
  | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8")); console.log("initialize:", d.result.serverInfo.name, d.result.serverInfo.version)'
rpc '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8")); console.log("tools:", d.result.tools.map((t) => t.name).join(" "))'
rpc '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"litsan_project_list","arguments":{}}}' \
  | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8")); if (d.result.isError) process.exit(1); console.log("litsan_project_list:", JSON.stringify(JSON.parse(d.result.content[0].text).projects))'
