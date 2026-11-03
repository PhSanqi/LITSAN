import assert from 'node:assert/strict';
import test from 'node:test';

import { MemoryRestContextSource } from '../dist/memory-source.js';

const emptyClient = {
  async search() {
    return { debug: { hits: [] } };
  }
};

const input = {
  accountId: 'acct',
  userId: 'user',
  query: 'What changed?',
  projectId: null,
  limit: 8,
};

function publicShape(result) {
  return Object.keys(result).sort();
}

test('legacy MemoryRestContextSource constructor remains compatible', async () => {
  const source = new MemoryRestContextSource(emptyClient);
  const result = await source.recall(input);
  assert.deepEqual(publicShape(result), ['diagnostics', 'globalMemory', 'globalState', 'projectMemory', 'reusableSkills']);
  assert.equal(result.diagnostics.version, 'retrieval-v1');
  assert.equal(result.diagnostics.rankingMode, 'memhub_v1');
});

test('memhub_core mode preserves recall response schema and is additive in diagnostics', async () => {
  const legacy = await new MemoryRestContextSource(emptyClient).recall(input);
  const core = await new MemoryRestContextSource(emptyClient, undefined, 'memhub_core').recall(input);

  assert.deepEqual(publicShape(core), publicShape(legacy));
  assert.deepEqual(Object.keys(core.globalMemory), Object.keys(legacy.globalMemory));
  assert.deepEqual(Object.keys(core.projectMemory), Object.keys(legacy.projectMemory));
  assert.deepEqual(Object.keys(core.reusableSkills), Object.keys(legacy.reusableSkills));
  assert.equal(core.diagnostics.version, legacy.diagnostics.version);
  assert.equal(core.diagnostics.rankingMode, 'memhub_core');
  assert.equal(legacy.diagnostics.rankingMode, 'memhub_v1');
  assert.equal(core.diagnostics.requestedLimit, legacy.diagnostics.requestedLimit);
  assert.equal(core.diagnostics.finalLimit, legacy.diagnostics.finalLimit);
  assert.ok(core.diagnostics.candidateLimit <= legacy.diagnostics.candidateLimit);
});
