import { createHash } from "node:crypto";
import type { ProjectReader } from "./core/ports/projects.js";
import type {
  DistilledCanonicalTime,
  DistilledFactMetadata,
  DistilledFactMetadataSet,
  DistilledFactParent,
  DistillationEvidenceItem,
  DistillationJob,
  DistillationTarget
} from "./contracts/distillation.js";

const FACT_RE = /^(atomic\s+facts?|facts?|原子事实|事实)\s*[:：]\s*(.+)$/iu;
const TIME_RE = /^(?:canonical\s+time|normalized\s+time|规范时间|标准时间|绝对时间)\s*[:：]\s*(.+)$/iu;
const SUPERSEDES_RE = /^(?:supersedes?|replaces?|取代|替代)\s*[:：]\s*(.+)$/iu;
const EVIDENCE_LINE_RE = /^((?:evidence|refs?|证据|引用)(?:\s*\/\s*(?:evidence|refs?|证据|引用))?)\s*[:：]\s*(.*)$/iu;
const EVIDENCE_REF_RE = /\b(?:l[1-4]|skill|l1-memory|raw-turn):[^\s,;|)\]}\x60*>]+/giu;
const PLAIN_BULLET_RE = /^[-*+]\s+(.+)$/u;

const MONTHS = new Map<string, number>([
  ["january", 1], ["february", 2], ["march", 3], ["april", 4],
  ["may", 5], ["june", 6], ["july", 7], ["august", 8],
  ["september", 9], ["october", 10], ["november", 11], ["december", 12]
]);
const MONTH_PATTERN = "January|February|March|April|May|June|July|August|September|October|November|December";

interface MutableParent {
  parent_id: string;
  heading?: string;
  canonical_time?: DistilledCanonicalTime;
  evidence_refs: string[];
  facts: DistilledFactMetadata[];
}

