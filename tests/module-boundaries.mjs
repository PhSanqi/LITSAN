// Boundary ratchet: contracts are type-only and import only contracts; core
// imports only contracts/core or node:crypto and never reads process.env.
// Runtime importers may only shrink; Archify imports only contracts/core/archify
// or node:crypto and never reads process.env. Required shell areas may only grow.
// Moved paths are re-export-only shims. Concrete adapters must delegate to core
// and cannot introduce exported functions absent from their core module.
// Required core areas must contain TypeScript; this area list may only grow.
// Shell modules cannot import runtime/the MCP entry; MCP register modules stay
// independent and export register*Tools. Archify builders stay below HTTP/UI.
// The MCP entry's size may only shrink.
// Phase 7: private composite packages enforce contracts <- core <- archify <-
// shell. Required packages may only grow; Memory Engine exceptions only shrink.
// Builds preserve every committed dist JS path (the unused graph move is exempt).
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const sourceRoot = fileURLToPath(new URL("../src/", import.meta.url));
const portable = path => path.split(sep).join("/");
// ratchet — entries may only be removed
const runtimeAllowlist = new Set(["runtime.ts", "mcp.ts", "gateway-http.ts", "index.ts"]);
// Rule 2 type-only exceptions: { file, specifier, reason }. None are needed.
const coreTypeOnlyExceptions = [];
const movedShims = [
  "project-scope.ts", "litsan-core.ts", "retrieval-ranker.ts", "core-interfaces.ts",
  "turn-knowledge-plan.ts", "context-capsule.ts",
  "memory-visualization.ts", "architecture-cognitive-map.ts"
];
const coreAdapters = [
  ["project-governance.ts", "core/governance/project-governance.ts"],
  ["architecture-governance.ts", "core/governance/architecture-governance.ts"],
  ["distillation-evidence.ts", "core/lifecycle/distillation-evidence.ts"]
];
// ratchet — entries may only be added
const requiredCoreAreas = ["scope", "retrieval", "context", "lifecycle", "governance", "maintenance", "workstream"];
// ratchet — may only decrease
const mcpEntryMaxLines = 190;
const shellMcpRules = {
  registerModule: /^shell\/mcp\/register-[^/]+\.ts$/,
  registrationExport: /\bexport\s+function\s+register\w+Tools\s*\(/
};
// ratchet — entries may only be added
const requiredShellAreas = ["shell/mcp", "shell/archify"];
// ratchet — entries may only be added
const archifyProjectors = ["archify/memory-visualization.ts", "archify/architecture-cognitive-map.ts", "archify/architecture-graph.ts", "archify/project-map-quality.ts", "archify/map-bootstrap.ts"];
// ratchet — entries may only be added
const requiredPackages = ["contracts", "core", "archify"];
const packageDirections = { contracts: [], core: ["contracts"], archify: ["contracts", "core"] };
// Memory Engine is the fifth unit, already packaged separately at vendor/memory-core.
const memoryEngineAdapters = ["local-memory-client.ts", "embedded-memory-core.ts"];
// ratchet — entries may only be removed; existing shared sanitizer URL import
const vendorImportExceptions = ["distillation-contract.ts"];
const violations = [];
const runtimeImporters = new Set();
let registerModuleCount = 0;

async function sourceFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(entries.map(entry => {
    const path = resolve(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : /\.(?:ts|mts|mjs)$/.test(entry.name) ? [path] : [];
  }));
  return nested.flat().sort();
}

function imports(source) {
  // Static imports/re-exports, side-effect imports and dynamic (also type) import().
  const pattern = /\b(?:import|export)\s*(type\s+)?([^;"'`]*?)\s*from\s*["']([^"']+)["']|\bimport\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']|\bimport\s*\(\s*new\s+URL\s*\(\s*["']([^"']+)["']/g;
  return [...source.matchAll(pattern)].map(match => ({
    specifier: match[3] ?? match[4] ?? match[5] ?? match[6],
    typeOnly: Boolean(match[1])
  }));
}

const sameEntries = (actual, expected) => Array.isArray(actual) &&
  JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());
