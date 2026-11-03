import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { writeFile, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { runToolCli } from '../dist/shell/cli/main.js';
import { parseToolArgs, usageFor, CliUsageError } from '../dist/shell/cli/args.js';
import { CLI_COMMANDS, toolForCommand, commandForTool } from '../dist/shell/cli/commands.js';
import { callTool, listTools, loopbackEndpoint, CliTransportError } from '../dist/shell/cli/client.js';

const schema = {
  type: 'object', required: ['action', 'user_text'], properties: {
    action: { type: 'string', enum: ['open', 'commit'] },
    user_text: { type: 'string' }, mode: { type: 'string', enum: ['brief', 'full'] },
    max_count: { type: 'integer', minimum: 1, maximum: 5 },
    score: { type: 'number', minimum: 0, maximum: 1 },
    enabled: { type: 'boolean' }, tag_names: { type: 'array', items: { type: 'string' } },
    metadata: { type: 'object' }, choices: { anyOf: [{ type: 'string' }, { type: 'object' }] },
    entries: { type: 'array', items: { type: 'object' } }, raw: {}
  }
};
const tools = [
  { name: 'litsan_turn', description: 'Manage a turn', inputSchema: schema },
  { name: 'litsan_context', description: 'Get context', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } }
];
let base;
let server;
let deadBase;
const received = [];
const fixture = fileURLToPath(new URL(`./.cli-client-${process.pid}.json`, import.meta.url));

before(async () => {
  await writeFile(fixture, '{"from_file":true}');
  server = createServer(async (req, res) => {
    received.push({ method: req.method, url: req.url, contentType: req.headers['content-type'] });
    res.setHeader('content-type', 'application/json');
    if (req.url.startsWith('/non-json')) { res.end('not JSON'); return; }
    if (req.url.startsWith('/malformed')) { res.end('{"ok":true}'); return; }
    if (req.url.startsWith('/redirect')) { res.writeHead(302, { location: base }); res.end(); return; }
    if (req.url.startsWith('/slow')) { setTimeout(() => res.end(JSON.stringify({ ok: true, tools })), 100); return; }
    if (req.method === 'GET') { res.end(JSON.stringify({ ok: true, tools })); return; }
    let body = '';
    for await (const chunk of req) body += chunk;
    const args = JSON.parse(body);
    if (args.user_text === 'fail') {
      res.statusCode = 409;
      res.end(JSON.stringify({ ok: false, error: { code: 'conflict', message: 'Turn conflict' } }));
    } else res.end(JSON.stringify({ ok: true, result: args }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}/memhub/api/tools`;
  const dead = createServer();
  dead.listen(0, '127.0.0.1');
  await once(dead, 'listening');
  deadBase = `http://127.0.0.1:${dead.address().port}`;
  await new Promise(resolve => dead.close(resolve));
});
after(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await unlink(fixture);
});

async function run(args, input = '') {
  let stdout = '', stderr = '';
  const exit = await runToolCli([...args, '--endpoint', base], {
    stdout: { write: text => { stdout += text; } }, stderr: { write: text => { stderr += text; } },
    stdin: Readable.from([input])
  });
  return { exit, stdout, stderr, body: stdout.startsWith('{') ? JSON.parse(stdout) : undefined };
}
async function runAt(args) {
  let stdout = '', stderr = '';
  const exit = await runToolCli(args, {
    stdout: { write: text => { stdout += text; } }, stderr: { write: text => { stderr += text; } }, stdin: Readable.from([])
  });
  return { exit, stdout, stderr, body: stdout.startsWith('{') ? JSON.parse(stdout) : undefined };
}
function child(args, input = '') {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['bin/litsan.mjs', ...args], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: { ...process.env, MEMHUB_TOOLS_URL: base, TMPDIR: '/tmp/mhd' }, stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '', stderr = '';
    proc.stdout.on('data', chunk => { stdout += chunk; });
    proc.stderr.on('data', chunk => { stderr += chunk; });
    proc.on('error', reject);
    proc.on('close', exit => resolve({ exit, stdout, stderr }));
    proc.stdin.end(input);
  });
}

