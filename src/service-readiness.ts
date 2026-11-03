import { readFileSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type LitsanServiceKind = "core" | "gateway";

export interface ServiceProbe {
  ok: boolean;
  status: number | null;
  reason: string;
}

export interface ServiceBuildIdentity {
  vendorSha256: string | null;
  litsanVersion: string | null;
}

export interface ServiceHealthProbe extends ServiceProbe {
  degraded: string[];
  build?: ServiceBuildIdentity;
}

/**
 * The build of this installation: the audited vendor tree hash and the LITSAN
 * package version. Both are read from the running distribution, so a gateway
 * and the Core it supervises should report the same values.
 */
export function readLocalBuildIdentity(): ServiceBuildIdentity {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const readJson = (path: string): unknown => {
    try {
      return JSON.parse(readFileSync(path, "utf8")) as unknown;
    } catch {
      return undefined;
    }
  };
  const manifest = readJson(join(root, "vendor", "manifest.json"));
  const packageJson = readJson(join(root, "package.json"));
  const components = (manifest as { components?: { memory?: { sha256?: unknown } } } | undefined)?.components;
  const vendorSha256 = components?.memory?.sha256;
  const litsanVersion = (packageJson as { version?: unknown } | undefined)?.version;
  return {
    vendorSha256: typeof vendorSha256 === "string" ? vendorSha256 : null,
    litsanVersion: typeof litsanVersion === "string" ? litsanVersion : null
  };
}

export function buildIdentitiesMatch(expected: ServiceBuildIdentity, actual: ServiceBuildIdentity | undefined): boolean {
  if (!actual) return false;
  if (!expected.vendorSha256 || !actual.vendorSha256 || expected.vendorSha256 !== actual.vendorSha256) return false;
  if (!expected.litsanVersion || !actual.litsanVersion || expected.litsanVersion !== actual.litsanVersion) return false;
  return true;
}

export function assertLoopbackHealthUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash) {
    throw new Error("LITSAN service readiness requires a plain loopback HTTP URL");
  }
  return url;
}

export async function probeService(url: string, kind: LitsanServiceKind, timeoutMs = 1_000): Promise<ServiceProbe> {
  const { ok, status, reason } = await probeServiceHealth(url, kind, timeoutMs);
  return { ok, status, reason };
}

/**
 * Detailed readiness probe. `degraded` names unhealthy optional parts (for
 * example an embedder error) that do not by themselves block startup; only
 * schema readiness does. The gateway report is returned unchanged so callers
 * can compare its build with the Core's.
 */
export async function probeServiceHealth(
  url: string,
  kind: LitsanServiceKind,
  timeoutMs = 1_000
): Promise<ServiceHealthProbe> {
  assertLoopbackHealthUrl(url);
  try {
    const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return { ok: false, status: response.status, reason: `http_${response.status}`, degraded: [] };
    const data: unknown = await response.json();
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return { ok: false, status: response.status, reason: "invalid_health_payload", degraded: [] };
    }
    const object = data as Record<string, unknown>;
    const degraded = Array.isArray(object.degraded)
      ? object.degraded.filter((item): item is string => typeof item === "string")
      : [];
    const build = parseBuildIdentity(object.build);
    if (kind === "core") {
      const storage = object.storage;
      if (typeof object.serviceVersion !== "string" ||
          !Number.isSafeInteger(object.protocolVersion) || Number(object.protocolVersion) < 1 ||
          !storage || typeof storage !== "object" || Array.isArray(storage) ||
          (storage as Record<string, unknown>).ready !== true) {
        return { ok: false, status: response.status, reason: "core_not_ready", degraded, ...(build ? { build } : {}) };
      }
      // `ok: false` because of an embedder/summary error is reported through
      // `degraded` but does not block startup; a non-zero schema is ready.
      return { ok: true, status: response.status, reason: "ready", degraded, ...(build ? { build } : {}) };
    }
    if (object.ok !== true || object.service !== "memhub") {
      return { ok: false, status: response.status, reason: "unexpected_service", degraded, ...(build ? { build } : {}) };
    }
    return { ok: true, status: response.status, reason: "ready", degraded, ...(build ? { build } : {}) };
  } catch (error) {
    return { ok: false, status: null, reason: error instanceof Error ? error.name : "connection_error", degraded: [] };
  }
}

export function parseBuildIdentity(value: unknown): ServiceBuildIdentity | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  const litsanVersion = candidate.litsanVersion ?? candidate.memhubVersion; // Legacy Core wire identity until C3 is installed.
  if (typeof candidate.vendorSha256 !== "string" || typeof litsanVersion !== "string") return undefined;
  return { vendorSha256: candidate.vendorSha256, litsanVersion };
}

export async function waitForService(options: {
  url: string;
  kind: LitsanServiceKind;
  timeoutMs?: number;
  intervalMs?: number;
  probeTimeoutMs?: number;
  signal?: AbortSignal;
  isAlive?: () => boolean;
  /** Required Core build; a mismatch fails immediately instead of timing out. */
  expectedBuild?: ServiceBuildIdentity;
}): Promise<ServiceHealthProbe> {
  assertLoopbackHealthUrl(options.url);
  const timeoutMs = options.timeoutMs ?? 20_000;
  const intervalMs = options.intervalMs ?? 200;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300_000 ||
      !Number.isInteger(intervalMs) || intervalMs < 10 || intervalMs > 10_000) {
    throw new RangeError("invalid service readiness timeout/interval");
  }
  const deadline = Date.now() + timeoutMs;
  let lastReason = "not_checked";
  while (Date.now() < deadline) {
    if (options.signal?.aborted) throw new Error(`${options.kind} startup cancelled`);
    if (options.isAlive && !options.isAlive()) throw new Error(`${options.kind} process exited before readiness`);
    const probe = await probeServiceHealth(
      options.url,
      options.kind,
      Math.min(options.probeTimeoutMs ?? 1_000, Math.max(100, deadline - Date.now()))
    );
    if (probe.ok) {
      if (options.isAlive && !options.isAlive()) throw new Error(`${options.kind} process exited during readiness`);
      if (options.kind === "core" && options.expectedBuild &&
          (options.expectedBuild.vendorSha256 || options.expectedBuild.litsanVersion) &&
          !buildIdentitiesMatch(options.expectedBuild, probe.build)) {
        const expected = describeBuild(options.expectedBuild);
        const actual = probe.build ? describeBuild(probe.build) : "no build identity";
        throw new Error(
          `core build mismatch: Core reports ${actual} but this LITSAN installation is ${expected}; ` +
          "the running Memory Core is stale after an upgrade — restart or reinstall the stack"
        );
      }
      return probe;
    }
    lastReason = probe.reason;
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, Math.min(intervalMs, Math.max(0, deadline - Date.now()))));
  }
  throw new Error(`${options.kind} readiness timeout (${lastReason})`);
}

function describeBuild(build: ServiceBuildIdentity): string {
  return `vendor ${build.vendorSha256 ?? "<unknown>"} / litsan ${build.litsanVersion ?? "<unknown>"}`;
}

export async function loopbackPortOccupied(url: string, timeoutMs = 400): Promise<boolean> {
  const parsed = assertLoopbackHealthUrl(url);
  const port = Number(parsed.port || 80);
  return new Promise((resolveOccupied) => {
    const socket = connect({ host: parsed.hostname === "[::1]" ? "::1" : parsed.hostname, port });
    const done = (occupied: boolean) => { socket.destroy(); resolveOccupied(occupied); };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(timeoutMs, () => done(false));
  });
}
