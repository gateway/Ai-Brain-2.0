#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

echo "[guardrails] operator UI must not import database drivers"
if rg -n 'from "pg"|require\("pg"\)' brain-console/src >/dev/null; then
  echo "brain-console imports pg directly"
  exit 1
fi

echo "[guardrails] operator API must use runtime boundary helpers"
if ! rg -n 'postRuntimeJson|redirectToSession|validateUploadFile' brain-console/src/app/api/operator >/dev/null; then
  echo "operator API routes are missing runtime boundary helper usage"
  exit 1
fi

echo "[guardrails] PDF/image intake must stay adapter-gated"
if ! rg -n "request.sourceType === \"pdf\" \\|\\| request.sourceType === \"image\"" local-brain/src/ops/session-service.ts >/dev/null; then
  echo "adapter gate for pdf/image intake is missing"
  exit 1
fi

echo "[guardrails] retrieval service boundaries must hold"
npm run guard:service-boundaries --workspace local-brain >/dev/null

echo "[guardrails] ok"