export function extractDistilledFactMetadata(
  kind: DistillationTarget,
  content: string,
  fallbackEvidenceRefs: readonly string[] = []
): DistilledFactMetadataSet | undefined {
  if (kind !== "l2" && kind !== "l3") return undefined;
  const layer = kind.toUpperCase() as "L2" | "L3";
  const parents: MutableParent[] = [];
  let current = createParent(layer, undefined, parents.length);
  parents.push(current);
  let ordinal = 0;
  let lastFact: DistilledFactMetadata | undefined;
  let lastFactGroup: DistilledFactMetadata[] = [];
  let pendingPlain: { text: string; evidenceRefs: string[] } | undefined;
  let awaitingParentEvidenceContinuation = false;

  const addFacts = (values: readonly { text: string; evidenceRefs: string[] }[]): DistilledFactMetadata[] => {
    const added: DistilledFactMetadata[] = [];
    for (const value of values) {
      const text = cleanFactText(value.text);
      if (!text || isNonFactBullet(text)) continue;
      ordinal += 1;
      const item: DistilledFactMetadata = {
        fact_id: stableId("fact", [layer, current.parent_id, String(ordinal), text]),
        ordinal,
        text,
        parent_id: current.parent_id,
        ...(current.heading ? { parent_heading: current.heading } : {}),
        ...(current.canonical_time ? { canonical_time: current.canonical_time } : {}),
        evidence_refs: unique(value.evidenceRefs)
      };
      current.facts.push(item);
      added.push(item);
    }
    if (added.length > 0) {
      lastFactGroup = added;
      lastFact = added[added.length - 1];
    }
    return added;
  };

  const flushPendingPlain = (): void => {
    if (!pendingPlain) return;
    addFacts([pendingPlain]);
    pendingPlain = undefined;
  };

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const indent = leadingIndent(rawLine);
    const structuralLine = normalizeStructuralLine(line);

    if (awaitingParentEvidenceContinuation) {
      const refs = extractEvidenceRefs(structuralLine);
      if (refs.length > 0) {
        current.evidence_refs = unique([...current.evidence_refs, ...refs]);
        awaitingParentEvidenceContinuation = false;
        continue;
      }
      awaitingParentEvidenceContinuation = false;
    }

    const heading = /^#{2,3}\s+(.+)$/.exec(line);
    if (heading) {
      const headingText = heading[1]!.trim();
      if (isTranslationOnlyHeading(headingText)) continue;
      flushPendingPlain();
      current = createParent(layer, headingText, parents.length);
      const inferredTime = parseCanonicalTime(headingText);
      if (inferredTime.precision !== "unknown") current.canonical_time = inferredTime;
      parents.push(current);
      lastFact = undefined;
      lastFactGroup = [];
      continue;
    }
    const time = TIME_RE.exec(structuralLine);
    if (time) {
      flushPendingPlain();
      current.canonical_time = parseCanonicalTime(time[1]!.trim());
      continue;
    }
    const fact = FACT_RE.exec(structuralLine);
    if (fact) {
      const label = fact[1]!.toLocaleLowerCase();
      if (label === "原子事实" || label === "事实") continue;
      if (indent > 0) pendingPlain = undefined;
      else flushPendingPlain();
      const parsed = splitInlineEvidence(fact[2]!.trim());
      addFacts(splitAtomicFacts(parsed.text).map((text) => ({ text, evidenceRefs: parsed.evidenceRefs })));
      continue;
    }
    const supersedes = SUPERSEDES_RE.exec(structuralLine);
    if (supersedes) {
      flushPendingPlain();
      if (!lastFact) continue;
      const parsed = splitInlineEvidence(supersedes[1]!.trim());
      const target = lastFact;
      const prior = findPriorFact(parents, parsed.text, target.fact_id);
      target.supersedes = {
        text: parsed.text,
        ...(prior ? { fact_id: prior.fact_id } : {})
      };
      target.evidence_refs = unique([...target.evidence_refs, ...parsed.evidenceRefs]);
      lastFact = target;
      lastFactGroup = [target];
      continue;
    }
    const evidence = EVIDENCE_LINE_RE.exec(structuralLine);
    if (evidence) {
      const label = evidence[1] ?? "";
      const refs = extractEvidenceRefs(evidence[2] ?? "");
      const bilingualParentBlock = label.includes("/");
      if (bilingualParentBlock) {
        current.evidence_refs = unique([...current.evidence_refs, ...refs]);
        awaitingParentEvidenceContinuation = refs.length === 0;
      } else {
        if (indent === 0) {
          current.evidence_refs = unique([...current.evidence_refs, ...refs]);
          awaitingParentEvidenceContinuation = refs.length === 0;
        } else if (pendingPlain) {
          pendingPlain.evidenceRefs = unique([...pendingPlain.evidenceRefs, ...refs]);
        } else if (lastFactGroup.length > 0) {
          for (const factItem of lastFactGroup) {
            factItem.evidence_refs = unique([...factItem.evidence_refs, ...refs]);
          }
        } else {
          current.evidence_refs = unique([...current.evidence_refs, ...refs]);
        }
      }
      continue;
    }

    const plainBullet = indent === 0 ? PLAIN_BULLET_RE.exec(line) : null;
    if (plainBullet) {
      const parsed = splitInlineEvidence(plainBullet[1]!.trim());
      if (!parsed.text || isTranslationOnlyBullet(parsed.text) || isNonFactBullet(parsed.text)) continue;
      flushPendingPlain();
      pendingPlain = { text: parsed.text, evidenceRefs: parsed.evidenceRefs };
      lastFactGroup = [];
    }
  }

  flushPendingPlain();

  const fallbackRefs = unique(fallbackEvidenceRefs);
  const hydratedFacts = parents.flatMap((parent) => parent.facts.map((fact) => ({
    ...fact,
    evidence_refs: fact.evidence_refs.length > 0
      ? fact.evidence_refs
      : parent.evidence_refs.length > 0
        ? parent.evidence_refs.slice()
        : fallbackRefs.slice()
  })));
  const facts = kind === "l2"
    ? hydratedFacts.filter((fact) => fact.evidence_refs.length > 0)
    : hydratedFacts;
  if (facts.length === 0) return undefined;

  const keptFactIds = new Set(facts.map((fact) => fact.fact_id));
  const durableParents: DistilledFactParent[] = parents
    .map((parent) => ({ parent, factIds: parent.facts.map((fact) => fact.fact_id).filter((id) => keptFactIds.has(id)) }))
    .filter(({ factIds }) => factIds.length > 0)
    .map(({ parent, factIds }) => ({
      parent_id: parent.parent_id,
      ...(parent.heading ? { heading: parent.heading } : {}),
      ...(parent.canonical_time ? { canonical_time: parent.canonical_time } : {}),
      evidence_refs: parent.evidence_refs.slice(),
      fact_ids: factIds
    }));

  return {
    version: "memhub-fact-metadata-v1",
    layer,
    facts,
    parents: durableParents
  };
}

