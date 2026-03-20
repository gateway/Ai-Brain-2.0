#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

say() {
  printf '\n[bootstrap] %s\n' "$1"
}

fail() {
  printf '\n[bootstrap] ERROR: %s\n' "$1" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1"
}

if [[ "$(uname -s)" != "Darwin" ]]; then
  fail "This bootstrap script currently targets macOS only."
fi

require_cmd brew

say "Installing or verifying Homebrew packages"
brew list node >/dev/null 2>&1 || brew install node
brew list postgresql@18 >/dev/null 2>&1 || brew install postgresql@18
brew list pgvector >/dev/null 2>&1 || brew install pgvector

say "Starting PostgreSQL 18"
brew services start postgresql@18 >/dev/null

PG_READY_CMD="/opt/homebrew/opt/postgresql@18/bin/pg_isready"
CREATE_DB_CMD="/opt/homebrew/opt/postgresql@18/bin/createdb"
PSQL_CMD="/opt/homebrew/opt/postgresql@18/bin/psql"

[[ -x "$PG_READY_CMD" ]] || fail "pg_isready not found at $PG_READY_CMD"
[[ -x "$CREATE_DB_CMD" ]] || fail "createdb not found at $CREATE_DB_CMD"
[[ -x "$PSQL_CMD" ]] || fail "psql not found at $PSQL_CMD"

for _ in {1..20}; do
  if "$PG_READY_CMD" -d "postgresql:///postgres" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

"$PG_READY_CMD" -d "postgresql:///postgres" >/dev/null 2>&1 || fail "PostgreSQL 18 did not become ready."

say "Creating ai_brain_local if needed"
if ! "$PSQL_CMD" "postgresql:///postgres" -Atqc "select 1 from pg_database where datname = 'ai_brain_local'" | grep -q 1; then
  "$CREATE_DB_CMD" ai_brain_local
fi

say "Checking PostgreSQL extension availability"
AVAILABLE_EXTENSIONS="$("$PSQL_CMD" "postgresql:///ai_brain_local" -Atqc "select name from pg_available_extensions where name in ('pgcrypto','vector','btree_gin','vectorscale','pg_search','timescaledb','ai') order by name")"
printf '%s\n' "$AVAILABLE_EXTENSIONS"

missing_required=()
for ext in pgcrypto vector btree_gin vectorscale pg_search; do
  if ! printf '%s\n' "$AVAILABLE_EXTENSIONS" | grep -qx "$ext"; then
    missing_required+=("$ext")
  fi
done

say "Installing JavaScript dependencies"
npm install
npm install --workspace local-brain
npm install --workspace brain-console

if [[ ! -f "$ROOT_DIR/.env" ]]; then
  say "Creating .env from .env.example"
  cp "$ROOT_DIR/.env.example" "$ROOT_DIR/.env"
fi

say "Creating repo-local Python helper environment"
if [[ ! -d "$ROOT_DIR/.venv-brain" ]]; then
  python3 -m venv "$ROOT_DIR/.venv-brain"
fi
source "$ROOT_DIR/.venv-brain/bin/activate"
python --version
python -m pip install --upgrade pip setuptools wheel >/dev/null
deactivate

if [[ ${#missing_required[@]} -gt 0 ]]; then
  printf '\n[bootstrap] Manual extension work is still required before migrations can succeed.\n' >&2
  printf '[bootstrap] Missing PostgreSQL extensions: %s\n' "${missing_required[*]}" >&2
  cat >&2 <<'EOF'

What this means:
- The base app dependencies are installed.
- PostgreSQL 18 is running.
- The local database exists.
- The repo-local Python helper venv exists.
- But local-brain migrations are not being run yet, because the database does not currently expose every required extension.

Current extension notes for macOS/Homebrew:
- pgvector is straightforward through Homebrew.
- timescaledb exists through the Timescale tap, but may currently target PostgreSQL 17 instead of 18.
- vectorscale and pg_search / ParadeDB are not handled by this script yet.

Next step:
- install the missing PostgreSQL extension binaries for your PostgreSQL 18 instance
- then run:
  cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
  npm run migrate

After migrations:
- cd /Users/evilone/Documents/Development/AI-Brain/ai-brain
  npm run dev
EOF
  exit 2
fi

say "Running local-brain migrations"
(
  cd "$ROOT_DIR/local-brain"
  npm run migrate
)

cat <<'EOF'

[bootstrap] AI Brain base setup is ready.

Next:
1. Review /Users/evilone/Documents/Development/AI-Brain/ai-brain/.env
2. Configure your local runtime or OpenRouter keys
3. Start the app:
   cd /Users/evilone/Documents/Development/AI-Brain/ai-brain
   npm run dev
4. Open:
   http://127.0.0.1:3005
5. Go through:
   Start Here -> Guided Setup -> Settings -> Sessions

EOF
