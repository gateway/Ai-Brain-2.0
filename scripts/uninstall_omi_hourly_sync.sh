#!/usr/bin/env bash
set -euo pipefail

LABEL="com.ai-brain.omi-sync.hourly"
PLIST_PATH="$HOME/Library/LaunchAgents/$LABEL.plist"

launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
rm -f "$PLIST_PATH"

echo "Disabled hourly Omi sync launch agent."
