#!/usr/bin/env python3
"""Isolated local Mem0 OSS service for Memory Arena.

Runs the Mem0 Python library against a local Qdrant path, the Arena CPU
embedding proxy, and the Arena DeepSeek proxy.  It deliberately exposes only
the tiny add/search/reset contract needed by OmniMemEval.
"""

from __future__ import annotations

import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
STATE_ROOT = Path(
    os.environ.get(
        "MEM0_ARENA_STATE_ROOT",
        ROOT / ".review-runtime" / "memory-arena" / "state" / "mem0",
    )
).resolve()
HOST = os.environ.get("MEM0_ARENA_HOST", "127.0.0.1")
PORT = int(os.environ.get("MEM0_ARENA_PORT", "19096"))
LLM_BASE_URL = os.environ.get("MEM0_ARENA_LLM_BASE_URL", "http://127.0.0.1:19095/v1")
LLM_MODEL = os.environ.get("MEM0_ARENA_LLM_MODEL", "deepseek-flash")
EMBED_BASE_URL = os.environ.get("MEM0_ARENA_EMBED_BASE_URL", "http://127.0.0.1:19093/v1")

os.environ.setdefault("MEM0_TELEMETRY", "false")
os.environ.setdefault("MEM0_DIR", str(STATE_ROOT))

STATE_ROOT.mkdir(parents=True, exist_ok=True)
(STATE_ROOT / "qdrant").mkdir(parents=True, exist_ok=True)

from mem0 import Memory  # noqa: E402  (env isolation must be set first)


memory = Memory.from_config(
    {
        "vector_store": {
            "provider": "qdrant",
            "config": {
                "collection_name": "memory_arena",
                "path": str(STATE_ROOT / "qdrant"),
                "embedding_model_dims": 384,
                "on_disk": True,
            },
        },
        "llm": {
            "provider": "openai",
            "config": {
                "model": LLM_MODEL,
                "api_key": "memory-arena",
                "openai_base_url": LLM_BASE_URL,
                "temperature": 0,
                "max_tokens": 2048,
            },
        },
        "embedder": {
            "provider": "openai",
            "config": {
                "model": "BAAI/bge-small-en-v1.5",
                "api_key": "memory-arena",
                "openai_base_url": EMBED_BASE_URL,
                "embedding_dims": 384,
            },
        },
        "history_db_path": str(STATE_ROOT / "history.db"),
        "version": "v1.1",
    }
)

lock = threading.RLock()


class Handler(BaseHTTPRequestHandler):
    server_version = "LitsanMemoryArenaMem0/1"

    def log_message(self, fmt, *args):
        return

    def _json(self, status, value):
        body = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        size = int(self.headers.get("content-length", "0"))
        return json.loads(self.rfile.read(size) or b"{}")

    def do_GET(self):
        if self.path == "/health":
            self._json(
                200,
                {
                    "ok": True,
                    "backend": "mem0-oss",
                    "state_root": str(STATE_ROOT),
                    "llm": LLM_MODEL,
                    "embedding": "BAAI/bge-small-en-v1.5",
                },
            )
            return
        self._json(404, {"error": "not found"})

    def do_POST(self):
        try:
            body = self._body()
            if self.path == "/add":
                user_id = str(body["user_id"])
                messages = body.get("messages") or []
                custom_instructions = body.get("custom_instructions")
                with lock:
                    result = memory.add(
                        messages,
                        user_id=user_id,
                        prompt=str(custom_instructions) if custom_instructions else None,
                    )
                self._json(200, {"ok": True, "result": result})
                return
            if self.path == "/search":
                user_id = str(body["user_id"])
                query = str(body["query"])
                top_k = max(1, min(100, int(body.get("top_k", 20))))
                threshold = float(body.get("threshold", 0.0))
                with lock:
                    result = memory.search(
                        query,
                        top_k=top_k,
                        filters={"user_id": user_id},
                        threshold=threshold,
                        rerank=False,
                    )
                self._json(200, result)
                return
            if self.path == "/reset-user":
                user_id = str(body["user_id"])
                with lock:
                    result = memory.delete_all(user_id=user_id)
                self._json(200, {"ok": True, "result": result})
                return
            self._json(404, {"error": "not found"})
        except Exception as exc:
            self._json(500, {"error": f"{type(exc).__name__}: {exc}"})


if __name__ == "__main__":
    print(f"memory_arena_mem0_service=http://{HOST}:{PORT}", flush=True)
    print(f"state_root={STATE_ROOT}", flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
