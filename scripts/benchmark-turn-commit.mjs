// Synthetic-only benchmark / 仅使用合成数据；never reads ~/.memmy.
import assert from 'node:assert/strict';
import { mkdir, writeFile, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createTestRoot, isolateTestEnvironment } from '../tests/test-isolation.mjs';
import { createLitsanRuntime } from '../dist/runtime.js';
import { turnTools } from '../dist/shell/catalog/turn.js';
import { closeCaptureIndexDb, storeCaptureEvent, markCaptureIngested } from '../dist/capture.js';
import { setDistillationConfig } from '../dist/distillation-jobs.js';
import { setMaintenanceConfig } from '../dist/maintenance-store.js';

const requestedTmpdir = process.env.TMPDIR;
const root = await createTestRoot('turn-commit-benchmark-');
isolateTestEnvironment(root, root);
if (requestedTmpdir) process.env.TMPDIR = requestedTmpdir;
const runtime = createLitsanRuntime({ accountId: 'bench', controlRoot: root, disableArchitecture: true,
  memoryEndpoint: 'http://127.0.0.1:1', memoryToken: '', source: { platform: 'benchmark', transport: 'local' } });
runtime.memoryClient.openSession = async () => ({});
runtime.memoryClient.completeTurn = async () => ({});
runtime.memoryClient.search = async () => ({ hits: [] });
runtime.memoryClient.viewerGet = async () => ({ items: [], hasNext: false });
const call = turnTools({ runtime, context: { stateRoot: root } })[0].run;
const unwrap = result => result.value;
const now = new Date().toISOString();
try {
  await runtime.projects.create('bench', { projectId: 'demo', name: 'Demo', description: 'Synthetic benchmark' });
  await setDistillationConfig(root, { auto_enabled: true, auto_since: '2020-01-01T00:00:00.000Z', turn_threshold: 2 });
  await setMaintenanceConfig(root, { conversation_maintenance: 'quiet', delegate_min_interval_s: 0 });
  const evidence = [{ ref: 'l1:synthetic', kind: 'turn', layer: 'L1', timestamp: now, user_text: 'synthetic', assistant_text: 'x'.repeat(30000) }];
  const jobs = Array.from({ length: 1000 }, (_, i) => ({ job_id: `history-${i}`, account_id: 'bench', target: 'l2', scope: 'project',
    project_id: 'demo', status: 'completed', result_kind: 'noop', reason: 'manual', created_at: now, updated_at: now,
    evidence_hash: `history-${i}`, evidence_refs: ['l1:synthetic'], evidence }));
  const ledger = join(root, 'distillation', 'jobs.json');
  await mkdir(join(root, 'distillation'), { recursive: true });
  await writeFile(ledger, JSON.stringify({ version: 2, jobs }));
  const bytes = (await stat(ledger)).size;
  assert.ok(bytes >= 30_000_000);
  // Six waiting captures force several enqueue/split mutations in one commit.
  for (let i = 0; i < 6; i++) {
    const event_id = `waiting-${i}`;
    await storeCaptureEvent(root, { account_id: 'bench', actor_id: 'mcp:local' }, { event_id, host: 'benchmark',
      conversation_id: 'benchmark', continuity_id: 'benchmark', timestamp: now, project_hint: 'demo',
      user_text: 'Synthetic request', assistant_text: 'y'.repeat(9000), capture_status: 'complete' });
    await markCaptureIngested(root, 'bench', event_id);
  }
  const opened = unwrap(await call({ action: 'open', project: 'demo', conversation_id: 'benchmark', user_text: 'Synthetic request' }));
  const args = { action: 'commit', project: 'demo', event_id: opened.event_id, conversation_id: 'benchmark',
    assistant_text: 'Synthetic result', client_profile: { execution: 'delegate' } };
  const measure = async input => {
    const started = performance.now(), result = unwrap(await call(input));
    assert.equal(result.ingested, true);
    assert.equal(result.distillation_queue_error, undefined);
    return Math.round((performance.now() - started) * 100) / 100;
  };
  const normal_ms = await measure(args);
  const repeat_ms = await measure(args);
  const warm = unwrap(await call({ action: 'open', project: 'demo', conversation_id: 'benchmark', user_text: 'Another synthetic request' }));
  const warm_normal_ms = await measure({ ...args, event_id: warm.event_id });
  console.log(JSON.stringify({ synthetic: true, ledger_bytes: bytes, historical_jobs: jobs.length, waiting_captures: 6, normal_ms, repeat_ms, warm_normal_ms }));
} finally {
  runtime.dispose(); closeCaptureIndexDb(root);
  await rm(root, { recursive: true, force: true });
}
