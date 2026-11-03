// API-only subprocess fixture: never invokes the MCP/CLI entry point.
import { serveHttp } from '../../dist/gateway-http.js';
import { createLitsanMcpServerForRuntime } from '../../dist/mcp.js';
import { queueIdleDistillation } from '../../dist/distillation-scheduling.js';
import { unfinishedDistillationJobsForProject } from '../../dist/project-governance.js';
import { assertManagedMemory, knownProjectRecords } from '../../dist/shell/mcp/shared.js';

const { stateRoot, accountId, memoryEndpoint, basePath = '/litsan', publicHost, port = 0, disableArchitecture = true } = JSON.parse(process.argv[2]);
await serveHttp({ controlRoot: stateRoot, accountId, memoryEndpoint, memoryToken: '', disableArchitecture },
  { stateRoot, port, path: '/mcp', basePath, publicHost, allowJit: false }, {
    createServerForRuntime: createLitsanMcpServerForRuntime,
    queueIdleDistillation, unfinishedDistillationJobsForProject, assertManagedMemory, knownProjectRecords
  });
