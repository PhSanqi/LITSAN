import type { ProjectModel } from "../contracts/project-model.js";
import type { MemoryVisualizationPayload } from "../contracts/project-map.js";
import type { GapKind, ProjectMapQuality, QualityComponentId } from "../contracts/project-map-quality.js";
export type { GapKind, ProjectMapQuality, QualityComponentId } from "../contracts/project-map-quality.js";

const compareText = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const severity = { high: 0, medium: 1, low: 2 };
const compareGaps = (a: ProjectMapQuality["gaps"][number], b: ProjectMapQuality["gaps"][number]) =>
  severity[a.severity] - severity[b.severity] || compareText(b.event_date ?? "", a.event_date ?? "") || compareText(a.id, b.id);
const timestamp = (value: string | null) => value ? Date.parse(value) : NaN;
const integerScore = (value: number) => Math.round(Math.max(0, Math.min(100, value)));
// L2 date labels may include ranges/annotations; the canonical ISO calendar
// date is the stable basis when a label is not an unambiguous ISO timestamp.
const eventTimestamp = (event: MemoryVisualizationPayload["state"]["events"][number]) =>
  timestamp(/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(event.date_label) ? event.date_label : event.date);

/** Pure projection: uses all canonical events, never the sampled flow/export.
 * Scores are rounded only at the component/final boundary. Base weights sum to
 * 1; with no events the .25 timeline weight is removed and the rest / .75.
 * Empty evidence/node populations score 0; absent activity retains the legacy freshness basis.
 */
