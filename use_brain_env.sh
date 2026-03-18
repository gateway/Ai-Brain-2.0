#!/usr/bin/env bash
set -euo pipefail

if [ -n "${BASH_SOURCE[0]:-}" ]; then
  SCRIPT_PATH="${BASH_SOURCE[0]}"
elif [ -n "${ZSH_VERSION:-}" ]; then
  SCRIPT_PATH="${(%):-%N}"
else
  SCRIPT_PATH="$0"
fi

SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"
VENV_DIR="$SCRIPT_DIR/.venv-brain"

if [[ ! -d "$VENV_DIR" ]]; then
  echo "Brain helper venv not found at $VENV_DIR" >&2
  return 1 2>/dev/null || exit 1
fi

source "$VENV_DIR/bin/activate"
export BRAIN_ROOT="$SCRIPT_DIR"
