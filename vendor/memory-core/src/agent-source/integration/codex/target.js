import { migrateOwnedIntegrationFiles } from "../legacy-files.js";
import { defaultLitsanHome } from "../../../utils/litsan-compat.js";
/** Target module. */
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { resolveCodexHomeDirectory } from "../../agent-paths.js";
import { createNodeHookCommand } from "../hook-command.js";
import { readLitsanMemoryServiceConfig } from "../litsan-runtime-config.js";
import { removeLitsanSkillDirectory, replaceLitsanSkillDirectory } from "../skill-directory.js";
import { renderLitsanPluginSkillManifest } from "../templates/litsan-plugin.js";
import { renderLitsanResumeHookScript } from "../templates/litsan-resume-hook.js";
import { renderLitsanSkillBootstrapManifest } from "../templates/litsan-skill-directory.js";
import { trustLitsanCodexHooks } from "./hook-trust.js";
import { loadLitsanWorkspaceBridgeRuntimeAsset } from "../workspace-bridge/runtime-loader.js";
const CODEX_TARGET_ID = "codex";
const CODEX_DISPLAY_NAME = "Codex";
const TARGET_FILE_NAME = "AGENTS.md";
const HOOKS_FILE_NAME = "hooks.json";
const HOOK_DIRECTORY_NAME = "hooks";
const HOOK_SCRIPT_FILE_NAME = "litsan-resume-hook.mjs";
const LEGACY_HOOK_SCRIPT_FILE_NAME = "memmy-memory-resume-hook.mjs";
const HOOK_CONFIG_FILE_NAME = "litsan-memory-config.json";
const WORKSPACE_BRIDGE_FILE_NAME = "litsan-workspace-bridge.mjs";
const HOOK_TIMEOUT_SECONDS = 60;
const START_MARKER = "<!-- memmy:start v=1 -->";
const END_MARKER = "<!-- memmy:end v=1 -->";
const LEGACY_CLI_START_MARKER = "<!-- memmy-memory cli : start -->";
const LEGACY_CLI_END_MARKER = "<!-- memmy-memory cli : end -->";
/** Creates create codex skill target. */
export function createCodexSkillTarget(deps = {}) {
    const rootDirectory = deps.rootDirectory ?? resolveCodexHomeDirectory();
    const litsanConfigPath = (deps.litsanConfigPath ?? deps.memmyConfigPath) ?? join(defaultLitsanHome(), "config.yaml");
    const trustHooks = deps.trustHooks ?? trustLitsanCodexHooks;
    return {
        targetId: CODEX_TARGET_ID,
        displayName: CODEX_DISPLAY_NAME,
        async resolveRootDirectory() {
            return resolveExistingDirectory(rootDirectory);
        },
        async install(manifest) {
            const root = await this.resolveRootDirectory();
            if (!root) {
                throw new Error("Codex is not installed or its directory is unavailable");
            }
            const filePath = join(root, TARGET_FILE_NAME);
            const existing = removeLegacyMarkerBlock(await readTextFile(filePath));
            await writeFileAtomically(filePath, upsertMarkerBlock(existing, renderLitsanSkillBootstrapManifest(manifest)));
            await replaceLitsanSkillDirectory(root, manifest);
        },
        async uninstall(_targetId) {
            const root = await this.resolveRootDirectory();
            if (!root) {
                return;
            }
            const filePath = join(root, TARGET_FILE_NAME);
            const existing = await readTextFile(filePath);
            await writeFileAtomically(filePath, removeMarkerBlock(removeLegacyMarkerBlock(existing)));
            await removeLitsanSkillDirectory(root);
        },
        async isInstalled(_targetId) {
            const root = await this.resolveRootDirectory();
            if (!root) {
                return false;
            }
            return (await readTextFile(join(root, TARGET_FILE_NAME))).includes(START_MARKER);
        },
        async installPlugin(_targetId) {
            const root = await this.resolveRootDirectory();
            if (!root) {
                throw new Error("Codex is not installed or its directory is unavailable");
            }
            await migrateOwnedIntegrationFiles(root);
            const hookDirectory = join(root, HOOK_DIRECTORY_NAME);
            const hookScriptPath = join(hookDirectory, HOOK_SCRIPT_FILE_NAME);
            await mkdir(hookDirectory, { recursive: true });
            await writeFileAtomically(join(hookDirectory, HOOK_CONFIG_FILE_NAME), `${JSON.stringify({ litsan_config_path: litsanConfigPath, ...(await readLitsanMemoryServiceConfig(litsanConfigPath)) }, null, 2)}\n`);
            await writeFileAtomically(hookScriptPath, renderLitsanResumeHookScript({ source: CODEX_TARGET_ID, mode: "codex" }));
            await writeFileAtomically(join(hookDirectory, WORKSPACE_BRIDGE_FILE_NAME), await loadLitsanWorkspaceBridgeRuntimeAsset());
            const hooksFilePath = join(root, HOOKS_FILE_NAME);
            const hookCommand = createNodeHookCommand(hookScriptPath);
            await upsertCodexHookConfig(hooksFilePath, hookCommand);
            const manifest = renderLitsanPluginSkillManifest(_targetId);
            const filePath = join(root, TARGET_FILE_NAME);
            await writeFileAtomically(filePath, upsertMarkerBlock(await readTextFile(filePath), renderLitsanSkillBootstrapManifest(manifest)));
            await replaceLitsanSkillDirectory(root, manifest);
            await trustHooks({
                codexHomeDirectory: root,
                hooksFilePath,
                hookCommand
            });
        },
        async uninstallPlugin(_targetId) {
            const root = await this.resolveRootDirectory();
            if (!root) {
                return;
            }
            await removeCodexHookConfig(join(root, HOOKS_FILE_NAME));
            await rm(join(root, HOOK_DIRECTORY_NAME, HOOK_SCRIPT_FILE_NAME), { force: true });
            await rm(join(root, HOOK_DIRECTORY_NAME, HOOK_CONFIG_FILE_NAME), { force: true });
            await rm(join(root, HOOK_DIRECTORY_NAME, WORKSPACE_BRIDGE_FILE_NAME), { force: true });
            const filePath = join(root, TARGET_FILE_NAME);
            await writeFileAtomically(filePath, removeMarkerBlock(removeLegacyMarkerBlock(await readTextFile(filePath))));
            await removeLitsanSkillDirectory(root);
        }
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
async function readJsonConfig(filePath) {
    const content = await readTextFile(filePath);
    if (!content.trim()) {
        return {};
    }
    const parsed = JSON.parse(content);
    return isRecord(parsed) ? { ...parsed } : {};
}
async function resolveExistingDirectory(directory) {
    try {
        const stats = await stat(directory);
        return stats.isDirectory() ? directory : null;
    }
    catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") {
            return null;
        }
        throw error;
    }
}
function upsertMarkerBlock(existing, manifest) {
    const block = renderMarkerBlock(manifest);
    const pattern = createMarkerBlockPattern(manifest.marker);
    if (pattern.test(existing)) {
        return existing.replace(pattern, block);
    }
    const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
    return `${existing}${separator}${block}`;
}
function removeMarkerBlock(existing) {
    return existing.replace(createMarkerBlockPattern(START_MARKER), "");
}
function removeLegacyMarkerBlock(existing) {
    return existing.replace(createMarkerBlockPattern(LEGACY_CLI_START_MARKER, LEGACY_CLI_END_MARKER), "");
}
async function upsertCodexHookConfig(filePath, hookCommand) {
    const config = await readJsonConfig(filePath);
    const hooks = toMutableRecord(config.hooks);
    hooks.UserPromptSubmit = [
        ...removeCodexResumeHookEntries(hooks.UserPromptSubmit),
        {
            hooks: [
                {
                    type: "command",
                    command: hookCommand,
                    timeout: HOOK_TIMEOUT_SECONDS,
                    statusMessage: "Searching LITSAN resume candidates"
                }
            ]
        }
    ];
    hooks.Stop = [
        ...removeCodexResumeHookEntries(hooks.Stop),
        {
            hooks: [
                {
                    type: "command",
                    command: hookCommand,
                    timeout: HOOK_TIMEOUT_SECONDS,
                    statusMessage: "Saving LITSAN turn"
                }
            ]
        }
    ];
    hooks.SessionStart = codexHookEntries(hooks.SessionStart, hookCommand, "Loading LITSAN world model");
    hooks.PostCompact = codexHookEntries(hooks.PostCompact, hookCommand, "Updating LITSAN world model");
    hooks.SessionEnd = codexHookEntries(hooks.SessionEnd, hookCommand, "Closing LITSAN memory session");
    config.hooks = hooks;
    await writeFileAtomically(filePath, `${JSON.stringify(config, null, 2)}\n`);
}
async function removeCodexHookConfig(filePath) {
    const existing = await readTextFile(filePath);
    if (!existing.trim()) {
        return;
    }
    const config = await readJsonConfig(filePath);
    const hooks = toMutableRecord(config.hooks);
    const userPromptSubmitEntries = removeCodexResumeHookEntries(hooks.UserPromptSubmit);
    if (userPromptSubmitEntries.length > 0) {
        hooks.UserPromptSubmit = userPromptSubmitEntries;
    }
    else {
        delete hooks.UserPromptSubmit;
    }
    const stopEntries = removeCodexResumeHookEntries(hooks.Stop);
    if (stopEntries.length > 0) {
        hooks.Stop = stopEntries;
    }
    else {
        delete hooks.Stop;
    }
    for (const event of ["SessionStart", "PostCompact", "SessionEnd"]) {
        const entries = removeCodexResumeHookEntries(hooks[event]);
        if (entries.length > 0)
            hooks[event] = entries;
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
function codexHookEntries(value, hookCommand, statusMessage) {
    return [
        ...removeCodexResumeHookEntries(value),
        { hooks: [{ type: "command", command: hookCommand, timeout: HOOK_TIMEOUT_SECONDS, statusMessage }] },
    ];
}
function removeCodexResumeHookEntries(value) {
    if (!Array.isArray(value)) {
        return [];
    }
    const entries = [];
    for (const item of value) {
        if (!isRecord(item)) {
            continue;
        }
        const hookItems = Array.isArray(item.hooks) ? item.hooks : [];
        const filteredHooks = hookItems.filter((hook) => !isLitsanResumeHook(hook));
        if (filteredHooks.length > 0 || hookItems.length === 0) {
            entries.push(hookItems.length === 0 ? { ...item } : { ...item, hooks: filteredHooks });
        }
    }
    return entries;
}
function isLitsanResumeHook(value) {
    if (!isRecord(value)) {
        return false;
    }
    return typeof value.command === "string" &&
        (value.command.match(/(?:memmy|litsan)-(?:memory-)?resume-hook\.mjs/u) || value.command.includes(LEGACY_HOOK_SCRIPT_FILE_NAME));
}
function renderMarkerBlock(manifest) {
    return `${manifest.marker}\n${manifest.content.trimEnd()}\n${END_MARKER}\n`;
}
function createMarkerBlockPattern(startMarker, endMarker = END_MARKER) {
    return new RegExp(`${escapeRegExp(startMarker)}\\n[\\s\\S]*?${escapeRegExp(endMarker)}\\n?`, "m");
}
async function writeFileAtomically(filePath, content) {
    await mkdir(dirname(filePath), { recursive: true });
    const tempPath = join(dirname(filePath), `.${basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
    await writeFile(tempPath, content, "utf8");
    await rename(tempPath, filePath);
}
function escapeRegExp(input) {
    return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function toMutableRecord(value) {
    return isRecord(value) ? { ...value } : {};
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isNodeError(error) {
    return error instanceof Error && "code" in error;
}
