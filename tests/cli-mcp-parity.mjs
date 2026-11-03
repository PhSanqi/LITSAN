import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { toolCatalog } from '../dist/shell/catalog/index.js';
import { maintenanceGenerators } from '../dist/core/maintenance/registry.js';
import { createLitsanRuntime } from '../dist/runtime.js';
import { JsonResultTransport } from '../dist/result-transport.js';
import { CLI_COMMANDS, RECORDER_COMMANDS } from '../dist/shell/cli/commands.js';
import { usageFor } from '../dist/shell/cli/args.js';
import { createTestRoot } from './test-isolation.mjs';

test('catalog registers arch_review without loading the MCP adapter', () => {
  assert.ok(maintenanceGenerators.has('arch_review'));
});

// hook/run are passive harness entry points, not MCP tools. Explicitly exclude
// them from catalog parity while keeping every actual tool command covered.
test('recorder commands are explicitly outside the MCP parity map', () => {
  assert.deepEqual([...RECORDER_COMMANDS], ['hook', 'run']);
  for (const command of RECORDER_COMMANDS) assert.equal(Object.hasOwn(CLI_COMMANDS, command), false);
});

test('CLI commands, catalog and MCP expose identical tools and schemas in registration order', async () => {
  const root = await createTestRoot('cli-mcp-parity-');
  const runtime = createLitsanRuntime({ controlRoot: root, projectRegistryPath: join(root, 'project-registry.json'),
    branchesPath: join(root, 'project-branches.json'), accountId: 'parity', disableArchitecture: true,
    memoryEndpoint: 'http://127.0.0.1:1', memoryToken: '' });
  const { createLitsanMcpServerForRuntime } = await import('../dist/mcp.js');
  const server = createLitsanMcpServerForRuntime(runtime, root);
  const client = new Client({ name: 'cli-parity-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const catalog = toolCatalog({ runtime, context: { stateRoot: root }, resultTransport: new JsonResultTransport(root, runtime.accountId) });
    const { tools } = await client.listTools();
    const names = tools.map(tool => tool.name);
    assert.ok(names.every(name => name.startsWith("litsan_")));
    assert.equal(new Set(names).size, names.length);
    assert.deepEqual(catalog.map(tool => tool.name), names);
    assert.deepEqual([...new Set(Object.values(CLI_COMMANDS))].sort(), [...names].sort());
    for (const tool of catalog) {
      const advertised = tools.find(item => item.name === tool.name);
      assert.deepEqual(tool.inputSchema, advertised.inputSchema, tool.name);
      assert.equal(tool.description, advertised.description, tool.name);
      const command = Object.keys(CLI_COMMANDS).find(key => CLI_COMMANDS[key] === tool.name);
      assert.ok(command, `${tool.name} needs a CLI command`);
      const usage = usageFor(command, tool.inputSchema);
      for (const key of Object.keys(tool.inputSchema.properties ?? {})) {
        if (key === 'action' && tool.inputSchema.properties.action.enum) continue;
        assert.ok(usage.includes(`--${key.replaceAll('_', '-')}`), `${tool.name}.${key} must be reachable from CLI`);
      }
    }
  } finally {
    await client.close();
    await server.close();
    runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
