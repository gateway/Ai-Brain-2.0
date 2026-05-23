#!/bin/zsh

ROOT="/Users/evilone/Documents/Development/AI-Brain/ai-brain"
GLOBAL_NOTEBOOKLM_VENV="/Users/evilone/.venvs/notebooklm"
SHARED_NOTEBOOKLM_HOME="/Users/evilone/.notebooklm"
LEGACY_STORAGE_PATH="${SHARED_NOTEBOOKLM_HOME}/storage_state.json"
PROFILE_STORAGE_PATH="${SHARED_NOTEBOOKLM_HOME}/profiles/default/storage_state.json"

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

# Bridge newer profile-based auth storage to the legacy file/env lookup used by
# the current workspace workflow and some notebooklm-py commands.
if [[ -z "${NOTEBOOKLM_AUTH_JSON:-}" && ! -f "${LEGACY_STORAGE_PATH}" && -f "${PROFILE_STORAGE_PATH}" ]]; then
  export NOTEBOOKLM_AUTH_JSON="$(cat "${PROFILE_STORAGE_PATH}")"
fi
