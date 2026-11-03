import type { McpServer } from "@modelcontextprotocol/server";
import { branchTools } from "../catalog/branch.js";
import { registerCatalog } from "./adapter.js";
import type { ToolContext } from "./shared.js";
import type { BranchToolDeps as CatalogDeps } from "../catalog/branch.js";

export type BranchToolDeps = Omit<CatalogDeps, "context"> & { context: ToolContext };

export function registerBranchTools(server: McpServer, deps: BranchToolDeps): void {
  registerCatalog(server, branchTools(deps), deps.context);
}
