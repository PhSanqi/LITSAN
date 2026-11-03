import { defaultLitsanHome, litsanEnv } from "../utils/litsan-compat.js";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import YAML from "yaml";
export const DEFAULT_MEMORY_URL = "http://127.0.0.1:18960";
export function loadCliMemoryConfig(configPath) {
    const selectedPath = configPath
        ? resolve(expandHome(configPath))
        : defaultConfigPaths().find((candidate) => existsSync(candidate));
    const rootConfig = selectedPath && existsSync(selectedPath)
        ? parseConfigFile(selectedPath)
        : {};
    const litsanMemory = asRecord((rootConfig.litsanMemory ?? rootConfig.memmyMemory));
    const storage = asRecord(litsanMemory.storage);
    const app = asRecord(rootConfig.app);
    return {
        config: {
            endpoint: optionalString(litsanEnv("LITSAN_MEMORY_URL", process.env)) ??
                optionalString(process.env.MEMORY_SERVICE_URL) ??
                optionalString(storage.endpoint) ??
                optionalString(litsanMemory.endpoint),
            token: optionalString(litsanEnv("LITSAN_MEMORY_TOKEN", process.env)) ??
                optionalString(process.env.MEMORY_SERVICE_TOKEN) ??
                optionalString(storage.token) ??
                optionalString(litsanMemory.token),
            userId: optionalString(litsanEnv("LITSAN_MEMORY_USER_ID", process.env)) ??
                optionalString(litsanEnv("LITSAN_USER_ID", process.env)) ??
                optionalString(process.env.MEMORY_SERVICE_USER_ID) ??
                optionalString(litsanMemory.userId) ??
                optionalString(app.userId)
        },
        path: selectedPath
    };
}
export function defaultConfigPaths() {
    return [
        litsanEnv("LITSAN_CONFIG", process.env) ? resolve(expandHome(litsanEnv("LITSAN_CONFIG", process.env))) : undefined,
        join(defaultLitsanHome(), "config.yaml")
    ].filter((value) => Boolean(value));
}
export function expandHome(value) {
    return value === "~" || value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
}
function parseConfigFile(path) {
    const raw = readFileSync(path, "utf8");
    if (path.endsWith(".json")) {
        const parsed = JSON.parse(raw);
        return asRecord(parsed);
    }
    return asRecord(YAML.parse(raw));
}
export function asRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value
        : {};
}
export function optionalString(value) {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