export function factMetadataSummary(metadata: DistilledFactMetadataSet | undefined): Record<string, unknown> | undefined {
  if (!metadata) return undefined;
  return {
    version: metadata.version,
    layer: metadata.layer,
    fact_count: metadata.facts.length,
    parent_count: metadata.parents.length,
    temporal_fact_count: metadata.facts.filter((fact) => fact.canonical_time).length,
    superseding_fact_count: metadata.facts.filter((fact) => fact.supersedes).length
  };
}

export function verifiedFactEvidenceRefs(input: {
  kind: DistillationTarget;
  accountId: string;
  projectId: string | null;
  projectStorageIds?: readonly string[];
  evidence: readonly DistillationEvidenceItem[];
  jobs: readonly DistillationJob[];
  asOf?: string;
}): string[] {
  const layer = input.kind === "l2" ? "L1" : input.kind === "l3" ? "L2" : undefined;
  if (!layer || !input.projectId) return [];
  const refs = input.evidence.filter((item) => item.layer === layer).map((item) => item.ref);
  if (input.kind === "l2") {
    const cutoff = input.asOf === undefined ? Infinity : Date.parse(input.asOf);
    const projectIds = new Set([input.projectId, ...(input.projectStorageIds ?? [])]);
    for (const job of input.jobs) {
      const timestamp = Date.parse(job.result_committed_at ?? job.completed_at ?? job.updated_at);
      // Same-millisecond revisions have no reliable completion order.
      if (job.account_id !== input.accountId || !job.project_id || !projectIds.has(job.project_id) ||
          job.status !== "completed" || job.target !== "l2" || job.result_kind !== "l2" ||
          Number.isNaN(cutoff) || !Number.isFinite(timestamp) || timestamp >= cutoff) continue;
      refs.push(...job.evidence.filter((item) => item.layer === "L1").map((item) => item.ref));
    }
  }
  return unique(refs);
}

export type FactProjectReader = Pick<ProjectReader, "resolve"> & Partial<Pick<ProjectReader, "storageIds">>;

export async function factProjectStorageIds(
  projects: FactProjectReader | undefined,
  accountId: string,
  projectId: string | null
): Promise<string[]> {
  if (!projectId) return [];
  if (!projects?.storageIds) return [projectId];
  const canonical = await projects.resolve(accountId, projectId, { includeArchived: true });
  return canonical ? projects.storageIds(accountId, canonical) : [projectId];
}

