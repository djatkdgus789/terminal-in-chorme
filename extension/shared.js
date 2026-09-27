// Shared constants and helpers used by every extension page.
"use strict";

const HOST_NAME = "com.terminal_in_chrome.host";

const DEFAULT_SETTINGS = {
  shell: "",            // empty = the user's login shell
  cwd: "",              // empty = home directory
  fontSize: 14,
  fontFamily: "Menlo, Monaco, 'SF Mono', 'JetBrains Mono', 'Fira Code', monospace",
  theme: "dark",        // dark | light | system
  scrollback: 5000,
  cursorStyle: "block", // block | underline | bar
  cursorBlink: true,
  macOptionIsMeta: true,
  copyOnSelect: false,
  actionOpens: "tab",   // tab | panel
  persistSessions: true, // keep shells alive when the page closes; re-attach on reopen
};

function loadSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(DEFAULT_SETTINGS, (items) => {
      resolve({ ...DEFAULT_SETTINGS, ...items });
    });
  });
}

function saveSettings(settings) {
  return new Promise((resolve) => chrome.storage.sync.set(settings, resolve));
}

// Base64 <-> bytes without hitting call-stack limits on large chunks.
function bytesToBase64(bytes) {
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

function base64ToBytes(b64) {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

const _encoder = new TextEncoder();
function stringToBase64(str) {
  return bytesToBase64(_encoder.encode(str));
}

// Turn a chrome.runtime.lastError message from connectNative into a helpful
// explanation for the user.
function explainNativeError(message) {
  const m = (message || "").toLowerCase();
  if (m.includes("not found")) {
    return {
      title: "Native host is not installed",
      detail: "Chrome could not find the \"" + HOST_NAME + "\" native messaging host. " +
        "Run ./install.sh from the project folder on your Mac, then reload this page.",
    };
  }
  if (m.includes("forbidden")) {
    return {
      title: "Native host does not allow this extension",
      detail: "The host manifest's allowed_origins does not include this extension's ID (" +
        chrome.runtime.id + "). Re-run ./install.sh --extension-id " + chrome.runtime.id + " and reload.",
    };
  }
  if (m.includes("failed to start") || m.includes("exited")) {
    return {
      title: "Native host failed to start",
      detail: "The host process exited immediately. Make sure python3 works on your Mac " +
        "(run `xcode-select --install` if needed) and that host/terminal_host.py is executable.",
    };
  }
  return {
    title: "Connection lost",
    detail: (message || "The native host disconnected.") +
      " If this keeps happening, check $TMPDIR/terminal-in-chrome-<uid>/daemon.log on your Mac.",
  };
}
