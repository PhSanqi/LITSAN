import type { McpServer } from "@modelcontextprotocol/server";
import { cardTools } from "../catalog/card.js";
import { registerCatalog } from "./adapter.js";
import type { ToolContext } from "./shared.js";
import type { MaintenanceDeps } from "../../maintenance-control.js";

export function registerCardTools(server: McpServer, deps: { runtime: MaintenanceDeps["runtime"]; context: ToolContext }): void {
  registerCatalog(server, cardTools(deps), deps.context);
}
