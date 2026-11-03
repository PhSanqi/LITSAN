import { normalizeMaintenanceConfig } from "../dist/core/maintenance/config.js";
import { decideOffer } from "../dist/core/maintenance/offer-policy.js";
import { maintenanceGenerators, registerMaintenanceGenerator, nodeEvidenceHash } from "../dist/core/maintenance/registry.js";
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { estimateTokens, cardEstTokens } from "../dist/core/maintenance/estimate.js";
import { normalizeClientProfile } from "../dist/core/maintenance/profile.js";
import { planL2Chunks, L2_INSTRUCTIONS } from "../dist/core/maintenance/chunk.js";
import { structureFingerprint, gapCheckFingerprint } from "../dist/core/maintenance/structure-fingerprint.js";
import { selectCandidateNodes, selectCandidateEvents } from "../dist/core/maintenance/candidates.js";
import { validateCardAnswer } from "../dist/core/maintenance/validate.js";
import { mergeChunkEvents } from "../dist/core/maintenance/merge-l2.js";
import { currentTimelineBatchHash, timelineEventHash } from "../dist/core/maintenance/timeline-digest.js";
import { extractDistilledFactMetadata } from "../dist/fact-metadata.js";
import { generationKey } from "../dist/maintenance-store.js";
import { graphProjectModel } from "./fakes/project-model-fakes.mjs";
const map = graphProjectModel().architecture.map;
const card = { card_id: "c", account_id: "a", project_id: "p", kind: "l2_chunk", allowed_refs: ["l1:x"], input: { items: [] },
  status: "leased", lease: { token: "t", owner: "h", until: "2026-10-26T01:00:00Z" }, fingerprint: "fp" };
