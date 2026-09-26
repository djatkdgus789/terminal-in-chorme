"use strict";

const form = document.getElementById("form");
const saveStatus = document.getElementById("save-status");
const hostStatus = document.getElementById("host-status");
document.getElementById("ext-id").textContent = chrome.runtime.id;

function fill(settings) {
  for (const [key, value] of Object.entries(settings)) {
    const el = form.elements[key];
    if (!el) continue;
    if (el.type === "checkbox") el.checked = Boolean(value);
    else el.value = value;
  }
}

function read() {
  const out = {};
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    const el = form.elements[key];
    if (!el) continue;
    if (el.type === "checkbox") out[key] = el.checked;
    else if (el.type === "number") out[key] = Number(el.value) || DEFAULT_SETTINGS[key];
    else out[key] = el.value.trim();
  }
  return out;
}

function flash(el, text) {
  el.textContent = text;
  setTimeout(() => { if (el.textContent === text) el.textContent = ""; }, 2500);
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  await saveSettings(read());
  flash(saveStatus, "Saved");
});

document.getElementById("reset").addEventListener("click", async () => {
  fill(DEFAULT_SETTINGS);
  await saveSettings(DEFAULT_SETTINGS);
  flash(saveStatus, "Defaults restored");
});

document.getElementById("test-host").addEventListener("click", () => {
  hostStatus.textContent = "Connecting…";
  let port;
  try {
    port = chrome.runtime.connectNative(HOST_NAME);
  } catch (err) {
    hostStatus.textContent = "✗ " + explainNativeError(String(err)).title;
    return;
  }
  let done = false;
  const timer = setTimeout(() => {
    if (done) return;
    done = true;
    hostStatus.textContent = "✗ No reply from the host (timeout)";
    port.disconnect();
  }, 4000);
  port.onMessage.addListener((msg) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    hostStatus.textContent = msg.type === "pong" ? "✓ Native host is installed and responding"
      : "✗ Unexpected reply: " + JSON.stringify(msg);
    port.disconnect();
  });
  port.onDisconnect.addListener(() => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    const err = chrome.runtime.lastError;
    const info = explainNativeError(err ? err.message : "");
    hostStatus.textContent = "✗ " + info.title + " — " + info.detail;
  });
  port.postMessage({ type: "ping" });
});

loadSettings().then(fill);
