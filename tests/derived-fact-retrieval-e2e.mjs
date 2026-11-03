import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractDistilledFactMetadata } from "../dist/fact-metadata.js";
import { recordCompletedDistillationRevision } from "../dist/distillation-jobs.js";
import { storeCaptureEvent } from "../dist/capture.js";
import {
  prewarmDerivedFactRevisionIndex,
  resetDerivedFactRetrievalCachesForTests,
  retrieveDerivedRevisionEvidence
} from "../dist/derived-fact-retrieval.js";

const root = await mkdtemp(join(tmpdir(), "memhub-derived-fact-retrieval-"));
try {
  const content = [
    "# Timeline",
    "## Yoga retreat",
    "- Atomic fact: Deborah prepared for a yoga retreat with friends and practiced Dancer Pose and Tree Pose. | Evidence: l1:yoga-retreat",
    "## Community yoga",
    "- Atomic fact: Deborah practiced Warrior II with Anna during a yoga class. | Evidence: l1:yoga-class",
    "## Food discussion",
    "- Atomic fact: Jolene discussed study stress and comfort food with Deborah. | Evidence: l1:lasagna",
    "## Appreciation letter",
    "- Atomic fact: Deborah received a letter yesterday. | Evidence: l1:letter-root"
  ].join("\n");
  const metadata = extractDistilledFactMetadata("l2", content);
  assert.ok(metadata);
  const actor = { account_id: "acct", actor_id: "test" };
  const capture = async (event_id, timestamp, user_text) => storeCaptureEvent(root, actor, {
    event_id,
    host: "test",
    conversation_id: "derived-fact-e2e",
    continuity_id: "derived-fact-e2e",
    timestamp,
    project_hint: "arena-project",
    user_text,
    assistant_text: "ack",
    capture_status: "complete"
  });
  await capture("yoga-retreat", "2023-06-26T12:00:00Z", "Deborah tried Dancer Pose and Tree Pose at the yoga retreat.");
  await capture("yoga-class", "2023-02-04T12:00:00Z", "Deborah and Anna practiced Warrior II during class.");
  await capture("lasagna", "2023-03-02T12:00:00Z", "Jolene: One of my favorite dishes is lasagna! Comfort food can be a great pick-me-up.");
  await capture("unlinked-noise", "2023-03-03T12:00:00Z", "An unrelated conversation about a bicycle repair shop.");
  await capture("letter-root", "2023-01-27T09:49:00Z", "[9:49 am on 27 January, 2023] Deborah: Look what letter I received yesterday!");
  await capture("letter-question", "2023-01-27T09:49:01Z", "[9:49 am on 27 January, 2023] Jolene: What touching words! Who is this letter from?");
  await capture("letter-answer", "2023-01-27T09:49:02Z", "[9:49 am on 27 January, 2023] Deborah: The group members sent this to me! They thanked me for the positive influence I had on them.");
  await capture("electrical-target", "2023-01-23T16:06:00Z", "Jolene finished an electrical engineering project last week.");
  const job = await recordCompletedDistillationRevision({
    stateRoot: root,
    accountId: "acct",
    target: "l2",
    projectId: "arena-project",
    resultId: "arena-l2",
    content,
    committedAt: "2026-10-30T00:00:00Z",
    factMetadata: metadata,
    evidence: [{
      ref: "l1:yoga-retreat", kind: "turn", layer: "L1", project_id: "arena-project",
      timestamp: "2023-06-26T12:00:00Z", user_text: "Deborah tried Dancer Pose and Tree Pose at the yoga retreat."
    }, {
      ref: "l1:yoga-class", kind: "turn", layer: "L1", project_id: "arena-project",
      timestamp: "2023-02-04T12:00:00Z", user_text: "Deborah and Anna practiced Warrior II during class."
    }, {
      ref: "l1:lasagna", kind: "turn", layer: "L1", project_id: "arena-project",
      timestamp: "2023-03-02T12:00:00Z", user_text: "Jolene: One of my favorite dishes is lasagna! Comfort food can be a great pick-me-up."
    }, {
      ref: "l1:unlinked-noise", kind: "turn", layer: "L1", project_id: "arena-project",
      timestamp: "2023-03-03T12:00:00Z", user_text: "An unrelated conversation about a bicycle repair shop."
    }, {
      ref: "l1:letter-root", kind: "turn", layer: "L1", project_id: "arena-project",
      timestamp: "2023-01-27T09:49:00Z", user_text: "[9:49 am on 27 January, 2023] Deborah: Look what letter I received yesterday!"
    }, {
      ref: "l1:letter-question", kind: "turn", layer: "L1", project_id: "arena-project",
      timestamp: "2023-01-27T09:49:01Z", user_text: "[9:49 am on 27 January, 2023] Jolene: What touching words! Who is this letter from?"
    }, {
      ref: "l1:letter-answer", kind: "turn", layer: "L1", project_id: "arena-project",
      timestamp: "2023-01-27T09:49:02Z", user_text: "[9:49 am on 27 January, 2023] Deborah: The group members sent this to me! They thanked me for the positive influence I had on them."
    }, {
      ref: "l1:doctor-first", kind: "turn", layer: "L1", project_id: "arena-project",
      timestamp: "2026-10-27T00:00:00Z", user_text: "[7:11 pm on 24 May, 2023] Sam (user): I had a check-up with my doctor a few days ago and the weight wasn't great."
    }, {
      ref: "l1:doctor-second", kind: "turn", layer: "L1", project_id: "arena-project",
      timestamp: "2026-10-27T00:00:01Z", user_text: "[4:20 pm on 15 August, 2023] Sam (user): Had a tough week and a doc's appointment, so it was a wake-up call to take better care of myself."
    }, {
      ref: "l1:doctor-later", kind: "turn", layer: "L1", project_id: "arena-project",
      timestamp: "2026-10-27T00:00:02Z", user_text: "[3:09 pm on 8 October, 2023] Sam (user): I went for a check-up Monday and my doc said my weight is a serious health risk."
    }, {
      ref: "l1:canada-root-1", kind: "turn", layer: "L1", project_id: "arena-project",
      timestamp: "2026-10-27T00:00:03Z", user_text: "[6:17 pm on 19 August, 2023] Evan (user): Yep, last month I drove somewhere fun. The views were amazing!"
    }, {
      ref: "l1:canada-q-1", kind: "turn", layer: "L1", project_id: "arena-project",
      timestamp: "2026-10-27T00:00:04Z", user_text: "[6:17 pm on 19 August, 2023] Sam (assistant): Did you take advantage of the skiing opportunities in Banff?"
    }, {
      ref: "l1:canada-a-1", kind: "turn", layer: "L1", project_id: "arena-project",
      timestamp: "2026-10-27T00:00:05Z", user_text: "[6:17 pm on 19 August, 2023] Evan (user): Yeah, it was great for skiing and I can't wait to go back."
    }, {
      ref: "l1:canada-root-2", kind: "turn", layer: "L1", project_id: "arena-project",
      timestamp: "2026-10-27T00:00:06Z", user_text: "[10:18 am on 27 August, 2023] Evan (user): I took a road trip last month and the scenery was stunning."
    }, {
      ref: "l1:canada-q-2", kind: "turn", layer: "L1", project_id: "arena-project",
      timestamp: "2026-10-27T00:00:07Z", user_text: "[10:18 am on 27 August, 2023] Sam (assistant): Where did you go?"
    }, {
      ref: "l1:canada-a-2", kind: "turn", layer: "L1", project_id: "arena-project",
      timestamp: "2026-10-27T00:00:08Z", user_text: "[10:18 am on 27 August, 2023] Evan (user): I went up to the Rocky Mountains. The views were stunning."
    }, {
      ref: "l1:john-trip-root", kind: "turn", layer: "L1", project_id: "arena-project",
      timestamp: "2026-10-27T00:00:09Z", user_text: "[1:08 pm on 11 August, 2023] John (user): Hey Tim, sorry I missed you. Been a crazy few days. Took a trip to a new place - it's been amazing. Love the energy there."
    }, {
      ref: "l1:john-trip-question", kind: "turn", layer: "L1", project_id: "arena-project",
      timestamp: "2026-10-27T00:00:10Z", user_text: "[1:08 pm on 11 August, 2023] Tim (assistant): Where did you go?"
    }, {
      ref: "l1:john-trip-chicago", kind: "turn", layer: "L1", project_id: "arena-project",
      timestamp: "2026-10-27T00:00:11Z", user_text: "[1:08 pm on 11 August, 2023] John (user): I was in Chicago, it was awesome! It had so much energy and the locals were really friendly."
    }]
  });
  const revision = {
    evidence_ref: `l2:arena-l2:${job.job_id}`,
    layer: "L2",
    memory_id: "arena-l2",
    revision_id: job.job_id,
    project_id: "arena-project",
    title: "Timeline",
    content,
    committed_at: job.result_committed_at,
    source_evidence_refs: job.evidence_refs,
    fact_metadata: metadata,
    estimated_tokens: 100
  };

  const yoga = await retrieveDerivedRevisionEvidence({
    stateRoot: root, accountId: "acct", query: "What new yoga poses did Deborah try?",
    revisions: [revision], mode: "lexical", maxFacts: 6
  });
  assert.equal(yoga.version, "derived-revision-retrieval-v1");
  assert.equal(yoga.mode, "lexical");
  assert.ok(yoga.facts.some((fact) => /Dancer Pose/.test(fact.text)));
  assert.ok(yoga.facts.some((fact) => /Warrior II/.test(fact.text)));
  assert.ok(yoga.facts.every((fact) => fact.memory_id === "arena-l2" && fact.parent_id));

  const prewarmed = await prewarmDerivedFactRevisionIndex({
    stateRoot: root,
    accountId: "acct",
    revisionId: job.job_id,
    memoryId: "arena-l2",
    layer: "L2",
    factMetadata: metadata,
    sourceEvidence: job.evidence
  });
  assert.equal(prewarmed.facts, metadata.facts.length);
  assert.ok((await stat(prewarmed.path)).size > 0);
  const persisted = JSON.parse(await readFile(prewarmed.path, "utf8"));
  assert.ok(persisted.source_evidence.some((item) => item.evidence_ref === "l1:lasagna"));
  resetDerivedFactRetrievalCachesForTests();
  const semantic = await retrieveDerivedRevisionEvidence({
    stateRoot: root, accountId: "acct", query: "What new yoga poses did Deborah try?",
    revisions: [revision], mode: "semantic", maxFacts: 6
  });
  assert.equal(semantic.diagnostics.revision_cache_hits, 1);
  assert.equal(semantic.diagnostics.revision_cache_misses, 0);
  assert.ok(semantic.facts.some((fact) => /Dancer Pose/.test(fact.text)));

  // Metadata-only changes must invalidate the persisted revision index even
  // when fact ids/text remain identical. Otherwise stale evidence/time can
  // survive parser or hydration repairs across process restarts.
  const changedEvidenceMetadata = {
    ...metadata,
    facts: metadata.facts.map((fact, index) => index === 0
      ? { ...fact, evidence_refs: [...fact.evidence_refs, "l1:yoga-class"] }
      : fact)
  };
  resetDerivedFactRetrievalCachesForTests();
  const evidenceChanged = await prewarmDerivedFactRevisionIndex({
    stateRoot: root,
    accountId: "acct",
    revisionId: job.job_id,
    memoryId: "arena-l2",
    layer: "L2",
    factMetadata: changedEvidenceMetadata,
    sourceEvidence: job.evidence
  });
  assert.equal(evidenceChanged.cache_hit, false);
  const rebuiltEvidenceIndex = JSON.parse(await readFile(evidenceChanged.path, "utf8"));
  assert.deepEqual(rebuiltEvidenceIndex.fact_metadata.facts[0].evidence_refs,
    changedEvidenceMetadata.facts[0].evidence_refs);

  const changedTimeMetadata = {
    ...changedEvidenceMetadata,
    facts: changedEvidenceMetadata.facts.map((fact, index) => index === 0
      ? { ...fact, canonical_time: { raw: "July 2023", precision: "month", start: "2023-07", end: "2023-07" } }
      : fact)
  };
  resetDerivedFactRetrievalCachesForTests();
  const timeChanged = await prewarmDerivedFactRevisionIndex({
    stateRoot: root,
    accountId: "acct",
    revisionId: job.job_id,
    memoryId: "arena-l2",
    layer: "L2",
    factMetadata: changedTimeMetadata,
    sourceEvidence: job.evidence
  });
  assert.equal(timeChanged.cache_hit, false);
  const rebuiltTimeIndex = JSON.parse(await readFile(timeChanged.path, "utf8"));
  assert.deepEqual(rebuiltTimeIndex.fact_metadata.facts[0].canonical_time,
    changedTimeMetadata.facts[0].canonical_time);

  resetDerivedFactRetrievalCachesForTests();
  const restoredOriginal = await retrieveDerivedRevisionEvidence({
    stateRoot: root,
    accountId: "acct",
    query: "What new yoga poses did Deborah try?",
    revisions: [revision],
    mode: "semantic",
    maxFacts: 6,
    includeRawEvidence: true,
    maxRawEvidence: 4
  });
  assert.equal(restoredOriginal.diagnostics.revision_cache_hits, 0);
  assert.equal(restoredOriginal.diagnostics.revision_cache_misses, 1);
  assert.ok(restoredOriginal.raw_evidence.some((item) => item.evidence_ref === "l1:yoga-retreat"));
  const restoredIndex = JSON.parse(await readFile(timeChanged.path, "utf8"));
  assert.deepEqual(restoredIndex.fact_metadata.facts[0].evidence_refs, metadata.facts[0].evidence_refs);
  assert.ok(restoredIndex.source_evidence.some((item) => item.evidence_ref === "l1:yoga-retreat"));

  const crowdedMetadata = {
    version: "memhub-fact-metadata-v1",
    layer: "L2",
    facts: [{
      fact_id: "crowded-summary",
      ordinal: 1,
      text: "Jolene was working on a project and kept working on the project.",
      parent_id: "crowded-parent",
      parent_heading: "Project work",
      evidence_refs: [
        "l1:yoga-retreat", "l1:yoga-class", "l1:lasagna",
        "l1:letter-root", "l1:letter-question", "l1:letter-answer"
      ]
    }, {
      fact_id: "crowded-exact",
      ordinal: 2,
      text: "The project Jolene completed was an electrical engineering project.",
      parent_id: "crowded-parent",
      parent_heading: "Project work",
      evidence_refs: ["l1:electrical-target"]
    }],
    parents: [{
      parent_id: "crowded-parent",
      heading: "Project work",
      evidence_refs: [],
      fact_ids: ["crowded-summary", "crowded-exact"]
    }]
  };
  resetDerivedFactRetrievalCachesForTests();
  const crowdedEvidence = await retrieveDerivedRevisionEvidence({
    stateRoot: root,
    accountId: "acct",
    query: "What kind of project was Jolene working on?",
    revisions: [{
      ...revision,
      evidence_ref: "l2:crowded-memory:crowded-revision",
      memory_id: "crowded-memory",
      revision_id: "crowded-revision",
      fact_metadata: crowdedMetadata
    }],
    mode: "lexical",
    maxFacts: 2,
    includeRawEvidence: true,
    maxRawEvidence: 1
  });
  assert.equal(crowdedEvidence.raw_evidence[0]?.evidence_ref, "l1:electrical-target");
  assert.match(crowdedEvidence.raw_evidence[0]?.text ?? "", /electrical engineering project/i);

  // One source row can carry two different temporal meanings: the message was
  // observed on Jan 23 while the event described by "last week" belongs to
  // Jan 16-22. An exact observation-date query must keep the raw source while
  // preserving, not overwriting, the normalized event time. Event-series
  // expansion must not crowd the exact source out of the bounded raw lane.
  const dualTimeMetadata = {
    version: "memhub-fact-metadata-v1",
    layer: "L2",
    facts: [{
      fact_id: "dual-electrical",
      ordinal: 1,
      text: "Jolene completed an electrical engineering project during the prior week.",
      parent_id: "dual-jan23",
      parent_heading: "Jolene project update",
      canonical_time: { raw: "2023-01-23", precision: "date", start: "2023-01-23" },
      evidence_refs: ["l1:electrical-target"]
    }, {
      fact_id: "dual-letter",
      ordinal: 2,
      text: "Jolene discussed an appreciation letter with Deborah.",
      parent_id: "dual-jan27",
      parent_heading: "Jolene community update",
      canonical_time: { raw: "2023-01-27", precision: "date", start: "2023-01-27" },
      evidence_refs: ["l1:letter-question"]
    }],
    parents: [{
      parent_id: "dual-jan23",
      heading: "Jolene project update",
      canonical_time: { raw: "2023-01-23", precision: "date", start: "2023-01-23" },
      evidence_refs: [],
      fact_ids: ["dual-electrical"]
    }, {
      parent_id: "dual-jan27",
      heading: "Jolene community update",
      canonical_time: { raw: "2023-01-27", precision: "date", start: "2023-01-27" },
      evidence_refs: [],
      fact_ids: ["dual-letter"]
    }]
  };
  const dualSourceEvidence = [{
    ref: "l1:electrical-target", kind: "turn", layer: "L1", project_id: "arena-project",
    timestamp: "2023-01-23T16:06:00Z",
    user_text: "[4:06 pm on 23 January, 2023] Jolene (user): I finished an electrical engineering project last week - took a lot of work, but it's done now."
  }, {
    ref: "l1:letter-question", kind: "turn", layer: "L1", project_id: "arena-project",
    timestamp: "2023-01-27T09:49:01Z",
    user_text: "[9:49 am on 27 January, 2023] Jolene (user): What touching words! Who is this letter from?"
  }];
  resetDerivedFactRetrievalCachesForTests();
  await prewarmDerivedFactRevisionIndex({
    stateRoot: root,
    accountId: "acct",
    revisionId: "dual-time-revision",
    memoryId: "dual-time-memory",
    layer: "L2",
    factMetadata: dualTimeMetadata,
    sourceEvidence: dualSourceEvidence
  });
  resetDerivedFactRetrievalCachesForTests();
  const dualTime = await retrieveDerivedRevisionEvidence({
    stateRoot: root,
    accountId: "acct",
    query: "What kind of project did Jolene say on January 23, 2023 that she had finished the previous week?",
    revisions: [{
      ...revision,
      evidence_ref: "l2:dual-time-memory:dual-time-revision",
      memory_id: "dual-time-memory",
      revision_id: "dual-time-revision",
      source_evidence_refs: dualSourceEvidence.map((item) => item.ref),
      fact_metadata: dualTimeMetadata
    }],
    mode: "semantic",
    maxFacts: 4,
    includeRawEvidence: true,
    maxRawEvidence: 4,
    annotateTemporalEvidence: true,
    expandEventSeries: true,
    maxSeriesFacts: 4
  });
  const dualTimeExact = dualTime.raw_evidence.find((item) => item.evidence_ref === "l1:electrical-target");
  assert.ok(dualTimeExact);
  assert.match(dualTimeExact.text, /electrical engineering project/i);
  assert.match(dualTimeExact.text, /2023-01-16 to 2023-01-22/);
  assert.match(dualTimeExact.text, /23 January, 2023/);

  // Query-time hydration may expose a verified subset of the immutable
  // revision metadata. The prewarmed revision index is a valid superset and
  // must not be replaced by the narrower view (which would discard cached L1
  // evidence and recreate the cold-query penalty).
  const filteredFactIds = new Set(metadata.facts.slice(0, 2).map((fact) => fact.fact_id));
  const filteredMetadata = {
    ...metadata,
    facts: metadata.facts.filter((fact) => filteredFactIds.has(fact.fact_id)),
    parents: metadata.parents
      .map((parent) => ({ ...parent, fact_ids: parent.fact_ids.filter((factId) => filteredFactIds.has(factId)) }))
      .filter((parent) => parent.fact_ids.length > 0)
  };
  resetDerivedFactRetrievalCachesForTests();
  const food = await retrieveDerivedRevisionEvidence({
    stateRoot: root, accountId: "acct", query: "What is one of Jolene's favorite dishes?",
    revisions: [{ ...revision, fact_metadata: filteredMetadata }], mode: "semantic", maxFacts: 4,
    includeRawEvidence: true, maxRawEvidence: 3
  });
  assert.equal(food.diagnostics.revision_cache_hits, 1);
  assert.equal(food.diagnostics.revision_cache_misses, 0);
  assert.ok(food.raw_evidence.length > 0);
  assert.equal(food.raw_evidence[0].evidence_ref, "l1:lasagna");
  assert.match(food.raw_evidence[0].text, /favorite dishes is lasagna/i);
  assert.ok(food.raw_evidence.every((item) => item.evidence_ref !== "l1:unlinked-noise"));
  assert.ok(food.diagnostics.direct_evidence_refs > 0);
  assert.ok(["partial", "insufficient"].includes(food.evidence_sufficiency.status));

  resetDerivedFactRetrievalCachesForTests();
  const letter = await retrieveDerivedRevisionEvidence({
    stateRoot: root,
    accountId: "acct",
    query: "When did Deborah receive an appreciation letter from her community?",
    revisions: [revision],
    mode: "semantic",
    maxFacts: 6,
    includeRawEvidence: true,
    maxRawEvidence: 4,
    annotateTemporalEvidence: true,
    bindEventIdentity: true
  });
  const identityBundle = letter.raw_evidence.find((item) => item.identity_evidence_refs?.includes("l1:letter-answer"));
  assert.ok(identityBundle);
  assert.match(identityBundle.text, /2023-01-26/);
  assert.match(identityBundle.text, /group members sent this to me/i);
  assert.match(identityBundle.text, /Event identity neighbor: l1:letter-answer/);

  resetDerivedFactRetrievalCachesForTests();
  const firstDoctor = await retrieveDerivedRevisionEvidence({
    stateRoot: root,
    accountId: "acct",
    query: "When did Sam first go to the doctor and find out he had a weight problem?",
    revisions: [revision],
    mode: "semantic",
    maxFacts: 6,
    includeRawEvidence: true,
    maxRawEvidence: 8,
    annotateTemporalEvidence: true,
    expandEventSeries: true
  });
  const firstDoctorBundle = firstDoctor.raw_evidence.find((item) => /Event family ordinal member: first/.test(item.text));
  assert.ok(firstDoctorBundle);
  assert.match(firstDoctorBundle.text, /2023-05-19 to 2023-05-22/);
  assert.match(firstDoctorBundle.text, /check-up with my doctor/i);

  resetDerivedFactRetrievalCachesForTests();
  const doctorInterval = await retrieveDerivedRevisionEvidence({
    stateRoot: root,
    accountId: "acct",
    query: "How many months lapsed between Sam's first and second doctor's appointment?",
    revisions: [revision],
    mode: "semantic",
    maxFacts: 6,
    includeRawEvidence: true,
    maxRawEvidence: 8,
    annotateTemporalEvidence: true,
    expandEventSeries: true
  });
  const intervalBundle = doctorInterval.raw_evidence.find((item) => /Event family ordered relation/.test(item.text));
  assert.ok(intervalBundle);
  assert.match(intervalBundle.text, /member1_month=2023-05/);
  assert.match(intervalBundle.text, /member2_month=2023-08/);
  assert.match(intervalBundle.text, /calendar_month_gap=3/);
  assert.match(intervalBundle.text, /doc's appointment/i);

  resetDerivedFactRetrievalCachesForTests();
  const canadaWindow = await retrieveDerivedRevisionEvidence({
    stateRoot: root,
    accountId: "acct",
    query: "Which places in Canada was Evan visiting in July 2023?",
    revisions: [revision],
    mode: "semantic",
    maxFacts: 6,
    includeRawEvidence: true,
    maxRawEvidence: 8,
    annotateTemporalEvidence: true,
    expandEventSeries: true
  });
  const canadaBundle = canadaWindow.raw_evidence.find((item) => /Event family window relation/.test(item.text));
  assert.ok(canadaBundle);
  assert.match(canadaBundle.text, /query_window=july 2023/i);
  assert.match(canadaBundle.text, /Banff/);
  assert.match(canadaBundle.text, /Rocky Mountains/);
  assert.doesNotMatch(canadaBundle.text, /Vancouver/);

  resetDerivedFactRetrievalCachesForTests();
  const chicagoRange = await retrieveDerivedRevisionEvidence({
    stateRoot: root,
    accountId: "acct",
    query: "Where was John between August 11 and August 15 2023?",
    revisions: [revision],
    mode: "semantic",
    maxFacts: 6,
    includeRawEvidence: true,
    maxRawEvidence: 8,
    annotateTemporalEvidence: true,
    expandEventSeries: true
  });
  const chicagoBundle = chicagoRange.raw_evidence.find((item) => /Event family window relation/.test(item.text));
  assert.ok(chicagoBundle);
  assert.match(chicagoBundle.text, /query_window=between august 11 and august 15 2023/i);
  assert.match(chicagoBundle.text, /location_members=Chicago/);
  assert.match(chicagoBundle.text, /Event family window observation: 2023-08-11/);
  assert.match(chicagoBundle.text, /I was in Chicago/i);

  console.log("derived-fact-retrieval-e2e: ok");
} finally {
  await rm(root, { recursive: true, force: true });
}