const event = { date: "2026-10-26", title_en: "Event", title_zh: "事件", body_en: "Durable facts.", body_zh: "长期事实。", evidence_refs: ["l1:x"] };
const answer = { events: [event] };
const context = { accountId: "a", now: Date.parse("2026-10-26T00:00:00Z"), leaseToken: "t", harness: "h", fingerprint: "fp" };
test("maintenance token estimate and profiles clamp untrusted inputs", () => {
  assert.equal(estimateTokens("abcd"), 1); assert.equal(estimateTokens("中文"), 2); assert.equal(estimateTokens("abcd中文"), 3);
  assert.equal(cardEstTokens({ kind: "arch_link", instructions: "abcd", input: {} }), 702);
  for (const raw of [undefined, null, [], "background", { execution: "invalid" }]) assert.equal(normalizeClientProfile(raw).execution, "inline");
  for (const [execution, fallback, cap] of [["inline", 1500, 2000], ["delegate", 6000, 8000], ["background", 8000, 8000]]) {
    assert.equal(normalizeClientProfile({ execution }).max_card_tokens, fallback);
    assert.equal(normalizeClientProfile({ execution, max_card_tokens: 1e9, cards_per_turn: 20 }).max_card_tokens, cap);
    assert.equal(normalizeClientProfile({ execution, max_card_tokens: NaN }).max_card_tokens, fallback);
  }
  assert.equal(normalizeClientProfile({ max_card_tokens: -1 }).max_card_tokens, 500);
  assert.equal(normalizeClientProfile({ model: "x".repeat(81) }).model, undefined);
});
test("maintenance chunks preserve order and never split evidence, including oversized items", () => {
  const items = [0, 1, 2].map(i => ({ ref: `l1:${i}`, content: "x".repeat(3600), timestamp: "2026-10-26", kind: "turn" }));
  const combined = planL2Chunks(items);
  assert.equal(combined.chunks.length, 1, "the 6k budget combines the former 3k chunks");
  assert.deepEqual(combined.chunks[0].items, items);
  assert.ok(cardEstTokens({ kind: "l2_chunk", instructions: L2_INSTRUCTIONS, input: { items } }) <= 6000);
  const large = items.map(item => ({ ...item, content: "x".repeat(9000) }));
  const plan = planL2Chunks(large);
  assert.equal(plan.chunks.length, 3); assert.deepEqual(plan.chunks.flatMap(c => c.refs), items.map(i => i.ref));
  assert.deepEqual(plan.chunks.flatMap(c => c.items), large);
  assert.deepEqual(plan.chunks.map(c => c.index), [0, 1, 2]);
  assert.equal(planL2Chunks([{ ...items[0], content: "x" }]).chunks.length, 1);
  assert.equal(planL2Chunks([{ ...items[0], content: "x".repeat(40000) }]).background_only, true);
  assert.equal(planL2Chunks([{ ...items[0], content: "x".repeat(10000) }]).chunks.length, 1);
});
test("maintenance structure fence ignores provenance and links, changes on structural edits", () => {
  const changed = structuredClone(map), fp = structureFingerprint(map);
  changed.timeline_links = []; changed.generated_at = "later"; changed.source_evidence_refs = ["other"];
  changed.nodes[0].confidence = 0; changed.nodes[0].evidence_refs = []; changed.edges[0].confidence = 0;
  changed.nodes.reverse(); changed.edges.reverse();
  assert.equal(structureFingerprint(changed), fp);
  changed.nodes[0].label += "changed"; assert.notEqual(structureFingerprint(changed), fp);
  const parent = structuredClone(map); parent.nodes.at(-1).parent_id = "alpha";
  assert.notEqual(structureFingerprint(parent), fp); assert.equal(structureFingerprint(null), structureFingerprint(null));
});
test("maintenance candidates deterministic, include ancestors, fallback and CJK bigrams", () => {
  const selected = selectCandidateNodes(map, "decode");
  assert.ok(selected.some(n => n.id === "decode")); assert.ok(selected.some(n => n.id === "alpha"));
  assert.deepEqual(selectCandidateNodes({ ...map, nodes: [...map.nodes].reverse() }, "decode"), selected);
  assert.deepEqual(selectCandidateNodes(map, "zzzz").map(n => n.kind), ["project", "domain", "domain"]);
  assert.equal(selectCandidateNodes(map, "decode", 2).length, 2);
  const chinese = structuredClone(map); chinese.nodes.at(-1).summary = "中文检索候选";
  assert.ok(selectCandidateNodes(chinese, "检索").some(n => n.id === chinese.nodes.at(-1).id));
});
test("maintenance answer validators cover every rejection code and strict schemas", () => {
  const reject = (code, a = answer, c = card, ctx = context) => assert.equal(validateCardAnswer(c, a, ctx).code, code);
  assert.equal(validateCardAnswer(card, answer, context).ok, true);
  reject("wrong_account", answer, card, { ...context, accountId: "other" });
  reject("wrong_project", answer, card, { ...context, workspaceProject: "other" });
  reject("lease_expired", answer, card, { ...context, now: Date.parse(card.lease.until) });
  reject("lease_token_stale", answer, card, { ...context, leaseToken: "old" });
  reject("card_not_leased", answer, { ...card, status: "pending" });
  reject("stale_fingerprint", answer, card, { ...context, fingerprint: "old" });
  reject("contaminated", answer, card, { ...context, contaminated: true });
  reject("oversize", { events: [], skip_reason: "x".repeat(8000) });
  reject("unsupported_kind", answer, { ...card, kind: "arch_review" });
  reject("schema_invalid", answer, { ...card, kind: "gap_check" });
  reject("schema_invalid", { ...answer, extra: true }); reject("schema_invalid", { events: [] });
  reject("schema_invalid", { events: [{ ...event, date: "2026-02-30" }] });
  reject("schema_invalid", { events: [{ ...event, body_en: "x".repeat(1201) }] });
  reject("bilingual_missing", { events: [{ ...event, body_zh: "" }] });
  reject("bilingual_missing", { events: [{ ...event, title_zh: "Event" }] });
  reject("bilingual_missing", { events: [{ ...event, body_zh: "English only" }] });
  reject("bilingual_missing", { events: [{ ...event, body_en: "只有中文" }] });
  reject("ref_not_allowed", { events: [{ ...event, evidence_refs: ["l1:alien"] }] });
  reject("ref_not_allowed", { events: [{ ...event, body_en: "Atomic fact: Claim. | Evidence: l1:alien" }] });
  reject("ref_not_allowed", { events: [{ ...event, body_en: "Atomic fact: Claim. [l1:alien]" }] });
  assert.equal(validateCardAnswer(card, { events: [{ ...event, body_en: "Atomic fact: Claim. | Evidence: l1:x" }] }, context).ok, true);
  assert.equal(validateCardAnswer(card, { events: [], skip_reason: "No durable events" }, context).ok, true);
  const arch = { ...card, kind: "arch_link", input: { candidates: [{ id: "n", kind: "domain" }, { id: "p", kind: "project" }] } };
  const link = { architecture_refs: ["n"], architecture_level: "domain", change_kind: "refine", confidence: 0.5 };
  assert.equal(validateCardAnswer(arch, { links: [link] }, context).ok, true);
  reject("node_not_allowed", { links: [{ ...link, architecture_refs: ["alien"] }] }, arch);
  reject("schema_invalid", { links: [{ ...link, architecture_refs: ["n", "p"] }] }, arch);
  reject("schema_invalid", { links: [{ ...link, confidence: 2 }] }, arch);
  reject("schema_invalid", { no_fit: true, reason: "why", extra: true }, arch);
  assert.equal(validateCardAnswer(arch, { no_fit: true, reason: "no suitable candidate" }, context).ok, true);
});
test("maintenance merge renders bilingual events, sorts and deduplicates against base and batch", () => {
  const base = "# Timeline\n\n## 2026-10-25：Prior   TITLE / 旧标题\n\nPrior history.";
  const wrap = (e, chunkIndex = 0, eventIndex = 0) => ({ event: e, chunkIndex, eventIndex, cardId: "c" });
  const result = mergeChunkEvents({ baseContent: base, canonicalTitle: "Timeline", events: [wrap(event, 1),
    wrap({ ...event, title_en: "Later" }, 2), wrap({ ...event, date: "2026-10-25", title_en: " prior title " }), wrap({ ...event }, 2)] });
  assert.equal(result.appended, 2); assert.equal(result.dropped_duplicates, 2);
  assert.ok(result.content.startsWith(base + "\n\n")); assert.ok(result.content.indexOf("Event / 事件") < result.content.indexOf("Later / 事件"));
  assert.match(result.content, /Atomic fact: Durable facts\. \| Evidence: l1:x\n\n长期事实。\n\nEvidence: l1:x\n/);
  assert.equal(mergeChunkEvents({ baseContent: null, canonicalTitle: "Timeline", events: [wrap(event)] }).content,
    "# Timeline\n\n## 2026-10-26: Event / 事件\n\nAtomic fact: Durable facts. | Evidence: l1:x\n\n长期事实。\n\nEvidence: l1:x\n");
});

