import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { renderConsole } from "../dist/web-ui.js";

const account = { account_id: "acct-test", username: "tester", role: "user" };
const html = renderConsole({ account, accounts: [account], projects: [], adminView: false, localControl: true, selectedAccountId: account.account_id });
const fn = name => html.match(new RegExp("^function " + name + "[^\\n]+", "m"))[0];
const helpers = [fn("displayText"), fn("displayParagraphs")].join("\n");
const display = (lang, value) => runInNewContext(helpers + ";displayText(value)", { lang, value });

for (const [value, zh, en] of [
  ["检索候选 / Retrieve candidates", "检索候选", "Retrieve candidates"],
  ["Retrieve candidates / 检索候选", "检索候选", "Retrieve candidates"],
  ["EN: Rank with BM25. ZH: 使用 BM25 排序。", "使用 BM25 排序。", "Rank with BM25."],
  ["读取 Top-K 候选。 Read Top-K candidates.", "读取 Top-K 候选。", "Read Top-K candidates."],
  ["BM25 / Top-K", "BM25 / Top-K", "BM25 / Top-K"],
  ["src/core/ranker.ts#L20-L40", "src/core/ranker.ts#L20-L40", "src/core/ranker.ts#L20-L40"],
  ["Single-language historical text", "Single-language historical text", "Single-language historical text"]
]) {
  assert.equal(display("zh", value), zh);
  assert.equal(display("en", value), en);
}

const paragraphs = ["Atomic fact: Core writes L2. | Evidence: l1:one", "Core 写入 L2。", "Evidence: l1:one"];
for (const [lang, included, excluded] of [["zh", "Core 写入 L2。", "Atomic fact:"], ["en", "Atomic fact:", "Core 写入 L2。"]]) {
  const output = runInNewContext(helpers + ";displayParagraphs(paragraphs).join(' ')", { lang, paragraphs });
  assert.ok(output.includes(included));
  assert.ok(!output.includes(excluded));
  assert.ok(output.includes("Evidence: l1:one"));
}

