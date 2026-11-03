export function installSnippet(harness: string): string {
  if (harness === "claude") return JSON.stringify({ hooks: Object.fromEntries(["UserPromptSubmit", "Stop", "SubagentStop"].map(event => [event,
    [{ hooks: [{ type: "command", command: `litsan hook claude ${event}`, timeout: 3 }] }]])) }, null, 2) + "\n";
  if (harness === "codex") return 'notify = ["litsan", "hook", "codex"]\n';
  if (harness === "codex-inline") return JSON.stringify({ hooks: Object.fromEntries(["UserPromptSubmit", "Stop"].map(event => [event,
    [{ hooks: [{ type: "command", command: `litsan hook codex-inline ${event}`, timeout: 3 }] }]])) }, null, 2) + "\n";
  if (harness === "gemini") return JSON.stringify({ hooks: { BeforeAgent: [{ hooks: [{ type: "command", name: "litsan-guidance", command: "litsan hook guidance gemini", timeout: 3000 }] }] } }, null, 2) + "\n";
  if (harness === "cursor") return JSON.stringify({ version: 1, hooks: { sessionStart: [{ command: "litsan hook guidance cursor" }] } }, null, 2) + "\n";
  if (harness === "copilot") return JSON.stringify({ version: 1, hooks: { sessionStart: [{ type: "command", bash: "litsan hook guidance copilot", powershell: "litsan hook guidance copilot" }] } }, null, 2) + "\n";
  throw new Error("Install supports claude, codex, codex-inline, gemini, cursor or copilot");
}
