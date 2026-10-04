// Shared constants and helpers used by every extension page.
"use strict";

const HOST_NAME = "com.terminal_in_chrome.host";

const DEFAULT_SETTINGS = {
  shell: "",            // empty = the user's login shell
  cwd: "",              // empty = home directory
  fontSize: 14,
  fontFamily: "Menlo, Monaco, 'SF Mono', 'JetBrains Mono', 'Fira Code', monospace",
  theme: "dracula",     // dracula | dark | light | system
  scrollback: 5000,
  cursorStyle: "block", // block | underline | bar
  cursorBlink: true,
  macOptionIsMeta: true,
  copyOnSelect: false,
  actionOpens: "tab",   // tab | panel
  persistSessions: true, // keep shells alive when the page closes; re-attach on reopen
  shellIntegration: true, // OSC 133 prompt marks + OSC 7 cwd (zsh, bash)
  pasteGuard: true,     // confirm multi-line pastes
  imageSupport: true,   // inline images: iTerm2 protocol (imgcat) and sixel
  inheritCwd: true,     // new splits/tabs start in the current pane's directory
  openCommand: "",      // for Cmd-click on a file path, e.g. "code -g {path}:{line}"; empty = `open`
  profiles: [],         // [{id, name, shell, cwd, theme, fontSize, fontFamily, cursorStyle}]
  defaultProfile: "",   // profile id used by the + button and Ctrl+Shift+T
};

// Settings a profile may override (empty string / null = inherit the global value).
const PROFILE_KEYS = ["shell", "cwd", "theme", "fontSize", "fontFamily", "cursorStyle"];

function getProfile(settings, id) {
  return (settings.profiles || []).find((p) => p.id === id) || null;
}

function effectiveSettings(settings, profile) {
  const out = { ...settings };
  if (profile) {
    for (const key of PROFILE_KEYS) {
      const v = profile[key];
      if (v !== undefined && v !== null && v !== "") out[key] = v;
    }
  }
  return out;
}

function newProfileId() {
  return Math.random().toString(36).slice(2, 10);
}

// "file://host/%2Fpath" (OSC 7) -> "/path"
function fileUrlToPath(url) {
  const m = /^file:\/\/[^/]*(\/.*)$/.exec(url || "");
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch (_) { return m[1]; }
}

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
