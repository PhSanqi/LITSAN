import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile, mkdir, mkdtemp, access, rm, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { litsanEnv, defaultLitsanHome, memoryConfigKey, legacyCliNotice, integrationReadUrl } from "../vendor/memory-core/src/utils/litsan-compat.js";
import { sanitizeLitsanProtocolText, LITSAN_MEMORY_CONTEXT_TAG, isLitsanRecallToolName } from "../vendor/memory-core/src/utils/litsan-context-tags.js";
import { loadCliMemoryConfig } from "../vendor/memory-core/src/cli/config.js";
import { loadLitsanConfig } from "../vendor/memory-core/src/config/index.js";
import { mutateMemoryConfig } from "../vendor/memory-core/src/config/writer.js";
import { createMemoryHttpServer, closeMemoryHttpServer } from "../vendor/memory-core/src/server/http.js";
import { isViewerApiRequest, assertLocalViewerRequest } from "../vendor/memory-core/src/server/viewer-api.js";
import { replaceLitsanSkillDirectory, removeLitsanSkillDirectory } from "../vendor/memory-core/src/agent-source/integration/skill-directory.js";
import { installLitsanMemorySkillForAgent } from "../vendor/memory-core/src/cli/skill-writer/index.js";
import { migrateOwnedIntegrationFiles } from "../vendor/memory-core/src/agent-source/integration/legacy-files.js";
import { renderLitsanResumeHookScript } from "../vendor/memory-core/src/agent-source/integration/templates/litsan-resume-hook.js";
import { renderLitsanOpencodePlugin } from "../vendor/memory-core/src/agent-source/integration/templates/litsan-opencode-plugin.js";
import { DEEPSEEK_HARNESS_PLUGIN_INDEX } from "../vendor/memory-core/src/agent-source/integration/templates/litsan-deepseek-harness-plugin.js";
import { loadLitsanWorkspaceBridgeRuntimeAsset } from "../vendor/memory-core/src/agent-source/integration/workspace-bridge/runtime-loader.js";
import { createCursorSkillTarget } from "../vendor/memory-core/src/agent-source/integration/cursor/target.js";

await mkdir(resolve('.tmp-c3'), { recursive: true });
const root = await mkdtemp(resolve('.tmp-c3/compat-'));
test.after(async () => { await rm(root, { recursive: true, force: true }); });

test('vendor env: new wins, legacy fallback, empty values and dynamic reads', () => {
  assert.equal(litsanEnv('MEMMY_MEMORY_URL', { LITSAN_MEMORY_URL: 'new', MEMMY_MEMORY_URL: 'old' }), 'new');
  assert.equal(litsanEnv('LITSAN_MEMORY_URL', { MEMMY_MEMORY_URL: 'old' }), 'old');
  assert.equal(litsanEnv('LITSAN_MEMORY_URL', { LITSAN_MEMORY_URL: '', MEMMY_MEMORY_URL: 'old' }), '');
  assert.equal(litsanEnv('LITSAN_MEMORY_URL', {}), undefined);
  assert.equal(litsanEnv('OTHER', { OTHER: '' }), '');
});

test('vendor home: prefer existing .litsan, fall back without creating it', async () => {
  const home = join(root, 'home'); await mkdir(home);
  assert.equal(defaultLitsanHome(home), join(home, '.memmy'));
  await assert.rejects(access(join(home, '.litsan')));
  await mkdir(join(home, '.litsan'));
  assert.equal(defaultLitsanHome(home), join(home, '.litsan'));
});

test('vendor config: both readers prefer new key; writers retain existing key', async () => {
  const path = join(root, 'config.yaml');
  for (const key of ['memmyMemory', 'litsanMemory']) {
    await writeFile(path, JSON.stringify({ [key]: { userId: 'fixture', storage: { endpoint: 'http://127.0.0.1:12345' } } }));
    assert.equal(loadCliMemoryConfig(path).config.endpoint, 'http://127.0.0.1:12345');
    assert.equal(loadLitsanConfig(path).config.storage.endpoint, 'http://127.0.0.1:12345');
    await mutateMemoryConfig(path, (config) => { config[memoryConfigKey(config)].userId = 'updated'; });
    const text = await readFile(path, 'utf8'); assert.match(text, new RegExp(`^${key}:`));
    assert.ok(!text.includes(key === 'memmyMemory' ? 'litsanMemory:' : 'memmyMemory:'));
  }
  await writeFile(path, JSON.stringify({ litsanMemory: { userId: 'new' }, memmyMemory: { userId: 'old' } }));
  assert.equal(loadCliMemoryConfig(path).config.userId, 'new');
  assert.equal(loadLitsanConfig(path).config.userId, 'new');
});

