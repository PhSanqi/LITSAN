import { toolName } from "../../brand.mjs";
import { inlineJsonResult, type ToolDefinition } from "./shared.js";
import type { JsonResultTransport } from "../../result-transport.js";
import { requiredString, optionalInteger, type CatalogContext } from "./shared.js";

export interface ResultToolDeps {
  resultTransport: Pick<JsonResultTransport, "read">;
  context: CatalogContext;
}

export function resultTools(deps: ResultToolDeps): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  const { resultTransport } = deps;
  tools.push({
    name: toolName("result"),
    description: "续取被 LITSAN 分片的 MCP JSON 结果。当返回 result_transport.mode=chunked 时，按 result_id 和 next_offset 继续读取，按 offset 拼接 result_chunk 后解析原始 JSON。短结果不经过此工具。",
    inputSchema: {
      type: "object",
      properties: {
        result_id: { type: "string", description: "大结果传输标识" },
        offset: { type: "integer", minimum: 0, description: "续取起始字符偏移量" },
        chunk_chars: { type: "integer", minimum: 10000, maximum: 200000, description: "每次续取字符数；默认 100000" }
      },
      required: ["result_id", "offset"],
      additionalProperties: false
    },
    run: async (args: Record<string, unknown>) => inlineJsonResult(resultTransport.read(
      requiredString(args.result_id, "result_id"),
      optionalInteger(args.offset) ?? 0,
      optionalInteger(args.chunk_chars) ?? 100_000
    ))
  });
  return tools;
}
