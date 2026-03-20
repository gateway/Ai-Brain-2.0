#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

echo "[api] operator runtime endpoints present"
for pattern in '"/ops/sessions"' 'sessionTextIntakeMatch' 'sessionFileIntakeMatch' '"/ops/bootstrap-state"' '"/ops/sources"'; do
  if ! rg -n "$pattern" local-brain/src/server/http.ts >/dev/null; then
    echo "missing governed endpoint pattern: $pattern"
    exit 1
  fi
done

echo "[api] console uses runtime client boundary"
if ! rg -n 'fetchJson<|postRuntimeJson|BRAIN_RUNTIME_BASE_URL' brain-console/src/lib brain-console/src/app/api >/dev/null; then
  echo "console runtime client boundary usage missing"
  exit 1
fi

echo "[api] ok"