export function filterFactMetadataEvidence(
  metadata: DistilledFactMetadataSet | undefined,
  verifiedRefs: readonly string[]
): DistilledFactMetadataSet | undefined {
  if (!metadata) return undefined;
  const allowed = new Set(verifiedRefs);
  const facts = metadata.facts.map((fact) => ({
    ...fact,
    evidence_refs: fact.evidence_refs.filter((ref) => allowed.has(ref))
  })).filter((fact) => fact.evidence_refs.length > 0);
  if (facts.length === 0) return undefined;
  const ids = new Set(facts.map((fact) => fact.fact_id));
  return {
    ...metadata,
    facts: facts.map((fact) => {
      if (!fact.supersedes?.fact_id || ids.has(fact.supersedes.fact_id)) return fact;
      return { ...fact, supersedes: { text: fact.supersedes.text } };
    }),
    parents: metadata.parents.map((parent) => ({
      ...parent,
      evidence_refs: parent.evidence_refs.filter((ref) => allowed.has(ref)),
      fact_ids: parent.fact_ids.filter((id) => ids.has(id))
    })).filter((parent) => parent.fact_ids.length > 0)
  };
}

function createParent(layer: "L2" | "L3", heading: string | undefined, index: number): MutableParent {
  return {
    parent_id: stableId("parent", [layer, heading ?? "root", String(index)]),
    ...(heading ? { heading } : {}),
    evidence_refs: [],
    facts: []
  };
}

function parseCanonicalTime(raw: string): DistilledCanonicalTime {
  const original = /original\s+expression\s*['“"]([^'”"]+)['”"]/iu.exec(raw)?.[1]?.trim();
  const range = /(\d{4}-\d{2}-\d{2})\s*(?:to|through|–|—)\s*(\d{4}-\d{2}-\d{2})/iu.exec(raw);
  if (range) return { raw, precision: "range", start: range[1], end: range[2], ...(original ? { original_expression: original } : {}) };
  const date = /\b(\d{4}-\d{2}-\d{2})\b/u.exec(raw)?.[1];
  if (date) return { raw, precision: "date", start: date, ...(original ? { original_expression: original } : {}) };
  const crossMonthRange = new RegExp(`\\b(\\d{1,2})\\s+(${MONTH_PATTERN})\\s*(?:to|through|–|—|-)\\s*(\\d{1,2})\\s+(${MONTH_PATTERN})\\s+(\\d{4})\\b`, "iu").exec(raw);
  if (crossMonthRange) {
    const start = humanDate(Number(crossMonthRange[5]), crossMonthRange[2]!, Number(crossMonthRange[1]));
    const end = humanDate(Number(crossMonthRange[5]), crossMonthRange[4]!, Number(crossMonthRange[3]));
    if (start && end) return { raw, precision: "range", start, end, ...(original ? { original_expression: original } : {}) };
  }
  const sameMonthRange = new RegExp(`\\b(\\d{1,2})\\s*(?:to|through|–|—|-)\\s*(\\d{1,2})\\s+(${MONTH_PATTERN})\\s+(\\d{4})\\b`, "iu").exec(raw);
  if (sameMonthRange) {
    const start = humanDate(Number(sameMonthRange[4]), sameMonthRange[3]!, Number(sameMonthRange[1]));
    const end = humanDate(Number(sameMonthRange[4]), sameMonthRange[3]!, Number(sameMonthRange[2]));
    if (start && end) return { raw, precision: "range", start, end, ...(original ? { original_expression: original } : {}) };
  }
  const humanSingleDate = new RegExp(`\\b(\\d{1,2})\\s+(${MONTH_PATTERN})\\s+(\\d{4})\\b`, "iu").exec(raw);
  if (humanSingleDate) {
    const start = humanDate(Number(humanSingleDate[3]), humanSingleDate[2]!, Number(humanSingleDate[1]));
    if (start) return { raw, precision: "date", start, ...(original ? { original_expression: original } : {}) };
  }
  const humanMonth = new RegExp(`\\b(${MONTH_PATTERN})\\s+(\\d{4})\\b`, "iu").exec(raw);
  if (humanMonth) {
    const monthNumber = MONTHS.get(humanMonth[1]!.toLowerCase());
    if (monthNumber) return { raw, precision: "month", start: `${humanMonth[2]}-${String(monthNumber).padStart(2, "0")}`, ...(original ? { original_expression: original } : {}) };
  }
  const month = /\b(\d{4}-\d{2})\b/u.exec(raw)?.[1];
  if (month) return { raw, precision: "month", start: month, ...(original ? { original_expression: original } : {}) };
  const year = /\b(\d{4})\b/u.exec(raw)?.[1];
  if (year) return { raw, precision: "year", start: year, ...(original ? { original_expression: original } : {}) };
  return { raw, precision: "unknown", ...(original ? { original_expression: original } : {}) };
}

