#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

# shellcheck disable=SC1091
source "$ROOT_DIR/scripts/load_env.sh"

UI_INTERNAL_PORT="${UI_INTERNAL_PORT:-3105}"
RUNTIME_PORT="${RUNTIME_PORT:-8787}"
PORT="${PORT:-3005}"

trap 'kill 0' INT TERM EXIT

(
  cd local-brain
  BRAIN_HTTP_PORT="$RUNTIME_PORT" \
  BRAIN_MODEL_RUNTIME_BASE_URL="${BRAIN_MODEL_RUNTIME_BASE_URL:-http://100.99.84.124:8000}" \
  npm run serve
) &

(
  cd brain-console
  PORT="$UI_INTERNAL_PORT" \
  BRAIN_RUNTIME_BASE_URL="http://127.0.0.1:${RUNTIME_PORT}" \
  BRAIN_MODEL_RUNTIME_BASE_URL="${BRAIN_MODEL_RUNTIME_BASE_URL:-http://100.99.84.124:8000}" \
  npm run start -- --hostname 127.0.0.1 --port "$UI_INTERNAL_PORT"
) &

UI_ORIGIN="http://127.0.0.1:${UI_INTERNAL_PORT}" \
RUNTIME_ORIGIN="http://127.0.0.1:${RUNTIME_PORT}" \
PORT="$PORT" \
node "$ROOT_DIR/scripts/one_app_proxy.mjs"
