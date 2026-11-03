import { createHash } from "node:crypto";
import type { DistilledCanonicalTime, DistilledFactMetadataSet } from "./contracts/distillation.js";
import { tokenizeRetrievalText } from "./retrieval-ranker.js";

export interface EventSeriesSourceEvidence {
  evidence_ref: string;
  timestamp: string;
  text: string;
  conversation_id?: string | null;
}

export interface EventSeriesTime {
  raw: string;
  precision: "date" | "month" | "year" | "range" | "unknown";
  start?: string;
  end?: string;
  original_expression?: string;
  source: "canonical" | "relative_evidence" | "evidence_timestamp";
  confidence: number;
  answerable: boolean;
}

export function deriveEvidenceTemporalTime(source: EventSeriesSourceEvidence): EventSeriesTime | undefined {
  const anchor = parseEvidenceTextDate(source.text) ?? parseTimestampDate(source.timestamp);
  if (!anchor) return undefined;
  return relativeTime(source.text, anchor);
}

export interface EventSeriesMember {
  fact_id: string;
  parent_id: string;
  parent_heading?: string;
  text: string;
  evidence_refs: string[];
  entity_anchors: string[];
  topic_terms: string[];
  order_time?: EventSeriesTime;
  answer_time?: EventSeriesTime;
  supersedes_fact_id?: string;
}

export interface EventSeriesRecord {
  series_id: string;
  kind: "entity_timeline" | "entity_topic" | "supersession";
  entity_anchor?: string;
  topic_anchor?: string;
  member_fact_ids: string[];
}

export interface EventIdentityWindow {
  evidence_ref: string;
  session_key: string;
  previous_refs: string[];
  next_refs: string[];
}

export interface EventSeriesSidecar {
  version: "event-series-sidecar-v4";
  revision_id: string;
  memory_id: string;
  layer: "L2" | "L3";
  members: EventSeriesMember[];
  series: EventSeriesRecord[];
  identity_windows: EventIdentityWindow[];
}

export interface EventSeriesSeed {
  fact_id: string;
  score: number;
}

export interface EventSeriesExpansionHit {
  fact_id: string;
  series_id: string;
  series_kind: EventSeriesRecord["kind"];
  relation: "seed" | "neighbor" | "time_window" | "ordered_series";
  distance: number;
  score: number;
  member: EventSeriesMember;
}

export interface EventSeriesExpansion {
  temporal_query: boolean;
  query_window?: { start?: string; end?: string; year?: number; month?: number; label: string };
  selected_series: string[];
  hits: EventSeriesExpansionHit[];
}

const MONTHS = new Map<string, number>([
  ["january", 1], ["february", 2], ["march", 3], ["april", 4], ["may", 5], ["june", 6],
  ["july", 7], ["august", 8], ["september", 9], ["october", 10], ["november", 11], ["december", 12]
]);
const WEEKDAYS = new Map<string, number>([
  ["sunday", 0], ["monday", 1], ["tuesday", 2], ["wednesday", 3], ["thursday", 4], ["friday", 5], ["saturday", 6]
]);
const ENTITY_STOPWORDS = new Set([
  "Atomic", "Canonical", "Evidence", "Memory", "Arena", "Project", "Timeline", "Current", "Truth",
  "The", "This", "That", "When", "What", "Which", "Where", "How", "Why", "After", "Before",
  ...[...MONTHS.keys()].map(titleCase), ...[...WEEKDAYS.keys()].map(titleCase)
]);
const TOPIC_STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "being", "but", "by", "did", "do", "does", "for",
  "from", "had", "has", "have", "he", "her", "hers", "him", "his", "how", "i", "in", "is", "it", "its",
  "me", "my", "of", "on", "or", "our", "she", "that", "the", "their", "them", "they", "this", "to", "was",
  "we", "were", "what", "when", "where", "which", "who", "why", "with", "you", "your", "yesterday", "today",
  "before", "after", "earlier", "later", "last", "next", "ago", "day", "days", "week", "weeks", "month", "months",
  "year", "years"
]);

