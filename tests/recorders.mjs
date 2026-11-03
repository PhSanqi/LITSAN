import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, readdir, stat, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createTestRoot } from './test-isolation.mjs';
import { Readable } from 'node:stream';
import { classify } from '../dist/shell/recorders/classify.js';
import { mapping, workstreamHint } from '../dist/shell/recorders/config.js';
import { childEventId, transcriptSummary } from '../dist/shell/recorders/claude-hook.js';
import { inlineCardContext } from '../dist/shell/recorders/inline-card.js';
import { Recorder } from '../dist/shell/recorders/state.js';
import { runRecorderCli } from '../dist/shell/cli/main.js';

let root, server, endpoint;
const requests = [];
const repository = resolve(import.meta.dirname, '..');
const fixtures = JSON.parse(await readFile(new URL('./fixtures/recorders/classifier.json', import.meta.url), 'utf8'));
before(async () => {
  root = await createTestRoot('recorders-');
  server = createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    const args = JSON.parse(text);
    requests.push({ tool: req.url.split('/').at(-1), args });
    if (req.url.includes('/slow/')) { setTimeout(() => res.end('{"ok":true,"result":{}}'), 5000).unref(); return; }
    if (args.user_text === 'delayed success') await new Promise(done => setTimeout(done, 300));
    res.setHeader('content-type', 'application/json');
    if (args.user_text === 'server error') res.end('{"ok":false,"error":{"code":"tool_error","message":"forced failure"}}');
    else res.end(JSON.stringify({ ok: true, result: { event_id: args.user_text === 'server canonical id' ? 'l1_server' : args.event_id ?? 'l1_mock',
      ...(args.action === 'open' && args.user_text === 'Inline task' ? { inline_maintenance: { card_id: 'card-1', lease_token: 'lease-1', input: { items: [{ user_text: 'PRIVATE EVIDENCE' }] } } } : {}) } }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  endpoint = `http://127.0.0.1:${server.address().port}/memhub/api/tools`;
});
after(async () => { server.closeAllConnections(); await new Promise(done => server.close(done)); await rm(root, { recursive: true, force: true }); });

async function setup(config = {}) {
  const dir = await mkdtemp(join(root, 'case-'));
  const cwd = join(dir, 'project'); await mkdir(cwd);
  const configPath = join(dir, 'cli.json');
  await writeFile(configPath, JSON.stringify({ projects: [{ path: cwd, project: 'test-project' }], unmapped: 'skip', endpoint, ...config }));
  return { dir, cwd, home: join(dir, 'recorder'), config: configPath };
}
function invoke(f, args, input = '', extra = {}) {
  return new Promise((accept, reject) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('MEMHUB_')));
    const child = spawn(process.execPath, [join(repository, 'bin/litsan.mjs'), ...args], {
      cwd: f.cwd, env: { ...env, MEMHUB_RECORDER_HOME: f.home, MEMHUB_CLI_CONFIG: f.config, ...extra }, stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => stdout += data); child.stderr.on('data', data => stderr += data);
    child.on('error', reject); child.on('close', exit => accept({ exit, stdout, stderr }));
    child.stdin.on('error', () => {});
    child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
  });
}
async function state(f) {
  const files = await readdir(f.home);
  return JSON.parse(await readFile(join(f.home, files.find(file => file.startsWith('session-'))), 'utf8'));
}
async function transcript(f, prompt, blocks = [], answer = 'Done.', filename = 'transcript.jsonl') {
  const file = join(f.dir, filename);
  const rows = [
    { type: 'user', message: { role: 'user', content: prompt } },
    { type: 'assistant', message: { role: 'assistant', content: blocks.map(name => ({ type: 'tool_use', name, id: name, input: {} })) } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: answer }] } }
  ];
  await writeFile(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  return file;
}
const payload = (f, more = {}) => ({ session_id: 'session-1', cwd: f.cwd, ...more });

