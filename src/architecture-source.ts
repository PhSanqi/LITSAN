import type { ProjectArchitectureDocument } from "./contracts/architecture.js";
import type { CodeEvidenceSnapshot, CodeEvidenceItem } from "./contracts/code-evidence.js";
import { scanCodeEvidence } from "./shell/archify/code-evidence.js";
import { applyCodeLayers, validateHistoricalCodeOwners } from "./archify/code-evidence.js";
export type { ProjectArchitectureDocument } from "./contracts/architecture.js";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ContextItem } from "./context-capsule.js";
import { withFileMutationLock } from "./file-mutation-lock.js";
import { validateProjectId } from "./project-registry.js";
import {
  architectureCognitiveMapFingerprint,
  parseArchitectureCognitiveMapCandidate,
  renderArchitectureCognitiveMapMarkdown,
  type ArchitectureCognitiveMap,
  type ArchitectureCognitiveMapDocument
} from "./architecture-cognitive-map.js";

export interface ProjectArchitectureSource {
  getProjectCodeEvidence?(input: { accountId: string; projectId: string }): Promise<CodeEvidenceSnapshot | null>;
  inspectProjectCodeEvidence?(input: { accountId: string; projectId: string }): Promise<{ snapshot: CodeEvidenceSnapshot; files: Array<{ path: string; hash: string }> } | null>;
  getProjectCodeCitations?(input: { accountId: string; projectId: string; refs: string[] }): Promise<CodeEvidenceItem[]>;
  listProjects(accountId: string): Promise<string[]>;
  listProjectArchitectureMarkdown(input: { accountId: string; projectId: string }): Promise<{ path: string; content: string }[]>;
  getProjectArchitecture(input: {
    accountId: string;
    projectId: string;
    query: string;
  }): Promise<ContextItem[]>;
  inspectProjectArchitecture(input: {
    accountId: string;
    projectId: string;
  }): Promise<ProjectArchitectureDocument | null>;
  writeProjectArchitecture(input: {
    accountId: string;
    projectId: string;
    expectedPath: string;
    expectedFingerprint: string;
    content: string;
  }): Promise<{ before: ProjectArchitectureDocument; after: ProjectArchitectureDocument }>;
  inspectProjectCognitiveMap(input: {
    accountId: string;
    projectId: string;
  }): Promise<ArchitectureCognitiveMapDocument>;
  writeProjectCognitiveMap(input: {
    accountId: string;
    projectId: string;
    expectedFingerprint: string;
    map: ArchitectureCognitiveMap;
  }): Promise<{ before: ArchitectureCognitiveMapDocument; after: ArchitectureCognitiveMapDocument }>;
}

export class NullProjectArchitectureSource implements ProjectArchitectureSource {
  async listProjects(): Promise<string[]> { return []; }
  async listProjectArchitectureMarkdown(): Promise<{ path: string; content: string }[]> { return []; }
  async getProjectArchitecture(): Promise<ContextItem[]> { return []; }
  async inspectProjectArchitecture(): Promise<null> { return null; }
  async writeProjectArchitecture(): Promise<never> { throw new Error("Project Architecture is disabled"); }
  async inspectProjectCognitiveMap(input: { projectId: string }): Promise<ArchitectureCognitiveMapDocument> {
    return { projectId: input.projectId, path: "", exists: false, map: null, fingerprint: architectureCognitiveMapFingerprint(null) };
  }
  async writeProjectCognitiveMap(): Promise<never> { throw new Error("Project Architecture is disabled"); }
}

export interface FileProjectArchitectureSourceOptions {
  rootDir: string;
  managedRootDir?: string;
  maxChars?: number;
}

/**
 * Project Architecture reader/writer. LITSAN-managed canonical documents live
 * under its private writable state root. Repository Markdown and legacy
 * `normify-<project>` trees remain read-only discovery/migration inputs.
 */
export class FileProjectArchitectureSource implements ProjectArchitectureSource {
  private readonly rootDir: string;
  private readonly managedRootDir: string;
  private readonly maxChars: number;
  private static readonly directoryCache = new Map<string, { expires: number; dirs: ArchitectureDir[] }>();

  constructor(options: FileProjectArchitectureSourceOptions) {
    this.rootDir = resolve(options.rootDir);
    this.managedRootDir = resolve(options.managedRootDir ?? join(this.rootDir, ".memhub-project-architecture"));
    this.maxChars = Math.max(1_000, options.maxChars ?? 16_000);
  }