export function buildEventSeriesSidecar(input: {
  revisionId: string;
  memoryId: string;
  layer: "L2" | "L3";
  factMetadata: DistilledFactMetadataSet;
  sourceEvidence?: readonly EventSeriesSourceEvidence[];
}): EventSeriesSidecar {
  const evidenceByRef = new Map((input.sourceEvidence ?? []).map((item) => [item.evidence_ref, item]));
  const members = input.factMetadata.facts.map((fact) => {
    const sourceRows = fact.evidence_refs.flatMap((ref) => {
      const item = evidenceByRef.get(ref);
      return item ? [item] : [];
    });
    const text = [fact.parent_heading, fact.text].filter(Boolean).join("\n");
    const anchors = entityAnchors(text);
    const topicTerms = topicTermsFor(text, anchors);
    const times = memberTimes(fact.canonical_time, fact.text, sourceRows);
    return {
      fact_id: fact.fact_id,
      parent_id: fact.parent_id,
      ...(fact.parent_heading ? { parent_heading: fact.parent_heading } : {}),
      text: fact.text,
      evidence_refs: fact.evidence_refs.slice(),
      entity_anchors: anchors,
      topic_terms: topicTerms,
      ...(times.orderTime ? { order_time: times.orderTime } : {}),
      ...(times.answerTime ? { answer_time: times.answerTime } : {}),
      ...(fact.supersedes?.fact_id ? { supersedes_fact_id: fact.supersedes.fact_id } : {})
    } satisfies EventSeriesMember;
  });

  const byFact = new Map(members.map((member) => [member.fact_id, member]));
  const series: EventSeriesRecord[] = [];
  const entityBuckets = new Map<string, EventSeriesMember[]>();
  for (const member of members) {
    if (!member.order_time) continue;
    for (const anchor of member.entity_anchors.slice(0, 4)) {
      const bucket = entityBuckets.get(anchor) ?? [];
      bucket.push(member);
      entityBuckets.set(anchor, bucket);
    }
  }
  for (const [anchor, bucket] of entityBuckets) {
    const ordered = orderedMembers(bucket);
    if (ordered.length < 2) continue;
    series.push({
      series_id: stableSeriesId("entity", anchor),
      kind: "entity_timeline",
      entity_anchor: anchor,
      member_fact_ids: ordered.map((member) => member.fact_id)
    });
    const termBuckets = new Map<string, EventSeriesMember[]>();
    for (const member of ordered) {
      for (const term of member.topic_terms.slice(0, 8)) {
        const items = termBuckets.get(term) ?? [];
        items.push(member);
        termBuckets.set(term, items);
      }
    }
    for (const [term, items] of termBuckets) {
      const uniqueItems = uniqueMembers(items);
      if (uniqueItems.length < 2 || uniqueItems.length > 16) continue;
      series.push({
        series_id: stableSeriesId("topic", anchor, term),
        kind: "entity_topic",
        entity_anchor: anchor,
        topic_anchor: term,
        member_fact_ids: orderedMembers(uniqueItems).map((member) => member.fact_id)
      });
    }
  }

  for (const member of members) {
    const priorId = member.supersedes_fact_id;
    if (!priorId || !byFact.has(priorId)) continue;
    const pair = orderedMembers([byFact.get(priorId)!, member]);
    series.push({
      series_id: stableSeriesId("supersession", priorId, member.fact_id),
      kind: "supersession",
      member_fact_ids: pair.map((item) => item.fact_id)
    });
  }

  return {
    version: "event-series-sidecar-v4",
    revision_id: input.revisionId,
    memory_id: input.memoryId,
    layer: input.layer,
    members,
    series: dedupeSeries(series),
    identity_windows: buildIdentityWindows(input.sourceEvidence ?? [])
  };
}

function buildIdentityWindows(sourceEvidence: readonly EventSeriesSourceEvidence[]): EventIdentityWindow[] {
  const rows = sourceEvidence.map((source, index) => ({ source, index, sessionKey: evidenceSessionKey(source) }));
  const groups = new Map<string, Array<(typeof rows)[number]>>();
  for (const row of rows) {
    if (!row.sessionKey) continue;
    const group = groups.get(row.sessionKey) ?? [];
    group.push(row);
    groups.set(row.sessionKey, group);
  }
  const windows: EventIdentityWindow[] = [];
  for (const [sessionKey, group] of groups) {
    group.sort((left, right) => left.index - right.index);
    for (let index = 0; index < group.length; index += 1) {
      const current = group[index]!;
      windows.push({
        evidence_ref: current.source.evidence_ref,
        session_key: sessionKey,
        previous_refs: group.slice(Math.max(0, index - 1), index).map((item) => item.source.evidence_ref),
        next_refs: group.slice(index + 1, Math.min(group.length, index + 3)).map((item) => item.source.evidence_ref)
      });
    }
  }
  return windows;
}

function evidenceSessionKey(source: EventSeriesSourceEvidence): string | undefined {
  const bracket = /^\s*\[([^\]]+)\]/u.exec(source.text)?.[1]?.normalize("NFKC").trim().toLocaleLowerCase();
  if (bracket && /\b20\d{2}\b/u.test(bracket)) return `message-time:${bracket}`;
  if (source.conversation_id?.trim()) return `conversation:${source.conversation_id.trim()}`;
  return undefined;
}

