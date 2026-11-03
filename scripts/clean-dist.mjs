#!/usr/bin/env node
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(fileURLToPath(new URL("..", import.meta.url)));
await rm(resolve(repo, "dist"), { recursive: true, force: true });
// Both directories contain generated build artifacts; remove them together.
await rm(resolve(repo, ".tsbuild"), { recursive: true, force: true });
