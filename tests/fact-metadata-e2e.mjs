import assert from "node:assert/strict";
import {
  extractDistilledFactMetadata, factMetadataSummary, factProjectStorageIds, filterFactMetadataEvidence, verifiedFactEvidenceRefs
} from "../dist/fact-metadata.js";

const l2 = [
  "# Timeline",
  "## 2025-02-14: Relocation / 搬家",
  "Canonical time: 2025-02-14 (from the original expression 'last Friday')",
  "- Atomic fact: Alex moved from Seattle to Portland. | Evidence: l1:move-1",
  "- Supersedes: Alex lived in Seattle. | Evidence: l1:move-0",
  "- Atomic fact: Alex bought a red notebook after the move.",
  "Evidence: l1:notebook-1"
].join("\n");

const metadata = extractDistilledFactMetadata("l2", l2);
assert.ok(metadata);
assert.equal(metadata.version, "memhub-fact-metadata-v1");
assert.equal(metadata.layer, "L2");
assert.equal(metadata.facts.length, 2);
assert.equal(metadata.parents.length, 1);
assert.equal(metadata.facts[0]?.canonical_time?.start, "2025-02-14");
assert.equal(metadata.facts[0]?.canonical_time?.original_expression, "last Friday");
assert.equal(metadata.facts[0]?.supersedes?.text, "Alex lived in Seattle.");
assert.deepEqual(metadata.facts[0]?.evidence_refs, ["l1:move-1", "l1:move-0"]);
assert.deepEqual(metadata.facts[1]?.evidence_refs, ["l1:notebook-1"]);
assert.deepEqual(factMetadataSummary(metadata), {
  version: "memhub-fact-metadata-v1",
  layer: "L2",
  fact_count: 2,
  parent_count: 1,
  temporal_fact_count: 2,
  superseding_fact_count: 1
});

const l3Current = extractDistilledFactMetadata("l3", [
  "# Current Truth",
  "## Residence / 居住地",
  "- Atomic fact: Alex currently lives in Portland. | Evidence: l2:timeline:rev-2",
  "- Supersedes: Alex lived in Seattle."
].join("\n"));
assert.equal(l3Current?.facts[0]?.supersedes?.text, "Alex lived in Seattle.");
assert.deepEqual(l3Current?.facts[0]?.evidence_refs, ["l2:timeline:rev-2"]);

const sharedEvidence = extractDistilledFactMetadata("l2", [
  "## 2026-10-29: Shared event",
  "- Atomic fact: The first event fact.",
  "- Atomic fact: The second event fact.",
  "Evidence: l1:shared-event"
].join("\n"));
assert.deepEqual(sharedEvidence?.facts.map((fact) => fact.text), ["The first event fact.", "The second event fact."]);
assert.ok(sharedEvidence?.facts.every((fact) => fact.evidence_refs.includes("l1:shared-event")));

const explicitAndSharedEvidence = extractDistilledFactMetadata("l2", [
  "## 2026-10-29: Separate facts in one event",
  "Atomic fact: First. | Evidence: l1:first",
  "Atomic fact: Second. | Evidence: l1:second",
  "Evidence: l1:first, l1:second"
].join("\n"));
assert.deepEqual(explicitAndSharedEvidence?.facts.map((fact) => fact.evidence_refs), [["l1:first"], ["l1:second"]]);

const nestedEvidence = extractDistilledFactMetadata("l2", [
  "## 2026-10-29: Separate fact",
  "- Atomic fact: The unreferenced fact.",
  "- Atomic fact: The referenced fact.",
  "  Evidence: l1:referenced"
].join("\n"));
assert.deepEqual(nestedEvidence?.facts.map((fact) => fact.text), ["The referenced fact."]);

const migrationMetadata = extractDistilledFactMetadata("l2", [
  "## 2026-10-29: Migrated evidence",
  "- Atomic fact: An imported fact. | Evidence: l1-memory:old-memory, raw-turn:old-turn"
].join("\n"));
assert.deepEqual(migrationMetadata?.facts[0]?.evidence_refs, ["l1-memory:old-memory", "raw-turn:old-turn"]);

