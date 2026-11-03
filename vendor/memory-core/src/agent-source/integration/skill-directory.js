import { removeOwnedLegacySkill, isInstalledMemorySkill } from "./legacy-files.js";
import { readFile, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { LITSAN_SKILL_DIRECTORY_NAME, renderLitsanSkillDirectoryFiles } from "./templates/litsan-skill-directory.js";
export async function replaceLitsanSkillDirectory(rootDirectory, manifest) {
    const targetPath = join(rootDirectory, "skills", LITSAN_SKILL_DIRECTORY_NAME);
    const tempPath = temporarySiblingPath(targetPath);
    const backupPath = temporarySiblingPath(`${targetPath}.old`);
    await rm(tempPath, { recursive: true, force: true });
    await rm(backupPath, { recursive: true, force: true });
    await mkdir(tempPath, { recursive: true });
    for (const file of renderLitsanSkillDirectoryFiles(manifest)) {
        const filePath = join(tempPath, file.relativePath);
        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(filePath, file.content, "utf8");
    }
    const hadExistingTarget = await pathExists(targetPath);
    try {
        if (hadExistingTarget) {
            await rename(targetPath, backupPath);
        }
        await rename(tempPath, targetPath);
        await rm(backupPath, { recursive: true, force: true });
        await removeOwnedLegacySkill(rootDirectory);
    }
    catch (error) {
        await rm(tempPath, { recursive: true, force: true });
        if (hadExistingTarget && !(await pathExists(targetPath)) && await pathExists(backupPath)) {
            await rename(backupPath, targetPath);
        }
        throw error;
    }
}
export async function removeLitsanSkillDirectory(rootDirectory) {
    const path = join(rootDirectory, "skills", LITSAN_SKILL_DIRECTORY_NAME);
    const content = await readFile(join(path, "SKILL.md"), "utf8").catch((error) => { if (error.code === "ENOENT") return ""; throw error; });
    if (isInstalledMemorySkill(content)) await rm(path, { recursive: true, force: true });
    await removeOwnedLegacySkill(rootDirectory);
}
function temporarySiblingPath(path) {
    return join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
}
async function pathExists(path) {
    try {
        await stat(path);
        return true;
    }
    catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") {
            return false;
        }
        throw error;
    }
}
function isNodeError(error) {
    return error instanceof Error && "code" in error;
}
