import { brand, env } from "../../brand.mjs";
import { stdin, stdout, stderr } from "node:process";
import { CliUsageError, parseGlobals, parseToolArgs, propertyKind, usageFor } from "./args.js";
import { callTool, listTools } from "./client.js";
import { commandForTool, toolForCommand } from "./commands.js";

type CliIo = {
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
  stdin: AsyncIterable<string | Buffer>;
};

export async function runToolCli(argv: string[], io: CliIo = { stdout, stderr, stdin }): Promise<number> {
  const command = argv[0] ?? "";
  if (command === "hook" || command === "run") return runRecorderCli(argv, io);
  const tool = toolForCommand(command);
  let pretty = false;
  let help = false;
  let schemaFetched = false;
  const emit = (body: unknown) => io.stdout.write(JSON.stringify(body, null, pretty ? 2 : undefined) + "\n");
  try {
    if (!tool && command !== "tools") throw new CliUsageError(`Unknown command: ${command ?? ""}`);
    const { global, rest } = parseGlobals(argv.slice(1));
    pretty = global.pretty;
    help = global.help;
    const endpoint = global.endpoint ?? env("TOOLS_URL") ?? `http://127.0.0.1:3001${brand.basePath}/api/tools`;
    const tools = await listTools(endpoint, global.timeoutMs);
    if (command === "tools") {
      if (rest.length) throw new CliUsageError(`Unexpected argument: ${rest[0]}`);
      if (help) io.stdout.write(usageFor(command, {}));
      else emit({ ok: true, tools: tools.map(item => ({ command: commandForTool(item.name), tool: item.name, description: item.description })) });
      return 0;
    }
    const description = tools.find(item => item.name === tool);
    if (!description) throw new CliUsageError(`Tool is unavailable: ${tool}`);
    schemaFetched = true;
    if (help) {
      io.stdout.write(usageFor(command, description.inputSchema));
      return 0;
    }
    const jsonFlags = new Set(["--json-args", ...Object.entries(description.inputSchema.properties ?? {})
      .filter(([, schema]) => propertyKind(schema) === "json")
      .map(([key]) => `--${key.replaceAll("_", "-")}-json`)]);
    let stdinText: string | undefined;
    if (rest.some((token, index) => {
      const equals = token.indexOf("=");
      return equals < 0 ? jsonFlags.has(token) && rest[index + 1] === "-" : jsonFlags.has(token.slice(0, equals)) && token.slice(equals + 1) === "-";
    })) {
      const chunks: Buffer[] = [];
      for await (const chunk of io.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      stdinText = Buffer.concat(chunks).toString("utf8");
    }
    const { args } = parseToolArgs(argv.slice(1), description.inputSchema, stdinText);
    const result = await callTool(endpoint, tool!, args, global.timeoutMs);
    if (!result.ok) {
      emit({ ok: false, tool, error: result.error });
      return 1;
    }
    emit({ ok: true, tool, ...(args.action === undefined ? {} : { action: args.action }), result: result.result });
    return 0;
  } catch (error) {
    const code = error instanceof CliUsageError ? "usage" : "transport";
    const message = error instanceof Error ? error.message : String(error);
    if (help && !schemaFetched && code === "transport") {
      io.stdout.write(usageFor(command, {}));
      io.stderr.write(message + "\n");
    } else emit({ ok: false, ...(tool ? { tool } : {}), error: { code, message } });
    return 2;
  }
}

export async function runRecorderCli(argv: string[], io: CliIo = { stdout, stderr, stdin }): Promise<number> {
  const { Recorder } = await import("../recorders/state.js");
  const recorder = new Recorder(io);
  try {
    if (argv[0] === "run") {
      const { runWrapper } = await import("../recorders/run-wrapper.js");
      return await runWrapper(argv.slice(1), recorder);
    }
    if (argv[0] !== "hook") throw new Error("Unknown recorder command");
    // Printing installation instructions is strictly read-only, even with a spool.
    if (argv[1] === "install") {
      if (argv.length !== 4 || argv[3] !== "--print") throw new Error("Usage: litsan hook install HARNESS --print");
      const { installSnippet } = await import("../recorders/install.js");
      io.stdout.write(installSnippet(argv[2]!));
      return 0;
    }
    if (argv[1] === "guidance" && argv.length === 3 && ["gemini", "cursor", "copilot", "json"].includes(argv[2]!)) {
      const { portableAgentGuidance } = await import("../recorders/inline-card.js");
      const message = portableAgentGuidance();
      io.stdout.write(JSON.stringify(argv[2] === "gemini" ? { hookSpecificOutput: { hookEventName: "BeforeAgent", additionalContext: message } } :
        argv[2] === "cursor" ? { additional_context: message } : { additionalContext: message }) + "\n");
      return 0;
    }
    // stop_hook_active must do absolutely nothing, including spool replay.
    let payload: Record<string, unknown> | undefined;
    if (argv[1] === "claude" || argv[1] === "codex-inline") {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const input = (async () => { let text = ""; for await (const chunk of io.stdin) text += chunk.toString(); return text; })();
      try {
        const text = await Promise.race([input, new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            if (io.stdin === stdin) stdin.destroy();
            reject(new Error("Hook stdin exceeded recorder time budget"));
          }, recorder.remaining());
        })]);
        payload = JSON.parse(text);
      } finally { if (timer) clearTimeout(timer); }
      if (argv[2] === "Stop" && payload?.stop_hook_active === true) return 0;
    }
    await recorder.init();
    if (argv[1] === "flush" && argv.length === 2) return 0;
    if (argv[1] === "status" && argv.length === 2) { io.stdout.write(JSON.stringify(await recorder.status()) + "\n"); return 0; }
    if (argv[1] === "claude" && argv.length === 3 && payload && typeof payload === "object" && !Array.isArray(payload)) {
      const { claudeHook } = await import("../recorders/claude-hook.js");
      await claudeHook(argv[2]!, payload, recorder);
    } else if (argv[1] === "codex-inline" && argv.length === 3 && payload && typeof payload === "object" && !Array.isArray(payload)) {
      const { codexInlineHook } = await import("../recorders/codex-notify.js");
      await codexInlineHook(argv[2]!, payload, recorder);
    } else if (argv[1] === "codex" && argv.length === 3) {
      const { codexNotify } = await import("../recorders/codex-notify.js");
      const value = JSON.parse(argv[2]!);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Codex notify payload");
      await codexNotify(value, recorder);
    } else throw new Error("Usage: litsan hook claude EVENT | codex-inline EVENT | codex JSON | flush | status | install HARNESS --print");
  } catch (error) { recorder.note(error); }
  return 0;
}
