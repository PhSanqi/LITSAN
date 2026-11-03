import { createHash } from "node:crypto";
import type { WorkstreamHint } from "../../contracts/branches.js";

export function deriveWorkstreamKey(hint?: WorkstreamHint):
  { key: string; kind: "git_branch" | "worktree" | "continuity"; display: string } |
  { key: null; reason: "no_hint" | "default_git_branch" } {
  const gitBranch = hint?.git_branch?.trim();
  const git = gitBranch === "HEAD" ? undefined : gitBranch;
  const defaultBranch = hint?.git_default_branch?.trim();
  const isDefault = Boolean(git && (defaultBranch ? git === defaultBranch : ["main", "master"].includes(git)));
  if (git && !isDefault) return { key: `git:${git}`, kind: "git_branch", display: git };
  const path = hint?.worktree?.trim().replaceAll("\\", "/").replace(/\/+$/, "").replace(/^[A-Z]:/, drive => drive.toLowerCase());
  if (path) return { key: `wt:${path}`, kind: "worktree", display: path.split("/").at(-1)! };
  const continuity = hint?.continuity_id?.trim();
  if (continuity) {
    const hash = createHash("sha256").update(continuity).digest("hex").slice(0, 16);
    return { key: `cont:${hash}`, kind: "continuity", display: hint?.label?.trim() || `conv-${hash.slice(0, 8)}` };
  }
  return { key: null, reason: isDefault ? "default_git_branch" : "no_hint" };
}

export function parseWorkstreamHint(value: unknown): WorkstreamHint | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("invalid workstream");
  const result: WorkstreamHint = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!["git_branch", "git_default_branch", "worktree", "continuity_id", "label"].includes(key) || typeof raw !== "string") throw new TypeError("invalid workstream hint");
    const text = raw.trim();
    if (text.length > (key === "label" ? 80 : 300)) throw new TypeError(`workstream ${key} too long`);
    if (text) result[key as keyof WorkstreamHint] = text;
  }
  return result;
}
