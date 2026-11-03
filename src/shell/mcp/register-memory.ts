import type { McpServer } from "@modelcontextprotocol/server";
import { memoryTools } from "../catalog/memory.js";
import { registerCatalog } from "./adapter.js";
import type { ToolContext } from "./shared.js";
import type { MemoryToolDeps as CatalogDeps } from "../catalog/memory.js";

export type MemoryToolDeps = Omit<CatalogDeps, "context"> & { context: ToolContext };

export function registerMemoryTools(server: McpServer, deps: MemoryToolDeps): void {
  registerCatalog(server, memoryTools(deps), deps.context);
}
