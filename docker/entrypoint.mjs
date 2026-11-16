#!/usr/bin/env node
// LITSAN container supervisor.
//   1. First start on an empty volume: create the same state an installer
//      creates (memory-config.yaml, memhub.env, owner account, Core token).
//   2. Run scripts/run-stack.mjs (Memory Core + gateway, both on loopback).
//   3. Forward container port LITSAN_LISTEN_PORT to the loopback gateway.
//
// The gateway binds 127.0.0.1 only and treats loopback peers as local clients.
// The forwarder keeps that contract inside the container, so the published
// host port is the trust boundary: publish it on 127.0.0.1 (see compose file)
// or behind an authenticated proxy such as Cloudflare Access.
import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { join } from "node:path";

const APP = "/opt/litsan";
const setting = (name, fallback) => process.env[`LITSAN_${name}`]?.trim() || fallback;
const portSetting = (name, fallback) => {
  const value = Number(setting(name, String(fallback)));
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error(`LITSAN_${name} must be a TCP port`);
  return value;
};
const home = setting("HOME", "/data");
const corePort = portSetting("CORE_PORT", 18960);
const gatewayPort = portSetting("GATEWAY_INTERNAL_PORT", 3101);
const listenPort = portSetting("LISTEN_PORT", 3001);
// 0.0.0.0 for a bridge network (Docker publishes the port); 127.0.0.1 with host networking.
const listenHost = setting("LISTEN_HOST", "0.0.0.0");
const log = (message) => console.error(`[litsan] ${message}`);

async function writePrivate(path, content) {
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, content, { mode: 0o600 });
  await rename(temporary, path);
}

function cli(args) {
  return execFileSync(process.execPath, [join(APP, "dist", "mcp.js"), ...args], { encoding: "utf8" });
}

// Mirrors editions/common/linux/install.sh. The env-file keys keep their
// phase-3 MEMHUB_ names because scripts/run-stack.mjs accepts only those.
// memhub.env is written last and is the "initialised" marker; a start
// interrupted before it resumes safely.
async function initialise() {
  const envPath = join(home, "memhub.env");
  if (existsSync(envPath)) return false;
  const controlRoot = join(home, "server");
  const memoryDir = join(home, "memory");
  const configPath = join(home, "memory-config.yaml");
  for (const dir of [home, controlRoot, memoryDir]) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
  }

  let memoryToken = setting("MEMORY_TOKEN", "");
  if (existsSync(configPath)) {
    memoryToken = JSON.parse(await readFile(configPath, "utf8")).litsanMemory?.storage?.token || memoryToken;
  } else {
    memoryToken ||= randomBytes(32).toString("hex");
    await writePrivate(configPath, JSON.stringify({
      litsanMemory: {
        version: 1,
        userId: "local-user",
        roleRouting: { summary: "follow", evolution: "follow" },
        storage: { mode: "local", backend: "sqlite", sqlitePath: join(memoryDir, "memory.sqlite"), endpoint: `http://127.0.0.1:${corePort}`, token: memoryToken },
        algorithm: { enableMemoryAdd: true, enableMemorySearch: true, enableQueryRewrite: false },
        agentAccess: { autoScanKnownAgents: false, watchFileChanges: false, autoInjectSkill: false }
      },
      providers: {},
      modelAssignments: { default: null, memorySummary: null, memoryEvolution: null, embedding: null, asr: null, imageGeneration: null },
      modelPresets: {},
      app: {}
    }, null, 2) + "\n");
  }
  if (!memoryToken) throw new Error(`${configPath} has no storage token`);

  const username = setting("USERNAME", "local");
  const email = setting("EMAIL", "");
  const existing = JSON.parse(cli(["account", "list", "--state-root", controlRoot]))
    .find((account) => account.username === username);
  const accountId = existing?.account_id ??
    JSON.parse(cli(["account", "add", username, ...(email ? [email] : []), "--state-root", controlRoot])).account_id;
  if (!accountId) throw new Error("account creation returned no account_id");

  const publicHost = setting("PUBLIC_HOST", "");
  await writePrivate(envPath, [
    `MEMHUB_ACCOUNT_ID=${accountId}`,
    `MEMHUB_OWNER_ACCOUNT_ID=${accountId}`,
    "MEMHUB_OWNER_USER_ID=local-user",
    `MEMHUB_MEMORY_TOKEN=${memoryToken}`,
    `MEMHUB_MEMORY_URL=http://127.0.0.1:${corePort}`,
    `MEMHUB_STATE_ROOT=${controlRoot}`,
    ...(publicHost ? [`MEMHUB_PUBLIC_HOST=${publicHost}`] : []),
    ""
  ].join("\n"));
  log(`initialised ${home} (account ${username}${publicHost ? `, public host ${publicHost}` : ", loopback only"})`);
  return true;
}

await initialise();

const stack = spawn(process.execPath, [join(APP, "scripts", "run-stack.mjs"), "--home", home,
  "--core-port", String(corePort), "--gateway-port", String(gatewayPort)], {
  cwd: APP,
  stdio: ["ignore", "inherit", "inherit"],
  env: { ...process.env, LITSAN_HOME: home }
});

const forwarder = createServer((client) => {
  const upstream = connect({ host: "127.0.0.1", port: gatewayPort });
  client.pipe(upstream).pipe(client);
  const close = () => { client.destroy(); upstream.destroy(); };
  client.on("error", close);
  upstream.on("error", close);
});
forwarder.on("error", (error) => {
  log(`forwarder failed: ${error.message}`);
  stack.kill("SIGTERM");
});
forwarder.listen({ host: listenHost, port: listenPort }, () => {
  log(`MCP http://${listenHost}:${listenPort}/mcp -> gateway 127.0.0.1:${gatewayPort}; health /memhub/health`);
});

let stopping = false;
const stop = (signal) => {
  if (stopping) return;
  stopping = true;
  log(`${signal}: stopping stack`);
  forwarder.close();
  stack.kill("SIGTERM");
};
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));

stack.on("exit", (code, signal) => {
  forwarder.close();
  if (!stopping) log(`stack exited unexpectedly (code ${code}, signal ${signal})`);
  process.exit(code ?? (stopping ? 0 : 1));
});