test("micro event prose and continuations retain structured facts with their own evidence", () => {
  const first = { ...event, body_en: "The release was deployed.", evidence_refs: ["l1:first"] };
  const second = { ...event, title_en: "Follow-up", body_en: "The service passed health checks.", evidence_refs: ["l1:second"],
    continues: "2026-10-26 event" };
  const explicit = { ...event, title_en: "Other", body_en: "Atomic fact: One change.\nAtomic fact: Another change.", evidence_refs: ["l1:third"] };
  const wrap = (value, chunkIndex) => ({ event: value, chunkIndex, eventIndex: 0, cardId: String(chunkIndex) });
  const content = mergeChunkEvents({ baseContent: null, canonicalTitle: "Timeline", events: [wrap(first, 0), wrap(second, 1), wrap(explicit, 2)] }).content;
  const facts = extractDistilledFactMetadata("l2", content)?.facts ?? [];
  assert.deepEqual(facts.map(f => [f.text, f.evidence_refs]), [
    ["The release was deployed.", ["l1:first"]],
    ["The service passed health checks.", ["l1:second"]],
    ["One change.", ["l1:third"]],
    ["Another change.", ["l1:third"]]
  ]);
});

test("micro cards reject standalone evidence lines outside the event refs", () => {
  const injected = { events: [{ ...event, body_en: "Claim.\nEvidence: l1:alien" }] };
  assert.equal(validateCardAnswer(card, injected, context).code, "ref_not_allowed");
});

