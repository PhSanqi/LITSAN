#!/usr/bin/env python3
"""Memory Arena local OpenAI-compatible embedding proxy.

The service is benchmark-only.  It uses FastEmbed/ONNX on CPU and exposes the
minimal `/v1/embeddings` contract used by local memory backends.  Keeping one
embedding model across compatible systems gives the Arena a provider-unified
track without requiring another cloud credential.
"""

from __future__ import annotations

import json
import os
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from fastembed import TextEmbedding


HOST = os.environ.get("MEMORY_ARENA_EMBED_HOST", "127.0.0.1")
PORT = int(os.environ.get("MEMORY_ARENA_EMBED_PORT", "19093"))
MODEL = os.environ.get("MEMORY_ARENA_EMBED_MODEL", "BAAI/bge-small-en-v1.5")

embedder = TextEmbedding(model_name=MODEL)


def _inputs(value):
    if isinstance(value, str):
        return [value]
    if isinstance(value, list):
        return [str(v) for v in value]
    raise ValueError("input must be a string or list of strings")


class Handler(BaseHTTPRequestHandler):
    server_version = "LitsanMemoryArenaEmbedding/1"

    def log_message(self, fmt, *args):
        # Keep benchmark logs compact; callers capture latency separately.
        return

    def _json(self, status, value):
        body = json.dumps(value, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._json(200, {"ok": True, "model": MODEL, "provider": "fastembed-cpu"})
            return
        self._json(404, {"error": {"message": "not found"}})

    def do_POST(self):
        if self.path not in ("/v1/embeddings", "/embeddings"):
            self._json(404, {"error": {"message": "only /v1/embeddings is supported"}})
            return
        try:
            size = int(self.headers.get("content-length", "0"))
            payload = json.loads(self.rfile.read(size) or b"{}")
            texts = _inputs(payload.get("input"))
            started = time.perf_counter()
            vectors = [vector.tolist() for vector in embedder.embed(texts)]
            elapsed_ms = round((time.perf_counter() - started) * 1000, 2)
            data = [
                {"object": "embedding", "index": idx, "embedding": vector}
                for idx, vector in enumerate(vectors)
            ]
            # Token counts are deliberately omitted rather than pretending to
            # be OpenAI tokenizer counts.  The Arena records wall time itself.
            self._json(
                200,
                {
                    "object": "list",
                    "data": data,
                    "model": MODEL,
                    "usage": {"prompt_tokens": 0, "total_tokens": 0},
                    "arena_elapsed_ms": elapsed_ms,
                },
            )
        except Exception as exc:  # benchmark service: surface exact failure
            self._json(500, {"error": {"message": str(exc)}})


if __name__ == "__main__":
    print(f"memory_arena_embedding_proxy=http://{HOST}:{PORT}/v1", flush=True)
    print(f"model={MODEL}", flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
