export function classifyExecutorFailure(input = {}) {
  const exitCode = Number(input.exitCode ?? 0);
  const transportError = Boolean(input.transportError);
  const text = [input.stdout, input.stderr, input.finalMessage].filter(Boolean).join('\n');

  if (transportError || /request timed out|routing discovery timed out|http\/request failed/i.test(text)) {
    return { kind: 'transport', detail: 'executor transport did not complete reliably' };
  }
  if (/bwrap:.*(?:failed rtm_newaddr|operation not permitted)|filesystem-restricted execution requires bubblewrap|blocked before repository inspection[\s\S]*bwrap/i.test(text)) {
    return { kind: 'sandbox', detail: 'executor sandbox could not start repository commands' };
  }
  if (exitCode === 124) {
    return { kind: 'timeout', detail: 'executor exceeded the benchmark time limit' };
  }
  if (exitCode !== 0) {
    return { kind: 'process_exit', detail: `executor process exited ${exitCode}` };
  }
  return null;
}

export function summarizeArenaRows(rows) {
  const attempted = rows.length;
  // Agent rows fail closed: only an explicit executor_valid=true can enter
  // quality denominators. This keeps adapter/spawn failures from silently
  // becoming task-quality failures when a row is produced from a catch path.
  const executorFailures = rows.filter((row) => row.mode === 'agent' && row.agent?.executor_valid !== true);
  const executorValidRows = rows.filter((row) => row.mode !== 'agent' || row.agent?.executor_valid === true);
  // Evaluator crashes are benchmark-infrastructure failures, not agent-memory
  // quality. Keep them visible, but exclude them from quality denominators.
  const evaluatorFailures = executorValidRows.filter((row) => Boolean(row.evaluator_error));
  const validRows = executorValidRows.filter((row) => !row.evaluator_error);
  const validN = validRows.length;
  const totalChecks = validRows.reduce((sum, row) => sum + (row.checks_total ?? 0), 0);
  const passedChecks = validRows.reduce((sum, row) => sum + (row.checks_passed ?? 0), 0);
  const usages = validRows.map((row) => row.agent?.usage).filter(Boolean);
  const attemptUsages = rows.map((row) => row.agent?.usage).filter(Boolean);
  const rate = (predicate) => validN ? validRows.filter(predicate).length / validN : null;
  return {
    tasks: attempted,
    valid_tasks: validN,
    executor_failures: executorFailures.length,
    evaluator_failures: evaluatorFailures.length,
    completed: validRows.filter((row) => row.task_complete).length,
    task_completion_rate: rate((row) => row.task_complete),
    hidden_check_pass_rate: totalChecks ? passedChecks / totalChecks : validN ? 1 : null,
    wrong_scope_modification_rate: rate((row) => row.wrong_scope_modification),
    architecture_violation_rate: rate((row) => (row.architecture_violation_count ?? 0) > 0),
    stale_fact_usage_rate: rate((row) => (row.stale_fact_usage_count ?? 0) > 0),
    avg_runtime_ms: validN ? Math.round(validRows.reduce((sum, row) => sum + Number(row.agent?.runtime_ms ?? 0), 0) / validN) : null,
    avg_attempt_runtime_ms: attempted ? Math.round(rows.reduce((sum, row) => sum + Number(row.agent?.runtime_ms ?? 0), 0) / attempted) : 0,
    token_usage: mergeUsage(usages),
    attempt_token_usage: mergeUsage(attemptUsages),
    executor_failure_rate: attempted ? executorFailures.length / attempted : 0,
    evaluator_failure_rate: attempted ? evaluatorFailures.length / attempted : 0
  };
}

