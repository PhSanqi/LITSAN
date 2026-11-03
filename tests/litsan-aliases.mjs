import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, win32 } from 'node:path';
import { request as httpRequest } from 'node:http';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { brand, env, inputHeader, publicHosts, warnLegacyCli, legacyToolGuidance } from '../dist/brand.mjs';
import { resolveHome, resolveControlRoot, resolveCoreState, resolveDataPath } from '../dist/state-root.mjs';
import { registerCatalog } from '../dist/shell/mcp/adapter.js';
import { flushToolAliasUsage } from '../dist/tool-aliases.js';
import { toolCatalog } from '../dist/shell/catalog/index.js';
import { inlineJsonResult, assertManagedMemory, knownProjectRecords } from '../dist/shell/mcp/shared.js';
import { createLitsanMcpServerForRuntime } from '../dist/mcp.js';
import { createLitsanRuntime, resolveLocalAccountId } from '../dist/runtime.js';
import { JsonResultTransport } from '../dist/result-transport.js';
import { serveHttp, webRoutePath } from '../dist/gateway-http.js';
import { resolveCloudflareAccessIssuer } from '../dist/cloudflare.js';
import { LocalMemoryRestClient } from '../dist/local-memory-client.js';
import { addAccount } from '../dist/auth.js';
import { inlineCardContext, portableAgentGuidance } from '../dist/shell/recorders/inline-card.js';
import { installSnippet } from '../dist/shell/recorders/install.js';
import { configPath } from '../dist/shell/recorders/config.js';
import { Recorder } from '../dist/shell/recorders/state.js';
import { claudeHook } from '../dist/shell/recorders/claude-hook.js';
import { codexInlineHook } from '../dist/shell/recorders/codex-notify.js';
import { createTestRoot } from './test-isolation.mjs';

const runtimeOptions = root => ({ controlRoot: root, accountId: 'aliases', disableArchitecture: true,
  memoryEndpoint: 'http://127.0.0.1:1', memoryToken: '' });

