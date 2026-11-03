# `litsan-memory get`

Intent map:
- read one memory item by id -> `litsan-memory get <id>`;
- inspect a memory before deletion -> `litsan-memory get <id>`;
- fetch the compact agent-readable detail behind a search hit -> `litsan-memory get <id>`;
- debug the full raw detail payload -> `litsan-memory get <id> --verbose`.

Use this command when:
- a concrete memory id is available from `search`, `add`, `turn complete`, or `raw`;
- the agent needs compact content for one item;
- the agent needs raw refs, version, etag, or timeline internals and can pass `--verbose`;
- the agent needs to verify a memory before acting on it.

API shape:
- endpoint: `GET /memory/:id`;
- the memory id is sent in the URL path;
- the CLI accepts the id as `<id>` or `--id <id>`;
- default output is compact markdown-like text with id, kind, layer, title, summary, and body;
- `--verbose` returns the full JSON detail payload, including metadata and refs;
- no request body is sent.

Do not use this command to:
- look up memories without an id;
- guess ids from titles or summaries;
- delete or mutate memory.

Command:

```bash
litsan-memory get <id>
```

Common flags:

- `--id <id>`
- `--verbose`

Example:

```bash
litsan-memory get mem_123
litsan-memory get mem_123 --verbose
```

Working rules:
- use ids returned by Memory API responses;
- if injected memory text says to call `litsan_memory_get(id="...")` but that tool is unavailable, run `litsan-memory get <id>` with the same id;
- inspect the returned item before deleting when the target is not fully known;
- pass `--verbose` only when debugging raw metadata, refs, version, etag, or timeline internals;
- treat missing items as unavailable, not as proof that related knowledge does not exist.
