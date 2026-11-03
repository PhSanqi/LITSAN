import type { ProjectBranchStatus, ProjectBranch } from "./contracts/branches.js";
export type { ProjectBranchStatus, ProjectBranch } from "./contracts/branches.js";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { withFileMutationLock } from "./file-mutation-lock.js";

interface BranchFile {
  version: 1;
  branches: ProjectBranch[];
}

export class JsonProjectBranchStore {
  constructor(private readonly path: string, private readonly locked = false, private readonly projectScope?: { accountId: string; projectId: string }) {}

  /** A single lock covers binding, cap eviction and append-only capture assignment.
   * ponytail: retain the existing file-wide lock; shard the JSON store only if
   * cross-project write contention warrants separate project locks.
   */
  async withProjectLock<T>(accountId: string, projectId: string, run: (store: JsonProjectBranchStore) => Promise<T>): Promise<T> {
    requireNonEmpty(accountId, "accountId");
    requireNonEmpty(projectId, "projectId");
    return this.serialize(() => run(new JsonProjectBranchStore(this.path, true, { accountId, projectId })));
  }

  async findActiveByKey(accountId: string, projectId: string, key: string): Promise<ProjectBranch | null> {
    return (await this.list(accountId, projectId)).find(b => b.workstream_key === key) ?? null;
  }

  async findByKey(accountId: string, projectId: string, key: string, options: { includeClosed: true }): Promise<ProjectBranch | null> {
    return (await this.list(accountId, projectId, options)).find(b => b.workstream_key === key && b.origin === "auto") ?? null;
  }

  async createAuto(accountId: string, projectId: string, input: {
    key: string; name: string; goal: string; base_map_fingerprint: string; base_l2_revision: string | null; now: string;
  }): Promise<ProjectBranch> {
    return this.serialize(async () => {
      const file = await this.read();
      const active = file.branches.filter(b => b.accountId === accountId && b.projectId === projectId && b.status === "active");
      const base = requireNonEmpty(input.name, "name");
      let name = base, suffix = 2;
      while (active.some(b => normalizeRef(b.name) === normalizeRef(name))) name = `${base}-${suffix++}`;
      const branch: ProjectBranch = {
        accountId, projectId, branchId: `${uniqueBranchId(file.branches, accountId, projectId, name)}-${randomUUID().slice(0, 8)}`, name,
        goal: input.goal, status: "active", createdAt: input.now, updatedAt: input.now,
        origin: "auto", workstream_key: input.key, last_activity_at: input.now,
        base_map_fingerprint: input.base_map_fingerprint, base_l2_revision: input.base_l2_revision
      };
      file.branches.push(branch);
      await this.write(file);
      return { ...branch };
    });
  }

  async touch(branchId: string, now: string): Promise<void> {
    await this.serialize(async () => {
      const file = await this.read();
      const branch = file.branches.find(b => b.branchId === branchId && (!this.projectScope || (b.accountId === this.projectScope.accountId && b.projectId === this.projectScope.projectId)));
      if (!branch || Date.parse(now) - Date.parse(branch.last_activity_at ?? "") < 60_000) return;
      branch.last_activity_at = now;
      await this.write(file);
    });
  }

  async closeForCap(branchId: string, closing = false): Promise<ProjectBranch> {
    return this.serialize(async () => {
      const file = await this.read();
      const branch = file.branches.find(b => b.branchId === branchId && (!this.projectScope || (b.accountId === this.projectScope.accountId && b.projectId === this.projectScope.projectId)));
      if (!branch || branch.origin !== "auto" || branch.status !== "active") throw new Error("unknown active auto branch");
      branch.status = closing ? "closing" : "closed";
      if (closing) branch.closing_since = new Date().toISOString();
      branch.closed_reason = "cap";
      branch.closedAt = branch.updatedAt = new Date().toISOString();
      await this.write(file);
      return { ...branch };
    });
  }

  async refreshBase(accountId: string, projectId: string, branchId: string, base: {
    base_map_fingerprint: string; base_l2_revision: string | null;
  }, now: string): Promise<ProjectBranch> {
    return this.serialize(async () => {
      const file = await this.read();
      const branch = file.branches.find(b => b.accountId === accountId && b.projectId === projectId && b.branchId === branchId);
      if (!branch) throw new Error("unknown branch");
      const active = file.branches.filter(b => b.accountId === accountId && b.projectId === projectId && b.status === "active" && b.branchId !== branchId);
      const originalName = branch.name;
      let name = originalName, suffix = 2;
      while (active.some(b => normalizeRef(b.name) === normalizeRef(name))) name = `${originalName}-${suffix++}`;
      Object.assign(branch, base, { name, status: "active", updatedAt: now, last_activity_at: now });
      delete branch.closedAt;
      delete branch.closed_reason;
      delete branch.closing_since; delete branch.merged_at; delete branch.merge_job_id; delete branch.expired_at;
      await this.write(file);
      return { ...branch };
    });
  }

