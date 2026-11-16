# Docker / Docker 部署

LITSAN (formerly Memhub) as one container: the vendored Memory Core and the MCP gateway, with all state in one volume.
LITSAN（原名 Memhub）打包为一个容器：内置的 Memory Core 与 MCP gateway，全部状态保存在一个 volume 中。

## What is in the image / 镜像内容

- EN: Same runtime as the Linux packages: `scripts/run-stack.mjs` supervises Core (`127.0.0.1:18960`) and the gateway (`127.0.0.1:3101`) inside the container. A small forwarder in `docker/entrypoint.mjs` exposes the gateway on container port `3001` (`/mcp`, health `/memhub/health`).
- 中文：与 Linux 安装包相同的运行时：容器内由 `scripts/run-stack.mjs` 托管 Core（`127.0.0.1:18960`）和 gateway（`127.0.0.1:3101`）。`docker/entrypoint.mjs` 中的小型转发器把 gateway 暴露在容器端口 `3001`（`/mcp`，健康检查 `/memhub/health`）。
- EN: Platforms: `linux/amd64` and `linux/arm64`. The build stage runs on the build machine and installs the target's prebuilt native modules (better-sqlite3, onnxruntime-node 1.30 — ships `linux/arm64` and `linux/x64`, sqlite-vec, sharp); the runtime stage only copies files, so either platform builds on either host without QEMU. `docker/verify-arch.mjs` fails the build if any native module has the wrong CPU.
- 中文：平台：`linux/amd64` 与 `linux/arm64`。构建阶段在构建机本机平台运行，安装目标平台的预编译原生模块（better-sqlite3、onnxruntime-node 1.30——自带 `linux/arm64` 和 `linux/x64`、sqlite-vec、sharp）；运行阶段只复制文件，因此任一平台都能在任一主机上构建，无需 QEMU。若有原生模块 CPU 不符，`docker/verify-arch.mjs` 会让构建失败。
- EN: Embedding model: `Xenova/all-MiniLM-L6-v2` (q8, 23 MB) is **baked into the image** at `/opt/litsan-models` (`LITSAN_EMBEDDING_MODEL_ROOT`), pinned by revision and SHA-256 in `docker/fetch-model.mjs`. The container never downloads a model and works offline.
- 中文：嵌入模型：`Xenova/all-MiniLM-L6-v2`（q8，23 MB）**已内置在镜像中**，位于 `/opt/litsan-models`（`LITSAN_EMBEDDING_MODEL_ROOT`），在 `docker/fetch-model.mjs` 中固定版本与 SHA-256。容器从不下载模型，可离线运行。
- EN: Runs as the non-root `node` user (uid 1000). Docker `HEALTHCHECK` calls the gateway health route. No tokens or account ids are in the image.
- 中文：以非 root 用户 `node`（uid 1000）运行。Docker `HEALTHCHECK` 调用 gateway 健康接口。镜像中不含任何 token 或账号 id。

## Run with compose / 用 compose 运行

```bash
docker compose up -d --build
```

```bash
docker/smoke.sh http://127.0.0.1:13001
```

- EN: MCP endpoint: `http://127.0.0.1:13001/mcp`; health: `http://127.0.0.1:13001/memhub/health`. Host port 13001 keeps clear of a native LITSAN on 3001; set `LITSAN_HOST_PORT` to change it.
- 中文：MCP 地址：`http://127.0.0.1:13001/mcp`；健康检查：`http://127.0.0.1:13001/memhub/health`。主机端口 13001 是为了避开本机原生安装占用的 3001；可用 `LITSAN_HOST_PORT` 修改。
- EN: If Docker has no usable bridge network (daemon `"bridge": "none"`, or "all predefined address pools have been fully subnetted"), add the host-network override. It keeps every port on host loopback (13001 MCP, 23101 gateway, 28960 Core):
- 中文：若 Docker 没有可用的 bridge 网络（daemon 配置 `"bridge": "none"`，或报 "all predefined address pools have been fully subnetted"），叠加 host 网络覆盖文件。所有端口都只在主机 loopback 上（13001 MCP、23101 gateway、28960 Core）：

```bash
docker compose -f docker-compose.yml -f docker-compose.hostnet.yml up -d
```

## Build for several platforms / 多平台构建

```bash
docker buildx build --platform linux/amd64,linux/arm64 -t litsan:local .
```

- EN: Without buildx (legacy builder), build only the host's own platform, passing the platform args by hand: `docker build --build-arg BUILDPLATFORM=linux/amd64 --build-arg TARGETARCH=amd64 -t litsan:local .` The legacy builder cannot mix an amd64 build stage with an arm64 runtime stage, so cross-platform images need buildx (BuildKit).
- 中文：没有 buildx（旧版 builder）时只能构建本机平台，并手动传入平台参数：`docker build --build-arg BUILDPLATFORM=linux/amd64 --build-arg TARGETARCH=amd64 -t litsan:local .` 旧版 builder 不能把 amd64 构建阶段与 arm64 运行阶段混用，跨平台镜像需要 buildx（BuildKit）。
- EN: To test an arm64 image on an amd64 machine without registering QEMU on the host, run `docker/test/arm64-emulated/run.sh litsan:local-arm64`. The harness container has no network. Inside its own user namespace it registers `qemu-aarch64` in a private binfmt_misc instance (needs Linux 6.7+), then runs the image's rootfs as uid 1000: entrypoint, HEALTHCHECK, `docker/smoke.sh`, a turn record → memory load, and a SIGTERM stop. It needs `--privileged` only to create that namespace.
- 中文：要在 amd64 机器上测试 arm64 镜像而不在主机注册 QEMU，运行 `docker/test/arm64-emulated/run.sh litsan:local-arm64`。该测试容器没有网络，会在自己的 user namespace 里把 `qemu-aarch64` 注册到私有的 binfmt_misc 实例（需要 Linux 6.7+），然后以 uid 1000 运行镜像的 rootfs：entrypoint、HEALTHCHECK、`docker/smoke.sh`、turn record → memory load，以及 SIGTERM 停止。它只是为了创建该 namespace 才需要 `--privileged`。
- EN: If the build container cannot resolve DNS (bridge networking disabled), add `--network host` to the build.
- 中文：若构建容器无法解析 DNS（bridge 网络被禁用），构建时加 `--network host`。

