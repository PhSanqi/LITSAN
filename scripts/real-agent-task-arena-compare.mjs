#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { compareArenaResults } from './real-agent-task-arena-lib.mjs';

const args = parseArgs(process.argv.slice(2));
if (!args.baseline || !args.memory) {
  throw new Error('usage: real-agent-task-arena-compare.mjs --baseline=<result.json> --memory=<result.json> [--output=<paired.json>]');
}
const baseline = JSON.parse(await readFile(resolve(args.baseline), 'utf8'));
const memory = JSON.parse(await readFile(resolve(args.memory), 'utf8'));
const comparison = compareArenaResults(baseline, memory);
if (args.output) {
  const output = resolve(args.output);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(comparison, null, 2) + '\n');
}
console.log(JSON.stringify(comparison, null, 2));

function parseArgs(argv) {
  const result = {};
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const index = arg.indexOf('=');
    if (index > 2) result[arg.slice(2, index).replaceAll('-', '_')] = arg.slice(index + 1);
  }
  return result;
}
