#!/bin/bash
# Registers the native messaging host with Chrome (and Chromium-based
# browsers) on macOS so the "Terminal in Chrome" extension can spawn a shell.
#
#   ./install.sh                       # register for every installed browser
#   ./install.sh --browser chrome      # only Google Chrome
#   ./install.sh --extension-id <id>   # allow an additional extension ID
#   sudo ./install.sh --system         # register for all users (/Library/...)
#
# Re-run it any time; it overwrites the previous registration.
set -euo pipefail

HOST_NAME="com.terminal_in_chrome.host"
DEFAULT_EXTENSION_ID="njljokdmmbkdlmllndefhngkjcdgllma"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST_SCRIPT="$SCRIPT_DIR/host/terminal_host.py"
LAUNCHER="$SCRIPT_DIR/host/run_host.sh"

EXTENSION_IDS=("$DEFAULT_EXTENSION_ID")
BROWSER_FILTER=""
SYSTEM_WIDE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --extension-id) EXTENSION_IDS+=("$2"); shift 2 ;;
    --browser) BROWSER_FILTER="$2"; shift 2 ;;
    --system) SYSTEM_WIDE=1; shift ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
done

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This installer targets macOS. On Linux, native host manifests live in" >&2
  echo "~/.config/google-chrome/NativeMessagingHosts/ - adapt the paths below." >&2
fi

# --- find a working python3 -------------------------------------------------
PYTHON=""
for candidate in "$(command -v python3 || true)" /opt/homebrew/bin/python3 /usr/local/bin/python3 /usr/bin/python3; do
  [[ -n "$candidate" && -x "$candidate" ]] || continue
  if "$candidate" -c 'import pty, fcntl, termios' >/dev/null 2>&1; then
    PYTHON="$candidate"
    break
  fi
done
if [[ -z "$PYTHON" ]]; then
  cat >&2 <<MSG
No working python3 was found.
On macOS install the Xcode command line tools (xcode-select --install)
or Homebrew Python (brew install python), then run this script again.
MSG
  exit 1
fi
echo "Using python: $PYTHON ($("$PYTHON" -c 'import sys; print(sys.version.split()[0])'))"

chmod +x "$HOST_SCRIPT"

# Chrome starts native hosts with a minimal PATH, so pin the interpreter.
cat > "$LAUNCHER" <<SH
#!/bin/sh
exec "$PYTHON" "$HOST_SCRIPT"
SH
chmod +x "$LAUNCHER"

# --- write the manifest into every browser directory ------------------------
ORIGINS=""
for id in "${EXTENSION_IDS[@]}"; do
  [[ -n "$ORIGINS" ]] && ORIGINS="$ORIGINS, "
  ORIGINS="$ORIGINS\"chrome-extension://$id/\""
done

MANIFEST_JSON=$(cat <<JSON
{
  "name": "$HOST_NAME",
  "description": "Terminal in Chrome native messaging host",
  "path": "$LAUNCHER",
  "type": "stdio",
  "allowed_origins": [$ORIGINS]
}
JSON
)

# Per-user location (default) or the system-wide one used by Google's own
# native messaging sample (needs sudo, applies to every account on the Mac).
if [[ $SYSTEM_WIDE -eq 1 ]]; then
  APP_SUPPORT="/Library"
else
  APP_SUPPORT="$HOME/Library/Application Support"
fi
declare -a BROWSERS=(
  "chrome|Google/Chrome"
  "chrome-beta|Google/Chrome Beta"
  "chrome-canary|Google/Chrome Canary"
  "chromium|Chromium"
  "brave|BraveSoftware/Brave-Browser"
  "edge|Microsoft Edge"
  "arc|Arc/User Data"
  "vivaldi|Vivaldi"
)
if [[ $SYSTEM_WIDE -eq 1 ]]; then
  # System-wide directories are flat: /Library/Google/Chrome/NativeMessagingHosts
  BROWSERS=("chrome|Google/Chrome" "chromium|Chromium" "brave|BraveSoftware/Brave-Browser"
            "edge|Microsoft Edge" "vivaldi|Vivaldi" "chrome-beta|Google/Chrome Beta" "chrome-canary|Google/Chrome Canary")
fi

installed=0
for entry in "${BROWSERS[@]}"; do
  key="${entry%%|*}"
  rel="${entry#*|}"
  if [[ -n "$BROWSER_FILTER" && "$BROWSER_FILTER" != "$key" ]]; then
    continue
  fi
  browser_dir="$APP_SUPPORT/$rel"
  # Only register for browsers that exist unless one was explicitly requested.
  if [[ ! -d "$browser_dir" && -z "$BROWSER_FILTER" ]]; then
    continue
  fi
  target_dir="$browser_dir/NativeMessagingHosts"
  mkdir -p "$target_dir"
  printf '%s\n' "$MANIFEST_JSON" > "$target_dir/$HOST_NAME.json"
  echo "Registered for $key: $target_dir/$HOST_NAME.json"
  installed=$((installed + 1))
done

if [[ $installed -eq 0 ]]; then
  echo "No supported browser profile directory found under $APP_SUPPORT." >&2
  echo "Start Chrome once, or pass --browser chrome to force registration." >&2
  exit 1
fi

cat <<MSG

Done. Next steps:
  1. Open chrome://extensions, enable "Developer mode".
  2. Click "Load unpacked" and choose: $SCRIPT_DIR/extension
  3. The extension ID should be $DEFAULT_EXTENSION_ID.
     If it differs, re-run: ./install.sh --extension-id <your id>
  4. Click the toolbar icon (or press Alt+Shift+T) to open a terminal.

Shells run inside a per-user daemon (host/terminal_daemon.py) that starts on
demand and exits when idle; its log is in \$TMPDIR/terminal-in-chrome-<uid>/daemon.log.
MSG
