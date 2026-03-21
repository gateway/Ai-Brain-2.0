#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

# shellcheck disable=SC1091
source "$ROOT_DIR/scripts/load_env.sh"

python3 "$ROOT_DIR/tools/omi-sync/sync_omi.py" "$@"

if [[ "${OMI_SYNC_IMPORT_AFTER_SYNC:-false}" == "true" ]]; then
  if [[ -z "${OMI_SYNC_SOURCE_ID:-}" ]]; then
    echo "OMI_SYNC_SOURCE_ID is required when OMI_SYNC_IMPORT_AFTER_SYNC=true" >&2
    exit 1
  fi

  cd "$ROOT_DIR/local-brain"
  npm run source:import -- --source-id "$OMI_SYNC_SOURCE_ID"
fi
