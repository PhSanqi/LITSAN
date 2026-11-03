export const brand = Object.freeze({
  displayName: "LITSAN",
  slug: "litsan",
  toolPrefix: "litsan_",
  legacyToolPrefixes: ["memmy_", "memhub_"],
  envPrefixes: ["LITSAN_", "MEMHUB_", "MEMMY_"],
  headerPrefix: "x-litsan-",
  legacyHeaderPrefixes: ["x-memmy-"],
  basePath: "/litsan",
  legacyBasePaths: ["/memhub"],
  cli: "litsan",
  mcpCli: "litsan-mcp",
  legacyCliNames: ["memhub", "memhub-mcp"],
  dataDir: ".litsan",
  legacyDataDir: ".memmy"
});

/** @param {string} name @param {Record<string, string | undefined>} [values] */
export function env(name, values = process.env) {
  for (const prefix of brand.envPrefixes) {
    const value = values[`${prefix}${name}`];
    if (value !== undefined) return value;
  }
  return undefined;
}

/** @param {string} name */
export function toolName(name) {
  for (const prefix of brand.legacyToolPrefixes) {
    if (name.startsWith(prefix)) return brand.toolPrefix + name.slice(prefix.length);
  }
  return name.startsWith(brand.toolPrefix) ? name : brand.toolPrefix + name;
}

/** @param {Record<string, string | string[] | undefined>} headers @param {string} name */
export function inputHeader(headers, name) {
  for (const prefix of [brand.headerPrefix, ...brand.legacyHeaderPrefixes]) {
    const value = headers[`${prefix}${name}`];
    if (value !== undefined) return value;
  }
  return undefined;
}

export const legacyToolGuidance = " Old memmy_*/memhub_* tool names are equivalent for cached clients.";

/** @param {Record<string, string | undefined>} [values] */
export function publicHosts(values = process.env) {
  return [...new Set((env("PUBLIC_HOSTS", values) ?? env("PUBLIC_HOST", values) ?? "")
    .split(",").map(host => host.trim().toLowerCase()).filter(Boolean))];
}

/** @param {string} invoked @param {string[]} args @param {{ write(text: string): unknown }} stderr */
export function warnLegacyCli(invoked, args, stderr) {
  const name = invoked.split(/[\\/]/).pop()?.replace(/\.(?:cmd|exe|mjs|js)$/i, "");
  if (!brand.legacyCliNames.includes(name ?? "")) return;
  if (!args.length || args[0] === "hook" || args[0] === "run" ||
      args.some(arg => /^--(?:json(?:-args)?|pretty)(?:=|$)/.test(arg))) return;
  // memhub-mcp defaults to stdio, including when runtime flags are present.
  if ((name === "memhub-mcp" || args[0]?.startsWith("-")) &&
      !args.some(arg => ["--http", "--help", "-h", "account", "admin-token"].includes(arg))) return;
  stderr.write(`${name} is deprecated; use ${name === "memhub-mcp" ? brand.mcpCli : brand.cli}.\n`);
}
