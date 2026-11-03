#!/usr/bin/env node
import { brand, env, legacyToolGuidance, publicHosts, warnLegacyCli } from "./brand.mjs";
import { toolForCommand, RECORDER_COMMANDS } from "./shell/cli/commands.js";
import { existsSync, realpathSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { runAccountCommand, runAdminTokenCommand } from "./cli-admin.js";
import { recoverCaptureIndex } from "./capture.js";
import { queueIdleDistillation } from "./distillation-scheduling.js";
import { unfinishedDistillationJobsForProject } from "./project-governance.js";
import { resolveControlRoot } from "./state-root.mjs";
import { JsonResultTransport } from "./result-transport.js";
import { normalizeBasePath, serveHttp } from "./gateway-http.js";
import { createLitsanRuntime, resolveLocalAccountId, type LitsanRuntime, type LitsanRuntimeOptions } from "./runtime.js";
import { registerResultTools } from "./shell/mcp/register-result.js";
import { registerTurnTools } from "./shell/mcp/register-turn.js";
import { registerContextTools } from "./shell/mcp/register-context.js";
import { registerMemoryTools } from "./shell/mcp/register-memory.js";
import { registerBranchTools } from "./shell/mcp/register-branch.js";
import { registerSkillTools } from "./shell/mcp/register-skill.js";
import { registerCardTools } from "./shell/mcp/register-card.js";
import { registerDistillTools } from "./shell/mcp/register-distill.js";
import { registerProjectsTools } from "./shell/mcp/register-projects.js";
import { assertManagedMemory, inlineJsonResult, knownProjectRecords, type ToolContext } from "./shell/mcp/shared.js";
const VERSION = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
export interface LitsanMcpOptions extends LitsanRuntimeOptions {}
export function createLitsanMcpServer(options: LitsanMcpOptions = {}): McpServer {
  const stateRoot = resolve(options.controlRoot ?? env("CONTROL_ROOT") ?? defaultStateRoot());
  const runtime = createLitsanRuntime({ ...options, controlRoot: stateRoot });
  const server = createLitsanMcpServerForRuntime(runtime, stateRoot);
  const onclose = server.server.onclose;
  server.server.onclose = () => { try { onclose?.(); } finally { runtime.dispose(); } };
  return server;
}

export function createLitsanMcpServerForRuntime(runtime: LitsanRuntime, stateRoot = defaultStateRoot()): McpServer {
  const server = new McpServer({
    name: brand.slug,
    version: VERSION,
    description: "Private account/project-scoped long-term memory and project routing. Each relevant user turn: call litsan_context, then litsan_turn open with user_text and the known project. Process any card offered by open; otherwise automatically check litsan_card next with inline_turn_event once each ordinary user turn. The server chooses 1-3 cards from backlog, with one eligible card as the minimum. Do not report busy/availability or self-select zero work; AI only distills and extracts content. Use returned input (inline_load only if absent) and submit immediately with card_id, lease_token and inline_turn_event. Process any next inline_maintenance returned by a successful submit until the server returns no next card or an error. No user click or copied task is needed. Keep card evidence separate from the normal answer. Commit the normal assistant_text before the final answer; skipping a card releases it. Host conversation/session IDs are optional provenance only: they do not select projects, branches, or distillation batches. Project-scoped tools must carry workspace_project or project from the current turn. If explicit project and workspace_project disagree after canonical resolution, LITSAN rejects the operation instead of guessing. If a project name is unknown, case-variant, or merely similar, call litsan_project_list and compare canonical slug, aliases, and description before creating anything. Project Registry mutations use litsan_project_manage plan -> explicit user authorization -> execute. Project Architecture replacements use litsan_project architecture_plan -> full-text user review -> architecture_execute. Explicit user-authored L3/L4 changes use litsan_memory plan -> full-text user review -> capture the confirmation as L1 -> execute. Project todos are first-class state." + legacyToolGuidance
  });
  const resultTransport = new JsonResultTransport(stateRoot, runtime.accountId);
  const context: ToolContext = {
    stateRoot,
    jsonResult: (value, pretty = true) => inlineJsonResult(resultTransport.wrap(value, { readOnly: true }), pretty),
    inlineJsonResult
  };
  const deps = { runtime, context };

  registerResultTools(server, { resultTransport, context });
  registerTurnTools(server, deps);
  registerContextTools(server, deps);
  registerMemoryTools(server, deps);
  registerBranchTools(server, deps);
  registerSkillTools(server, deps);
  registerDistillTools(server, deps);
  registerCardTools(server, deps);
  registerProjectsTools(server, deps);

  return server;
}

export function createLitsanMcpHandler(options: LitsanMcpOptions = {}) {
  return createMcpHandler(() => createLitsanMcpServer(options));
}

interface CliOptions extends LitsanRuntimeOptions {
  stateRoot?: string;
  httpPort?: number;
  httpPath?: string;
  basePath?: string;
  publicHost?: string;
  allowJit?: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (!next) throw new Error(`${arg} requires a value`);
      return next;
    };
    if (arg === "--account") options.accountId = value();
    else if (arg === "--state-root") options.stateRoot = value();
    else if (arg === "--memory-url") options.memoryEndpoint = value();
    else if (arg === "--memory-token") options.memoryToken = value();
    else if (arg === "--architecture-root") options.architectureRoot = value();
    else if (arg === "--no-architecture") options.disableArchitecture = true;
    else if (arg === "--normify-root") options.architectureRoot = value(); // deprecated alias
    else if (arg === "--no-normify") options.disableArchitecture = true; // deprecated alias
    else if (arg === "--owner-account") options.ownerAccountId = value();
    else if (arg === "--owner-user") options.ownerUserId = value();
    else if (arg === "--http") {
      const raw = value();
      const port = Number(raw);
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`invalid --http port: ${raw}`);
      options.httpPort = port;
    }
    else if (arg === "--http-path") {
      const path = value();
      if (!path.startsWith("/") || path.includes("?") || path.includes("#")) {
        throw new Error("--http-path must start with / and contain no query/fragment");
      }
      options.httpPath = path.length > 1 ? path.replace(/\/+$/, "") : path;
    }
    else if (arg === "--base-path") options.basePath = normalizeBasePath(value());
    else if (arg === "--public-host") {
      const host = value().trim().toLowerCase();
      if (!host || host.includes("/") || host.includes(":")) throw new Error("--public-host must be a hostname");
      options.publicHost = host;
    }
    else if (arg === "--allow-jit") options.allowJit = true;
    else if (arg === "--help" || arg === "-h") {
      process.stdout.write([
        "Usage: litsan-mcp [options]",
        "       litsan-mcp account list|add|bind-email|delete ...",
        "       litsan-mcp admin-token show|rotate [--state-root PATH]",
        "",
        "Default transport: stdio.",
        "HTTP binds only to 127.0.0.1. Local Control Plane requires the local admin token.",
        "--public-host enables Cloudflare Access JWT identity for public Control Plane/MCP requests.",
        "Unknown Cloudflare emails are denied unless --allow-jit is explicitly set."
      ].join("\n") + "\n");
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  if (argv[0] === "tools" || toolForCommand(argv[0] ?? "") || RECORDER_COMMANDS.includes(argv[0] as "hook" | "run")) {
    process.exitCode = await (await import("./shell/cli/main.js")).runToolCli(argv); return;
  }
  if (!(argv[0] === "account" && ["list", "add"].includes(argv[1] ?? ""))) warnLegacyCli(process.argv[1] ?? "", argv, process.stderr);
  if (argv[0] === "account") {
    await runAccountCommand(argv.slice(1));
    return;
  }
  if (argv[0] === "admin-token") {
    await runAdminTokenCommand(argv.slice(1));
    return;
  }
  const options = parseArgs(argv);
  const {
    stateRoot = defaultStateRoot(),
    httpPort,
    httpPath = "/mcp",
    basePath = normalizeBasePath(env("BASE_PATH")?.trim() || brand.basePath),
    publicHost,
    allowJit = env("ALLOW_JIT") === "1",
    ...runtimeOptions
  } = options;
  const effectiveRuntimeOptions: LitsanRuntimeOptions = {
    ...runtimeOptions,
    controlRoot: runtimeOptions.controlRoot ?? stateRoot
  };
  await recoverCaptureIndex(stateRoot);
  if (httpPort !== undefined) {
    await serveHttp(
      effectiveRuntimeOptions,
      { stateRoot, port: httpPort, path: httpPath, basePath, publicHosts: publicHost ? [publicHost] : publicHosts(), allowJit },
      {
        createServerForRuntime: createLitsanMcpServerForRuntime,
        queueIdleDistillation,
        unfinishedDistillationJobsForProject,
        assertManagedMemory,
        knownProjectRecords
      }
    );
    return;
  }
  console.error(`[litsan] serving stdio account=${resolveLocalAccountId(effectiveRuntimeOptions)}`);
  await serveStdio(() => createLitsanMcpServer({ ...effectiveRuntimeOptions, controlRoot: stateRoot }));
}

function defaultStateRoot(): string {
  return resolve(resolveControlRoot());
}

const invokedArg = process.argv[1];
const invokedPath = invokedArg && !invokedArg.startsWith("-") && existsSync(resolve(invokedArg))
  ? realpathSync(resolve(invokedArg))
  : "";
if (invokedPath !== "" && invokedPath === fileURLToPath(import.meta.url)) await main();
