import type { AccountId, UserId } from "../../contracts/identity.js";
import type { ProjectDescriptor } from "../../contracts/projects.js";
import type { ProjectReader } from "../../core/ports/projects.js";
import type { MemoryViewerReader } from "../../core/ports/memory.js";

export function requiredString(value: unknown, field: string): string {
  const normalized = optionalString(value);
  if (!normalized) throw new TypeError(`${field} is required`);
  return normalized;
}

export function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized ? normalized : undefined;
}

export function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export async function assertManagedMemory(runtime: { userId: UserId; memoryClient: MemoryViewerReader }, memoryId: string): Promise<void> {
  for (const kind of ["l2", "l3", "l4", "skills"] as const) {
    for (let page = 1; ; page++) {
      const params = new URLSearchParams({ limit: "100", page: String(page), userId: runtime.userId });
      const payload = objectRecord(await runtime.memoryClient.viewerGet(`/api/v1/${kind}?${params}`));
      const items = Array.isArray(payload.items) ? payload.items : [];
      if (items.some((item) => objectRecord(item).id === memoryId)) return;
      if (payload.hasNext !== true && !(typeof payload.totalPages === "number" && page < payload.totalPages)) break;
      if (!items.length) break;
    }
  }
  throw new Error(`managed memory not found for account: ${memoryId}`);
}

export function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
  return values.length ? [...new Set(values)] : undefined;
}

export function uniqueStrings(values: string[]): string[] | undefined {
  const normalized = values.map((value) => value.trim()).filter(Boolean);
  return normalized.length ? [...new Set(normalized)] : undefined;
}

export async function knownProjectRecords(runtime: { accountId: AccountId; projects: Pick<ProjectReader, "list"> }): Promise<ProjectDescriptor[]> {
  return runtime.projects.list(runtime.accountId);
}

export function projectSummaryForModel(project: ProjectDescriptor): Record<string, unknown> {
  const chars = Array.from(project.description);
  return {
    project: project.projectId,
    name: project.name,
    aliases: project.aliases,
    state: project.state,
    descriptionSource: project.descriptionSource ?? (project.description ? "legacy" : "empty"),
    description: chars.slice(0, 280).join(""),
    ...(chars.length > 280 ? { descriptionTruncated: true } : {}),
    pendingTodoCount: (project.todos ?? []).filter((todo) => todo.status === "pending").length
  };
}

export function projectForModel(project: ProjectDescriptor): Record<string, unknown> {
  const todos = project.todos ?? [];
  return {
    project: project.projectId,
    name: project.name,
    description: project.description,
    descriptionSource: project.descriptionSource ?? (project.description ? "legacy" : "empty"),
    ...(project.distilledDescription ? { distilledDescription: project.distilledDescription } : {}),
    ...(project.descriptionEvidenceRefs ? { descriptionEvidenceRefs: project.descriptionEvidenceRefs } : {}),
    ...(project.descriptionUpdatedAt ? { descriptionUpdatedAt: project.descriptionUpdatedAt } : {}),
    todos,
    pendingTodos: todos.filter((todo) => todo.status === "pending"),
    pendingTodoCount: todos.filter((todo) => todo.status === "pending").length,
    aliases: project.aliases,
    state: project.state,
    ...(project.mergedInto ? { mergedInto: project.mergedInto } : {}),
    descriptionMissing: !project.description,
    updatedAt: project.updatedAt
  };
}

export function optionalInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : undefined;
}

export function optionalBoolean(value: unknown): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new TypeError("value must be a boolean");
  return value;
}

export const CLIENT_PROFILE_SCHEMA = { type: "object", additionalProperties: false, properties: {
  execution: { type: "string", enum: ["inline", "delegate", "background"] }, max_card_tokens: { type: "integer", minimum: 500, maximum: 8000 },
  cards_per_turn: { type: "integer", minimum: 0, maximum: 5, description: "Legacy client preference; automatic queue-driven counts are server-controlled." }, model: { type: "string", maxLength: 80 },
  availability: { type: "string", enum: ["busy", "available", "unknown"], description: "Deprecated compatibility field; ignored by queue-driven automatic allocation." },
  available_tokens: { type: "integer", minimum: 0, maximum: 24000, description: "Deprecated compatibility field; ignored by queue-driven automatic allocation." }
} };

export { parseWorkstreamHint } from "../../core/workstream/binding.js";
// Validation depends on the resolved project's flag, so the transport must
// admit malformed hints for the handler to ignore when workstreams are off.
export const WORKSTREAM_SCHEMA = {
  description: "Workstream hint; validated only for a resolved project with workstreams enabled.",
  anyOf: [{
  type: "object", additionalProperties: false,
  properties: {
    git_branch: { type: "string", maxLength: 300 },
    git_default_branch: { type: "string", maxLength: 300 },
    worktree: { type: "string", maxLength: 300, description: "Linked git worktree path, not the main checkout. LITSAN does not inspect the filesystem." },
    continuity_id: { type: "string", maxLength: 300 },
    label: { type: "string", maxLength: 80 }
  }
  }, {}]
};

export type ToolOutput = { kind: "json"; value: unknown; pretty?: boolean } | { kind: "inline"; value: unknown; pretty?: boolean };
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run(args: Record<string, unknown>): Promise<ToolOutput>;
}
export interface CatalogContext { stateRoot: string }
export function jsonResult(value: unknown, pretty?: boolean): ToolOutput { return { kind: "json", value, ...(pretty === undefined ? {} : { pretty }) }; }
export function inlineJsonResult(value: unknown, pretty?: boolean): ToolOutput { return { kind: "inline", value, ...(pretty === undefined ? {} : { pretty }) }; }