test('static command table has all twelve commands and safe lookups', () => {
  assert.equal(Object.keys(CLI_COMMANDS).length, 12);
  for (const [command, tool] of Object.entries(CLI_COMMANDS)) {
    assert.equal(toolForCommand(command), tool);
    assert.equal(commandForTool(tool), command);
  }
  assert.equal(toolForCommand('toString'), undefined);
  assert.equal(commandForTool('unknown'), undefined);
});
test('maps action, string, enum, integer, number, boolean and repeated arrays', async () => {
  const out = await run(['turn', 'open', '--user-text', 'hello', '--mode=brief', '--max-count=3', '--score', '0.5', '--enabled', '--tag-names', 'first', '--tag-names=second']);
  assert.equal(out.exit, 0);
  assert.deepEqual(out.body, { ok: true, tool: 'litsan_turn', action: 'open', result: {
    action: 'open', user_text: 'hello', mode: 'brief', max_count: 3, score: 0.5, enabled: true, tag_names: ['first', 'second']
  } });
  assert.equal(out.stderr, '');
  assert.equal(out.stdout.trim().split('\n').length, 1);
  assert.equal(received.at(-1).contentType, 'application/json');
  assert.equal(received.at(-1).url, '/memhub/api/tools/litsan_turn');
});
test('negative boolean overrides JSON base regardless of order', async () => {
  const out = await run(['turn', 'open', '--no-enabled', '--json-args', '{"user_text":"base","enabled":true}', '--user-text=explicit']);
  assert.equal(out.exit, 0);
  assert.equal(out.body.result.enabled, false);
  assert.equal(out.body.result.user_text, 'explicit');
});
test('JSON properties cover objects, unions, object arrays and untyped values', async () => {
  const out = await run(['turn', 'open', '--user-text=x', '--metadata-json={"a":1}', '--choices-json', '"choice"', '--entries-json=[{}]', '--raw-json=null']);
  assert.equal(out.exit, 0);
  assert.deepEqual(out.body.result.metadata, { a: 1 });
  assert.equal(out.body.result.choices, 'choice');
  assert.deepEqual(out.body.result.entries, [{}]);
  assert.equal(out.body.result.raw, null);
});
test('JSON property accepts @file', async () => {
  const out = await run(['turn', 'open', '--user-text=x', '--metadata-json', `@${fixture}`]);
  assert.equal(out.exit, 0);
  assert.deepEqual(out.body.result.metadata, { from_file: true });
});
test('JSON base accepts @file and explicit flags override keys', async () => {
  const out = await run(['turn', 'open', '--user-text=override', '--json-args', `@${fixture}`]);
  assert.equal(out.exit, 0);
  assert.equal(out.body.result.user_text, 'override');
  assert.equal(out.body.result.from_file, true);
});
test('JSON base accepts injected stdin and flag overrides', async () => {
  const out = await run(['turn', '--json-args=-', '--user-text=override'], '{"action":"commit","user_text":"base"}');
  assert.equal(out.exit, 0);
  assert.equal(out.body.action, 'commit');
  assert.equal(out.body.result.user_text, 'override');
});
test('JSON property accepts injected stdin', async () => {
  const out = await run(['turn', 'open', '--user-text=x', '--metadata-json', '-'], '{"stdin":true}');
  assert.equal(out.exit, 0);
  assert.deepEqual(out.body.result.metadata, { stdin: true });
});
test('string hyphen does not read stdin', async () => {
  const out = await run(['turn', 'open', '--user-text', '-']);
  assert.equal(out.body.result.user_text, '-');
});
test('tool without action omits action from output', async () => {
  const out = await run(['context', '--query=hello=world']);
  assert.equal(out.exit, 0);
  assert.deepEqual(out.body, { ok: true, tool: 'litsan_context', result: { query: 'hello=world' } });
});

