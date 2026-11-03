import { architectureDocSections } from "../core/maintenance/arch-review.js";
import { ARCHITECTURE_NODE_KINDS } from "../core/architecture/node-kinds.js";
import { createHash } from "node:crypto";
import type { CodeEvidenceSnapshot } from "../contracts/code-evidence.js";
import type { ArchitectureCognitiveMapCandidate, ProjectModel } from "../contracts/project-model.js";
import { architectureCognitiveMapEvidenceRefs, architectureCognitiveMapFingerprint } from "./architecture-cognitive-map.js";
import { projectMemoryVisualization, timelineLinkDate } from "./memory-visualization.js";

export const MAP_BOOTSTRAP_INSTRUCTIONS = `Build an evidence-backed architecture map: project → domain → capability → process → method → mechanism. For engineers, use controlled technical writing: label each non-project node with action + object; avoid vague names. State input → action → result in ≤160 chars, one action or fact per sentence, no chronology. Use bilingual labels 'English / 中文' and summaries or prose facts 'EN: ... ZH: ...'; preserve IDs, code and terms. For a Method with code evidence, decompose distinct steps into Mechanisms; use flows_to only where execution order is proven, and keep parallel inputs parallel. One Mechanism, one concrete action and its result. Put thresholds, weights, top-k, limits and modes in cited facts on the most specific Mechanism; identify the applicable mode. A ranking score is not confidence unless evidence defines it as such. Never invent steps or pad levels; stop when evidence is insufficient. Cite exact code modules/constants when supplied. Layer facets need cited declarations. Every node, fact, layer, edge and timeline link needs allowed_refs. Confidence reflects support per item, not a flat value. Timeline links are provenance only; chronology adjacency is not causality.
中文：面向工程人员使用受控技术写法。节点名用“动作 + 对象”，避免空泛；摘要写“输入 → 动作 → 结果”，一句只表达一个动作或事实。Method 有代码证据且有独立步骤时拆成 Mechanism；仅在代码证明先后时用 flows_to，并行输入保持并列。每个 Mechanism 说明具体动作及结果；权重、阈值、Top-K、限制和适用模式写成带引用的 facts。排序分数不等于置信度。禁止凑层、猜步骤或把时间线当实现。`;