for (const fixture of fixtures) test(`classifier: ${fixture.name}`, () => {
  const actual = classify(fixture.prompt);
  if (fixture.skip) return assert.equal(actual, undefined);
  assert.equal(actual.origin, fixture.origin); assert.equal(actual.trigger, fixture.trigger);
  assert.equal(actual.userText, fixture.userText ?? fixture.prompt);
  assert.deepEqual(actual.initiator, fixture.initiator);
});
test('classifier strips all reminders, caps text, respects priority and longer fences', () => {
  assert.equal(classify('a<system-reminder>x</system-reminder>b<system-reminder>y</system-reminder>c').userText, 'abc');
  assert.equal(classify('x'.repeat(30_000)).userText.length, 20_000);
  assert.equal(classify('<ci-monitor-event>x</ci-monitor-event> <task-notification>x</task-notification>').trigger, 'task_notification');
  assert.equal(classify('````xml\n```\n<task-notification>x\n````').origin, 'user');
});
test('project mapping uses longest directory prefix and supports global opt-in', () => {
  const config = { projects: [{ path: '/a', project: 'outer' }, { path: '/a/b', project: 'inner' }], unmapped: 'skip' };
  assert.deepEqual(mapping(config, '/a/b/c'), { project: 'inner' });
  assert.equal(mapping(config, '/ab'), undefined);
  assert.deepEqual(mapping({ ...config, unmapped: 'record_global' }, '/other'), { keep_global: true });
  assert.equal(mapping(undefined, '/a'), undefined);
});
test('Claude user opens once, injects event id, commits final text and compact tool counts', async () => {
  const f = await setup(), before = requests.length;
  const path = await transcript(f, 'Fix it', ['Read', 'Edit', 'Edit', 'mcp__memhub__get_status'], 'Fixed.');
  const result = await invoke(f, ['hook', 'claude', 'UserPromptSubmit'], payload(f, { prompt: 'Fix it', transcript_path: path }));
  assert.equal(result.exit, 0); assert.equal(result.stderr, '');
  const context = JSON.parse(result.stdout).hookSpecificOutput;
  assert.equal(context.hookEventName, 'UserPromptSubmit');
  const open = requests[before].args;
  assert.equal(open.action, 'open'); assert.equal(open.project, 'test-project'); assert.equal(open.origin, 'user');
  assert.equal(open.conversation_id, 'claude:session-1'); assert.equal(open.turn_id, 'claude:session-1:1');
  assert.ok(context.additionalContext.includes(open.event_id)); assert.ok(context.additionalContext.includes('Do not call litsan_turn open/commit/record'));
  const stop = await invoke(f, ['hook', 'claude', 'Stop'], payload(f));
  assert.equal(stop.exit, 0); assert.equal(stop.stdout, ''); assert.equal(stop.stderr, '');
  const commit = requests[before + 1].args;
  assert.equal(commit.action, 'commit'); assert.equal(commit.event_id, open.event_id); assert.equal(commit.assistant_text, 'Fixed.');
  assert.match(commit.tool_summary, /Edit: 2/); assert.ok(commit.tool_summary.length <= 1000);
  assert.equal((await state(f)).turn, undefined);
  await invoke(f, ['hook', 'claude', 'Stop'], payload(f)); assert.equal(requests.length, before + 2);
  await invoke(f, ['hook', 'claude', 'UserPromptSubmit'], payload(f, { prompt: 'Next', transcript_path: path }));
  assert.equal(requests.at(-1).args.turn_id, 'claude:session-1:2');
  if (process.platform !== 'win32') {
    assert.equal((await stat(f.home)).mode & 0o777, 0o700);
    for (const file of await readdir(f.home)) assert.equal((await stat(join(f.home, file))).mode & 0o777, 0o600);
  }
});
test('Claude hook exposes a leased card route without embedding evidence', async () => {
  const f = await setup(), path = await transcript(f, 'Inline task');
  const result = await invoke(f, ['hook', 'claude', 'UserPromptSubmit'], payload(f, { prompt: 'Inline task', transcript_path: path }));
  const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
  const route = JSON.parse(context.match(/litsan card --json-args '([^']+)'/)[1]);
  assert.equal(route.action, 'next'); assert.ok(route.inline_turn_event); assert.equal(route.card_id, undefined);
  assert.ok(context.includes('For each ordinary user turn')); assert.match(context, /only if input is absent/); assert.ok(context.includes('submit the evidence-bound answer immediately'));
  assert.equal(requests.at(-1).args.inline_maintenance, false);
  assert.match(context, /For each ordinary user turn, automatically check maintenance/);
  assert.ok(!context.includes('if suitable'));
  assert.ok(!context.includes('PRIVATE EVIDENCE'));
  await invoke(f, ['hook', 'claude', 'Stop'], payload(f));
});
test('inline hook route rejects unsafe or incomplete identifiers', () => {
  assert.match(inlineCardContext('l1_test'), /next/);
  assert.equal(inlineCardContext("l1_' ;whoami"), '');
  assert.equal(inlineCardContext(undefined), '');
});
test('Claude automation defers then counts a short status reply as skipped', async () => {
  const f = await setup(), before = requests.length, prompt = '<task-notification>still running</task-notification>';
  const path = await transcript(f, prompt);
  const result = await invoke(f, ['hook', 'claude', 'UserPromptSubmit'], payload(f, { prompt, transcript_path: path }));
  assert.match(JSON.parse(result.stdout).hookSpecificOutput.additionalContext, /Do not call litsan_turn/); assert.equal(requests.length, before);
  assert.equal((await state(f)).turn.prompt.origin, 'automation');
  await invoke(f, ['hook', 'claude', 'Stop'], payload(f)); assert.equal(requests.length, before);
  const status = JSON.parse((await invoke(f, ['hook', 'status'])).stdout);
  assert.equal(status.skipped[new Date().toISOString().slice(0, 10)], 1);
  assert.equal(status.spool_size, 0); assert.equal(status.config_path, f.config); assert.equal(status.mapped_projects[0].project, 'test-project');
});
test('Claude injects and commits the server-confirmed event id', async () => {
  const f = await setup(), prompt = 'server canonical id', path = await transcript(f, prompt);
  const result = await invoke(f, ['hook', 'claude', 'UserPromptSubmit'], payload(f, { prompt, transcript_path: path }));
  assert.match(JSON.parse(result.stdout).hookSpecificOutput.additionalContext, /event_id=l1_server/);
  await invoke(f, ['hook', 'claude', 'Stop'], payload(f));
  assert.equal(requests.at(-1).args.event_id, 'l1_server');
});
for (const [name, tools, reply] of [
  ['Edit', ['Edit'], 'Done'], ['Bash', ['Bash'], 'Done'], ['MCP mutation', ['mcp__memhub__turn'], 'Done'],
  ['AskUserQuestion', ['AskUserQuestion'], 'Choose'], ['final question', [], 'Which one?'], ['long reply', [], 'x'.repeat(400)]
]) test(`Claude automation records ${name}`, async () => {
  const f = await setup(), prompt = '<ci-monitor-event>finished</ci-monitor-event>', before = requests.length;
  const path = await transcript(f, prompt, tools, reply);
  await invoke(f, ['hook', 'claude', 'UserPromptSubmit'], payload(f, { prompt, transcript_path: path }));
  await invoke(f, ['hook', 'claude', 'Stop'], payload(f));
  assert.equal(requests.length, before + 1); assert.equal(requests.at(-1).args.action, 'record');
  assert.equal(requests.at(-1).args.origin, 'automation');
});
test('Claude links only explicit child event ids and skips read-only status tools', async () => {
  const f = await setup(), before = requests.length;
  const prompt = '<side-sessions-event>child event_id=l1_child42</side-sessions-event>';
  const path = await transcript(f, prompt, ['mcp__memhub__read_file', 'mcp__memhub__list', 'mcp__memhub__status'], 'Done');
  await invoke(f, ['hook', 'claude', 'UserPromptSubmit'], payload(f, { prompt, transcript_path: path }));
  await invoke(f, ['hook', 'claude', 'Stop'], payload(f));
  assert.deepEqual(requests[before].args.relates_to, { event_id: 'l1_child42', relation: 'relays' });
  assert.equal(childEventId('```\nevent_id=l1_quoted\n```'), undefined);
  assert.equal(childEventId('session_id=local_x'), undefined);
  assert.equal(childEventId('{"event_id":"l1_json"}'), 'l1_json');
  const prompt2 = '<task-notification>running</task-notification>';
  const path2 = await transcript(f, prompt2, ['mcp__memhub__get', 'mcp__memhub__query', 'mcp__memhub__load', 'mcp__memhub__search']);
  await invoke(f, ['hook', 'claude', 'UserPromptSubmit'], payload(f, { prompt: prompt2, transcript_path: path2 }));
  await invoke(f, ['hook', 'claude', 'Stop'], payload(f));
  assert.equal(requests.length, before + 1);
});
test('Claude SubagentStop appends summary without another L1 and active Stop is a no-op', async () => {
  const f = await setup(), before = requests.length;
  const path = await transcript(f, 'Do it', [], 'Parent.'), child = await transcript(f, 'Child', [], 'Child response', 'child.jsonl');
  await invoke(f, ['hook', 'claude', 'UserPromptSubmit'], payload(f, { prompt: 'Do it', transcript_path: path }));
  await invoke(f, ['hook', 'claude', 'SubagentStop'], payload(f, { transcript_path: child }));
  assert.equal(requests.length, before + 1);
  const previous = await state(f);
  await invoke(f, ['hook', 'claude', 'Stop'], payload(f, { stop_hook_active: true }));
  assert.deepEqual(await state(f), previous);
  await invoke(f, ['hook', 'claude', 'Stop'], payload(f));
  assert.match(requests.at(-1).args.tool_summary, /subagent: 14 chars/);
});
test('unmapped cwd and missing config do nothing and create no recorder directory', async () => {
  const f = await setup({ projects: [] }), before = requests.length;
  const input = payload(f, { prompt: 'hello' });
  assert.equal((await invoke(f, ['hook', 'claude', 'UserPromptSubmit'], input)).stdout, '');
  await invoke(f, ['hook', 'claude', 'UserPromptSubmit'], input, { MEMHUB_CLI_CONFIG: join(f.dir, 'missing.json') });
  assert.equal(requests.length, before);
  await assert.rejects(readdir(f.home), { code: 'ENOENT' });
});
test('server down spools open and commit with stable ids then replays oldest first', async () => {
  const f = await setup({ endpoint: 'http://127.0.0.1:1/api/tools' });
  const path = await transcript(f, 'Offline');
  const opened = await invoke(f, ['hook', 'claude', 'UserPromptSubmit'], payload(f, { prompt: 'Offline', transcript_path: path }));
  assert.equal(opened.exit, 0); assert.match(opened.stderr, /^\[litsan recorder\] [^\n]+\n$/);
  await invoke(f, ['hook', 'claude', 'Stop'], payload(f));
  const pending = (await readFile(join(f.home, 'spool.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(pending.map(item => item.args.action), ['open', 'commit']); assert.equal(pending[0].args.event_id, pending[1].args.event_id);
  assert.equal(pending[0].tool, 'litsan_turn'); assert.ok(pending[0].ts);
  await writeFile(f.config, JSON.stringify({ projects: [], unmapped: 'skip', endpoint }));
  const before = requests.length;
  await invoke(f, ['hook', 'status']);
  assert.deepEqual(requests.slice(before).map(item => item.args.action), ['open', 'commit']);
  assert.equal(await readFile(join(f.home, 'spool.jsonl'), 'utf8'), '');
});
test('spool flush caps at 20 entries and stops at first tool failure', async () => {
  const f = await setup(); await mkdir(f.home);
  const entries = Array.from({ length: 23 }, (_, i) => ({ ts: new Date().toISOString(), tool: 'litsan_turn', args: { action: 'record', user_text: `entry ${i}`, turn_id: `entry:${i}` } }));
  await writeFile(join(f.home, 'spool.jsonl'), entries.map(JSON.stringify).join('\n') + '\n');
  const before = requests.length;
  await invoke(f, ['hook', 'flush']); assert.equal(requests.length, before + 20);
  assert.equal((await readFile(join(f.home, 'spool.jsonl'), 'utf8')).trim().split('\n').length, 3);
  entries[0].args.user_text = 'server error';
  await writeFile(join(f.home, 'spool.jsonl'), entries.slice(0, 2).map(JSON.stringify).join('\n') + '\n');
  const failed = await invoke(f, ['hook', 'flush']); assert.match(failed.stderr, /forced failure/); assert.equal(requests.length, before + 21);
  assert.equal((await readFile(join(f.home, 'spool.jsonl'), 'utf8')).trim().split('\n').length, 2);
});
for (const delegated of [false, true]) test(`Codex notify ${delegated ? 'delegated' : 'user'} provenance`, async () => {
  const f = await setup(), before = requests.length, initiator = { harness: 'claude', session_id: 'parent', event_id: 'l1_parent' };
  const input = { type: 'agent-turn-complete', 'thread-id': 'thread', 'turn-id': 'turn', cwd: f.cwd, 'input-messages': ['first', 'second'], 'last-assistant-message': 'Done.' };
  const result = await invoke(f, ['hook', 'codex', JSON.stringify(input)], '', delegated ? { MEMHUB_INITIATOR: JSON.stringify(initiator) } : {});
  assert.equal(result.exit, 0); assert.equal(result.stdout, ''); assert.equal(result.stderr, ''); assert.equal(requests.length, before + 1);
  const args = requests.at(-1).args;
  assert.equal(args.action, 'record'); assert.equal(args.origin, delegated ? 'agent' : 'user'); assert.equal(args.trigger, delegated ? 'delegate' : 'user_prompt');
  assert.equal(args.user_text, 'first\nsecond'); assert.equal(args.assistant_text, 'Done.'); assert.equal(args.turn_id, 'codex:turn'); assert.equal(args.conversation_id, 'codex:thread');
  assert.equal(args.inline_maintenance, false);
  assert.deepEqual(args.initiator, delegated ? initiator : undefined);
  await invoke(f, ['hook', 'codex', '{"type":"other"}']); assert.equal(requests.length, before + 1);
});
test('Codex inline hooks provide only a task pointer and commit the real final answer', async () => {
  const f = await setup(), before = requests.length;
  const start = { session_id: 'session-1', turn_id: 'turn-1', cwd: f.cwd, prompt: 'Inline task' };
  const opened = await invoke(f, ['hook', 'codex-inline', 'UserPromptSubmit'], start);
  assert.equal(opened.exit, 0);
  const context = JSON.parse(opened.stdout).hookSpecificOutput.additionalContext;
  assert.match(context, /next/); assert.doesNotMatch(context, /card-1/);
  assert.doesNotMatch(context, /PRIVATE EVIDENCE/);
  assert.equal(requests.at(-1).args.inline_maintenance, false);
  const stopped = await invoke(f, ['hook', 'codex-inline', 'Stop'],
    { session_id: 'session-1', turn_id: 'turn-1', cwd: f.cwd, last_assistant_message: 'Visible answer' });
  assert.equal(stopped.exit, 0);
  assert.equal(requests.at(-1).args.action, 'commit');
  assert.equal(requests.at(-1).args.assistant_text, 'Visible answer');
  assert.equal(requests.at(-1).args.inline_maintenance, false);
  await invoke(f, ['hook', 'codex-inline', 'Stop'], { session_id: 'session-1', turn_id: 'turn-1', cwd: f.cwd, last_assistant_message: 'Visible answer' });
  assert.equal(requests.length, before + 2);
});
test('Codex inline hook closes an interrupted turn before opening the next', async () => {
  const f = await setup(), before = requests.length;
  await invoke(f, ['hook', 'codex-inline', 'UserPromptSubmit'], { session_id: 's', turn_id: 'one', cwd: f.cwd, prompt: 'Inline task' });
  await invoke(f, ['hook', 'codex-inline', 'UserPromptSubmit'], { session_id: 's', turn_id: 'two', cwd: f.cwd, prompt: 'Next task' });
  assert.deepEqual(requests.slice(before).map(x => x.args.action), ['open', 'failed', 'open']);
  assert.equal(requests[before + 1].args.inline_maintenance, false);
});
test('run wrapper preserves stdout, stderr, exit code, recorder env and JSON response', async () => {
  const f = await setup(), before = requests.length;
  const script = 'console.error("child stderr");console.log(process.env.MEMHUB_RECORDER);console.log(JSON.stringify({response:"Answer"}));process.exitCode=7';
  const result = await invoke(f, ['run', '--harness', 'agy', '--', process.execPath, '-e', script, '--', '--prompt', 'Question']);
  assert.equal(result.exit, 7); assert.equal(result.stdout, 'agy\n{"response":"Answer"}\n'); assert.equal(result.stderr, 'child stderr\n');
  assert.equal(requests.length, before + 1); assert.equal(requests.at(-1).args.assistant_text, 'Answer'); assert.equal(requests.at(-1).args.user_text, 'Question');
  assert.equal(requests.at(-1).args.inline_maintenance, false);
});
test('run wrapper prompt-file, direct prompt precedence, explicit project and initiator', async () => {
  const f = await setup({ projects: [] }); const file = join(f.dir, 'prompt.txt'); await writeFile(file, 'From file');
  const script = 'process.stdout.write("plain reply")', initiator = { harness: 'claude', event_id: 'l1_parent' };
  await invoke(f, ['run', '--harness', 'agy', '--project', 'explicit', '--', process.execPath, '-e', script, '--', '--prompt-file', file], '', { MEMHUB_INITIATOR: JSON.stringify(initiator) });
  assert.equal(requests.at(-1).args.user_text, 'From file'); assert.equal(requests.at(-1).args.project, 'explicit');
  assert.equal(requests.at(-1).args.origin, 'agent'); assert.equal(requests.at(-1).args.trigger, 'delegate'); assert.deepEqual(requests.at(-1).args.initiator, initiator);
  await invoke(f, ['run', '--harness', 'agy', '--project', 'explicit', '--', process.execPath, '-e', script, '--', '--prompt-file', file, '-p=Direct']);
  assert.equal(requests.at(-1).args.user_text, 'Direct');
});
test('run recording failure preserves child exit; no prompt skips; fallback caps at 20000', async () => {
  const f = await setup({ endpoint: 'http://127.0.0.1:1/api/tools' });
  const result = await invoke(f, ['run', '--harness', 'agy', '--', process.execPath, '-e', 'process.stdout.write("x".repeat(25000));process.exitCode=9', '--', '-p', 'Question']);
  assert.equal(result.exit, 9); assert.equal(result.stdout.length, 25000); assert.match(result.stderr, /litsan recorder/);
  const entry = JSON.parse((await readFile(join(f.home, 'spool.jsonl'), 'utf8')).trim()); assert.equal(entry.args.assistant_text.length, 20000);
  const before = requests.length;
  const noPrompt = await invoke(f, ['run', '--harness', 'agy', '--', process.execPath, '-e', 'process.stdout.write("ok")']);
  assert.equal(noPrompt.exit, 0); assert.equal(noPrompt.stdout, 'ok'); assert.equal(requests.length, before);
});
test('hook install --print only prints snippets and never writes or flushes', async () => {
  const f = await setup(), initial = await readdir(f.dir);
  const result = await invoke(f, ['hook', 'install', 'claude', '--print']);
  assert.equal(result.exit, 0); assert.equal(result.stderr, '');
  const snippet = JSON.parse(result.stdout);
  for (const event of ['UserPromptSubmit', 'Stop', 'SubagentStop']) assert.equal(snippet.hooks[event][0].hooks[0].command, `litsan hook claude ${event}`);
  assert.deepEqual(await readdir(f.dir), initial);
  assert.equal((await invoke(f, ['hook', 'install', 'codex', '--print'])).stdout, 'notify = ["litsan", "hook", "codex"]\n');
  const inline = JSON.parse((await invoke(f, ['hook', 'install', 'codex-inline', '--print'])).stdout);
  for (const event of ['UserPromptSubmit', 'Stop']) {
    const hook = inline.hooks[event][0].hooks[0];
    assert.equal(hook.command, `litsan hook codex-inline ${event}`);
    assert.match(hook.command, new RegExp(`hook codex-inline ${event}`));
    assert.equal(hook.timeout, 3);
  }
  const gemini = JSON.parse((await invoke(f, ['hook', 'install', 'gemini', '--print'])).stdout);
  assert.equal(gemini.hooks.BeforeAgent[0].hooks[0].command, 'litsan hook guidance gemini');
  const cursor = JSON.parse((await invoke(f, ['hook', 'install', 'cursor', '--print'])).stdout);
  assert.equal(cursor.hooks.sessionStart[0].command, 'litsan hook guidance cursor');
  const copilot = JSON.parse((await invoke(f, ['hook', 'install', 'copilot', '--print'])).stdout);
  assert.equal(copilot.hooks.sessionStart[0].bash, 'litsan hook guidance copilot');
  assert.deepEqual(await readdir(f.dir), initial);
});
test('portable guidance emits the documented host-specific envelopes without acquiring a card', async () => {
  const f = await setup(), before = requests.length;
  for (const host of ['gemini', 'cursor', 'copilot', 'json']) {
    const result = await invoke(f, ['hook', 'guidance', host]);
    assert.equal(result.exit, 0); assert.equal(result.stderr, '');
    const body = JSON.parse(result.stdout);
    const text = host === 'gemini' ? body.hookSpecificOutput.additionalContext : host === 'cursor' ? body.additional_context : body.additionalContext;
    if (host === 'gemini') assert.equal(body.hookSpecificOutput.hookEventName, 'BeforeAgent');
    assert.match(text, /next/); assert.match(text, /inline_maintenance=false/);
  }
  assert.equal(requests.length, before);
  await assert.rejects(readdir(f.home), { code: 'ENOENT' });
});
test('malformed hook input fails open with one stderr line and exit zero', async () => {
  const f = await setup();
  for (const args of [['hook', 'claude', 'UserPromptSubmit'], ['hook', 'codex', '{bad'], ['hook', 'install', 'claude']]) {
    const result = await invoke(f, args, '{bad'); assert.equal(result.exit, 0); assert.equal(result.stdout, ''); assert.match(result.stderr, /^\[litsan recorder\] [^\n]+\n$/);
  }
});
test('slow tool calls respect the hook budget and are not spooled (delivered, server still working)', async () => {
  const f = await setup({ endpoint: endpoint.replace('/memhub/', '/slow/') }), started = Date.now(), before = requests.length;
  const result = await invoke(f, ['hook', 'codex', JSON.stringify({ type: 'agent-turn-complete', cwd: f.cwd, 'thread-id': 't', 'turn-id': 'slow', 'input-messages': ['Hi'], 'last-assistant-message': 'Hi' })]);
  assert.equal(result.exit, 0); assert.ok(Date.now() - started < 3000); assert.match(result.stderr, /response still pending/);
  assert.equal(requests.length, before + 1); assert.equal(requests.at(-1).args.turn_id, 'codex:slow');
  assert.equal(await readFile(join(f.home, 'spool.jsonl'), 'utf8').catch(() => ''), '');
});
test('an unreachable server still spools the request for replay', async () => {
  const f = await setup({ endpoint: 'http://127.0.0.1:9/memhub/api/tools' });
  const result = await invoke(f, ['hook', 'codex', JSON.stringify({ type: 'agent-turn-complete', cwd: f.cwd, 'thread-id': 't', 'turn-id': 'down', 'input-messages': ['Hi'], 'last-assistant-message': 'Hi' })]);
  assert.equal(result.exit, 0);
  assert.equal(JSON.parse((await readFile(join(f.home, 'spool.jsonl'), 'utf8')).trim()).args.turn_id, 'codex:down');
});
test('reverse transcript scanning ignores older turns and handles multibyte chunk boundaries', async () => {
  const f = await setup(), path = await transcript(f, 'latest', ['Read'], '你'.repeat(30_000));
  const recent = await readFile(path, 'utf8');
  await writeFile(path, JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit' }] } }) + '\n' + recent);
  const recorder = new Recorder({ stdout: { write() {} }, stderr: { write() {} }, stdin: Readable.from([]) });
  const summary = await transcriptSummary(path, recorder);
  assert.equal(summary.assistant_text, '你'.repeat(30_000)); assert.equal(summary.sideEffects, false); assert.equal(summary.tool_summary, 'Read: 1');
});
test('git hints identify this linked worktree and never inspect outside the given repository', async () => {
  const hint = await workstreamHint(repository);
  assert.ok(hint?.git_branch); assert.ok(hint?.git_default_branch); assert.equal(hint.worktree, repository);
  assert.equal((await workstreamHint(root))?.worktree, repository);
});
test('programmatic recorder dispatch works with injected I/O', async () => {
  let stdout = '', stderr = '';
  const exit = await runRecorderCli(['hook', 'install', 'codex', '--print'], { stdout: { write: text => stdout += text }, stderr: { write: text => stderr += text }, stdin: Readable.from([]) });
  assert.equal(exit, 0); assert.equal(stdout, 'notify = ["litsan", "hook", "codex"]\n'); assert.equal(stderr, '');
});

test('concurrent replay preserves new failed requests appended during HTTP', async () => {
  const f = await setup(); await mkdir(f.home);
  const entry = { ts: new Date().toISOString(), tool: 'litsan_turn', args: { action: 'record', user_text: 'delayed success', turn_id: 'old' } };
  await writeFile(join(f.home, 'spool.jsonl'), JSON.stringify(entry) + '\n');
  const before = requests.length;
  const flushing = invoke(f, ['hook', 'flush']);
  // Wait for the server to receive the replay, so append occurs during HTTP.
  while (requests.length === before) await new Promise(done => setTimeout(done, 5));
  const input = { type: 'agent-turn-complete', cwd: f.cwd, 'thread-id': 't', 'turn-id': 'new', 'input-messages': ['server error'], 'last-assistant-message': 'answer' };
  const concurrent = await invoke(f, ['hook', 'codex', JSON.stringify(input)]);
  assert.equal(concurrent.exit, 0); assert.match(concurrent.stderr, /forced failure/);
  await flushing;
  const pending = (await readFile(join(f.home, 'spool.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(pending.length, 1); assert.equal(pending[0].args.turn_id, 'codex:new');
});
test('hook with stdin kept open exits zero within three seconds', async () => {
  const f = await setup(), started = Date.now();
  const child = spawn(process.execPath, [join(repository, 'bin/litsan.mjs'), 'hook', 'claude', 'UserPromptSubmit'], {
    cwd: f.cwd, env: { ...process.env, MEMHUB_RECORDER_HOME: f.home, MEMHUB_CLI_CONFIG: f.config }, stdio: ['pipe', 'pipe', 'pipe']
  });
  let stderr = ''; child.stderr.on('data', chunk => stderr += chunk);
  const [exit] = await once(child, 'close');
  assert.equal(exit, 0); assert.ok(Date.now() - started < 3000); assert.match(stderr, /stdin exceeded recorder time budget/);
});
test('active Stop neither replays a spool nor modifies pending state', async () => {
  const f = await setup(); await mkdir(f.home);
  const spool = JSON.stringify({ ts: 'now', tool: 'litsan_turn', args: { action: 'record', user_text: 'keep' } }) + '\n';
  await writeFile(join(f.home, 'spool.jsonl'), spool);
  const before = requests.length;
  const result = await invoke(f, ['hook', 'claude', 'Stop'], payload(f, { stop_hook_active: true }));
  assert.equal(result.exit, 0); assert.equal(result.stdout, ''); assert.equal(result.stderr, ''); assert.equal(requests.length, before);
  assert.equal(await readFile(join(f.home, 'spool.jsonl'), 'utf8'), spool);
});
test('a slow spool does not exhaust the hook budget, and delivered requests leave the spool', async () => {
  const f = await setup({ endpoint: endpoint.replace('/memhub/', '/slow/') }); await mkdir(f.home);
  await writeFile(join(f.home, 'spool.jsonl'), JSON.stringify({ ts: 'now', tool: 'litsan_turn', args: { action: 'record', turn_id: 'old' } }) + '\n');
  const input = { type: 'agent-turn-complete', cwd: f.cwd, 'thread-id': 't', 'turn-id': 'new', 'input-messages': ['Hi'], 'last-assistant-message': 'Hi' };
  const started = Date.now(), result = await invoke(f, ['hook', 'codex', JSON.stringify(input)]);
  assert.equal(result.exit, 0); assert.ok(Date.now() - started < 3000);
  // Both requests reached the slow server: the replayed one leaves the spool and the new one is not added.
  assert.deepEqual(requests.slice(-2).map(entry => entry.args.turn_id), ['old', 'codex:new']);
  assert.equal((await readFile(join(f.home, 'spool.jsonl'), 'utf8')).trim(), '');
});
test('run command still executes with invalid recorder config or initiator', async () => {
  const f = await setup(); await writeFile(f.config, '{bad');
  const argv = ['run', '--harness', 'agy', '--', process.execPath, '-e', 'process.stdout.write("ok");process.exitCode=6', '--', '-p', 'Question'];
  const result = await invoke(f, argv);
  assert.equal(result.exit, 6); assert.equal(result.stdout, 'ok'); assert.match(result.stderr, /litsan recorder/);
  await writeFile(f.config, JSON.stringify({ projects: [{ path: f.cwd, project: 'p' }], unmapped: 'skip', endpoint }));
  const before = requests.length;
  const invalid = await invoke(f, argv, '', { MEMHUB_INITIATOR: '{bad' });
  assert.equal(invalid.exit, 6); assert.equal(invalid.stdout, 'ok'); assert.equal(requests.length, before + 1);
  assert.equal(requests.at(-1).args.initiator, undefined); assert.match(invalid.stderr, /invalid LITSAN_INITIATOR/);
});
test('Claude Stop with an unreadable transcript closes the opened turn as failed', async () => {
  const f = await setup();
  const opened = await invoke(f, ['hook', 'claude', 'UserPromptSubmit'], payload(f, { prompt: 'Please fix it', transcript_path: join(f.cwd, 'missing.jsonl') }));
  const eventId = /L1 event (l1_\w+)/.exec(JSON.parse(opened.stdout).hookSpecificOutput.additionalContext)[1];
  const before = requests.length;
  const stop = await invoke(f, ['hook', 'claude', 'Stop'], payload(f, { transcript_path: join(f.cwd, 'missing.jsonl') }));
  assert.equal(stop.exit, 0); assert.equal(requests.length, before + 1);
  assert.equal(requests.at(-1).args.action, 'failed'); assert.equal(requests.at(-1).args.event_id, eventId);
  assert.equal((await state(f)).turn, undefined);
});
test('dead lock owners are reclaimed after a killed invocation', async () => {
  const f = await setup(); await mkdir(f.home);
  const dead = spawn(process.execPath, ['-e', '']); await once(dead, 'close');
  const key = createHash('sha256').update('claude:session-1').digest('hex');
  const { hostname } = await import('node:os');
  await writeFile(join(f.home, `${key}.lock`), JSON.stringify({ pid: dead.pid, host: hostname() }));
  const result = await invoke(f, ['hook', 'claude', 'UserPromptSubmit'], payload(f, { prompt: 'Recovered' }));
  assert.equal(result.exit, 0); assert.equal(result.stderr, ''); assert.ok(JSON.parse(result.stdout).hookSpecificOutput);
});
