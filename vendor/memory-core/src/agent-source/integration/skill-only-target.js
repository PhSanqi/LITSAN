import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { removeLitsanSkillDirectory, replaceLitsanSkillDirectory } from "./skill-directory.js";
export function createSkillOnlyTarget(input) {
    return {
        targetId: input.targetId,
        displayName: input.displayName,
        async resolveRootDirectory() {
            try {
                return (await stat(input.rootDirectory)).isDirectory() ? input.rootDirectory : null;
            }
            catch (error) {
                if (isNodeError(error) && error.code === "ENOENT")
                    return null;
                throw error;
            }
        },
        async install(manifest) {
            const root = await this.resolveRootDirectory();
            if (!root) {
                throw new Error(`${input.displayName} is not installed or its directory is unavailable`);
            }
            await replaceLitsanSkillDirectory(root, manifest);
        },
        async uninstall() {
            const root = await this.resolveRootDirectory();
            if (root)
                await removeLitsanSkillDirectory(root);
        },
        async isInstalled() {
            const root = await this.resolveRootDirectory();
            if (!root)
                return false;
            const content = await readTextFile(join(root, "skills", "litsan-memory", "SKILL.md"));
            return content.includes("name: litsan-memory") && content.includes("## Agent Loop");
        }
    };
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
function isNodeError(error) {
    return error instanceof Error && "code" in error;
}
