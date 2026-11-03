# `litsan-memory delete`

Intent map:
- remove one concrete memory by id -> `litsan-memory delete <id>`;
- delete a memory the user explicitly asked to remove -> `litsan-memory delete <id>`;
- remove a memory that is clearly wrong or unsafe to retain -> `litsan-memory delete <id>`.

Use this command when:
- the target memory id is already known;
- the user requested deletion of a specific memory;
- inspection confirms that a memory should no longer be retained.

API shape:
- endpoint: `DELETE /memory/:id`;
- the memory id is sent in the URL path;
- the CLI accepts the id as `<id>` or `--id <id>`;
- no request body is required for the standard delete command.

Do not use this command to:
- search for memories;
- delete an item when the id is uncertain;
- perform routine cleanup without a user request or clear safety reason.

Command:

```bash
litsan-memory delete <id>
```

Common flags:

- `--id <id>`

Example:

```bash
litsan-memory delete mem_123
```

Working rules:
- run `litsan-memory get <id>` first if the contents are uncertain;
- do not invent ids;
- treat deletion as a durable operation;
- keep the id available if the delete request fails and needs troubleshooting.