test('tools/list advertises only litsan names; every legacy alias dispatches and is counted', async () => {
  const root = await createTestRoot('litsan-tools-');
  const runtime = createLitsanRuntime(runtimeOptions(root));
  const server = new McpServer({ name: brand.slug, version: '1' });
  const client = new Client({ name: 'alias-test', version: '1' });
  const context = { stateRoot: root, jsonResult: inlineJsonResult, inlineJsonResult };
  const definitions = toolCatalog({ runtime, context, resultTransport: new JsonResultTransport(root, 'aliases') });
  // Exercise the real catalog's entire name set with harmless business handlers.
  const tools = definitions.map(def => ({ ...def, inputSchema: { type: 'object', properties: { optional: { type: 'string' } } },
    run: async args => ({ kind: 'inline', value: { called: def.name, args } }) }));
  const [ct, st] = InMemoryTransport.createLinkedPair();
  try {
    for (const tool of tools) registerCatalog(server, [tool], context);
    await server.connect(st); await client.connect(ct);
    const listed = (await client.listTools()).tools;
    assert.equal(listed.length, 12);
    assert.ok(listed.every(tool => tool.name.startsWith('litsan_')));
    for (const tool of listed) {
      assert.doesNotMatch(tool.description, /\b(?:memmy|memhub)_\w+/);
      const canonical = await client.callTool({ name: tool.name, arguments: {} });
      assert.equal(canonical.isError, undefined);
      assert.equal((await client.callTool({ name: tool.name, arguments: { optional: undefined } })).isError, undefined);
      for (const prefix of brand.legacyToolPrefixes) {
        const oldName = prefix + tool.name.slice(brand.toolPrefix.length);
        for (let i = 0; i < 2; i++) {
          const aliased = await client.callTool({ name: oldName, arguments: {} });
          assert.deepEqual(aliased, canonical, oldName);
        }
      }
    }
    await flushToolAliasUsage();
    const usage = JSON.parse(await readFile(join(root, 'tool-alias-usage.json'), 'utf8'));
    assert.equal(Object.keys(usage).length, listed.length * 2);
    for (const [name, entry] of Object.entries(usage)) {
      assert.equal(entry.name, name.replace(/^(?:memmy|memhub)_/, 'litsan_'));
      assert.equal(entry.count, 2); assert.ok(Number.isFinite(Date.parse(entry.last_seen)));
    }
    assert.throws(() => registerCatalog(server, [tools[0]], context), /collision/);
  } finally {
    await client.close(); await server.close(); runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('env fallback order preserves empty strings and reaches actual runtime readers', () => {
  const values = { LITSAN_ACCOUNT_ID: 'new', MEMHUB_ACCOUNT_ID: 'hub', MEMMY_ACCOUNT_ID: 'my' };
  assert.equal(env('ACCOUNT_ID', values), 'new');
  values.LITSAN_ACCOUNT_ID = ''; assert.equal(env('ACCOUNT_ID', values), '');
  delete values.LITSAN_ACCOUNT_ID; assert.equal(env('ACCOUNT_ID', values), 'hub');
  delete values.MEMHUB_ACCOUNT_ID; assert.equal(env('ACCOUNT_ID', values), 'my');
  delete values.MEMMY_ACCOUNT_ID; assert.equal(env('ACCOUNT_ID', values), undefined);
  const saved = { ...process.env };
  try {
    process.env.MEMMY_ACCOUNT_ID = 'my'; process.env.MEMHUB_ACCOUNT_ID = 'hub'; process.env.LITSAN_ACCOUNT_ID = 'new';
    assert.equal(resolveLocalAccountId(), 'new');
    assert.equal(resolveLocalAccountId({ accountId: 'flag' }), 'flag');
    process.env.LITSAN_ACCOUNT_ID = ''; assert.equal(resolveLocalAccountId(), 'local');
  } finally { process.env = saved; }
  assert.deepEqual(publicHosts({ LITSAN_PUBLIC_HOSTS: ' LITSAN.example,memhub.example,litsan.example ' }), ['litsan.example', 'memhub.example']);
  assert.deepEqual(publicHosts({ MEMHUB_PUBLIC_HOST: 'memhub.example' }), ['memhub.example']);
});

test('new and legacy input headers resolve equally; vendor Core still receives x-memmy-viewer', async () => {
  for (const prefix of [brand.headerPrefix, ...brand.legacyHeaderPrefixes]) {
    assert.equal(inputHeader({ [`${prefix}viewer`]: '1' }, 'viewer'), '1');
  }
  assert.equal(inputHeader({ 'x-litsan-viewer': '0', 'x-memmy-viewer': '1' }, 'viewer'), '0');
  let headers;
  const client = new LocalMemoryRestClient({ endpoint: 'http://127.0.0.1:1', fetchImpl: async (_url, options) => {
    headers = options.headers; return new Response('{}');
  } });
  await client.viewerGet('/api/v1/l1');
  assert.equal(headers['x-memmy-viewer'], '1'); assert.equal(headers['x-litsan-viewer'], undefined);
});

test('temporary HOME prefers existing .litsan paths without creating or renaming directories', async () => {
  const root = await createTestRoot('litsan-home-');
  const saved = { ...process.env };
  try {
    for (const key of Object.keys(process.env)) if (/^(?:LITSAN|MEMHUB|MEMMY)_/.test(key)) delete process.env[key];
    process.env.HOME = root; process.env.USERPROFILE = root;
    assert.equal(resolveHome(), join(root, '.memmy', 'memhub'));
    assert.equal(configPath(), join(root, '.memmy', 'memhub', 'cli.json'));
    assert.equal(existsSync(join(root, '.litsan')), false);
    await mkdir(join(root, '.memmy', 'memhub', 'recorder'), { recursive: true });
    await writeFile(join(root, '.memmy', 'memhub', 'cli.json'), '{}');
    await mkdir(join(root, '.litsan', 'memhub', 'recorder'), { recursive: true });
    await mkdir(join(root, '.litsan', 'memory-service'), { recursive: true });
    await writeFile(join(root, '.litsan', 'memhub', 'cli.json'), '{}');
    await writeFile(join(root, '.litsan', 'config.yaml'), '{}');
    await writeFile(join(root, '.litsan', 'memory-service', 'memory.sqlite'), 'fixture');
    assert.equal(resolveHome(), join(root, '.litsan', 'memhub'));
    assert.equal(configPath(), join(root, '.litsan', 'memhub', 'cli.json'));
    assert.equal(new Recorder({}).home, join(root, '.litsan', 'memhub', 'recorder'));
    assert.equal(resolveDataPath(['missing']), join(root, '.memmy', 'missing'));
    assert.equal(resolveCoreState().configPath, join(root, '.litsan', 'config.yaml'));
    assert.equal(resolveCoreState().dbPath, join(root, '.litsan', 'memory-service', 'memory.sqlite'));
    process.env.LITSAN_HOME = join(root, 'explicit');
    assert.equal(resolveHome(), join(root, 'explicit'));
    assert.equal(resolveHome({ explicit: root }), root);
    process.env.LITSAN_STATE_ROOT = join(root, 'control');
    assert.equal(resolveControlRoot(), join(root, 'control'));
    assert.equal(resolveHome({ platform: 'win32', env: { USERPROFILE: 'C:\\Users\\test' } }), win32.join('C:\\Users\\test', '.memmy', 'memhub'));
  } finally { process.env = saved; await rm(root, { recursive: true, force: true }); }
});

test('legacy CLI notice writes one stderr line and preserves stdout on human, hook, JSON and stdio paths', () => {
  // Test the exact entry-point notice helper without launching any CLI.
  for (const name of ['memhub', 'memhub-mcp', 'C:\\bin\\memhub.cmd']) {
    let stderr = '';
    warnLegacyCli(name, ['--help'], { write: text => { stderr += text; } });
    assert.match(stderr, /deprecated; use litsan/); assert.equal(stderr.split('\n').length, 2);
  }
  for (const [name, args] of [['memhub', ['hook', 'status']], ['memhub', ['run']], ['memhub', ['status', '--json']],
    ['memhub-mcp', []], ['memhub-mcp', ['--account', 'fixture']], ['memhub', []], ['litsan', ['--help']]]) {
    let stderr = ''; warnLegacyCli(name, args, { write: text => { stderr += text; } }); assert.equal(stderr, '');
  }
});

test('installed legacy CLI aliases preserve stdout and suppress notices for hook and JSON output',
  { skip: process.env.C1_SKIP_CLI_TESTS === '1' ? 'CLI launches prohibited for this work session' : false }, async () => {
    const root = await createTestRoot('litsan-cli-');
    try {
      const entry = new URL('../bin/litsan.mjs', import.meta.url);
      for (const name of ['memhub', 'litsan']) await writeFile(join(root, `${name}.mjs`), `await import(${JSON.stringify(entry.href)});\n`);
      const run = (name, args) => spawnSync(process.execPath, [join(root, `${name}.mjs`), ...args], {
        encoding: 'utf8', env: { ...process.env, HOME: root, USERPROFILE: root }
      });
      for (const args of [['version'], ['version', '--json'], ['hook', 'install', 'claude', '--print']]) {
        const legacy = run('memhub', args), current = run('litsan', args);
        assert.equal(legacy.status, 0); assert.equal(current.status, 0);
        assert.equal(legacy.stdout, current.stdout);
        if (args.length === 1) assert.match(legacy.stderr, /^memhub is deprecated; use litsan\.\n$/);
        else assert.equal(legacy.stderr, '');
        assert.equal(current.stderr, '');
      }
      for (const name of ['memhub-mcp', 'litsan-mcp']) {
        await writeFile(join(root, `${name}.mjs`), `const { main } = await import(${JSON.stringify(new URL('../dist/mcp.js', import.meta.url).href)}); await main();\n`);
      }
      const legacyHelp = run('memhub-mcp', ['--help']), currentHelp = run('litsan-mcp', ['--help']);
      assert.equal(legacyHelp.status, 0); assert.equal(legacyHelp.stdout, currentHelp.stdout);
      assert.match(legacyHelp.stderr, /^memhub-mcp is deprecated; use litsan-mcp\.\n$/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

test('hook snippets and injected guidance use new names with one cached-client clause per message', () => {
  for (const message of [inlineCardContext('l1_fixture'), portableAgentGuidance()]) {
    assert.equal(message.split(legacyToolGuidance).length, 2);
    assert.match(message, /litsan_card/);
  }
  assert.match(inlineCardContext('l1_fixture'), /litsan card --json-args/);
  for (const harness of ['claude', 'codex', 'codex-inline', 'gemini', 'cursor', 'copilot']) {
    const snippet = installSnippet(harness); assert.match(snippet, /litsan/); assert.doesNotMatch(snippet, /memhub hook|systemctl/);
  }
});

test('Claude and Codex recorder messages include the new display name and one alias clause', async () => {
  for (const hook of [claudeHook, codexInlineHook]) {
    let stdout = '', state = { sequence: 0, skipped: {} };
    const recorder = { io: { stdout: { write: text => { stdout += text; } } }, remaining: () => 5000,
      locked: async (_key, action) => action(), load: async () => structuredClone(state),
      save: async (_key, value) => { state = structuredClone(value); }, base: async () => ({ project: 'fixture' }),
      call: async args => ({ event_id: args.event_id }) };
    await hook('UserPromptSubmit', { session_id: 'fixture', turn_id: 'fixture', prompt: 'A user question' }, recorder);
    const message = JSON.parse(stdout).hookSpecificOutput.additionalContext;
    assert.match(message, /^LITSAN recorder active:/);
    assert.match(message, /litsan_turn/);
    assert.equal(message.split(legacyToolGuidance).length, 2);
  }
});

test('issuer discovery resolves each listed hostname to the shared Access application', async () => {
  const root = await createTestRoot('litsan-discovery-');
  const originalFetch = globalThis.fetch, seen = [];
  globalThis.fetch = async input => {
    seen.push(String(input));
    return new Response(JSON.stringify({ issuer: 'https://shared-fixture.cloudflareaccess.com' }));
  };
  try {
    for (const host of ['litsan.example.test', 'memhub.example.test']) {
      assert.equal(await resolveCloudflareAccessIssuer(root, host), 'https://shared-fixture.cloudflareaccess.com');
    }
    assert.deepEqual(seen, ['https://litsan.example.test/.well-known/oauth-authorization-server',
      'https://memhub.example.test/.well-known/oauth-authorization-server']);
  } finally { globalThis.fetch = originalFetch; await rm(root, { recursive: true, force: true }); }
});

function request(port, path, headers = {}, body) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, headers, method: body ? 'POST' : 'GET' }, res => {
      let raw = ''; res.on('data', chunk => { raw += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, raw }));
    });
    req.on('error', reject); req.end(body);
  });
}

test('both base paths and public hosts share routes, JWT pin, per-host metadata and redirects', async () => {
  const root = await createTestRoot('litsan-hosts-');
  const issuer = 'https://c1-fixture.cloudflareaccess.com';
  const hosts = ['litsan.example.test', 'memhub.example.test'];
  const pin = JSON.stringify({ version: 1, issuer, audience: 'c1-aud' });
  await writeFile(join(root, 'cloudflare-access.json'), pin);
  await addAccount(root, 'aliases', 'fixture@example.test');
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk = { ...await exportJWK(publicKey), kid: 'c1', alg: 'RS256', use: 'sig' };
  const jwt = await new SignJWT({ email: 'fixture@example.test' }).setProtectedHeader({ alg: 'RS256', kid: 'c1' })
    .setSubject('c1-user').setAudience('c1-aud').setIssuer(issuer).setExpirationTime('1h').sign(privateKey);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async input => {
    assert.equal(String(input), `${issuer}/cdn-cgi/access/certs`);
    return new Response(JSON.stringify({ keys: [jwk] }), { headers: { 'content-type': 'application/json' } });
  };
  let server;
  try {
    server = await serveHttp(runtimeOptions(root), { stateRoot: root, port: 0, path: '/mcp', basePath: brand.basePath,
      publicHosts: hosts, allowJit: false }, { createServerForRuntime: createLitsanMcpServerForRuntime,
      queueIdleDistillation: async () => {}, unfinishedDistillationJobsForProject: async () => [], assertManagedMemory, knownProjectRecords });
    const port = server.address().port;
    for (const host of hosts) {
      assert.equal(await resolveCloudflareAccessIssuer(root, host), issuer);
      for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
        const metadata = await request(port, path, { host, origin: `https://${host}` });
        assert.equal(metadata.status, 200);
        assert.deepEqual(JSON.parse(metadata.raw), { resource: `https://${host}/mcp`, authorization_servers: [issuer] });
      }
      const redirected = await request(port, '/memhub/docs?a=1', { host, 'x-forwarded-proto': 'http' });
      assert.equal(redirected.status, 308); assert.equal(redirected.headers.location, `https://${host}/memhub/docs?a=1`);
      for (const base of ['/litsan', '/memhub']) {
        const listing = await request(port, `${base}/api/tools`, { host, origin: `https://${host}`, 'cf-access-jwt-assertion': jwt });
        assert.equal(listing.status, 200); assert.ok(JSON.parse(listing.raw).tools.every(tool => tool.name.startsWith('litsan_')));
        for (const name of ['litsan_project_list', 'memmy_project_list', 'memhub_project_list']) {
          const result = await request(port, `${base}/api/tools/${name}`, { host, 'cf-access-jwt-assertion': jwt,
            'content-type': 'application/json', 'x-litsan-viewer': '1' }, '{}');
          assert.equal(result.status, 200); assert.equal(JSON.parse(result.raw).ok, true);
        }
        const unauthenticated = await request(port, `${base}/api/tools`, { host, 'x-memmy-viewer': '1' });
        assert.equal(unauthenticated.status, 401);
        assert.equal((await request(port, `${base}/docs`, { host })).status, 200);
      }
      assert.equal((await request(port, '/mcp', { host })).status, 401);
    }
    assert.equal((await request(port, '/litsan/api/tools', { host: 'evil.example' })).status, 403);
    assert.equal((await request(port, '/litsan/api/tools', { host: hosts[0], origin: 'https://evil.example' })).status, 403);
    assert.equal(await readFile(join(root, 'cloudflare-access.json'), 'utf8'), pin);
    for (const primary of ['/litsan', '/memhub', '/']) {
      for (const base of ['/litsan', '/memhub']) assert.equal(webRoutePath(`${base}/api/tools`, primary, '/mcp'), '/memhub/api/tools');
    }
    // A custom base path is not widened by the product aliases.
    assert.equal(webRoutePath('/memhub/api/tools', '/custom', '/mcp'), '');
  } finally {
    globalThis.fetch = originalFetch;
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await rm(root, { recursive: true, force: true });
  }
});