export function queryNeedsEventSeries(query: string): boolean {
  const lower = query.normalize("NFKC").toLocaleLowerCase();
  const exactWindow = parseQueryWindow(query);
  if (exactWindow) return true;
  if (/\b(?:when|date|time|week|weeks|month|year|day|first|second|third|last|before|after|earlier|later|between|lapsed|elapsed|during|in\s+(?:january|february|march|april|may|june|july|august|september|october|november|december))\b/u.test(lower)) return true;
  if (/\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{4}\b/u.test(lower)) return true;
  return /什么时候|何时|日期|时间|哪天|哪月|哪年|第一次|第二次|首次|上次|之前|之后|以前|后来|相隔|间隔|几个月|期间/u.test(lower);
}

/**
 * A narrower gate for expanding sibling/neighbor events. Point-in-time
 * questions often need only one exact raw evidence row plus its temporal hint;
 * pulling an entire entity timeline can displace stronger evidence. Expand a
 * series only when the question explicitly asks for order/interval/windowed
 * membership, or when the caller has already found the point evidence bundle
 * insufficient.
 */
export function queryNeedsSeriesExpansion(query: string): boolean {
  const lower = query.normalize("NFKC").toLocaleLowerCase();
  if (/\b(?:first|second|third|before|after|earlier|later|between|lapsed|elapsed|interval|how\s+many\s+(?:days?|weeks?|months?|years?))\b/u.test(lower)) return true;
  if (/第一次|第二次|第三次|首次|上次|之前|之后|以前|后来|相隔|间隔|几天|几周|几个月|几年/u.test(lower)) return true;
  const window = parseQueryWindow(query);
  if (!window) return false;
  if (window?.start && window.start === window.end) return true;
  return /\b(?:which\s+places?|where|what\s+(?:significant\s+)?event|what\s+happened|activities|visiting|visited|during|towards?\s+the\s+end|beginning|start\s+of)\b/u.test(lower) ||
    /哪些地方|去了哪里|什么事件|发生了什么|期间|月底|月初|年初|年底/u.test(lower);
}

export function queryNeedsPointTemporalEvidence(query: string): boolean {
  const lower = query.normalize("NFKC").toLocaleLowerCase().trim();
  if (queryNeedsSeriesExpansion(query)) return false;
  return /^(?:when\b|what\s+date\b|which\s+(?:day|week)\b)/u.test(lower) ||
    /什么时候|何时|哪一天|哪天/u.test(lower);
}

/**
 * Relative-time wording needs the exact source row even when a distilled fact
 * already looks semantically sufficient, because the source message carries
 * the anchor required to normalize expressions such as "last week".
 */
export function queryNeedsRelativeTemporalEvidence(query: string): boolean {
  const lower = query.normalize("NFKC").toLocaleLowerCase();
  return /\b(?:last|previous|prior)\s+(?:day|week|month|year)\b/u.test(lower) ||
    /(?:昨天|前天|上周|上一周|前一周|上个月|前一个月|去年|前一年)/u.test(lower);
}

export function eventSeriesQueryWindow(query: string): EventSeriesExpansion["query_window"] | undefined {
  return parseQueryWindow(query);
}

