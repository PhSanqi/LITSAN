#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

export async function maintenanceQueueStatus(endpoint = process.env.MEMHUB_MCP_URL ?? "http://127.0.0.1:3001/mcp") {
  const url = new URL(endpoint);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password)
    throw new Error("LITSAN_MCP_URL must be a loopback HTTP MCP URL");
  const client = new Client({ name: "memhub-maintenance-queue-status", version: "1" });
  try {
    await client.connect(new StreamableHTTPClientTransport(url));
    const result = await client.callTool({ name: "memhub_card", arguments: { action: "queue_status", dry: true } });
    const body = result.content.filter(item => item.type === "text").map(item => item.text).join("");
    if (result.isError) throw new Error(body || "queue_status failed");
    const status = JSON.parse(body);
    if (!status?.kinds || !Number.isFinite(status.est_tokens_today)) throw new Error("invalid queue_status response");
    return status;
  } finally { await client.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  maintenanceQueueStatus().then(status => process.stdout.write(JSON.stringify(status) + "\n"), error => {
    console.error(error.message); process.exitCode = 1;
  });
}
