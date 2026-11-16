#!/usr/bin/env node
// Build-time guard: every Linux ELF native module under <dir> must be for <cpu>.
// Reads the ELF e_machine field, so it never loads (or needs to run) the binary.
// usage: node docker/verify-arch.mjs x64|arm64 node_modules
import { open, readdir } from "node:fs/promises";
import { join } from "node:path";

const [cpu, root = "node_modules"] = process.argv.slice(2);
const MACHINES = { 0x3e: "x64", 0xb7: "arm64" };
if (!Object.values(MACHINES).includes(cpu)) throw new Error(`unknown cpu ${cpu}`);

async function* files(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else if (entry.isFile() && /\.(node|so(\.\d+)*)$/.test(entry.name)) yield path;
  }
}

const seen = [], wrong = [];
for await (const path of files(root)) {
  const handle = await open(path, "r");
  const header = Buffer.alloc(20);
  try { await handle.read(header, 0, 20, 0); } finally { await handle.close(); }
  if (header.readUInt32BE(0) !== 0x7f454c46) continue; // not ELF (darwin/win32 leftovers are pruned anyway)
  const machine = MACHINES[header.readUInt16LE(18)] ?? `0x${header.readUInt16LE(18).toString(16)}`;
  (machine === cpu ? seen : wrong).push(`${machine} ${path}`);
}
for (const line of seen) console.log(`ok ${line}`);
if (wrong.length) {
  for (const line of wrong) console.error(`WRONG ${line}`);
  process.exit(1);
}
if (!seen.length) throw new Error("no native modules found; dependency install looks broken");
console.log(`verify-arch: ${seen.length} native modules, all ${cpu}`);
