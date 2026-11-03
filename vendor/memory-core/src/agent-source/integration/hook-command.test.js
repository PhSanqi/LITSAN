import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createNodeHookCommand, resolveNodeExecutable } from "./hook-command.js";
const HOME = "/Users/test";
describe("resolveNodeExecutable", () => {
    for (const execPath of [
        "/Applications/LITSAN.app/Contents/MacOS/LITSAN",
        "/Volumes/LITSAN Installer/LITSAN.app/Contents/MacOS/LITSAN",
        "/Applications/Electron.app/Contents/MacOS/Electron",
        "/applications/LITSAN.APP/contents/macos/LITSAN"
    ]) it(`rejects a packaged app host from process.execPath: ${execPath}`, () => {
        assert.equal(resolveNodeExecutable(runtime({ execPath, executable: [execPath, "/opt/homebrew/bin/node"] })), "/opt/homebrew/bin/node");
    });
    it("rejects packaged app hosts supplied through environment overrides", () => {
        const appHost = "/Applications/LITSAN.app/Contents/MacOS/LITSAN";
        assert.equal(resolveNodeExecutable(runtime({
            env: { LITSAN_HOOK_NODE: appHost, NODE: "/usr/local/bin/node" },
            executable: [appHost, "/usr/local/bin/node"]
        })), "/usr/local/bin/node");
    });
    it("rejects a branded non-Node process executable", () => {
        const execPath = "/usr/local/bin/litsan";
        assert.equal(resolveNodeExecutable(runtime({ execPath, executable: [execPath, "/opt/homebrew/bin/node"] })), "/opt/homebrew/bin/node");
    });
    it("preserves override, process, known-path, and PATH fallback precedence", () => {
        assert.equal(resolveNodeExecutable(runtime({
            env: { LITSAN_HOOK_NODE: "/custom/bin/node" },
            execPath: "/runtime/bin/node",
            executable: ["/custom/bin/node", "/runtime/bin/node"]
        })), "/custom/bin/node");
        assert.equal(resolveNodeExecutable(runtime({
            execPath: "/runtime/bin/node",
            executable: ["/runtime/bin/node", "/opt/homebrew/bin/node"]
        })), "/runtime/bin/node");
        assert.equal(resolveNodeExecutable(runtime({
            execPath: "/Applications/LITSAN.app/Contents/MacOS/LITSAN",
            executable: ["/usr/local/bin/node"]
        })), "/usr/local/bin/node");
        assert.equal(resolveNodeExecutable(runtime()), "node");
    });
    it("skips absolute candidates that exist but are not executable files", () => {
        assert.equal(resolveNodeExecutable(runtime({
            env: { LITSAN_HOOK_NODE: "/custom/bin/node" },
            executable: ["/opt/homebrew/bin/node"]
        })), "/opt/homebrew/bin/node");
    });
});
describe("createNodeHookCommand", () => {
    it("single-quotes the command on POSIX platforms", () => {
        assert.equal(createNodeHookCommand("/Users/me/Library/Application Support/hook.mjs", runtime()), "'node' '/Users/me/Library/Application Support/hook.mjs'");
    });
    it("double-quotes paths on Windows so cmd.exe and PowerShell can run them", () => {
        const nodePath = "C:/Program Files/nodejs/node.exe";
        assert.equal(createNodeHookCommand("C:/Users/me/.codex/hooks/litsan-resume-hook.mjs", runtime({
            platform: "win32",
            env: { LITSAN_HOOK_NODE: nodePath },
            executable: [nodePath]
        })), "\"C:/Program Files/nodejs/node.exe\" \"C:/Users/me/.codex/hooks/litsan-resume-hook.mjs\"");
    });
    it("leaves a bare command name unquoted on Windows", () => {
        assert.equal(createNodeHookCommand("C:/Users/me/.codex/hooks/litsan-resume-hook.mjs", runtime({ platform: "win32" })), "node \"C:/Users/me/.codex/hooks/litsan-resume-hook.mjs\"");
    });
});
function runtime(overrides = {}) {
    const executable = new Set(overrides.executable ?? []);
    return {
        platform: overrides.platform ?? "darwin",
        env: overrides.env ?? {},
        execPath: overrides.execPath ?? "/missing/runtime/node",
        hermesHomeDirectory: HOME,
        isExecutableFile: (candidate) => executable.has(candidate)
    };
}
