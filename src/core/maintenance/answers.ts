import { ARCHITECTURE_NODE_KINDS } from "../architecture/node-kinds.js";
import { validateFactCoverage } from "./quality.js";
import type { MaintenanceCard, L2ChunkInput, ArchLinkInput, L2ChunkAnswer, ArchLinkAnswer, GapCheckAnswer, CardValidationResult, MaintenanceRejectCode } from "../../contracts/maintenance.js";
const fail = (code: MaintenanceRejectCode, detail: string): CardValidationResult => ({ ok: false, code, detail });
const record = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const keys = (v: Record<string, unknown>, allowed: string[]) => Object.keys(v).every(k => allowed.includes(k));
const text = (v: unknown, max: number) => typeof v === "string" && Boolean(v.trim()) && v.length <= max;
const refs = (v: unknown): v is string[] => Array.isArray(v) && v.length > 0 && v.every(r => typeof r === "string" && r.length > 0);
function inlineEvidenceRefs(body: string): string[] {
  return body.split(/\r?\n/u).flatMap(raw => {
    const line = raw.replace(/\*\*/gu, "");
    const marker = /(?:^|\s*\|\s*|\s+)(?:evidence|refs?|证据|引用)\s*[:：]\s*/iu.exec(line);
    const bracket = /\s*\[([^\]]+)\]\s*$/u.exec(line);
    const evidence = marker ? line.slice(marker.index + marker[0].length) : bracket?.[1] ?? "";
    return (evidence.match(/\b(?:l[1-4]|skill|l1-memory|raw-turn):[^\s,;|)\]}\x60*>]+/giu) ?? [])
      .map(ref => ref.replace(/[.:]+$/u, ""));
  });
}
export function validateL2ChunkAnswer(card: MaintenanceCard, answer: unknown): CardValidationResult {
  if (!record(answer)) return fail("schema_invalid", "answer must be an object");
  if (!keys(answer, ["events", "skip_reason", ...((card.input as L2ChunkInput)?.quality ? ["facts"] : [])]) || !Array.isArray(answer.events) || answer.events.length > 3 ||
    (answer.skip_reason !== undefined && !text(answer.skip_reason, 300)) || (!answer.events.length && !text(answer.skip_reason, 300))) return fail("schema_invalid", "expected 0-3 events, or events:[] with skip_reason");
  for (const event of answer.events) {
    if (!record(event) || !keys(event, ["date", "title_en", "title_zh", "body_en", "body_zh", "evidence_refs", "continues"])) return fail("schema_invalid", "unknown event fields");
    if ([event.title_en, event.title_zh, event.body_en, event.body_zh].some(t => typeof t !== "string" || !t.trim())) return fail("bilingual_missing", "all four bilingual fields are required");
    if (![event.title_en, event.body_en].every(t => /[A-Za-z]/u.test(t as string)) ||
      ![event.title_zh, event.body_zh].every(t => /[\u3400-\u9fff]/u.test(t as string))) {
      return fail("bilingual_missing", "English and Chinese text are required in their respective fields");
    }
    for (const [field, limit] of [["title_en", 160], ["title_zh", 160], ["body_en", 1200], ["body_zh", 1200]] as const) {
      if (!text(event[field], limit)) return fail("schema_invalid", `${field} must contain 1-${limit} characters (received ${(event[field] as string).length})`);
    }
    if (typeof event.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(event.date) || !Number.isFinite(Date.parse(event.date)) || new Date(event.date).toISOString().slice(0, 10) !== event.date) return fail("schema_invalid", "date must be a valid YYYY-MM-DD date");
    if (!refs(event.evidence_refs)) return fail("schema_invalid", "evidence_refs must be a nonempty string array");
    if (event.continues !== undefined && (typeof event.continues !== "string" ||
      !(card.input as L2ChunkInput | undefined)?.prior_events?.some(prior => prior.key === event.continues))) return fail("schema_invalid", "continues must name a prior_events key");
    if (event.evidence_refs.some(r => !card.allowed_refs.includes(r))) return fail("ref_not_allowed", "event ref outside allowed_refs");
    const eventRefs = event.evidence_refs;
    if (eventRefs.length > 1) {
      const facts = (event.body_en as string).split(/\r?\n/u).filter(line => line.trim());
      if (facts.some(line => !/^Atomic fact:/u.test(line.trim()) || !inlineEvidenceRefs(line).length))
        return fail("schema_invalid", "multi-source events require an Atomic fact: line and supporting | Evidence: refs for each claim");
    }
    if ([event.body_en as string, event.body_zh as string].flatMap(inlineEvidenceRefs).some(r => !eventRefs.includes(r))) {
      return fail("ref_not_allowed", "inline fact ref outside event evidence_refs");
    }
  }
  if ((card.input as L2ChunkInput)?.quality) {
    const error = validateFactCoverage(card, answer as unknown as L2ChunkAnswer);
    if (error) return fail("schema_invalid", error);
  }
  return { ok: true, normalized: structuredClone(answer) as unknown as L2ChunkAnswer };
}
export function validateArchLinkAnswer(card: MaintenanceCard, answer: unknown): CardValidationResult {
  if (!record(answer)) return fail("schema_invalid", "answer must be an object");
  if (answer.no_fit === true) {
    if (!keys(answer, ["no_fit", "reason"]) || !text(answer.reason, 300)) return fail("schema_invalid", "no_fit requires a reason up to 300 chars");
  } else {
    if (!keys(answer, ["links"]) || !Array.isArray(answer.links) || answer.links.length < 1 || answer.links.length > 3) return fail("schema_invalid", "expected 1-3 links");
    const candidates = card.kind === "arch_link" ? (card.input as ArchLinkInput).candidates : [];
    for (const link of answer.links) {
      if (!record(link) || !keys(link, ["architecture_refs", "architecture_level", "change_kind", "confidence"]) || !refs(link.architecture_refs) ||
        !ARCHITECTURE_NODE_KINDS.some(kind => kind === link.architecture_level) || !["add", "refine", "replace", "remove", "reroute"].includes(String(link.change_kind)) ||
        typeof link.confidence !== "number" || !Number.isFinite(link.confidence) || link.confidence < 0 || link.confidence > 1) return fail("schema_invalid", "invalid link fields");
      if (link.architecture_refs.some(id => !candidates.some(n => n.id === id))) return fail("node_not_allowed", "node outside candidates");
      if (link.architecture_refs.some(id => candidates.find(n => n.id === id)!.kind !== link.architecture_level)) return fail("schema_invalid", "level must equal every referenced node kind");
    }
  }
  return { ok: true, normalized: structuredClone(answer) as unknown as ArchLinkAnswer };
}

