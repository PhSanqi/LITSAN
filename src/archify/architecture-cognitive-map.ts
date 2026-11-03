import { ARCHITECTURE_NODE_KINDS } from "../core/architecture/node-kinds.js";
import type { ArchitectureRelationType, ArchitectureChangeKind, ArchitectureCognitiveNode, ArchitectureCognitiveEdge, ArchitectureTimelineLink, ArchitectureCognitiveMapCandidate, ArchitectureCognitiveMap } from "../contracts/project-model.js";
export type { ArchitectureNodeKind, ArchitectureRelationType, ArchitectureChangeKind, ArchitectureCognitiveNode, ArchitectureCognitiveEdge, ArchitectureTimelineLink, ArchitectureCognitiveMapCandidate, ArchitectureCognitiveMap, ArchitectureCognitiveMapDocument } from "../contracts/project-model.js";
import { createHash } from "node:crypto";

export const ARCHITECTURE_COGNITIVE_MAP_CONTRACT = "memhub-architecture-cognitive-map-v1";

const NODE_KINDS = ARCHITECTURE_NODE_KINDS;
const RELATION_TYPES: ArchitectureRelationType[] = ["contains", "flows_to", "depends_on", "uses", "constrained_by"];
const CHANGE_KINDS: ArchitectureChangeKind[] = ["add", "refine", "replace", "remove", "reroute"];
const NODE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

export function parseArchitectureCognitiveMapCandidate(value: unknown): ArchitectureCognitiveMapCandidate {
  const raw = record(value, "architecture_map");
  const nodesRaw = array(raw.nodes, "architecture_map.nodes", 1, 300);
  const edgesRaw = array(raw.edges ?? [], "architecture_map.edges", 0, 800);
  const linksRaw = array(raw.timeline_links ?? [], "architecture_map.timeline_links", 0, 500);
  // The read-only storage adapter passes persisted envelopes through this parser.
  // Preserve legacy layer reads; buildArchitectureCognitiveMap always enforces evidence on writes.
  const stored = raw.schema_version === 1 && raw.contract === ARCHITECTURE_COGNITIVE_MAP_CONTRACT && raw.authority === "derived";
  const nodes = nodesRaw.map((item, index) => parseNode(item, index, stored));
  const facet_vocab = raw.facet_vocab === undefined ? undefined : parseFacetVocab(raw.facet_vocab);
  for (const node of nodes) {
    if (node.facets?.layer !== undefined && !facet_vocab?.layer?.includes(node.facets.layer))
      throw new TypeError(`architecture node ${node.id} layer must belong to facet_vocab.layer`);
  }
  const ids = new Set(nodes.map((node) => node.id));
  if (ids.size !== nodes.length) throw new TypeError("architecture_map node ids must be unique");
  const roots = nodes.filter((node) => node.kind === "project" && node.parent_id === null);
  if (roots.length !== 1) throw new TypeError("architecture_map requires exactly one project root node");
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  for (const node of nodes) {
    if (node.kind === "project") {
      if (node.parent_id !== null) throw new TypeError("project architecture node must not have parent_id");
      continue;
    }
    if (!node.parent_id || !ids.has(node.parent_id)) throw new TypeError(`architecture node ${node.id} requires a valid parent_id`);
    const parent = nodeById.get(node.parent_id)!;
    if (NODE_KINDS.indexOf(parent.kind) >= NODE_KINDS.indexOf(node.kind)) {
      throw new TypeError(`architecture node ${node.id} must be below its parent abstraction level`);
    }
  }
  assertAcyclicParents(nodes);

  const edges = edgesRaw.map((item, index) => parseEdge(item, index, ids));
  const timeline_links = linksRaw.map((item, index) => parseTimelineLink(item, index, nodeById));
  const summary = optionalText(raw.summary, "architecture_map.summary", 1200);
  return { ...(facet_vocab ? { facet_vocab } : {}), ...(summary ? { summary } : {}), nodes, edges, timeline_links };
}

