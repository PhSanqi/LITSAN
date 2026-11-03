import { createHash } from "node:crypto";

/** @implements {import('../../dist/core/ports/projects.js').ProjectReader} @implements {import('../../dist/core/ports/projects.js').ProjectWriter} */
export class FakeProjectStore {
  calls = [];
  records = new Map();

  constructor(projects = [], accountId = "acct") {
    for (const project of projects) this.records.set(`${accountId}:${project.projectId}`, {
      name: project.projectId, description: "project", aliases: [], state: "active",
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", ...structuredClone(project)
    });
  }

  async list(accountId, options = {}) {
    this.calls.push({ method: "list", accountId, options });
    return structuredClone([...this.records.entries()].filter(([key, item]) => key.startsWith(`${accountId}:`) &&
      (options.includeInactive || item.state === "active" || options.includeArchived && item.state === "archived"))
      .map(([, item]) => item));
  }

  async resolve(accountId, reference, options = {}) {
    this.calls.push({ method: "resolve", accountId, reference, options });
    const project = [...this.records.entries()].find(([key, item]) => key.startsWith(`${accountId}:`) &&
      (item.projectId === reference || item.name === reference || item.aliases.includes(reference)));
    if (!project) return null;
    const item = project[1];
    if (item.state === "merged") return this.resolve(accountId, item.mergedInto, options);
    return item.state === "active" || options.includeArchived && item.state === "archived" ? item.projectId : null;
  }

  async suggest(accountId, query, limit = 6, options = {}) {
    this.calls.push({ method: "suggest", accountId, query, limit, options });
    return (await this.list(accountId, options)).filter(item => item.projectId.includes(query))
      .slice(0, limit).map(item => ({ ...item, similarity: 1, matchedBy: "fake" }));
  }

  async storageIds(accountId, projectId) {
    this.calls.push({ method: "storageIds", accountId, projectId });
    const aliases = [...this.records.entries()].filter(([key, item]) => key.startsWith(`${accountId}:`) && item.state === "merged" && item.mergedInto === projectId).map(([, item]) => item.projectId);
    return [projectId, ...aliases];
  }

  async create(accountId, input) {
    this.calls.push({ method: "create", accountId, input: structuredClone(input) });
    if (this.records.has(`${accountId}:${input.projectId}`)) throw new Error("project already exists");
    const record = { state: "active", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      ...structuredClone(input), name: input.name ?? input.projectId, aliases: structuredClone(input.aliases ?? []) };
    this.records.set(`${accountId}:${record.projectId}`, record);
    return structuredClone(record);
  }

  async update(accountId, projectId, patch) {
    this.calls.push({ method: "update", accountId, projectId, patch: structuredClone(patch) });
    const record = this.records.get(`${accountId}:${projectId}`);
    if (!record) throw new Error("unknown project");
    Object.assign(record, structuredClone(patch), { updatedAt: new Date().toISOString() });
    return structuredClone(record);
  }