for (const name of requiredPackages) {
  try {
    const config = JSON.parse(await readFile(resolve(sourceRoot, name, "tsconfig.json"), "utf8"));
    const pkg = JSON.parse(await readFile(resolve(sourceRoot, name, "package.json"), "utf8"));
    const dependencies = packageDirections[name];
    const references = config.references?.map(ref => portable(relative(sourceRoot, resolve(sourceRoot, name, ref.path))));
    if (!sameEntries(references, dependencies)) violations.push(`${name}: tsconfig references must match package direction`);
    if (pkg.name !== `@phsanqi/litsan-${name}` || pkg.private !== true || pkg.type !== "module") {
      violations.push(`${name}: expected named private ESM package`);
    }
    if (!sameEntries(pkg.litsanInternalDependencies, dependencies.map(dep => `@phsanqi/litsan-${dep}`))) {
      violations.push(`${name}: internal dependencies must match package direction`);
    }
  } catch (error) {
    violations.push(`${name}: required package config missing or invalid (${error.message})`);
  }
}
const rootConfig = JSON.parse(await readFile(new URL("../tsconfig.json", import.meta.url), "utf8"));
if (!sameEntries(rootConfig.references?.map(ref => portable(relative(sourceRoot, resolve(sourceRoot, "..", ref.path)))), requiredPackages)) {
  violations.push("shell: tsconfig references must include all required packages exactly");
}
const distRoot = new URL("../dist/", import.meta.url);
if (await stat(distRoot).then(info => info.isDirectory(), error => {
  if (error.code === "ENOENT") return false;
  throw error;
})) {
  const baseline = JSON.parse(await readFile(new URL("./fixtures/p7-dist-paths.json", import.meta.url), "utf8"));
  for (const path of baseline) {
    if (!await stat(new URL(`../${path}`, import.meta.url)).then(info => info.isFile(), () => false)) {
      violations.push(`${path}: baseline dist path missing; run a clean build`);
    }
  }
} else {
  console.log("Module boundaries: dist absent; skipping emitted-path baseline check");
}

function localTarget(file, specifier) {
  if (!specifier.startsWith(".")) return null;
  return portable(relative(sourceRoot, resolve(dirname(file), specifier)))
    .replace(/\.(?:ts|mts|js|mjs)$/, "");
}

for (const exception of coreTypeOnlyExceptions) {
  if (!exception.file?.startsWith("core/") || !exception.specifier || !exception.reason?.trim()) {
    violations.push("invalid documented core type-only exception");
  }
}

