#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { classifyExecutorFailure, summarizeArenaRows } from './real-agent-task-arena-lib.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DEFAULT_SUITE = resolve(ROOT, 'benchmarks/agent-tasks/v1/suite.json');
const args = parseArgs(process.argv.slice(2));
const suitePath = resolve(args.suite ?? DEFAULT_SUITE);
const suite = JSON.parse(await readFile(suitePath, 'utf8'));
if (!Array.isArray(suite.tasks)) throw new Error('suite.tasks must be an array');
const mode = args.mode ?? 'self-test';
const lane = args.lane ?? (mode === 'self-test' ? 'oracle' : 'memory');
const ids = new Set((args.ids ?? '').split(',').map((x) => x.trim()).filter(Boolean));
let tasks = suite.tasks.filter((task) => !ids.size || ids.has(task.id));
if (args.category) tasks = tasks.filter((task) => task.category === args.category);
if (args.limit) tasks = tasks.slice(0, Math.max(1, Number(args.limit)));
if (!tasks.length) throw new Error('no tasks selected');
if (!['self-test', 'agent'].includes(mode)) throw new Error(`unsupported --mode=${mode}`);
if (mode === 'agent' && !['baseline', 'memory'].includes(lane)) throw new Error('agent mode lane must be baseline or memory');

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const runRoot = resolve(ROOT, '.review-runtime/agent-task-arena', `${stamp}-${lane}`);
await mkdir(runRoot, { recursive: true });
const rows = [];
for (let index = 0; index < tasks.length; index += 1) {
  const task = tasks[index];
  const workspace = await prepareWorkspace(runRoot, task);
  let agent = {
    exit_code: 0,
    runtime_ms: 0,
    usage: null,
    stdout_bytes: 0,
    stderr_bytes: 0,
    final_message: '',
    ...(mode === 'agent' ? {
      executor_valid: false,
      executor_failure: { kind: 'adapter', detail: 'executor adapter did not produce a reliable result' }
    } : {})
  };
  try {
    if (mode === 'self-test') {
      await applyFiles(workspace, task.oracle?.files ?? {});
    } else {
      process.stderr.write(`[${index + 1}/${tasks.length}] ${task.id} lane=${lane}\n`);
      agent = await runCodex(workspace, buildPrompt(task, lane), Number(args.timeout_ms ?? 240000));
    }
    const evaluation = await evaluateTask(task, workspace);
    rows.push({ task_id: task.id, category: task.category, title: task.title, lane, mode, agent, ...evaluation });
  } catch (error) {
    rows.push({
      task_id: task.id, category: task.category, title: task.title, lane, mode,
      agent, task_complete: false, evaluator_error: String(error?.stack || error),
      checks_passed: 0, checks_total: task.checks?.length ?? 0, hidden_check_pass_rate: 0,
      changed_paths: [], wrong_scope_modification: false, architecture_violation_count: 0,
      stale_fact_usage_count: 0
    });
  }
  if (!args.keep_workdirs) await rm(workspace, { recursive: true, force: true });
}
const summary = summarizeArenaRows(rows);
const output = {
  schema: 'memhub-real-agent-task-arena-result-v1',
  suite: suite.name,
  suite_version: suite.version,
  generated_at: new Date().toISOString(),
  mode,
  lane,
  selected_tasks: tasks.map((t) => t.id),
  summary,
  by_category: byCategory(rows),
  rows
};
const outputPath = resolve(args.output ?? join(runRoot, 'results.json'));
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, JSON.stringify(output, null, 2) + '\n');
console.log(JSON.stringify({ output: relative(ROOT, outputPath), summary, by_category: output.by_category }, null, 2));
if (mode === 'self-test' && summary.task_completion_rate !== 1) process.exitCode = 1;

async function prepareWorkspace(runRoot, task) {
  const parent = join(runRoot, 'workspaces');
  await mkdir(parent, { recursive: true });
  const workspace = await mkdtemp(join(parent, `${safe(task.id)}-`));
  await applyFiles(workspace, task.workspace?.files ?? {});
  await run('git', ['init', '-q'], workspace, 30000);
  await run('git', ['add', '.'], workspace, 30000);
  await run('git', ['-c', 'user.email=arena@memhub.invalid', '-c', 'user.name=LITSAN Arena', 'commit', '-qm', 'baseline'], workspace, 30000);
  return workspace;
}

async function applyFiles(root, files) {
  for (const [name, content] of Object.entries(files)) {
    const path = workspacePath(root, name, 'fixture');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, String(content));
  }
}

