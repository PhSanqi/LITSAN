import type { McpServer } from "@modelcontextprotocol/server";
import { turnTools } from "../catalog/turn.js";
import { registerCatalog } from "./adapter.js";
import type { ToolContext } from "./shared.js";
import type { TurnToolDeps as CatalogDeps } from "../catalog/turn.js";

export type TurnToolDeps = Omit<CatalogDeps, "context"> & { context: ToolContext };

export function registerTurnTools(server: McpServer, deps: TurnToolDeps): void {
  registerCatalog(server, turnTools(deps), deps.context);
}
