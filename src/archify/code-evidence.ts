import type { CodeEvidenceSnapshot } from "../contracts/code-evidence.js";
import type { ArchitectureCognitiveMapCandidate } from "../contracts/project-model.js";

/** Compare JSON map entries without depending on object property insertion order. */
export function mapEntryKey(entry: object): string {
  return JSON.stringify(entry, (_key, value) => value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : value);
}

export function retainsCodeEvidenceOwner(entry: { evidence_refs: string[] }, previous: { evidence_refs: string[] }): boolean {
  const retained = new Set(previous.evidence_refs);
  return previous.evidence_refs.every(ref => entry.evidence_refs.includes(ref)) &&
    entry.evidence_refs.every(ref => retained.has(ref) || !ref.startsWith("code:")) &&
    mapEntryKey({ ...entry, evidence_refs: previous.evidence_refs }) === mapEntryKey(previous);
}

export function validateHistoricalCodeOwners(
  candidate: ArchitectureCognitiveMapCandidate,
  previous: ArchitectureCognitiveMapCandidate | null,
  historical: ReadonlySet<string>
): void {
  const groups = [
    [candidate.nodes, previous?.nodes ?? []],
    [candidate.edges, previous?.edges ?? []],
    [candidate.timeline_links, previous?.timeline_links ?? []]
  ] as const;
  for (const [entries, oldEntries] of groups) {
    for (const entry of entries) {
      const cited = [...entry.evidence_refs,
        ...("facets" in entry ? entry.facets?.layer_evidence_refs ?? [] : []),
        ...("facts" in entry ? (entry.facts ?? []).flatMap(fact => fact.evidence_refs) : [])];
      if (cited.some(ref => historical.has(ref)) && !oldEntries.some(old => retainsCodeEvidenceOwner(entry, old))) {
        throw new Error("stale code evidence on a changed map entry; request a fresh bootstrap package");
      }
    }
  }
}

/** Count files, not repeated citations or lines, so agents cannot vote a layer into existence. */
export function applyCodeLayers(candidate: ArchitectureCognitiveMapCandidate, code: CodeEvidenceSnapshot | null, previous?: ArchitectureCognitiveMapCandidate | null): ArchitectureCognitiveMapCandidate {
  const result = structuredClone(candidate);
  const items = new Map(code?.items.map(item => [item.ref, item]) ?? []);
  const modules = new Map(code?.items.filter(item => item.kind === "module").map(item => [item.path, item]) ?? []);
  for (const node of result.nodes) {
    const refs = [...node.evidence_refs, ...(node.facts ?? []).flatMap(fact => fact.evidence_refs)];
    const codeRefs = [...new Set(refs.filter(ref => ref.startsWith("code:")))];
    // Non-code corroboration does not change the claim or its snapshot-backed layer.
    if (codeRefs.some(ref => !items.has(ref)) && previous?.nodes.some(old => retainsCodeEvidenceOwner(node, old))) continue;
    if (!codeRefs.length) {
      if (node.facets?.layer_evidence_refs?.some(ref => ref.startsWith("code:"))) delete node.facets;
      continue;
    }
    const files = new Map<string, ReturnType<typeof modules.get>>();
    for (const ref of codeRefs) {
      const item = items.get(ref);
      if (!item) throw new Error("stale or foreign code evidence; request a fresh bootstrap package: " + ref);
      if (item.kind !== "layer") files.set(item.path, modules.get(item.path) ?? item);
    }
    delete node.facets;
    if (!files.size || !code?.layers.length) continue;
    const counts = new Map<string, number>();
    const evidence: string[] = [];
    for (const module of files.values()) if (module?.layer && module.layer_ref) {
      counts.set(module.layer, (counts.get(module.layer) ?? 0) + 1);
      evidence.push(module.layer_ref);
    }
    if (!counts.size) continue;
    const [name, count] = [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]!;
    node.facets = { layer: count / files.size >= 0.8 ? name : "mixed", layer_evidence_refs: [...new Set(evidence)] };
  }
  const used = [...new Set(result.nodes.flatMap(node => node.facets?.layer ? [node.facets.layer] : []))].sort();
  if (used.length) result.facet_vocab = { layer: used };
  else delete result.facet_vocab;
  return result;
}
