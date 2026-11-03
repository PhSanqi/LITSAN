# Real Agent Task Arena v1

## Purpose

Real Agent Task Arena complements retrieval/answer benchmarks by measuring whether memory actually helps a coding agent finish work correctly. It is intentionally downstream of LoCoMo/Memory Arena, LongMemEval-S, Memora/FAMA and the P0 real-pipeline suite.

It does **not** change LITSAN's governed Project Architecture or production runtime. All workspaces are isolated development fixtures under `.review-runtime/agent-task-arena/`.

## What the six task families measure

| Family | Primary failure mode |
| --- | --- |
| `interrupted_resume` | A fresh agent cannot recover the exact remaining work from an interrupted session. |
| `stale_decision` | Old decisions are followed after Current Truth superseded them. |
| `project_isolation` | The correct fix is made in the wrong sibling project/account/client too. |
| `architecture_constraint` | The task is completed by violating a durable architecture rule. |
| `provenance_debug` | Prior reproduction/root-cause evidence is not converted into the correct repair. |
| `cross_session_handoff` | A finalized design/review contract is lost between sessions. |

v1 contains 24 deterministic tasks, four per family.

## Lanes

- `baseline`: the same coding agent receives only the task prompt and repository.
- `memory`: the same coding agent receives task prompt plus Current Truth, handoff/provenance, explicit architecture constraints and clearly marked superseded history.
- `oracle`: no model is used. The known correct patch is applied only to validate the evaluator itself.

The first comparison should keep agent model, tool permissions and task set identical across `baseline` and `memory`.

## Primary scoring

LLM judging is not a primary success signal. Hidden deterministic checks evaluate:

- `task_completion_rate`
- `hidden_check_pass_rate`
- `wrong_scope_modification_rate`
- `architecture_violation_rate`
- `stale_fact_usage_rate`
- changed paths / diff footprint
- agent runtime and token usage when the adapter exposes it

A task passes only when every hidden functional check passes, required target files were actually changed, no forbidden scope was modified, and no known stale marker survives in changed output.

Executor validity is a hard gate before those quality metrics. A model process that exits successfully but cannot actually inspect/edit the repository because its sandbox or transport is broken is recorded with `agent.executor_valid=false` and an `executor_failure` class. Adapter/spawn failures also fail closed: an agent row enters quality denominators only when `executor_valid=true` is explicit. Evaluator crashes are tracked separately as `evaluator_failures` and are also excluded from memory-quality denominators. Attempted rows and their runtime/token spend remain visible through attempt-level metrics. `valid_tasks`, `executor_failures`, `evaluator_failures` and their failure rates make the distinction explicit. This prevents benchmark infrastructure failures from masquerading as memory failures.

## Relationship to existing benchmarks

- **LoCoMo / Memory Arena:** long-dialogue QA, multi-hop and temporal answer quality.
- **LongMemEval-S:** long-history evidence retrieval quality.
- **Memora/FAMA:** current-state validity, update/delete semantics and forgotten-fact pollution.
- **P0 real-pipeline:** project/account isolation and retrieval authority through the real Core path.
- **Real Agent Task Arena:** whether an agent can turn remembered state into a correct code change under hidden checks.

A strong retrieval score therefore does not substitute for Real Agent Task Arena, and Arena does not substitute for retrieval diagnostics. The two layers locate different failures.

## Commands

Evaluator self-test:

```bash
npm run benchmark:agent:arena:self-test
```

Small memory-lane pilot with the installed Codex CLI:

```bash
node scripts/real-agent-task-arena.mjs \
  --mode=agent \
  --lane=memory \
  --ids=resume-retry-delay,stale-api-path,debug-env-rename
```

Run the exact same IDs with `--lane=baseline` for the paired comparison. Full sweeps should only follow after a small pilot validates the agent adapter and task difficulty.

Paired comparison is deliberately a separate offline step so infrastructure validity is checked before any A/B delta is reported:

```bash
node scripts/real-agent-task-arena-compare.mjs \
  --baseline=.review-runtime/agent-task-arena/baseline.json \
  --memory=.review-runtime/agent-task-arena/memory.json \
  --output=.review-runtime/agent-task-arena/paired.json
```

Only task IDs present on both sides with `executor_valid=true` and no evaluator error enter paired quality metrics. Missing rows, one-sided executor failures and evaluator failures are listed under `invalid_pairs`; they never enter the A/B denominator.