export function expandEventSeries(input: {
  query: string;
  sidecars: readonly EventSeriesSidecar[];
  seeds: readonly EventSeriesSeed[];
  maxHits?: number;
  maxSeries?: number;
  neighborDistance?: number;
}): EventSeriesExpansion {
  const temporalQuery = queryNeedsEventSeries(input.query);
  if (!temporalQuery) return { temporal_query: false, selected_series: [], hits: [] };
  const maxHits = Math.max(1, Math.min(12, Math.trunc(input.maxHits ?? 8)));
  const maxSeries = Math.max(1, Math.min(8, Math.trunc(input.maxSeries ?? 4)));
  const neighborDistance = Math.max(1, Math.min(4, Math.trunc(input.neighborDistance ?? 2)));
  const queryWindow = parseQueryWindow(input.query);
  const queryTokens = new Set(normalizedTerms(input.query));
  const seedScores = new Map(input.seeds.map((seed) => [seed.fact_id, seed.score]));
  const seedIds = new Set(seedScores.keys());
  const sidecarMembers = new Map<string, EventSeriesMember>();
  for (const sidecar of input.sidecars) for (const member of sidecar.members) sidecarMembers.set(member.fact_id, member);
  const requestedAnchors = unique([...sidecarMembers.values()].flatMap(member => member.entity_anchors))
    .filter(anchor => queryMentionsAnchor(queryTokens, input.query, anchor));
  const wantsOrderedSeries = /\b(?:first|second|third|last|between|lapsed|elapsed|interval)\b/iu.test(input.query) || /第一次|第二次|首次|上次|相隔|间隔|几个月/u.test(input.query);

  const rankedSeries = input.sidecars.flatMap((sidecar) => sidecar.series.map((series) => {
    const members = series.member_fact_ids.flatMap((id) => {
      const member = sidecarMembers.get(id);
      return member ? [member] : [];
    });
    const seedPositions = series.member_fact_ids.flatMap((id, index) => seedIds.has(id) ? [index] : []);
    const entityMatch = series.entity_anchor ? queryMentionsAnchor(queryTokens, input.query, series.entity_anchor) : false;
    const topicMatch = series.topic_anchor ? queryTokens.has(normalizeTerm(series.topic_anchor)) : false;
    const windowMatches = queryWindow ? members.filter((member) => timeMatchesWindow(member.order_time, queryWindow)).length : 0;
    let score = seedPositions.length * 4 + (entityMatch ? 3 : 0) + (topicMatch ? 2.5 : 0) + Math.min(2, windowMatches * 0.7);
    if (series.kind === "entity_topic" && topicMatch) score += 1;
    if (wantsOrderedSeries && seedPositions.length > 0) score += 1.5;
    return { sidecar, series, members, seedPositions, entityMatch, topicMatch, windowMatches, score };
  })).filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score || left.series.series_id.localeCompare(right.series.series_id))
    .slice(0, maxSeries);

  const hits = new Map<string, EventSeriesExpansionHit>();
  for (const candidate of rankedSeries) {
    const { series, members, seedPositions } = candidate;
    for (let index = 0; index < members.length; index += 1) {
      const member = members[index]!;
      const seedScore = seedScores.get(member.fact_id);
      const nearestDistance = seedPositions.length > 0
        ? Math.min(...seedPositions.map((position) => Math.abs(position - index)))
        : Number.POSITIVE_INFINITY;
      const windowMatch = queryWindow ? timeMatchesWindow(member.order_time, queryWindow) : false;
      const isSeed = seedScore !== undefined;
      const isNeighbor = Number.isFinite(nearestDistance) && nearestDistance <= neighborDistance;
      const orderedAdmission = wantsOrderedSeries && (candidate.entityMatch || candidate.topicMatch || seedPositions.length > 0) && index < 6;
      // Recording ranges and missing dates cannot disprove a semantically retrieved event.
      const uncertainTime = !member.order_time || member.order_time.source === "evidence_timestamp" ||
        member.order_time.precision === "range" || member.order_time.precision === "unknown";
      if (queryWindow && !windowMatch && !(isSeed && uncertainTime)) continue;
      if (queryWindow && requestedAnchors.length &&
          !member.entity_anchors.some(anchor => requestedAnchors.includes(anchor))) continue;
      if (queryWindow && !eventWindowTopicRelevant(input.query, member.text)) continue;
      if (!isSeed && !windowMatch && !isNeighbor && !orderedAdmission) continue;
      const lexical = lexicalOverlap(queryTokens, member);
      const temporalBoost = windowMatch ? 0.18 : 0;
      const distanceBoost = isSeed ? 0.20 : isNeighbor ? Math.max(0.04, 0.16 - nearestDistance * 0.04) : 0;
      const base = Math.min(0.82, 0.42 + candidate.score * 0.035);
      const score = clamp01(Math.max(seedScore ?? 0, base + temporalBoost + distanceBoost + lexical * 0.18));
      const relation: EventSeriesExpansionHit["relation"] = isSeed
        ? "seed"
        : windowMatch
          ? "time_window"
          : isNeighbor
            ? "neighbor"
            : "ordered_series";
      const next: EventSeriesExpansionHit = {
        fact_id: member.fact_id,
        series_id: series.series_id,
        series_kind: series.kind,
        relation,
        distance: Number.isFinite(nearestDistance) ? nearestDistance : 99,
        score,
        member
      };
      const previous = hits.get(member.fact_id);
      if (!previous || next.score > previous.score) hits.set(member.fact_id, next);
    }
  }
  return {
    temporal_query: true,
    ...(queryWindow ? { query_window: queryWindow } : {}),
    selected_series: rankedSeries.map((candidate) => candidate.series.series_id),
    hits: [...hits.values()]
      .sort((left, right) => right.score - left.score || compareMemberTime(left.member, right.member) || left.fact_id.localeCompare(right.fact_id))
      .slice(0, maxHits)
  };
}