test("maintenance config defaults, invalid values, clamps and project bounds", () => {
  const defaults = normalizeMaintenanceConfig();
  assert.deepEqual(defaults, { conversation_maintenance: "off", daily_card_cap: 20, daily_est_token_cap: 60000, inline_every_n_turns: 5,
    delegate_min_interval_s: 60, heavy_turn_chars: 12000, cross_project: false, opted_out_projects: [], offer_style: "delegate_request" });
  for (const offer_style of ["optional", "delegate_request"]) assert.equal(normalizeMaintenanceConfig({ offer_style }).offer_style, offer_style);
  for (const offer_style of [null, "invalid", 1]) assert.equal(normalizeMaintenanceConfig({ offer_style }).offer_style, "delegate_request");
  for (const raw of [null, false, "quiet", [], { conversation_maintenance: "bad", daily_card_cap: "30", daily_est_token_cap: NaN, inline_every_n_turns: Infinity, cross_project: "true" }]) {
    assert.deepEqual(normalizeMaintenanceConfig(raw), defaults);
  }
  for (const [key, min, max] of [["daily_card_cap", 1, 500], ["daily_est_token_cap", 1000, 2000000], ["inline_every_n_turns", 1, 50],
    ["delegate_min_interval_s", 0, 3600], ["heavy_turn_chars", 1000, 200000]]) {
    assert.equal(normalizeMaintenanceConfig({ [key]: -100 })[key], min);
    assert.equal(normalizeMaintenanceConfig({ [key]: 1e10 })[key], max);
    assert.equal(normalizeMaintenanceConfig({ [key]: min + 0.8 })[key], min);
    assert.equal(normalizeMaintenanceConfig({ [key]: null })[key], defaults[key]);
  }
  assert.deepEqual(normalizeMaintenanceConfig({ opted_out_projects: [null, 42, "alpha", "alpha", "", "bad slug", "../bad", "beta-test_2"] }).opted_out_projects, ["alpha", "beta-test_2"]);
  assert.equal(normalizeMaintenanceConfig({ opted_out_projects: Array.from({ length: 250 }, (_, i) => `p${i}`) }).opted_out_projects.length, 200);
});
test("maintenance offer policy full setting/profile/eligibility/cap/throttle matrix", () => {
  const now = Date.parse("2026-10-26T12:00:00Z");
  for (const mode of ["off", "quiet", "visible"]) for (const execution of [undefined, "inline", "delegate", "background"])
    for (const ingested of [false, true]) for (const project of [false, true]) for (const optedOut of [false, true])
      for (const heavy of [false, true]) for (const cap of ["none", "cards", "tokens"]) for (const turns of [3, 4]) for (const elapsed of [0, 59999, 60000]) {
        const config = normalizeMaintenanceConfig({ conversation_maintenance: mode, opted_out_projects: optedOut ? ["alpha"] : [] });
        const turn = { ingested, projectId: project ? "alpha" : null, assistantChars: heavy ? 12000 : 11000, toolSummaryChars: 1000, continuityId: "c" };
        const state = { day: "2026-10-26", cards_offered: cap === "cards" ? 20 : 0, est_tokens_offered: cap === "tokens" ? 60000 : 0,
          by_continuity: { c: { committed_turns_since_offer: turns, last_offer_at: new Date(now - elapsed).toISOString() } } };
        const reason = mode === "off" ? "setting_off" : !ingested ? "not_ingested" : !project ? "no_project" : optedOut ? "opted_out" : heavy ? "heavy_turn" :
          execution === "background" ? "background_profile" : cap !== "none" ? "daily_cap" : execution === "delegate" ? (elapsed < 60000 ? "throttled" : null) : turns < 4 ? "throttled" : null;
        const actual = decideOffer({ config, profile: execution ? { execution } : undefined, turn, state, now });
        assert.deepEqual(actual, reason ? { offer: false, reason } : { offer: true, maxCardTokens: execution === "delegate" ? 6000 : 1500, projectScope: "current" },
          JSON.stringify({ mode, execution, ingested, project, optedOut, heavy, cap, turns, elapsed }));
      }
  const config = normalizeMaintenanceConfig({ conversation_maintenance: "quiet", cross_project: true, delegate_min_interval_s: 0, inline_every_n_turns: 1 });
  const turn = { ingested: true, projectId: "alpha", assistantChars: 12000, toolSummaryChars: 0, continuityId: "new" };
  const state = { day: "2026-10-26", cards_offered: 0, est_tokens_offered: 59900, by_continuity: {} };
  assert.deepEqual(decideOffer({ config, turn, state, now }), { offer: true, maxCardTokens: 100, projectScope: "any" });
  state.day = "2026-10-25"; state.cards_offered = 500;
  assert.equal(decideOffer({ config, profile: { execution: "delegate" }, turn, state, now }).maxCardTokens, 6000);
});
test("maintenance registry preserves drafts, pure validation, apply ports and evidence hashing", async () => {
  assert.deepEqual([...maintenanceGenerators.keys()], ["l2_chunk", "arch_link", "gap_check", "timeline_digest"]);
  const l2 = maintenanceGenerators.get("l2_chunk"), arch = maintenanceGenerators.get("arch_link");
  const ctx = { accountId: "a", projectId: "p", map: null, jobs: [{ job_id: "j", target: "l2", project_id: "p", status: "pending", evidence_hash: "h",
    evidence: [{ ref: "l1:x", kind: "turn", user_text: "A fact" }] }], events: [] };
  const before = JSON.stringify(ctx), drafts = l2.ensure(ctx, 0);
  assert.equal(drafts.length, 1); assert.equal(drafts[0].key, "l2:j:0"); assert.equal(JSON.stringify(ctx), before);
  assert.equal(arch.ensure(ctx, 0).length, 0);
  let called = 0;
  assert.deepEqual(await l2.apply(card, answer, { submitL2Chunk: async (c, a) => { assert.equal(c, card); assert.equal(a, answer); called++; return { ok: true }; } }), { ok: true });
  assert.equal(called, 1);
  assert.deepEqual(await arch.apply({ ...card, kind: "arch_link" }, { no_fit: true, reason: "No match" }, {}), { ok: true });
  assert.equal(nodeEvidenceHash({ evidence_refs: ["b", "a", "a"] }), nodeEvidenceHash({ evidence_refs: ["a", "b"] }));
  assert.notEqual(nodeEvidenceHash({ evidence_refs: ["a"] }), nodeEvidenceHash({ evidence_refs: ["b"] }));
});

