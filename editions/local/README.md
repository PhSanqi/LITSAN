# LITSAN Local Edition

LITSAN (formerly Memhub). Legacy `MEMHUB_*` / `MEMMY_*` environment variables still work.

Local Edition runs Memory Core and the LITSAN MCP runtime on one machine. It requires no Cloudflare/VPS and binds both services to loopback.

- Linux: `bash linux/install.sh`
- Windows: `powershell -ExecutionPolicy Bypass -File .\windows\install.ps1`

MCP clients connect directly to `http://127.0.0.1:3001/mcp`; clients use the MCP endpoint directly.
