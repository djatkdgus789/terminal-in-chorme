#!/bin/bash
# Removes the native messaging host registration written by install.sh.
set -euo pipefail
HOST_NAME="com.terminal_in_chrome.host"
APP_SUPPORT="$HOME/Library/Application Support"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

removed=0
while IFS= read -r -d '' f; do
  rm -f "$f"
  echo "Removed $f"
  removed=$((removed + 1))
done < <(find "$APP_SUPPORT" -maxdepth 4 -path "*/NativeMessagingHosts/$HOST_NAME.json" -print0 2>/dev/null)

rm -f "$SCRIPT_DIR/host/run_host.sh"
echo "Removed $removed host manifest(s). Remove the extension from chrome://extensions to finish."