test("maintenance candidate events rank shared Latin/CJK terms, dates and ids deterministically", () => {
  const events = [
    { id: "z", date: "2026-10-26", title: "Capture", summary: "facts" },
    { id: "b", date: "2026-10-25", title: "Capture", summary: "中文检索" },
    { id: "a", date: "2026-10-25", title: "Capture", summary: "中文检索" },
    { id: "c", date: "2026-10-24", title: "Capture", summary: "中文检索" },
    { id: "none", date: "2026-10-26", title: "Other", summary: "facts" }
  ];
  const before = structuredClone(events), selected = selectCandidateEvents(events, "CAPTURE 检索");
  assert.deepEqual(selected.map(e => e.id), ["a", "b", "c", "z"]);
  assert.deepEqual(selectCandidateEvents([...events].reverse(), "CAPTURE 检索"), selected);
  assert.deepEqual(events, before); assert.equal(selectCandidateEvents(events, "Capture", 2).length, 2);
  assert.deepEqual(selectCandidateEvents(events, "zzz"), []); assert.deepEqual(selectCandidateEvents(events, "Capture", 0), []);
  assert.equal(selectCandidateEvents(Array.from({ length: 8 }, (_, i) => ({ ...events[0], id: String(i) })), "capture").length, 6);
});

test("maintenance gap schema validates all fields and applicable shared rejection codes", () => {
  const gap = { ...card, kind: "gap_check" };
  const valid = { verdict: "supported", evidence_refs: ["l1:x"], confidence: 0.5, note: "" };
  const check = (a, ctx = context, c = gap) => validateCardAnswer(c, a, ctx);
  assert.equal(check(valid).ok, true);
  for (const verdict of ["still_gap", "possibly_obsolete"]) assert.equal(check({ ...valid, verdict, evidence_refs: [], confidence: 0, note: "x".repeat(300) }).ok, true);
  assert.equal(check({ ...valid, confidence: 1 }).ok, true);
  for (const invalid of [null, [], {}, { ...valid, extra: true }, { ...valid, verdict: "unknown" },
    { ...valid, evidence_refs: [] }, { ...valid, evidence_refs: [42] }, { ...valid, evidence_refs: [""] },
    { ...valid, evidence_refs: "l1:x" }, { ...valid, confidence: -0.1 }, { ...valid, confidence: 1.1 },
    { ...valid, confidence: NaN }, { ...valid, confidence: Infinity }, { ...valid, note: "x".repeat(301) }, { ...valid, note: null }])
    assert.equal(check(invalid).code, "schema_invalid", JSON.stringify(invalid));
  for (const key of Object.keys(valid)) { const invalid = { ...valid }; delete invalid[key]; assert.equal(check(invalid).code, "schema_invalid", key); }
  assert.equal(check({ ...valid, evidence_refs: ["alien"] }).code, "ref_not_allowed");
  for (const [code, ctx] of [["wrong_account", { accountId: "other" }], ["wrong_project", { project: "other" }],
    ["lease_expired", { now: Date.parse(card.lease.until) }], ["lease_token_stale", { leaseToken: "old" }],
    ["stale_fingerprint", { fingerprint: "old" }], ["contaminated", { contaminated: true }]])
    assert.equal(check(valid, { ...context, ...ctx }).code, code);
  assert.equal(check(valid, context, { ...gap, status: "pending" }).code, "card_not_leased");
  assert.equal(check({ ...valid, note: "x".repeat(8000) }).code, "oversize");
});