// The existing parseArchitectureCognitiveMapCandidate shape, including its limits.
const text = (maxLength: number) => ({ type: "string", minLength: 1, maxLength });
const refs = { type: "array", minItems: 1, maxItems: 40, items: text(1000) };
const confidence = { type: "number", minimum: 0, maximum: 1 };
const kinds = ARCHITECTURE_NODE_KINDS;
export const MAP_BOOTSTRAP_ANSWER_SCHEMA = {
  type: "object",
  properties: {
    summary: text(1200),
    facet_vocab: { type: "object", properties: { layer: { type: "array", minItems: 1, maxItems: 12, uniqueItems: true, items: text(40) } } },
    nodes: { type: "array", minItems: 1, maxItems: 300, items: {
      type: "object", required: ["id", "kind", "label", "summary", "evidence_refs", "confidence"],
      properties: { id: { ...text(160), pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$" },
        kind: { enum: kinds }, label: text(160), summary: text(1200),
        parent_id: { type: ["string", "null"], maxLength: 160 },
        order: { type: "integer", minimum: 0, maximum: 100000 }, evidence_refs: refs, confidence,
        facts: { type: "array", maxItems: 12, items: { type: "object", required: ["key", "value", "evidence_refs", "confidence"], properties: {
          key: text(60), value: { anyOf: [text(120), { type: "number" }] }, unit: text(20), evidence_refs: refs, confidence
        } } },
        facets: { type: "object", properties: { layer: text(40), layer_evidence_refs: refs } } }
    } },
    edges: { type: "array", maxItems: 800, items: {
      type: "object", required: ["from", "to", "type", "evidence_refs", "confidence"],
      properties: { from: text(160), to: text(160),
        type: { enum: ["contains", "flows_to", "depends_on", "uses", "constrained_by"] }, evidence_refs: refs, confidence }
    } },
    timeline_links: { type: "array", maxItems: 500, items: {
      type: "object", required: ["event_date", "event_title", "architecture_refs", "architecture_level", "change_kind", "evidence_refs", "confidence"],
      properties: { event_date: text(80), event_title: text(300), architecture_refs: refs,
        architecture_level: { enum: kinds }, change_kind: { enum: ["add", "refine", "replace", "remove", "reroute"] }, evidence_refs: refs, confidence }
    } }
  },
  required: ["nodes"],
  description: "Exactly one project root; non-project parents must exist at a higher abstraction level. Edge endpoints and timeline architecture_refs must exist; architecture_level must match a referenced node. edges/timeline_links default to []; parent_id to null and order to node index."
};

export function estimateMapBootstrapTokens(value: unknown): number {
  const serialized = JSON.stringify(value);
  let ascii = 0, other = 0;
  for (const char of serialized) char.codePointAt(0)! < 128 ? ascii++ : other++;
  return Math.ceil(ascii / 4 + other / 1.5) + 400 + 6000;
}

/** Canonical `architecture-doc:` refs (stable path order, 80k-char cap); shared with maintenance generators so refs match exactly. */
export function architectureDocRefs(projectId: string, sources: readonly { path: string; content: string }[]) {
  let remaining = 80_000;
  let truncated = false;
  const out = [] as { ref: string; path: string; content: string; sections: { ref: string; heading: string }[] }[];
  for (const source of [...sources].sort((a, b) => compare(a.path, b.path) || compare(a.content, b.content))) {
    if (remaining === 0) { truncated = true; break; }
    const content = source.content.slice(0, remaining);
    if (content.length < source.content.length) truncated = true;
    const ref = `architecture-doc:${projectId}:${createHash("sha256").update(content).digest("hex").slice(0, 16)}:${source.path}`;
    out.push({ ref, path: source.path, content, sections: architectureDocSections(content).map(({ slug, heading }) => ({ ref: `${ref}#${slug}`, heading })) });
    remaining -= content.length;
  }
  return { sources: out, truncated };
}

export function assembleMapBootstrapPackage(input: {
  model: ProjectModel;
  architectureSources: { path: string; content: string }[];
  code?: CodeEvidenceSnapshot | null;
  rebuild?: boolean;
}) {
  const { model } = input;
  if (!model.projectId) throw new Error("map bootstrap requires a project");
  if (model.architecture.map && !input.rebuild) throw new Error("Cognitive map already exists; set rebuild=true explicitly");
  const { sources: architecture_sources, truncated } = architectureDocRefs(model.projectId, input.architectureSources);
  const events = projectMemoryVisualization(model).state.events;
  // Events without an exact job-backed L2 revision ref (e.g. migrated history) cannot be cited; skip and count them.
  const citable = events.filter(event => event.latest_revision_ref);
  const l2_events = [...citable].sort((a, b) => compare(b.date, a.date) || compare(b.date_label, a.date_label) || compare(a.id, b.id))
    .slice(0, 200).map(event => ({
      // Link date: the label when it fits the 80-char link cap (matching uses it), else the canonical ISO date.
      event_id: event.id, date: timelineLinkDate(event), title: event.title, summary: event.summary.slice(0, 300),
      evidence_ref: event.latest_revision_ref!
    }));
  const allowed_refs = [...new Set([
    ...(input.code?.items.map(item => item.ref) ?? []),
    ...architecture_sources.flatMap(source => [source.ref, ...source.sections.map(section => section.ref)]), ...l2_events.map(event => event.evidence_ref),
    ...(input.rebuild ? architectureCognitiveMapEvidenceRefs(model.architecture.map) : [])
  ])];
  const result = {
    project: model.projectId, base_fingerprint: model.architecture.fingerprint ?? architectureCognitiveMapFingerprint(model.architecture.map),
    mode: input.rebuild ? "rebuild" as const : "bootstrap" as const,
    ...(input.rebuild ? { current_map: model.architecture.map } : {}),
    architecture_sources, truncated, l2_events, events_truncated: Math.max(0, citable.length - l2_events.length), events_without_ref: events.length - citable.length,
    ...(input.code ? { code: input.code } : {}),
    allowed_refs, instructions: MAP_BOOTSTRAP_INSTRUCTIONS, answer_schema: MAP_BOOTSTRAP_ANSWER_SCHEMA
  };
  return { ...result, est_tokens: estimateMapBootstrapTokens(result) };
}

export function mapBootstrapCitedRefs(candidate: ArchitectureCognitiveMapCandidate, allowedRefs: string[]): string[] {
  const allowed = new Set(allowedRefs);
  const cited = [...new Set([...candidate.nodes, ...candidate.edges, ...candidate.timeline_links, ...candidate.nodes.flatMap(node => node.facts ?? [])].flatMap(item => item.evidence_refs).concat(candidate.nodes.flatMap(node => node.facets?.layer_evidence_refs ?? [])))];
  for (const ref of cited) if (!allowed.has(ref)) throw new Error(`architecture_map cites a ref outside allowed_refs: ${ref}`);
  return cited;
}

function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
