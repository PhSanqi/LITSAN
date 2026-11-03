import assert from "node:assert/strict";
import { extractDistilledFactMetadata } from "../dist/fact-metadata.js";
import { buildEventSeriesSidecar, deriveEvidenceTemporalTime, expandEventSeries, queryNeedsEventSeries, queryNeedsPointTemporalEvidence, queryNeedsRelativeTemporalEvidence, queryNeedsSeriesExpansion } from "../dist/event-series.js";

const timeline = [
  "# Timeline",
  "## First doctor visit",
  "Canonical time: 2023-05-10",
  "- Atomic fact: Sam went to the doctor for the first appointment about his weight problem. | Evidence: l1:doctor-1",
  "## Second doctor visit",
  "Canonical time: 2023-08-10",
  "- Atomic fact: Sam returned to the doctor for a second appointment about the weight problem. | Evidence: l1:doctor-2",
  "## Appreciation letter",
  "- Atomic fact: Deborah received an appreciation letter from her community yesterday. | Evidence: l1:letter",
  "## Soccer injury",
  "- Atomic fact: Evan's son was injured at soccer last Saturday. | Evidence: l1:soccer",
  "## Canada trip",
  "Canonical time: 2023-07-12",
  "- Atomic fact: Evan visited Banff in Canada. | Evidence: l1:banff",
  "## Canada trip continued",
  "Canonical time: 2023-07-16",
  "- Atomic fact: Evan explored the Rocky Mountains in Canada. | Evidence: l1:rockies",
  "## Later Canada trip",
  "Canonical time: 2023-08-04",
  "- Atomic fact: Evan visited Vancouver in Canada. | Evidence: l1:vancouver"
].join("\n");

const metadata = extractDistilledFactMetadata("l2", timeline);
assert.ok(metadata);
const sourceEvidence = [
  { evidence_ref: "l1:doctor-1", timestamp: "2023-05-10T12:00:00Z", text: "Sam: I went to the doctor about my weight problem." },
  { evidence_ref: "l1:doctor-2", timestamp: "2023-08-10T12:00:00Z", text: "Sam: I went back for my second doctor's appointment." },
  { evidence_ref: "l1:letter", timestamp: "2023-01-27T12:00:00Z", text: "[9:49 am on 27 January, 2023] Deborah: Look what letter I received yesterday!" },
  { evidence_ref: "l1:letter-question", timestamp: "2023-01-27T12:00:01Z", text: "[9:49 am on 27 January, 2023] Jolene: What touching words! Who is this letter from?" },
  { evidence_ref: "l1:letter-answer", timestamp: "2023-01-27T12:00:02Z", text: "[9:49 am on 27 January, 2023] Deborah: The group members sent this to me! They thanked me for the positive influence I had on them." },
  { evidence_ref: "l1:soccer", timestamp: "2023-08-15T12:00:00Z", text: "Evan: My son was injured at soccer last Saturday." },
  { evidence_ref: "l1:banff", timestamp: "2023-07-12T12:00:00Z", text: "Evan: I'm visiting Banff in Canada." },
  { evidence_ref: "l1:rockies", timestamp: "2023-07-16T12:00:00Z", text: "Evan: The Rocky Mountains are amazing." },
  { evidence_ref: "l1:vancouver", timestamp: "2023-08-04T12:00:00Z", text: "Evan: I'm in Vancouver now." }
];

const sidecar = buildEventSeriesSidecar({
  revisionId: "r1",
  memoryId: "timeline-1",
  layer: "L2",
  factMetadata: metadata,
  sourceEvidence
});
assert.equal(sidecar.version, "event-series-sidecar-v4");
assert.equal(sidecar.revision_id, "r1");
assert.ok(sidecar.series.some((series) => series.kind === "entity_timeline" && series.entity_anchor === "Sam"));
assert.ok(sidecar.series.some((series) => series.kind === "entity_topic" && series.entity_anchor === "Sam" && /doctor|weight/.test(series.topic_anchor ?? "")));

const letter = sidecar.members.find((member) => /appreciation letter/i.test(member.text));
assert.equal(letter?.answer_time?.start, "2023-01-26");
assert.equal(letter?.answer_time?.source, "relative_evidence");
const letterWindow = sidecar.identity_windows.find((window) => window.evidence_ref === "l1:letter");
assert.deepEqual(letterWindow?.next_refs, ["l1:letter-question", "l1:letter-answer"]);
const soccer = sidecar.members.find((member) => /injured at soccer/i.test(member.text));
assert.equal(soccer?.answer_time?.start, "2023-08-12");
assert.equal(soccer?.answer_time?.original_expression, "last saturday");

const previousMonth = deriveEvidenceTemporalTime({
  evidence_ref: "l1:last-month",
  timestamp: "2026-10-27T00:00:00Z",
  text: "[6:17 pm on 19 August, 2023] Evan (user): Yep, last month I drove somewhere fun."
});
assert.equal(previousMonth?.precision, "month");
assert.equal(previousMonth?.raw, "2023-07");
assert.equal(previousMonth?.start, "2023-07-01");
assert.equal(previousMonth?.end, "2023-07-31");

