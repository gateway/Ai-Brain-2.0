#!/bin/zsh
set -euo pipefail

script_dir="${0:A:h}"
repo_root="${script_dir:h:h}"

if [[ $# -lt 1 ]]; then
  echo "Usage: scripts/benchmark-lane-fast-openrouter.sh <command> [args...]"
  echo "Example: scripts/benchmark-lane-fast-openrouter.sh npm run benchmark:production-battle"
  exit 1
fi

if [[ -z "${OPENROUTER_API_KEY:-}" && -f "${repo_root}/.env" ]]; then
  set -a
  source "${repo_root}/.env"
  set +a
fi

if [[ -z "${OPENROUTER_API_KEY:-}" ]]; then
  echo "OPENROUTER_API_KEY is required for the fast-openrouter lane."
  exit 1
fi

export BRAIN_BENCHMARK_LANE="fast-openrouter"
export BRAIN_DATABASE_URL="${BRAIN_BENCHMARK_DATABASE_URL:-postgresql:///ai_brain_benchmark}"
export BRAIN_BENCHMARK_ISOLATED_DB="${BRAIN_BENCHMARK_ISOLATED_DB:-1}"
export BRAIN_EMBEDDING_PROVIDER="openrouter"
export BRAIN_OPENROUTER_EMBEDDING_MODEL="${BRAIN_OPENROUTER_EMBEDDING_MODEL:-text-embedding-3-small}"
export BRAIN_EMBEDDING_MODEL="${BRAIN_OPENROUTER_EMBEDDING_MODEL}"

exec "$@"
