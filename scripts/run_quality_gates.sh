#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

# shellcheck disable=SC1091
source "$ROOT_DIR/scripts/load_env.sh"

echo "[quality] typecheck"
npm run typecheck

echo "[quality] test"
npm test

echo "[quality] lint"
npm run lint

echo "[quality] guardrails"
bash scripts/check_guardrails.sh

echo "[quality] api-governance"
bash scripts/check_api_governance.sh

echo "[quality] build"
npm run build

echo "[quality] complete"
