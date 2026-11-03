// Offline acceptance for dev-project-map-demo.mjs --check. No dependencies are
// installed: use a local Playwright package and Chromium already on this host.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { renderConsole } from "../dist/web-ui.js";
import { projectMemoryVisualization } from "../dist/archify/memory-visualization.js";

export async function checkProjectMapDemo(input) {
  const playwright = await import(process.env.MEMHUB_PLAYWRIGHT_MODULE || "playwright");
  const { chromium } = playwright.default ?? playwright;
  const model = structuredClone(input), map = model.architecture?.map;
  if (map) {
    map.nodes.find(node => node.id === 'bounded-admission').label = 'Token Knowledge Plane';
    map.edges.push({ from: "normalize", to: "decode", type: "depends_on", confidence: 0.9, evidence_refs: ["l1:demo"] });
  }
  const visual = projectMemoryVisualization(model), account = { account_id: "demo", username: "demo", role: "user" };
  visual.maintenance_status = { pending: 2, leased: 1, requested: 2, by_kind: { arch_link: 2, arch_review: 1 },
    oldest_pending_at: "2026-10-20T00:00:00Z", last_accepted_at: "2026-10-26T00:00:00Z" };
  const expectedPrompt = 'Please process my pending LITSAN maintenance tasks for project alpha: call memhub_card action=next with project=alpha and client_profile {execution:"delegate"}, answer strictly from the card\'s input and answer_schema, submit with the lease token, and repeat until no card is returned or you have done 10. Report how many were accepted.' + '\n' +
    '请处理我在项目 alpha 中待处理的 LITSAN 维护任务：调用 memhub_card action=next，设置 project=alpha 和 client_profile {execution:"delegate"}，严格依据卡片的 input 和 answer_schema 作答，携带 lease token 提交，并重复直到不再返回卡片或已处理 10 张。报告被接受的任务数量。';
  const name = !map ? "no-map" : !model.l2.length ? "map-only" : "gaps";
  const directory = resolve(fileURLToPath(new URL("../.tmp-tests/project-map-browser/", import.meta.url)), name);
  await mkdir(directory, { recursive: true });
  const html = renderConsole({ account, accounts: [account], adminView: false, localControl: true, selectedAccountId: "demo",
    projects: [{ projectId: "alpha", name: "Alpha · Project Map demo", aliases: [], todos: model.todos, state: "active" }] });
  // Mock only the API transport; all production rendering and interactions run.
  const bootstrap = `<script>window.__demoPayload=${JSON.stringify(visual).replaceAll("<", "\\u003c")};window.__demoActions=[];window.__demoFetches=0;window.fetch=async(url,options)=>{window.__demoFetches++;if(options?.method==='POST'){const body=JSON.parse(options.body);window.__demoActions.push(body);if(body.action==='map-link-unmapped')return {ok:true,json:async()=>({ok:true,open_arch_link_count:3})};const artifact=window.__demoPayload.architecture.node_flags??={version:1,flags:{}};const flags=artifact.flags[body.node_id]??=[];if(body.action==='map-flag-node')flags.push({id:'demo-'+flags.length,reason:body.reason,note:body.note,created_at:'2026-10-27T00:00:00Z',by:'demo'});if(body.action==='map-clear-flag')flags.find(flag=>flag.id===body.flag_id).cleared_at='2026-10-27T00:01:00Z';return {ok:true,json:async()=>({ok:true,node_flags:artifact})}}return {ok:true,json:async()=>window.__demoPayload}};</script>`;
  const file = resolve(directory, "demo.html");
  const logo = await readFile(new URL("../web-assets/logo-mark.png", import.meta.url));
  await writeFile(file, html.replace("<head>", "<head>" + bootstrap)
    .replaceAll('/memhub/assets/logo-mark.png', `data:image/png;base64,${logo.toString('base64')}`));
  const browser = await chromium.launch({ ...(process.env.MEMHUB_CHROMIUM ? { executablePath: process.env.MEMHUB_CHROMIUM } : { channel: "chrome" }), headless: true,
    args: ["--no-sandbox", "--disable-background-networking", "--disable-component-update", "--disable-sync", "--no-proxy-server",
      "--host-resolver-rules=MAP * ~NOTFOUND", "--metrics-recording-only"] });
  const metrics = [], errors = [];
  let assertions = 0;
  const check = (value, message) => { assert.ok(value, message); assertions++; };
  try {
    for (const width of [800, 375, 1440, 1024, 768, 390]) {
      const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: "reduce" });
      await context.route(/^https?:/, route => route.abort());
      await context.addInitScript(() => { localStorage.memhubLang = 'zh'; localStorage.memhubTheme = 'light'; });
      await context.addInitScript(({ fallback }) => {
        window.__copiedText = null;
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => {
          if (fallback) throw Error('Clipboard denied');
          window.__copiedText = text;
        } } });
        document.execCommand = command => {
          if (command !== 'copy') return false;
          window.__copiedText = document.querySelector('textarea[aria-label="Agent prompt / 代理提示"]').value;
          return true;
        };
      }, { fallback: width === 375 });
      const page = await context.newPage();
      page.on("pageerror", error => errors.push(error.message));
      await page.goto(pathToFileURL(file).href + "?view=visualization&project=alpha");
      const panel = page.locator('.architecture-map-panel');
      await panel.waitFor();
      const queueLine = page.locator('[data-map-queue-status]'), copy = page.locator('[data-map-copy-prompt]');
      check((await queueLine.textContent()).includes('3 tasks waiting (2 you requested) · last done'), 'queue counts in English');
      check((await queueLine.textContent()).includes('等待中任务 3 个（你请求的 2 个）· 最近完成'), 'queue counts in Chinese');
      check((await copy.boundingBox()).height >= 44 && (await copy.boundingBox()).width >= 44, 'copy target at least 44px');
      const fetches = await page.evaluate(() => window.__demoFetches);
      await copy.focus();
      await page.keyboard.press('Enter');
      await page.locator('[data-map-copy-status]').filter({ hasText: 'Copied / 已复制' }).waitFor();
      check(await page.evaluate(() => window.__copiedText) === expectedPrompt, 'exact bilingual prompt with project slug');
      check(await copy.evaluate(el => document.activeElement === el), 'copy retains keyboard focus');
      check(await page.evaluate(() => window.__demoFetches) === fetches, 'copy makes no API call');
      check(await page.locator('.project-map-quality,.quality-gap,[data-quality-gap]').count() === 0, 'score card and gaps absent');
      if (map) {
        check(await panel.locator('.architecture-graph').count() === 1, 'architecture graph renders');
        check(await panel.locator('.architecture-graph-node').count() > 0, 'architecture graph nodes render');
        if (width === 800) {
          check(await panel.locator('.architecture-graph-node[data-architecture-node="bounded-admission"]').isVisible(), 'mechanism shown by default');
          // Bound the observer regression so a recursive redraw fails instead of hanging Chrome.
          await page.evaluate(() => {
            window.__searchUpdates = 0;
            window.__originalGraphUpdate = updateArchitectureGraph;
            updateArchitectureGraph = () => {
              if (++window.__searchUpdates > 25) { architectureEnhancer.disconnect(); return; }
              return window.__originalGraphUpdate();
            };
          });
          await panel.locator('[data-architecture-level]').selectOption('3');
          await page.locator('#filter').fill('TKP');
          await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 50)));
          check(await page.evaluate(() => window.__searchUpdates < 25), 'search redraw settles without observer recursion');
          check(await panel.locator('.architecture-graph-node[data-architecture-node="bounded-admission"]:not(.is-filtered)').isVisible(), 'TKP search reveals mechanism below selected depth');
          check(await panel.locator('.architecture-graph-node[data-architecture-node="decode"]:not(.is-filtered)').isVisible(), 'search retains ancestor context');
          await page.locator('#filter').fill('');
          await page.evaluate(() => { updateArchitectureGraph = window.__originalGraphUpdate; });
        }
      } else check(await panel.locator('.architecture-empty').count() === 1, 'no-map empty state renders');
      if (model.l2.length) check(await page.locator('.project-flow-canvas').count() === 1, 'timeline flow renders');
      const unmapped = visual.state.events.filter(event => !event.architecture_refs.length).length;
      check(await page.locator('[data-map-link-unmapped]').count() === (unmapped ? 1 : 0), 'link action only for unmapped events');
      if (unmapped) {
        const link = page.locator('[data-map-link-unmapped]');
        check((await link.boundingBox()).height >= 44, 'link target at least 44px');
        await link.focus();
        await page.keyboard.press('Enter');
        await page.locator('[data-map-action-status]').filter({ hasText: '已排队 3' }).waitFor();
        check((await page.locator('[data-map-action-status]').textContent()).includes('下一个连接的代理会处理'), 'queue success message');
      }
      if (map) {
        check(await panel.locator('.architecture-relation.strong-coupling').count() >= 2, 'strong coupling highlighted');

        if ((width === 375 || width === 800) && map.facet_vocab?.layer) {
          for (const theme of ['light', 'dark']) {
            await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
            await panel.locator('[data-architecture-view="graph"]').click();
            const group = panel.locator('[data-architecture-group]');
            check(await group.isVisible(), 'layer group selector visible');
            check((await group.boundingBox()).height >= 44, 'group target at least 44px');
            const positions = () => panel.locator('.architecture-graph-node').evaluateAll(nodes => nodes.map(n => n.getAttribute('transform')));
            const functional = await positions();
            await group.selectOption('layer');
            check(JSON.stringify(await positions()) !== JSON.stringify(functional), 'grouping reorders node positions');
            check(await panel.locator('.architecture-layer-groups text').count() > 0, 'layer separators labelled');
            check(await page.evaluate(() => JSON.parse(localStorage.memhub_map_v2_alpha).groupBy) === 'layer', 'group choice persisted');
            const order = await page.evaluate(() => {
              const graph = payload.architecture.graph;
              return graph.levels.every((_,level) => {
                const vocab=payload.architecture.facet_vocab.layer;
                const row=graph.nodes.filter(n=>n.level===level).sort((a,b)=>a.x-b.x);
                return row.every((n,i)=>!i||vocab.indexOf(row[i-1].facets?.layer)<=vocab.indexOf(n.facets?.layer));
              });
            });
            check(order, 'layer order follows vocabulary in every band');
            await page.reload();await panel.waitFor();
            await page.waitForFunction(() => document.querySelector('[data-architecture-group]')?.value === 'layer');
            check(await group.inputValue() === 'layer', 'layer choice restored after reload');
            await group.selectOption('function');
            check(JSON.stringify(await positions()) === JSON.stringify(functional), 'function positions restored');
            check(await panel.locator('.architecture-layer-badge:not([hidden])').count() > 0, 'layer badges visible');
            check(await panel.locator('.architecture-fact-chip:not([hidden])').count() >= 3, 'two fact chips and overflow render');
            const decode = panel.locator('.architecture-graph-node[data-architecture-node="decode"]');
            check((await decode.textContent()).includes('+1'), 'fact overflow count');
            await decode.focus();await page.keyboard.press('Shift+Enter');
            const facts=page.locator('.architecture-drawer-facts');
            check((await facts.textContent()).includes('top-k = 8 items'), 'drawer full fact values');
            check((await facts.textContent()).includes('l1:demo'), 'drawer fact citation');
            check((await facts.textContent()).includes('90%'), 'drawer fact confidence');
            await page.keyboard.press('Escape');
            await panel.locator('[data-map-display-toggle]').click();
            await panel.locator('[data-display-toggle="facts"]').uncheck();
            await panel.locator('[data-display-toggle="layer_badges"]').uncheck();
            check(await panel.locator('.architecture-fact-chip:not([hidden])').count() === 0, 'fact toggle hides chips');
            check(await panel.locator('.architecture-layer-badge:not([hidden])').count() === 0, 'layer toggle hides badges');
            await panel.locator('[data-display-toggle="facts"]').check();
            await panel.locator('[data-display-toggle="layer_badges"]').check();
            await page.keyboard.press('Escape');
            await page.screenshot({ path: resolve(directory, `${width}-${theme}-facts.png`) });
          }
          await page.evaluate(() => document.documentElement.dataset.theme = 'light');
        }
        if (width === 800) {
          await page.locator('[data-architecture-view="graph"]').click();
          const rootNode = panel.locator('.architecture-graph-node[data-architecture-node="alpha"]');
          await rootNode.focus();
          await page.keyboard.press('ArrowDown');
          const childId = await page.evaluate(() => document.activeElement?.getAttribute('data-architecture-node'));
          check(childId === 'capture' || childId === 'dashboard', 'ArrowDown moves focus to child node');
          await page.keyboard.press('ArrowRight');
          const siblingId = await page.evaluate(() => document.activeElement?.getAttribute('data-architecture-node'));
          check(siblingId && siblingId !== childId, 'ArrowRight moves focus to sibling node');

          await page.keyboard.press('Enter');
          check(await page.evaluate(id => document.querySelector('.architecture-graph-node[data-architecture-node="'+id+'"]')?.getAttribute('aria-pressed') === 'true', siblingId), 'Enter pins node');
          check(!await page.locator('#drawer:not(.hidden)').isVisible(), 'pinning leaves drawer closed');
          await page.keyboard.press('Shift+Enter');
          check(await page.locator('#drawer:not(.hidden)').isVisible(), 'Shift+Enter opens node drawer');
          await page.keyboard.press('Escape');
          check(!await page.locator('#drawer:not(.hidden)').isVisible(), 'Escape closes node drawer');
          check(await page.evaluate(id => document.activeElement?.getAttribute('data-architecture-node') === id, siblingId), 'focus returns to node on Escape');

          await page.keyboard.press('?');
          const shortcutsDialog = panel.locator('#architecture-shortcuts-dialog');
          check(await shortcutsDialog.isVisible(), '? opens shortcuts dialog');
          await page.keyboard.press('Escape');
          check(!await shortcutsDialog.isVisible(), 'Escape closes shortcuts dialog');
          check(await page.evaluate(id => document.activeElement?.getAttribute('data-architecture-node') === id, siblingId), 'focus returns after closing shortcuts');

          const fitBtn = panel.locator('[data-architecture-fit]');
          const zoomLabel = panel.locator('[data-architecture-zoom-level]');
          const initialZoom = await zoomLabel.textContent();
          await page.keyboard.press('+');
          const zoomedIn = await zoomLabel.textContent();
          check(zoomedIn !== initialZoom, '+ key changes zoom level');
          check(await fitBtn.getAttribute('aria-pressed') === 'false', '+ un-fits graph');
          await page.keyboard.press('-');
          const zoomedOut = await zoomLabel.textContent();
          check(zoomedOut !== zoomedIn, '- key changes zoom level');
          await page.keyboard.press('0');
          check(await fitBtn.getAttribute('aria-pressed') === 'true', '0 key fits to width');

          const frame = panel.locator('.architecture-graph-frame');
          const frameBox = await frame.boundingBox();
          if (frameBox) {
            for (let i = 0; i < 4; i++) await page.locator('[data-architecture-zoom-in]').click();
            await frame.evaluate(el => { el.scrollLeft = 60; });
            const scrollBefore = await frame.evaluate(el => el.scrollLeft);
            await page.mouse.move(frameBox.x + 60, frameBox.y + 40);
            await page.mouse.down();
            await page.mouse.move(frameBox.x + 160, frameBox.y + 40, { steps: 5 });
            await page.mouse.up();
            const scrollAfter = await frame.evaluate(el => el.scrollLeft);
            check(scrollAfter !== scrollBefore, 'drag horizontally pans frame');
            check(!await page.locator('#drawer:not(.hidden)').isVisible(), 'drag does not trigger node click');
          }

          const displayToggle = panel.locator('[data-map-display-toggle]');
          await displayToggle.click();
          const displayPanel = panel.locator('#map-display-panel');
          check(await displayPanel.isVisible(), 'display panel opens');
          const flowsToggle = panel.locator('[data-display-toggle="flows_to"]');
          check(await flowsToggle.isChecked(), 'flows_to toggle checked by default');
          await flowsToggle.uncheck();
          const hiddenFlows = await panel.locator('.architecture-relation.flows_to[hidden]').count();
          const totalFlows = await panel.locator('.architecture-relation.flows_to').count();
          check(hiddenFlows === totalFlows && totalFlows > 0, 'unchecking flows_to hides all flows_to edges');
          check(await panel.locator('.architecture-graph-node:not([hidden])').count() > 0, 'nodes remain visible when edges hidden');

          const couplingToggle = panel.locator('[data-display-toggle="strong_coupling"]');
          await couplingToggle.uncheck();
          check(await panel.locator('.architecture-relation.strong-coupling').count() === 0, 'strong coupling toggle disables thick highlight');
          await couplingToggle.check();
          check(await panel.locator('.architecture-relation.strong-coupling').count() >= 2, 'strong coupling toggle re-enables thick highlight');

          await flowsToggle.check();
          await page.keyboard.press('Escape');
          check(!await displayPanel.isVisible(), 'Escape closes display panel');

          const savedState = await page.evaluate(() => JSON.parse(localStorage.getItem('memhub_map_v2_alpha') || 'null'));
          check(savedState !== null && typeof savedState.zoom === 'number', 'graph state persisted to localStorage');
          await page.reload();
          await panel.waitFor();
          check(await panel.locator('.architecture-graph').count() === 1, 'graph rendered after reload');
        }

        if (width === 375) {
          await page.locator('[data-architecture-view="graph"]').click();
          const displayToggle = panel.locator('[data-map-display-toggle]');
          await displayToggle.click();
          const displayPanel = panel.locator('#map-display-panel');
          check(await displayPanel.isVisible(), 'mobile display panel opens');
          const panelBox = await displayPanel.boundingBox();
          check(panelBox && panelBox.y + panelBox.height >= 950, 'display panel is a bottom sheet on 375px viewport');
          await page.keyboard.press('Escape');
          check(!await displayPanel.isVisible(), 'Escape closes mobile display panel');
        }

        for (const view of ['list', 'graph']) {
          await page.locator('[data-architecture-view="'+view+'"]').click();
          const node = page.locator(view === 'graph' ? '.architecture-graph-node:not([hidden])' : '.architecture-node-card').first();
          const nodeId = await node.getAttribute('data-architecture-node');
          await node.focus();
          await page.keyboard.press('Shift+Enter');
          const open = page.locator('[data-map-flag-open]');
          check(!await page.locator('#map-flag-form').isVisible(), 'flag form initially hidden');
          await open.click();
          check(await page.locator('#map-flag-form select').evaluate(el => document.activeElement === el), 'reason focused');
          await page.locator('#map-flag-form select').selectOption('unclear');
          await page.locator('#map-flag-form textarea').fill('Needs evidence <test>');
          check(await page.locator('#map-flag-form textarea').getAttribute('maxlength') === '300', 'note bounded');
          await page.locator('#map-flag-form button[type="submit"]').click();
          await page.locator('[data-map-flag-status]').filter({ hasText: '标记已保存' }).waitFor();
          check(await open.evaluate(el => document.activeElement === el), 'focus returns after save');
          check(!await page.locator('#map-flag-form').isVisible(), 'flag form hidden after save');
          check(await page.locator('.map-flag-badge').count() >= 2, 'graph and list flag badges');
          await page.screenshot({ path: resolve(directory, `${width}-flag-${view}.png`) });
          await page.keyboard.press('Escape');
          check(await node.evaluate(el => document.activeElement === el), 'drawer returns focus to node');
          await node.press('Shift+Enter');
          await page.locator('[data-map-clear-flag]').click();
          await page.locator('[data-map-flag-status]').filter({ hasText: '标记已清除' }).waitFor();
          check(await page.locator('.map-flag-badge').count() === 0, 'clearing removes badges');
          await page.locator('[data-map-flag-open]').click();
          await page.locator('[data-map-flag-cancel]').click();
          check(await page.locator('[data-map-flag-open]').evaluate(el => document.activeElement === el), 'cancel returns focus');
          check(!await page.locator('#map-flag-form').isVisible(), 'cancel hides form');
          await page.keyboard.press('Escape');
          check(await page.evaluate(id => window.__demoActions.some(a => a.action === 'map-flag-node' && a.node_id === id), nodeId), 'flag action sent');
        }
      }
      const measure = await page.evaluate(() => ({ width: innerWidth, overflow: document.documentElement.scrollWidth > innerWidth }));
      metrics.push(measure);
      check(!measure.overflow, `no page overflow at ${width}px`);
      await page.screenshot({ path: resolve(directory, `${width}.png`) });
      await page.locator('#filter').fill('Capture');
      check(await page.locator('.project-map-quality').count() === 0, 'filter leaves score card absent');
      await page.locator('#filter').fill('');
      await page.locator('#lang').click();
      check(await page.locator('html').getAttribute('lang') === 'en', 'English labels');
      await page.locator('#theme-toggle').click();
      check(await page.locator('html').getAttribute('data-theme') === 'dark', 'dark theme');
      check(await queueLine.isVisible() && await copy.isVisible(), 'queue visible in dark theme');
      await copy.click();
      check(await page.evaluate(() => window.__copiedText) === expectedPrompt, 'dark theme bilingual copy');
      if (map) {
        await page.locator('[data-architecture-view="list"]').click();
        await page.locator('.architecture-node-card').first().dblclick();
        await page.locator('[data-map-flag-open]').click();
        check((await page.locator('#map-flag-form option').allTextContents()).join(',') === 'Wrong,Unclear,Outdated,Missing part', 'English reasons');
        await page.locator('#map-flag-form textarea').fill('Dark theme flag');
        await page.locator('#map-flag-form button[type="submit"]').click();
        await page.locator('[data-map-flag-status]').filter({ hasText: 'Flag saved' }).waitFor();
        await page.screenshot({ path: resolve(directory, `${width}-dark-flag.png`) });
        await page.locator('[data-map-clear-flag]').click();
        await page.locator('[data-map-flag-status]').filter({ hasText: 'Flag cleared' }).waitFor();
        await page.keyboard.press('Escape');
        if (width === 800 || width === 375) {
          await page.locator('[data-architecture-view="graph"]').click();
          await page.screenshot({ path: resolve(directory, `${width}-dark.png`) });
        }
      }
      await page.evaluate(() => { window.__demoPayload.maintenance_status.pending = 0; window.__demoPayload.maintenance_status.leased = 0; renderRows(); });
      check(await queueLine.textContent() === 'No maintenance tasks waiting / 暂无待处理维护任务', 'empty queue message');
      check(await copy.count() === 0, 'empty queue hides copy');
      await page.evaluate(() => { delete window.__demoPayload.maintenance_status; renderRows(); });
      check(await queueLine.count() === 0, 'absent queue hides status');
      await page.evaluate(() => { window.__demoPayload.maintenance_status = { pending: 2, leased: 1, requested: 2, last_accepted_at: null }; renderRows(); });
      check((await queueLine.textContent()).includes('last done never'), 'missing acceptance timestamp');
      await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined }); });
      await copy.click();
      await page.locator('[data-map-copy-status]').filter({ hasText: 'Copied / 已复制' }).waitFor();
      check(await page.evaluate(() => window.__copiedText) === expectedPrompt, 'fallback when clipboard API is absent');
      await page.evaluate(() => { document.execCommand = () => false; });
      await copy.click();
      await page.locator('[data-map-copy-status]').filter({ hasText: 'Copy failed; try again / 复制失败，请重试' }).waitFor();
      check(await page.locator('textarea[aria-label="Agent prompt / 代理提示"]').count() === 0, 'fallback cleans up on failure');
      check(await copy.evaluate(el => document.activeElement === el), 'failed copy restores focus');
      check(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches), 'reduced motion');
      await context.close();
    }
    check(errors.length === 0, 'no browser runtime errors');
    await writeFile(resolve(directory, 'deterministic-metrics.json'), JSON.stringify({ metrics, errors, assertions }, null, 2));
    console.log(`browser_viewports=${metrics.length} assertions=${assertions} failures=0`);
  } finally {
    await browser.close();
  }
}
