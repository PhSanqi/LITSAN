#!/usr/bin/env bash
# Run a linux/arm64 LITSAN image on an amd64 host without changing the host:
# no host binfmt registration, no host network use at run time.
#   docker/test/arm64-emulated/run.sh [image]      (default litsan:local-arm64)
# The harness container runs with --network none and --privileged only so it
# can create a user namespace; inner.sh registers qemu-aarch64 in that
# namespace's private binfmt_misc instance (Linux 6.7+), chroots into the
# image's exported rootfs as uid 1000 and runs the entrypoint, the image
# HEALTHCHECK, docker/smoke.sh, a turn record -> memory load and a SIGTERM stop.
# Set HARNESS_BUILD_NETWORK=host if build containers cannot resolve DNS.
set -euo pipefail
IMAGE="${1:-litsan:local-arm64}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/litsan-arm64-emulated.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
docker build -q ${HARNESS_BUILD_NETWORK:+--network "$HARNESS_BUILD_NETWORK"} -t litsan-arm64-harness:local "$HERE" >/dev/null
docker image inspect --platform linux/arm64 "$IMAGE" --format '{{range .Config.Env}}{{println .}}{{end}}' | grep . > "$WORK/image.env"
id="$(docker create --platform linux/arm64 "$IMAGE")"
docker export "$id" -o "$WORK/rootfs.tar"; docker rm "$id" >/dev/null
cp "$HERE/outer.sh" "$HERE/inner.sh" "$HERE/../../smoke.sh" "$WORK/"
docker run --rm --network none --privileged -v "$WORK:/work" litsan-arm64-harness:local sh /work/outer.sh