function memberTimes(
  canonical: DistilledCanonicalTime | undefined,
  factText: string,
  sources: readonly EventSeriesSourceEvidence[]
): { orderTime?: EventSeriesTime; answerTime?: EventSeriesTime } {
  if (canonical) {
    const value: EventSeriesTime = {
      ...canonical,
      source: "canonical",
      confidence: canonical.precision === "unknown" ? 0.6 : 1,
      answerable: canonical.precision !== "unknown"
    };
    return { orderTime: value, ...(value.answerable ? { answerTime: value } : {}) };
  }
  const factTerms = new Set(normalizedTerms(factText).filter((term) => !TOPIC_STOPWORDS.has(term)));
  const relativeInFact = containsRelativeExpression(factText);
  const rankedSources = sources.map((source) => ({
    source,
    overlap: termOverlap(factTerms, new Set(normalizedTerms(source.text).filter((term) => !TOPIC_STOPWORDS.has(term))))
  })).sort((left, right) => right.overlap - left.overlap);
  // A fact that inherited a very broad parent/job evidence set cannot safely
  // use an arbitrary L1 timestamp to normalize "yesterday" or a weekday.
  // Require a narrow evidence set, or a strong lexical binding to one source.
  for (const { source, overlap } of rankedSources.slice(0, 4)) {
    if (sources.length > 8 && overlap < 0.28) continue;
    if (!relativeInFact && overlap < 0.16) continue;
    const anchor = parseEvidenceTextDate(source.text) ?? parseTimestampDate(source.timestamp);
    if (!anchor) continue;
    const relative = relativeTime(`${factText}\n${source.text}`, anchor);
    // Month-relative source phrases are useful as raw event-window hints, but
    // they should not silently retime a broad distilled Fact. Keep Fact-level
    // series ordering behavior stable and let the raw Event Family lane bind
    // "last month" to exact L1 evidence instead.
    if (relative?.original_expression && /^(?:last|previous)\s+month$/iu.test(relative.original_expression)) continue;
    if (relative) return { orderTime: relative, answerTime: relative };
  }
  if (sources.length > 8) return {};
  const timestamps = sources
    .map((source) => parseEvidenceTextDate(source.text) ?? parseTimestampDate(source.timestamp))
    .filter((date): date is Date => Boolean(date));
  if (timestamps.length > 0) {
    timestamps.sort((left, right) => left.getTime() - right.getTime());
    const start = isoDate(timestamps[0]!);
    const end = isoDate(timestamps[timestamps.length - 1]!);
    const raw = start === end ? start : `${start} to ${end}`;
    return {
      orderTime: {
        raw,
        precision: start === end ? "date" : "range",
        start,
        ...(start === end ? {} : { end }),
        source: "evidence_timestamp",
        confidence: 0.45,
        answerable: false
      }
    };
  }
  return {};
}

function relativeTime(text: string, anchor: Date): EventSeriesTime | undefined {
  const lower = text.normalize("NFKC").toLocaleLowerCase();
  const exact = (date: Date, expression: string, confidence = 0.9): EventSeriesTime => ({
    raw: isoDate(date), precision: "date", start: isoDate(date), original_expression: expression,
    source: "relative_evidence", confidence, answerable: true
  });
  if (/\byesterday\b/u.test(lower)) return exact(addDays(anchor, -1), "yesterday", 0.98);
  if (/\btoday\b/u.test(lower)) return exact(anchor, "today", 0.98);
  const daysAgo = /\b(\d{1,3})\s+days?\s+ago\b/u.exec(lower);
  if (daysAgo) return exact(addDays(anchor, -Number(daysAgo[1])), daysAgo[0], 0.96);
  const weeksAgo = /\b(\d{1,2})\s+weeks?\s+ago\b/u.exec(lower);
  if (weeksAgo) return exact(addDays(anchor, -7 * Number(weeksAgo[1])), weeksAgo[0], 0.92);
  const previousWeek = /\b(?:last|previous)\s+week\b/u.exec(lower);
  if (previousWeek) {
    const start = isoDate(addDays(anchor, -7));
    const end = isoDate(addDays(anchor, -1));
    return {
      raw: `${start} to ${end}`,
      precision: "range",
      start,
      end,
      original_expression: previousWeek[0],
      source: "relative_evidence",
      confidence: 0.94,
      answerable: true
    };
  }
  if (/\ba few days ago\b/u.test(lower)) {
    const start = isoDate(addDays(anchor, -5));
    const end = isoDate(addDays(anchor, -2));
    return { raw: `${start} to ${end}`, precision: "range", start, end, original_expression: "a few days ago",
      source: "relative_evidence", confidence: 0.72, answerable: true };
  }
  const previousMonth = /\b(?:last|previous)\s+month\b/u.exec(lower);
  if (previousMonth) {
    const monthStart = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() - 1, 1));
    const monthEnd = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), 0));
    const start = isoDate(monthStart);
    const end = isoDate(monthEnd);
    return {
      raw: start.slice(0, 7),
      precision: "month",
      start,
      end,
      original_expression: previousMonth[0],
      source: "relative_evidence",
      confidence: 0.94,
      answerable: true
    };
  }
  const weekdayMatch = /\b(?:(last|past|previous|on)\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/u.exec(lower);
  if (weekdayMatch) {
    const qualifier = weekdayMatch[1] ?? "on";
    const weekday = WEEKDAYS.get(weekdayMatch[2]!)!;
    const current = anchor.getUTCDay();
    let delta = (current - weekday + 7) % 7;
    if (qualifier !== "on" && delta === 0) delta = 7;
    if (qualifier === "on" && delta > 6) return undefined;
    return exact(addDays(anchor, -delta), `${qualifier} ${weekdayMatch[2]}`, qualifier === "on" ? 0.80 : 0.90);
  }
  return undefined;
}

