import { existsSync as compatExistsSync } from "node:fs";
import { homedir as compatHomedir } from "node:os";
import { join as compatJoin } from "node:path";

// Nullish selection preserves callers' existing treatment of empty strings.
export function litsanEnv(name, source = process.env) {
    const suffix = name.replace(/^(?:LITSAN|MEMMY)_/, "");
    if (suffix === name) return source[name];
    return source[`LITSAN_${suffix}`] ?? source[`MEMMY_${suffix}`];
}
export function defaultLitsanHome(home = compatHomedir()) {
    const preferred = compatJoin(home, ".litsan");
    return compatExistsSync(preferred) ? preferred : compatJoin(home, ".memmy");
}
export function memoryConfigKey(root) {
    return Object.hasOwn(root, "litsanMemory") ? "litsanMemory"
        : Object.hasOwn(root, "memmyMemory") ? "memmyMemory" : "litsanMemory";
}
export function litsanHeader(headers, name) {
    return headers[name] ?? headers[name.replace(/^x-litsan-/, "x-memmy-")];
}
export function legacyCliNotice(argvPath, argv) {
    const name = String(argvPath ?? "").replaceAll("\\", "/").split("/").pop()?.replace(/\.(?:cmd|exe|ps1)$/i, "");
    if (!["memmy", "memmy-memory", "memmy-web"].includes(name)) return "";
    if (argv.some((arg) => /(?:json|hook|stdio|mcp)/i.test(arg))) return "";
    return `${name} is deprecated; use ${name === "memmy-web" ? "litsan-web" : "litsan-memory"}.\n`;
}
export function integrationReadUrl(value) {
    if (compatExistsSync(value)) return value;
    const oldName = (text) => text.replace(/([/\\])litsan-([^/\\]+)$/, "$1memmy-$2");
    const legacy = value instanceof URL ? new URL(oldName(value.href)) : oldName(value);
    return compatExistsSync(legacy) ? legacy : value;
}
