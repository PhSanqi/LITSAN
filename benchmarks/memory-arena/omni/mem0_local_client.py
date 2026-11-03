"""OmniMemEval adapter for the isolated local Mem0 OSS Arena service."""

from .base_client import BaseApiClient, env_float, env_int, env_str, iter_batches


class Mem0LocalClient(BaseApiClient):
    def __init__(self):
        super().__init__(
            base_url=env_str("MEM0_ARENA_BASE_URL", "http://127.0.0.1:19096"),
            headers={"Content-Type": "application/json"},
            qps=0,
            timeout=env_int("MEM0_ARENA_TIMEOUT", 600, min_value=1),
        )
        self._batch_size = env_int("MEM0_BATCH_SIZE", 20, min_value=1)
        self._threshold = env_float("MEM0_SEARCH_THRESHOLD", 0.0, min_value=0)
        self._custom_instructions = None

    def set_custom_instructions(self, text):
        self._custom_instructions = str(text) if text else None

    @staticmethod
    def _fmt(msg):
        content = str(msg.get("content", ""))
        chat_time = msg.get("chat_time")
        if chat_time:
            content = f"[{chat_time}] {content}"
        return {"role": msg.get("role", "user"), "content": content}

    def add(self, messages, user_id, batch_size=None, **_kwargs):
        formatted = [self._fmt(message) for message in messages]
        for batch in iter_batches(formatted, batch_size or self._batch_size):
            payload = {"messages": batch, "user_id": user_id}
            if self._custom_instructions:
                payload["custom_instructions"] = self._custom_instructions
            response = self._post("/add", json=payload)
            response.raise_for_status()

    def search(self, query, user_id, top_k):
        response = self._post(
            "/search",
            json={
                "query": query,
                "user_id": user_id,
                "top_k": top_k,
                "threshold": self._threshold,
            },
        )
        response.raise_for_status()
        payload = response.json()
        memories = payload.get("results") if isinstance(payload, dict) else []
        return "\n".join(
            str(item.get("memory", ""))
            for item in (memories or [])
            if isinstance(item, dict) and item.get("memory")
        )

    def delete_all(self, user_id):
        response = self._post("/reset-user", json={"user_id": user_id})
        response.raise_for_status()

