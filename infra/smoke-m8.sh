#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ ! -f .env ]]; then
  echo "Copy .env.example to .env and replace placeholder values first." >&2
  exit 1
fi
set -a
# shellcheck disable=SC1091
source .env
set +a
docker compose up -d --build --wait
node infra/smoke/m8-smoke.mjs
