#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

# shellcheck disable=SC1091
source "$ROOT_DIR/scripts/load_env.sh"

trap 'kill 0' INT TERM EXIT

(
  cd local-brain
  BRAIN_MODEL_RUNTIME_BASE_URL="${BRAIN_MODEL_RUNTIME_BASE_URL:-http://100.99.84.124:8000}" npm run serve
) &

if [[ "${BRAIN_RUNTIME_OPS_ENABLED:-false}" == "true" ]]; then
  (
    cd "$ROOT_DIR"
    bash scripts/run_runtime_ops.sh
  ) &
elif [[ "${BRAIN_SOURCE_MONITOR_ENABLED:-false}" == "true" ]]; then
  (
    cd "$ROOT_DIR"
    bash scripts/run_source_monitor.sh
  ) &
fi

(
  cd brain-console
  BRAIN_RUNTIME_BASE_URL="${BRAIN_RUNTIME_BASE_URL:-http://127.0.0.1:8787}" \
  BRAIN_MODEL_RUNTIME_BASE_URL="${BRAIN_MODEL_RUNTIME_BASE_URL:-http://100.99.84.124:8000}" \
  npm run dev -- --hostname 127.0.0.1 --port "${PORT:-3005}"
) &

wait
