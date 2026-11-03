import { CliUsageError, type JsonSchemaObject } from "./args.js";

export class CliTransportError extends Error {
  /** True when the request was sent but the response did not arrive in time; the server may still apply it. */
  constructor(message: string, readonly timedOut = false) { super(message); }
}

export type ToolDescription = { name: string; description: string; inputSchema: JsonSchemaObject };
type ToolError = { ok: false; error: { code: string; message: string } };
type ToolResult = { ok: true; result: unknown } | ToolError;

export function loopbackEndpoint(base: string): string {
  let url: URL;
  try { url = new URL(base); }
  catch { throw new CliUsageError("remote CLI endpoints are not supported yet; use loopback"); }
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password)
    throw new CliUsageError("remote CLI endpoints are not supported yet; use loopback");
  if (url.search || url.hash) throw new CliUsageError("CLI endpoint must not contain a query or fragment");
  return url.href.replace(/\/+$/, "");
}

async function request(base: string, timeoutMs: number, name?: string, args?: Record<string, unknown>): Promise<any> {
  const endpoint = loopbackEndpoint(base);
  try {
    const response = await fetch(endpoint + (name === undefined ? "" : `/${encodeURIComponent(name)}`), {
      method: name === undefined ? "GET" : "POST",
      ...(name === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(args) }),
      signal: AbortSignal.timeout(timeoutMs), redirect: "error"
    });
    const body = await response.json();
    if (!body || typeof body.ok !== "boolean" ||
        (body.ok === false && (typeof body.error?.code !== "string" || typeof body.error?.message !== "string")) ||
        (body.ok === true && !response.ok)) throw new Error(`Invalid tools response (HTTP ${response.status})`);
    return body;
  } catch (error) {
    if (error instanceof CliTransportError) throw error;
    throw new CliTransportError(error instanceof Error ? error.message : String(error),
      error instanceof Error && error.name === "TimeoutError");
  }
}

export async function listTools(base: string, timeoutMs: number): Promise<ToolDescription[]> {
  const body = await request(base, timeoutMs);
  if (!body.ok) throw new CliTransportError(body.error.message);
  if (!Array.isArray(body.tools) || body.tools.some((tool: ToolDescription) =>
    !tool || typeof tool.name !== "string" || typeof tool.description !== "string" ||
    !tool.inputSchema || typeof tool.inputSchema !== "object" || Array.isArray(tool.inputSchema)))
    throw new CliTransportError("Invalid tools listing");
  return body.tools;
}

export async function callTool(base: string, name: string, args: Record<string, unknown>, timeoutMs: number): Promise<ToolResult> {
  const body = await request(base, timeoutMs, name, args);
  if (body.ok && !Object.hasOwn(body, "result")) throw new CliTransportError("Invalid tool result");
  return body;
}
