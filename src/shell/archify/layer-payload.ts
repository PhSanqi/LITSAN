import type { MemoryViewerReader } from "../../core/ports/memory.js";

/** Shared body loader for the Project Map HTTP route and map bootstrap. */
export async function loadLayerPayload(input: {
  memoryClient: MemoryViewerReader;
  userId: string;
  projectId?: string;
  kind: "l2" | "l3" | "l4" | "skills";
  hydrateBody: boolean;
  includeItem?: (item: Record<string, unknown>) => boolean;
}): Promise<{ payload: Record<string, unknown>; items: Record<string, unknown>[] }> {
  let payload: Record<string, unknown> = {};
  const items: Record<string, unknown>[] = [];
  for (let page = 1; page <= 100 && items.length < 100; page += 1) {
    const params = new URLSearchParams({ limit: "100", page: String(page), userId: input.userId });
    if (input.projectId && input.kind !== "l4") params.set("projectId", input.projectId);
    params.set("status", "activated");
    if (input.hydrateBody && input.kind !== "skills") params.set("includeBody", "1");
    const pagePayload = objectRecord(await input.memoryClient.viewerGet(`/api/v1/${input.kind}?${params.toString()}`));
    if (page === 1) payload = pagePayload;
    const pageItems = Array.isArray(pagePayload.items) ? pagePayload.items.map(objectRecord) : [];
    items.push(...pageItems.filter(item => !input.includeItem || input.includeItem(item)));
    if (pagePayload.hasNext !== true || pageItems.length === 0 || !input.hydrateBody) break;
  }
  return { payload, items: items.slice(0, 100) };
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
