"""Arena-only EverOS adapter for the current self-hosted API.

OmniMemEval's upstream EverOS adapter still targets the older
``/api/v1/memories/*`` surface.  Current EverOS exposes
``/api/v1/memory/add|flush|search``.  This subclass preserves OmniMemEval's
benchmark contract while translating only the transport shape.

This file is copied into the review-runtime OmniMemEval checkout by
``scripts/memory-arena-patch-omni.mjs``.  It is not a production Memhub
dependency.
"""

from .everos_client import EverosClient
from .base_client import iter_batches


class EverosCurrentClient(EverosClient):
    """Translate OmniMemEval EverOS calls to the current local EverOS API."""

    def delete(self, user_id):
        # Current self-hosted EverOS no longer exposes the old benchmark delete
        # endpoint.  Arena runs use unique versioned ids and isolated state, so
        # cleanup is done by resetting the isolated state directory between runs.
        return None

    def delete_group(self, group_id):
        return None

    def _current_add(self, messages, owner_id, session_id, batch_size=None):
        for batch in iter_batches(
            messages,
            batch_size or self._batch_size,
            max_chars=self._max_batch_chars,
        ):
            everos_msgs = []
            for msg in batch:
                original_sender = (
                    msg.get("name")
                    or msg.get("sender_name")
                    or msg.get("sender_id")
                    or msg.get("role")
                    or "user"
                )
                role = msg.get("role", "user")
                if role not in ("user", "assistant", "tool"):
                    role = "user"
                everos_msgs.append(
                    {
                        # One synthetic owner per benchmark conversation.  The
                        # original participant remains in sender_name and content.
                        "sender_id": owner_id,
                        "sender_name": str(original_sender),
                        "role": role,
                        "timestamp": self._to_unix_ms(msg.get("chat_time")),
                        "content": self._clean_latex_delimiters_for_everos(
                            msg["content"]
                        ),
                    }
                )
            payload = {
                "session_id": str(session_id),
                "app_id": "omnimemeval",
                "project_id": "memory-arena",
                "messages": everos_msgs,
                "defer_extraction": False,
                "async_mode": self._async_mode,
            }

            def _do(p=payload):
                resp = self._post("/api/v1/memory/add", json=p)
                self._check_rate_limit(resp)
                if resp.status_code not in (200, 202):
                    resp.raise_for_status()
                return resp.json()

            self._retry(_do)

    def _current_flush(self, session_id):
        payload = {
            "session_id": str(session_id),
            "app_id": "omnimemeval",
            "project_id": "memory-arena",
        }

        def _do():
            resp = self._post("/api/v1/memory/flush", json=payload)
            self._check_rate_limit(resp)
            if resp.status_code not in (200, 202):
                resp.raise_for_status()
            return resp.json()

        return self._retry(_do)

    def add_group(self, messages, group_id, batch_size=None, flush=None):
        self._current_add(messages, group_id, group_id, batch_size=batch_size)
        should_flush = self._flush_policy != "never" if flush is None else flush
        if should_flush:
            self._current_flush(group_id)

    def add(self, messages, user_id, conv_id=None, batch_size=None, flush=None):
        if self._use_group:
            return self.add_group(
                messages, user_id, batch_size=batch_size, flush=flush
            )
        session_id = str(conv_id) if conv_id is not None else str(user_id)
        self._current_add(messages, user_id, session_id, batch_size=batch_size)
        should_flush = self._flush_policy != "never" if flush is None else flush
        if should_flush:
            self._current_flush(session_id)

    def flush(self, user_id, session_id=None):
        return self._current_flush(session_id or user_id)

    def flush_group(self, group_id):
        return self._current_flush(group_id)

    def search(self, query, user_id, top_k):
        payload = {
            "user_id": user_id,
            "app_id": "omnimemeval",
            "project_id": "memory-arena",
            "query": query,
            "method": self._search_method,
            "top_k": top_k,
            "include_profile": self._fetch_profile,
        }
        if self._use_group:
            payload["filters"] = {"session_id": user_id}

        def _do():
            resp = self._post("/api/v1/memory/search", json=payload)
            self._check_rate_limit(resp)
            if resp.status_code != 200:
                resp.raise_for_status()
            return resp.json()

        result = self._retry(_do)
        return self._format_as_text(result.get("data", {}), None)