## State and first start / 状态与首次启动

- EN: Everything lives in the `/data` volume: `memhub.env`, `memory-config.yaml`, `memory/memory.sqlite`, `server/` (control root, accounts, `local-admin-token`). Files are `0600`, directories `0700`.
- 中文：所有状态都在 `/data` volume 中：`memhub.env`、`memory-config.yaml`、`memory/memory.sqlite`、`server/`（control root、账号、`local-admin-token`）。文件权限 `0600`，目录 `0700`。
- EN: On the first start of an empty volume the entrypoint does what the Linux installer does: generates the Core token, writes the config, creates the owner account and writes `memhub.env` last. An interrupted first start resumes safely.
- 中文：空 volume 首次启动时，entrypoint 执行与 Linux 安装器相同的步骤：生成 Core token、写入配置、创建 owner 账号，最后写 `memhub.env`。首次启动中断后可安全续做。
- EN: First-start settings (stored in `/data/memhub.env`, later changes need an edit there): `LITSAN_USERNAME` (default `local`), `LITSAN_EMAIL`, `LITSAN_PUBLIC_HOST`, `LITSAN_MEMORY_TOKEN` (optional; generated if unset).
- 中文：首次启动参数（保存到 `/data/memhub.env`，之后要改需编辑该文件）：`LITSAN_USERNAME`（默认 `local`）、`LITSAN_EMAIL`、`LITSAN_PUBLIC_HOST`、`LITSAN_MEMORY_TOKEN`（可选；未设置则自动生成）。
- EN: Every-start settings: any `LITSAN_*` runtime switch (for example `LITSAN_DERIVED_FACT_RETRIEVAL=semantic`), plus `LITSAN_LISTEN_HOST`, `LITSAN_LISTEN_PORT`, `LITSAN_GATEWAY_INTERNAL_PORT`, `LITSAN_CORE_PORT`.
- 中文：每次启动都生效的参数：任意 `LITSAN_*` 运行时开关（例如 `LITSAN_DERIVED_FACT_RETRIEVAL=semantic`），以及 `LITSAN_LISTEN_HOST`、`LITSAN_LISTEN_PORT`、`LITSAN_GATEWAY_INTERNAL_PORT`、`LITSAN_CORE_PORT`。
- EN: Local admin token for the Control Plane: `docker compose exec litsan node dist/mcp.js admin-token show --state-root /data/server`.
- 中文：Control Plane 的本地管理 token：`docker compose exec litsan node dist/mcp.js admin-token show --state-root /data/server`。
- EN: One volume belongs to one container. The entrypoint holds an `flock` on `/data/.container.lock`; a second container on the same volume exits with code 75. Because of that lock, a stack lock left by a killed container is removed automatically on the next start.
- 中文：一个 volume 只属于一个容器。entrypoint 持有 `/data/.container.lock` 上的 `flock`；同一 volume 上的第二个容器会以退出码 75 退出。有了这把锁，被强杀的容器遗留的 stack lock 会在下次启动时自动清除。
- EN: Backup: stop the container, then copy the volume, e.g. `docker run --rm -v litsan_litsan-data:/data -v "$PWD":/backup node:22-bookworm-slim tar -czf /backup/litsan-data.tgz -C /data .`.
- 中文：备份：先停容器，再复制 volume，例如 `docker run --rm -v litsan_litsan-data:/data -v "$PWD":/backup node:22-bookworm-slim tar -czf /backup/litsan-data.tgz -C /data .`。

## Security boundary / 安全边界

- EN: The gateway trusts loopback peers as local clients. Inside the container the forwarder connects from loopback, so **the published host port is the trust boundary**. Compose publishes it on `127.0.0.1` only; do not publish it on `0.0.0.0` or a LAN address.
- 中文：gateway 把 loopback 来源视为本地客户端。容器内转发器从 loopback 连接 gateway，因此**发布到主机的端口就是信任边界**。compose 只把它发布到 `127.0.0.1`；不要发布到 `0.0.0.0` 或局域网地址。
- EN: For remote use, set `LITSAN_PUBLIC_HOST` on first start and put an authenticated proxy in front of the host port (for example Cloudflare Tunnel + Access to `http://127.0.0.1:13001`), as in [remote-auth.md](remote-auth.md) and [cloudflare-tunnel.md](cloudflare-tunnel.md).
- 中文：远程使用时，首次启动设置 `LITSAN_PUBLIC_HOST`，并在主机端口前放一个带认证的代理（例如 Cloudflare Tunnel + Access 指向 `http://127.0.0.1:13001`），见 [remote-auth.md](remote-auth.md) 与 [cloudflare-tunnel.md](cloudflare-tunnel.md)。
- EN: This image is not a published release: nothing is pushed to a registry.
- 中文：本镜像不是正式发布版本：没有推送到任何镜像仓库。
