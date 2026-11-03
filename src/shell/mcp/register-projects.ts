import type { McpServer } from "@modelcontextprotocol/server";
import { projectsTools } from "../catalog/projects.js";
import { registerCatalog } from "./adapter.js";
import type { ToolContext } from "./shared.js";
import type { ProjectsToolDeps as CatalogDeps } from "../catalog/projects.js";

export type ProjectsToolDeps = Omit<CatalogDeps, "context"> & { context: ToolContext };

export function registerProjectsTools(server: McpServer, deps: ProjectsToolDeps): void {
  registerCatalog(server, projectsTools(deps), deps.context);
}
