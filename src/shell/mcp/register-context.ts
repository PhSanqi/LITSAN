import type { McpServer } from "@modelcontextprotocol/server";
import { contextTools } from "../catalog/context.js";
import { registerCatalog } from "./adapter.js";
import type { ToolContext } from "./shared.js";
import type { ContextToolDeps as CatalogDeps } from "../catalog/context.js";

export type ContextToolDeps = Omit<CatalogDeps, "context"> & { context: ToolContext };

export function registerContextTools(server: McpServer, deps: ContextToolDeps): void {
  registerCatalog(server, contextTools(deps), deps.context);
}