test('vendor tags: new output, both histories sanitized including unclosed tails', () => {
  assert.equal(LITSAN_MEMORY_CONTEXT_TAG, 'litsan_memory_context');
  for (const tag of ['memmy_memory_context', 'litsan_memory_context']) {
    assert.equal(sanitizeLitsanProtocolText(`<${tag}>secret</${tag}><current_user_request>request</current_user_request>`), 'request');
    assert.equal(sanitizeLitsanProtocolText(`request<${tag}>secret`), 'request');
  }
  for (const name of ['memmy_memory_get', 'memmy_memory_search', 'litsan_memory_get', 'litsan_memory_search']) assert.ok(isLitsanRecallToolName(name));
});

test('vendor CLI: aliases route to same entry; notices suppressed for JSON/hook/stdio', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
  for (const alias of ['memmy', 'memmy-memory']) {
    assert.equal(pkg.bin[alias], pkg.bin['litsan-memory']);
    assert.match(legacyCliNotice(`C:\\bin\\${alias}.cmd`, ['health']), /deprecated.*litsan-memory\.\n$/);
    for (const args of [['health', '--json'], ['hook'], ['--stdio'], ['--format=json'], ['mcp']]) assert.equal(legacyCliNotice(alias, args), '');
  }
  assert.equal(pkg.bin['memmy-web'], pkg.bin['litsan-web']);
  assert.match(legacyCliNotice('memmy-web', []), /litsan-web/);
  assert.equal(legacyCliNotice('litsan-memory', []), '');
  const source = await readFile(new URL('../vendor/memory-core/src/cli/index.js', import.meta.url), 'utf8');
  assert.match(source, /if \(notice\) process\.stderr\.write\(notice\)/);
  assert.doesNotMatch(source, /stdout\.write\(notice\)/);
});

test('vendor Core: both header spellings and new precedence without opening sockets', async () => {
  const seen = [];
  const server = createMemoryHttpServer({
    service: { nextWorkerRunAt() {}, getMemory(id, options) { seen.push(options); return { id }; } },
    pluginRuntimeAnalytics: { track() {}, async trackAwait() {} },
    agentSourceExecutor: { startAutomation() {}, async dispose() {} }
  });
  async function request(headers) {
    const req = Readable.from([]); Object.assign(req, { url: '/api/v1/memory/id', method: 'GET', headers });
    const res = new EventEmitter(); res.setHeader = () => {}; res.writeHead = (code) => { res.statusCode = code; };
    await new Promise((done) => { res.end = () => { res.emit('finish'); done(); }; server.emit('request', req, res); });
    assert.equal(res.statusCode, 200);
  }
  try {
    for (const prefix of ['x-memmy-', 'x-litsan-']) {
      await request({ [`${prefix}user-id`]: 'fixture', [`${prefix}project-id`]: 'project', [`${prefix}time-zone`]: 'UTC' });
      assert.equal(seen.at(-1).namespace.userId, 'fixture'); assert.equal(seen.at(-1).namespace.projectId, 'project');
    }
    await request({ 'x-memmy-user-id': 'old', 'x-litsan-user-id': 'new' });
    assert.equal(seen.at(-1).namespace.userId, 'new');
    for (const prefix of ['x-memmy-', 'x-litsan-']) {
      const req = { method: 'PATCH', headers: { [`${prefix}viewer`]: '1', host: 'localhost', 'content-type': 'application/json' }, socket: { remoteAddress: '127.0.0.1' } };
      const url = new URL('http://localhost/api/v1/config');
      assert.ok(isViewerApiRequest(req, url)); assert.doesNotThrow(() => assertLocalViewerRequest(req, url));
    }
    assert.equal(isViewerApiRequest({ method: 'PATCH', headers: { 'x-litsan-viewer': '0', 'x-memmy-viewer': '1' } }, new URL('http://localhost/api/v1/config')), false);
  } finally { await closeMemoryHttpServer(server); }
});

