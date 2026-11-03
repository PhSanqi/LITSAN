/** Turn-local Harness requests. This contract cannot grant scope or write memory. */
export interface ProgressiveDemand {
  version: "progressive-demand-v1";
  decision: "search" | "answer" | "abstain";
  missing_information: string[];
  queries: Array<{ text: string; keywords: string[]; reason: string }>;
  preference_refs: string[];
  strategy?: MemoryStrategy;
}

export interface MemoryStrategy {
  horizon: "working" | "current" | "history" | "durable" | "mixed";
  needs: string[];
  depth: "summary" | "passage" | "source";
  expand_refs: string[];
  required_evidence: Array<{ref: string; quote: string}>;
}
const horizons = ["working", "current", "history", "durable", "mixed"];
const needs = ["fact", "preference", "relationship", "timeline", "count"];
const depths = ["summary", "passage", "source"];
const refSchema = {type: "string", minLength: 1, maxLength: 600};
const strategySchema = {type: "object", additionalProperties: false,
  required: ["horizon", "needs", "depth", "expand_refs", "required_evidence"],
  properties: {
    horizon: {enum: horizons}, needs: {type: "array", maxItems: 5, uniqueItems: true, items: {enum: needs}},
    depth: {enum: depths}, expand_refs: {type: "array", maxItems: 3, uniqueItems: true, items: refSchema},
    required_evidence: {type: "array", maxItems: 8, items: {type: "object", additionalProperties: false,
      required: ["ref", "quote"], properties: {ref: refSchema, quote: {type: "string", minLength: 1, maxLength: 1000}}}}
  }
};

export const PROGRESSIVE_DEMAND_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["version", "decision", "missing_information", "queries", "preference_refs"],
  properties: {
    strategy: strategySchema,
    version: { const: "progressive-demand-v1" },
    decision: { enum: ["search", "answer", "abstain"] },
    missing_information: { type: "array", maxItems: 4, items: { type: "string", minLength: 1, maxLength: 240 } },
    queries: { type: "array", maxItems: 3, items: {
      type: "object", additionalProperties: false, required: ["text", "keywords", "reason"],
      properties: {
        text: { type: "string", minLength: 1, maxLength: 300 },
        keywords: { type: "array", maxItems: 6, items: { type: "string", minLength: 1, maxLength: 60 } },
        reason: { type: "string", minLength: 1, maxLength: 240 }
      }
    } },
    preference_refs: { type: "array", maxItems: 12, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 600 } }
  }
} as const;

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("request must be an object");
  const result = value as Record<string, unknown>;
  if (Object.keys(result).length !== keys.length || keys.some(key => !Object.hasOwn(result, key)) ||
      Object.keys(result).some(key => !keys.includes(key))) throw new Error("unknown or missing request field");
  return result;
}
function text(value: unknown, max: number): string {
  if (typeof value !== "string" || !value.trim() || [...value].length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) throw new Error("invalid request text");
  return value.trim();
}
function list(value: unknown, max: number, itemMax: number): string[] {
  if (!Array.isArray(value) || value.length > max) throw new Error("request list exceeds limit");
  return value.map(item => text(item, itemMax));
}
export function normalizedProgressiveQuery(query: string): string {
  return query.normalize("NFKC").toLocaleLowerCase().replace(/\s+/gu, " ").trim();
}

export function parseProgressiveDemand(value: unknown, limits: {
  round: number;
  allowedPreferenceRefs: readonly string[];
  previousQueries?: readonly string[];
  sourceEvidence?: Readonly<Record<string, string>>;
}): ProgressiveDemand {
  if (!Number.isInteger(limits.round) || limits.round < 0 || limits.round > 2) throw new Error("invalid disclosure round");
  const hasStrategy = !!value && typeof value === "object" && Object.hasOwn(value, "strategy");
  const raw = object(value, ["version", "decision", "missing_information", "queries", "preference_refs", ...(hasStrategy ? ["strategy"] : [])]);
  if (raw.version !== "progressive-demand-v1" || !["search", "answer", "abstain"].includes(String(raw.decision))) throw new Error("unsupported request version or decision");
  if (!Array.isArray(raw.queries) || raw.queries.length > 3) throw new Error("at most three queries are allowed");
  const seen = new Set((limits.previousQueries ?? []).map(normalizedProgressiveQuery));
  const queries = raw.queries.map(query => {
    const q = object(query, ["text", "keywords", "reason"]);
    const result = { text: text(q.text, 300), keywords: list(q.keywords, 6, 60), reason: text(q.reason, 240) };
    const key = normalizedProgressiveQuery(result.text);
    if (seen.has(key)) throw new Error("duplicate or repeated query");
    seen.add(key);
    return result;
  });
  const missing = list(raw.missing_information, 4, 240);
  const preferenceRefs = list(raw.preference_refs, 12, 600);
  if (new Set(preferenceRefs).size !== preferenceRefs.length || preferenceRefs.some(ref => !limits.allowedPreferenceRefs.includes(ref))) throw new Error("unknown or duplicate preference evidence ref");
  let strategy: MemoryStrategy | undefined;
  if (hasStrategy) {
    const s = object(raw.strategy, ["horizon", "needs", "depth", "expand_refs", "required_evidence"]);
    if (!horizons.includes(String(s.horizon)) || !depths.includes(String(s.depth))) throw new Error("invalid memory strategy");
    const sources = limits.sourceEvidence ?? {};
    // Display headers wrap IDs in brackets; canonicalize only a verified exact ID.
    const sourceRef = (ref: string): string => !Object.hasOwn(sources, ref) && ref.startsWith("[") && ref.endsWith("]") && Object.hasOwn(sources, ref.slice(1, -1)) ? ref.slice(1, -1) : ref;
    const selectedNeeds = list(s.needs, 5, 20), refs = list(s.expand_refs, 3, 600).map(sourceRef);
    if (new Set(selectedNeeds).size !== selectedNeeds.length || selectedNeeds.some(n => !needs.includes(n))) throw new Error("invalid evidence needs");
    if (new Set(refs).size !== refs.length || refs.some(ref => !Object.hasOwn(sources, ref))) throw new Error("unknown expansion source");
    if (!Array.isArray(s.required_evidence) || s.required_evidence.length > 8) throw new Error("too many required quotes");
    const evidence = s.required_evidence.map(item => {
      const e = object(item, ["ref", "quote"]), ref = sourceRef(text(e.ref, 600)), quote = text(e.quote, 1000);
      if (!Object.hasOwn(sources, ref) || !sources[ref]!.includes(quote)) throw new Error("required quote is not source evidence");
      return {ref, quote};
    });
    if (refs.length && (s.depth !== "source" || raw.decision !== "search")) throw new Error("source expansion requires source search");
    strategy = {horizon: s.horizon as MemoryStrategy["horizon"], needs: selectedNeeds,
      depth: s.depth as MemoryStrategy["depth"], expand_refs: refs, required_evidence: evidence};
  }
  if (raw.decision === "search") {
    if (limits.round >= 2 || (!queries.length && !strategy?.expand_refs.length) || !missing.length) throw new Error("search needs a gap and remaining round budget");
  } else if (queries.length) throw new Error("non-search decision cannot issue queries");
  return { version: "progressive-demand-v1", decision: raw.decision as ProgressiveDemand["decision"], missing_information: missing, queries, preference_refs: preferenceRefs, ...(strategy ? {strategy} : {}) };
}
