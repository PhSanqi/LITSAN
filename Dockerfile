# syntax=docker/dockerfile:1
# LITSAN container image: vendored Memory Core + MCP gateway in one container.
#
# Multi-arch without emulation: the build stage always runs on the build
# machine's own platform ($BUILDPLATFORM) and installs the *target* platform's
# prebuilt native modules (better-sqlite3, onnxruntime-node, sqlite-vec, sharp).
# The runtime stage only copies files, so linux/arm64 can be built on an amd64
# host (and vice versa) without QEMU:
#
#   docker buildx build --platform linux/amd64,linux/arm64 -t litsan:local .
#
# Legacy builder (no buildx): pass the platform args by hand, e.g.
#   docker build --platform linux/arm64 --build-arg BUILDPLATFORM=linux/amd64 \
#     --build-arg TARGETARCH=arm64 -t litsan:local-arm64 .

ARG NODE_IMAGE=node:22-bookworm-slim
# Predefined by BuildKit; declared so the legacy builder accepts --build-arg BUILDPLATFORM.
ARG BUILDPLATFORM

FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS build
ARG TARGETARCH
WORKDIR /src

# Local embedding model (Xenova/all-MiniLM-L6-v2, q8), baked into the image so
# first start needs no network (the model is arch-independent). Revision and
# SHA-256 are pinned in docker/fetch-model.mjs.
COPY docker/fetch-model.mjs /tmp/fetch-model.mjs
RUN node /tmp/fetch-model.mjs /opt/litsan-models

COPY package.json package-lock.json .npmrc ./
# npm selects optional platform packages by --cpu/--os/--libc; prebuild-install
# (better-sqlite3) follows npm_config_arch. Neither executes target binaries.
RUN set -eux; \
    case "${TARGETARCH:-amd64}" in \
      amd64) cpu=x64 ;; arm64) cpu=arm64 ;; *) echo "unsupported TARGETARCH=$TARGETARCH" >&2; exit 1 ;; \
    esac; \
    echo "$cpu" > /tmp/target-cpu; \
    npm_config_arch="$cpu" npm_config_platform=linux ONNXRUNTIME_NODE_INSTALL=skip \
      npm ci --cpu="$cpu" --os=linux --libc=glibc --no-audit --no-fund

COPY tsconfig.json tsconfig.base.json ./
COPY src ./src
COPY scripts/clean-dist.mjs ./scripts/clean-dist.mjs
RUN npm run build

# Runtime tree: production deps only, and only the target's native binaries.
RUN set -eux; \
    cpu="$(cat /tmp/target-cpu)"; \
    npm prune --omit=dev --cpu="$cpu" --os=linux --libc=glibc --no-audit --no-fund; \
    ort=node_modules/onnxruntime-node/bin/napi-v6; \
    for d in "$ort"/*/*; do [ "$d" = "$ort/linux/$cpu" ] || rm -rf "$d"; done; \
    rm -rf .tsbuild node_modules/@img/*linuxmusl*; \
    # transformers' Node build inlines its own ort-web bundle and loads
    # onnxruntime-node; the separate onnxruntime-web package (~140 MB) is unused.
    rm -rf node_modules/onnxruntime-web
COPY vendor ./vendor
COPY web-assets ./web-assets
COPY docs/site ./docs/site
COPY scripts/run-stack.mjs ./scripts/run-stack.mjs
COPY docker/entrypoint.sh docker/entrypoint.mjs docker/healthcheck.mjs docker/verify-arch.mjs ./docker/
# Fail the build if any native module is for the wrong CPU (e.g. a silent
# node-gyp fallback compiled for the build host instead of the target).
# COPY keeps the checkout's modes; normalise them so the non-root runtime user
# can read the app even when it was cloned with a strict umask (e.g. 077).
RUN node docker/verify-arch.mjs "$(cat /tmp/target-cpu)" node_modules \
    && mkdir -p /out /out-data \
    && cp -a package.json dist vendor web-assets docs scripts docker node_modules /out/ \
    && chmod -R a+rX,go-w /out /opt/litsan-models \
    && chmod 0755 /out/docker/entrypoint.sh

FROM ${NODE_IMAGE} AS runtime
# No RUN in this stage: it must build for any target platform without emulation.
# The base image's `node` user (uid/gid 1000) runs everything.
ENV NODE_ENV=production \
    HOME=/data/home \
    LITSAN_HOME=/data \
    LITSAN_EMBEDDING_MODEL_ROOT=/opt/litsan-models \
    LITSAN_CORE_PORT=18960 \
    LITSAN_GATEWAY_INTERNAL_PORT=3101 \
    LITSAN_LISTEN_PORT=3001
COPY --from=build /opt/litsan-models /opt/litsan-models
COPY --from=build --chown=node:node /out-data /data
COPY --from=build /out /opt/litsan
WORKDIR /opt/litsan
USER node
VOLUME ["/data"]
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "/opt/litsan/docker/healthcheck.mjs"]
ENTRYPOINT ["/opt/litsan/docker/entrypoint.sh"]