for (const [name, args] of [
  ['unknown flag', ['open', '--user-text=x', '--bogus']],
  ['bad action enum', ['wrong', '--user-text=x']],
  ['bad string enum', ['open', '--user-text=x', '--mode=wrong']],
  ['missing required property', ['open']],
  ['extra positional', ['open', 'commit', '--user-text=x']],
  ['fractional integer', ['open', '--user-text=x', '--max-count=1.5']],
  ['integer below minimum', ['open', '--user-text=x', '--max-count=0']],
  ['integer above maximum', ['open', '--user-text=x', '--max-count=6']],
  ['nonfinite number', ['open', '--user-text=x', '--score=Infinity']],
  ['number above maximum', ['open', '--user-text=x', '--score=2']],
  ['missing flag value', ['open', '--user-text']],
  ['boolean value', ['open', '--user-text=x', '--enabled=false']],
  ['negated string', ['open', '--user-text=x', '--no-mode']],
  ['malformed JSON', ['open', '--user-text=x', '--metadata-json={']],
  ['nonobject JSON base', ['--json-args=[]']],
  ['invalid JSON base type', ['--json-args={"action":"open","user_text":1}']],
  ['invalid JSON base enum', ['--json-args={"action":"bad","user_text":"x"}']],
  ['invalid JSON base range', ['open', '--user-text=x', '--json-args={"max_count":9}']],
  ['invalid timeout', ['open', '--user-text=x', '--timeout-ms=0']],
  ['missing JSON file', ['open', '--user-text=x', '--metadata-json=@/nonexistent/memhub-cli.json']]
]) test(`usage: ${name}`, async () => {
  const out = await run(['turn', ...args]);
  assert.equal(out.exit, 2);
  assert.equal(out.body.error.code, 'usage');
  if (name === 'unknown flag') assert.match(out.body.error.message, /--bogus/);
});

test('unknown command returns usage', async () => {
  const out = await run(['unknown']);
  assert.equal(out.exit, 2);
  assert.equal(out.body.error.code, 'usage');
  assert.equal(out.body.tool, undefined);
});
test('server tool errors pass through with exit 1', async () => {
  const out = await run(['turn', 'open', '--user-text=fail']);
  assert.equal(out.exit, 1);
  assert.deepEqual(out.body, { ok: false, tool: 'litsan_turn', error: { code: 'conflict', message: 'Turn conflict' } });
});
test('pretty output is one JSON document', async () => {
  const out = await run(['context', '--pretty']);
  assert.equal(out.exit, 0);
  assert.match(out.stdout, /\n  "ok": true/);
  assert.equal(JSON.parse(out.stdout).ok, true);
});
test('tools lists commands, names and descriptions', async () => {
  const out = await run(['tools']);
  assert.equal(out.exit, 0);
  assert.deepEqual(out.body, { ok: true, tools: tools.map(t => ({ command: commandForTool(t.name), tool: t.name, description: t.description })) });
});
test('help lists actions, all schema flags and globals without required args', async () => {
  const out = await run(['turn', '--help']);
  assert.equal(out.exit, 0);
  assert.match(out.stdout, /<open\|commit>/);
  for (const flag of ['user-text', 'max-count', 'metadata-json', 'entries-json', 'choices-json', 'raw-json', 'endpoint', 'json-args', 'timeout-ms'])
    assert.ok(out.stdout.includes(`--${flag}`), flag);
  assert.match(usageFor('turn', schema), /string\[\] \(repeatable\)/);
});
test('server down returns transport error', async () => {
  const out = await runAt(['turn', 'open', '--user-text=x', '--endpoint', deadBase]);
  assert.equal(out.exit, 2);
  assert.equal(out.body.error.code, 'transport');
});
test('help with server down returns generic usage and diagnostics', async () => {
  const out = await runAt(['turn', '--help', '--endpoint', deadBase]);
  assert.equal(out.exit, 2);
  assert.match(out.stdout, /Usage: litsan turn \[--flags\]/);
  assert.ok(out.stderr);
  assert.doesNotMatch(out.stdout, /open|commit/);
});
for (const endpoint of ['http://example.com/api', 'https://127.0.0.1/api', 'http://user:pass@127.0.0.1/api', 'file:///etc/passwd', 'invalid'])
  test(`reject endpoint ${endpoint}`, async () => {
    const out = await runAt(['turn', 'open', '--user-text=x', '--endpoint', endpoint]);
    assert.equal(out.exit, 2);
    assert.equal(out.body.error.code, 'usage');
    assert.equal(out.body.error.message, 'remote CLI endpoints are not supported yet; use loopback');
  });
