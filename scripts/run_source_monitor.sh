#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

# shellcheck disable=SC1091
source "$ROOT_DIR/scripts/load_env.sh"

INTERVAL_SECONDS="${BRAIN_SOURCE_MONITOR_INTERVAL_SECONDS:-60}"

cd "$ROOT_DIR/local-brain"
npm run build >/dev/null

while true; do
  node dist/cli/process-source-monitors.js
  sleep "$INTERVAL_SECONDS"
done