  async delete(accountId, projectId) { this.calls.push({ method: "delete", accountId, projectId }); return this.update(accountId, projectId, { state: "deleted" }); }
  async archive(accountId, projectId) { this.calls.push({ method: "archive", accountId, projectId }); return this.update(accountId, projectId, { state: "archived" }); }
  async unarchive(accountId, projectId) { this.calls.push({ method: "unarchive", accountId, projectId }); return this.update(accountId, projectId, { state: "active" }); }
  async merge(accountId, sourceId, targetId) {
    this.calls.push({ method: "merge", accountId, sourceId, targetId });
    const source = await this.update(accountId, sourceId, { state: "merged", mergedInto: targetId });
    return { source, target: structuredClone(this.records.get(`${accountId}:${targetId}`)) };
  }
  async addTodo(accountId, projectId, text, todoId) {
    this.calls.push({ method: "addTodo", accountId, projectId, text, ...(todoId === undefined ? {} : { todoId }) });
    const record = this.records.get(`${accountId}:${projectId}`);
    const id = todoId === undefined ? undefined : todoId.trim().toLowerCase();
    if (id !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) throw new TypeError("add todo_id must be a UUID");
    const existing = id && (record.todos ?? []).find(todo => todo.id === id);
    if (existing) {
      if (existing.text !== text) throw new Error("todo_id already in use for different text");
      return structuredClone(record);
    }
    if (id && [...this.records.entries()].some(([key, project]) => key.startsWith(`${accountId}:`) && key !== `${accountId}:${projectId}` && project.todos?.some(todo => todo.id === id))) throw new Error("todo_id already in use");
    const now = new Date().toISOString();
    return this.update(accountId, projectId, { todos: [...(record.todos ?? []), {
      id: id ?? `todo-${(record.todos ?? []).length + 1}`, text, status: "pending", createdAt: now, updatedAt: now
    }] });
  }
  async setTodoStatus(accountId, projectId, todoId, status) {
    this.calls.push({ method: "setTodoStatus", accountId, projectId, todoId, status });
    const record = this.records.get(`${accountId}:${projectId}`);
    const selected = record.todos.find(todo => todo.id === todoId)
      ?? (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(todoId)
        ? record.todos.find(todo => todo.id === todoId.toLowerCase()) : undefined);
    if (!selected) throw new Error(`project todo not found: ${todoId}`);
    return this.update(accountId, projectId, { todos: record.todos.map(todo => todo.id === selected.id ? { ...todo, status } : todo) });
  }
  async updateDistilledDescription(accountId, projectId, description, evidenceRefs = []) {
    this.calls.push({ method: "updateDistilledDescription", accountId, projectId, description, evidenceRefs: [...evidenceRefs] });
    return this.update(accountId, projectId, { distilledDescription: description, descriptionEvidenceRefs: [...evidenceRefs] });
  }
}

/** @implements {import('../../dist/core/ports/memory.js').MemoryViewerReader} @implements {import('../../dist/core/ports/memory.js').MemoryViewerWriter} @implements {import('../../dist/core/ports/memory.js').MemoryDistiller} @implements {import('../../dist/core/ports/memory.js').TurnSessionWriter} @implements {import('../../dist/core/ports/memory.js').CaptureEvidenceReader} */
export class FakeMemoryEngine {
  calls = [];
  responses = new Map();
  sessions = new Map();
  turns = new Map();
  artifacts = [];
  captures = [];
  async viewerGet(path, timeoutMs) {
    this.calls.push({ method: "viewerGet", path, timeoutMs });
    return structuredClone(this.responses.get(path) ?? { items: [], hasNext: false });
  }
  async viewerPost(path, body = {}, timeoutMs) {
    this.calls.push({ method: "viewerPost", path, body: structuredClone(body), timeoutMs });
    this.responses.set(path, structuredClone(body));
    return structuredClone(body);
  }
  async viewerDelete(path, timeoutMs) {
    this.calls.push({ method: "viewerDelete", path, timeoutMs });
    return { deleted: this.responses.delete(path) };
  }
  async openSession(request) {
    this.calls.push({ method: "openSession", request: structuredClone(request) });
    const session = { id: `session-${this.sessions.size + 1}`, ...structuredClone(request) };
    this.sessions.set(session.id, session);
    return structuredClone(session);
  }
  async completeTurn(turnId, request) {
    this.calls.push({ method: "completeTurn", turnId, request: structuredClone(request) });
    this.turns.set(turnId, structuredClone(request));
    return { turnId, ...structuredClone(request) };
  }
  async distill(input) {
    this.calls.push({ method: "distill", input: structuredClone(input) });
    const artifact = { id: `memory-${this.artifacts.length + 1}`, ...structuredClone(input) };
    this.artifacts.push(artifact);
    return structuredClone(artifact);
  }
  async listCaptureEvents(stateRoot, accountId) {
    this.calls.push({ method: "listCaptureEvents", stateRoot, accountId });
    return structuredClone(this.captures.filter(item => !accountId || item.account_id === accountId));
  }
}

/** @implements {import('../../dist/core/ports/distillation.js').DistillationJobReader} */
export class FakeDistillationJobReader {
  calls = [];
  constructor(jobs = []) { this.jobs = structuredClone(jobs); }
  async listDistillationJobs(stateRoot, accountId, includeRetired = false) {
    this.calls.push({ method: "listDistillationJobs", stateRoot, accountId, includeRetired });
    return structuredClone(this.jobs.filter(job => (!accountId || job.account_id === accountId) && (includeRetired || !job.result_retirement))
      .sort((a, b) => b.created_at.localeCompare(a.created_at)));
  }
}

