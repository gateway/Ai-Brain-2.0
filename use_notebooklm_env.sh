#!/bin/zsh

ROOT="/Users/evilone/Documents/Development/AI-Brain/ai-brain"
GLOBAL_NOTEBOOKLM_VENV="/Users/evilone/.venvs/notebooklm"
SHARED_NOTEBOOKLM_HOME="/Users/evilone/.notebooklm"

if [[ -d "${ROOT}/.venv-notebooklm" ]]; then
  source "${ROOT}/.venv-notebooklm/bin/activate"
elif [[ -d "${GLOBAL_NOTEBOOKLM_VENV}" ]]; then
  source "${GLOBAL_NOTEBOOKLM_VENV}/bin/activate"
else
  echo "NotebookLM virtual environment not found." >&2
  return 1 2>/dev/null || exit 1
fi

export NOTEBOOKLM_HOME="${NOTEBOOKLM_HOME:-${SHARED_NOTEBOOKLM_HOME}}"
export PATH="${ROOT}:${HOME}/.local/bin:${PATH}"