test("maintenance gap generation filters kinds and missing/unmatched nodes, bounds excerpts and fences target evidence", () => {
  const generator = maintenanceGenerators.get("gap_check"), node = map.nodes[1];
  const gap = kind => ({ id: kind + ":" + node.id, kind, ref: node.id, reason_en: "Check evidence" });
  const ctx = { accountId: "a", projectId: "p", map, jobs: [], events: [],
    gaps: [gap("node_without_evidence"), gap("low_confidence_node"), gap("empty_branch"), gap("unmapped_change"),
      gap("stale_map"), gap("dangling_relation"), gap("open_todo"), { ...gap("empty_branch"), ref: "missing" }] };
  assert.equal(generator.ensure({ ...ctx, map: null }, 0).length, 0);
  assert.equal(generator.ensure(ctx, 0).length, 1);
  const events = Array.from({ length: 8 }, (_, i) => ({ id: String(i), date: "2026-10-26", date_label: "Oct 26", link_date: "Oct 26", title: node.label,
    summary: "x".repeat(800), latest_revision_ref: "l2:latest", first_revision_ref: "l2:first" }));
  const withEvents = { ...ctx, events }, before = structuredClone(withEvents), drafts = generator.ensure(withEvents, 0);
  assert.deepEqual(withEvents, before); assert.equal(drafts.length, 3); assert.ok(generator.instructions.length <= 600);
  assert.equal(drafts[0].input.events.length, 6); assert.equal(drafts[0].input.events[0].summary.length, 600);
  assert.equal(drafts[0].input.events[0].date, "Oct 26"); assert.deepEqual(drafts[0].allowed_refs, ["l2:latest", "l2:first"]);
  assert.ok(drafts[0].input.node.child_labels.length <= 10);
  const fp = gapCheckFingerprint(map, node.id), changed = structuredClone(map);
  assert.equal(drafts[0].fingerprint, fp); assert.equal(drafts[0].key, `gap_check:p:${ctx.gaps[0].id}:${fp}`);
  changed.nodes[0].evidence_refs.push("unrelated"); assert.equal(gapCheckFingerprint(changed, node.id), fp);
  changed.nodes[1].evidence_refs.push("target"); assert.notEqual(gapCheckFingerprint(changed, node.id), fp);
  assert.notEqual(gapCheckFingerprint(null, node.id), fp); assert.notEqual(gapCheckFingerprint(map, "missing"), fp);
});

test("maintenance extension registration rejects duplicates and enables reserved kinds", () => {
  const gap = maintenanceGenerators.get("gap_check");
  assert.throws(() => registerMaintenanceGenerator(gap), /already registered: gap_check/);
  const extension = { ...gap, kind: "arch_review" };
  try {
    registerMaintenanceGenerator(extension); assert.equal(maintenanceGenerators.get("arch_review"), extension);
    assert.throws(() => registerMaintenanceGenerator(extension), /already registered: arch_review/);
  } finally { maintenanceGenerators.delete("arch_review"); }
});

