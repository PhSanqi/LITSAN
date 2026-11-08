// Fresh undistilled L1 turns must not push the L2 timeline out of the capsule budget (pilot-v2 defect, 2026-11-08).
import assert from "node:assert/strict";
import test from "node:test";
import { resolveProjectScope } from "../dist/core/scope/project-scope.js";
import { buildContextCapsule } from "../dist/core/context/context-capsule.js";

const resolution = resolveProjectScope({ workspaceProjectId: "memhub" });
const text = (label, bytes) => `${label} `.padEnd(bytes, "x");
const base = { scope: "project", projectId: "memhub", source: "memory" };
const l3 = { ...base, id: "project_profile_1", content: text("profile", 386), authority: "remembered", evidenceRef: "l3:project_profile_1", provenance: { memoryLayer: "L3" } };
const l2 = { ...base, id: "timeline_1", content: text("timeline", 408), authority: "remembered", evidenceRef: "l2:timeline_1", provenance: { memoryLayer: "L2" } };
const fresh = (n) => ({ ...base, id: `l1_fresh_${n}`, content: text(`fresh ${n}`, 605), authority: "evidence", evidenceRef: `l1:l1_fresh_${n}`,
  provenance: { memoryLayer: "L1", freshness: "undistilled" } });
const global = (id, bytes) => ({ id, content: text(id, bytes), authority: "remembered", scope: "global", source: "memory", provenance: { memoryLayer: "L4" } });
const skill = { id: "skill_1", content: text("skill", 786), authority: "remembered", scope: "capability", source: "skill" };
const arch = (id, bytes) => ({ ...base, id, content: text(id, bytes), authority: "authoritative", source: "architecture" });
const globalState = { id: "state_1", content: text("state", 2618), authority: "observed", scope: "global", source: "state" };

// Sizes observed on the pilot-v2 copy (brief budget 8,000 B): the other collections use ~7 KB before the project list's L2 item is reached.
function capsule(extra = {}, projectMemory = [l3, fresh(1), fresh(2), fresh(3), fresh(4), l2]) {
  return buildContextCapsule({ accountId: "acct", resolution, detail: "brief", query: "retrieval policy",
    globalMemory: [global("g1", 382), global("g2", 668)], globalState: [globalState], projectMemory, reusableSkills: [skill],
    projectArchitecture: [arch("a1", 1767), arch("a2", 744)], ...extra });
}
const ids = (c) => c.projectMemory.map((i) => i.id);

test("old order (reserve off) reproduces the defect: four fresh turns, no L2", () => {
  const c = capsule({ reserveL2Timeline: false });
  assert.ok(!ids(c).includes("timeline_1"), ids(c).join());
  assert.ok(c.contextBudgetTrace.decisions.some((d) => d.id === "timeline_1" && d.result === "dropped"));
});

test("reserve keeps the L2 timeline at its place and within the byte budget", () => {
  const c = capsule();
  const got = ids(c);
  assert.ok(got.includes("timeline_1"), got.join());
  assert.equal(got[0], "project_profile_1");
  assert.ok(got.indexOf("l1_fresh_1") < got.indexOf("timeline_1"), "relative order of emitted items is kept");
  assert.ok(c.contextBudget.emittedContentBytes <= c.contextBudget.maxContentBytes);
  const sum = [...c.globalMemory, ...c.globalState, ...c.projectMemory, ...c.reusableSkills, ...c.projectArchitecture]
    .reduce((n, i) => n + Buffer.byteLength(i.content, "utf8"), 0);
  assert.equal(sum, c.contextBudget.emittedContentBytes);
  const decisions = c.contextBudgetTrace.decisions.filter((d) => d.id === "timeline_1");
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].result, "kept");
});

// Same emitted items and byte accounting (the trace lists the reserved item first, so it is not compared).
const emitted = ({ contextBudgetTrace, ...rest }) => rest;
test("reserve is a no-op when the L2 timeline already fits or sits first", () => {
  const roomy = capsule({ maxContentBytes: 96_000, maxItemContentBytes: 24_000 });
  const roomyOff = capsule({ maxContentBytes: 96_000, maxItemContentBytes: 24_000, reserveL2Timeline: false });
  assert.deepEqual(emitted(roomy), emitted(roomyOff));
  const first = [l2, fresh(1)];
  assert.deepEqual(emitted(capsule({}, first)), emitted(capsule({ reserveL2Timeline: false }, first)));
  const noL2 = [l3, fresh(1), fresh(2)];
  assert.deepEqual(emitted(capsule({}, noL2)), emitted(capsule({ reserveL2Timeline: false }, noL2)));
});

test("only the first L2 item is reserved and the budget is never exceeded when it is large", () => {
  const big = { ...l2, content: text("timeline", 9_000) };
  const c = capsule({}, [l3, fresh(1), fresh(2), big, { ...l2, id: "timeline_2", evidenceRef: "l2:timeline_2" }]);
  assert.ok(ids(c).includes("timeline_1"));
  assert.ok(c.contextBudget.emittedContentBytes <= c.contextBudget.maxContentBytes);
  const t = c.projectMemory.find((i) => i.id === "timeline_1");
  assert.ok(Buffer.byteLength(t.content, "utf8") <= c.contextBudget.maxItemContentBytes);
});

test("reserve works on items that carry no evidence ref yet (refs are attached after the capsule is built)", () => {
  const noRef = { ...l2, evidenceRef: undefined };
  const c = capsule({}, [{ ...l3, evidenceRef: undefined }, ...[1, 2, 3, 4].map((n) => ({ ...fresh(n), evidenceRef: undefined })), noRef]);
  assert.ok(ids(c).includes("timeline_1"), ids(c).join());
});
