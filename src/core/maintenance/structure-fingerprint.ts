import { createHash } from "node:crypto";
import type { ArchitectureCognitiveMap } from "../../contracts/project-model.js";
export function structureFingerprint(map: ArchitectureCognitiveMap | null): string {
  return createHash("sha256").update(map ? JSON.stringify({
    nodes: [...map.nodes].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map(({ id, kind, label, summary, parent_id, order }) => ({ id, kind, label, summary, parent_id, order })),
    edges: map.edges.map(({ from, to, type }) => ({ from, to, type })).sort((a, b) => JSON.stringify([a.from, a.to, a.type]) < JSON.stringify([b.from, b.to, b.type]) ? -1 : JSON.stringify([a.from, a.to, a.type]) > JSON.stringify([b.from, b.to, b.type]) ? 1 : 0)
  }) : "<missing>").digest("hex");
}
export function chunkFingerprint(evidenceHash: string, refs: string[]): string {
  return createHash("sha256").update(JSON.stringify([evidenceHash, refs])).digest("hex");
}
/** Evidence order and duplicates do not change a node's evidence identity. */
export function nodeEvidenceHash(node: Pick<import("../../contracts/project-model.js").ArchitectureCognitiveNode, "evidence_refs">): string {
  return createHash("sha256").update(JSON.stringify([...new Set(node.evidence_refs)].sort())).digest("hex");
}
export function gapCheckFingerprint(map: ArchitectureCognitiveMap | null, nodeId: string): string {
  const node = map?.nodes.find(n => n.id === nodeId);
  return node ? createHash("sha256").update(structureFingerprint(map) + ":" + nodeEvidenceHash(node)).digest("hex") : "<stale>";
}
