#!/bin/sh
# Runs inside the harness container (--network none). Extract the arm64 image
# rootfs, then enter a private user+mount+pid namespace for the emulated run.
set -eu
mkdir -p /arm64root && tar -xpf /work/rootfs.tar -C /arm64root
exec unshare --user --map-users=0,0,65536 --map-groups=0,0,65536 --mount --pid --fork --mount-proc sh /work/inner.sh
