# LITSAN Server Edition

LITSAN (formerly Memhub). Legacy `MEMHUB_*` / `MEMMY_*` environment variables still work.

Server Edition runs the central Memory Core and LITSAN MCP runtime on loopback. Publish `/mcp` only through an authenticated reverse proxy such as Cloudflare Access/Tunnel; the public route terminates at the same loopback MCP runtime used by local clients.

- Linux: `LITSAN_PUBLIC_HOST=memory.example.com bash linux/install.sh`
- Windows: `powershell -ExecutionPolicy Bypass -File .\windows\install.ps1 -PublicHost memory.example.com`

Remote MCP clients authenticate at the reverse-proxy boundary.
