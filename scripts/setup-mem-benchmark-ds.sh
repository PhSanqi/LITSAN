#!/usr/bin/env bash
set -euo pipefail

config="${MEM_BENCH_DS_CONFIG:-$HOME/.config/memhub/mem-benchmark-ds.env}"
mkdir -p "$(dirname "$config")"

read -r -p "MEM_BENCH_DS_BASE_URL: " base_url
read -r -p "MEM_BENCH_DS_MODEL: " model
read -r -s -p "MEM_BENCH_DS_API_KEY: " api_key
printf '\n'

if [[ -z "$base_url" || -z "$model" || -z "$api_key" ]]; then
  echo "All three values are required." >&2
  exit 2
fi

escape_env() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

umask 077
tmp="$(mktemp "${config}.tmp.XXXXXX")"
trap 'rm -f "$tmp"' EXIT
{
  printf 'MEM_BENCH_DS_BASE_URL="%s"\n' "$(escape_env "$base_url")"
  printf 'MEM_BENCH_DS_MODEL="%s"\n' "$(escape_env "$model")"
  printf 'MEM_BENCH_DS_API_KEY="%s"\n' "$(escape_env "$api_key")"
} > "$tmp"
chmod 600 "$tmp"
mv "$tmp" "$config"
trap - EXIT

echo "Saved benchmark-only DeepSeek configuration: $config"
echo "Permissions: $(stat -c '%a' "$config")"
echo "This file is not used by LITSAN production Core, DSH, or distillation."
