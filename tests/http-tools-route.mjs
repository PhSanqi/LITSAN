import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { rm, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createLitsanMcpServer } from '../dist/mcp.js';
import { JsonProjectRegistry } from '../dist/project-registry.js';
import { setDistillationConfig } from '../dist/distillation-jobs.js';
import { listCaptureEvents, closeCaptureIndexDb } from '../dist/capture.js';
import { MAX_HTTP_JSON_BODY_BYTES } from '../dist/http-json.js';
import { addAccount } from '../dist/auth.js';
import { createTestRoot, testEnvironment } from './test-isolation.mjs';

const requestedTmpdir = process.env.TMPDIR;
let root, memoryServer, server, client, gateway, base, port;
const completed = [];
const gateways = [];
const accountId = 'http-tools-test';

async function startGateway(basePath, publicHost, extraEnv = {}) {
  const child = spawn(process.execPath, ['tests/fixtures/c1-http-gateway.mjs', JSON.stringify({
    stateRoot: root, accountId, memoryEndpoint: `http://127.0.0.1:${memoryServer.address().port}`, basePath, publicHost
  })], {
    env: testEnvironment(root, root, { TMPDIR: requestedTmpdir ?? root, MEMHUB_MEMORY_TOKEN: '', ...extraEnv }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  gateways.push(child);
  let output = '';
  child.stdout.resume();
  child.stderr.on('data', chunk => { output += chunk; });
  const deadline = Date.now() + 10_000;
  while (!output.includes('listening on http://127.0.0.1:') && Date.now() < deadline && child.exitCode === null) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const match = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(output);
  assert.ok(match, `gateway starts: ${output}`);
  return { child, port: Number(match[1]), base: `http://127.0.0.1:${match[1]}${basePath === '/' ? '' : basePath}/api/tools` };
}

before(async () => {
  root = await createTestRoot('http-tools-');
  const registry = new JsonProjectRegistry(join(root, 'project-registry.json'));
  await registry.create(accountId, { projectId: 'demo', description: 'HTTP tools fixture' });
  await setDistillationConfig(root, { auto_enabled: false });
  memoryServer = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    response.setHeader('content-type', 'application/json');
    if (request.url.endsWith('/complete')) completed.push(body);
    if (request.url.includes('search')) response.end('{"hits":[]}');
    else if (request.method === 'GET') response.end('{"items":[],"hasNext":false}');
    else response.end(JSON.stringify({ sessionId: body.sessionId, status: 'captured', l1MemoryId: 'fake-l1' }));
  });
  await new Promise(resolve => memoryServer.listen(0, '127.0.0.1', resolve));
  server = createLitsanMcpServer({ controlRoot: root, projectRegistryPath: join(root, 'project-registry.json'),
    branchesPath: join(root, 'project-branches.json'), accountId, disableArchitecture: true,
    memoryEndpoint: `http://127.0.0.1:${memoryServer.address().port}`, memoryToken: '' });
  client = new Client({ name: 'http-parity', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  gateway = await startGateway('/memhub', 'litsan.example.test');
  ({ port, base } = gateway);
});

after(async () => {
  await Promise.all(gateways.map(async child => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await exited;
  }));
  await client?.close();
  await server?.close();
  closeCaptureIndexDb(root);
  if (memoryServer) await new Promise(resolve => memoryServer.close(resolve));
  if (root) await rm(root, { recursive: true, force: true });
});

async function call(name, args, endpoint = base) {
  const response = await fetch(`${endpoint}/${name}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args) });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  return { status: response.status, body: await response.json() };
}
function rawRequest(path, { headers = {}, body, method = 'GET', targetPort = port } = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port: targetPort, path, method, headers }, response => {
      let raw = '';
      response.on('data', chunk => { raw += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, raw }));
    });
    request.on('error', reject);
    request.end(body);
  });
}

test('GET tools advertises the same schemas and descriptions as MCP', async () => {
  const response = await fetch(base);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  const listing = await response.json();
  assert.equal(listing.ok, true);
  const { tools } = await client.listTools();
  assert.deepEqual(listing.tools, tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })));
});

test('todo list and turn open/commit round-trip record local CLI provenance', async () => {
  assert.deepEqual(await call('litsan_todo', { action: 'list' }), { status: 200,
    body: { ok: true, result: { scope: 'account', status: 'pending', projects: [], total: 0 } } });
  const opened = await call('litsan_turn', { action: 'open', project: 'demo', user_text: 'HTTP request', continuity_id: 'http-continuity' });
  assert.equal(opened.status, 200);
  const eventId = opened.body.result.event_id;
  const committed = await call('litsan_turn', { action: 'commit', event_id: eventId, assistant_text: 'HTTP response' });
  assert.equal(committed.status, 200);
  assert.equal(committed.body.result.status, 'complete');
  assert.equal(committed.body.result.ingested, true);
  assert.equal(completed.length, 1);
  const resumed = await call('litsan_turn', { action: 'resume', event_id: eventId });
  assert.equal(resumed.body.result.turns[0].assistant_text, 'HTTP response');
  const [event] = await listCaptureEvents(root, accountId, { eventId });
  assert.equal(event.provenance.platform, 'local-cli');
  assert.equal(event.provenance.transport, 'http-tools');
});

const invalid = [
  ['required', 'litsan_todo', {}],
  ['enum', 'litsan_todo', { action: 'wrong' }],
  ['additional properties', 'litsan_todo', { action: 'list', extra: true }],
  ['string type', 'litsan_todo', { action: 12 }],
  ['object type', 'litsan_turn', { action: 'open', initiator: [] }],
  ['boolean type', 'litsan_card', { action: 'next', dry: 'yes' }],
  ['integer', 'litsan_turn', { action: 'resume', limit: 1.5 }],
  ['minimum', 'litsan_turn', { action: 'resume', limit: 0 }],
  ['maximum', 'litsan_card', { action: 'next', lease_seconds: 901 }],
  ['maxLength', 'litsan_turn', { action: 'open', initiator: { harness: 'x'.repeat(81) } }],
  ['nested required', 'litsan_turn', { action: 'open', relates_to: {} }],
  ['nested additional properties', 'litsan_turn', { action: 'open', initiator: { extra: true } }],
  ['minItems', 'litsan_branch', { action: 'retag', event_ids: [] }],
  ['maxItems', 'litsan_branch', { action: 'retag', event_ids: Array(201).fill('id') }],
  ['minLength', 'litsan_branch', { action: 'retag', event_ids: [''] }],
  ['array item', 'litsan_branch', { action: 'retag', event_ids: [1] }],
  ['number limits', 'litsan_distill', { confidence: 1.1 }],
  ['nullable union', 'litsan_distill', { architecture_map: { nodes: [{ parent_id: 1 }], edges: [], timeline_links: [] } }],
  ['pattern', 'litsan_distill', { events: [{ date: 'invalid', title_en: 'T', title_zh: '题', body_en: 'B', body_zh: '文', evidence_refs: ['x'] }] }],
  ['handler TypeError', 'litsan_turn', { action: 'open' }],
];
for (const [label, tool, args] of invalid) test(`HTTP/MCP rejection parity: ${label}`, async () => {
  const mcp = await client.callTool({ name: tool, arguments: args });
  assert.equal(mcp.isError, true);
  const http = await call(tool, args);
  assert.equal(http.status, 400);
  assert.equal(http.body.ok, false);
  assert.equal(http.body.error.code, 'invalid_request');
  assert.equal(http.body.error.message, mcp.content[0].text);
});

test('unknown tools, tool errors, non-object/invalid JSON, media types and methods', async () => {
  assert.equal((await call('missing', {})).status, 404);
  assert.equal((await call('missing', {})).body.error.code, 'unknown_tool');
  const error = await call('litsan_turn', { action: 'resume', event_id: 'missing' });
  assert.deepEqual(error, { status: 422, body: { ok: false, error: { code: 'tool_error', message: 'capture event not found for account' } } });
  for (const args of [null, [], 'text', 1, false]) {
    const result = await call('litsan_todo', args);
    assert.equal(result.status, 400);
    assert.equal(result.body.error.code, 'invalid_request');
  }
  for (const contentType of ['text/plain', 'application/jsonp', '']) {
    const response = await fetch(`${base}/litsan_todo`, { method: 'POST', headers: { 'content-type': contentType }, body: '{}' });
    assert.equal(response.status, 415);
  }
  const broken = await rawRequest('/memhub/api/tools/litsan_todo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
  assert.equal(broken.status, 400);
  assert.equal(JSON.parse(broken.raw).ok, false);
  assert.equal((await fetch(base, { method: 'POST' })).status, 405);
  assert.equal((await fetch(`${base}/litsan_todo`)).status, 405);
});

test('JSON body size limits apply to declared and streamed bodies', async () => {
  for (const headers of [{ 'content-length': String(MAX_HTTP_JSON_BODY_BYTES + 1) }, {}]) {
    const result = await rawRequest('/memhub/api/tools/litsan_todo', { method: 'POST',
      headers: { 'content-type': 'application/json', ...headers }, body: ' '.repeat(MAX_HTTP_JSON_BODY_BYTES + 1) });
    assert.equal(result.status, 413);
    assert.equal(JSON.parse(result.raw).error.code, 'request_body_too_large');
  }
});

test('public host and forwarded requests require JWT; Host/Origin protections reject outsiders', async () => {
  for (const headers of [{ host: 'litsan.example.test' }, { 'cf-ray': 'forwarded' }, { 'cf-connecting-ip': '203.0.113.1' }]) {
    const response = await rawRequest('/memhub/api/tools', { headers });
    assert.equal(response.status, 401);
    assert.equal(JSON.parse(response.raw).error.code, 'missing_cloudflare_access_jwt');
    assert.equal(response.headers['cache-control'], 'no-store');
  }
  for (const headers of [{ host: 'evil.example' }, { origin: 'http://evil.example' }]) {
    assert.equal((await rawRequest('/memhub/api/tools', { headers })).status, 403);
  }
});

test('large JSON results are continued inline through POST litsan_result', async () => {
  const text = 'Large HTTP result. '.repeat(11_000).trim();
  const opened = await call('litsan_turn', { action: 'open', project: 'demo', user_text: 'large request', continuity_id: 'large' });
  const eventId = opened.body.result.event_id;
  assert.equal((await call('litsan_turn', { action: 'commit', event_id: eventId, assistant_text: text })).status, 200);
  const resumed = await call('litsan_turn', { action: 'resume', event_id: eventId });
  const first = resumed.body.result;
  assert.equal(first.result_transport.mode, 'chunked');
  let joined = first.result_chunk;
  let offset = first.result_transport.next_offset;
  while (offset !== null) {
    const result = await call('litsan_result', { result_id: first.result_transport.result_id, offset, chunk_chars: 200_000 });
    assert.equal(result.status, 200);
    assert.equal(result.body.result.result_transport.offset, offset);
    joined += result.body.result.result_chunk;
    offset = result.body.result.result_transport.next_offset;
  }
  assert.equal(JSON.parse(joined).turns[0].assistant_text, text);
  const foreign = new (await import('../dist/result-transport.js')).JsonResultTransport(root, 'foreign');
  assert.throws(() => foreign.read(first.result_transport.result_id), /expired/);
});

test('custom and root base paths normalize to the same route without publicHost', async () => {
  for (const basePath of ['/custom/base', '/']) {
    const started = await startGateway(basePath);
    assert.equal((await fetch(started.base)).status, 200);
    assert.equal((await call('litsan_todo', { action: 'list' }, started.base)).status, 200);
    // Product paths alias each other under the root base; a custom base path stays exclusive.
    const aliased = basePath === '/' ? 200 : 404;
    assert.equal((await fetch(`http://127.0.0.1:${started.port}/memhub/api/tools`)).status, aliased);
    assert.equal((await fetch(`http://127.0.0.1:${started.port}/litsan/api/tools`)).status, aliased);
  }
});

test('JWKS timeout is retryable, recovery verifies JWTs, and key rotation stays fenced', async () => {
  const issuer = 'https://team-test.cloudflareaccess.com';
  const accountEmail = 'jwks-test@example.test';
  const fixturePath = join(root, 'jwks-fixture.json');
  const offsetPath = join(root, 'jwks-clock-offset.txt');
  const preloadPath = join(root, 'jwks-fetch-preload.mjs');
  const first = await generateKeyPair('RS256', { extractable: true });
  const second = await generateKeyPair('RS256', { extractable: true });
  const firstJwk = { ...await exportJWK(first.publicKey), kid: 'first', alg: 'RS256', use: 'sig' };
  const secondJwk = { ...await exportJWK(second.publicKey), kid: 'second', alg: 'RS256', use: 'sig' };
  const token = (key, kid, audience = 'test-audience') => new SignJWT({ email: accountEmail })
    .setProtectedHeader({ alg: 'RS256', kid }).setSubject('jwks-test-sub').setIssuer(issuer)
    .setAudience(audience).setIssuedAt().setExpirationTime('1h').sign(key);
  const firstToken = await token(first.privateKey, 'first');
  const secondToken = await token(second.privateKey, 'second');
  await addAccount(root, 'jwks-test', accountEmail);
  await writeFile(join(root, 'cloudflare-access.json'), JSON.stringify({ version: 1, issuer, audience: 'test-audience' }));
  await writeFile(fixturePath, JSON.stringify({ mode: 'timeout', keys: [firstJwk] }));
  await writeFile(offsetPath, '0');
  await writeFile(preloadPath, `
    import { readFileSync } from 'node:fs';
    const originalFetch = globalThis.fetch;
    const originalNow = Date.now;
    Date.now = () => originalNow() + Number(readFileSync(${JSON.stringify(offsetPath)}, 'utf8'));
    globalThis.fetch = async (input, options) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.origin !== ${JSON.stringify(issuer)}) return originalFetch(input, options);
      const fixture = JSON.parse(readFileSync(${JSON.stringify(fixturePath)}, 'utf8'));
      if (fixture.mode === 'timeout') throw new DOMException('simulated JWKS timeout', 'TimeoutError');
      if (fixture.mode === 'slow') await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 5_500);
        if (options.signal.aborted) { clearTimeout(timer); reject(options.signal.reason); return; }
        options.signal.addEventListener('abort', () => { clearTimeout(timer); reject(options.signal.reason); }, { once: true });
      });
      return new Response(JSON.stringify({ keys: fixture.keys }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
  `);
  const { port: targetPort } = await startGateway('/memhub', 'litsan.example.test', {
    NODE_OPTIONS: `--import=${pathToFileURL(preloadPath).href}`
  });
  const headers = { host: 'litsan.example.test', 'cf-access-jwt-assertion': firstToken };
  for (const path of ['/mcp', '/memhub/api/tools', '/memhub/user']) {
    const failure = await rawRequest(path, { headers, targetPort });
    assert.equal(failure.status, 503, path);
    assert.equal(failure.headers['retry-after'], '1', path);
    assert.equal(failure.headers['cache-control'], 'no-store', path);
    assert.ok(failure.headers['x-memhub-request-id'], path);
    const body = JSON.parse(failure.raw);
    assert.equal(body.error?.code ?? body.error, 'identity_provider_unavailable', path);
  }

  await writeFile(fixturePath, JSON.stringify({ mode: 'slow', keys: [firstJwk] }));
  const recovered = await rawRequest('/memhub/api/tools', { headers, targetPort });
  assert.equal(recovered.status, 200, 'a valid key arriving after 5 seconds is accepted');
  assert.equal((await rawRequest('/memhub/user', { headers, targetPort })).status, 200);
  const mcp = await rawRequest('/mcp', {
    targetPort, method: 'POST',
    headers: { ...headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'jwks-test', version: '1' }
    } })
  });
  assert.equal(mcp.status, 200, 'MCP initializes after key retrieval recovers');
  const invalidSignature = await token(second.privateKey, 'first');
  const wrongAudience = await token(first.privateKey, 'first', 'wrong-audience');
  const wrongIssuer = await new SignJWT({ email: accountEmail }).setProtectedHeader({ alg: 'RS256', kid: 'first' })
    .setSubject('jwks-test-sub').setIssuer('https://untrusted.cloudflareaccess.com').setAudience('test-audience')
    .setIssuedAt().setExpirationTime('1h').sign(first.privateKey);
  for (const invalid of [invalidSignature, wrongAudience, wrongIssuer]) {
    const response = await rawRequest('/memhub/api/tools', {
      headers: { ...headers, 'cf-access-jwt-assertion': invalid }, targetPort
    });
    assert.equal(response.status, 403);
    assert.equal(JSON.parse(response.raw).error.code, 'identity_rejected');
  }
  assert.equal((await rawRequest('/memhub/api/tools', { headers: { host: 'litsan.example.test' }, targetPort })).status, 401);

  await writeFile(fixturePath, JSON.stringify({ mode: 'ok', keys: [secondJwk] }));
  await writeFile(offsetPath, '31000');
  const rotated = await rawRequest('/memhub/api/tools', {
    headers: { ...headers, 'cf-access-jwt-assertion': secondToken }, targetPort
  });
  assert.equal(rotated.status, 200, 'new key is fetched after the normal cooldown');
  assert.equal((await rawRequest('/memhub/api/tools', { headers, targetPort })).status, 403, 'removed key is not trusted');
});