const files = await sourceFiles(sourceRoot);
for (const name of archifyProjectors) {
  if (!files.includes(resolve(sourceRoot, name))) violations.push(`${name}: required projector missing`);
}
for (const area of requiredShellAreas) {
  const requiresRegister = area === "shell/mcp";
  if (!files.some(file => {
    const name = portable(relative(sourceRoot, file));
    return name.startsWith(`${area}/`) && (requiresRegister ? shellMcpRules.registerModule.test(name) : name.endsWith(".ts"));
  })) {
    violations.push(`${area}: required shell area must contain at least one ${requiresRegister ? "register module" : ".ts file"}`);
  }
}
for (const area of requiredCoreAreas) {
  if (!files.some(file => portable(relative(sourceRoot, file)).startsWith(`core/${area}/`) && file.endsWith(".ts"))) {
    violations.push(`core/${area}: required core area must contain at least one .ts file`);
  }
}
for (const name of movedShims) {
  const source = await readFile(resolve(sourceRoot, name), "utf8");
  const remaining = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, "")
    .replace(/\bexport\s+(?:type\s+)?(?:\*(?:\s+as\s+\w+)?|\{[^}]*\})\s+from\s*["']\.\/(?:core|contracts|archify)\/[^"']+["']\s*;?/g, "");
  if (remaining.trim()) violations.push(`${name}: moved shim may contain only core/contracts/archify re-exports`);
}
const exportedFunctions = source => [...source.matchAll(/\bexport\s+(?:async\s+)?function\s+(\w+)/g)].map(match => match[1]);
for (const [name, coreName] of coreAdapters) {
  const source = await readFile(resolve(sourceRoot, name), "utf8");
  const coreSource = await readFile(resolve(sourceRoot, coreName), "utf8");
  if (!imports(source).some(({ specifier }) => specifier.startsWith("./core/"))) {
    violations.push(`${name}: core adapter must import from ./core/`);
  }
  const coreFunctions = new Set(exportedFunctions(coreSource));
  for (const nameOfFunction of exportedFunctions(source)) {
    if (!coreFunctions.has(nameOfFunction)) violations.push(`${name}: adapter function ${nameOfFunction} is absent from ${coreName}`);
  }
}
for (const file of files) {
  const name = portable(relative(sourceRoot, file));
  const source = await readFile(file, "utf8");
  const contract = name.startsWith("contracts/");
  const core = name.startsWith("core/");
  const archify = name.startsWith("archify/");
  const shell = name.startsWith("shell/");
  const register = shellMcpRules.registerModule.test(name);
  if (register) {
    registerModuleCount++;
    if (!shellMcpRules.registrationExport.test(source)) {
      violations.push(`${name}: register module must export a register*Tools function`);
    }
  }
  if (name === "mcp.ts") {
    if (/\bregisterTool\s*\(/.test(source)) violations.push(`${name}: tool registration belongs in shell/mcp`);
    const lines = source.split(/\r?\n/).length - (source.endsWith("\n") ? 1 : 0);
    if (lines > mcpEntryMaxLines) violations.push(`${name}: ${lines} lines exceeds the ${mcpEntryMaxLines}-line ratchet`);
  }
  const projector = archifyProjectors.includes(name);
  if ((contract || core || archify || projector) && /\bprocess\s*\.\s*env\b/.test(source)) {
    violations.push(`${name}: process.env is forbidden`);
  }
  for (const { specifier, typeOnly } of imports(source)) {
    const target = localTarget(file, specifier);
    if (/(?:^|\/)vendor\//.test(specifier.replaceAll("\\", "/")) &&
        (contract || core || archify || (!memoryEngineAdapters.includes(name) && !vendorImportExceptions.includes(name)))) {
      violations.push(`${name}: Memory Engine vendor import is outside the adapters/legacy ratchet (${specifier})`);
    }
    if (shell && (target === "runtime" || target === "mcp")) {
      violations.push(`${name}: shell cannot import runtime or mcp (${specifier})`);
    }
    if (register && target?.startsWith("shell/mcp/register-")) {
      violations.push(`${name}: register modules cannot import register modules (${specifier})`);
    }
    if (target === "runtime") {
      runtimeImporters.add(name);
      if (!runtimeAllowlist.has(name)) violations.push(`${name}: runtime import is outside the allowlist`);
    }
    if (contract && (!target?.startsWith("contracts/") || !typeOnly)) {
      violations.push(`${name}: contracts require type-only imports from contracts (${specifier})`);
    }
    if (core && /^(?:node:)?(?:fs|http|https|net|child_process|sqlite)(?:\/|$)/.test(specifier)) {
      violations.push(`${name}: core Node I/O import is forbidden (${specifier})`);
    }
    if (core && specifier.startsWith("node:") && specifier !== "node:crypto") {
      violations.push(`${name}: core allows only node:crypto (${specifier})`);
    }
    if (core && specifier !== "node:crypto" && !target?.startsWith("contracts/") && !target?.startsWith("core/")) {
      const exception = typeOnly && coreTypeOnlyExceptions.find(item => item.file === name && item.specifier === specifier);
      if (!exception) violations.push(`${name}: core import is outside contracts/core (${specifier})`);
    }
    if (/^shell\/archify\/[^/]+\.ts$/.test(name) && target && /^(?:memory-control-|web-ui(?:$|[/-]))/.test(target)) {
      violations.push(`${name}: archify builder cannot import memory-control-* or web-ui (${specifier})`);
    }
    if ((archify || projector) && specifier !== "node:crypto" && !target?.startsWith("contracts/") && !target?.startsWith("core/") && !target?.startsWith("archify/")) {
      violations.push(`${name}: projector import is outside contracts/core/archify (${specifier})`);
    }
  }
}

console.log(`Module boundaries: ${files.length} files scanned, ${runtimeImporters.size} runtime importers, ${registerModuleCount} register modules, ${archifyProjectors.length} projectors, ${requiredPackages.length} packages, ${violations.length} violations`);
if (violations.length) {
  console.error(violations.join("\n"));
  process.exitCode = 1;
}
