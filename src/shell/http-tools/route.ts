import type { IncomingMessage, ServerResponse } from "node:http";
import { readJsonBody, asHttpJsonBodyError } from "../../http-json.js";
import { JsonResultTransport } from "../../result-transport.js";
import type { ToolCatalogDeps } from "../catalog/index.js";
import { validateToolArgs } from "../catalog/validate.js";
import { brand } from "../../brand.mjs";
import { canonicalToolName, logToolAlias } from "../../tool-aliases.js";

export function toolResponse(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent) { response.end(); return; }
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

export async function handleHttpTools(request: IncomingMessage, response: ServerResponse, pathname: string,
  runtime: ToolCatalogDeps["runtime"], stateRoot: string): Promise<void> {
  const fail = (status: number, code: string, message: string) => toolResponse(response, status, { ok: false, error: { code, message } });
  try {
    // Lazy: the catalog registers maintenance generators on import, and the
    // gateway (imported by web-ui) must stay side-effect free until a tool call.
    const { toolCatalog } = await import("../catalog/index.js");
    const resultTransport = new JsonResultTransport(stateRoot, runtime.accountId);
    const tools = toolCatalog({ runtime, context: { stateRoot }, resultTransport });
    const base = [brand.basePath, ...brand.legacyBasePaths].map(path => `${path}/api/tools`)
      .find(path => pathname === path || pathname.startsWith(`${path}/`));
    if (pathname === base) {
      if (request.method !== "GET") { response.setHeader("allow", "GET"); fail(405, "method_not_allowed", "Use GET to list tools"); return; }
      toolResponse(response, 200, { ok: true, tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
      return;
    }
    const requestedName = base ? pathname.slice(base.length + 1) : "";
    const tool = tools.find(tool => canonicalToolName(requestedName) === tool.name);
    if (!tool) { fail(404, "unknown_tool", "Unknown tool"); return; }
    if (request.method !== "POST") { response.setHeader("allow", "POST"); fail(405, "method_not_allowed", "Use POST to call a tool"); return; }
    logToolAlias(stateRoot, requestedName, tool.name);
    const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/json") { fail(415, "unsupported_media_type", "Content-Type must be application/json"); return; }
    const args = await readJsonBody(request);
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new TypeError("Tool arguments must be a JSON object");
    validateToolArgs(tool, args as Record<string, unknown>);
    const output = await tool.run(args as Record<string, unknown>);
    const result = output.kind === "json" ? resultTransport.wrap(output.value, { readOnly: true }) : output.value;
    toolResponse(response, 200, { ok: true, result });
  } catch (error) {
    const bodyError = asHttpJsonBodyError(error);
    fail(bodyError?.statusCode ?? (error instanceof TypeError ? 400 : 422),
      bodyError?.code ?? (error instanceof TypeError ? "invalid_request" : "tool_error"),
      error instanceof Error ? error.message : String(error));
  }
}
