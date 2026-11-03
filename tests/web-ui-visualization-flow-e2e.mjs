import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { renderConsole } from "../dist/web-ui.js";

const account = { account_id: "acct-test", username: "tester", role: "user" };
const html = renderConsole({
  account,
  accounts: [account],
  projects: [{ projectId: "alpha", name: "Alpha", aliases: [], todos: [], state: "active" }],
  adminView: false,
  localControl: true,
  selectedAccountId: account.account_id
});

// Project Map combines the derived architecture mental model with the canonical
// L2 progress flow; evidence/revisions stay behind drill-down.
assert.match(html, /prefers-reduced-motion:reduce/);
assert.match(html, /项目地图/);
assert.match(html, /ARCHITECTURE COGNITIVE MAP/);
assert.match(html, /architecture-tree/);
assert.match(html, /architecture-graph/);
assert.match(html, /data-relation-toggle/);
assert.match(html, /aria-pressed/);
assert.match(html, /data-architecture-level/);
assert.match(html, /data-architecture-fit aria-pressed="true"/);
assert.match(html, /适应宽度/);
assert.match(html, /fit:true/);
assert.match(html, /width:100%;min-width:var\(--architecture-min-width\);height:auto/);
assert.match(html, /graph.width\*0\.45/);
assert.match(html, /frame.scrollLeft=root/);
assert.match(html, /data-architecture-view="graph"/);
assert.match(html, /data-architecture-view="list"/);
assert.match(html, /pinnedNode:null/);
assert.match(html, /interaction_v3:true/);
assert.match(html, /Hover: preview · Click: pin focus \(priority\) · Click blank: clear · Double-click: open details/);
assert.match(html, /双击：打开详情/);
assert.match(html, /固定聚焦（优先）/);
assert.match(html, /单击空白：取消聚焦/);
assert.match(html, /Mechanism \/ Rule/);
assert.match(html, /机制 \/ 决策规则/);
assert.match(html, /document\.addEventListener\('dblclick'/);
assert.match(html, /pinArchitectureNode/);
assert.match(html, /TIMELINE EVOLUTION/);
assert.match(html, /openArchitectureNode/);
assert.match(html, /project-flow-canvas/);
assert.match(html, /project-flow-edge/);
assert.match(html, /项目发展时间线/);
assert.match(html, /虚线表示主题归类，不代表 Git 分叉或合并/);
assert.match(html, /来源追溯 · L2 revision \/ evidence/);
assert.match(html, /完整 L2 时间线/);
assert.doesNotMatch(html, /project-state-time-track/);
assert.doesNotMatch(html, /project-state-lane-row/);
assert.doesNotMatch(html, /证据关系[^<]*<\/span>/);

// Exercise the emitted browser functions, including both languages and zero counts.
const countSource = html.match(/^function architectureCount[^\n]+/m)[0];
for (const [singular, plural, zh] of [['change', 'changes', '次变更'], ['node', 'nodes', '节点'], ['relation', 'relations', '关系'], ['event', 'events', '次变更']]) {
  for (const count of [0, 1, 2]) {
    assert.equal(runInNewContext(countSource + ';architectureCount(count,singular,plural,zh)', { lang: 'en', count, singular, plural, zh }), count + ' ' + (count === 1 ? singular : plural));
    assert.equal(runInNewContext(countSource + ';architectureCount(count,singular,plural,zh)', { lang: 'zh', count, singular, plural, zh }), count + ' ' + zh);
  }
}
const nodeSource = html.match(/^function architectureNodeHtml[^\n]+/m)[0];
const displayTextSource = html.match(/^function displayText[^\n]+/m)[0];
const primaryLabelSource = html.match(/^function architecturePrimaryLabel[^\n]+/m)[0];
const primarySummarySource = html.match(/^function architecturePrimarySummary[^\n]+/m)[0];
const translationNoticeSource = html.match(/^function architectureTranslationNotice[^\n]+/m)[0];
for (const lang of ['en', 'zh']) {
  const notice = runInNewContext(displayTextSource + ';' + translationNoticeSource + ';architectureTranslationNotice(nodes)', {
    lang, nodes: [{ summary: 'EN: Preserve Top-K. ZH: 保留 Top-K。' }, { summary: 'Only English exists.' }]
  });
  assert.match(notice, lang === 'zh' ? /1 个节点缺少双语说明/ : /1 node lacks bilingual descriptions/);
  assert.doesNotMatch(notice, /2 nodes|2 个节点/);
}
for (const lang of ['en', 'zh']) {
  const tree = runInNewContext(displayTextSource + ';' + primaryLabelSource + ';' + primarySummarySource + ';' + nodeSource + ';architectureNodeHtml(node,new Map())', { lang, node: { id: 'one', kind: 'method', label: '筛选候选 / Filter candidates', summary: '输入候选，计算相关性并输出最高分项。 Filter candidates and keep the highest-ranked items.', confidence: .91 }, architectureKindLabel: kind => kind, esc: value => value });
  assert.match(tree, lang === 'en' ? /Filter candidates/ : /筛选候选/);
  assert.match(tree, /91%/);
  assert.doesNotMatch(tree, /change|次变更/);
}
const searchSource = html.match(/^function architectureSearchText[^\n]+/m)[0];
assert.match(runInNewContext(searchSource + ';architectureSearchText(node)', { node: { id: 'knowledge-plan', label: '轮次知识计划 / Turn Knowledge Plan', summary: 'Required supporting knowledge.' } }), /tkp/);
const textUnitsSource = html.match(/^function architectureTextUnits[^\n]+/m)[0];
const takeTextSource = html.match(/^function architectureTakeText[^\n]+/m)[0];
const purposeLinesSource = html.match(/^function architecturePurposeLines[^\n]+/m)[0];
const graphSource = html.match(/^function architectureGraphHtmlV2[^\n]+/m)[0];
for (const lang of ['en', 'zh']) {
  const graph = { width: 300, height: 200, levels: ['method'], relations: [], nodes: [
    { id: 'search', kind: 'method', label: 'Find candidates / 检索候选', summary: 'EN: Retain Top-K results. ZH: 保留 Top-K 结果。', confidence: 1, x: 150, y: 50 }
  ] };
  const output = runInNewContext([displayTextSource, primaryLabelSource, primarySummarySource, textUnitsSource, takeTextSource, purposeLinesSource, graphSource].join(';') + ';architectureGraphHtmlV2(graph)', {
    lang, graph, architectureKindLabel: kind => kind, architectureRelationLabel: value => value, esc: value => String(value)
  });
  assert.match(output, lang === 'zh' ? /检索候选/ : /Find candidates/);
  assert.match(output, lang === 'zh' ? /保留 Top-K/ : /Retain Top-K/);
  assert.doesNotMatch(output, lang === 'zh' ? /Find candidates|Retain Top-K/ : /检索候选|保留 Top-K/);
}
const decorateSource = html.match(/^function decorateProjectArchitectureMap[^\n]+/m)[0];
for (const lang of ['en', 'zh']) {
  let annotation;
  const flowNode = { dataset: { itemIndex: '0' }, appendChild: value => { annotation = value; }, addEventListener: () => {} };
  const stage = { before: () => {} };
  const document = {
    querySelector: value => value === '[data-project-state-board]' ? stage : null,
    querySelectorAll: value => value === '.project-flow-node' ? [flowNode] : [],
    createElement: () => ({}),
    createElementNS: () => ({ setAttribute: () => {} })
  };
  const payload = { project_id: 'alpha', state: { events: [] }, architecture: { available: true, nodes: [
    { id: 'search', parent_id: null, label: 'Find candidates / 检索候选', summary: 'EN: Read Top-K. ZH: 读取 Top-K。' }
  ], edges: [], timeline_links: [] } };
  runInNewContext([displayTextSource, primaryLabelSource, translationNoticeSource, decorateSource].join(';') + ';decorateProjectArchitectureMap()', {
    lang, document, payload, window: { visibleItems: [{ architecture_refs: ['search'] }] }, esc: String,
    architectureCount: () => '', architectureNodeHtml: () => '', bindMapActions: () => {}, bindMapQueueStatus: () => {},
    updateMapFlagBadges: () => {}, flowClip: value => value, focusArchitectureRefs: () => {}
  });
  assert.equal(annotation.textContent, lang === 'zh' ? '检索候选' : 'Find candidates');
}
assert.equal(runInNewContext(textUnitsSource + ';architectureTextUnits("中")'), 2);
assert.equal(runInNewContext(textUnitsSource + ';architectureTextUnits("A")'), 1);
assert.equal(runInNewContext(textUnitsSource + ';' + takeTextSource + ';architectureTakeText("这是一个很长的中文架构卡片标题",10,true)'), '这是一个很…');
const previewSource = html.match(/^function architecturePreviewFocusId[^\n]+/m)[0];
assert.equal(runInNewContext(previewSource + ';architecturePreviewFocusId("hovered","pinned")'), 'pinned');
assert.equal(runInNewContext(previewSource + ';architecturePreviewFocusId("hovered",null)'), 'hovered');
assert.equal(runInNewContext(previewSource + ';architecturePreviewFocusId(null,null)'), null);
assert.match(html, /architectureSuppressClickUntil=Date\.now\(\)\+300/);
assert.doesNotMatch(html, /hasDragged=false;frame\.setPointerCapture\(e\.pointerId\)/);
assert.match(html, /if\(Math\.abs\(dx\)>5&&!hasDragged\)\{hasDragged=true;frame\.classList\.add\('is-dragging'\);if\(!frame\.hasPointerCapture\(e\.pointerId\)\)frame\.setPointerCapture\(e\.pointerId\)\}/);
assert.match(html, /if\(dragged\)return;if\(node\)\{pinArchitectureNode/);
assert.match(html, /clearProjectStateFocus\(\)\},true\);/);
assert.match(html, /architectureImplementationDetailHtml/);
assert.match(html, /architectureImplementationDetailHtmlV2/);
assert.match(html, /Implementation pipeline/);
assert.match(html, /Key parameters \/ pruning rules/);
assert.match(html, /Inputs, outputs & dependencies/);
assert.match(html, /Code locations/);
assert.match(html, /Evidence refs/);
assert.match(html, /architecture-graph-purpose/);
assert.match(html, /architectureGraphHtml=architectureGraphHtmlV2/);
assert.match(html, /architecture-pipeline\.is-unordered \.architecture-pipeline-step:not\(:last-child\)::after\{content:none\}/);
assert.match(html, /architecture-card-text-clip/);
assert.match(html, /clip-path="url\(#architecture-card-text-clip\)"/);
assert.match(html, /architecturePurposeLines\(node,38\)/);
assert.doesNotMatch(html, /architectureMainGraph/);
assert.match(html, /architectureImplementationCodeRef/);
assert.match(html, /data-architecture-open-node/);
const pathSource = html.match(/^function architectureNodePath[^\n]+/m)[0];
const codeRefSource = html.match(/^function architectureImplementationCodeRef[^\n]+/m)[0];
const modulesSource = html.match(/^function architectureImplementationModules[^\n]+/m)[0];
const relationRoleSource = html.match(/^function architectureImplementationRelationRole[^\n]+/m)[0];
const stepsSource = html.match(/^function architectureImplementationSteps[^\n]+/m)[0];
const evidenceSource = html.match(/^function architectureImplementationEvidenceGroups[^\n]+/m)[0];
const detailSource = html.match(/^function architectureImplementationDetailHtmlV2[^\n]+/m)[0];
const relationEvidenceSource = html.match(/^function architectureRelationEvidenceHtml[^\n]+/m)[0];
const explorerSource = html.match(/^function architectureExplorerHtml[^\n]+/m)[0];
const findPathSource = html.match(/^function architectureFindPath[^\n]+/m)[0];
const impactSource = html.match(/^function architectureImpactPaths[^\n]+/m)[0];

