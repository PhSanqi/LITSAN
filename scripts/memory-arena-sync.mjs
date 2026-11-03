#!/usr/bin/env node
import { readFile, mkdir, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const MANIFEST = resolve(ROOT, "benchmarks", "memory-arena", "backends.json");
const DEST = resolve(ROOT, ".review-runtime", "memory-arena", "backends");
const SNAPSHOT = resolve(ROOT, ".review-runtime", "memory-arena", "backend-snapshot.json");
const requested = new Set(process.argv.slice(2).filter((arg) => !arg.startsWith("--")));
const manifest = JSON.parse(await readFile(MANIFEST, "utf8"));
await mkdir(DEST, { recursive: true });

const rows = [];
for (const backend of manifest.backends) {
  if (!backend.repo || backend.id === "memhub") continue;
  if (requested.size && !requested.has(backend.id)) continue;
  const path = resolve(DEST, backend.id);
  const exists = await isDir(path);
  if (!exists) {
    console.log(`clone ${backend.id}`);
    await run("git", ["clone", "--depth", "1", "--filter=blob:none", backend.repo, path]);
  } else {
    console.log(`present ${backend.id}`);
  }
  const sha = (await capture("git", ["-C", path, "rev-parse", "HEAD"])).trim();
  const branch = (await capture("git", ["-C", path, "rev-parse", "--abbrev-ref", "HEAD"])).trim();
  rows.push({ id: backend.id, name: backend.name, repo: backend.repo, sha, branch, path: `.review-runtime/memory-arena/backends/${backend.id}` });
}
await writeFile(SNAPSHOT, JSON.stringify({ generated_at: new Date().toISOString(), backends: rows }, null, 2) + "\n");
console.log(`snapshot ${SNAPSHOT}`);

async function isDir(path) {
  try { return (await stat(path)).isDirectory(); } catch { return false; }
}

function run(cmd, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit" });
    child.on("exit", (code) => code === 0 ? resolvePromise() : reject(new Error(`${cmd} exited ${code}`)));
    child.on("error", reject);
  });
}

function capture(cmd, args) {
  return new Promise((resolvePromise, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("exit", (code) => code === 0 ? resolvePromise(stdout) : reject(new Error(`${cmd} exited ${code}: ${stderr}`)));
    child.on("error", reject);
  });
}