  async listProjects(accountId: string): Promise<string[]> {
    const dirs = await this.architectureDirs(requireNonEmpty(accountId, "accountId"));
    return [...new Set(dirs.map((item) => item.projectId))].sort();
  }

  async getProjectCodeEvidence(input: { accountId: string; projectId: string }): Promise<CodeEvidenceSnapshot | null> {
    requireNonEmpty(input.accountId, "accountId");
    const projectId = validateProjectId(input.projectId);
    const workspace = await this.projectWorkspaceDir(projectId);
    return workspace ? scanCodeEvidence(workspace, projectId) : null;
  }

  async inspectProjectCodeEvidence(input: { accountId: string; projectId: string }): Promise<{ snapshot: CodeEvidenceSnapshot; files: Array<{ path: string; hash: string }> } | null> {
    requireNonEmpty(input.accountId, "accountId");
    const projectId = validateProjectId(input.projectId);
    const workspace = await this.projectWorkspaceDir(projectId);
    if (!workspace) return null;
    const files: Array<{ path: string; hash: string }> = [];
    const snapshot = await scanCodeEvidence(workspace, projectId, (path, hash) => files.push({ path, hash }));
    return { snapshot, files };
  }

  async getProjectCodeCitations(input: { accountId: string; projectId: string; refs: string[] }): Promise<CodeEvidenceItem[]> {
    const root = dirname(this.managedCognitiveMapPath(requireNonEmpty(input.accountId, "accountId"), input.projectId));
    const prefix = "code:" + validateProjectId(input.projectId) + ":";
    const wanted = new Set(input.refs);
    const revisions = [...new Set(input.refs.filter(ref => ref.startsWith(prefix)).map(ref => ref.slice(prefix.length).split(":")[0]!))]
      .filter(revision => /^[a-f0-9]{12}$/.test(revision)).slice(0, 40);
    const items: CodeEvidenceItem[] = [];
    for (const revision of revisions) {
      const text = await readFile(join(root, "code-evidence", revision + ".json"), "utf8").catch(error => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      });
      if (!text) continue;
      const snapshot = JSON.parse(text) as CodeEvidenceSnapshot;
      if (snapshot.project !== input.projectId || snapshot.revision !== revision || snapshot.version !== 1) throw new Error("invalid code snapshot identity");
      items.push(...snapshot.items.filter(item => wanted.has(item.ref) && item.ref.startsWith(prefix + revision + ":")));
    }
    return items;
  }

  /** Full Hard Architecture inputs, including repository docs when managed docs exist. */
  async listProjectArchitectureMarkdown(input: { accountId: string; projectId: string }): Promise<{ path: string; content: string }[]> {
    const accountId = requireNonEmpty(input.accountId, "accountId");
    const projectId = validateProjectId(input.projectId);
    const managedPath = this.managedArchitecturePath(accountId, projectId);
    const candidates = (await this.architectureDirs(accountId)).filter(item => sameProject(item.projectId, projectId));
    if (await fileExists(managedPath)) candidates.unshift({ projectId, dir: dirname(managedPath), scope: "memhub-managed", format: "managed-project-doc" });
    const workspaceDir = await this.projectWorkspaceDir(projectId);
    if (workspaceDir) candidates.push({ projectId, dir: workspaceDir, scope: "project-repo", format: "project-docs" });
    const rows = new Map<string, { path: string; content: string }>();
    for (const candidate of candidates) {
      for (const path of await architectureMarkdownFiles(candidate, projectId)) {
        const absolute = resolve(path);
        if (rows.has(absolute)) continue;
        rows.set(absolute, {
          path: candidate.scope + "/" + relative(candidate.dir, path).replaceAll("\\", "/"),
          content: await readFile(path, "utf8")
        });
      }
    }
    return [...rows.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  }

  async getProjectArchitecture(input: {
    accountId: string;
    projectId: string;
    query: string;
  }): Promise<ContextItem[]> {
    const accountId = requireNonEmpty(input.accountId, "accountId");
    const projectId = validateProjectId(input.projectId);
    const query = requireNonEmpty(input.query, "query");
    const managedPath = this.managedArchitecturePath(accountId, projectId);
    const cognitive = await this.inspectProjectCognitiveMap({ accountId, projectId });
    let candidates: ArchitectureDir[] = await fileExists(managedPath)
      ? [{ projectId, dir: dirname(managedPath), scope: "memhub-managed", format: "managed-project-doc" }]
      : (await this.architectureDirs(accountId))
        .filter((item) => sameProject(item.projectId, projectId));
    const managedCandidates = candidates.filter((item) => item.scope === "memhub-managed");
    if (managedCandidates.length > 0) candidates = managedCandidates;
    const queryTokens = tokens(query);
    const rows = [] as Array<{
      path: string;
      root: string;
      content: string;
      score: number;
      scope: ArchitectureDir["scope"];
      format: ArchitectureDir["format"];
    }>;
    for (const candidate of candidates) {
      const files = await architectureMarkdownFiles(candidate, projectId);
      for (const path of files) {
        const content = (await readFile(path, "utf8")).trim();
        if (!content) continue;
        const haystack = `${basename(path)}\n${content}`.toLocaleLowerCase();
        const score = queryTokens.reduce((sum, token) => sum + (haystack.includes(token) ? 1 : 0), 0) +
          (basename(path).toLocaleLowerCase() === "architecture.md" ? 0.75 : 0) +
          (basename(path) === "outline.md" ? 0.5 : 0) +
          (candidate.format === "managed-project-doc" ? 2 : 0) +
          (candidate.format === "project-docs" ? 0.25 : 0);
        rows.push({ path, root: candidate.dir, content, score, scope: candidate.scope, format: candidate.format });
      }
    }
    const uniqueRows = new Map<string, typeof rows[number]>();
    for (const row of rows) if (!uniqueRows.has(resolve(row.path))) uniqueRows.set(resolve(row.path), row);
    const rankedRows = [...uniqueRows.values()]
      .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));

    const cognitiveReserve = cognitive.exists && cognitive.map
      ? Math.min(6_000, Math.max(2_000, Math.floor(this.maxChars * 0.35)))
      : 0;
    let remaining = Math.max(0, this.maxChars - cognitiveReserve);
    const items: ContextItem[] = [];
    for (const row of rankedRows) {
      if (remaining <= 0) break;
      const clipped = row.content.slice(0, remaining);
      if (!clipped.trim()) continue;
      const relativePath = relative(row.root, row.path).replaceAll("\\", "/");
      items.push({
        id: `architecture:${projectId}:${createHash("sha256").update(`${row.format}\0${row.root}\0${relativePath}`).digest("hex").slice(0, 16)}`,
        content: `# ${relativePath}\n\n${clipped}`,
        authority: "authoritative",
        scope: "project",
        source: "project-architecture",
        projectId,
        provenance: {
          storage: row.scope,
          path: relativePath,
          format: row.format,
          ...(row.format === "normify-files" ? { legacyFormat: "normify-files" } : {})
        }
      });
      remaining -= clipped.length;
    }
    if (cognitive.exists && cognitive.map) {
        const allowance = cognitiveReserve + remaining;
        const rendered = renderArchitectureCognitiveMapMarkdown(cognitive.map).slice(0, allowance);
        if (rendered.trim()) {
          items.push({
            id: `architecture-cognitive:${projectId}:${cognitive.fingerprint.slice(0, 16)}`,
            content: rendered,
            authority: "derived",
            scope: "project",
            source: "project-architecture-cognitive-map",
            projectId,
            updatedAt: cognitive.map.generated_at,
            provenance: {
              storage: "memhub-managed",
              format: cognitive.map.contract,
              authority: "derived",
              abstraction_cutoff: cognitive.map.abstraction_cutoff,
              fingerprint: cognitive.fingerprint,
              source_evidence_refs: cognitive.map.source_evidence_refs
            }
          });
        }
    }
    return items;
  }

  async inspectProjectArchitecture(input: {
    accountId: string;
    projectId: string;
  }): Promise<ProjectArchitectureDocument | null> {
    const accountId = requireNonEmpty(input.accountId, "accountId");
    const projectId = validateProjectId(input.projectId);
    const path = this.managedArchitecturePath(accountId, projectId);
    const managedDir = dirname(path);
    try {
      const content = await readFile(path, "utf8");
      return architectureDocument(projectId, managedDir, path, true, content);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    }

    // First write may migrate an existing repository Architecture document
    // into LITSAN-managed state. The repository remains read-only; its current
    // body is only the reviewed seed and participates in the stale-plan hash.
    let seedContent = "";
    const workspaceDir = await this.projectWorkspaceDir(projectId);
    if (workspaceDir) {
      const external = await projectArchitectureMarkdownFiles(workspaceDir);
      if (external[0]) seedContent = await readFile(external[0], "utf8");
    }
    return architectureDocument(projectId, managedDir, path, false, seedContent);
  }

  async writeProjectArchitecture(input: {
    accountId: string;
    projectId: string;
    expectedPath: string;
    expectedFingerprint: string;
    content: string;
  }): Promise<{ before: ProjectArchitectureDocument; after: ProjectArchitectureDocument }> {
    requireNonEmpty(input.accountId, "accountId");
    const projectId = validateProjectId(input.projectId);
    const normalizedContent = normalizeArchitectureContent(input.content);
    const expectedPath = resolve(requireNonEmpty(input.expectedPath, "expectedPath"));
    if (expectedPath !== this.managedArchitecturePath(input.accountId.trim(), projectId)) {
      throw new Error("Project Architecture target changed after plan; create a fresh plan");
    }
    return withFileMutationLock(expectedPath, async () => {
      const before = await this.inspectProjectArchitecture({ accountId: input.accountId, projectId });
      if (!before) throw new Error(`no canonical workspace found for project: ${projectId}`);
      if (resolve(before.path) !== expectedPath) {
        throw new Error("Project Architecture target changed after plan; create a fresh plan");
      }
      if (before.fingerprint !== input.expectedFingerprint) {
        throw new Error("Project Architecture changed after plan; create a fresh plan");
      }
      await mkdir(dirname(expectedPath), { recursive: true, mode: 0o700 });
      const tmp = `${expectedPath}.tmp-${process.pid}-${Date.now()}`;
      await writeFile(tmp, normalizedContent, { encoding: "utf8", mode: 0o600 });
      await rename(tmp, expectedPath);
      FileProjectArchitectureSource.directoryCache.clear();
      const after = await this.inspectProjectArchitecture({ accountId: input.accountId, projectId });
      if (!after || resolve(after.path) !== expectedPath) {
        throw new Error("Project Architecture write completed but canonical document could not be re-read");
      }
      return { before, after };
    });
  }

  async inspectProjectCognitiveMap(input: {
    accountId: string;
    projectId: string;
  }): Promise<ArchitectureCognitiveMapDocument> {
    const accountId = requireNonEmpty(input.accountId, "accountId");
    const projectId = validateProjectId(input.projectId);
    const path = this.managedCognitiveMapPath(accountId, projectId);
    try {
      const raw = JSON.parse(await readFile(path, "utf8")) as ArchitectureCognitiveMap;
      if (raw.project_id !== projectId || raw.contract !== "memhub-architecture-cognitive-map-v1" || raw.authority !== "derived") {
        throw new Error("invalid Project Architecture Cognitive Map identity");
      }
      parseArchitectureCognitiveMapCandidate(raw);
      return { projectId, path, exists: true, map: raw, fingerprint: architectureCognitiveMapFingerprint(raw) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
      return { projectId, path, exists: false, map: null, fingerprint: architectureCognitiveMapFingerprint(null) };
    }
  }

  async writeProjectCognitiveMap(input: {
    accountId: string;
    projectId: string;
    expectedFingerprint: string;
    map: ArchitectureCognitiveMap;
  }): Promise<{ before: ArchitectureCognitiveMapDocument; after: ArchitectureCognitiveMapDocument }> {
    const accountId = requireNonEmpty(input.accountId, "accountId");
    const projectId = validateProjectId(input.projectId);
    if (input.map.project_id !== projectId || input.map.authority !== "derived") {
      throw new Error("Project Architecture Cognitive Map identity mismatch");
    }
    const path = this.managedCognitiveMapPath(accountId, projectId);
    return withFileMutationLock(path, async () => {
      const before = await this.inspectProjectCognitiveMap({ accountId, projectId });
      if (before.fingerprint !== input.expectedFingerprint) {
        throw new Error("Project Architecture Cognitive Map changed after it was read; retry from the latest map");
      }
      let map = input.map;
      const refs = [...map.source_evidence_refs, ...map.nodes.flatMap(n => [...n.evidence_refs, ...(n.facets?.layer_evidence_refs ?? []), ...(n.facts ?? []).flatMap(f => f.evidence_refs)]),
        ...map.edges.flatMap(e => e.evidence_refs), ...map.timeline_links.flatMap(l => l.evidence_refs)];
      if (refs.some(ref => ref.startsWith("code:"))) {
        const code = await this.getProjectCodeEvidence({ accountId, projectId });
        const allowed = new Set(code?.items.map(item => item.ref));
        const historical = refs.filter(ref => ref.startsWith("code:") && !allowed.has(ref));
        const retained = new Set(before.map?.source_evidence_refs);
        const snapshots = await this.getProjectCodeCitations({ accountId, projectId, refs: historical });
        const backed = new Set(snapshots.map(item => item.ref));
        if (historical.some(ref => !retained.has(ref) || !backed.has(ref))) throw new Error("stale or foreign code evidence; request a fresh bootstrap package");
        validateHistoricalCodeOwners(map, before.map, new Set(historical));
        const candidate = applyCodeLayers(map, code, before.map);
        map = { ...map, ...candidate };
        if (!candidate.facet_vocab) delete map.facet_vocab;
        map.source_evidence_refs = [...new Set([...map.source_evidence_refs, ...map.nodes.flatMap(node => node.facets?.layer_evidence_refs ?? [])])];
        if (code && refs.some(ref => allowed.has(ref))) {
          const snapshotDir = join(dirname(path), "code-evidence");
          await mkdir(snapshotDir, { recursive: true, mode: 0o700 });
          const snapshotPath = join(snapshotDir, code.revision + ".json");
          const text = JSON.stringify(code) + "\n";
          try {
            if (await readFile(snapshotPath, "utf8") !== text) throw new Error("code snapshot identity collision");
          }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            // The project fence serializes writers; publish a complete snapshot before its map can reference it.
            const tmp = `${snapshotPath}.tmp-${process.pid}-${Date.now()}`;
            await writeFile(tmp, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
            await rename(tmp, snapshotPath);
          }
        }
      }
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
      await writeFile(tmp, `${JSON.stringify(map, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(tmp, path);
      const after = await this.inspectProjectCognitiveMap({ accountId, projectId });
      return { before, after };
    });
  }

  private async architectureDirs(accountId: string): Promise<ArchitectureDir[]> {
    const cacheKey = JSON.stringify([this.rootDir, this.managedRootDir, accountId]);
    const cached = FileProjectArchitectureSource.directoryCache.get(cacheKey);
    if (cached && cached.expires > Date.now()) return cached.dirs;
    const results: ArchitectureDir[] = [];
    const managedAccountRoot = join(this.managedRootDir, accountHash(accountId));
    for (const dir of await childDirs(managedAccountRoot)) {
      const projectId = managedProjectIdFromDir(dir);
      if (projectId && (await fileExists(join(dir, "ARCHITECTURE.md")) || await fileExists(join(dir, "COGNITIVE_MAP.json")))) {
        results.push({ projectId, dir, scope: "memhub-managed", format: "managed-project-doc" });
      }
    }
    const accountRoot = join(this.rootDir, ".normify", "accounts", accountHash(accountId));
    for (const dir of await childArchitectureDirs(accountRoot)) {
      results.push({ projectId: projectIdFromDir(dir), dir, scope: "account-scoped", format: "normify-files" });
    }
    for (const dir of await childArchitectureDirs(this.rootDir)) {
      results.push({ projectId: projectIdFromDir(dir), dir, scope: "legacy-repo-local", format: "normify-files" });
    }
    if (await hasProjectArchitectureDocs(this.rootDir)) {
      results.push({ projectId: basename(this.rootDir), dir: this.rootDir, scope: "project-repo", format: "project-docs" });
    }
    for (const child of await childDirs(this.rootDir)) {
      if (basename(child) === ".normify") continue;
      for (const dir of await childArchitectureDirs(child)) {
        results.push({ projectId: projectIdFromDir(dir), dir, scope: "legacy-repo-local", format: "normify-files" });
      }
      if (await isProjectRepositoryRoot(child) && await hasProjectArchitectureDocs(child)) {
        results.push({ projectId: basename(child), dir: child, scope: "project-repo", format: "project-docs" });
      }
    }
    // Architecture roots often point at a home or shared parent directory.
    // Discover one extra level only inside directories whose names explicitly
    // identify them as workspace containers. This keeps nested project support
    // without baking a host-specific container name into the runtime.
    for (const workspaceContainer of await workspaceContainers(this.rootDir)) {
      for (const child of await childDirs(workspaceContainer)) {
        if (await hasProjectArchitectureDocs(child)) {
          results.push({ projectId: basename(child), dir: child, scope: "project-repo", format: "project-docs" });
          continue;
        }
        const nestedWorkspace = await singleNestedProjectWorkspace(child);
        if (nestedWorkspace) {
          results.push({ projectId: basename(child), dir: nestedWorkspace, scope: "project-repo", format: "project-docs" });
        }
      }
    }
    const unique = new Map<string, typeof results[number]>();
    for (const item of results) {
      const key = `${item.scope}\0${item.projectId}`;
      if (!unique.has(key)) unique.set(key, item);
    }
    const dirs = [...unique.values()].sort((a, b) =>
      (a.scope === b.scope ? 0 : a.scope === "memhub-managed" ? -1 : b.scope === "memhub-managed" ? 1 : a.scope === "account-scoped" ? -1 : 1) ||
      a.projectId.localeCompare(b.projectId)
    );
    FileProjectArchitectureSource.directoryCache.set(cacheKey, { expires: Date.now() + 30_000, dirs });
    return dirs;
  }

  private managedArchitecturePath(accountId: string, projectId: string): string {
    const accountRoot = join(this.managedRootDir, accountHash(accountId));
    const path = resolve(accountRoot, encodeURIComponent(validateProjectId(projectId)), "ARCHITECTURE.md");
    const rel = relative(accountRoot, path);
    if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) {
      throw new Error("Project Architecture path must stay inside the account directory");
    }
    return path;
  }

  private managedCognitiveMapPath(accountId: string, projectId: string): string {
    const accountRoot = join(this.managedRootDir, accountHash(accountId));
    const path = resolve(accountRoot, encodeURIComponent(validateProjectId(projectId)), "COGNITIVE_MAP.json");
    const rel = relative(accountRoot, path);
    if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) {
      throw new Error("Project Architecture Cognitive Map path must stay inside the account directory");
    }
    return path;
  }

  private async projectWorkspaceDir(projectId: string): Promise<string | null> {
    const wanted = normalizeProjectFolder(projectId);
    if (normalizeProjectFolder(basename(this.rootDir)) === wanted && await dirExists(this.rootDir)) {
      return this.rootDir;
    }
    // Canonical engineering workspaces take precedence over home-directory
    // state such as ~/.memhub. Never let a hidden state directory become a
    // Project Architecture write target merely because its basename matches.
    for (const workspaceContainer of await workspaceContainers(this.rootDir)) {
      for (const child of await childDirs(workspaceContainer)) {
        if (normalizeProjectFolder(basename(child)) !== wanted) continue;
        if (await isProjectRepositoryRoot(child) || await hasProjectArchitectureDocs(child)) return child;
        const nestedWorkspace = await singleNestedProjectWorkspace(child);
        if (nestedWorkspace) return nestedWorkspace;
      }
    }
    for (const child of await childDirs(this.rootDir)) {
      if (basename(child).startsWith(".")) continue;
      if (normalizeProjectFolder(basename(child)) !== wanted) continue;
      if (await isProjectRepositoryRoot(child) || await hasProjectArchitectureDocs(child)) return child;
    }
    return null;
  }
}

async function workspaceContainers(rootDir: string): Promise<string[]> {
  const containers: string[] = [];
  for (const child of await childDirs(rootDir)) {
    const name = basename(child).toLowerCase();
    if (name.startsWith(".")) continue;
    if (/(^|[-_])workspaces?$/.test(name)) containers.push(child);
  }
  return containers;
}

async function singleNestedProjectWorkspace(projectContainer: string): Promise<string | null> {
  const candidates: string[] = [];
  for (const child of await childDirs(projectContainer)) {
    if (basename(child).startsWith(".")) continue;
    if (!await hasProjectArchitectureDocs(child)) continue;
    if (!await isProjectRepositoryRoot(child)) continue;
    candidates.push(child);
  }
  if (candidates.length <= 1) return candidates[0] ?? null;

  // Canonical project containers may deliberately hold both a private
  // runtime/development repository and a sanitized publish repository. Prefer
  // the conventional <project>runtime (or plain runtime) child; if that does
  // not resolve the ambiguity uniquely, fail closed instead of guessing.
  const projectName = normalizeProjectFolder(basename(projectContainer));
  const preferred = candidates.filter((child) => {
    const name = normalizeProjectFolder(basename(child));
    return name === `${projectName}runtime` || name === "runtime";
  });
  return preferred.length === 1 ? preferred[0]! : null;
}

interface ArchitectureDir {
  projectId: string;
  dir: string;
  scope: "memhub-managed" | "account-scoped" | "legacy-repo-local" | "project-repo";
  format: "managed-project-doc" | "normify-files" | "project-docs";
}

async function architectureMarkdownFiles(candidate: ArchitectureDir, projectId: string): Promise<string[]> {
  if (candidate.format === "managed-project-doc") {
    const path = join(candidate.dir, "ARCHITECTURE.md");
    return await fileExists(path) ? [path] : [];
  }
  if (candidate.format === "project-docs") return projectArchitectureMarkdownFiles(candidate.dir);
  const root = candidate.dir;
  const files: string[] = [];
  const outline = join(root, "outline.md");
  if (await fileExists(outline)) files.push(outline);
  const moduleRoots = [join(root, "modules", projectId), join(root, "modules")];
  for (const moduleRoot of moduleRoots) {
    for (const file of await markdownFiles(moduleRoot, 3)) {
      if (!files.includes(file)) files.push(file);
    }
    if (files.length > (await fileExists(outline) ? 1 : 0)) break;
  }
  return files;
}

async function projectArchitectureMarkdownFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const path of [
    join(root, "ARCHITECTURE.md"),
    join(root, "docs", "ARCHITECTURE.md"),
    join(root, "docs", "architecture.md")
  ]) {
    if (await fileExists(path) && !files.includes(path)) files.push(path);
  }
  for (const file of await markdownFiles(join(root, "docs", "architecture"), 2)) {
    if (!files.includes(file)) files.push(file);
  }
  return files;
}

async function hasProjectArchitectureDocs(root: string): Promise<boolean> {
  return (await projectArchitectureMarkdownFiles(root)).length > 0;
}

function architectureDocument(
  projectId: string,
  workspaceDir: string,
  path: string,
  exists: boolean,
  content: string
): ProjectArchitectureDocument {
  const normalized = content;
  return {
    projectId,
    workspaceDir,
    path,
    relativePath: relative(workspaceDir, path).replaceAll("\\", "/"),
    exists,
    content: normalized,
    fingerprint: createHash("sha256").update(`${exists ? "1" : "0"}\0${normalized}`, "utf8").digest("hex")
  };
}

function managedProjectIdFromDir(dir: string): string | null {
  try {
    const decoded = decodeURIComponent(basename(dir));
    return validateProjectId(decoded);
  } catch {
    return null;
  }
}

function normalizeArchitectureContent(value: string): string {
  const normalized = value.replace(/\r\n/g, "\n").trim();
  if (!normalized) throw new TypeError("Project Architecture content must be non-empty");
  return `${normalized}\n`;
}

function normalizeProjectFolder(value: string): string {
  return value.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "");
}

async function dirExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return false;
    throw error;
  }
}

async function isProjectRepositoryRoot(root: string): Promise<boolean> {
  for (const marker of [".git", "package.json", "pyproject.toml", "Cargo.toml", "go.mod"]) {
    try {
      const info = await stat(join(root, marker));
      if (marker === ".git" ? info.isDirectory() || info.isFile() : info.isFile()) return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    }
  }
  return false;
}

async function markdownFiles(root: string, depth: number): Promise<string[]> {
  if (depth < 0) return [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(root, entry.name);
    if (entry.isFile() && entry.name.endsWith(".md")) files.push(path);
    else if (entry.isDirectory() && depth > 0) files.push(...await markdownFiles(path, depth - 1));
  }
  return files;
}

async function childArchitectureDirs(root: string): Promise<string[]> {
  return (await childDirs(root)).filter((dir) => basename(dir).startsWith("normify-"));
}

async function childDirs(root: string): Promise<string[]> {
  try {
    return (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, entry.name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw error;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return false;
    throw error;
  }
}

function projectIdFromDir(dir: string): string {
  return basename(dir).slice("normify-".length);
}

function sameProject(left: string, right: string): boolean {
  return left.normalize("NFKC").toLocaleLowerCase() === right.normalize("NFKC").toLocaleLowerCase();
}

function tokens(value: string): string[] {
  return [...new Set(value.toLocaleLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter((item) => item.length >= 2))];
}

function accountHash(accountId: string): string {
  return createHash("sha256").update(accountId, "utf8").digest("hex");
}

function requireNonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${field} must be non-empty`);
  return normalized;
}
