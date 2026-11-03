import { appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ProjectArchitectureSource } from "../../architecture-source.js";
import type { MemoryViewerReader } from "../../core/ports/memory.js";
import { assembleMapBootstrapPackage, mapBootstrapCitedRefs } from "../../archify/map-bootstrap.js";
import { buildArchitectureCognitiveMap, architectureCognitiveMapFingerprint, parseArchitectureCognitiveMapCandidate } from "../../archify/architecture-cognitive-map.js";
import { buildProjectModel, type ProjectModelBuilderDeps } from "./project-model.js";
import { loadLayerPayload } from "./layer-payload.js";
import { applyCodeLayers, mapEntryKey, validateHistoricalCodeOwners } from "../../archify/code-evidence.js";
import type { ArchitectureCognitiveMapCandidate } from "../../contracts/project-model.js";

export type MapBootstrapDeps = ProjectModelBuilderDeps & {
  architecture: Pick<ProjectArchitectureSource, "inspectProjectCognitiveMap" | "writeProjectCognitiveMap" | "listProjectArchitectureMarkdown" | "getProjectCodeEvidence" | "getProjectCodeCitations">;
  userId: string;
  memoryClient: MemoryViewerReader;
};

async function loadMapBootstrap(deps: MapBootstrapDeps, input: { stateRoot: string; projectId: string; rebuild?: boolean }) {
  const current = await deps.architecture.inspectProjectCognitiveMap({ accountId: deps.accountId, projectId: input.projectId });
  if (current.exists && !input.rebuild) throw new Error("Cognitive map already exists; set rebuild=true explicitly");
  const [{ items }, architectureSources, code] = await Promise.all([
    loadLayerPayload({ memoryClient: deps.memoryClient, userId: deps.userId, projectId: input.projectId, kind: "l2", hydrateBody: true }),
    deps.architecture.listProjectArchitectureMarkdown({ accountId: deps.accountId, projectId: input.projectId }),
    deps.architecture.getProjectCodeEvidence?.({ accountId: deps.accountId, projectId: input.projectId }) ?? null
  ]);
  const model = await buildProjectModel(deps, { ...input, l2: items, todos: [] });
  return { model, package: assembleMapBootstrapPackage({ model, architectureSources, code, rebuild: input.rebuild }) };
}

export async function mapBootstrapNext(deps: MapBootstrapDeps, input: { stateRoot: string; projectId: string; rebuild?: boolean }) {
  return (await loadMapBootstrap(deps, input)).package;
}

export async function mapBootstrapSubmit(deps: MapBootstrapDeps, input: {
  stateRoot: string;
  projectId: string;
  base_fingerprint: string;
  architecture_map: unknown;
  rebuild?: boolean;
  dry_run?: boolean;
  source_harness?: string;
  model?: string;
}) {
  const loaded = await loadMapBootstrap(deps, input);
  const pkg = loaded.package;
  if (pkg.base_fingerprint !== input.base_fingerprint) throw new Error("Stale base_fingerprint; request a fresh map bootstrap package");
  const parsed = parseArchitectureCognitiveMapCandidate(input.architecture_map);
  const previous = input.rebuild ? loaded.model.architecture.map : null;
  const withoutText = (value: ArchitectureCognitiveMapCandidate) => ({
    ...value, nodes: value.nodes.map(({ label: _label, summary: _summary, ...node }) => node)
  });
  const translationOnly = !!previous &&
    mapEntryKey(withoutText(parsed)) === mapEntryKey(withoutText(parseArchitectureCognitiveMapCandidate(previous))) &&
    parsed.nodes.some((node, index) => node.label !== previous.nodes[index]!.label || node.summary !== previous.nodes[index]!.summary) &&
    parsed.nodes.every((node, index) => {
      const old = previous.nodes[index]!;
      const labelSuffix = node.label.startsWith(old.label + " / ") ? node.label.slice(old.label.length + 3) : "";
      const summaryPrefix = "EN: " + old.summary + " ZH: ";
      return (node.label === old.label || /[\u3400-\u9fff]/.test(labelSuffix)) &&
        (node.summary === old.summary || (node.summary.startsWith(summaryPrefix) && /[\u3400-\u9fff]/.test(node.summary.slice(summaryPrefix.length))));
    });
  const currentCodeRefs = new Set(pkg.code?.items.map(item => item.ref) ?? []);
  const historical = mapBootstrapCitedRefs(parsed, pkg.allowed_refs).filter(ref => ref.startsWith("code:") && !currentCodeRefs.has(ref));
  if (historical.length && !translationOnly) {
    const retained = new Set(previous?.source_evidence_refs ?? []);
    const snapshots = await deps.architecture.getProjectCodeCitations?.({ accountId: deps.accountId, projectId: input.projectId, refs: historical }) ?? [];
    const backed = new Set(snapshots.map(item => item.ref));
    if (historical.some(ref => !retained.has(ref) || !backed.has(ref))) {
      throw new Error("stale or foreign code evidence; request a fresh bootstrap package");
    }
    validateHistoricalCodeOwners(parsed, previous, new Set(historical));
  }
  const candidate = translationOnly ? parsed : applyCodeLayers(parsed, pkg.code ?? null, previous);
  const cited = mapBootstrapCitedRefs(candidate, pkg.allowed_refs);
  // A translation preserves the original evidence and topology instead of recalculating them.
  const map = translationOnly && previous
    ? { ...previous, generated_at: new Date().toISOString(), nodes: previous.nodes.map((node, index) => ({
      ...node, label: parsed.nodes[index]!.label, summary: parsed.nodes[index]!.summary
    })) }
    : buildArchitectureCognitiveMap({ projectId: input.projectId, candidate, sourceEvidenceRefs: cited,
      previousMap: input.rebuild ? loaded.model.architecture.map : null });
  const provenance = {
    source_harness: input.source_harness ?? null, model: input.model ?? null, mode: pkg.mode,
    architecture_refs: cited.filter(ref => ref.startsWith("architecture-doc:")).length,
    l2_refs: cited.filter(ref => ref.startsWith("l2:")).length
  };
  const result = {
    ok: true, project: pkg.project, fingerprint_before: pkg.base_fingerprint,
    fingerprint_after: architectureCognitiveMapFingerprint(map), nodes: map.nodes.length,
    edges: map.edges.length, timeline_links: map.timeline_links.length, provenance
  };
  if (!input.dry_run) {
    const written = await deps.architecture.writeProjectCognitiveMap({ accountId: deps.accountId, projectId: input.projectId,
      expectedFingerprint: input.base_fingerprint, map });
    result.fingerprint_after = written.after.fingerprint;
    await appendFile(join(dirname(written.after.path), "COGNITIVE_MAP.bootstrap.jsonl"),
      JSON.stringify({ ...provenance, timestamp: new Date().toISOString() }) + "\n", { encoding: "utf8", mode: 0o600 });
  }
  return result;
}
