import type { McpServer } from "@modelcontextprotocol/server";
import { resultTools } from "../catalog/result.js";
import { registerCatalog } from "./adapter.js";
import type { ToolContext } from "./shared.js";
import type { ResultToolDeps as CatalogDeps } from "../catalog/result.js";

export type ResultToolDeps = Omit<CatalogDeps, "context"> & { context: ToolContext };

export function registerResultTools(server: McpServer, deps: ResultToolDeps): void {
  registerCatalog(server, resultTools(deps), deps.context);
}