const pastJob = (account, project, date, ref) => ({
  account_id: account, project_id: project, target: "l2", status: "completed", result_kind: "l2",
  result_committed_at: date, evidence: [{ layer: "L1", ref }]
});
const scopedRefs = verifiedFactEvidenceRefs({
  kind: "l2", accountId: "account-a", projectId: "project-a", asOf: "2026-10-29T12:00:00Z",
  projectStorageIds: ["project-a", "project-old"],
  evidence: [{ layer: "L1", ref: "l1:current" }],
  jobs: [
    pastJob("account-a", "project-a", "2026-10-28T12:00:00Z", "l1:previous"),
    pastJob("account-a", "project-old", "2026-10-28T12:00:00Z", "l1:merged-history"),
    pastJob("account-b", "project-a", "2026-10-28T12:00:00Z", "l1:other-account"),
    pastJob("account-a", "project-b", "2026-10-28T12:00:00Z", "l1:other-project"),
    pastJob("account-a", "project-a", "2026-10-29T12:00:00Z", "l1:same-millisecond"),
    pastJob("account-a", "project-a", "2026-10-30T12:00:00Z", "l1:future")
  ]
});
assert.deepEqual(scopedRefs, ["l1:current", "l1:previous", "l1:merged-history"]);
assert.deepEqual(await factProjectStorageIds({
  resolve: async (account, project) => account === "account-a" && project === "project-old" ? "project-a" : null,
  storageIds: async () => ["project-a", "project-old"]
}, "account-a", "project-old"), ["project-a", "project-old"]);
const mixedMetadata = extractDistilledFactMetadata("l2", [
  "## 2026-10-29: Scoped evidence",
  "- Atomic fact: Prior valid fact. | Evidence: l1:previous, l1:other-project",
  "- Atomic fact: Unsupported fact. | Evidence: l1:future"
].join("\n"));
const scopedMetadata = filterFactMetadataEvidence(mixedMetadata, scopedRefs);
assert.deepEqual(scopedMetadata?.facts.map((fact) => fact.text), ["Prior valid fact."]);
assert.deepEqual(scopedMetadata?.facts[0]?.evidence_refs, ["l1:previous"]);

const realV4Shape = [
  "# Timeline / 时间线",
  "## Chronology / 时间顺序",
  "### 9–17 August 2023 — Games, travel, and belonging",
  "### 2023年8月9日至17日——比赛、旅行与归属感",
  "- Alex moved from Seattle to Portland during the trip.",
  "  Alex 在旅途中从西雅图搬到了波特兰。",
  "  **Refs:** `l1:move-1`, `l1:trip-1`",
  "- Alex bought a red notebook after arriving.",
  "  Alex 抵达后买了一本红色笔记本。",
  "  **Ref:** `l1:notebook-1`",
  "### 26 August–2 October 2023 — Settling in",
  "### 2023年8月26日至10月2日——安顿",
  "- Alex now considers Portland home.",
  "  Alex 现在把波特兰视为家。",
  "  **Ref:** `l1:home-1`"
].join("\n");
const realMetadata = extractDistilledFactMetadata("l2", realV4Shape);
assert.ok(realMetadata);
assert.equal(realMetadata.facts.length, 3);
assert.equal(realMetadata.parents.length, 2);
assert.deepEqual(realMetadata.facts[0]?.evidence_refs, ["l1:move-1", "l1:trip-1"]);
assert.equal(realMetadata.facts[0]?.canonical_time?.start, "2023-08-09");
assert.equal(realMetadata.facts[0]?.canonical_time?.end, "2023-08-17");
assert.equal(realMetadata.facts[2]?.canonical_time?.start, "2023-08-26");
assert.equal(realMetadata.facts[2]?.canonical_time?.end, "2023-10-02");

