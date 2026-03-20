#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

# shellcheck disable=SC1091
source "$ROOT_DIR/scripts/load_env.sh"

export CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
export PWCLI="$CODEX_HOME/skills/playwright/scripts/playwright_cli.sh"

"$PWCLI" close-all >/dev/null 2>&1 || true
"$PWCLI" kill-all >/dev/null 2>&1 || true

"$PWCLI" open "${BRAIN_CONSOLE_URL:-http://127.0.0.1:3005}/console/relationships"
"$PWCLI" press PageDown
"$PWCLI" press PageDown
"$PWCLI" mousemove 460 340
"$PWCLI" mousewheel -- -900 0
"$PWCLI" screenshot
"$PWCLI" close-all >/dev/null 2>&1 || true
"$PWCLI" kill-all >/dev/null 2>&1 || true
