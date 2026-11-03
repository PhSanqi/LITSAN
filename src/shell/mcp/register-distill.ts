import type { McpServer } from "@modelcontextprotocol/server";
import { distillTools } from "../catalog/distill.js";
import { registerCatalog } from "./adapter.js";
import type { ToolContext } from "./shared.js";
import type { DistillToolDeps as CatalogDeps } from "../catalog/distill.js";

export type DistillToolDeps = Omit<CatalogDeps, "context"> & { context: ToolContext };

export function registerDistillTools(server: McpServer, deps: DistillToolDeps): void {
  registerCatalog(server, distillTools(deps), deps.context);
}
