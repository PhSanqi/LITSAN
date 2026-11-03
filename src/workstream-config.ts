import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withFileMutationLock } from "./file-mutation-lock.js";

interface WorkstreamConfig { version: 1; enabled_projects: string[] }
const projectKey = (accountId: string, projectId: string) => JSON.stringify([accountId, projectId]);
async function readConfig(stateRoot: string): Promise<WorkstreamConfig> {
  try {
    const config = JSON.parse(await readFile(join(stateRoot, "workstream-branches.json"), "utf8"));
    if (config.version !== 1 || !Array.isArray(config.enabled_projects) || config.enabled_projects.some((p: unknown) => typeof p !== "string")) {
      throw new Error("invalid workstream config");
    }
    return config;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, enabled_projects: [] };
    throw error;
  }
}
const warnedRoots = new Set<string>();
export async function isWorkstreamEnabled(stateRoot: string, accountId: string, projectId: string): Promise<boolean> {
  try {
    return (await readConfig(stateRoot)).enabled_projects.includes(projectKey(accountId, projectId));
  } catch (error) {
    if (!warnedRoots.has(stateRoot)) {
      warnedRoots.add(stateRoot);
      console.warn("[litsan] workstream config unreadable; all projects disabled:", error);
    }
    return false;
  }
}
export async function setWorkstreamEnabled(stateRoot: string, accountId: string, projectId: string, enabled: boolean): Promise<void> {
  const path = join(stateRoot, "workstream-branches.json");
  await withFileMutationLock(path, async () => {
    const config = await readConfig(stateRoot);
    const keys = new Set(config.enabled_projects), key = projectKey(accountId, projectId);
    if (enabled) keys.add(key); else keys.delete(key);
    await mkdir(stateRoot, { recursive: true, mode: 0o700 });
    const temporary = `${path}.tmp-${randomUUID()}`;
    await writeFile(temporary, JSON.stringify({ version: 1, enabled_projects: [...keys].sort() }, null, 2) + "\n", { mode: 0o600 });
    await rename(temporary, path);
  });
}

export async function hasWorkstreamProjects(stateRoot: string, accountId: string): Promise<boolean> {
  try { return (await readConfig(stateRoot)).enabled_projects.some(key => JSON.parse(key)[0] === accountId); }
  catch { return false; }
}
