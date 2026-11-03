import { ARCHITECTURE_NODE_KINDS } from "../architecture/node-kinds.js";
import type { ArchitectureCognitiveMap, ArchitectureCognitiveNode } from "../../contracts/project-model.js";
import type { MaintenanceGeneratorContext } from "../../contracts/maintenance.js";
const levels = ARCHITECTURE_NODE_KINDS;
const cmp = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
function terms(text: string): Set<string> {
  const result = new Set(text.toLowerCase().match(/[a-z]{2,}/g) ?? []);
  for (const run of text.match(/[\p{Script=Han}]+/gu) ?? []) {
    const chars = [...run];
    for (let i = 0; i + 1 < chars.length; i++) result.add(chars[i]! + chars[i + 1]!);
  }
  return result;
}
export function selectCandidateEvents(events: MaintenanceGeneratorContext["events"], text: string, limit = 6): MaintenanceGeneratorContext["events"][number][] {
  const query = terms(text);
  return events.map(event => ({ event, score: [...terms(event.title + " " + event.summary)].filter(t => query.has(t)).length }))
    .filter(item => item.score > 0).sort((a, b) => b.score - a.score || cmp(b.event.date, a.event.date) || cmp(a.event.id, b.event.id))
    .slice(0, Math.max(0, Math.trunc(limit))).map(item => item.event);
}
export function selectCandidateNodes(map: ArchitectureCognitiveMap, text: string, limit = 30): ArchitectureCognitiveNode[] {
  const cap = Math.max(0, Math.trunc(limit));
  const query = terms(text), byId = new Map(map.nodes.map(n => [n.id, n]));
  const ranked = map.nodes.map(node => ({ node, score: [...terms(node.label + " " + node.summary)].filter(t => query.has(t)).length }))
    .filter(n => n.score > 0).sort((a, b) => b.score - a.score || cmp(a.node.id, b.node.id));
  const chosen = new Map<string, ArchitectureCognitiveNode>();
  if (!ranked.length) {
    for (const n of [...map.nodes].sort((a, b) => levels.indexOf(a.kind) - levels.indexOf(b.kind) || a.order - b.order || cmp(a.id, b.id))) {
      if (["project", "domain"].includes(n.kind) && chosen.size < cap) chosen.set(n.id, n);
    }
  } else for (const { node } of ranked) {
    const chain: ArchitectureCognitiveNode[] = [], seen = new Set<string>();
    let current: ArchitectureCognitiveNode | undefined = node;
    while (current && !seen.has(current.id)) { chain.unshift(current); seen.add(current.id); current = current.parent_id ? byId.get(current.parent_id) : undefined; }
    for (const n of chain) if (chosen.size < cap) chosen.set(n.id, n);
  }
  return [...chosen.values()].sort((a, b) => levels.indexOf(a.kind) - levels.indexOf(b.kind) || a.order - b.order || cmp(a.id, b.id));
}
