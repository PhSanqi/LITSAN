import { migrateOwnedIntegrationFiles } from "../legacy-files.js";
import { defaultLitsanHome } from "../../../utils/litsan-compat.js";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { resolveDeepseekHarnessHomeDirectory } from "../../agent-paths.js";
import { removeLitsanSkillDirectory, replaceLitsanSkillDirectory } from "../skill-directory.js";
import { readLitsanMemoryServiceConfig } from "../litsan-runtime-config.js";
import { createDeepseekHarnessPluginPackageManifest, DEEPSEEK_HARNESS_PLUGIN_CLIENT, DEEPSEEK_HARNESS_PLUGIN_INDEX } from "../templates/litsan-deepseek-harness-plugin.js";
import { renderLitsanPluginSkillManifest } from "../templates/litsan-plugin.js";
import { loadLitsanWorkspaceBridgeRuntimeAsset } from "../workspace-bridge/runtime-loader.js";
const TARGET_ID = "deepseek_harness";
const DISPLAY_NAME = "DeepSeek Harness";
const PATCH_START = "# litsan-memory plugin:start";
const PATCH_END = "# litsan-memory plugin:end";
const PLUGIN_PACKAGE_NAME = "@litsan/litsan-memory";
export function createDeepseekHarnessSkillTarget(deps = {}) {
    const rootDirectory = deps.rootDirectory ?? resolveDeepseekHarnessHomeDirectory();
    const litsanConfigPath = (deps.litsanConfigPath ?? deps.memmyConfigPath) ?? join(defaultLitsanHome(), "config.yaml");
    const pluginDirectory = join(rootDirectory, "profiles", "node_modules", "@litsan", "litsan-memory");
    const patchPath = join(rootDirectory, "cordis.patch.yml");
    return {
        targetId: TARGET_ID,
        displayName: DISPLAY_NAME,
        async resolveRootDirectory() {
            return resolveExistingDirectory(rootDirectory);
        },
        async install(manifest) {
            if (!(await this.resolveRootDirectory())) {
                throw new Error("DeepSeek Harness is not installed or its directory is unavailable");
            }
            await replaceLitsanSkillDirectory(rootDirectory, manifest);
        },
        async uninstall() {
            await removeLitsanSkillDirectory(rootDirectory);
        },
        async isInstalled() {
            if (!(await this.resolveRootDirectory()))
                return false;
            const patch = await readTextFile(patchPath);
            const pluginSource = await readTextFile(join(pluginDirectory, "index.mjs"));
            const clientSource = await readTextFile(join(pluginDirectory, "client.js"));
            const packageSource = await readTextFile(join(pluginDirectory, "package.json"));
            const bridgeSource = await readTextFile(join(pluginDirectory, "litsan-workspace-bridge.mjs"));
            return patch.includes("name: " + yamlString(PLUGIN_PACKAGE_NAME)) &&
                pluginSource === DEEPSEEK_HARNESS_PLUGIN_INDEX &&
                clientSource === DEEPSEEK_HARNESS_PLUGIN_CLIENT &&
                packageSource === JSON.stringify(createDeepseekHarnessPluginPackageManifest(), null, 2) + "\n" &&
                bridgeSource === await loadLitsanWorkspaceBridgeRuntimeAsset();
        },
        async installPlugin() {
            if (!(await this.resolveRootDirectory())) {
                throw new Error("DeepSeek Harness is not installed or its directory is unavailable");
            }
            await migrateOwnedIntegrationFiles(rootDirectory);
            await mkdir(pluginDirectory, { recursive: true });
            await writeFileAtomically(join(pluginDirectory, "package.json"), JSON.stringify(createDeepseekHarnessPluginPackageManifest(), null, 2) + "\n");
            await writeFileAtomically(join(pluginDirectory, "index.mjs"), DEEPSEEK_HARNESS_PLUGIN_INDEX);
            await writeFileAtomically(join(pluginDirectory, "client.js"), DEEPSEEK_HARNESS_PLUGIN_CLIENT);
            await writeFileAtomically(join(pluginDirectory, "litsan-workspace-bridge.mjs"), await loadLitsanWorkspaceBridgeRuntimeAsset());
            await writeFileAtomically(join(pluginDirectory, "litsan-memory-config.json"), JSON.stringify({ litsan_config_path: litsanConfigPath, ...(await readLitsanMemoryServiceConfig(litsanConfigPath)) }, null, 2) + "\n");
            await upsertPatch(patchPath, renderPluginPatch(litsanConfigPath));
            await replaceLitsanSkillDirectory(rootDirectory, renderLitsanPluginSkillManifest(TARGET_ID));
        },
        async uninstallPlugin() {
            if (!(await this.resolveRootDirectory()))
                return;
            await removePatch(patchPath);
            await rm(pluginDirectory, { recursive: true, force: true });
            await removeLitsanSkillDirectory(rootDirectory);
        }
    };
}
function renderPluginPatch(litsanConfigPath) {
    return [
        PATCH_START,
        "- insert:",
        "    - id: litsan-memory",
        "      name: " + yamlString(PLUGIN_PACKAGE_NAME),
        "      config:",
        "        litsanConfigPath: " + yamlString(litsanConfigPath),
        PATCH_END
    ].join("\n");
}
async function upsertPatch(filePath, block) {
    const existing = removePatchBlock(await readTextFile(filePath));
    const lines = existing.split(/\r?\n/u);
    const contentLines = lines.filter((line) => {
        const trimmed = line.trim();
        return trimmed && !trimmed.startsWith("#");
    });
    const base = contentLines.length === 1 && contentLines[0] === "[]"
        ? lines.filter((line) => line.trim() !== "[]").join("\n").trimEnd()
        : existing.trimEnd();
    await writeFileAtomically(filePath, [base, block, ""].filter((part, index) => part || index === 2).join("\n"));
}
async function removePatch(filePath) {
    const existing = await readTextFile(filePath);
    if (!existing.includes(PATCH_START))
        return;
    const without = removePatchBlock(existing).trimEnd();
    const hasEntries = without.split(/\r?\n/u).some((line) => {
        const trimmed = line.trim();
        return trimmed && !trimmed.startsWith("#");
    });
    await writeFileAtomically(filePath, without + (without ? "\n" : "") + (hasEntries ? "" : "[]\n"));
}
function removePatchBlock(value) {
    let result = value;
    while (true) {
        const start = result.indexOf(PATCH_START);
        if (start < 0)
            return result;
        const end = result.indexOf(PATCH_END, start);
        if (end < 0)
            throw new Error("Invalid LITSAN patch block starting at " + PATCH_START);
        const lineEnd = result.indexOf("\n", end + PATCH_END.length);
        const after = lineEnd < 0 ? result.length : lineEnd + 1;
        result = result.slice(0, start).trimEnd() + "\n" + result.slice(after).trimStart();
    }
}
function yamlString(value) {
    return "'" + value.replaceAll("'", "''") + "'";
}
async function readTextFile(filePath) {
    try {
        return await readFile(filePath, "utf8");
    }
    catch (error) {
        if (isNodeError(error) && error.code === "ENOENT")
            return "";
        throw error;
    }
}
async function resolveExistingDirectory(directory) {
    try {
        return (await stat(directory)).isDirectory() ? directory : null;
    }
    catch (error) {
        if (isNodeError(error) && error.code === "ENOENT")
            return null;
        throw error;
    }
}
async function writeFileAtomically(filePath, content) {
    await mkdir(dirname(filePath), { recursive: true });
    const tempPath = join(dirname(filePath), "." + basename(filePath) + "." + process.pid + "." + Date.now() + "." + Math.random().toString(16).slice(2) + ".tmp");
    try {
        await writeFile(tempPath, content, "utf8");
        await rename(tempPath, filePath);
    }
    catch (error) {
        await rm(tempPath, { force: true });
        throw error;
    }
}
function isNodeError(error) {
    return error instanceof Error && "code" in error;
}
