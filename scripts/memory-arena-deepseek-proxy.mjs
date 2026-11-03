#!/usr/bin/env node
import http from "node:http";
import https from "node:https";
import { readFile, appendFile, mkdir, stat, mkdtemp, writeFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CONFIG = process.env.MEM_BENCH_DS_CONFIG || resolve(homedir(), ".config", "memhub", "mem-benchmark-ds.env");
const HOST = process.env.MEMORY_ARENA_PROXY_HOST || "127.0.0.1";
const PORT = Number(process.env.MEMORY_ARENA_PROXY_PORT || 19091);
const RUN_TAG = process.env.MEMORY_ARENA_RUN_TAG || "unassigned";
const MAX_CONCURRENCY = Math.max(1, Number(process.env.MEMORY_ARENA_PROXY_MAX_CONCURRENCY || 3));
const UPSTREAM_TRANSPORT = (process.env.MEMORY_ARENA_PROXY_TRANSPORT || "curl").toLowerCase();
if (!["curl", "node"].includes(UPSTREAM_TRANSPORT)) throw new Error(`Unsupported MEMORY_ARENA_PROXY_TRANSPORT=${UPSTREAM_TRANSPORT}`);
const GLOBAL_UPSTREAM_LOCK = process.env.MEMORY_ARENA_GLOBAL_UPSTREAM_LOCK !== "0";
const GLOBAL_LOCK_PATH = resolve(ROOT, ".review-runtime", "memory-arena", "deepseek-upstream.lock");
const GLOBAL_LOCK_TIMEOUT_SECONDS = Math.max(1, Number(process.env.MEMORY_ARENA_GLOBAL_LOCK_TIMEOUT_SECONDS || 185));
const SAFE_CONNECT_RETRIES = Math.max(0, Number(process.env.MEMORY_ARENA_SAFE_CONNECT_RETRIES || 2));
const UPSTREAM_RESOLVE_IP = (process.env.MEMORY_ARENA_UPSTREAM_RESOLVE_IP || "").trim();
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: MAX_CONCURRENCY, maxFreeSockets: MAX_CONCURRENCY, scheduling: "fifo" });
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: MAX_CONCURRENCY, maxFreeSockets: MAX_CONCURRENCY, scheduling: "fifo" });
let activeUpstream = 0;
const upstreamWaiters = [];
const USAGE_LOG = resolve(ROOT, ".review-runtime", "memory-arena", "deepseek-usage.jsonl");

const config = await loadConfig(CONFIG);
const baseUrl = normalizeBaseUrl(process.env.MEM_BENCH_DS_BASE_URL_OVERRIDE || config.MEM_BENCH_DS_BASE_URL);
const apiKey = config.MEM_BENCH_DS_API_KEY;
if (!apiKey) throw new Error(`MEM_BENCH_DS_API_KEY missing in ${CONFIG}`);
await mkdir(resolve(ROOT, ".review-runtime", "memory-arena"), { recursive: true });

const server = http.createServer(async (req, res) => {
  const requestStartedAt = performance.now();
  try {
    if (req.method === "GET" && req.url === "/health") {
      return json(res, 200, { ok: true, model: "deepseek-flash", thinking: "disabled", run_tag: RUN_TAG, transport: UPSTREAM_TRANSPORT, max_concurrency: MAX_CONCURRENCY, global_upstream_lock: GLOBAL_UPSTREAM_LOCK, safe_connect_retries: SAFE_CONNECT_RETRIES, active_upstream: activeUpstream, queued: upstreamWaiters.length });
    }
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      return json(res, 404, { error: { message: "Memory Arena proxy only exposes POST /v1/chat/completions" } });
    }
    const input = JSON.parse(await readBody(req));
    const body = normalizeRequest(input);
    const startedAt = performance.now();
    const upstream = await withUpstreamSlot(() => upstreamJson(`${baseUrl}/chat/completions`, apiKey, body));
    const elapsedMs = performance.now() - startedAt;
    await recordUsage(upstream, elapsedMs);
    return json(res, 200, upstream);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const upstreamStatus = Number(error?.statusCode);
    const status = Number.isInteger(upstreamStatus) && upstreamStatus >= 400 && upstreamStatus <= 599 ? upstreamStatus : 502;
    await recordFailure(message, status, performance.now() - requestStartedAt);
    return json(res, status, { error: { message } });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`memory_arena_deepseek_proxy=http://${HOST}:${PORT}/v1`);
  console.log(`upstream_host=${new URL(baseUrl).host}`);
  console.log("model=deepseek-flash");
  console.log("thinking=disabled");
  console.log(`run_tag=${RUN_TAG}`);
  console.log(`max_concurrency=${MAX_CONCURRENCY}`);
  console.log(`transport=${UPSTREAM_TRANSPORT}`);
  console.log(`global_upstream_lock=${GLOBAL_UPSTREAM_LOCK}`);
  console.log(`safe_connect_retries=${SAFE_CONNECT_RETRIES}`);
  console.log(`upstream_resolve_ip=${UPSTREAM_RESOLVE_IP || "auto"}`);
});

