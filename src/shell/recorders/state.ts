import { resolveDataPath } from "../../state-root.mjs";
import { brand, env } from "../../brand.mjs";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, chmod, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { callTool, CliTransportError } from "../cli/client.js";
import { configPath, mapping, readConfig, workstreamHint, type RecorderConfig } from "./config.js";
import type { ClassifiedPrompt } from "./classify.js";

export interface SessionState {
  sequence: number;
  skipped: Record<string, number>;
  turn?: { prompt: ClassifiedPrompt; args: Record<string, unknown>; event_id?: string; transcript_path?: string; tool_summary?: string };
}
type SpoolEntry = { ts: string; tool: string; args: Record<string, unknown> };
export interface RecorderIo {
  stdout: { write(text: string | Buffer): unknown };
  stderr: { write(text: string): unknown };
  stdin: AsyncIterable<string | Buffer>;
}
export class Recorder {
  readonly home = env("RECORDER_HOME") ?? resolveDataPath(["memhub", "recorder"]);
  deadline = Date.now() + 2700;
  config?: RecorderConfig;
  constructor(readonly io: RecorderIo) {}
  note(error: unknown): void {
    this.io.stderr.write(`[litsan recorder] ${String(error instanceof Error ? error.message : error).replace(/[\r\n]+/g, " ")}\n`);
  }
  remaining(): number { return Math.max(0, this.deadline - Date.now()); }
  async init(): Promise<void> { this.config = await readConfig(); await this.flush(); }
  private async directory(): Promise<void> {
    await mkdir(this.home, { recursive: true, mode: 0o700 });
    await chmod(this.home, 0o700);
  }
  async atomic(path: string, text: string): Promise<void> {
    await this.directory();
    const temporary = `${path}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, text, { mode: 0o600, flag: "wx" }); await rename(temporary, path); }
    finally { await unlink(temporary).catch(() => undefined); }
  }
  private sessionPath(id: string): string { return join(this.home, `session-${createHash("sha256").update(id).digest("hex")}.json`); }
  async load(id: string): Promise<SessionState> {
    try { return JSON.parse(await readFile(this.sessionPath(id), "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { sequence: 0, skipped: {} }; throw error; }
  }
  async save(id: string, state: SessionState): Promise<void> { await this.atomic(this.sessionPath(id), JSON.stringify(state) + "\n"); }
  // A short-lived exclusive file prevents a concurrent flush from losing an append.
  async locked<T>(key: string, action: () => Promise<T>, waitMs = 200): Promise<T> {
    await this.directory();
    const path = join(this.home, `${createHash("sha256").update(key).digest("hex")}.lock`);
    let handle;
    const until = Math.min(this.deadline, Date.now() + waitMs);
    while (!handle) {
      try {
        handle = await open(path, "wx", 0o600);
        await handle.writeFile(JSON.stringify({ pid: process.pid, host: hostname() }));
      }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (await this.reclaim(path)) continue;
        if (Date.now() >= until) throw error;
        await new Promise(accept => setTimeout(accept, 10));
      }
    }
    try { return await action(); } finally { await handle.close(); await unlink(path); }
  }
  private async reclaim(path: string): Promise<boolean> {
    // Serialize dead-owner recovery too: two reclaimers must never remove a
    // newly acquired live lock. Malformed/foreign locks remain untouched.
    let guard;
    try { guard = await open(`${path}.reclaim`, "wx", 0o600); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return false; throw error; }
    try {
      let owner;
      try { owner = JSON.parse(await readFile(path, "utf8")); } catch { return false; }
      if (owner.host !== hostname() || !Number.isInteger(owner.pid) || owner.pid <= 0) return false;
      try { process.kill(owner.pid, 0); return false; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false; }
      await unlink(path);
      return true;
    } finally { await guard.close(); await unlink(`${path}.reclaim`); }
  }
  private endpoint(): string { return this.config?.endpoint ?? env("TOOLS_URL") ?? `http://127.0.0.1:3001${brand.basePath}/api/tools`; }
  private async send(entry: SpoolEntry): Promise<unknown> {
    if (this.remaining() < 100) throw new Error("Recorder time budget exhausted");
    const response = await callTool(this.endpoint(), entry.tool, entry.args, Math.max(1, Math.min(900, this.remaining() - 80)));
    if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`);
    return response.result;
  }
  async call(args: Record<string, unknown>): Promise<unknown> {
    const entry = { ts: new Date().toISOString(), tool: "litsan_turn", args };
    try { return await this.send(entry); }
    catch (error) {
      // A timed-out request was delivered and the server finishes it (litsan_turn is
      // idempotent by event_id / turn_id). Replaying it would only repeat slow
      // server work, so only undelivered requests are spooled.
      if (error instanceof CliTransportError && error.timedOut) {
        this.io.stderr.write("[litsan recorder] sent; server response still pending\n");
        return undefined;
      }
      await this.locked("spool", async () => {
        const path = join(this.home, "spool.jsonl");
        await appendFile(path, JSON.stringify(entry) + "\n", { mode: 0o600 });
        await chmod(path, 0o600);
      });
      this.note(error);
      return undefined;
    }
  }
  async flush(): Promise<void> {
    const path = join(this.home, "spool.jsonl");
    try { await readFile(path, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    try {
      await this.locked("flush", async () => {
        const lines = await this.locked("spool", async () => (await readFile(path, "utf8")).split("\n").filter(Boolean));
        let sent = 0;
        while (sent < Math.min(20, lines.length) && this.remaining() >= 150) {
          try { await this.send(JSON.parse(lines[sent]!)); sent++; }
          catch (error) {
            if (error instanceof CliTransportError && error.timedOut) { sent++; continue; }
            this.note(error); break;
          }
        }
        // HTTP runs outside the append lock. Preserve entries appended while
        // this snapshot was replaying; a crash may replay acknowledged ids.
        if (sent) await this.locked("spool", async () => {
          const current = (await readFile(path, "utf8")).split("\n").filter(Boolean);
          await this.atomic(path, current.slice(sent).map(line => line + "\n").join(""));
        });
      }, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Another invocation owns replay. New recording still proceeds.
    }
  }
  async base(cwd: string, explicit?: string): Promise<Record<string, unknown> | undefined> {
    const mapped = mapping(this.config, cwd, explicit);
    if (!mapped) return undefined;
    const hint = await workstreamHint(cwd, Math.min(500, this.remaining()));
    return { ...mapped, ...(hint ? { workstream: hint } : {}) };
  }
  async status(): Promise<unknown> {
    const { readdir } = await import("node:fs/promises");
    const skipped: Record<string, number> = {};
    let files: string[] = [];
    try { files = await readdir(this.home); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    for (const file of files.filter(name => /^session-[a-f0-9]+\.json$/.test(name))) {
      if (this.remaining() < 100) throw new Error("Status exceeded recorder time budget");
      const state: SessionState = JSON.parse(await readFile(join(this.home, file), "utf8"));
      for (const [date, count] of Object.entries(state.skipped)) skipped[date] = (skipped[date] ?? 0) + count;
    }
    let spool = "";
    try { spool = await readFile(join(this.home, "spool.jsonl"), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    return { spool_size: spool.split("\n").filter(Boolean).length, skipped, config_path: configPath(), mapped_projects: this.config?.projects ?? [] };
  }
}