const graphEdges = [
  { from: 'a', to: 'b', type: 'depends_on', evidence_refs: ['code:alpha:abc:src/a.ts#L1-L1'] },
  { from: 'b', to: 'c', type: 'uses', evidence_refs: ['l2:evidence'] },
  { from: 'c', to: 'a', type: 'flows_to', evidence_refs: ['l1:evidence'] },
  { from: 'a', to: 'd', type: 'contains', evidence_refs: [] }
];
const trace = (start, target, type) => runInNewContext(findPathSource + ';architectureFindPath(edges,start,target,type)', { edges: graphEdges, start, target, type });
assert.equal(trace('a', 'c', 'any').length, 2);
assert.equal(trace('a', 'c', 'depends_on'), null);
assert.equal(trace('a', 'd', 'any'), null);
assert.equal(trace('c', 'a', 'any').length, 1);
const impacts = runInNewContext(impactSource + ';architectureImpactPaths(edges,"c")', { edges: graphEdges });
assert.deepEqual(Array.from(impacts, item => item.id), ['b', 'a']);
assert.equal(impacts[1].path.length, 2);
const longEdges = Array.from({ length: 7 }, (_, i) => ({ from: String(i), to: String(i + 1), type: 'uses' }));
assert.equal(runInNewContext(findPathSource + ';architectureFindPath(edges,"0","7","any")', { edges: longEdges }), null);
assert.doesNotMatch(html, /data-architecture-code-check/);
assert.match(html, /data-architecture-trace-result/);