/** @implements {import('../../dist/core/ports/architecture.js').ArchitectureReader} @implements {import('../../dist/core/ports/architecture.js').ArchitectureWriter} @implements {import('../../dist/core/ports/architecture.js').ArchitectureRevisionStore} */
export class FakeArchitectureStore {
  calls = [];
  documents = new Map();
  maps = new Map();
  revisions = new Map();
  commitError = null;
  constructor(documents = [], accountId = "acct") {
    for (const document of documents) this.documents.set(`${accountId}:${document.projectId}`, structuredClone(document));
  }
  async inspectProjectArchitecture(input) {
    this.calls.push({ method: "inspectProjectArchitecture", input: structuredClone(input) });
    return structuredClone(this.documents.get(`${input.accountId}:${input.projectId}`) ?? null);
  }
  async getProjectArchitecture(input) {
    this.calls.push({ method: "getProjectArchitecture", input: structuredClone(input) });
    const document = await this.inspectProjectArchitecture(input);
    return document ? [{ id: document.path, content: document.content, authority: "authoritative", scope: "project",
      source: "project-architecture", projectId: input.projectId }] : [];
  }
  async inspectProjectCognitiveMap(input) {
    this.calls.push({ method: "inspectProjectCognitiveMap", input: structuredClone(input) });
    return structuredClone(this.maps.get(`${input.accountId}:${input.projectId}`) ?? {
      projectId: input.projectId, path: `${input.projectId}/map.json`, exists: false, map: null, fingerprint: "missing"
    });
  }
  async writeProjectArchitecture(input) {
    this.calls.push({ method: "writeProjectArchitecture", input: structuredClone(input) });
    const before = await this.inspectProjectArchitecture(input);
    if (!before || before.path !== input.expectedPath || before.fingerprint !== input.expectedFingerprint) throw new Error("architecture write fence changed");
    const after = { ...before, exists: true, content: input.content, fingerprint: createHash("sha256").update(input.content).digest("hex") };
    this.documents.set(`${input.accountId}:${input.projectId}`, after);
    return { before, after: structuredClone(after) };
  }
  async writeProjectCognitiveMap(input) {
    this.calls.push({ method: "writeProjectCognitiveMap", input: structuredClone(input) });
    const before = await this.inspectProjectCognitiveMap(input);
    if (before.fingerprint !== input.expectedFingerprint) throw new Error("cognitive map write fence changed");
    const after = { ...before, exists: true, map: structuredClone(input.map), fingerprint: createHash("sha256").update(JSON.stringify(input.map)).digest("hex") };
    this.maps.set(`${input.accountId}:${input.projectId}`, after);
    return { before, after: structuredClone(after) };
  }
  async prepareArchitectureRevision(input) {
    this.calls.push({ method: "prepareArchitectureRevision", input: structuredClone(input) });
    const record = { revision_id: `revision-${this.revisions.size + 1}`, account_id: input.accountId, project_id: input.projectId,
      path: input.path, before_exists: input.beforeExists, before_fingerprint: input.beforeFingerprint, before_content: input.beforeContent,
      proposed_content: input.proposedContent, proposed_sha256: createHash("sha256").update(input.proposedContent).digest("hex"),
      status: "prepared", created_at: new Date().toISOString() };
    this.revisions.set(record.revision_id, record);
    return structuredClone(record);
  }
  async commitArchitectureRevision(input) {
    this.calls.push({ method: "commitArchitectureRevision", input: structuredClone(input) });
    if (this.commitError) throw this.commitError;
    const record = this.revisions.get(input.revisionId);
    if (!record || record.account_id !== input.accountId || record.project_id !== input.projectId) throw new Error("Architecture revision scope mismatch");
    Object.assign(record, { status: "committed", committed_at: new Date().toISOString(), after_fingerprint: input.afterFingerprint });
    return structuredClone(record);
  }
}
