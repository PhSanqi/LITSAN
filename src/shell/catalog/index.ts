import type { ToolDefinition } from "./shared.js";
import { resultTools } from "./result.js";
import { turnTools } from "./turn.js";
import { contextTools } from "./context.js";
import { memoryTools } from "./memory.js";
import { branchTools } from "./branch.js";
import { skillTools } from "./skill.js";
import { distillTools } from "./distill.js";
import { cardTools } from "./card.js";
import { projectsTools } from "./projects.js";

export type { ToolDefinition, ToolOutput } from "./shared.js";

export type ToolCatalogDeps = Parameters<typeof resultTools>[0] & Parameters<typeof turnTools>[0] &
  Parameters<typeof contextTools>[0] & Parameters<typeof memoryTools>[0] & Parameters<typeof branchTools>[0] &
  Parameters<typeof skillTools>[0] & Parameters<typeof distillTools>[0] & Parameters<typeof cardTools>[0] &
  Parameters<typeof projectsTools>[0];

export function toolCatalog(deps: ToolCatalogDeps): ToolDefinition[] {
  return [...resultTools(deps), ...turnTools(deps), ...contextTools(deps), ...memoryTools(deps), ...branchTools(deps), ...skillTools(deps), ...distillTools(deps), ...cardTools(deps), ...projectsTools(deps)];
}
