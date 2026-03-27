#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLIST_TEMPLATE="$ROOT_DIR/scripts/launchd/com.ai-brain.omi-sync.hourly.plist.template"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
PLIST_PATH="$LAUNCH_AGENTS_DIR/com.ai-brain.omi-sync.hourly.plist"
LABEL="com.ai-brain.omi-sync.hourly"
RUNTIME_DIR="$HOME/Library/Application Support/AI-Brain/omi-sync"
LAUNCH_SCRIPT="$RUNTIME_DIR/run_omi_sync_launchd.sh"
RUNTIME_ENV="$RUNTIME_DIR/omi-sync.env"
SYNC_SCRIPT="$RUNTIME_DIR/sync_omi.py"
ARCHIVE_ROOT="$HOME/Library/Application Support/AI-Brain/omi-archive"
STATE_PATH="$ARCHIVE_ROOT/state.json"
NORMALIZED_ROOT="$ARCHIVE_ROOT/normalized"
LOG_DIR="$HOME/Library/Logs/AI-Brain/omi-sync"
OUT_LOG="$LOG_DIR/hourly-sync.out.log"
ERR_LOG="$LOG_DIR/hourly-sync.err.log"

mkdir -p "$LAUNCH_AGENTS_DIR"
mkdir -p "$RUNTIME_DIR"
mkdir -p "$LOG_DIR"
mkdir -p "$ARCHIVE_ROOT"
: >"$OUT_LOG"
: >"$ERR_LOG"

if [[ -f "$ROOT_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.env"
  set +a
fi

cp "$ROOT_DIR/tools/omi-sync/sync_omi.py" "$SYNC_SCRIPT"
chmod 755 "$SYNC_SCRIPT"

python3 - <<'PY' "$ROOT_DIR/data/inbox/omi" "$ARCHIVE_ROOT"
from pathlib import Path
import shutil
import sys

source_root = Path(sys.argv[1])
target_root = Path(sys.argv[2])

if source_root.exists():
    shutil.copytree(source_root, target_root, dirs_exist_ok=True)
PY

cat >"$RUNTIME_ENV" <<EOF
OMI_API_KEY=${OMI_API_KEY:-}
OMI_API_BASE_URL=${OMI_API_BASE_URL:-}
OMI_SYNC_IMPORT_AFTER_SYNC=${OMI_SYNC_IMPORT_AFTER_SYNC:-true}
OMI_SYNC_SOURCE_ID=${OMI_SYNC_SOURCE_ID:-}
OMI_SYNC_LOCAL_API_BASE=${OMI_SYNC_LOCAL_API_BASE:-http://127.0.0.1:8787}
EOF

cat >"$LAUNCH_SCRIPT" <<EOF
#!/usr/bin/env bash
set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:\${PATH:-}"
ARCHIVE_ROOT="$ARCHIVE_ROOT"
STATE_PATH="$STATE_PATH"
RUNTIME_ENV="$RUNTIME_ENV"
SYNC_SCRIPT="$SYNC_SCRIPT"

# shellcheck disable=SC1091
set -a
source "\$RUNTIME_ENV"
set +a

python3 "\$SYNC_SCRIPT" --output-root "\$ARCHIVE_ROOT" --state-path "\$STATE_PATH" "\$@"

if [[ "\${OMI_SYNC_IMPORT_AFTER_SYNC:-false}" == "true" ]]; then
  if [[ -z "\${OMI_SYNC_SOURCE_ID:-}" ]]; then
    echo "OMI_SYNC_SOURCE_ID is required when OMI_SYNC_IMPORT_AFTER_SYNC=true" >&2
    exit 1
  fi

  curl -fsS -X PATCH "\${OMI_SYNC_LOCAL_API_BASE}/ops/sources/\${OMI_SYNC_SOURCE_ID}" \\
    -H 'Content-Type: application/json' \\
    -d "{\"root_path\":\"$NORMALIZED_ROOT\"}" >/dev/null

  curl -fsS -X POST "\${OMI_SYNC_LOCAL_API_BASE}/ops/sources/\${OMI_SYNC_SOURCE_ID}/import" \\
    -H 'Content-Type: application/json' \\
    -d '{"trigger_type":"scheduled"}' >/dev/null
fi
EOF

chmod 755 "$LAUNCH_SCRIPT"

if [[ -n "${OMI_SYNC_SOURCE_ID:-}" ]]; then
  curl -fsS -X PATCH "http://127.0.0.1:8787/ops/sources/${OMI_SYNC_SOURCE_ID}" \
    -H 'Content-Type: application/json' \
    -d "{\"root_path\":\"$NORMALIZED_ROOT\"}" >/dev/null || true
fi

python3 - <<'PY' "$PLIST_TEMPLATE" "$PLIST_PATH" "$ROOT_DIR" "$LAUNCH_SCRIPT" "$RUNTIME_DIR" "$OUT_LOG" "$ERR_LOG"
from pathlib import Path
import sys

template_path = Path(sys.argv[1])
output_path = Path(sys.argv[2])
repo_root = sys.argv[3]
launch_script = sys.argv[4]
work_dir = sys.argv[5]
out_log = sys.argv[6]
err_log = sys.argv[7]

content = template_path.read_text(encoding="utf-8")
content = content.replace("__REPO_ROOT__", repo_root)
content = content.replace("__LAUNCH_SCRIPT__", launch_script)
content = content.replace("__WORK_DIR__", work_dir)
content = content.replace("__OUT_LOG__", out_log)
content = content.replace("__ERR_LOG__", err_log)
output_path.write_text(content, encoding="utf-8")
PY

launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH"
launchctl enable "gui/$(id -u)/$LABEL"
launchctl kickstart -k "gui/$(id -u)/$LABEL"

cat <<EOF
Installed hourly Omi sync launch agent.
Label: $LABEL
Plist: $PLIST_PATH
Launch script: $LAUNCH_SCRIPT
Archive root: $ARCHIVE_ROOT
Stdout log: $OUT_LOG
Stderr log: $ERR_LOG

Disable it any time with:
  npm run omi:schedule:disable

Check status with:
  npm run omi:schedule:status
EOF