function normalizeRequest(input) {
  const body = { ...input };
  body.model = "deepseek-flash";
  body.thinking = { type: "disabled" };
  body.reasoning_effort = "none";
  if (body.max_completion_tokens != null && body.max_tokens == null) {
    body.max_tokens = body.max_completion_tokens;
  }
  delete body.max_completion_tokens;
  return body;
}

async function recordFailure(message, status, elapsedMs) {
  const row = {
    ts: new Date().toISOString(),
    run_tag: RUN_TAG,
    model: "deepseek-flash",
    success: false,
    http_status: status,
    error: String(message).slice(0, 1000),
    elapsed_ms: Math.round(elapsedMs)
  };
  await appendFile(USAGE_LOG, JSON.stringify(row) + "\n", { mode: 0o600 });
}

async function recordUsage(response, elapsedMs) {
  const usage = response?.usage ?? {};
  const row = {
    ts: new Date().toISOString(),
    run_tag: RUN_TAG,
    model: response?.model ?? "deepseek-flash",
    prompt_tokens: usage.prompt_tokens ?? 0,
    prompt_cache_hit_tokens: usage.prompt_cache_hit_tokens ?? 0,
    prompt_cache_miss_tokens: usage.prompt_cache_miss_tokens ?? 0,
    completion_tokens: usage.completion_tokens ?? 0,
    total_tokens: usage.total_tokens ?? 0,
    elapsed_ms: Math.round(elapsedMs)
  };
  await appendFile(USAGE_LOG, JSON.stringify(row) + "\n", { mode: 0o600 });
}

async function upstreamJson(url, key, body) {
  return UPSTREAM_TRANSPORT === "node" ? nodeJson(url, key, body) : curlJson(url, key, body);
}