export function projectMapQuality(model: ProjectModel, visual: Pick<MemoryVisualizationPayload, "state">): ProjectMapQuality {
  const projectId = model.projectId?.trim() || null;
  const map = projectId && model.architecture.map?.project_id === projectId ? model.architecture.map : null;
  const latestRevision = (projectId ? model.revisions : []).filter(revision => revision.layer === "L2")
    .map(revision => revision.committed_at).filter(value => Number.isFinite(timestamp(value)))
    .sort((a, b) => timestamp(a) - timestamp(b) || compareText(a, b)).at(-1) ?? null;
  const basis = { map_generated_at: map?.generated_at ?? null, latest_l2_revision_at: latestRevision,
    map_fingerprint: map ? model.architecture.fingerprint : null };
  const info = { pending_todos: projectId ? model.todos.filter(todo => todo.status === "pending").length : 0 };
  const latestActivity = Math.max(...[latestRevision, model.activity?.latest_l1_at ?? null].map(timestamp).filter(Number.isFinite));
  const activity = model.as_of && Number.isFinite(latestActivity) && timestamp(model.as_of) - latestActivity > 30 * 86_400_000 ? "dormant" : "active";
  const gaps: ProjectMapQuality["gaps"] = [];
  const addGap = (kind: GapKind, severity: ProjectMapQuality["gaps"][number]["severity"], ref: string,
    label: string, reason_en: string, reason_zh: string, event_date?: string) => {
    gaps.push({ id: `${kind}:${ref}`, kind, severity, ref, label, reason_en, reason_zh, ...(event_date ? { event_date } : {}) });
  };
  const l1 = timestamp(projectId ? model.activity?.latest_l1_at ?? null : null);
  // No L2 yet: use the 30-day score saturation lag for wholly unprocessed L1.
  const l2Lag = Number.isFinite(l1) ? latestRevision ? Math.max(0, (l1 - timestamp(latestRevision)) / 86_400_000) : 30 : 0;
  if (projectId && (l2Lag > 1 || (model.activity?.pending_l2_jobs ?? 0) > 0)) addGap("l2_backlog", l2Lag > 14 ? "high" : "medium", projectId,
    "L2 backlog / L2 积压", `L2 is ${l2Lag.toFixed(1)} days behind L1; ${model.activity?.pending_l2_jobs ?? 0} pending jobs`,
    `L2 落后 L1 ${l2Lag.toFixed(1)} 天；${model.activity?.pending_l2_jobs ?? 0} 个待处理任务`);
  if (!map) return { info, activity, version: 1, score: 0, grade: "unavailable", computed_at_basis: basis, components: [],
    gaps: [...gaps, { id: "stale_map:no_map", kind: "stale_map", severity: "high", ref: projectId ?? "", label: "Architecture map / 架构地图",
      reason_en: "no architecture map yet", reason_zh: "尚无架构地图" } as const].sort(compareGaps) };

  const components: ProjectMapQuality["components"] = [];
  let weightedScore = 0;
  const component = (id: QualityComponentId, label_en: string, label_zh: string, score: number, weight: number, value: number, detail: string) => {
    weight /= visual.state.events.length ? 1 : 0.75;
    weightedScore += score * weight;
    components.push({ id, label_en, label_zh, score: integerScore(score), weight: Number(weight.toFixed(4)), value, detail });
  };

  // Evidence: nodes plus non-containment relations with >=1 evidence ref / total.
  const evidenceItems = [...map.nodes, ...map.edges.filter(edge => edge.type !== "contains")];
  const evidenced = evidenceItems.filter(item => item.evidence_refs.length > 0).length;
  const coverage = evidenceItems.length ? evidenced / evidenceItems.length : 0;
  component("evidence_coverage", "Evidence coverage", "证据覆盖", coverage * 100, 0.25, coverage,
    `${evidenced}/${evidenceItems.length} nodes + non-contains relations with evidence / 节点及非包含关系有证据`);

  // Timeline: all canonical L2 events with any architecture_ref / all events.
  const events = [...visual.state.events].sort((a, b) => (eventTimestamp(b) - eventTimestamp(a)) || compareText(b.date, a.date) || b.order - a.order || compareText(a.id, b.id));
  const mapped = events.filter(event => event.architecture_refs.length > 0).length;
  if (events.length) component("timeline_coverage", "Timeline coverage", "时间线覆盖", mapped / events.length * 100,
    0.25, mapped / events.length, `${mapped}/${events.length} L2 events mapped / L2 事件已关联`);
  const generated = timestamp(map.generated_at);
  const unmapped = events.filter(event => !event.architecture_refs.length);
  for (const event of unmapped.slice(0, 50)) {
    const newer = eventTimestamp(event);
    const stale = Number.isFinite(newer) && newer > generated;
    addGap("unmapped_change", events.indexOf(event) < 10 ? "high" : "medium", event.id, event.title,
      stale ? "Unmapped L2 change newer than the map (stale map)" : "L2 change has no architecture reference",
      stale ? "未关联的 L2 变更新于地图（地图过期）" : "L2 变更尚无架构关联", event.date);
  }

  // Only supplied current document refs enable drift detection (legacy callers retain their basis).
  const drift = new Map<string, { removed: boolean; nodes: Set<string> }>();
  if (model.architecture_docs) {
    const current = new Map(model.architecture_docs.map(doc => [doc.path, doc.ref.split("#", 1)[0]]));
    const prefix = `architecture-doc:${projectId}:`;
    const citations = [...map.nodes.map(node => ({ refs: [...node.evidence_refs, ...(node.facets?.layer_evidence_refs ?? []), ...(node.facts ?? []).flatMap(fact => fact.evidence_refs)], node: node.id })),
      ...map.edges.map(edge => ({ refs: edge.evidence_refs, node: null })),
      ...map.timeline_links.map(link => ({ refs: link.evidence_refs, node: null })),
      { refs: map.source_evidence_refs, node: null }];
    const cited = new Map<string, { refs: Set<string>; nodes: Set<string> }>();
    for (const citation of citations) for (const anchoredRef of citation.refs) {
      const ref = anchoredRef.split("#", 1)[0]!;
      if (!ref.startsWith(prefix)) continue;
      const rest = ref.slice(prefix.length), separator = rest.indexOf(":");
      if (separator < 0) continue;
      const path = rest.slice(separator + 1);
      const entry = cited.get(path) ?? { refs: new Set<string>(), nodes: new Set<string>() };
      entry.refs.add(ref);
      if (citation.node) entry.nodes.add(citation.node);
      cited.set(path, entry);
    }
    for (const [path, entry] of cited) if ([...entry.refs].some(ref => current.get(path) !== ref)) {
      drift.set(path, { removed: !current.has(path), nodes: entry.nodes });
    }
  }
  for (const [path, entry] of drift) addGap("doc_drift", entry.removed ? "high" : "medium", path, path,
    `${entry.removed ? "Removed" : "Changed"} document; cited by ${entry.nodes.size} nodes`,
    `文档${entry.removed ? "已移除" : "已变化"}；${entry.nodes.size} 个节点引用`);
  const mapLag = Number.isFinite(generated) ? latestRevision ? Math.max(0, (timestamp(latestRevision) - generated) / 86_400_000) : 0 : 30;
  const lagDays = Math.max(mapLag, l2Lag);
  component("freshness", "Freshness", "新鲜度", Math.max(0, 100 * (1 - lagDays / 30) - drift.size * 10), 0.20, Number(lagDays.toFixed(2)),
    `Map lag / 地图滞后 ${mapLag.toFixed(1)} days; L2 behind L1 / L2 落后 L1 ${l2Lag.toFixed(1)} days; drifted docs / 漂移文档 ${drift.size}`);
  if (mapLag > 0 || unmapped.some(event => eventTimestamp(event) > generated)) addGap("stale_map", "high", projectId!,
    "Architecture map / 架构地图", "Map predates L2 revisions or unmapped changes", "地图早于 L2 修订或未关联变更");
  for (const node of map.nodes) for (const flag of (model.node_flags && Object.hasOwn(model.node_flags.flags, node.id) ? model.node_flags.flags[node.id] : []) ?? []) {
    if (!flag.cleared_at) addGap("user_flag", "high", `${node.id}:${flag.id}`, node.label,
      `${flag.reason}: ${flag.note}`, `${flag.reason}: ${flag.note}`);
  }

  const nodeIds = new Set(map.nodes.map(node => node.id));
  const parents = new Set(map.nodes.map(node => node.parent_id));
  const emptyBranches = map.nodes.filter(node => ["domain", "capability", "process"].includes(node.kind) && !parents.has(node.id));
  const dangling = map.edges.filter(edge => !nodeIds.has(edge.from) || !nodeIds.has(edge.to));
  // Structure: -5 per empty domain/capability/process, -20 per dangling relation.
  const penalties = emptyBranches.length * 5 + dangling.length * 20;
  component("structure", "Structure", "结构完整性", Math.max(0, 100 - penalties), 0.15, penalties,
    `${emptyBranches.length} empty branches × 5 + ${dangling.length} dangling relations × 20 / 空分支与悬空关系扣分`);
  for (const node of emptyBranches) addGap("empty_branch", "low", node.id, node.label, "Branch has no children", "分支没有子节点");
  for (const edge of dangling) addGap("dangling_relation", "high", `${edge.from}:${edge.type}:${edge.to}`,
    `${edge.from} → ${edge.to}`, "Relation endpoint is missing", "关系端点缺失");

  // Confidence: arithmetic mean of node confidence, expressed as a percentage.
  const confidence = map.nodes.length ? map.nodes.reduce((sum, node) => sum + node.confidence, 0) / map.nodes.length : 0;
  const nonRoot = map.nodes.filter(node => node.kind !== "project");
  const mean = nonRoot.length ? nonRoot.reduce((sum, node) => sum + node.confidence, 0) / nonRoot.length : 0;
  const deviation = nonRoot.length ? Math.sqrt(nonRoot.reduce((sum, node) => sum + (node.confidence - mean) ** 2, 0) / nonRoot.length) : 0;
  const flat = nonRoot.length >= 5 && deviation < 0.02;
  component("confidence", "Confidence", "置信度", flat ? Math.min(50, confidence * 100) : confidence * 100, 0.15, confidence,
    `${map.nodes.length} nodes; mean confidence / 节点平均置信度${flat ? "; uniform confidence / 置信度过于一致" : ""}`);
  if (flat) addGap("flat_confidence", "medium", projectId!, "Uniform confidence / 置信度过于一致",
    "uniform confidence: non-root population standard deviation < 0.02", "非根节点置信度总体标准差小于 0.02");
  for (const node of map.nodes) {
    if (!node.evidence_refs.length) addGap("node_without_evidence", "medium", node.id, node.label, "Node has no evidence reference", "节点没有证据引用");
    if (node.confidence < 0.6) addGap("low_confidence_node", node.confidence >= 0.4 ? "low" : "medium", node.id, node.label,
      `Node confidence ${node.confidence} is below 0.6`, `节点置信度 ${node.confidence} 低于 0.6`);
  }
  gaps.sort(compareGaps);
  const truncated = Math.max(0, unmapped.length - 50) + Math.max(0, gaps.length - 100);
  const score = integerScore(weightedScore);
  return { info, activity, version: 1, score, grade: score >= 80 ? "good" : score >= 60 ? "fair" : "weak", computed_at_basis: basis,
    components, gaps: gaps.slice(0, 100), ...(truncated ? { truncated } : {}) };
}