const previousWeek = deriveEvidenceTemporalTime({
  evidence_ref: "l1:last-week",
  timestamp: "2026-10-27T00:00:00Z",
  text: "[1:50 pm on 13 October, 2023] Tim (user): Last week I went to a Harry Potter conference in the UK."
});
assert.equal(previousWeek?.precision, "range");
assert.equal(previousWeek?.raw, "2023-10-06 to 2023-10-12");
assert.equal(previousWeek?.start, "2023-10-06");
assert.equal(previousWeek?.end, "2023-10-12");
assert.equal(previousWeek?.original_expression, "last week");
assert.equal(previousWeek?.answerable, true);

const doctorFacts = sidecar.members.filter((member) => /doctor/i.test(member.text));
const doctorExpansion = expandEventSeries({
  query: "How many months lapsed between Sam's first and second doctor's appointment?",
  sidecars: [sidecar],
  seeds: [{ fact_id: doctorFacts[0].fact_id, score: 0.71 }]
});
assert.equal(doctorExpansion.temporal_query, true);
assert.ok(doctorExpansion.hits.some((hit) => hit.fact_id === doctorFacts[0].fact_id));
assert.ok(doctorExpansion.hits.some((hit) => hit.fact_id === doctorFacts[1].fact_id));

const canadaExpansion = expandEventSeries({
  query: "Which places in Canada was Evan visiting in July 2023?",
  sidecars: [sidecar],
  seeds: []
});
assert.equal(canadaExpansion.query_window?.month, 7);
const julyTexts = canadaExpansion.hits.filter((hit) => hit.relation === "time_window").map((hit) => hit.member.text).join("\n");
assert.match(julyTexts, /Banff/);
assert.match(julyTexts, /Rocky Mountains/);
assert.doesNotMatch(julyTexts, /Vancouver/);

const explicitRangeExpansion = expandEventSeries({
  query: "Where was John between August 11 and August 15 2023?",
  sidecars: [sidecar],
  seeds: []
});
assert.equal(explicitRangeExpansion.query_window?.start, "2023-08-11");
assert.equal(explicitRangeExpansion.query_window?.end, "2023-08-15");

const beginningMonthExpansion = expandEventSeries({
  query: "What kind of project was Jolene working on in the beginning of January 2023?",
  sidecars: [sidecar],
  seeds: []
});
assert.equal(beginningMonthExpansion.query_window?.start, "2023-01-01");
assert.equal(beginningMonthExpansion.query_window?.end, "2023-01-10");
assert.equal(beginningMonthExpansion.query_window?.month, 1);

const exactDateExpansion = expandEventSeries({
  query: "What happened on January 23, 2023?",
  sidecars: [sidecar],
  seeds: []
});
assert.equal(exactDateExpansion.query_window?.start, "2023-01-23");
assert.equal(exactDateExpansion.query_window?.end, "2023-01-23");
assert.equal(exactDateExpansion.query_window?.month, 1);

const dayMonthExpansion = expandEventSeries({
  query: "What happened on 23 January 2023?",
  sidecars: [sidecar],
  seeds: []
});
assert.equal(dayMonthExpansion.query_window?.start, "2023-01-23");
assert.equal(dayMonthExpansion.query_window?.end, "2023-01-23");

const isoDateExpansion = expandEventSeries({
  query: "What happened on 2023-01-23?",
  sidecars: [sidecar],
  seeds: []
});
assert.equal(isoDateExpansion.query_window?.start, "2023-01-23");
assert.equal(isoDateExpansion.query_window?.end, "2023-01-23");

assert.equal(queryNeedsEventSeries("What food does Evan like?"), false);
assert.equal(queryNeedsEventSeries("When did Evan visit Canada?"), true);
assert.equal(queryNeedsEventSeries("What happened on January 23, 2023?"), true);
assert.equal(queryNeedsEventSeries("What happened on 2023-01-23?"), true);
assert.equal(queryNeedsSeriesExpansion("When did Evan visit Canada?"), false);
assert.equal(queryNeedsSeriesExpansion("How many months lapsed between the first and second doctor appointments?"), true);
assert.equal(queryNeedsSeriesExpansion("Which places in Canada was Evan visiting in July 2023?"), true);
assert.equal(queryNeedsSeriesExpansion("What injury did Evan suffer from in August 2023?"), false);
assert.equal(queryNeedsSeriesExpansion("What project did Jolene finish on January 23, 2023?"), true);
assert.equal(queryNeedsPointTemporalEvidence("When was Evan's son injured at soccer?"), true);
assert.equal(queryNeedsPointTemporalEvidence("Which week did Tim visit the UK for the Harry Potter Conference?"), true);
assert.equal(queryNeedsPointTemporalEvidence("Which year did Evan start taking care of his health seriously?"), false);
assert.equal(queryNeedsPointTemporalEvidence("How many months lapsed between doctor appointments?"), false);
assert.equal(queryNeedsRelativeTemporalEvidence("What project did Jolene finish last week?"), true);
assert.equal(queryNeedsRelativeTemporalEvidence("What project did Jolene finish in January 2023?"), false);
assert.equal(queryNeedsRelativeTemporalEvidence("她上周完成了什么项目？"), true);
console.log("event-series-e2e: ok");
