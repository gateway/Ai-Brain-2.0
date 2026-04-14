#!/bin/zsh
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: scripts/benchmark-lane-canonical-local.sh <command> [args...]"
  echo "Example: scripts/benchmark-lane-canonical-local.sh npm run benchmark:production-battle"
  exit 1
fi

export BRAIN_BENCHMARK_LANE="canonical-local"
export BRAIN_DATABASE_URL="${BRAIN_BENCHMARK_DATABASE_URL:-postgresql:///ai_brain_benchmark}"
export BRAIN_BENCHMARK_ISOLATED_DB="${BRAIN_BENCHMARK_ISOLATED_DB:-1}"
export BRAIN_EMBEDDING_PROVIDER="external"
export BRAIN_EMBEDDING_MODEL="${BRAIN_EXTERNAL_AI_EMBEDDING_MODEL:-Qwen/Qwen3-Embedding-4B}"
export BRAIN_EXTERNAL_AI_EMBEDDING_MODEL="${BRAIN_EXTERNAL_AI_EMBEDDING_MODEL:-Qwen/Qwen3-Embedding-4B}"

exec "$@"
