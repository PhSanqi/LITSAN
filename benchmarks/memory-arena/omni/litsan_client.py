import os
import requests

from .base_client import BaseApiClient, env_float, env_int, env_str


class LitsanClient(BaseApiClient):
    """OmniMemEval adapter for the isolated LITSAN Memory Arena service."""

    def __init__(self):
        base_url = env_str("MEMHUB_ARENA_BASE_URL", "http://127.0.0.1:19092")
        super().__init__(
            base_url=base_url,
            headers={"Content-Type": "application/json"},
            qps=env_float("MEMHUB_ARENA_QPS", 0.0) or None,
            timeout=env_int("MEMHUB_ARENA_TIMEOUT", 180),
        )

    def add(self, messages, user_id, conv_id=None, batch_size=None, **kwargs):
        payload = {
            "messages": messages,
            "user_id": user_id,
            "conv_id": conv_id,
            "session_key": kwargs.get("session_key"),
            "session_id": kwargs.get("session_id"),
        }
        response = self._post("/add", json=payload)
        response.raise_for_status()
        return response.json()

    def search(self, query, user_id, top_k):
        response = self._post("/search", json={"query": query, "user_id": user_id, "top_k": top_k})
        response.raise_for_status()
        payload = response.json()
        return "\n".join(item.get("memory", "") for item in payload.get("memories", []))

    def delete(self, user_id):
        return self._reset(user_id)

    def delete_all(self, user_id):
        return self._reset(user_id)

    def delete_user(self, user_id):
        return self._reset(user_id)

    def _reset(self, user_id):
        response = self._post("/reset-user", json={"user_id": user_id})
        response.raise_for_status()
        return response.json()

