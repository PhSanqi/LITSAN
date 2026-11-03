/** LITSAN runtime config helpers. */
import { readFile } from "node:fs/promises";
import YAML from "yaml";
import { deriveWorkspaceHostId } from "../../contracts/index.js";
import { getOrCreateInstallationId } from "../../cli/analytics.js";
/** Reads LITSAN memory service endpoint and token from the local config file. */
export async function readLitsanMemoryServiceConfig(configPath) {
    const content = await readTextFile(configPath);
    const parsed = content.trim() ? YAML.parse(content) : {};
    const root = toMutableRecord(parsed);
    const litsanMemory = toMutableRecord((root.litsanMemory ?? root.memmyMemory));
    const storage = toMutableRecord(litsanMemory.storage);
    const legacyStorage = toMutableRecord(root.storage);
    const app = toMutableRecord(root.app);
    return {
        endpoint: normalizeString(storage.endpoint) ||
            normalizeString(litsanMemory.endpoint) ||
            normalizeString(legacyStorage.endpoint) ||
            "http://127.0.0.1:18960",
        token: normalizeString(storage.token) ||
            normalizeString(litsanMemory.token) ||
            normalizeString(legacyStorage.token),
        userId: normalizeString(app.userId) || normalizeString(litsanMemory.userId) || "local-user",
        workspaceHostId: deriveWorkspaceHostId(getOrCreateInstallationId())
    };
}
async function readTextFile(filePath) {
    try {
        return await readFile(filePath, "utf8");
    }
    catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") {
            return "";
        }
        throw error;
    }
}
function toMutableRecord(value) {
    return isRecord(value) ? { ...value } : {};
}
function normalizeString(value) {
    return typeof value === "string" ? value.trim() : "";
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isNodeError(error) {
    return error instanceof Error && "code" in error;
}
