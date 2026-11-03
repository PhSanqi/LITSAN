import { readFileSync } from "node:fs";

export type JsonSchemaObject = {
  type?: string;
  properties?: Record<string, JsonSchemaObject>;
  required?: string[];
  enum?: unknown[];
  items?: JsonSchemaObject;
  minimum?: number;
  maximum?: number;
  [key: string]: unknown;
};

export class CliUsageError extends Error {}

function valueFor(argv: string[], index: number, inline: string | undefined, flag: string) {
  const value = inline ?? argv[index + 1];
  if (value === undefined || (inline === undefined && value.startsWith("--"))) throw new CliUsageError(`${flag} requires a value`);
  return value;
}

export function parseGlobals(argv: string[]) {
  const global = { pretty: false, endpoint: undefined as string | undefined, timeoutMs: 30000, help: false };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const [flag = "", ...parts] = argv[i]!.split("=");
    const inline = parts.length ? parts.join("=") : undefined;
    if (["--pretty", "--help", "-h"].includes(flag)) {
      if (inline !== undefined) throw new CliUsageError(`${flag} does not take a value`);
      if (flag === "--pretty") global.pretty = true;
      else global.help = true;
    } else if (flag === "--endpoint" || flag === "--timeout-ms") {
      const value = valueFor(argv, i, inline, flag);
      if (inline === undefined) i++;
      if (flag === "--endpoint") global.endpoint = value;
      else {
        const ms = Number(value);
        if (!value.trim() || !Number.isSafeInteger(ms) || ms < 1 || ms > 4294967295)
          throw new CliUsageError("--timeout-ms must be a positive integer <= 4294967295");
        global.timeoutMs = ms;
      }
    } else rest.push(argv[i]!);
  }
  return { global, rest };
}

export function propertyKind(schema: JsonSchemaObject): string {
  if (schema.anyOf || schema.oneOf || schema.allOf) return "json";
  if (schema.type === "array" && schema.items?.type === "string" && !schema.items.anyOf) return "array";
  return ["string", "integer", "number", "boolean"].includes(schema.type ?? "") ? schema.type! : "json";
}

function jsonValue(raw: string, stdinText?: string): unknown {
  try {
    return JSON.parse(raw === "-" ? (stdinText ?? readFileSync(0, "utf8")) : raw.startsWith("@") ? readFileSync(raw.slice(1), "utf8") : raw);
  } catch (error) {
    throw new CliUsageError(`Invalid JSON argument: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function parseToolArgs(argv: string[], schema: JsonSchemaObject, stdinText?: string) {
  const { global, rest } = parseGlobals(argv);
  const properties = schema.properties ?? {};
  const flags = new Map(Object.entries(properties).map(([key, value]) => [
    `--${key.replaceAll("_", "-")}${propertyKind(value) === "json" ? "-json" : ""}`, { key, kind: propertyKind(value) }
  ]));
  const explicit: Record<string, unknown> = Object.create(null);
  let base: Record<string, unknown> = {};
  let positional = false;
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!;
    if (!token.startsWith("-")) {
      if (positional || !properties.action?.enum) throw new CliUsageError(`Unexpected positional argument: ${token}`);
      explicit.action = token;
      positional = true;
      continue;
    }
    const [flag = "", ...parts] = token.split("=");
    const inline = parts.length ? parts.join("=") : undefined;
    if (flag === "--json-args") {
      const value = jsonValue(valueFor(rest, i, inline, flag), stdinText);
      if (inline === undefined) i++;
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new CliUsageError("--json-args requires a JSON object");
      base = { ...base, ...value };
      continue;
    }
    const negated = !flags.has(flag) && flag.startsWith("--no-");
    const entry = flags.get(flag) ?? (negated ? flags.get(`--${flag.slice(5)}`) : undefined);
    if (!entry || (negated && entry.kind !== "boolean")) throw new CliUsageError(`Unknown flag: ${flag}`);
    if (entry.kind === "boolean") {
      if (inline !== undefined) throw new CliUsageError(`${flag} does not take a value`);
      explicit[entry.key] = !negated;
      continue;
    }
    const raw = valueFor(rest, i, inline, flag);
    if (inline === undefined) i++;
    if (entry.kind === "json") explicit[entry.key] = jsonValue(raw, stdinText);
    else if (entry.kind === "array") explicit[entry.key] = [...(explicit[entry.key] as string[] ?? []), raw];
    else if (entry.kind === "number" || entry.kind === "integer") {
      const number = Number(raw);
      if (!raw.trim() || !Number.isFinite(number) || (entry.kind === "integer" && !Number.isInteger(number)))
        throw new CliUsageError(`${flag} requires an ${entry.kind}`);
      explicit[entry.key] = number;
    } else explicit[entry.key] = raw;
  }
  const args = { ...base, ...explicit };
  if (!global.help) {
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(args, key)) throw new CliUsageError(`Missing required property: ${key}`);
    }
    for (const [key, value] of Object.entries(args)) {
      const property = properties[key];
      if (!property) continue;
      const kind = propertyKind(property);
      if ((kind === "string" && typeof value !== "string") ||
          (kind === "boolean" && typeof value !== "boolean") ||
          (kind === "array" && (!Array.isArray(value) || value.some(item => typeof item !== "string"))) ||
          ((kind === "number" || kind === "integer") && (typeof value !== "number" || !Number.isFinite(value) || (kind === "integer" && !Number.isInteger(value)))))
        throw new CliUsageError(`${key} must be ${kind}`);
      if (property.enum && !property.enum.includes(value)) throw new CliUsageError(`${key} must be one of: ${property.enum.join(", ")}`);
      if (typeof value === "number" && ((property.minimum !== undefined && value < property.minimum) || (property.maximum !== undefined && value > property.maximum)))
        throw new CliUsageError(`${key} is outside its minimum/maximum bounds`);
    }
  }
  return { args, global };
}

export function usageFor(command: string, schema: JsonSchemaObject): string {
  const actions = schema.properties?.action?.enum;
  return [
    `Usage: litsan ${command}${actions ? ` <${actions.join("|")}>` : ""} [--flags]`,
    ...Object.entries(schema.properties ?? {}).map(([key, value]) => {
      const kind = propertyKind(value);
      return `  --${key.replaceAll("_", "-")}${kind === "json" ? "-json" : ""} <${kind === "array" ? "string[] (repeatable)" : kind}>${kind === "boolean" ? ` / --no-${key.replaceAll("_", "-")}` : ""}${value.enum ? ` (${value.enum.join("|")})` : ""}${schema.required?.includes(key) ? " (required)" : ""}`;
    }),
    "  --json-args <json|@path|->", "  --endpoint <URL>", "  --pretty <boolean>",
    "  --timeout-ms <integer> (default 30000)", "  --help, -h"
  ].join("\n") + "\n";
}