const artifact = fn("structuredArtifactHtml");
for (const [lang, included, excluded] of [["zh", "保留结果", "Keep results"], ["en", "Keep results", "保留结果"]]) {
  const output = runInNewContext(helpers + "\n" + artifact + ";structuredArtifactHtml(body)", {
    lang, body: "# Title\n\n## 说明 / Details\n\n- EN: Keep results\n- ZH: 保留结果\n\nBM25 / Top-K",
    esc: value => String(value), cleanHeading: value => value.replace(/^#+\s*/, "")
  });
  assert.ok(output.includes(included));
  assert.ok(!output.includes(excluded));
  assert.ok(output.includes("BM25 / Top-K"));
}

const render = html.match(/^function renderVisualization\(\)\{[\s\S]*?^\}\n/m)[0];
const timelineEvents = html.match(/^function projectTimelineEvents\(.*[\s\S]*?^\}\n/m)[0];
const selection = fn("projectFlowSelection");
const timelineHelpers = [fn("projectStateSearchText"), timelineEvents, selection, fn("architecturePrimarySummary"), fn("architectureTextUnits"), fn("architectureTakeText"), fn("architecturePurposeLines")].join("\n");
const events = Array.from({ length: 12 }, (_, index) => ({
  id: "main-" + index, date: "2026-10-" + String(index + 1).padStart(2, "0"), date_label: "2026-10-" + String(index + 1).padStart(2, "0"),
  title: "Build " + index + " / 构建 " + index, summary: "EN: Built a concrete feature. ZH: 完成具体功能。", order: index + 1,
  workstream_id: "inferred-topic", workstream_basis: "inferred", stage: "completed", current_head: index === 11
}));
const branches = [
  { id: "review", name: "Review", status: "merged", created_at: "2026-10-02T09:00:00Z", base_l2_revision: "l2:base:1",
    merged_at: "2026-10-08T09:00:00Z", merge_revision_ref: "l2:merge:2",
    events: [{ date: "2026-10-04", title: "EN: Test change ZH: 测试变更", summary: "EN: Verify the fix. ZH: 验证修复。", evidence_refs: ["l1:one"], merged: true }] },
  { id: "unknown", name: "Unknown", status: "active", created_at: "2026-10-03T09:00:00Z", base_l2_revision: "l2:future:3",
    merged_at: "2026-10-09T09:00:00Z", merge_revision_ref: "l2:future:3",
    events: [{ date: "2026-10-06", title: "EN: Isolated change ZH: 独立变更", summary: "EN: Check behavior. ZH: 检查行为。", evidence_refs: [], merged: false }] },
  { id: "empty", name: "Empty", status: "active", created_at: "2026-10-05T09:00:00Z", goal: "Test branch", events: [] }
];
const revisions = [{ ref: "l2:base:1", committed_at: "2026-10-01T00:00:00Z" }, { ref: "l2:merge:2", committed_at: "2026-10-07T00:00:00Z" }, { ref: "l2:future:3", committed_at: "2026-10-10T00:00:00Z" }];
const digest = { processed: 3, total: 12, processed_ids: ["main-0", "main-1", "main-2"], milestones: [
  { kind: "main", title_en: "Established the main architecture", title_zh: "建立主线架构", summary_en: "Created the initial platform.", summary_zh: "建立初始平台。", source_ids: ["main-0", "main-1"] },
  { kind: "topic", topic_en: "Capture", topic_zh: "采集", title_en: "Improved capture", title_zh: "改进采集", summary_en: "Validated capture behavior.", summary_zh: "验证采集行为。", source_ids: ["main-2"] }
] };
const box = { className: "", innerHTML: "", querySelector: () => null, querySelectorAll: () => [] };
const context = { lang: "zh", payload: { state: { events, branches, timeline_digest: digest }, drilldown: { revisions }, stats: {} }, document: { getElementById: () => box },
  projectSelect: { value: "alpha", selectedOptions: [{ textContent: "Alpha" }] }, filterInput: { value: "" }, window: {},
  statusText: value => value, esc: value => String(value), emptyState: () => ""
};
const script = helpers + "\n" + timelineHelpers + "\nvar projectFlowPinned=null;function bindProjectFlow(){}\n" + render + ";renderVisualization()";
runInNewContext(script, context);
assert.ok(context.window.visibleItems.length < events.length + branches.length, "show distilled milestones rather than every L2 event");
assert.equal(context.window.visibleItems.filter(event => event.id.startsWith("digest:")).length, 2);
assert.ok(context.window.visibleItems.some(event => event.kind === "topic" && event.workstream_id.startsWith("topic:")));
assert.ok(context.window.visibleItems.some(event => event.id === "timeline-origin"), "an earlier recorded source anchors topic branches to mainline");
assert.match(box.innerHTML, /is-projection/);
assert.match(box.innerHTML, /建立主线架构/);
assert.match(box.innerHTML, /改进采集/);
assert.match(box.innerHTML, /当前 L2 HEAD/);
assert.match(box.innerHTML, /data-from="fork:review" data-to="branch-event:review:0"/);
assert.match(box.innerHTML, /data-from="branch-event:review:0" data-to="merge:review"/);
assert.doesNotMatch(box.innerHTML, /fork:unknown|merge:unknown/);
assert.doesNotMatch(box.innerHTML, /branch-record:empty/);
assert.doesNotMatch(box.innerHTML, /project-flow-lane-label/);
assert.match(box.innerHTML, /验证修复/);
assert.doesNotMatch(box.innerHTML, /Verify the fix/);
assert.match(box.innerHTML, /data-flow-fit/);
assert.match(box.innerHTML, /双击打开详情/);
context.filterInput.value = "测试";
runInNewContext(script, context);
assert.equal(context.window.visibleItems.filter(event => event.id.startsWith("digest:")).length, 2, "search dims instead of hiding milestones");
assert.match(box.innerHTML, /is-filtered/);
context.lang = "en"; context.filterInput.value = "";
runInNewContext(script, context);
assert.match(box.innerHTML, /Verify the fix/);
assert.doesNotMatch(box.innerHTML, /验证修复/);
assert.match(box.innerHTML, /CURRENT L2 HEAD/);
const openEvent = html.match(/^window\.openProjectStateEvent=[^\n]+/m)[0];
let drawer = "";
const drawerContext = { lang: "zh", window: { visibleItems: [{ id: "event", title: "Title / 标题", summary: "Short / 简短", detail: "EN: Full details. ZH: 完整变更详情。", evidence_refs: ["l1:one"], workstream_id: "main", workstream_label: "Mainline", current_head: true }] },
  payload: { drilldown: { revisions: [] } }, document: { getElementById: () => null }, focusProjectStateEvent: () => {}, lastDrawerReturnSelector: "",
  openDrawer: value => { drawer = value; }, statusText: value => value, esc: value => String(value) };
runInNewContext(helpers + "\n" + openEvent + ";window.openProjectStateEvent(0)", drawerContext);
assert.match(drawer, /完整变更详情/);
assert.match(drawer, /l1:one/);
assert.match(drawer, /<b>主线<\/b>/);
assert.match(drawer, /当前 L2 head/);
drawerContext.lang = "en";
runInNewContext(helpers + "\n" + openEvent + ";window.openProjectStateEvent(0)", drawerContext);
assert.match(drawer, /<b>Mainline<\/b>/);
assert.match(drawer, /current L2 head/);
console.log("web-ui-localized-timeline-e2e: ok");