const detailPayload = {
  architecture: {
    nodes: [
      { id: 'root', kind: 'method', label: '重排候选 / Rerank candidates', summary: '候选进入后计算并融合相关性，输出裁剪后的候选。 Fuse candidate relevance and return a pruned ranked set.', parent_id: null, order: 0, evidence_refs: ['code:litsan:abc123:src/core/root.ts#L10-L22'], confidence: .99 },
      { id: 'semantic', kind: 'mechanism', label: '计算语义分 / Score semantics', summary: '读取语义相似度，输出归一化语义分。 Normalize semantic similarity into a score.', parent_id: 'root', order: 1, evidence_refs: ['code:litsan:abc123:src/core/child.ts#L30-L48'], confidence: .91, facts: [{ key: 'weight', value: .68, evidence_refs: ['code:litsan:abc123:src/core/child.ts#L41-L41'], confidence: .95 }] },
      { id: 'topk', kind: 'mechanism', label: '保留 Top-K / Keep Top-K', summary: '按最终分数排序并裁剪低分候选。 Sort by final score and drop candidates below Top-K.', parent_id: 'root', order: 2, evidence_refs: ['code:litsan:abc123:src/core/topk.ts#L10-L25'], confidence: .93, facts: [{ key: 'top_k', value: 12, evidence_refs: ['code:litsan:abc123:src/core/topk.ts#L18-L18'], confidence: .95 }] }
    ],
    edges: [{ from: 'semantic', to: 'topk', type: 'flows_to', evidence_refs: ['code:litsan:abc123:src/core/root.ts#L18-L18'], confidence: .9 }]
  },
  state: { events: [{ id: 'event:1', title: 'Mechanism refined', summary: 'Full evolution summary is visible here.', date_label: '2026-10-29', order: 1, architecture_refs: ['child'], architecture_change_kind: 'refine', architecture_confidence: .94, workstream_label: 'Validation', stage: 'active', version: 'v2', first_seen_at: '2026-10-28', last_seen_at: '2026-10-29' }] },
  drilldown: { revisions: [{ ref: 'l2:timeline:r2', committed_at: '2026-10-29', current: true, event_ids: ['event:1'], evidence_refs: ['l1:revision'] }] }
};
const renderedDetail = runInNewContext(displayTextSource + ';' + primaryLabelSource + ';' + primarySummarySource + ';' + pathSource + ';' + codeRefSource + ';' + modulesSource + ';' + relationRoleSource + ';' + stepsSource + ';' + evidenceSource + ';' + relationEvidenceSource + ';' + explorerSource + ';' + detailSource + ';architectureImplementationDetailHtmlV2("root")', {
  payload: detailPayload,
  lang: 'en',
  architectureKindLabel: kind => kind,
  architectureRelationLabel: type => type,
  esc: value => String(value)
});
assert.match(renderedDetail, /Rerank candidates/);
assert.match(renderedDetail, /Score semantics/);
assert.match(renderedDetail, /Keep Top-K/);
assert.match(renderedDetail, /STEP 01/);
assert.match(renderedDetail, /STEP 02/);
assert.match(renderedDetail, /src\/core\/root\.ts#L10-L22/);
assert.match(renderedDetail, /src\/core\/child\.ts#L30-L48/);
assert.match(renderedDetail, /weight = 0.68/);
assert.match(renderedDetail, /top_k = 12/);
assert.doesNotMatch(renderedDetail, /Architecture evolution history|Full evolution summary|l2:timeline:r2/);
const parallelPayload = structuredClone(detailPayload);
parallelPayload.architecture.nodes.push({ id: 'lexical', kind: 'mechanism', label: '计算词法分 / Score lexical',
  summary: '计算词法相关性。 Score lexical relevance.', parent_id: 'root', order: 1, evidence_refs: ['code:litsan:abc123:src/core/child.ts#L30-L48'] });
parallelPayload.architecture.edges.push({ from: 'lexical', to: 'topk', type: 'flows_to', evidence_refs: ['code:litsan:abc123:src/core/root.ts#L18-L18'] });
const parallelDetail = runInNewContext(displayTextSource + ';' + primaryLabelSource + ';' + primarySummarySource + ';' + pathSource + ';' + codeRefSource + ';' + modulesSource + ';' + relationRoleSource + ';' + stepsSource + ';' + evidenceSource + ';' + relationEvidenceSource + ';' + explorerSource + ';' + detailSource + ';architectureImplementationDetailHtmlV2("root")', {
  payload: parallelPayload, lang: 'en', architectureKindLabel: kind => kind, architectureRelationLabel: type => type, esc: value => String(value)
});
assert.match(parallelDetail, /Implementation components/);
assert.match(parallelDetail, /<span>Components<\/span>/);
assert.doesNotMatch(parallelDetail, /<span>Steps<\/span>/);
assert.match(parallelDetail, /Recorded flows:/);
assert.match(parallelDetail, /Score semantics → Keep Top-K/);
assert.match(parallelDetail, /Score lexical → Keep Top-K/);
assert.doesNotMatch(parallelDetail, /STEP 01|STEP 02/);
assert.match(parallelDetail, /architecture-pipeline is-unordered/);
const parallelZh = runInNewContext(displayTextSource + ';' + primaryLabelSource + ';' + primarySummarySource + ';' + pathSource + ';' + codeRefSource + ';' + modulesSource + ';' + relationRoleSource + ';' + stepsSource + ';' + evidenceSource + ';' + relationEvidenceSource + ';' + explorerSource + ';' + detailSource + ';architectureImplementationDetailHtmlV2("root")', {
  payload: parallelPayload, lang: 'zh', architectureKindLabel: kind => kind, architectureRelationLabel: type => type, esc: value => String(value)
});
assert.match(parallelZh, /<span>实现组件<\/span>/);
assert.match(parallelZh, /计算语义分 → 保留 Top-K/);
assert.match(parallelZh, /计算词法分 → 保留 Top-K/);
assert.match(parallelZh, /候选进入后计算并融合相关性/);
assert.doesNotMatch(parallelZh, /Fuse candidate relevance/);
const bilingualFactPayload = structuredClone(detailPayload);
bilingualFactPayload.architecture.nodes[1].facts[0].key = 'Weight description / 权重说明';
for (const lang of ['en', 'zh']) {
  const output = runInNewContext(displayTextSource + ';' + primaryLabelSource + ';' + primarySummarySource + ';' + pathSource + ';' + codeRefSource + ';' + modulesSource + ';' + relationRoleSource + ';' + stepsSource + ';' + evidenceSource + ';' + relationEvidenceSource + ';' + explorerSource + ';' + detailSource + ';architectureImplementationDetailHtmlV2("root")', {
    payload: bilingualFactPayload, lang, architectureKindLabel: kind => kind, architectureRelationLabel: type => type, esc: value => String(value)
  });
  assert.match(output, lang === 'zh' ? /权重说明/ : /Weight description/);
  assert.doesNotMatch(output, lang === 'zh' ? /Weight description/ : /权重说明/);
  assert.match(output, /src\/core\/child\.ts#L30-L48/);
}
const unorderedPayload = structuredClone(detailPayload);
unorderedPayload.architecture.edges = [];
const unorderedDetail = runInNewContext(displayTextSource + ';' + primaryLabelSource + ';' + primarySummarySource + ';' + pathSource + ';' + codeRefSource + ';' + modulesSource + ';' + relationRoleSource + ';' + stepsSource + ';' + evidenceSource + ';' + relationEvidenceSource + ';' + explorerSource + ';' + detailSource + ';architectureImplementationDetailHtmlV2("root")', {
  payload: unorderedPayload, lang: 'en', architectureKindLabel: kind => kind, architectureRelationLabel: type => type, esc: value => String(value)
});
assert.match(unorderedDetail, /No execution order is recorded/);
assert.doesNotMatch(unorderedDetail, /STEP 01/);
console.log("web-ui-visualization-flow-e2e: ok");

assert.match(html, /data-map-queue-status/);
assert.match(html, /No maintenance tasks waiting \/ 暂无待处理维护任务/);
assert.match(html, /Copy prompt for an agent \/ 复制给代理的提示/);
assert.match(html, /navigator.clipboard/);
assert.match(html, /document.execCommand\('copy'\)/);
assert.match(html, /aria-live="polite" data-map-copy-status/);
assert.match(html, /Copied \/ 已复制/);

const detailsSource = html.match(/^function architectureNodeDetails[^\n]+/m)[0];
for (const lang of ['en', 'zh']) for (const svg of [false, true]) {
  const node = { facets: { layer: 'core' } };
  const render = () => runInNewContext(detailsSource + ';architectureNodeDetails(node,svg)', { lang, node, svg, esc: value => value, flowClip: value => value });
  assert.match(render(), /is-unverified/);
  assert.match(render(), lang === 'zh' ? /未验证/ : /unverified/);
  assert.match(render(), svg ? /<title>/ : /title=/);
  node.facets.layer_evidence_refs = ['architecture-doc:p:hash:a.md#layer'];
  assert.doesNotMatch(render(), /is-unverified|unverified|未验证/);
}
assert.match(html, /architecture-layer-badge\.is-unverified\{color:var\(--muted\)\}/);