export function buildArchitectureCognitiveMap(input: {
  projectId: string;
  candidate: ArchitectureCognitiveMapCandidate;
  sourceEvidenceRefs: string[];
  previousMap?: ArchitectureCognitiveMap | null;
  generatedAt?: string;
}): ArchitectureCognitiveMap {
  const currentEvidenceRefs = uniqueRefs(input.sourceEvidenceRefs);
  if (currentEvidenceRefs.length === 0) throw new TypeError("architecture_map requires source evidence");
  validateArchitectureMapEvidence(input.candidate, currentEvidenceRefs, input.previousMap ?? null);
  const sourceEvidenceRefs = uniqueRefs([
    ...currentEvidenceRefs,
    ...input.candidate.nodes.flatMap((node) => node.evidence_refs),
    ...input.candidate.nodes.flatMap((node) => node.facets?.layer_evidence_refs ?? []),
    ...input.candidate.nodes.flatMap((node) => (node.facts ?? []).flatMap(fact => fact.evidence_refs)),
    ...input.candidate.edges.flatMap((edge) => edge.evidence_refs),
    ...input.candidate.timeline_links.flatMap((link) => link.evidence_refs)
  ]);
  return {
    schema_version: 1,
    contract: ARCHITECTURE_COGNITIVE_MAP_CONTRACT,
    project_id: input.projectId,
    authority: "derived",
    abstraction_cutoff: "mechanism",
    generated_at: input.generatedAt ?? new Date().toISOString(),
    source_evidence_refs: sourceEvidenceRefs,
    ...input.candidate
  };
}

export function architectureCognitiveMapFingerprint(map: ArchitectureCognitiveMap | null): string {
  return createHash("sha256").update(map ? JSON.stringify(map) : "<missing>", "utf8").digest("hex");
}

export function architectureCognitiveMapEvidenceRefs(map: ArchitectureCognitiveMap | null): string[] {
  if (!map) return [];
  return uniqueRefs([
    ...map.source_evidence_refs,
    ...map.nodes.flatMap((node) => node.evidence_refs),
    ...map.nodes.flatMap((node) => node.facets?.layer_evidence_refs ?? []),
    ...map.nodes.flatMap((node) => (node.facts ?? []).flatMap(fact => fact.evidence_refs)),
    ...map.edges.flatMap((edge) => edge.evidence_refs),
    ...map.timeline_links.flatMap((link) => link.evidence_refs)
  ]);
}

export function renderArchitectureCognitiveMapMarkdown(map: ArchitectureCognitiveMap): string {
  const children = new Map<string | null, ArchitectureCognitiveNode[]>();
  for (const node of map.nodes) {
    const bucket = children.get(node.parent_id) ?? [];
    bucket.push(node);
    children.set(node.parent_id, bucket);
  }
  for (const bucket of children.values()) bucket.sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
  const lines = [
    "# Architecture Cognitive Map / 架构认知地图",
    "",
    `Derived, evidence-backed structural model. Authority: derived. Abstraction cutoff: ${map.abstraction_cutoff}.`,
    "This map does not override the governed Project Architecture contract or L1-L4 memory.",
    ""
  ];
  const walk = (parentId: string | null, depth: number) => {
    for (const node of children.get(parentId) ?? []) {
      lines.push(`${"  ".repeat(depth)}- [${node.kind}] ${node.label}${node.facets?.layer ? ` [${node.facets.layer}]` : ""} (${node.id}) — ${node.summary}`);
      for (const fact of node.facts ?? []) lines.push(`${"  ".repeat(depth + 1)}- ${fact.key} = ${fact.value}${fact.unit ? ` ${fact.unit}` : ""}`);
      walk(node.id, depth + 1);
    }
  };
  walk(null, 0);
  if (map.timeline_links.length) {
    lines.push("", "## Architecture evolution links / 架构演化关联", "");
    for (const link of map.timeline_links.slice(-40)) {
      lines.push(`- ${link.event_date} · ${link.event_title} -> ${link.architecture_refs.join(", ")} · ${link.change_kind} · confidence ${link.confidence.toFixed(2)}`);
    }
  }
  return lines.join("\n");
}