export function validateGapCheckAnswer(card: MaintenanceCard, answer: unknown): CardValidationResult {
  if (!record(answer) || !keys(answer, ["verdict", "evidence_refs", "confidence", "note"]) ||
    !["supported", "still_gap", "possibly_obsolete"].includes(String(answer.verdict)) ||
    !Array.isArray(answer.evidence_refs) || !answer.evidence_refs.every(r => typeof r === "string" && r.length > 0) ||
    (answer.verdict === "supported" && !answer.evidence_refs.length) ||
    typeof answer.confidence !== "number" || !Number.isFinite(answer.confidence) || answer.confidence < 0 || answer.confidence > 1 ||
    typeof answer.note !== "string" || answer.note.length > 300) return fail("schema_invalid", "invalid gap verdict, refs, confidence or note");
  if (answer.evidence_refs.some(r => !card.allowed_refs.includes(r))) return fail("ref_not_allowed", "gap ref outside allowed_refs");
  return { ok: true, normalized: structuredClone(answer) as unknown as GapCheckAnswer };
}

// These schemas travel with the card; submit still validates independently.
const string = (maxLength: number) => ({ type: "string", minLength: 1, maxLength });
const refArray = { type: "array", minItems: 1, items: { type: "string", minLength: 1 } };
export const GAP_CHECK_ANSWER_SCHEMA: Record<string, unknown> = {
  type: "object", additionalProperties: false, required: ["verdict", "evidence_refs", "confidence", "note"], properties: {
    verdict: { enum: ["supported", "still_gap", "possibly_obsolete"] },
    evidence_refs: { type: "array", items: { type: "string", minLength: 1 } },
    confidence: { type: "number", minimum: 0, maximum: 1 }, note: { type: "string", maxLength: 300 }
  }, allOf: [{ if: { properties: { verdict: { const: "supported" } } }, then: { properties: { evidence_refs: { minItems: 1 } } } }]
};
export const L2_ANSWER_SCHEMA: Record<string, unknown> = {
  type: "object", additionalProperties: false, required: ["events"], properties: {
    events: { type: "array", maxItems: 3, items: { type: "object", additionalProperties: false,
      required: ["date", "title_en", "title_zh", "body_en", "body_zh", "evidence_refs"], properties: {
        date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" }, title_en: string(160), title_zh: string(160), body_en: string(1200), body_zh: string(1200), evidence_refs: refArray } } }, skip_reason: string(300)
  }, allOf: [{ if: { properties: { events: { maxItems: 0 } } }, then: { required: ["skip_reason"] } }]
};
// Continuations are a maintenance-card output extension; keep the shared distill MCP input schema unchanged.
export const L2_CHUNK_ANSWER_SCHEMA = structuredClone(L2_ANSWER_SCHEMA);
((L2_CHUNK_ANSWER_SCHEMA.properties as { events: { items: { properties: Record<string, unknown> } } }).events.items.properties).continues = { type: "string", minLength: 1 };
export const ARCH_LINK_ANSWER_SCHEMA: Record<string, unknown> = { oneOf: [
  { type: "object", additionalProperties: false, required: ["no_fit", "reason"], properties: { no_fit: { const: true }, reason: string(300) } },
  { type: "object", additionalProperties: false, required: ["links"], properties: { links: { type: "array", minItems: 1, maxItems: 3, items: {
    type: "object", additionalProperties: false, required: ["architecture_refs", "architecture_level", "change_kind", "confidence"], properties: {
      architecture_refs: refArray, architecture_level: { enum: ARCHITECTURE_NODE_KINDS }, change_kind: { enum: ["add", "refine", "replace", "remove", "reroute"] }, confidence: { type: "number", minimum: 0, maximum: 1 }
    }
  } } } }
] };