export function compareArenaResults(baseline, memory) {
  if (baseline?.schema !== 'memhub-real-agent-task-arena-result-v1' || memory?.schema !== baseline.schema) {
    throw new Error('paired comparison requires two memhub-real-agent-task-arena-result-v1 artifacts');
  }
  if (baseline.suite !== memory.suite || baseline.suite_version !== memory.suite_version) {
    throw new Error('paired comparison requires identical suite and suite_version');
  }
  if (baseline.lane !== 'baseline' || memory.lane !== 'memory') {
    throw new Error('paired comparison requires baseline artifact first and memory artifact second');
  }
  const baselineRows = uniqueRowsByTaskId(baseline.rows ?? [], 'baseline');
  const memoryRows = uniqueRowsByTaskId(memory.rows ?? [], 'memory');
  const taskIds = [...new Set([...baselineRows.keys(), ...memoryRows.keys()])].sort();
  const pairs = [];
  const invalidPairs = [];
  for (const taskId of taskIds) {
    const base = baselineRows.get(taskId);
    const mem = memoryRows.get(taskId);
    const invalid = pairInvalidReason(base, mem);
    if (invalid) {
      invalidPairs.push({ task_id: taskId, ...invalid });
      continue;
    }
    const completionDelta = Number(Boolean(mem.task_complete)) - Number(Boolean(base.task_complete));
    pairs.push({
      task_id: taskId,
      category: mem.category ?? base.category,
      baseline: pairedRowView(base),
      memory: pairedRowView(mem),
      delta: {
        task_complete: completionDelta,
        hidden_check_pass_rate: numberDelta(mem.hidden_check_pass_rate, base.hidden_check_pass_rate),
        wrong_scope_modification: Number(Boolean(mem.wrong_scope_modification)) - Number(Boolean(base.wrong_scope_modification)),
        architecture_violation_count: Number(mem.architecture_violation_count ?? 0) - Number(base.architecture_violation_count ?? 0),
        stale_fact_usage_count: Number(mem.stale_fact_usage_count ?? 0) - Number(base.stale_fact_usage_count ?? 0),
        runtime_ms: Number(mem.agent?.runtime_ms ?? 0) - Number(base.agent?.runtime_ms ?? 0)
      }
    });
  }
  const pairedBaseline = pairs.map((pair) => baselineRows.get(pair.task_id));
  const pairedMemory = pairs.map((pair) => memoryRows.get(pair.task_id));
  const baseSummary = summarizeArenaRows(pairedBaseline);
  const memorySummary = summarizeArenaRows(pairedMemory);
  return {
    schema: 'memhub-real-agent-task-arena-paired-v1',
    suite: baseline.suite,
    suite_version: baseline.suite_version,
    baseline_generated_at: baseline.generated_at ?? null,
    memory_generated_at: memory.generated_at ?? null,
    tasks_union: taskIds.length,
    paired_valid_tasks: pairs.length,
    invalid_pairs: invalidPairs,
    summary: {
      baseline: baseSummary,
      memory: memorySummary,
      delta: {
        task_completion_rate: numberDelta(memorySummary.task_completion_rate, baseSummary.task_completion_rate),
        hidden_check_pass_rate: numberDelta(memorySummary.hidden_check_pass_rate, baseSummary.hidden_check_pass_rate),
        wrong_scope_modification_rate: numberDelta(memorySummary.wrong_scope_modification_rate, baseSummary.wrong_scope_modification_rate),
        architecture_violation_rate: numberDelta(memorySummary.architecture_violation_rate, baseSummary.architecture_violation_rate),
        stale_fact_usage_rate: numberDelta(memorySummary.stale_fact_usage_rate, baseSummary.stale_fact_usage_rate),
        avg_runtime_ms: numberDelta(memorySummary.avg_runtime_ms, baseSummary.avg_runtime_ms)
      },
      memory_wins: pairs.filter((pair) => pair.delta.task_complete > 0).length,
      baseline_wins: pairs.filter((pair) => pair.delta.task_complete < 0).length,
      completion_ties: pairs.filter((pair) => pair.delta.task_complete === 0).length
    },
    pairs
  };
}

function uniqueRowsByTaskId(rows, lane) {
  const result = new Map();
  for (const row of rows) {
    const taskId = String(row?.task_id ?? '').trim();
    if (!taskId) throw new Error(`${lane} artifact contains row without task_id`);
    if (result.has(taskId)) throw new Error(`${lane} artifact contains duplicate task_id ${taskId}`);
    result.set(taskId, row);
  }
  return result;
}

function pairInvalidReason(baseline, memory) {
  if (!baseline) return { reason: 'missing_baseline' };
  if (!memory) return { reason: 'missing_memory' };
  if (baseline.mode !== 'agent' || memory.mode !== 'agent') return { reason: 'non_agent_row' };
  if (baseline.agent?.executor_valid !== true) return { reason: 'baseline_executor_invalid', failure: baseline.agent?.executor_failure ?? null };
  if (memory.agent?.executor_valid !== true) return { reason: 'memory_executor_invalid', failure: memory.agent?.executor_failure ?? null };
  if (baseline.evaluator_error) return { reason: 'baseline_evaluator_invalid', failure: baseline.evaluator_error };
  if (memory.evaluator_error) return { reason: 'memory_evaluator_invalid', failure: memory.evaluator_error };
  return null;
}

function pairedRowView(row) {
  return {
    task_complete: Boolean(row.task_complete),
    hidden_check_pass_rate: row.hidden_check_pass_rate ?? null,
    wrong_scope_modification: Boolean(row.wrong_scope_modification),
    architecture_violation_count: Number(row.architecture_violation_count ?? 0),
    stale_fact_usage_count: Number(row.stale_fact_usage_count ?? 0),
    changed_paths: row.changed_paths ?? [],
    runtime_ms: Number(row.agent?.runtime_ms ?? 0),
    usage: row.agent?.usage ?? null
  };
}

function numberDelta(left, right) {
  if (left === null || left === undefined || right === null || right === undefined) return null;
  return Number.isFinite(Number(left)) && Number.isFinite(Number(right)) ? Number(left) - Number(right) : null;
}

function mergeUsage(usages) {
  const out = {};
  for (const usage of usages) {
    for (const [key, value] of Object.entries(usage)) out[key] = (out[key] ?? 0) + Number(value || 0);
  }
  return Object.keys(out).length ? out : null;
}

