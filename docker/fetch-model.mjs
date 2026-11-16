#!/usr/bin/env node
// Build-time download of the local embedding model, pinned by revision and SHA-256.
// usage: node docker/fetch-model.mjs <models-root>
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const MODEL = "Xenova/all-MiniLM-L6-v2";
const REVISION = "751bff37182d3f1213fa05d7196b954e230abad9";
const FILES = {
  "config.json": "7135149f7cffa1a573466c6e4d8423ed73b62fd2332c575bf738a0d033f70df7",
  "tokenizer.json": "da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0",
  "tokenizer_config.json": "9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3",
  "onnx/model_quantized.onnx": "afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1"
};
const root = process.argv[2];
if (!root) throw new Error("usage: fetch-model.mjs <models-root>");
const base = process.env.LITSAN_MODEL_BASE_URL || `https://huggingface.co/${MODEL}/resolve/${REVISION}`;

for (const [file, sha256] of Object.entries(FILES)) {
  let body;
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await fetch(`${base}/${file}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      body = Buffer.from(await response.arrayBuffer());
      break;
    } catch (error) {
      if (attempt >= 3) throw new Error(`download ${file} failed: ${error.message}`);
      await new Promise((done) => setTimeout(done, 1000 * attempt));
    }
  }
  const actual = createHash("sha256").update(body).digest("hex");
  if (actual !== sha256) throw new Error(`${file}: sha256 ${actual} != ${sha256}`);
  const target = join(root, MODEL, file);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, body);
  console.log(`model ${file} ${body.length} bytes sha256 ok`);
}
