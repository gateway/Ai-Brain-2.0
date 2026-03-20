#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

status=0

pass() {
  printf '[doctor] PASS: %s\n' "$1"
}

warn() {
  printf '[doctor] WARN: %s\n' "$1"
}

fail() {
  printf '[doctor] FAIL: %s\n' "$1"
  status=1
}

check_cmd() {
  local cmd="$1"
  local label="$2"
  if command -v "$cmd" >/dev/null 2>&1; then
    pass "$label"
  else
    fail "$label"
  fi
}

if [[ "$(uname -s)" != "Darwin" ]]; then
  warn "This doctor script is optimized for macOS. Continuing with best-effort checks."
fi

check_cmd brew "Homebrew is installed"
check_cmd node "Node.js is installed"
check_cmd npm "npm is installed"
check_cmd python3 "Python 3 is installed"

if [[ -f "$ROOT_DIR/.env" ]]; then
  pass ".env exists"
else
  warn ".env is missing. Copy .env.example to .env before running the app."
fi

if [[ -d "$ROOT_DIR/.venv-brain" ]]; then
  pass "Repo-local Python helper venv exists"
else
  warn "Repo-local Python helper venv is missing. Run scripts/bootstrap_mac.sh."
fi

if [[ -x /opt/homebrew/opt/postgresql@18/bin/pg_isready ]]; then
  if /opt/homebrew/opt/postgresql@18/bin/pg_isready -d "postgresql:///postgres" >/dev/null 2>&1; then
    pass "PostgreSQL 18 is accepting connections"
  else
    fail "PostgreSQL 18 is installed but not accepting connections"
  fi
else
  fail "PostgreSQL 18 binaries not found in /opt/homebrew/opt/postgresql@18"
fi

if [[ -x /opt/homebrew/opt/postgresql@18/bin/psql ]]; then
  if /opt/homebrew/opt/postgresql@18/bin/psql "postgresql:///postgres" -Atqc "select 1 from pg_database where datname='ai_brain_local'" | grep -q 1; then
    pass "ai_brain_local database exists"
  else
    fail "ai_brain_local database does not exist"
  fi

  ext_output="$(/opt/homebrew/opt/postgresql@18/bin/psql "postgresql:///ai_brain_local" -Atqc "select name from pg_available_extensions where name in ('pgcrypto','vector','btree_gin','vectorscale','pg_search','timescaledb','ai') order by name" 2>/dev/null || true)"
  for ext in pgcrypto vector btree_gin; do
    if printf '%s\n' "$ext_output" | grep -qx "$ext"; then
      pass "PostgreSQL extension available: $ext"
    else
      fail "PostgreSQL extension missing: $ext"
    fi
  done
  for ext in vectorscale pg_search timescaledb ai; do
    if printf '%s\n' "$ext_output" | grep -qx "$ext"; then
      pass "Optional/advanced extension available: $ext"
    else
      warn "Optional/advanced extension not currently available: $ext"
    fi
  done
fi

if [[ -d "$ROOT_DIR/node_modules" && -d "$ROOT_DIR/local-brain/node_modules" && -d "$ROOT_DIR/brain-console/node_modules" ]]; then
  pass "Workspace node_modules are installed"
else
  warn "Workspace dependencies are not fully installed. Run npm install at repo root."
fi

if curl -sf http://127.0.0.1:8787/health >/dev/null 2>&1; then
  pass "local-brain runtime is responding on 127.0.0.1:8787"
else
  warn "local-brain runtime is not responding on 127.0.0.1:8787"
fi

if curl -sf http://127.0.0.1:3003 >/dev/null 2>&1; then
  pass "brain-console is responding on 127.0.0.1:3003"
elif curl -sf http://127.0.0.1:3005 >/dev/null 2>&1; then
  pass "brain-console is responding on 127.0.0.1:3005"
else
  warn "brain-console is not responding on 3003 or 3005"
fi

exit "$status"