test('vendor skills: replace owned legacy dir and preserve unrelated directory', async () => {
  const agent = join(root, 'agent'); const old = join(agent, 'skills/memmy-memory');
  await mkdir(old, { recursive: true });
  await writeFile(join(old, 'SKILL.md'), '---\nname: memmy-memory\ndescription: Use shared Memmy memory when prior context may be relevant.\n---\n');
  await replaceLitsanSkillDirectory(agent, { content: 'fixture', marker: '<!-- memmy:start v=1 -->' });
  await assert.rejects(access(old)); await access(join(agent, 'skills/litsan-memory/SKILL.md'));
  await mkdir(old); await writeFile(join(old, 'SKILL.md'), '# User-owned skill');
  await replaceLitsanSkillDirectory(agent, { content: 'fixture' });
  await removeLitsanSkillDirectory(agent);
  assert.equal(await readFile(join(old, 'SKILL.md'), 'utf8'), '# User-owned skill');
});

test('vendor CLI skill installer: upgrade removes owned old skill and copies 10 references', async () => {
  const agent = join(root, 'cli-agent'); const old = join(agent, 'skills/memmy-memory');
  await mkdir(old, { recursive: true });
  await writeFile(join(old, 'SKILL.md'), 'name: memmy-memory\ndescription: Use shared Memmy memory');
  await installLitsanMemorySkillForAgent('cursor', { agentRoot: agent });
  await assert.rejects(access(old));
  assert.equal((await readdir(join(agent, 'skills/litsan-memory/references'))).length, 10);
});

test('vendor integration files: owned upgrade and legacy read fallback', async () => {
  const dir = join(root, 'files/hooks'); await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'memmy-memory-config.json'), '{"memmy_config_path":"fixture"}');
  await writeFile(join(dir, 'memmy-resume.md'), '# User-owned unrelated command');
  const next = pathToFileURL(join(dir, 'litsan-memory-config.json'));
  assert.match(integrationReadUrl(next).pathname, /memmy-memory-config/);
  await migrateOwnedIntegrationFiles(join(root, 'files'));
  await access(next); await assert.rejects(access(join(dir, 'memmy-memory-config.json')));
  await access(join(dir, 'memmy-resume.md'));
  assert.equal(integrationReadUrl(next).href, next.href);
});

test('vendor generated hooks and bridge: parse offline; bridge retains config fallback', async () => {
  const scripts = [renderLitsanResumeHookScript({ source: 'cursor', mode: 'cursor' }), renderLitsanOpencodePlugin(), DEEPSEEK_HARNESS_PLUGIN_INDEX, await loadLitsanWorkspaceBridgeRuntimeAsset()];
  for (const [i, source] of scripts.entries()) {
    const path = join(root, `generated-${i}.mjs`); await writeFile(path, source);
    execFileSync(process.execPath, ['--check', path], { stdio: 'pipe' });
    assert.ok(!source.includes('<memmy_memory_context>'));
  }
  const bridge = await import(pathToFileURL(join(root, 'generated-3.mjs')));
  assert.equal(bridge.litsanEnv('MEMMY_CONFIG', { LITSAN_CONFIG: '', MEMMY_CONFIG: 'old' }), '');
  const config = join(root, 'bridge-config.yaml'); await writeFile(config, 'memmyMemory:\n  storage:\n    endpoint: http://127.0.0.1:12345\n');
  await writeFile(join(root, 'memmy-memory-config.json'), JSON.stringify({ memmy_config_path: config }));
  assert.equal((await bridge.readRuntimeConfig(pathToFileURL(join(root, 'litsan-memory-config.json')))).endpoint, 'http://127.0.0.1:12345');
});