function buildPrompt(task, lane) {
  const lines = [
    'You are completing an isolated coding benchmark task.',
    'Work only inside the current repository. Do not inspect parent directories or external benchmark files.',
    'Make the smallest correct change. Do not commit. Hidden checks evaluate behavior, scope isolation, stale decisions, and architecture constraints.',
    '',
    `TASK: ${task.prompt}`
  ];
  if (lane === 'memory') {
    lines.push('', 'MEMORY CONTEXT (authority order: CURRENT TRUTH > HANDOFF > SUPERSEDED HISTORY):');
    for (const item of task.memory?.current ?? []) lines.push(`CURRENT TRUTH: ${item}`);
    for (const item of task.memory?.handoff ?? []) lines.push(`HANDOFF: ${item}`);
    for (const item of task.memory?.superseded ?? []) lines.push(`SUPERSEDED HISTORY (do not treat as current): ${item}`);
    for (const item of task.architecture_rules ?? []) lines.push(`ARCHITECTURE CONSTRAINT: ${item}`);
  }
  lines.push('', 'Finish the implementation and verify what you can from the repository.');
  return lines.join('\n');
}

async function runCodex(workspace, prompt, timeoutMs) {
  const started = performance.now();
  const lastMessage = join(workspace, '.arena-last-message.txt');
  const model = args.model ?? 'gpt-6.1-sol';
  const effort = args.effort ?? 'medium';
  const seconds = Math.max(15, Math.ceil(timeoutMs / 1000));
  const codexArgs = [
    'exec', '--ignore-user-config', '--ignore-rules', '-m', model,
    '-c', `model_reasoning_effort=\"${effort}\"`, '--sandbox', 'workspace-write',
    '--ephemeral', '--json', '-C', workspace, '-o', lastMessage, prompt
  ];
  const result = await run(
    'timeout',
    ['--signal=TERM', '--kill-after=5s', `${seconds}s`, 'codex', ...codexArgs],
    workspace,
    timeoutMs + 10_000,
    { allowFailure: true }
  );
  const finalMessage = await readFile(lastMessage, 'utf8').catch(() => '');
  await rm(lastMessage, { force: true }).catch(() => undefined);
  // A transient reconnect can recover and finish successfully. Only terminal
  // transport failure signatures invalidate the executor row.
  const transportError = /request timed out|routing discovery timed out|http\/request failed/i.test(`${result.stdout}\n${result.stderr}`);
  const executorFailure = classifyExecutorFailure({
    exitCode: result.code,
    transportError,
    stdout: result.stdout,
    stderr: result.stderr,
    finalMessage
  });
  return {
    exit_code: result.code,
    runtime_ms: Math.round(performance.now() - started),
    usage: extractUsage(result.stdout),
    transport_error: transportError,
    executor_valid: executorFailure === null,
    executor_failure: executorFailure,
    stdout_bytes: Buffer.byteLength(result.stdout),
    stderr_bytes: Buffer.byteLength(result.stderr),
    final_message: finalMessage.slice(0, 4000)
  };
}

async function evaluateTask(task, workspace) {
  const changed = await changedPaths(workspace);
  const checkResults = [];
  for (const check of task.checks ?? []) checkResults.push(await evaluateCheck(check, task, workspace));
  const expectedMissing = (task.expected_changed_paths ?? []).filter((path) => !changed.includes(path));
  const forbiddenChanged = changed.filter((path) => (task.forbidden_changed_prefixes ?? []).some((prefix) => path.startsWith(prefix)));
  const staleHits = await scanChangedForMarkers(workspace, changed, task.stale_markers ?? []);
  const architectureFailures = checkResults.filter((x) => x.class === 'architecture' && !x.pass).length;
  const staleCheckFailures = checkResults.filter((x) => x.class === 'stale' && !x.pass).length;
  const isolationFailures = checkResults.filter((x) => x.class === 'isolation' && !x.pass).length;
  const checksPassed = checkResults.filter((x) => x.pass).length;
  const taskComplete = checksPassed === checkResults.length && expectedMissing.length === 0 && forbiddenChanged.length === 0 && staleHits.length === 0;
  return {
    task_complete: taskComplete,
    checks_passed: checksPassed,
    checks_total: checkResults.length,
    hidden_check_pass_rate: checkResults.length ? checksPassed / checkResults.length : 1,
    changed_paths: changed,
    expected_changed_paths_missing: expectedMissing,
    wrong_scope_modification: forbiddenChanged.length > 0 || isolationFailures > 0,
    wrong_scope_paths: forbiddenChanged,
    architecture_violation_count: architectureFailures,
    stale_fact_usage_count: staleCheckFailures + staleHits.length,
    stale_marker_hits: staleHits,
    checks: checkResults
  };
}

