#!/usr/bin/env node
import http from "node:http";
import { createEmbedder } from "../vendor/memory-core/src/model/embedder.js";

const HOST = process.env.MEMORY_ARENA_EMBED_HOST || "127.0.0.1";
const PORT = Number(process.env.MEMORY_ARENA_EMBED_PORT || 19120);
const MODEL = process.env.MEMORY_ARENA_EMBED_MODEL || "Xenova/all-MiniLM-L6-v2";

const embedder = createEmbedder({
  provider: "local",
  model: MODEL,
  normalize: true,
  cache: true
});

// Warm the model before binding the port so /health implies embeddings are ready.
const warm = await embedder.embedOne("memory arena embedding warmup", "query");
const dimension = warm.length;

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") {
      return send(res, 200, { ok: true, model: MODEL, dimension });
    }
    if (req.method !== "POST" || req.url !== "/v1/embeddings") {
      return send(res, 404, { error: { message: "Only POST /v1/embeddings is supported" } });
    }
    const body = JSON.parse(await readBody(req));
    const inputs = Array.isArray(body.input) ? body.input.map(String) : [String(body.input ?? "")];
    const vectors = await embedder.embed(inputs, "document");
    return send(res, 200, {
      object: "list",
      model: MODEL,
      data: vectors.map((embedding, index) => ({ object: "embedding", index, embedding })),
      usage: { prompt_tokens: 0, total_tokens: 0 }
    });
  } catch (error) {
    return send(res, 500, { error: { message: error instanceof Error ? error.message : String(error) } });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`memory_arena_embedding_proxy=http://${HOST}:${PORT}/v1`);
  console.log(`model=${MODEL}`);
  console.log(`dimension=${dimension}`);
});

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 32 * 1024 * 1024) reject(new Error("request body too large"));
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function send(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}
