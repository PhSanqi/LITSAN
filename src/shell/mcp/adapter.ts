import { fromJsonSchema, ProtocolError, ProtocolErrorCode, type JsonSchemaType, type McpServer } from "@modelcontextprotocol/server";
import { canonicalToolName, logToolAlias } from "../../tool-aliases.js";
import type { ToolDefinition, ToolOutput } from "../catalog/index.js";
import type { ToolContext } from "./shared.js";

export function toMcpResult(output: ToolOutput, context: ToolContext) {
  return output.kind === "json" ? context.jsonResult(output.value, output.pretty) : context.inlineJsonResult(output.value, output.pretty);
}

type InputSchema = ReturnType<typeof fromJsonSchema<Record<string, unknown>>>;
const catalogs = new WeakMap<McpServer, Map<string, { def: ToolDefinition; context: ToolContext; inputSchema: InputSchema }>>();

export function registerCatalog(server: McpServer, tools: ToolDefinition[], context: ToolContext): void {
  let catalog = catalogs.get(server);
  const first = !catalog;
  if (!catalog) { catalog = new Map(); catalogs.set(server, catalog); }
  for (const def of tools) {
    if (catalog.has(def.name)) throw new Error(`Tool name collision: ${def.name}`);
    const inputSchema = fromJsonSchema<Record<string, unknown>>(def.inputSchema as JsonSchemaType);
    catalog.set(def.name, { def, context, inputSchema });
    server.registerTool(def.name, {
      description: def.description,
      inputSchema
    }, async args => toMcpResult(await def.run(args), context));
  }
  // Test doubles expose only registerTool; real McpServer instances always carry `.server`.
  if (first && server.server) server.server.setRequestHandler("tools/call", async request => {
    const name = canonicalToolName(request.params.name);
    const entry = catalog.get(name);
    if (!entry) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Tool ${request.params.name} not found`);
    try {
      const parsed = await entry.inputSchema["~standard"].validate(request.params.arguments ?? {});
      if (parsed.issues) throw new TypeError(`Input validation error: Invalid arguments for tool ${name}: ${parsed.issues.map(issue => issue.message).join(", ")}`);
      logToolAlias(entry.context.stateRoot, request.params.name, name);
      return server.server.projectCallToolResult(toMcpResult(await entry.def.run(parsed.value), entry.context), undefined);
    } catch (error) {
      return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
    }
  });
}