  async list(accountId: string, projectId: string, options: { includeClosed?: boolean } = {}): Promise<ProjectBranch[]> {
    const account = requireNonEmpty(accountId, "accountId");
    const project = requireNonEmpty(projectId, "projectId");
    const file = await this.read();
    return file.branches
      .filter((branch) => branch.accountId === account && branch.projectId === project)
      .filter((branch) => options.includeClosed || branch.status === "active")
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async create(accountId: string, projectId: string, input: { name: string; goal: string; base_map_fingerprint?: string; base_l2_revision?: string | null }): Promise<ProjectBranch> {
    return this.serialize(async () => {
      const account = requireNonEmpty(accountId, "accountId");
      const project = requireNonEmpty(projectId, "projectId");
      const name = requireNonEmpty(input.name, "name");
      const goal = requireNonEmpty(input.goal, "goal");
      const file = await this.read();
      const same = file.branches.find((branch) =>
        branch.accountId === account &&
        branch.projectId === project &&
        branch.status === "active" &&
        normalizeRef(branch.name) === normalizeRef(name)
      );
      if (same) {
        if (same.origin === "auto") throw new Error(`active auto branch already uses name: ${name}`);
        if (same.goal !== goal) {
          same.goal = goal;
          same.updatedAt = new Date().toISOString();
          await this.write(file);
        }
        return { ...same };
      }
      const now = new Date().toISOString();
      const branch: ProjectBranch = {
        accountId: account,
        projectId: project,
        branchId: uniqueBranchId(file.branches, account, project, name),
        name,
        goal,
        status: "active",
        createdAt: now,
        updatedAt: now,
        ...(input.base_map_fingerprint !== undefined ? {
          origin: "manual" as const, base_map_fingerprint: input.base_map_fingerprint,
          base_l2_revision: input.base_l2_revision ?? null
        } : {})
      };
      file.branches.push(branch);
      await this.write(file);
      return { ...branch };
    });
  }

  async resolve(accountId: string, projectId: string, reference: string, options: { includeClosed?: boolean } = {}): Promise<ProjectBranch | null> {
    const account = requireNonEmpty(accountId, "accountId");
    const project = requireNonEmpty(projectId, "projectId");
    const ref = normalizeRef(requireNonEmpty(reference, "branch"));
    const candidates = (await this.read()).branches.filter((branch) =>
      branch.accountId === account &&
      branch.projectId === project &&
      (options.includeClosed || branch.status === "active")
    );
    return candidates.find((branch) => normalizeRef(branch.branchId) === ref) ??
      candidates.find((branch) => normalizeRef(branch.name) === ref) ?? null;
  }

  async close(accountId: string, projectId: string, reference: string): Promise<ProjectBranch> {
    return this.setStatus(accountId, projectId, reference, "closed");
  }

  async reopen(accountId: string, projectId: string, reference: string): Promise<ProjectBranch> {
    return this.setStatus(accountId, projectId, reference, "active");
  }

  async transition(accountId: string, projectId: string, reference: string,
    patch: Pick<ProjectBranch, "status"> & Partial<Pick<ProjectBranch, "closing_since" | "closed_reason" | "merged_at" | "merge_job_id" | "expired_at">>,
    now = new Date().toISOString()): Promise<ProjectBranch> {
    return this.serialize(async () => {
      const file = await this.read();
      const branch = file.branches.find(b => b.accountId === accountId && b.projectId === projectId &&
        (normalizeRef(b.branchId) === normalizeRef(reference) || normalizeRef(b.name) === normalizeRef(reference)));
      if (!branch) throw new Error("unknown branch");
      Object.assign(branch, patch, { updatedAt: now });
      if (patch.status === "active") { delete branch.closing_since; delete branch.closed_reason; delete branch.closedAt; }
      await this.write(file);
      return { ...branch };
    });
  }

  private async setStatus(accountId: string, projectId: string, reference: string, status: ProjectBranchStatus): Promise<ProjectBranch> {
    return this.serialize(async () => {
      const account = requireNonEmpty(accountId, "accountId");
      const project = requireNonEmpty(projectId, "projectId");
      const ref = normalizeRef(requireNonEmpty(reference, "branch"));
      const file = await this.read();
      const branch = file.branches.find((item) =>
        item.accountId === account &&
        item.projectId === project &&
        (normalizeRef(item.branchId) === ref || normalizeRef(item.name) === ref)
      );
      if (!branch) throw new Error(`unknown branch for project ${project}: ${reference}`);
      const now = new Date().toISOString();
      branch.status = status;
      branch.updatedAt = now;
      if (status === "closed") {
        branch.closedAt = now;
        if (branch.origin) branch.closed_reason = "manual_close";
      } else { delete branch.closedAt; delete branch.closed_reason; }
      await this.write(file);
      return { ...branch };
    });
  }

  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    return this.locked ? operation() : withFileMutationLock(this.path, operation);
  }

  private async read(): Promise<BranchFile> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as unknown;
      if (!isBranchFile(parsed)) throw new Error(`invalid branch store: ${this.path}`);
      return { version: 1, branches: parsed.branches };
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { version: 1, branches: [] };
      throw error;
    }
  }

  private async write(file: BranchFile): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.tmp-${process.pid}-${randomUUID()}`;
    await writeFile(temporary, JSON.stringify(file, null, 2) + "\n", { mode: 0o600 });
    await rename(temporary, this.path);
  }
}

function uniqueBranchId(branches: readonly ProjectBranch[], accountId: string, projectId: string, name: string): string {
  const base = slug(name) || "branch";
  const occupied = new Set(branches
    .filter((branch) => branch.accountId === accountId && branch.projectId === projectId)
    .map((branch) => branch.branchId));
  if (!occupied.has(base)) return base;
  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!occupied.has(candidate)) return candidate;
  }
  return `branch-${randomUUID().slice(0, 8)}`;
}

function slug(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function normalizeRef(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().trim();
}

function requireNonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${field} must be non-empty`);
  return normalized;
}

function isBranchFile(value: unknown): value is BranchFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || !Array.isArray(record.branches)) return false;
  return record.branches.every((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const branch = item as Record<string, unknown>;
    return typeof branch.accountId === "string" &&
      typeof branch.projectId === "string" &&
      typeof branch.branchId === "string" &&
      typeof branch.name === "string" &&
      typeof branch.goal === "string" &&
      ["active", "closed", "closing", "merged", "expired"].includes(branch.status as string) &&
      typeof branch.createdAt === "string" &&
      typeof branch.updatedAt === "string";
  });
}
