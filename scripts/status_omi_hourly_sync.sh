#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.ai-brain.omi-sync.hourly"
PLIST_PATH="$HOME/Library/LaunchAgents/$LABEL.plist"
RUNTIME_DIR="$HOME/Library/Application Support/AI-Brain/omi-sync"
LAUNCH_SCRIPT="$RUNTIME_DIR/run_omi_sync_launchd.sh"
ARCHIVE_ROOT="$HOME/Library/Application Support/AI-Brain/omi-archive"
OUT_LOG="$HOME/Library/Logs/AI-Brain/omi-sync/hourly-sync.out.log"
ERR_LOG="$HOME/Library/Logs/AI-Brain/omi-sync/hourly-sync.err.log"

echo "Label: $LABEL"
echo "Plist: $PLIST_PATH"
echo "Launch script: $LAUNCH_SCRIPT"
echo "Archive root: $ARCHIVE_ROOT"

if [[ -f "$PLIST_PATH" ]]; then
  echo "Plist present: yes"
else
  echo "Plist present: no"
fi

if launchctl print "gui/$(id -u)/$LABEL" >/tmp/omi-sync-launchctl-status.txt 2>/tmp/omi-sync-launchctl-status.err; then
  echo "Launch agent loaded: yes"
  sed -n '1,120p' /tmp/omi-sync-launchctl-status.txt
else
  echo "Launch agent loaded: no"
  sed -n '1,40p' /tmp/omi-sync-launchctl-status.err || true
fi

echo
echo "Disable it with:"
echo "  npm run omi:schedule:disable"

echo
echo "Recent stdout log:"
if [[ -f "$OUT_LOG" ]]; then
  tail -n 20 "$OUT_LOG"
else
  echo "  no stdout log yet"
fi

echo
echo "Recent stderr log:"
if [[ -f "$ERR_LOG" ]]; then
  tail -n 20 "$ERR_LOG"
else
  echo "  no stderr log yet"
fi
