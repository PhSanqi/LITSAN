#!/bin/sh
# Container entrypoint: one container owns one /data volume.
#
# run-stack.mjs never deletes an existing stack lock (it cannot prove the owner
# is dead). In a container we can: an flock on the volume is held for the whole
# life of the stack, so if we obtain it no other container is using this
# volume, and any stack lock left behind is from a crashed or killed container.
set -eu
DATA="${LITSAN_HOME:-/data}"
mkdir -p "$DATA" "${HOME:-$DATA/home}"
exec 9>"$DATA/.container.lock"
if ! flock -n 9; then
  echo "[litsan] $DATA is in use by another container; refusing to share a state volume" >&2
  exit 75
fi
for stale in "$DATA/.memhub-stack.lock" "$DATA/.memhub-stack.lock.stop"; do
  if [ -e "$stale" ]; then
    echo "[litsan] removing stack lock left by a previous container: $stale" >&2
    rm -f "$stale"
  fi
done
# fd 9 stays open in node (and the services it spawns), keeping the volume lock.
exec node /opt/litsan/docker/entrypoint.mjs "$@"
