import { toolName } from "../../brand.mjs";
export const CLI_COMMANDS: Readonly<Record<string, string>> = {
  context: toolName("context"), turn: toolName("turn"), todo: toolName("todo"),
  "project-list": toolName("project_list"), project: toolName("project"), "project-manage": toolName("project_manage"),
  distill: toolName("distill"), card: toolName("card"), branch: toolName("branch"),
  memory: toolName("memory"), skill: toolName("skill"), result: toolName("result")
};

// Harness entry points, not catalog/MCP tools. Parity only covers CLI_COMMANDS.
export const RECORDER_COMMANDS = ["hook", "run"] as const;

export function toolForCommand(cmd: string): string | undefined {
  return Object.hasOwn(CLI_COMMANDS, cmd) ? CLI_COMMANDS[cmd] : undefined;
}

export function commandForTool(tool: string): string | undefined {
  return Object.keys(CLI_COMMANDS).find(command => CLI_COMMANDS[command] === tool);
}