async function nodeJson(url, key, body) {
  const target = new URL(url);
  const payload = JSON.stringify(body);
  const isHttps = target.protocol === "https:";
  const client = isHttps ? https : http;
  const agent = isHttps ? httpsAgent : httpAgent;
  return await new Promise((resolvePromise, reject) => {
    const req = client.request(target, {
      method: "POST",
      agent,
      family: 4,
      headers: {
        "Authorization": `Bearer ${key}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        "Connection": "keep-alive"
      }
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch {
          const err = new Error(`DeepSeek upstream returned invalid JSON (${res.statusCode}): ${text.slice(0, 500)}`);
          err.statusCode = res.statusCode || 502;
          reject(err);
          return;
        }
        if ((res.statusCode || 500) < 200 || (res.statusCode || 500) >= 300) {
          const err = new Error(`DeepSeek upstream HTTP ${res.statusCode}: ${text.slice(0, 500)}`);
          err.statusCode = res.statusCode || 502;
          reject(err);
          return;
        }
        resolvePromise(parsed);
      });
    });
    const hardTimer = setTimeout(
      () => req.destroy(new Error("DeepSeek upstream hard deadline after 180s")),
      180000
    );
    hardTimer.unref?.();
    req.once("close", () => clearTimeout(hardTimer));
    req.setTimeout(180000, () => req.destroy(new Error("DeepSeek upstream inactivity timeout after 180s")));
    req.on("error", reject);
    req.end(payload);
  });
}

async function withUpstreamSlot(fn) {
  if (activeUpstream >= MAX_CONCURRENCY) {
    await new Promise((resolveWaiter) => upstreamWaiters.push(resolveWaiter));
  }
  activeUpstream += 1;
  try {
    return await fn();
  } finally {
    activeUpstream -= 1;
    const next = upstreamWaiters.shift();
    if (next) next();
  }
}

async function curlJson(url, key, body) {
  const temp = await mkdtemp(join(tmpdir(), "memhub-arena-ds-"));
  const bodyPath = join(temp, "body.json");
  await writeFile(bodyPath, JSON.stringify(body), { mode: 0o600 });
  const configText = [
    `url = \"${escapeCurlConfig(url)}\"`,
    `header = \"Authorization: Bearer ${escapeCurlConfig(key)}\"`,
    `header = \"Content-Type: application/json\"`,
    `data-binary = \"@${escapeCurlConfig(bodyPath)}\"`,
    "silent",
    "show-error",
    "fail-with-body",
    "ipv4",
    ...(UPSTREAM_RESOLVE_IP ? [`resolve = "${new URL(url).hostname}:443:${escapeCurlConfig(UPSTREAM_RESOLVE_IP)}"`] : []),
    // Chat completions are POSTs and may already have been processed upstream
    // when a transport failure is observed. Do not retry inside curl: the
    // checkpoint-aware ANSWER/EVAL client owns retries, avoiding multiplicative
    // duplicate requests (curl retries × outer LLM retries).
    "http1.1",
    "connect-timeout = 8",
    "max-time = 180"
  ].join("\n") + "\n";
  try {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const output = await runCurl(configText);
        return JSON.parse(output);
      } catch (error) {
        if (attempt >= SAFE_CONNECT_RETRIES || !isSafePreRequestCurlFailure(error)) throw error;
        await sleepMs(500 * (2 ** attempt));
      }
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

function runCurl(configText) {
  return new Promise((resolvePromise, reject) => {
    let stdout = "";
    let stderr = "";
    const command = GLOBAL_UPSTREAM_LOCK ? "flock" : "curl";
    const args = GLOBAL_UPSTREAM_LOCK
      ? ["-w", String(GLOBAL_LOCK_TIMEOUT_SECONDS), GLOBAL_LOCK_PATH, "curl", "--config", "-"]
      : ["--config", "-"];
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolvePromise(stdout);
        return;
      }
      const err = new Error(`DeepSeek transport failed (curl ${code}): ${stderr.trim() || stdout.slice(0, 500)}`);
      err.curlCode = code;
      err.curlStderr = stderr;
      reject(err);
    });
    child.stdin.end(configText);
  });
}

function isSafePreRequestCurlFailure(error) {
  const code = Number(error?.curlCode);
  const text = String(error?.curlStderr || error?.message || "").toLowerCase();
  if ([6, 7, 35].includes(code)) return true;
  if (code === 28 && (text.includes("ssl connection timeout") || text.includes("failed to connect") || text.includes("connection timed out"))) return true;
  return false;
}

function sleepMs(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function loadConfig(path) {
  const info = await stat(path);
  if ((info.mode & 0o077) !== 0) throw new Error(`${path} must not be group/world accessible`);
  const text = await readFile(path, "utf8");
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out[match[1]] = value;
  }
  return out;
}

function normalizeBaseUrl(value) {
  if (!value) throw new Error("MEM_BENCH_DS_BASE_URL is missing");
  let url = value.trim().replace(/\/$/, "");
  if (/api\.deepseek\.comv1$/i.test(url)) throw new Error("MEM_BENCH_DS_BASE_URL is malformed: expected https://api.deepseek.com or https://api.deepseek.com/v1");
  if (url.endsWith("/v1")) return url;
  return `${url}/v1`;
}

function escapeCurlConfig(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function readBody(req) {
  return new Promise((resolvePromise, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 16 * 1024 * 1024) reject(new Error("request body too large"));
    });
    req.on("end", () => resolvePromise(body));
    req.on("error", reject);
  });
}

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

