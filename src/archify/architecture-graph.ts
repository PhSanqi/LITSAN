import { ARCHITECTURE_NODE_KINDS } from "../core/architecture/node-kinds.js";
import type { ProjectModel, ArchitectureCognitiveNode, ArchitectureRelationType } from "../contracts/project-model.js";
import type { ArchitectureGraph, ArchitectureGraphNode } from "../contracts/project-map.js";

/** Pure layout; canonical event identities are supplied by the timeline projector. */
export function buildArchitectureGraph(
  model: ProjectModel,
  eventNodes: Array<{ id: string; event_ids: string[] }>
): ArchitectureGraph | null {
  const map = model.architecture.map;
  if (!model.projectId?.trim() || !map || map.project_id !== model.projectId.trim()) return null;
  const levels: ArchitectureGraph["levels"] = ARCHITECTURE_NODE_KINDS.filter(kind => kind !== "mechanism" || map.nodes.some(node => node.kind === kind));
  const children = new Map<string | null, ArchitectureCognitiveNode[]>();
  for (const node of map.nodes) {
    const siblings = children.get(node.parent_id) ?? [];
    siblings.push(node);
    children.set(node.parent_id, siblings);
  }
  // Code-point comparison avoids locale-dependent ordering on Ubuntu/Windows.
  for (const siblings of children.values()) siblings.sort((a, b) =>
    a.order - b.order || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const impacts = new Map(eventNodes.map(node => [node.id, node.event_ids]));
  const changes = new Map<string, { count: number; date: string; kind: ArchitectureGraphNode["latest_change_kind"] }>();
  for (const link of map.timeline_links) {
    for (const id of new Set(link.architecture_refs)) {
      const prior = changes.get(id);
      changes.set(id, { count: (prior?.count ?? 0) + 1,
        date: !prior || link.event_date >= prior.date ? link.event_date : prior.date,
        kind: !prior || link.event_date >= prior.date ? link.change_kind : prior.kind });
    }
  }
  // Reserve 140px before the first card for the band label column.
  let slot = 0;
  const positions = new Map<string, { x: number; depth: number }>();
  const visit = (node: ArchitectureCognitiveNode, depth: number): number => {
    const xs = (children.get(node.id) ?? []).map(child => visit(child, depth + 1));
    const x = xs.length ? Math.round(xs.reduce((sum, value) => sum + value, 0) / xs.length) : 244 + slot++ * 240;
    positions.set(node.id, { x, depth });
    return x;
  };
  for (const root of children.get(null) ?? []) visit(root, 0);
  const nodes = map.nodes.map(node => {
    const position = positions.get(node.id)!;
    const change = changes.get(node.id);
    const level = levels.indexOf(node.kind);
    return { ...(node.facts ? { facts: node.facts } : {}), ...(node.facets ? { facets: node.facets } : {}), id: node.id, kind: node.kind, level, parent_id: node.parent_id, depth: position.depth,
      x: position.x, y: 68 + level * 120, label: node.label, summary: node.summary, confidence: node.confidence,
      change_count: change?.count ?? 0, latest_change_kind: change?.kind ?? null, event_ids: [...(impacts.get(node.id) ?? [])] };
  });
  const labels = new Map(nodes.map(node => [node.id, node.label]));
  const nonContainsEdges = map.edges.filter((edge): edge is typeof edge & { type: Exclude<ArchitectureRelationType, "contains"> } => edge.type !== "contains");
  const pairStats = new Map<string, { fwd: number; rev: number }>();
  for (const edge of nonContainsEdges) {
    const isOrdered = edge.from <= edge.to;
    const key = isOrdered ? `${edge.from}|${edge.to}` : `${edge.to}|${edge.from}`;
    const stats = pairStats.get(key) ?? { fwd: 0, rev: 0 };
    if (isOrdered) stats.fwd++;
    else stats.rev++;
    pairStats.set(key, stats);
  }
  const stronglyCoupledPairs = new Set<string>();
  for (const [key, stats] of pairStats.entries()) {
    if ((stats.fwd >= 1 && stats.rev >= 1) || (stats.fwd + stats.rev >= 3)) {
      stronglyCoupledPairs.add(key);
    }
  }
  const relations: ArchitectureGraph["relations"] = nonContainsEdges.map(edge => {
    const isOrdered = edge.from <= edge.to;
    const key = isOrdered ? `${edge.from}|${edge.to}` : `${edge.to}|${edge.from}`;
    const coupled = stronglyCoupledPairs.has(key);
    return {
      from: edge.from, to: edge.to, type: edge.type, confidence: edge.confidence,
      from_label: labels.get(edge.from) ?? edge.from, to_label: labels.get(edge.to) ?? edge.to,
      ...(coupled ? { strong_coupling: true } : {})
    };
  });
  return { levels, width: Math.max(900, slot * 240 + 184), height: 20 + levels.length * 120, nodes, relations };
}
