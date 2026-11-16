#!/usr/bin/env node
// Docker HEALTHCHECK: the gateway health route, which also reports Core reachability.
const port = Number(process.env.LITSAN_GATEWAY_INTERNAL_PORT || 3101);
try {
  const response = await fetch(`http://127.0.0.1:${port}/memhub/health`, { signal: AbortSignal.timeout(4000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  process.exit(0);
} catch (error) {
  console.error(`litsan unhealthy: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
