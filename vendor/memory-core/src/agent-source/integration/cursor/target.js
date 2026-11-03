import { migrateOwnedIntegrationFiles } from "../legacy-files.js";
import { defaultLitsanHome } from "../../../utils/litsan-compat.js";
/** Target module. */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createNodeHookCommand } from "../hook-command.js";
import { readLitsanMemoryServiceConfig } from "../litsan-runtime-config.js";
import { removeLitsanSkillDirectory, replaceLitsanSkillDirectory } from "../skill-directory.js";
import { renderLitsanPluginSkillManifest } from "../templates/litsan-plugin.js";
import { renderLitsanResumeHookScript } from "../templates/litsan-resume-hook.js";
import { loadLitsanWorkspaceBridgeRuntimeAsset } from "../workspace-bridge/runtime-loader.js";
const CURSOR_TARGET_ID = "cursor";
const CURSOR_DISPLAY_NAME = "Cursor";
const HOOKS_FILE_NAME = "hooks.json";
const HOOK_DIRECTORY_NAME = "hooks";
const HOOK_SCRIPT_FILE_NAME = "litsan-resume-hook.mjs";
const LEGACY_HOOK_SCRIPT_FILE_NAME = "memmy-memory-resume-hook.mjs";
const HOOK_CONFIG_FILE_NAME = "litsan-memory-config.json";
const WORKSPACE_BRIDGE_FILE_NAME = "litsan-workspace-bridge.mjs";
const HOOK_TIMEOUT_SECONDS = 60;
/** Creates create cursor skill target. */
export function createCursorSkillTarget(deps = {}) {
    const cursorRootDirectory = deps.rootDirectory ?? join(homedir(), ".cursor");
    const litsanConfigPath = (deps.litsanConfigPath ?? deps.memmyConfigPath) ?? join(defaultLitsanHome(), "config.yaml");
    return {
        targetId: CURSOR_TARGET_ID,
        displayName: CURSOR_DISPLAY_NAME,
        async resolveRootDirectory() {
            return cursorRootDirectory;
        },
        async install(manifest) {
            await mkdir(cursorRootDirectory, { recursive: true });
            await replaceLitsanSkillDirectory(cursorRootDirectory, manifest);
        },
        async uninstall(_targetId) {
            await removeLitsanSkillDirectory(cursorRootDirectory);
        },
        async isInstalled(_targetId) {
            return (await readTextFile(join(cursorRootDirectory, "skills", "litsan-memory", "SKILL.md"))).includes("name: litsan-memory");
        },
        async installPlugin(_targetId) {
            await migrateOwnedIntegrationFiles(cursorRootDirectory);
            await mkdir(cursorRootDirectory, { recursive: true });
            const hookDirectory = join(cursorRootDirectory, HOOK_DIRECTORY_NAME);
            const hookScriptPath = join(hookDirectory, HOOK_SCRIPT_FILE_NAME);
            await mkdir(hookDirectory, { recursive: true });
            await writeFileAtomically(join(hookDirectory, HOOK_CONFIG_FILE_NAME), `${JSON.stringify({ litsan_config_path: litsanConfigPath, ...(await readLitsanMemoryServiceConfig(litsanConfigPath)) }, null, 2)}\n`);
            await writeFileAtomically(hookScriptPath, renderLitsanResumeHookScript({ source: CURSOR_TARGET_ID, mode: "cursor" }));
            await writeFileAtomically(join(hookDirectory, WORKSPACE_BRIDGE_FILE_NAME), await loadLitsanWorkspaceBridgeRuntimeAsset());
            await upsertCursorHookConfig(join(cursorRootDirectory, HOOKS_FILE_NAME), hookScriptPath);
            const manifest = renderLitsanPluginSkillManifest(_targetId);
            await replaceLitsanSkillDirectory(cursorRootDirectory, manifest);
        },
        async uninstallPlugin(_targetId) {
            await removeCursorHookConfig(join(cursorRootDirectory, HOOKS_FILE_NAME));
            await rm(join(cursorRootDirectory, HOOK_DIRECTORY_NAME, HOOK_SCRIPT_FILE_NAME), { force: true });
            await rm(join(cursorRootDirectory, HOOK_DIRECTORY_NAME, HOOK_CONFIG_FILE_NAME), { force: true });
            await rm(join(cursorRootDirectory, HOOK_DIRECTORY_NAME, WORKSPACE_BRIDGE_FILE_NAME), { force: true });
            await removeLitsanSkillDirectory(cursorRootDirectory);
        }
    };
}
/** Reads read text file. */
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
async function readJsonConfig(filePath) {
    const content = await readTextFile(filePath);
    if (!content.trim()) {
        return {};
    }
    const parsed = JSON.parse(content);
    return isRecord(parsed) ? { ...parsed } : {};
}
async function upsertCursorHookConfig(filePath, hookScriptPath) {
    const config = await readJsonConfig(filePath);
    const hooks = toMutableRecord(config.hooks);
    hooks.beforeSubmitPrompt = [
        ...removeCursorResumeHookEntries(hooks.beforeSubmitPrompt),
        {
            command: createNodeHookCommand(hookScriptPath),
            timeout: HOOK_TIMEOUT_SECONDS
        }
    ];
    hooks.afterAgentResponse = [
        ...removeCursorResumeHookEntries(hooks.afterAgentResponse),
        {
            command: createNodeHookCommand(hookScriptPath),
            timeout: HOOK_TIMEOUT_SECONDS
        }
    ];
    hooks.stop = [
        ...removeCursorResumeHookEntries(hooks.stop),
        {
            command: createNodeHookCommand(hookScriptPath),
            timeout: HOOK_TIMEOUT_SECONDS
        }
    ];
    hooks.sessionStart = cursorHookEntries(hooks.sessionStart, hookScriptPath);
    hooks.preCompact = cursorHookEntries(hooks.preCompact, hookScriptPath);
    hooks.sessionEnd = cursorHookEntries(hooks.sessionEnd, hookScriptPath);
    config.version = 1;
    config.hooks = hooks;
    await writeFileAtomically(filePath, `${JSON.stringify(config, null, 2)}\n`);
}
async function removeCursorHookConfig(filePath) {
    const existing = await readTextFile(filePath);
    if (!existing.trim()) {
        return;
    }
    const config = await readJsonConfig(filePath);
    const hooks = toMutableRecord(config.hooks);
    const entries = removeCursorResumeHookEntries(hooks.beforeSubmitPrompt);
    if (entries.length > 0) {
        hooks.beforeSubmitPrompt = entries;
    }
    else {
        delete hooks.beforeSubmitPrompt;
    }
    const afterAgentResponseEntries = removeCursorResumeHookEntries(hooks.afterAgentResponse);
    if (afterAgentResponseEntries.length > 0) {
        hooks.afterAgentResponse = afterAgentResponseEntries;
    }
    else {
        delete hooks.afterAgentResponse;
    }
    const stopEntries = removeCursorResumeHookEntries(hooks.stop);
    if (stopEntries.length > 0) {
        hooks.stop = stopEntries;
    }
    else {
        delete hooks.stop;
    }
    for (const event of ["sessionStart", "preCompact", "sessionEnd"]) {
        const eventEntries = removeCursorResumeHookEntries(hooks[event]);
        if (eventEntries.length > 0)
            hooks[event] = eventEntries;
        else
            delete hooks[event];
    }
    if (Object.keys(hooks).length > 0) {
        config.hooks = hooks;
    }
    else {
        delete config.hooks;
    }
    await writeFileAtomically(filePath, `${JSON.stringify(config, null, 2)}\n`);
}
function cursorHookEntries(value, hookScriptPath) {
    return [
        ...removeCursorResumeHookEntries(value),
        { command: createNodeHookCommand(hookScriptPath), timeout: HOOK_TIMEOUT_SECONDS },
    ];
}
function removeCursorResumeHookEntries(value) {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.filter((item) => isRecord(item) && !isLitsanResumeHook(item));
}
function isLitsanResumeHook(value) {
    return isRecord(value) &&
        typeof value.command === "string" &&
        (value.command.match(/(?:memmy|litsan)-(?:memory-)?resume-hook\.mjs/u) || value.command.includes(LEGACY_HOOK_SCRIPT_FILE_NAME));
}
/**
 * Writes a text file atomically.
 *
 * @param filePath the target file path.
 * @param content the full file content.
 */
async function writeFileAtomically(filePath, content) {
    await mkdir(dirname(filePath), { recursive: true });
    const tempPath = join(dirname(filePath), `.${basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
    await writeFile(tempPath, content, "utf8");
    await rename(tempPath, filePath);
}
function toMutableRecord(value) {
    return isRecord(value) ? { ...value } : {};
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** Checks is node error. */
function isNodeError(error) {
    return error instanceof Error && "code" in error;
}