function validateArchitectureMapEvidence(
  candidate: ArchitectureCognitiveMapCandidate,
  currentEvidenceRefs: string[],
  previousMap: ArchitectureCognitiveMap | null
): void {
  const allowed = new Set([
    ...currentEvidenceRefs,
    ...architectureCognitiveMapEvidenceRefs(previousMap)
  ]);
  const validate = (refs: string[], label: string) => {
    if (refs.length === 0) throw new TypeError(`${label} requires evidence_refs`);
    for (const ref of refs) {
      if (!allowed.has(ref)) throw new Error(`${label} contains evidence outside the current distillation or previous cognitive map: ${ref}`);
    }
  };
  for (const node of candidate.nodes) {
    validate(node.evidence_refs, `architecture node ${node.id}`);
    if (node.facets?.layer !== undefined && !node.facets.layer_evidence_refs?.length) throw new TypeError(`architecture node ${node.id} layer needs evidence`);
    if (node.facets?.layer_evidence_refs) validate(node.facets.layer_evidence_refs, `architecture node ${node.id} layer`);
    for (const fact of node.facts ?? []) validate(fact.evidence_refs, `architecture node ${node.id} fact ${fact.key}`);
  }
  for (const edge of candidate.edges) validate(edge.evidence_refs, `architecture edge ${edge.from}->${edge.to}`);
  for (const link of candidate.timeline_links) validate(link.evidence_refs, `architecture timeline link ${link.event_date} ${link.event_title}`);
}

function parseNode(value: unknown, index: number, stored: boolean): ArchitectureCognitiveNode {
  const raw = record(value, `architecture_map.nodes[${index}]`);
  const id = text(raw.id, `architecture_map.nodes[${index}].id`, 160);
  if (!NODE_ID.test(id)) throw new TypeError(`invalid architecture node id: ${id}`);
  const kind = enumValue(raw.kind, NODE_KINDS, `architecture_map.nodes[${index}].kind`);
  return {
    ...(raw.facts === undefined ? {} : { facts: parseFacts(raw.facts) }),
    ...(raw.facets === undefined ? {} : { facets: parseFacets(raw.facets, stored) }),
    id,
    kind,
    label: text(raw.label, `architecture_map.nodes[${index}].label`, 160),
    summary: text(raw.summary, `architecture_map.nodes[${index}].summary`, 1200),
    parent_id: nullableText(raw.parent_id, `architecture_map.nodes[${index}].parent_id`, 160),
    order: integer(raw.order ?? index, `architecture_map.nodes[${index}].order`, 0, 100000),
    evidence_refs: refs(raw.evidence_refs, `architecture_map.nodes[${index}].evidence_refs`),
    confidence: confidence(raw.confidence, `architecture_map.nodes[${index}].confidence`)
  };
}

function parseEdge(value: unknown, index: number, ids: Set<string>): ArchitectureCognitiveEdge {
  const raw = record(value, `architecture_map.edges[${index}]`);
  const from = text(raw.from, `architecture_map.edges[${index}].from`, 160);
  const to = text(raw.to, `architecture_map.edges[${index}].to`, 160);
  if (!ids.has(from) || !ids.has(to)) throw new TypeError(`architecture edge ${from}->${to} references an unknown node`);
  if (from === to) throw new TypeError("architecture edge cannot self-reference");
  return {
    from,
    to,
    type: enumValue(raw.type, RELATION_TYPES, `architecture_map.edges[${index}].type`),
    evidence_refs: refs(raw.evidence_refs, `architecture_map.edges[${index}].evidence_refs`),
    confidence: confidence(raw.confidence, `architecture_map.edges[${index}].confidence`)
  };
}

function parseTimelineLink(value: unknown, index: number, nodeById: Map<string, ArchitectureCognitiveNode>): ArchitectureTimelineLink {
  const raw = record(value, `architecture_map.timeline_links[${index}]`);
  const architecture_refs = refs(raw.architecture_refs, `architecture_map.timeline_links[${index}].architecture_refs`);
  for (const ref of architecture_refs) if (!nodeById.has(ref)) throw new TypeError(`timeline link references unknown architecture node: ${ref}`);
  const architecture_level = enumValue(raw.architecture_level, NODE_KINDS, `architecture_map.timeline_links[${index}].architecture_level`);
  if (!architecture_refs.some((ref) => nodeById.get(ref)?.kind === architecture_level)) {
    throw new TypeError("timeline link architecture_level must match at least one referenced node");
  }
  return {
    event_date: text(raw.event_date, `architecture_map.timeline_links[${index}].event_date`, 80),
    event_title: text(raw.event_title, `architecture_map.timeline_links[${index}].event_title`, 300),
    architecture_refs,
    architecture_level,
    change_kind: enumValue(raw.change_kind, CHANGE_KINDS, `architecture_map.timeline_links[${index}].change_kind`),
    evidence_refs: refs(raw.evidence_refs, `architecture_map.timeline_links[${index}].evidence_refs`),
    confidence: confidence(raw.confidence, `architecture_map.timeline_links[${index}].confidence`)
  };
}