test('loopback validator accepts localhost and IPv6 without connecting', () => {
  assert.equal(loopbackEndpoint('http://localhost:3001/api/'), 'http://localhost:3001/api');
  assert.equal(loopbackEndpoint('http://[::1]:3001/api'), 'http://[::1]:3001/api');
});
for (const path of ['non-json', 'malformed', 'redirect', 'slow']) test(`transport: ${path}`, async () => {
  const endpoint = base.replace('/memhub/api/tools', `/${path}`);
  const out = await runAt(['context', '--endpoint', endpoint, '--timeout-ms', path === 'slow' ? '10' : '1000']);
  assert.equal(out.exit, 2);
  assert.equal(out.body.error.code, 'transport');
});
test('transport exports support direct callers', async () => {
  assert.deepEqual(await listTools(base, 1000), tools);
  assert.deepEqual(await callTool(base, 'litsan_context', { query: 'x' }, 1000), { ok: true, result: { query: 'x' } });
  await assert.rejects(listTools(deadBase, 1000), CliTransportError);
  assert.throws(() => parseToolArgs(['--unknown'], schema), CliUsageError);
});
test('unavailable tool returns usage', async () => {
  const out = await run(['todo', 'list']);
  assert.equal(out.exit, 2);
  assert.equal(out.body.error.code, 'usage');
});
test('tools rejects extra arguments', async () => {
  const out = await run(['tools', '--bogus']);
  assert.equal(out.exit, 2);
  assert.equal(out.body.error.code, 'usage');
});
test('bin turn --help uses tools dispatch before lifecycle flags', async () => {
  const out = await child(['turn', '--help']);
  assert.equal(out.exit, 0, out.stderr);
  assert.match(out.stdout, /Usage: litsan turn <open\|commit>/);
});
test('bin tools uses environment endpoint', async () => {
  const out = await child(['tools']);
  assert.equal(out.exit, 0, out.stderr);
  assert.equal(JSON.parse(out.stdout).tools.length, 2);
});
test('explicit endpoint overrides environment', async () => {
  const out = await child(['context', '--endpoint', deadBase]);
  assert.equal(out.exit, 2);
  assert.equal(JSON.parse(out.stdout).error.code, 'transport');
});
test('bin JSON stdin works', async () => {
  const out = await child(['turn', '--json-args', '-'], '{"action":"commit","user_text":"stdin"}');
  assert.equal(out.exit, 0, out.stderr);
  assert.equal(JSON.parse(out.stdout).result.user_text, 'stdin');
});
test('bin version retains lifecycle output', async () => {
  const out = await child(['version']);
  assert.equal(out.exit, 0, out.stderr);
  assert.equal(out.stdout, '1.0.0\n');
});
test('bin lifecycle help includes tool block', async () => {
  const out = await child(['--help']);
  assert.equal(out.exit, 0, out.stderr);
  assert.match(out.stdout, /Tool commands: litsan tools \| litsan <command>/);
  assert.match(out.stdout, /litsan start/);
});

test('equals form accepts a string beginning with double hyphen', async () => {
  const out = await run(['turn', 'open', '--user-text=--literal']);
  assert.equal(out.exit, 0);
  assert.equal(out.body.result.user_text, '--literal');
});
test('schema properties beginning with no retain their direct flag mapping', () => {
  const parsed = parseToolArgs(['--no-cache', '--no-label=x'], { properties: {
    no_cache: { type: 'boolean' }, no_label: { type: 'string' }
  } });
  assert.deepEqual(parsed.args, { no_cache: true, no_label: 'x' });
});