function splitInlineEvidence(value: string): { text: string; evidenceRefs: string[] } {
  const marker = /(?:\s*\|\s*|\s+)(?:Evidence|Refs?|证据|引用)\s*[:：]\s*/iu.exec(value);
  if (marker && marker.index !== undefined) {
    const evidenceStart = marker.index + marker[0].length;
    return { text: value.slice(0, marker.index).trim(), evidenceRefs: extractEvidenceRefs(value.slice(evidenceStart)) };
  }
  const trailingRefs = /\s*\[([^\]]+)\]\s*$/u.exec(value);
  if (trailingRefs) {
    const evidenceRefs = extractEvidenceRefs(trailingRefs[1] ?? "");
    if (evidenceRefs.length > 0) return { text: value.slice(0, trailingRefs.index).trim(), evidenceRefs };
  }
  return { text: value.trim(), evidenceRefs: [] };
}

function extractEvidenceRefs(value: string): string[] {
  return unique((value.match(EVIDENCE_REF_RE) ?? []).map((ref) => ref.replace(/[.:]+$/u, "")));
}

function findPriorFact(parents: readonly MutableParent[], text: string, excludingId: string): DistilledFactMetadata | undefined {
  const wanted = normalize(text);
  if (!wanted) return undefined;
  return parents.flatMap((parent) => parent.facts).filter((fact) => fact.fact_id !== excludingId).reverse().find((fact) => normalize(fact.text) === wanted);
}

function normalize(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").replace(/[.!?。！？]+$/u, "").trim();
}

function stableId(prefix: string, parts: readonly string[]): string {
  return `${prefix}_${createHash("sha256").update(parts.join("\u0000"), "utf8").digest("hex").slice(0, 24)}`;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function leadingIndent(value: string): number {
  const whitespace = /^\s*/u.exec(value)?.[0] ?? "";
  return whitespace.replace(/\t/gu, "    ").length;
}

function splitAtomicFacts(value: string): string[] {
  const parts = value.split(/[;；]/u).map((part) => cleanFactText(part)).filter(Boolean);
  return parts.length > 0 ? parts : [cleanFactText(value)].filter(Boolean);
}

function cleanFactText(value: string): string {
  const trimmed = value.trim();
  const strong = /^\*\*(.+)\*\*$/u.exec(trimmed);
  return (strong?.[1] ?? trimmed).trim();
}

function normalizeStructuralLine(line: string): string {
  return line.replace(/^[-*+]\s+/u, "").replace(/\*\*/gu, "").trim();
}

function isTranslationOnlyHeading(value: string): boolean {
  return /\p{Script=Han}/u.test(value) && !/[A-Za-z]/u.test(value);
}

function isTranslationOnlyBullet(value: string): boolean {
  return /\p{Script=Han}/u.test(value) && !/[A-Za-z]/u.test(value);
}

function isNonFactBullet(value: string): boolean {
  return /^(?:project|项目|scope|范围|status|状态|source|来源|version|版本|contract|合约|layer|层级|memory\s+id)\s*[:：]/iu.test(value)
    || /^no\s+explicit\s+(?:supersession|replacement|correction)\b/iu.test(value)
    || /^(?:未发现|没有)明确的(?:取代|替代|更正|纠正)/u.test(value);
}

function humanDate(year: number, monthName: string, day: number): string | undefined {
  const month = MONTHS.get(monthName.toLowerCase());
  if (!month || !Number.isInteger(year) || !Number.isInteger(day)) return undefined;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return undefined;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
