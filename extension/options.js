"use strict";

const form = document.getElementById("form");
const saveStatus = document.getElementById("save-status");
const hostStatus = document.getElementById("host-status");
document.getElementById("ext-id").textContent = chrome.runtime.id;

function fill(settings) {
  for (const [key, value] of Object.entries(settings)) {
    const el = form.elements[key];
    if (!el || el instanceof RadioNodeList) continue;
    if (el.type === "checkbox") el.checked = Boolean(value);
    else el.value = value;
  }
  renderProfiles(settings.profiles || [], settings.defaultProfile || "");
}

// -- profiles editor ---------------------------------------------------------------
const profilesEl = document.getElementById("profiles");

function renderProfiles(profiles, defaultId) {
  profilesEl.textContent = "";
  for (const p of profiles) profilesEl.appendChild(profileRow(p, p.id === defaultId));
}

function profileRow(p, isDefault) {
  const el = document.createElement("div");
  el.className = "profile";
  el.dataset.id = p.id;
  el.innerHTML = `
    <div class="head">
      <input type="text" class="p-name" placeholder="Profile name" spellcheck="false">
      <label><input type="radio" name="defaultProfileRadio"> Default</label>
      <button type="button" class="remove">Remove</button>
    </div>
    <div class="grid">
      <label>Shell <input type="text" class="p-shell" placeholder="inherit" spellcheck="false"></label>
      <label>Start directory <input type="text" class="p-cwd" placeholder="inherit" spellcheck="false"></label>
      <label>Theme <select class="p-theme">
        <option value="">inherit</option><option value="dracula">Dracula</option><option value="dark">Dark</option>
        <option value="light">Light</option><option value="system">Follow system</option></select></label>
      <label>Font size <input type="number" class="p-fontSize" min="8" max="40" placeholder="inherit"></label>
      <label>Font family <input type="text" class="p-fontFamily" placeholder="inherit" spellcheck="false"></label>
      <label>Cursor <select class="p-cursorStyle">
        <option value="">inherit</option><option value="block">Block</option>
        <option value="underline">Underline</option><option value="bar">Bar</option></select></label>
    </div>`;
  el.querySelector(".p-name").value = p.name || "";
  el.querySelector(".p-shell").value = p.shell || "";
  el.querySelector(".p-cwd").value = p.cwd || "";
  el.querySelector(".p-theme").value = p.theme || "";
  el.querySelector(".p-fontSize").value = p.fontSize || "";
  el.querySelector(".p-fontFamily").value = p.fontFamily || "";
  el.querySelector(".p-cursorStyle").value = p.cursorStyle || "";
  el.querySelector("input[type=radio]").checked = isDefault;
  el.querySelector(".remove").addEventListener("click", () => el.remove());
  return el;
}

function readProfiles() {
  const profiles = [];
  let defaultProfile = "";
  for (const el of profilesEl.querySelectorAll(".profile")) {
    const size = parseInt(el.querySelector(".p-fontSize").value, 10);
    const p = {
      id: el.dataset.id,
      name: el.querySelector(".p-name").value.trim() || "Profile",
      shell: el.querySelector(".p-shell").value.trim(),
      cwd: el.querySelector(".p-cwd").value.trim(),
      theme: el.querySelector(".p-theme").value,
      fontSize: Number.isFinite(size) ? Math.min(40, Math.max(8, size)) : "",
      fontFamily: el.querySelector(".p-fontFamily").value.trim(),
      cursorStyle: el.querySelector(".p-cursorStyle").value,
    };
    profiles.push(p);
    if (el.querySelector("input[type=radio]").checked) defaultProfile = p.id;
  }
  return { profiles, defaultProfile };
}

document.getElementById("add-profile").addEventListener("click", () => {
  profilesEl.appendChild(profileRow({ id: newProfileId(), name: "" }, false));
  profilesEl.lastElementChild.querySelector(".p-name").focus();
});

function read() {
  const out = { ...readProfiles() };
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    const el = form.elements[key];
    if (!el || el instanceof RadioNodeList) continue;
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
    if (done || msg.type === "hello") return;
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
