export * from "../catalog/shared.js";

export interface ToolContext {
  stateRoot: string;
  jsonResult(value: unknown, pretty?: boolean): ReturnType<typeof inlineJsonResult>;
  inlineJsonResult: typeof inlineJsonResult;
}

export function inlineJsonResult(value: unknown, pretty = true) {
  return { content: [{ type: "text" as const, text: pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value) }] };
}
