#!/usr/bin/env node
import { mkdir, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const DEST = resolve(ROOT, ".review-runtime", "memory-arena", "OmniMemEval");
const META = resolve(ROOT, ".review-runtime", "memory-arena", "omnimemeval-snapshot.json");
const REPO = "https://github.com/MemTensor/OmniMemEval.git";
await mkdir(resolve(ROOT, ".review-runtime", "memory-arena"), { recursive: true });

if (!(await isDir(DEST))) {
  await run("git", ["clone", "--depth", "1", "--filter=blob:none", REPO, DEST]);
}
const sha = (await capture("git", ["-C", DEST, "rev-parse", "HEAD"])).trim();
await writeFile(META, JSON.stringify({ generated_at: new Date().toISOString(), repo: REPO, sha, path: ".review-runtime/memory-arena/OmniMemEval" }, null, 2) + "\n");
console.log(`OmniMemEval ${sha}`);

async function isDir(path) { try { return (await stat(path)).isDirectory(); } catch { return false; } }
function run(cmd, args) { return new Promise((ok, fail) => { const p = spawn(cmd, args, { stdio: "inherit" }); p.on("exit", (c) => c === 0 ? ok() : fail(new Error(`${cmd} exited ${c}`))); p.on("error", fail); }); }
function capture(cmd, args) { return new Promise((ok, fail) => { let out = "", err = ""; const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] }); p.stdout.on("data", (c) => out += c); p.stderr.on("data", (c) => err += c); p.on("exit", (code) => code === 0 ? ok(out) : fail(new Error(err))); p.on("error", fail); }); }

