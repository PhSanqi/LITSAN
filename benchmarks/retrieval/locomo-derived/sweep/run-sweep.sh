#!/usr/bin/env bash
# usage: run-sweep.sh <arms.json> <suffix> <workers> [questions.json]
# Splits the arm list round-robin over N workers; each worker queries from its own copy of the ingested state.
set -euo pipefail
ARMS=$(realpath "$1"); SUF=$2; W=${3:-4}; Q=$(realpath "${4:-sets/p3-tune-pool.json}")
HERE=$(cd "$(dirname "$0")/.." && pwd); RT="$HERE/../../../.review-runtime"; SRC="$RT/locomo-derived"
for i in $(seq 1 "$W"); do
  D="$RT/sweep-w$i"; mkdir -p "$D"
  [ -d "$D/state" ] || cp -a --reflink=auto "$SRC/state" "$D/state"
  python3 - "$ARMS" "$SUF" "$i" "$W" "$(cd "$HERE/../../.." && pwd)" > "$D/arms-$SUF.json" <<'P'
import json, sys
arms, suf, i, w, repo = json.load(open(sys.argv[1])), sys.argv[2], int(sys.argv[3]), int(sys.argv[4]), sys.argv[5]
print(json.dumps([[f"{n}-{suf}", repo, f, e] for k, (n, f, e) in enumerate(arms) if k % w == i - 1]))
P
  ( cd "$HERE" && P0_OUT="sweep-w$i" P0_CORE_PORT=$((19700 + i * 10)) P0_QUESTIONS="$Q" P0_ARMS="$(cat "$D/arms-$SUF.json")" \
      node run.mjs query > "$D/log-$SUF.txt" 2>&1 ) &
done
wait
echo sweep done
