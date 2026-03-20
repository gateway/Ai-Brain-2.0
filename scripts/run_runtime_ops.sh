#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

# shellcheck disable=SC1091
source "$ROOT_DIR/scripts/load_env.sh"

cd "$ROOT_DIR/local-brain"
npm run ops:work -- --poll-seconds "${BRAIN_RUNTIME_OPS_POLL_SECONDS:-5}"