test("workstream phase 2 maintenance keys, generationKey, and headRef branch_draft isolation", () => {
  assert.equal(generationKey("alpha"), "alpha");
  assert.equal(generationKey("alpha", undefined), "alpha");
  assert.equal(generationKey("alpha", ""), "alpha");
  assert.equal(generationKey("alpha", "feat-1"), JSON.stringify(["alpha", "feat-1"]));

  const l2 = maintenanceGenerators.get("l2_chunk");
  // Main job without branch_id: key is byte-identical, no branch_id on draft
  const mainJob = { job_id: "main-job", target: "l2", project_id: "p", status: "pending", evidence_hash: "h",
    evidence: [{ ref: "l1:1", kind: "turn", user_text: "fact" }] };
  const mainDrafts = l2.ensure({ accountId: "a", projectId: "p", map: null, jobs: [mainJob], events: [] }, 0);
  assert.equal(mainDrafts.length, 1);
  assert.equal(mainDrafts[0].key, "l2:main-job:0");
  assert.equal(mainDrafts[0].branch_id, undefined);

  // Branch job with branch_id: key is l2:<branch_id>:<job_id>:<index>, draft has branch_id
  const branchJob = { job_id: "branch-job", target: "l2", project_id: "p", branch_id: "ws-feature", status: "pending", evidence_hash: "h",
    evidence: [{ ref: "l1:1", kind: "turn", user_text: "fact" }] };
  const branchDrafts = l2.ensure({ accountId: "a", projectId: "p", map: null, jobs: [branchJob], events: [] }, 0);
  assert.equal(branchDrafts.length, 1);
  assert.equal(branchDrafts[0].key, "l2:ws-feature:branch-job:0");
  assert.equal(branchDrafts[0].branch_id, "ws-feature");

  // A completed branch_draft job never counts as a canonical L2 revision and does not affect the headRef digest
  const canonicalJob = { status: "completed", target: "l2", result_kind: "l2", result_id: "res-1", result_content: "L2 Content", job_id: "j-1", project_id: "p" };
  const branchDraftJob = { status: "completed", target: "l2", result_kind: "branch_draft", branch_id: "ws-feature", job_id: "j-2", project_id: "p" };
  const storageIds = new Set(["p"]);
  const computeHeadRef = (jobList) => {
    const revisionRefs = jobList.filter(j => j.status === "completed" && j.target === "l2" && j.result_kind === "l2" &&
      j.result_id && j.result_content?.trim() && j.project_id && storageIds.has(j.project_id))
      .map(j => `l2:${j.result_id}:${j.job_id}`).sort();
    return revisionRefs.length ? createHash("sha256").update(revisionRefs.join("\n")).digest("hex") : null;
  };
  const baseHeadRef = computeHeadRef([canonicalJob]);
  assert.ok(baseHeadRef);
  const headRefWithBranchDraft = computeHeadRef([canonicalJob, branchDraftJob]);
  assert.equal(headRefWithBranchDraft, baseHeadRef, "branch_draft completion must not change headRef digest");
});