function containsRelativeExpression(text: string): boolean {
  const lower = text.normalize("NFKC").toLocaleLowerCase();
  return /\b(?:yesterday|today|a few days ago|\d{1,3}\s+days?\s+ago|\d{1,2}\s+weeks?\s+ago|(?:last|previous)\s+(?:week|month)|(?:last|past|previous|on)\s+(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday))\b/u.test(lower);
}

function entityAnchors(text: string): string[] {
  const anchors: string[] = [];
  const english = /\b([A-Z][a-z]{2,}(?:['’]s)?(?:\s+[A-Z][a-z]{2,}){0,2})\b/gu;
  for (const match of text.matchAll(english)) {
    const value = match[1]!.replace(/['’]s$/u, "").trim();
    if (!value || ENTITY_STOPWORDS.has(value)) continue;
    anchors.push(value);
  }
  return unique(anchors).slice(0, 6);
}

function topicTermsFor(text: string, anchors: readonly string[]): string[] {
  const entityTerms = new Set(anchors.flatMap((anchor) => normalizedTerms(anchor)));
  return unique(normalizedTerms(text).filter((term) =>
    term.length >= 3 && !TOPIC_STOPWORDS.has(term) && !entityTerms.has(term) && !/^\d+$/u.test(term) &&
    !MONTHS.has(term) && !WEEKDAYS.has(term)
  )).slice(0, 16);
}

function normalizedTerms(value: string): string[] {
  return tokenizeRetrievalText(value).map(normalizeTerm).filter(Boolean);
}

function normalizeTerm(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/^['’]+|['’]+$/gu, "").replace(/['’]s$/u, "");
}

function parseQueryWindow(query: string): EventSeriesExpansion["query_window"] | undefined {
  const normalized = query.normalize("NFKC").toLocaleLowerCase()
    .replace(/[零〇一二三四五六七八九]{4}(?=年)/gu, value =>
      [...value].map(char => "零一二三四五六七八九".indexOf(char === "〇" ? "零" : char)).join(""))
    .replace(/[一二三四五六七八九十两]{1,3}(?=[月日号])/gu, value => {
      const digits: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
      const parts = value.split("十");
      return String(parts.length === 2 ? (digits[parts[0]!] ?? 1) * 10 + (digits[parts[1]!] ?? 0) : digits[value] ?? 0);
    });
  const lower = normalized.replace(/\s*年\s*/gu, "年").replace(/\s*月\s*/gu, "月");
  const chineseRange = /(20\d{2})年(\d{1,2})月(?:(\d{1,2})[日号])?\s*(?:至|到|—|～|~|-)\s*(?:(20\d{2})年)?(?:(\d{1,2})月)?(?:(\d{1,2})[日号])?/u.exec(lower);
  if (chineseRange) {
    const [, y, m, d, ey, em, ed] = chineseRange;
    if (!em && !ed) return undefined;
    const start = d ? exactDateWindow(+y!, +m!, +d, chineseRange[0]) : validMonthWindow(+y!, +m!, chineseRange[0]);
    const end = ed ? exactDateWindow(+(ey ?? y)!, +(em ?? m)!, +ed, chineseRange[0])
      : validMonthWindow(+(ey ?? y)!, +(em ?? m)!, chineseRange[0]);
    if (!start?.start || !end?.end || start.start > end.end) return undefined;
    return { start: start.start, end: end.end, label: chineseRange[0] };
  }
  const numericRange = /(20\d{2})[-/](\d{1,2})[-/](\d{1,2})\s*(?:to|through|至|到|—|~)\s*(20\d{2})[-/](\d{1,2})[-/](\d{1,2})(?!\d)/u.exec(lower);
  if (numericRange) {
    const start = exactDateWindow(+numericRange[1]!, +numericRange[2]!, +numericRange[3]!, numericRange[0]);
    const end = exactDateWindow(+numericRange[4]!, +numericRange[5]!, +numericRange[6]!, numericRange[0]);
    if (!start?.start || !end?.end || start.start > end.end) return undefined;
    return { start: start.start, end: end.end, label: numericRange[0] };
  }
  const chineseDate = /(20\d{2})年(\d{1,2})月(?:(\d{1,2})[日号])?/u.exec(lower);
  if (chineseDate) {
    if (chineseDate[3]) return exactDateWindow(+chineseDate[1]!, +chineseDate[2]!, +chineseDate[3], chineseDate[0]);
    const window = validMonthWindow(+chineseDate[1]!, +chineseDate[2]!, chineseDate[0]);
    if (!window) return undefined;
    const suffix = lower.slice(chineseDate.index! + chineseDate[0].length);
    if (/^(?:初|上旬)/u.test(suffix)) window.end = window.start!.slice(0, 8) + "10";
    if (/^中旬/u.test(suffix)) { window.start = window.start!.slice(0, 8) + "11"; window.end = window.end!.slice(0, 8) + "20"; }
    if (/^(?:底|末|下旬)/u.test(suffix)) window.start = window.start!.slice(0, 8) + "21";
    return window;
  }
  const numericDate = /(?<![A-Za-z\d])(20\d{2})[-/](\d{1,2})[-/](\d{1,2})(?!\d)/u.exec(lower);
  if (numericDate) return exactDateWindow(+numericDate[1]!, +numericDate[2]!, +numericDate[3]!, numericDate[0]);
  const numericMonth = /(?<![A-Za-z\d-])(20\d{2})-(\d{2})(?![-\d])/u.exec(lower);
  if (numericMonth) return validMonthWindow(+numericMonth[1]!, +numericMonth[2]!, numericMonth[0]);
  const chineseYear = /(20\d{2})年/u.exec(lower);
  if (chineseYear) return { start: chineseYear[1] + "-01-01", end: chineseYear[1] + "-12-31", year: +chineseYear[1]!, label: chineseYear[0] };

  const explicitRange = /\b(?:between|from)\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(20\d{2}))?\s+(?:and|to|through)\s+(?:(january|february|march|april|may|june|july|august|september|october|november|december)\s+)?(\d{1,2})(?:st|nd|rd|th)?,?\s+(20\d{2})\b/u.exec(lower);
  if (explicitRange) {
    const startMonth = MONTHS.get(explicitRange[1]!)!;
    const endMonth = explicitRange[4] ? MONTHS.get(explicitRange[4]!)! : startMonth;
    const endYear = Number(explicitRange[6]);
    const startYear = explicitRange[3] ? Number(explicitRange[3]) : endYear;
    const start = exactDateWindow(startYear, startMonth, Number(explicitRange[2]), explicitRange[0]);
    const end = exactDateWindow(endYear, endMonth, Number(explicitRange[5]), explicitRange[0]);
    if (start?.start && end?.end && start.start <= end.end) {
      return {
        start: start.start,
        end: end.end,
        year: startYear === endYear ? startYear : undefined,
        label: explicitRange[0]
      };
    }
    return undefined;
  }
  const summer = /(?:end|towards?\s+the\s+end)\s+(?:of\s+)?summer\s+(\d{4})/u.exec(lower);
  if (summer) {
    const year = Number(summer[1]);
    return { start: `${year}-08-15`, end: `${year}-09-30`, year, label: `late summer ${year}` };
  }
  const isoDateMatch = /\b(20\d{2})-(\d{2})-(\d{2})\b/u.exec(lower);
  if (isoDateMatch) {
    const window = exactDateWindow(Number(isoDateMatch[1]), Number(isoDateMatch[2]), Number(isoDateMatch[3]), isoDateMatch[0]);
    if (window) return window;
  }
  const monthDayYear = /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(20\d{2})\b/u.exec(lower);
  if (monthDayYear) {
    const window = exactDateWindow(Number(monthDayYear[3]), MONTHS.get(monthDayYear[1]!)!, Number(monthDayYear[2]), monthDayYear[0]);
    return window;
  }
  const dayMonthYear = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s+(20\d{2})\b/u.exec(lower);
  if (dayMonthYear) {
    const window = exactDateWindow(Number(dayMonthYear[3]), MONTHS.get(dayMonthYear[2]!)!, Number(dayMonthYear[1]), dayMonthYear[0]);
    return window;
  }
  const beginningMonth = /\b(?:beginning|start)\s+(?:of\s+)?(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{4})\b/u.exec(lower);
  if (beginningMonth) {
    const month = MONTHS.get(beginningMonth[1]!)!;
    const year = Number(beginningMonth[2]);
    const mm = String(month).padStart(2, "0");
    return { start: `${year}-${mm}-01`, end: `${year}-${mm}-10`, year, month, label: beginningMonth[0] };
  }
  const monthYear = /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{4})\b/u.exec(lower);
  if (monthYear) {
    const month = MONTHS.get(monthYear[1]!)!;
    const year = Number(monthYear[2]);
    return monthWindow(year, month, monthYear[0]);
  }
  const yearOnly = /\b(20\d{2})\b/u.exec(lower);
  if (yearOnly) return { year: Number(yearOnly[1]), label: yearOnly[1]! };
  return undefined;
}

function exactDateWindow(year: number, month: number, day: number, label: string): NonNullable<EventSeriesExpansion["query_window"]> | undefined {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return undefined;
  const iso = isoDate(date);
  return { start: iso, end: iso, year, month, label };
}

function validMonthWindow(year: number, month: number, label: string): NonNullable<EventSeriesExpansion["query_window"]> | undefined {
  return month >= 1 && month <= 12 ? monthWindow(year, month, label) : undefined;
}

function monthWindow(year: number, month: number, label: string): NonNullable<EventSeriesExpansion["query_window"]> {
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 0));
  return { start: isoDate(start), end: isoDate(end), year, month, label };
}

function timeMatchesWindow(time: EventSeriesTime | undefined, window: NonNullable<EventSeriesExpansion["query_window"]>): boolean {
  if (!time?.start) return false;
  if (window.start && window.end) {
    const end = time.end ?? time.start;
    return end >= window.start && time.start <= window.end;
  }
  const year = Number(time.start.slice(0, 4));
  if (window.year && year !== window.year) return false;
  if (window.month) return Number(time.start.slice(5, 7)) === window.month;
  return Boolean(window.year);
}

function queryMentionsAnchor(queryTokens: ReadonlySet<string>, rawQuery: string, anchor: string): boolean {
  const normalizedAnchor = normalizeTerm(anchor);
  if (rawQuery.normalize("NFKC").toLocaleLowerCase().includes(normalizedAnchor)) return true;
  const parts = normalizedTerms(anchor);
  return parts.length > 0 && parts.every((part) => queryTokens.has(part));
}

function lexicalOverlap(queryTokens: ReadonlySet<string>, member: EventSeriesMember): number {
  if (queryTokens.size === 0) return 0;
  const terms = new Set([...member.topic_terms, ...member.entity_anchors.flatMap((anchor) => normalizedTerms(anchor))]);
  let matched = 0;
  for (const token of queryTokens) if (terms.has(token)) matched += 1;
  return matched / queryTokens.size;
}

function orderedMembers(values: readonly EventSeriesMember[]): EventSeriesMember[] {
  return uniqueMembers(values).sort(compareMemberTime);
}

function compareMemberTime(left: EventSeriesMember, right: EventSeriesMember): number {
  const a = left.order_time?.start ?? "9999-99-99";
  const b = right.order_time?.start ?? "9999-99-99";
  return a.localeCompare(b) || left.fact_id.localeCompare(right.fact_id);
}

function uniqueMembers(values: readonly EventSeriesMember[]): EventSeriesMember[] {
  const seen = new Set<string>();
  return values.filter((value) => seen.has(value.fact_id) ? false : (seen.add(value.fact_id), true));
}

function dedupeSeries(values: readonly EventSeriesRecord[]): EventSeriesRecord[] {
  const byKey = new Map<string, EventSeriesRecord>();
  for (const value of values) {
    const key = `${value.kind}\u0000${value.entity_anchor ?? ""}\u0000${value.topic_anchor ?? ""}\u0000${value.member_fact_ids.join(",")}`;
    if (!byKey.has(key)) byKey.set(key, value);
  }
  return [...byKey.values()];
}

function stableSeriesId(...parts: string[]): string {
  return `series_${createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 20)}`;
}

function parseTimestampDate(value: string): Date | undefined {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())) : undefined;
}