function assertAcyclicParents(nodes: ArchitectureCognitiveNode[]): void {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  for (const start of nodes) {
    const seen = new Set<string>();
    let cursor: ArchitectureCognitiveNode | undefined = start;
    while (cursor?.parent_id) {
      if (seen.has(cursor.id)) throw new TypeError("architecture_map parent hierarchy must be acyclic");
      seen.add(cursor.id);
      cursor = byId.get(cursor.parent_id);
    }
  }
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${field} must be an object`);
  return value as Record<string, unknown>;
}

function array(value: unknown, field: string, min: number, max: number): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) throw new TypeError(`${field} must contain ${min}-${max} items`);
  return value;
}

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) throw new TypeError(`${field} must be a non-empty string up to ${max} chars`);
  return value.trim();
}

function optionalText(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return text(value, field, max);
}

function nullableText(value: unknown, field: string, max: number): string | null {
  if (value === null || value === undefined || value === "") return null;
  return text(value, field, max);
}

function integer(value: unknown, field: string, min: number, max: number): number {
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) throw new TypeError(`${field} must be an integer between ${min} and ${max}`);
  return Number(value);
}

function confidence(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) throw new TypeError(`${field} must be between 0 and 1`);
  return value;
}

function refs(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 40) throw new TypeError(`${field} must contain 1-40 references`);
  const normalized = value.map((item) => text(item, field, 1000));
  return uniqueRefs(normalized);
}

function uniqueRefs(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function enumValue<T extends string>(value: unknown, values: readonly T[], field: string): T {
  if (typeof value !== "string" || !values.includes(value as T)) throw new TypeError(`${field} must be one of: ${values.join(", ")}`);
  return value as T;
}

function parseFacts(value: unknown): NonNullable<ArchitectureCognitiveNode["facts"]> {
  const facts = array(value, "facts", 0, 12).map(item => {
    const raw = record(item, "fact");
    const value = typeof raw.value === "number" && Number.isFinite(raw.value) ? raw.value : text(raw.value, "fact.value", 120);
    return { key: text(raw.key, "fact.key", 60), value,
      ...(raw.unit === undefined ? {} : { unit: text(raw.unit, "fact.unit", 20) }),
      evidence_refs: refs(raw.evidence_refs, "fact.evidence_refs"), confidence: confidence(raw.confidence, "fact.confidence") };
  });
  if (new Set(facts.map(fact => fact.key)).size !== facts.length) throw new TypeError("fact keys must be unique per node");
  return facts;
}
function parseFacets(value: unknown, stored: boolean): NonNullable<ArchitectureCognitiveNode["facets"]> {
  const raw = record(value, "facets");
  if (!stored && raw.layer !== undefined && raw.layer_evidence_refs === undefined) throw new TypeError("layer needs evidence");
  return { ...(raw.layer === undefined ? {} : { layer: text(raw.layer, "facets.layer", 40) }),
    ...(raw.layer_evidence_refs === undefined ? {} : { layer_evidence_refs: refs(raw.layer_evidence_refs, "facets.layer_evidence_refs") }) };
}
function parseFacetVocab(value: unknown): { layer?: string[] } {
  const raw = record(value, "facet_vocab");
  if (raw.layer === undefined) return {};
  const layer = array(raw.layer, "facet_vocab.layer", 1, 12).map(value => text(value, "facet_vocab.layer value", 40));
  if (new Set(layer).size !== layer.length) throw new TypeError("facet_vocab.layer values must be unique");
  return { layer };
}