test("timeline digest batches evidence, validates bilingual coverage, and refreshes changed sources", async () => {
  const generator = maintenanceGenerators.get("timeline_digest");
  const events = Array.from({ length: 12 }, (_, i) => ({ id: `event-${i}`, date: "2026-10-01", link_date: "2026-10-01", order: i,
    title: `Change ${i} / 变更 ${i}`, summary: `EN: Change ${i}. ZH: 变更 ${i}。`, architecture_refs: [], latest_revision_ref: `l2:${i}`, first_revision_ref: null }));
  events[0].summary = `EN: ${"a".repeat(600)} ZH: ${"中".repeat(600)}`;
  let artifact;
  const ctx = { accountId: "acct", projectId: "alpha", map: null, jobs: [], events, artifacts: { get: () => artifact } };
  const draft = generator.ensure(ctx, 0)[0];
  assert.ok(draft.input.events.length > 1 && draft.input.events.length <= 10);
  assert.ok(cardEstTokens({ ...draft, instructions: generator.instructions }) <= 2000);
  assert.equal(timelineEventHash(events[0]), timelineEventHash({ ...events[0], latest_revision_ref: "l2:new-head" }), "unchanged events survive an L2 head advance");
  assert.match(draft.input.events[0].summary, /ZH: 中/);
  assert.ok(draft.input.events[0].summary.length < 520);
  const result = { milestones: [{ kind: "topic", topic_en: "Capture", topic_zh: "采集", title_en: "Improved capture", title_zh: "改进采集",
    summary_en: "Validated capture.", summary_zh: "验证采集。", source_ids: [draft.input.events[0].id, draft.input.events[1].id] }],
    omitted_ids: draft.input.events.slice(2).map(item => item.id) };
  assert.equal(generator.validate(draft, result).ok, true);
  assert.equal(generator.validate(draft, { ...result, omitted_ids: [] }).code, "ref_not_allowed");
  assert.equal(generator.validate(draft, { ...result, omitted_ids: [...result.omitted_ids, "other-project"] }).code, "ref_not_allowed");
  assert.equal(generator.validate(draft, { ...result, milestones: [{ ...result.milestones[0], title_zh: "" }] }).ok, false);
  await generator.apply(draft, result, { artifacts: { read: async () => artifact, write: async (_key, value) => { artifact = value; } } }, {}, 0);
  assert.equal(Object.keys(artifact.processed).length, draft.input.events.length);
  const next = generator.ensure(ctx, 1)[0], carried = next.input.carry.source_ids;
  assert.deepEqual(carried, result.milestones[0].source_ids);
  assert.ok(cardEstTokens({ ...next, instructions: generator.instructions }) <= 2000);
  assert.equal(currentTimelineBatchHash(next, events, artifact), next.fingerprint);
  const pending = next.input.events.filter(item => !carried.includes(item.id));
  assert.ok(pending.length > 0);
  const combined = { milestones: [{ ...result.milestones[0], summary_en: "Validated capture and indexed later changes.",
    summary_zh: "验证采集并索引后续变更。", source_ids: [...carried, pending[0].id] }],
    omitted_ids: pending.slice(1).map(item => item.id) };
  assert.equal(generator.validate(next, combined).ok, true);
  assert.equal(generator.validate(next, { milestones: [], omitted_ids: next.input.events.map(item => item.id) }).code, "ref_not_allowed");
  const stale = structuredClone(artifact); stale.milestones[0].summary_en = "Changed elsewhere.";
  assert.equal(currentTimelineBatchHash(next, events, stale), "<stale>");
  const rejected = await generator.apply(next, combined, { artifacts: { read: async () => stale, write: async () => assert.fail("stale carry must not write") } }, {}, 0);
  assert.equal(rejected.code, "stale_fingerprint");
  await generator.apply(next, combined, { artifacts: { read: async () => artifact, write: async (_key, value) => { artifact = value; } } }, {}, 0);
  assert.equal(artifact.milestones.length, 1);
  assert.deepEqual(artifact.milestones[0].source_ids, [...carried, pending[0].id]);
  const changed = structuredClone(events); changed[0].summary += " changed";
  const refreshed = generator.ensure({ ...ctx, events: changed }, 2)[0];
  assert.ok(refreshed.input.events.some(item => item.id === "event-0"));
  assert.notEqual(refreshed.fingerprint, draft.fingerprint);
});

test("timeline digest fits normal long bilingual inputs into the inline budget", () => {
  const generator = maintenanceGenerators.get("timeline_digest");
  const events = Array.from({ length: 12 }, (_, i) => ({ id: `event-${i}`, date: "2026-10-01", link_date: "2026-10-01", order: i,
    title: `Change ${i} / 变更 ${i}`, summary: `EN: ${"evidence ".repeat(70)} ZH: ${"具体证据".repeat(90)}`,
    architecture_refs: [], latest_revision_ref: null, first_revision_ref: null }));
  const [draft] = generator.ensure({ accountId: "acct", projectId: "alpha", map: null, jobs: [], events,
    artifacts: { get: () => undefined } }, 0);
  assert.ok(draft.input.events.length > 0 && draft.input.events.length < 10);
  assert.ok(cardEstTokens({ ...draft, instructions: generator.instructions }) <= 2000);
  assert.match(draft.input.events[0].summary, /EN: .*… ZH: .*…/);
});