function parseEvidenceTextDate(text: string): Date | undefined {
  const iso = /\[(?:[^\]]*?\s+)?(20\d{2}-\d{2}-\d{2})(?:[^\]]*)\]/u.exec(text)?.[1];
  if (iso) return parseTimestampDate(`${iso}T00:00:00Z`);
  const human = /\[(?:[^\]]*?\bon\s+)?(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December),?\s+(20\d{2})[^\]]*\]/iu.exec(text);
  if (!human) return undefined;
  const month = MONTHS.get(human[2]!.toLocaleLowerCase());
  if (!month) return undefined;
  const date = new Date(Date.UTC(Number(human[3]), month - 1, Number(human[1])));
  return Number.isFinite(date.getTime()) ? date : undefined;
}

function termOverlap(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const term of left) if (right.has(term)) intersection += 1;
  return intersection / Math.max(1, Math.min(left.size, right.size));
}

function addDays(value: Date, days: number): Date {
  return new Date(value.getTime() + days * 86_400_000);
}

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

// shortcut: location intent uses lexical cues; upgrade when held-out semantic cases demonstrate a gap.
export function eventWindowTopicRelevant(query: string, bundleText: string): boolean {
  const lowerQuery = query.normalize("NFKC").toLocaleLowerCase();
  const lowerBundle = bundleText.normalize("NFKC").toLocaleLowerCase();
  const locationIntent = /\b(?:which\s+places?|what\s+places?|where\b|visiting\b|visited\b|travell?ing\b|traveling\b|state\b|city\b|country\b)\b/u.test(lowerQuery) ||
    /哪些地方|什么地方|去了哪里|在哪里|哪个州|哪座城市|哪个国家/u.test(lowerQuery);
  if (!locationIntent) return true;
  return /\b(?:went|returned|arrived|located|home|office|clinic|hospital|travel|trip|visit|visiting|visited|drive|drove|road|route|lake|mountain|mountains|banff|park|ski|city|state|country|beach|trail|hike|hiking)\b/u.test(lowerBundle) || /旅行|旅游|出行|到访|位于|居住|去了|返回|城市|国家|公园|海滩/u.test(lowerBundle);
}

