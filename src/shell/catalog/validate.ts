import type { ToolDefinition } from "./shared.js";

type Schema = Record<string, unknown>;
const record = (value: unknown): value is Schema => value !== null && typeof value === "object" && !Array.isArray(value);

// MCP's JSON Schema validator is SDK-internal. Match its AJV subset and error
// ordering without coupling the catalog or HTTP shell to that transport.
function errors(schema: Schema, value: unknown, path = ""): string[] {
  const issues: string[] = [];
  const add = (message: string) => { issues.push(`data${path} ${message}`); };
  if (Array.isArray(schema.anyOf)) {
    const branches = schema.anyOf as Schema[];
    if (!branches.some(branch => errors(branch, value, path).length === 0)) {
      issues.push(...branches.flatMap(branch => errors(branch, value, path)));
      add("must match a schema in anyOf");
    }
  }
  const matches = (type: unknown) => {
    if (type === "object") return record(value);
    if (type === "array") return Array.isArray(value);
    if (type === "null") return value === null;
    if (type === "integer") return typeof value === "number" && Number.isInteger(value);
    if (type === "number") return typeof value === "number" && Number.isFinite(value);
    return typeof value === type;
  };
  if (schema.type !== undefined && !(Array.isArray(schema.type) ? schema.type.some(matches) : matches(schema.type))) {
    add(`must be ${Array.isArray(schema.type) ? schema.type.join(",") : schema.type}`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.some(item => JSON.stringify(item) === JSON.stringify(value))) add("must be equal to one of the allowed values");
  if (typeof value === "number") {
    if (typeof schema.maximum === "number" && value > schema.maximum) add(`must be <= ${schema.maximum}`);
    if (typeof schema.minimum === "number" && value < schema.minimum) add(`must be >= ${schema.minimum}`);
  }
  if (typeof value === "string") {
    const length = Array.from(value).length;
    if (typeof schema.maxLength === "number" && length > schema.maxLength) add(`must NOT have more than ${schema.maxLength} characters`);
    if (typeof schema.minLength === "number" && length < schema.minLength) add(`must NOT have fewer than ${schema.minLength} characters`);
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(value)) add(`must match pattern "${schema.pattern}"`);
  }
  if (Array.isArray(value)) {
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) add(`must NOT have more than ${schema.maxItems} items`);
    if (typeof schema.minItems === "number" && value.length < schema.minItems) add(`must NOT have fewer than ${schema.minItems} items`);
    if (record(schema.items)) value.forEach((item, i) => issues.push(...errors(schema.items as Schema, item, `${path}/${i}`)));
  }
  if (record(value)) {
    const properties = record(schema.properties) ? schema.properties : {};
    if (Array.isArray(schema.required)) for (const key of schema.required as string[]) {
      if (!Object.hasOwn(value, key)) add(`must have required property '${key}'`);
    }
    if (schema.additionalProperties === false) for (const key of Object.keys(value)) {
      if (!Object.hasOwn(properties, key)) add("must NOT have additional properties");
    }
    for (const [key, child] of Object.entries(properties)) if (Object.hasOwn(value, key) && record(child)) {
      const pointer = key.replaceAll("~", "~0").replaceAll("/", "~1");
      issues.push(...errors(child, value[key], `${path}/${pointer}`));
    }
  }
  return issues;
}

export function validateToolArgs(tool: Pick<ToolDefinition, "name" | "inputSchema">, args: Record<string, unknown>): void {
  const issues = errors(tool.inputSchema, args);
  if (issues.length) throw new TypeError(`Input validation error: Invalid arguments for tool ${tool.name}: ${issues.join(", ")}`);
}
