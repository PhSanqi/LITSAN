import { resolveDataPath } from "../../state-root.mjs";
import { env } from "../../brand.mjs";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { execFile } from "node:child_process";
import type { TurnInitiator } from "../../contracts/capture.js";

export interface RecorderConfig {
  projects: { path: string; project: string }[];
  unmapped: "skip" | "record_global";
  endpoint?: string;
}
export function configPath(): string {
  return env("CLI_CONFIG") ?? resolveDataPath(["memhub", "cli.json"]);
}
export async function readConfig(): Promise<RecorderConfig | undefined> {
  let text: string;
  try { text = await readFile(configPath(), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  const config = JSON.parse(text);
  if (!config || !Array.isArray(config.projects) || !["skip", "record_global"].includes(config.unmapped) ||
      config.projects.some((p: any) => !p || typeof p.path !== "string" || !isAbsolute(p.path) || typeof p.project !== "string" || !p.project) ||
      (config.endpoint !== undefined && typeof config.endpoint !== "string")) throw new Error("Invalid recorder config");
  return config;
}
export function mapping(config: RecorderConfig | undefined, cwd: string, explicit?: string): Record<string, unknown> | undefined {
  if (explicit) return { project: explicit };
  if (!config) return undefined;
  const match = config.projects.filter(p => {
    const rel = relative(resolve(p.path), resolve(cwd));
    return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
  }).sort((a, b) => resolve(b.path).length - resolve(a.path).length)[0];
  return match ? { project: match.project } : config.unmapped === "record_global" ? { keep_global: true } : undefined;
}
export function initiatorFromEnv(): TurnInitiator | undefined {
  const raw = env("INITIATOR");
  if (raw === undefined) return undefined;
  // A malformed initiator must not cost the turn: record it without one.
  let value: Record<string, unknown> | undefined;
  try { value = JSON.parse(raw); } catch { value = undefined; }
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      ["harness", "session_id", "event_id"].some(key => value![key] !== undefined && typeof value![key] !== "string")) {
    process.stderr.write("[litsan] ignoring invalid LITSAN_INITIATOR\n");
    return undefined;
  }
  return Object.fromEntries(["harness", "session_id", "event_id"].filter(key => value[key] !== undefined).map(key => [key, value[key]]));
}

export async function workstreamHint(cwd: string, remainingMs = 500): Promise<Record<string, string> | undefined> {
  const git = (args: string[]) => new Promise<string>((accept, reject) => {
    execFile("git", ["-C", cwd, ...args], { timeout: Math.max(1, Math.min(500, remainingMs)), maxBuffer: 1_000_000,
      windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" } },
    (error, stdout) => error ? reject(error) : accept(stdout.trim()));
  });
  const results = await Promise.allSettled([
    git(["rev-parse", "--abbrev-ref", "HEAD"]), git(["worktree", "list", "--porcelain"]),
    git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]), git(["branch", "--list", "main", "master"])
  ]);
  const [branch, trees, remote, branches] = results;
  if (branch!.status !== "fulfilled" || trees!.status !== "fulfilled") return undefined;
  const defaultBranch = remote!.status === "fulfilled" ? remote!.value.replace(/^origin\//, "") :
    branches!.status === "fulfilled" ? (branches!.value.split(/\r?\n/).some(b => b.replace(/^[*+ ]+/, "") === "main") ? "main" : "master") : undefined;
  if (!defaultBranch) return undefined;
  const paths = trees!.value.split(/\r?\n/).filter(line => line.startsWith("worktree ")).map(line => {
    const raw = line.slice(9);
    try { return raw.startsWith('"') ? JSON.parse(raw) as string : raw; } catch { return raw; }
  });
  const linked = paths.slice(1).find(path => {
    const rel = relative(resolve(path), resolve(cwd));
    return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
  });
  return { git_branch: branch!.value, git_default_branch: defaultBranch, ...(linked ? { worktree: linked } : {}) };
}
