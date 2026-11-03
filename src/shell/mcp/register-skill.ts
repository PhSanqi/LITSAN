import type { McpServer } from "@modelcontextprotocol/server";
import { skillTools } from "../catalog/skill.js";
import { registerCatalog } from "./adapter.js";
import type { ToolContext } from "./shared.js";
import type { SkillToolDeps as CatalogDeps } from "../catalog/skill.js";

export type SkillToolDeps = Omit<CatalogDeps, "context"> & { context: ToolContext };

export function registerSkillTools(server: McpServer, deps: SkillToolDeps): void {
  registerCatalog(server, skillTools(deps), deps.context);
}
