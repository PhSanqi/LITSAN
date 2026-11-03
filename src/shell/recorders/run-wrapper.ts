import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { constants } from "node:os";
import { StringDecoder } from "node:string_decoder";
import { initiatorFromEnv } from "./config.js";
import { Recorder } from "./state.js";

export async function promptFromArgs(args: string[]): Promise<string | undefined> {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith("-p=") || arg.startsWith("--prompt=")) return arg.slice(arg.indexOf("=") + 1);
    if (arg === "-p" || arg === "--prompt") return args[i + 1];
  }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const path = arg.startsWith("--prompt-file=") ? arg.slice(14) : arg === "--prompt-file" ? args[i + 1] : undefined;
    if (path) return readFile(path, "utf8");
  }
  return undefined;
}

export async function runWrapper(argv: string[], recorder: Recorder): Promise<number> {
  const separator = argv.indexOf("--");
  if (separator < 0 || !argv[separator + 1]) throw new Error("Usage: litsan run --harness NAME [--project P] -- cmd args…");
  let harness: string | undefined, project: string | undefined;
  for (let i = 0; i < separator; i += 2) {
    const flag = argv[i], value = argv[i + 1];
    if (!value || i + 1 >= separator || !["--harness", "--project"].includes(flag!)) throw new Error("Invalid litsan run options");
    if (flag === "--harness") harness = value;
    else project = value;
  }
  if (!harness) throw new Error("litsan run requires --harness");
  const command = argv[separator + 1]!;
  const args = argv.slice(separator + 2);
  // Recording setup must never prevent the already requested command running.
  let base: Record<string, unknown> | undefined, prompt: string | undefined;
  let initiator: ReturnType<typeof initiatorFromEnv>;
  try {
    await recorder.init();
    base = await recorder.base(process.cwd(), project);
    if (base) { prompt = await promptFromArgs(args); initiator = initiatorFromEnv(); }
  } catch (error) { base = undefined; recorder.note(error); }
  const started = Date.now();
  let tail = "", lastLine = "", finalLine = "";
  const decoder = new StringDecoder("utf8");
  const capture = (text: string) => {
    tail = (tail + text).slice(-20_000);
    const lines = (lastLine + text).split(/\r?\n/);
    lastLine = lines.pop()!;
    for (const line of lines) if (line.trim()) finalLine = line;
  };
  const child = spawn(command, args, { stdio: ["inherit", "pipe", "inherit"], env: { ...process.env, MEMHUB_RECORDER: harness }, windowsHide: true });
  // Forward terminal interrupts when this wrapper is targeted directly.
  const onInt = () => { child.kill("SIGINT"); };
  const onTerm = () => { child.kill("SIGTERM"); };
  process.on("SIGINT", onInt); process.on("SIGTERM", onTerm);
  const exit = await new Promise<number>(accept => {
    child.stdout.on("data", (chunk: Buffer) => {
      capture(decoder.write(chunk));
      // Honour a slow consumer without changing a single output byte.
      const writable = recorder.io.stdout;
      if (writable.write(chunk) === false && writable === process.stdout) {
        child.stdout.pause(); process.stdout.once("drain", () => child.stdout.resume());
      }
    });
    child.on("error", error => { recorder.note(error); accept(127); });
    child.on("close", (code, signal) => accept(code ?? (signal ? 128 + (constants.signals[signal] ?? 1) : 1)));
  });
  process.off("SIGINT", onInt); process.off("SIGTERM", onTerm);
  capture(decoder.end());
  // The launched command's duration is not part of recorder overhead.
  recorder.deadline += Date.now() - started;
  if (base && prompt) {
    try {
      let assistant = tail;
      try { const parsed = JSON.parse(lastLine.trim() ? lastLine : finalLine); if (typeof parsed.response === "string") assistant = parsed.response; } catch { /* plain stdout */ }
      const id = `${harness}:${randomUUID()}`;
      await recorder.call({ ...base, action: "record", inline_maintenance: false, user_text: prompt, assistant_text: assistant,
        turn_id: id, conversation_id: id, origin: initiator ? "agent" : "user", trigger: "delegate", ...(initiator ? { initiator } : {}) });
    } catch (error) { recorder.note(error); }
  }
  return exit;
}
