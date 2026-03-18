#!/usr/bin/env bash
set -euo pipefail

if [ -n "${BASH_SOURCE[0]:-}" ]; then
  SCRIPT_PATH="${BASH_SOURCE[0]}"
elif [ -n "${ZSH_VERSION:-}" ]; then
  SCRIPT_PATH="${(%):-%N}"
else
  SCRIPT_PATH="$0"
fi

ROOT_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"

export NOTEBOOKLM_HOME="${NOTEBOOKLM_HOME:-$HOME/.notebooklm}"

# shellcheck disable=SC1091
source "$ROOT_DIR/.venv-notebooklm/bin/activate"