async function evaluateCheck(check, task, workspace) {
  let pass = false;
  let actual = null;
  try {
    const checkPath = check.path === undefined ? null : workspacePath(workspace, check.path);
    if (check.type === 'file_contains' || check.type === 'file_not_contains') {
      const text = await readFile(checkPath, 'utf8');
      actual = text.includes(check.text);
      pass = check.type === 'file_contains' ? actual : !actual;
    } else if (check.type === 'path_exists') {
      actual = Boolean(await stat(checkPath).catch(() => null));
      pass = actual === Boolean(check.exists);
    } else if (check.type === 'path_unchanged') {
      workspacePath(workspace, check.path);
      const diff = await run('git', ['diff', '--quiet', 'HEAD', '--', check.path], workspace, 30000, { allowFailure: true });
      const untracked = (await run('git', ['ls-files', '--others', '--exclude-standard', '--', check.path], workspace, 30000)).stdout.trim();
      actual = diff.code === 0 && !untracked;
      pass = actual;
    } else if (check.type === 'dependencies_unchanged') {
      const before = JSON.parse(task.workspace.files['package.json'] ?? '{}');
      const after = JSON.parse(await readFile(resolve(workspace, 'package.json'), 'utf8'));
      actual = { dependencies: after.dependencies ?? {}, devDependencies: after.devDependencies ?? {} };
      pass = isDeepStrictEqual(before.dependencies ?? {}, after.dependencies ?? {}) && isDeepStrictEqual(before.devDependencies ?? {}, after.devDependencies ?? {});
    } else if (check.type === 'module_call') {
      const url = `${pathToFileURL(checkPath).href}?arena=${Date.now()}-${Math.random()}`;
      const mod = await import(url);
      if (!(check.export in mod)) throw new Error(`missing export ${check.export}`);
      actual = await mod[check.export](...(check.args ?? []));
      pass = isDeepStrictEqual(actual, check.equals);
    } else {
      throw new Error(`unknown check type ${check.type}`);
    }
    return { ...check, pass, actual: jsonSafe(actual) };
  } catch (error) {
    return { ...check, pass: false, error: String(error?.message || error), actual: jsonSafe(actual) };
  }
}

function workspacePath(workspace, path, label = 'evaluator') {
  const root = resolve(workspace);
  const target = resolve(root, String(path ?? ''));
  const rel = relative(root, target);
  assert.ok(rel && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(rel), `unsafe ${label} path: ${path}`);
  return target;
}

async function changedPaths(workspace) {
  const tracked = (await run('git', ['diff', '--name-only', 'HEAD'], workspace, 30000)).stdout.split(/\r?\n/).filter(Boolean);
  const untracked = (await run('git', ['ls-files', '--others', '--exclude-standard'], workspace, 30000)).stdout.split(/\r?\n/).filter(Boolean);
  return [...new Set([...tracked, ...untracked])].filter((x) => !x.startsWith('.arena-')).sort();
}

async function scanChangedForMarkers(workspace, changed, markers) {
  const hits = [];
  if (!markers.length) return hits;
  for (const path of changed) {
    const text = await readFile(resolve(workspace, path), 'utf8').catch(() => null);
    if (text == null) continue;
    for (const marker of markers) if (text.includes(marker)) hits.push({ path, marker });
  }
  return hits;
}

function byCategory(rows) {
  return Object.fromEntries([...new Set(rows.map((r) => r.category))].sort().map((category) => [category, summarizeArenaRows(rows.filter((r) => r.category === category))]));
}

function extractUsage(stdout) {
  let merged = {};
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim().startsWith('{')) continue;
    let obj; try { obj = JSON.parse(line); } catch { continue; }
    const candidates = [];
    walk(obj, (key, value) => { if (/(input_tokens|output_tokens|cached_input_tokens|total_tokens)$/i.test(key) && Number.isFinite(Number(value))) candidates.push([key, Number(value)]); });
    for (const [key, value] of candidates) merged[key] = Math.max(Number(merged[key] ?? 0), value);
  }
  return Object.keys(merged).length ? merged : null;
}
function walk(value, fn, prefix='') {
  if (Array.isArray(value)) return value.forEach((v, i) => walk(v, fn, `${prefix}[${i}]`));
  if (!value || typeof value !== 'object') return;
  for (const [k, v] of Object.entries(value)) { const key = prefix ? `${prefix}.${k}` : k; fn(k, v); walk(v, fn, key); }
}
function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const body = arg.slice(2); const eq = body.indexOf('=');
    if (eq < 0) out[body.replaceAll('-', '_')] = true;
    else out[body.slice(0, eq).replaceAll('-', '_')] = body.slice(eq + 1);
  }
  return out;
}
function safe(value) { return String(value).replace(/[^a-zA-Z0-9._-]+/g, '-'); }
function jsonSafe(value) { if (value === undefined) return '<undefined>'; try { return JSON.parse(JSON.stringify(value)); } catch { return String(value); } }
function run(command, argv, cwd, timeoutMs, { allowFailure = false } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, argv, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', settled = false;
    const timer = setTimeout(() => { if (!settled) child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', (c) => { stdout += c.toString(); });
    child.stderr.on('data', (c) => { stderr += c.toString(); });
    child.once('error', (error) => { clearTimeout(timer); if (!settled) { settled = true; rejectRun(error); } });
    child.once('exit', (code, signal) => {
      clearTimeout(timer); if (settled) return; settled = true;
      const result = { code: code ?? 1, signal, stdout, stderr };
      if (!allowFailure && code !== 0) rejectRun(new Error(`${command} ${argv.join(' ')} failed (${code ?? signal}): ${stderr || stdout}`));
      else resolveRun(result);
    });
  });
}
