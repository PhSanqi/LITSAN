import { lstat, mkdir, readdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

// Ownership markers are retained across the rename so upgrades can identify our files.
export function isInstalledMemorySkill(content) {
    return /<!-- memmy:start v=1 -->/.test(content)
        || (/^name: (?:memmy|litsan)-memory\s*$/m.test(content)
            && /(?:shared (?:Memmy|LITSAN) memory|memmy-memory|litsan-memory)/.test(content));
}
export async function removeOwnedLegacySkill(root) {
    const path = join(root, "skills", "memmy-memory");
    const content = await readFile(join(path, "SKILL.md"), "utf8").catch((error) => {
        if (error.code === "ENOENT") return "";
        throw error;
    });
    if (isInstalledMemorySkill(content)) await rm(path, { recursive: true, force: true });
}
const legacyNames = new Set([
    "memmy-memory-config.json", "memmy-resume-hook.mjs", "memmy-memory-resume-hook.mjs",
    "memmy-resume.md", "memmy-resume-state.json", "memmy-workspace-bridge.mjs"
]);
export async function migrateOwnedIntegrationFiles(root) {
    for (const name of ["extensions/memmy-memory", "plugins/memmy-memory", "plugins/memmy", "plugins/memmy-resume", "profiles/node_modules/@memmy/memmy-memory"]) {
        const oldPath = join(root, name);
        const info = await lstat(oldPath).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
        if (!info?.isDirectory()) continue;
        let owned = false;
        for (const marker of ["package.json", "plugin.yaml", "config.json", "memmy-memory-config.json"]) {
            const content = await readFile(join(oldPath, marker), "utf8").catch((error) => { if (error.code === "ENOENT") return ""; throw error; });
            if (/(?:memmy_config_path|(?:name|id)["']?\s*:\s*["']?(?:@memmy\/)?memmy(?:-memory|-resume)?["'\s,}])/.test(content)) owned = true;
        }
        if (!owned) continue;
        const nextPath = join(root, name.replaceAll("memmy", "litsan"));
        await mkdir(dirname(nextPath), { recursive: true });
        await rename(oldPath, nextPath);
    }
    // Only integration locations written by these targets; never follow symlinks.
    for (const directory of [root, ...["hooks", "plugins", "plugin", "commands", "extensions", "plugins/litsan-memory", "plugins/litsan", "plugins/litsan-resume", "extensions/litsan-memory", "profiles/node_modules/@litsan/litsan-memory"].map((name) => join(root, name))]) {
        const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
            if (error.code === "ENOENT") return [];
            throw error;
        });
        let ownedDirectory = false;
        for (const configName of ["memmy-memory-config.json", "litsan-memory-config.json"]) {
            const content = await readFile(join(directory, configName), "utf8").catch((error) => { if (error.code === "ENOENT") return ""; throw error; });
            if (/(?:memmy|litsan)_config_path/.test(content)) ownedDirectory = true;
        }
        for (const entry of entries) {
            if (!entry.isFile() || !legacyNames.has(entry.name)) continue;
            const oldPath = join(directory, entry.name);
            const content = await readFile(oldPath, "utf8");
            if (!/(?:memmy_config_path|memmy-memory|memmy-resume|MEMMY_|__memmyCreateRequire)/.test(content)
                && !(ownedDirectory && entry.name === "memmy-resume-state.json")) continue;
            const nextName = entry.name === "memmy-memory-resume-hook.mjs" ? "litsan-resume-hook.mjs" : entry.name.replace(/^memmy-/, "litsan-");
            const nextPath = join(directory, nextName);
            const present = entries.some((item) => item.name === nextName);
            if (present) await rm(oldPath);
            else await rename(oldPath, nextPath);
        }
    }
}
