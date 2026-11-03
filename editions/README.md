# Editions

LITSAN (formerly Memhub). Legacy `MEMHUB_*` / `MEMMY_*` environment variables still work.

LITSAN ships one shared core with two deployment profiles:

- `server/`: central multi-device deployment with authenticated remote MCP and capture.
- `local/`: standalone loopback deployment for users without a server.
- root `install-complete.sh` / `install-complete.ps1`: self-contained release installers that use the bundled target-OS Node runtime, production dependencies and prebuilt output, then select either Local or Server mode from the same archive.

See [Edition and release documentation](../docs/operations/editions.md) for the architectural contract.
