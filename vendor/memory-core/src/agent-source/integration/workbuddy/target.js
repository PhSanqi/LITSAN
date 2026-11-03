import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { resolveWorkbuddyHomeDirectory } from "../../agent-paths.js";
import { removeLitsanSkillDirectory, replaceLitsanSkillDirectory } from "../skill-directory.js";
const WORKBUDDY_TARGET_ID = "workbuddy";
const WORKBUDDY_DISPLAY_NAME = "WorkBuddy";
export function createWorkbuddySkillTarget(deps = {}) {
    const rootDirectory = deps.rootDirectory ?? resolveWorkbuddyHomeDirectory();
    return {
        targetId: WORKBUDDY_TARGET_ID,
        displayName: WORKBUDDY_DISPLAY_NAME,
        async resolveRootDirectory() {
            return resolveExistingDirectory(rootDirectory);
        },
        async install(manifest) {
            const root = await this.resolveRootDirectory();
            if (!root) {
                throw new Error("WorkBuddy is not installed or its directory is unavailable");
            }
            await replaceLitsanSkillDirectory(root, manifest);
        },
        async uninstall(_targetId) {
            const root = await this.resolveRootDirectory();
            if (root) {
                await removeLitsanSkillDirectory(root);
            }
        },
        async isInstalled(_targetId) {
            const root = await this.resolveRootDirectory();
            if (!root) {
                return false;
            }
            const content = await readTextFile(join(root, "skills", "litsan-memory", "SKILL.md"));
            return content.includes("name: litsan-memory") && content.includes("## Agent Loop");
        }
    };
}
async function resolveExistingDirectory(directory) {
    try {
        return (await stat(directory)).isDirectory() ? directory : null;
    }
    catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") {
            return null;
        }
        throw error;
    }
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
function isNodeError(error) {
    return error instanceof Error && "code" in error;
}