test('vendor Cursor upgrade: installs new hook and removes old hook setting', async () => {
  const agent = join(root, 'cursor'); await mkdir(join(agent, 'hooks'), { recursive: true });
  const config = join(root, 'cursor-config.yaml'); await writeFile(config, 'memmyMemory: {}');
  await writeFile(join(agent, 'hooks/memmy-resume-hook.mjs'), '// MEMMY_CONFIG fixture');
  await writeFile(join(agent, 'hooks.json'), JSON.stringify({ version: 1, hooks: { beforeSubmitPrompt: [{ command: 'node memmy-resume-hook.mjs' }] } }));
  // Avoid installation identity writes outside the fixture by supplying a temporary home.
  const previous = process.env.LITSAN_HOME; process.env.LITSAN_HOME = agent;
  try { await createCursorSkillTarget({ rootDirectory: agent, litsanConfigPath: config }).installPlugin('cursor'); }
  finally { if (previous === undefined) delete process.env.LITSAN_HOME; else process.env.LITSAN_HOME = previous; }
  await access(join(agent, 'hooks/litsan-resume-hook.mjs'));
  await assert.rejects(access(join(agent, 'hooks/memmy-resume-hook.mjs')));
  const settings = await readFile(join(agent, 'hooks.json'), 'utf8');
  assert.ok(!settings.includes('node memmy-resume-hook.mjs')); assert.ok(settings.includes('litsan-resume-hook.mjs'));
});

test('vendor Windows launcher: new .cmd uses quoted executable and CLI entry', async () => {
  const { installViewerCli } = await import('../vendor/memory-core/src/server/viewer-cli.js');
  const home = join(root, 'windows-home');
  const result = await installViewerCli({ home, platform: 'win32', executable: 'C:\\Program Files\\nodejs\\node.exe' });
  assert.ok(result.path.endsWith('litsan-memory.cmd'));
  const launcher = await readFile(join(home, '.local/bin/litsan-memory.cmd'), 'utf8');
  assert.ok(launcher.includes('"C:\\Program Files\\nodejs\\node.exe"'));
  assert.ok(launcher.includes('%*'));
  assert.equal(legacyCliNotice('C:\\bin\\memmy-memory.cmd', ['--json']), '');
});

test('vendor plugin upgrades: owned legacy directory moves and generated JS/Python parses', async () => {
  const { createOpenclawSkillTarget } = await import('../vendor/memory-core/src/agent-source/integration/openclaw/target.js');
  const { createHermesSkillTarget } = await import('../vendor/memory-core/src/agent-source/integration/hermes/target.js');
  const config = join(root, 'plugins-config.yaml'); await writeFile(config, 'memmyMemory: {}');
  for (const [name, factory, oldDir, newDir] of [
    ['openclaw', createOpenclawSkillTarget, 'extensions/memmy-memory', 'extensions/litsan-memory'],
    ['hermes', createHermesSkillTarget, 'plugins/memmy-memory', 'plugins/litsan-memory']
  ]) {
    const agent = join(root, name); const workspace = join(agent, 'workspace');
    await mkdir(join(agent, oldDir), { recursive: true }); await mkdir(workspace);
    await writeFile(join(agent, oldDir, 'config.json'), JSON.stringify({ memmy_config_path: config }));
    const previous = process.env.LITSAN_HOME; process.env.LITSAN_HOME = agent;
    try { await factory({ rootDirectory: agent, workspaceDirectory: workspace, litsanConfigPath: config }).installPlugin(name); }
    finally { if (previous === undefined) delete process.env.LITSAN_HOME; else process.env.LITSAN_HOME = previous; }
    await assert.rejects(access(join(agent, oldDir)));
    await access(join(agent, newDir));
    if (name === 'openclaw') execFileSync(process.execPath, ['--check', join(agent, newDir, 'index.mjs')], { stdio: 'pipe' });
    else {
      for (const dir of [newDir, 'plugins/litsan-resume']) {
        execFileSync('python3', ['-c', 'import ast,sys; ast.parse(open(sys.argv[1]).read())', join(agent, dir, '__init__.py')], { stdio: 'pipe' });
      }
    }
  }
});