const nestedAtomicShape = [
  "# Timeline / 时间线",
  "## 15 June 2023 — Endorsement ambitions",
  "## 2023年6月15日——代言计划",
  "- **John began exploring endorsement opportunities.**",
  "  **John 开始探索品牌代言机会。**",
  "  - Atomic facts: John was considering Nike and Under Armour; John was open to brands aligned with his values; John planned to keep Tim updated.",
  "  - 原子事实：John 考虑 Nike 和 Under Armour；John 愿意考虑符合其价值观的品牌；John 计划继续向 Tim 更新。",
  "  - Evidence: `l1:endorsement-1`, `l1:endorsement-2`",
  "- **Tim maintained a Harry Potter collection.**",
  "  **Tim 保持着哈利·波特收藏。**",
  "  - Atomic facts: Tim owned a MinaLima picture; MinaLima created props for the Harry Potter films.",
  "  - 原子事实：Tim 有一幅 MinaLima 图片；MinaLima 为哈利·波特电影制作过道具。",
  "  - Evidence: `l1:collection-1`",
  "## Supersession notes / 取代说明",
  "- No explicit supersession events were present in the supplied evidence."
].join("\n");
const nestedMetadata = extractDistilledFactMetadata("l2", nestedAtomicShape);
assert.ok(nestedMetadata);
assert.equal(nestedMetadata.facts.length, 5);
assert.equal(nestedMetadata.facts.every((fact) => fact.evidence_refs.length > 0), true);
assert.equal(nestedMetadata.facts[0]?.canonical_time?.start, "2023-06-15");

const bilingualEvidenceBlock = [
  "# Timeline / 时间线",
  "## 2023-02-01 — Engineering studies",
  "- Jolene was working on an engineering project.",
  "  Jolene 正在进行一个工程项目。",
  "**Evidence / 证据:**",
  "`l1:eng-1`, `l1:eng-2`",
  "## 2023-02-04 — Water purifier milestone",
  "- Jolene completed a water-purifier prototype.",
  "  Jolene 完成了净水器原型。",
  "Evidence / 证据: `l1:water-1`"
].join("\n");
const bilingualEvidenceMetadata = extractDistilledFactMetadata("l2", bilingualEvidenceBlock);
assert.ok(bilingualEvidenceMetadata);
assert.deepEqual(bilingualEvidenceMetadata.facts[0]?.evidence_refs, ["l1:eng-1", "l1:eng-2"]);
assert.deepEqual(bilingualEvidenceMetadata.facts[1]?.evidence_refs, ["l1:water-1"]);

const bracketEvidenceShape = [
  "# Timeline / 时间线",
  "## 2023-04-01 — Family road trip",
  "- Evan visited Banff with his family. [l1:road-1, l1:road-2]",
  "- This summary sentence intentionally has no evidence and must remain Markdown-only."
].join("\n");
const bracketEvidenceMetadata = extractDistilledFactMetadata("l2", bracketEvidenceShape);
assert.ok(bracketEvidenceMetadata);
assert.equal(bracketEvidenceMetadata.facts.length, 1);
assert.equal(bracketEvidenceMetadata.facts[0]?.text, "Evan visited Banff with his family.");
assert.deepEqual(bracketEvidenceMetadata.facts[0]?.evidence_refs, ["l1:road-1", "l1:road-2"]);

const l3FallbackMetadata = extractDistilledFactMetadata("l3", [
  "# Current Truth / 当前事实",
  "## Residence / 居住地",
  "- Alex currently lives in Portland.",
  "  Alex 目前住在波特兰。"
].join("\n"), ["l2:timeline_real:rev-real"]);
assert.ok(l3FallbackMetadata);
assert.deepEqual(l3FallbackMetadata.facts[0]?.evidence_refs, ["l2:timeline_real:rev-real"]);

assert.equal(extractDistilledFactMetadata("l4", l2), undefined);
assert.equal(extractDistilledFactMetadata("skill", l2), undefined);

console.log("fact-metadata-e2e: ok");
