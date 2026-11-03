import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestRoot } from './test-isolation.mjs';
import { classifyExecutorFailure, compareArenaResults, summarizeArenaRows } from '../scripts/real-agent-task-arena-lib.mjs';

const repo = resolve(fileURLToPath(new URL('..', import.meta.url)));
const suite = JSON.parse(await readFile(join(repo, 'benchmarks/agent-tasks/v1/suite.json'), 'utf8'));
assert.equal(suite.version, 'real-agent-task-arena-v1');
assert.equal(suite.tasks.length, 24);
const counts = new Map();
for (const task of suite.tasks) counts.set(task.category, (counts.get(task.category) ?? 0) + 1);
assert.equal(counts.size, 6);
assert.ok([...counts.values()].every((count) => count === 4));
assert.ok(suite.tasks.every((task) => Array.isArray(task.checks) && task.checks.length > 0));
assert.ok(suite.tasks.every((task) => task.workspace?.files?.['package.json']));

assert.equal(classifyExecutorFailure({ exitCode: 0, finalMessage: 'Implemented successfully.' }), null);
assert.equal(classifyExecutorFailure({
  exitCode: 0,
  finalMessage: 'Blocked before repository inspection: every shell attempt failed with bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted.'
})?.kind, 'sandbox');
assert.equal(classifyExecutorFailure({ exitCode: 124, stderr: 'timeout' })?.kind, 'timeout');
assert.equal(classifyExecutorFailure({ exitCode: 0, transportError: true })?.kind, 'transport');
assert.equal(classifyExecutorFailure({ exitCode: 0, stderr: 'Reconnecting... 1/5', finalMessage: 'Implemented successfully.' }), null);

const infrastructureSummary = summarizeArenaRows([
  {
    mode: 'agent', category: 'x', agent: { executor_valid: false, usage: { input_tokens: 10 }, runtime_ms: 100 },
    task_complete: false, checks_passed: 1, checks_total: 2
  },
  {
    mode: 'agent', category: 'x', agent: { executor_valid: true, usage: { input_tokens: 20 }, runtime_ms: 200 },
    evaluator_error: 'synthetic evaluator crash', task_complete: false, checks_passed: 0, checks_total: 2
  },
  {
    mode: 'agent', category: 'x', agent: { executor_valid: true, usage: { input_tokens: 30 }, runtime_ms: 300 },
    task_complete: true, checks_passed: 2, checks_total: 2,
    wrong_scope_modification: false, architecture_violation_count: 0, stale_fact_usage_count: 0
  }
]);
assert.equal(infrastructureSummary.tasks, 3);
assert.equal(infrastructureSummary.valid_tasks, 1);
assert.equal(infrastructureSummary.executor_failures, 1);
assert.equal(infrastructureSummary.evaluator_failures, 1);
assert.equal(infrastructureSummary.task_completion_rate, 1);
assert.equal(infrastructureSummary.hidden_check_pass_rate, 1);
assert.deepEqual(infrastructureSummary.token_usage, { input_tokens: 30 });
assert.deepEqual(infrastructureSummary.attempt_token_usage, { input_tokens: 60 });

const paired = compareArenaResults({
  schema: 'memhub-real-agent-task-arena-result-v1', suite: 'suite', suite_version: 'v1', lane: 'baseline', rows: [
    { task_id: 'valid', category: 'x', mode: 'agent', agent: { executor_valid: true, runtime_ms: 100 }, task_complete: false, checks_passed: 1, checks_total: 2, hidden_check_pass_rate: 0.5 },
    { task_id: 'invalid', category: 'x', mode: 'agent', agent: { executor_valid: true, runtime_ms: 100 }, task_complete: false, checks_passed: 0, checks_total: 2, hidden_check_pass_rate: 0 }
  ]
}, {
  schema: 'memhub-real-agent-task-arena-result-v1', suite: 'suite', suite_version: 'v1', lane: 'memory', rows: [
    { task_id: 'valid', category: 'x', mode: 'agent', agent: { executor_valid: true, runtime_ms: 120 }, task_complete: true, checks_passed: 2, checks_total: 2, hidden_check_pass_rate: 1 },
    { task_id: 'invalid', category: 'x', mode: 'agent', agent: { executor_valid: false, executor_failure: { kind: 'sandbox' }, runtime_ms: 90 }, task_complete: false, checks_passed: 1, checks_total: 2, hidden_check_pass_rate: 0.5 }
  ]
});
assert.equal(paired.paired_valid_tasks, 1);
assert.equal(paired.invalid_pairs.length, 1);
assert.equal(paired.invalid_pairs[0].reason, 'memory_executor_invalid');
assert.equal(paired.summary.baseline.task_completion_rate, 0);
assert.equal(paired.summary.memory.task_completion_rate, 1);
assert.equal(paired.summary.delta.task_completion_rate, 1);
assert.equal(paired.summary.memory_wins, 1);

const noValidPairs = compareArenaResults({
  schema: 'memhub-real-agent-task-arena-result-v1', suite: 'suite', suite_version: 'v1', lane: 'baseline', rows: [
    { task_id: 'only', mode: 'agent', agent: { executor_valid: false } }
  ]
}, {
  schema: 'memhub-real-agent-task-arena-result-v1', suite: 'suite', suite_version: 'v1', lane: 'memory', rows: [
    { task_id: 'only', mode: 'agent', agent: { executor_valid: false } }
  ]
});
assert.equal(noValidPairs.paired_valid_tasks, 0);
assert.equal(noValidPairs.summary.delta.task_completion_rate, null);
assert.equal(noValidPairs.summary.delta.hidden_check_pass_rate, null);

const temp = await createTestRoot('real-agent-arena-e2e-');
const output = join(temp, 'self-test.json');
try {
  await run(process.execPath, ['scripts/real-agent-task-arena.mjs', '--mode=self-test', `--output=${output}`]);
  const result = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(result.summary.tasks, 24);
  assert.equal(result.summary.valid_tasks, 24);
  assert.equal(result.summary.executor_failures, 0);
  assert.equal(result.summary.evaluator_failures, 0);
  assert.equal(result.summary.completed, 24);
  assert.equal(result.summary.task_completion_rate, 1);
  assert.equal(result.summary.hidden_check_pass_rate, 1);
  assert.equal(result.summary.wrong_scope_modification_rate, 0);
  assert.equal(result.summary.architecture_violation_rate, 0);
  assert.equal(result.summary.stale_fact_usage_rate, 0);
  assert.equal(result.summary.executor_failure_rate, 0);
  assert.equal(result.summary.evaluator_failure_rate, 0);
  console.log('real-agent-task-arena-e2e: ok');
} finally {
  await rm(temp, { recursive: true, force: true });
}

function run(command, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', rejectRun);
    child.once('exit', (code) => code === 0 ? resolveRun(stdout) : rejectRun(new Error(stderr || stdout || `exit ${code}`)));
  });
}
