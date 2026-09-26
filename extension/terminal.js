// Terminal page: one xterm.js instance per tab, each backed by its own
// native messaging port (and therefore its own shell process).
"use strict";

const THEMES = {
  dark: {
    background: "#1b1d23", foreground: "#d7dae0", cursor: "#d7dae0",
    cursorAccent: "#1b1d23", selectionBackground: "rgba(95, 179, 245, 0.35)",
    black: "#1b1d23", red: "#ff6b6b", green: "#98c379", yellow: "#e5c07b",
    blue: "#61afef", magenta: "#c678dd", cyan: "#56b6c2", white: "#d7dae0",
    brightBlack: "#5c6370", brightRed: "#ff8787", brightGreen: "#b5e890",
    brightYellow: "#f0d38f", brightBlue: "#7cc1ff", brightMagenta: "#d98ff0",
    brightCyan: "#6fd0dc", brightWhite: "#ffffff",
  },
  light: {
    background: "#fafafa", foreground: "#24292f", cursor: "#24292f",
    cursorAccent: "#fafafa", selectionBackground: "rgba(9, 105, 218, 0.25)",
    black: "#24292f", red: "#cf222e", green: "#116329", yellow: "#9a6700",
    blue: "#0969da", magenta: "#8250df", cyan: "#1b7c83", white: "#6e7781",
    brightBlack: "#57606a", brightRed: "#a40e26", brightGreen: "#1a7f37",
    brightYellow: "#7d4e00", brightBlue: "#218bff", brightMagenta: "#a475f9",
    brightCyan: "#3192aa", brightWhite: "#8c959f",
  },
};

const isPanel = document.body.classList.contains("panel");

const tabsEl = document.getElementById("tabs");
const panesEl = document.getElementById("panes");
const paneTemplate = document.getElementById("pane-template");

let settings = { ...DEFAULT_SETTINGS };
const sessions = [];
let activeSession = null;
let nextId = 1;

function resolveTheme(name) {
  if (name === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return name === "light" ? "light" : "dark";
}

function applyPageTheme() {
  document.documentElement.dataset.theme = resolveTheme(settings.theme);
}

class Session {
  constructor() {
    this.id = nextId++;
    this.port = null;
    this.exited = false;
    this.title = "Terminal";
    this.buildDom();
    this.buildTerminal();
  }

  buildDom() {
    const frag = paneTemplate.content.cloneNode(true);
    this.pane = frag.querySelector(".pane");
    this.termEl = frag.querySelector(".term");
    this.overlay = frag.querySelector(".overlay");
    this.overlayTitle = frag.querySelector(".overlay-title");
    this.overlayDetail = frag.querySelector(".overlay-detail");
    this.overlayCode = frag.querySelector(".overlay-code");
    frag.querySelector(".overlay-retry").addEventListener("click", () => this.restart());
    frag.querySelector(".overlay-close").addEventListener("click", () => closeSession(this));
    panesEl.appendChild(frag);

    this.tab = document.createElement("div");
    this.tab.className = "tab";
    this.tab.setAttribute("role", "tab");
    this.tab.innerHTML =
      '<span class="status"></span><span class="title"></span>' +
      '<button class="close" title="Close">×</button>';
    this.tabTitle = this.tab.querySelector(".title");
    this.tabStatus = this.tab.querySelector(".status");
    this.tab.addEventListener("mousedown", (e) => {
      if (e.target.classList.contains("close")) return;
      activateSession(this);
    });
    this.tab.addEventListener("auxclick", (e) => {
      if (e.button === 1) closeSession(this);
    });
    this.tab.querySelector(".close").addEventListener("click", (e) => {
      e.stopPropagation();
      closeSession(this);
    });
    tabsEl.appendChild(this.tab);
    this.setTitle(this.title);
  }

  buildTerminal() {
    this.term = new Terminal({
      allowProposedApi: true,
      cursorBlink: settings.cursorBlink,
      cursorStyle: settings.cursorStyle,
      fontSize: settings.fontSize,
      fontFamily: settings.fontFamily,
      scrollback: settings.scrollback,
      macOptionIsMeta: settings.macOptionIsMeta,
      macOptionClickForcesSelection: true,
      theme: THEMES[resolveTheme(settings.theme)],
      allowTransparency: false,
      convertEol: false,
    });
    this.fit = new FitAddon.FitAddon();
    this.term.loadAddon(this.fit);
    this.term.loadAddon(new WebLinksAddon.WebLinksAddon((event, uri) => {
      // Require Cmd/Ctrl-click so ordinary clicks never leave the terminal.
      if (event.metaKey || event.ctrlKey) chrome.tabs.create({ url: uri });
    }));
    this.term.open(this.termEl);

    this.term.onData((data) => this.send({ type: "input", data: stringToBase64(data) }));
    this.term.onBinary((data) => {
      const bytes = new Uint8Array(data.length);
      for (let i = 0; i < data.length; i++) bytes[i] = data.charCodeAt(i) & 0xff;
      this.send({ type: "input", data: bytesToBase64(bytes) });
    });
    this.term.onResize(({ cols, rows }) => this.send({ type: "resize", cols, rows }));
    this.term.onTitleChange((title) => this.setTitle(title));
    this.term.onSelectionChange(() => {
      if (settings.copyOnSelect && this.term.hasSelection()) {
        navigator.clipboard.writeText(this.term.getSelection()).catch(() => {});
      }
    });
    this.term.attachCustomKeyEventHandler((e) => this.handleKey(e));
  }

  handleKey(e) {
    if (e.type !== "keydown") return true;
    const mod = e.metaKey || e.ctrlKey;

    // Cmd+C with a selection copies; without a selection it is sent to the
    // shell as Ctrl+C would be. (xterm never forwards Cmd combos itself.)
    if (e.metaKey && !e.ctrlKey && !e.altKey && e.key === "c" && this.term.hasSelection()) {
      return false; // let the browser fire the copy event
    }
    if (e.metaKey && !e.ctrlKey && !e.altKey && e.key === "v") {
      return false; // native paste event handled by xterm
    }
    if (e.metaKey && e.key === "k") {
      this.term.clear();
      e.preventDefault();
      return false;
    }
    if (mod && e.shiftKey && (e.key === "T" || e.key === "t")) {
      newSession();
      e.preventDefault();
      return false;
    }
    if (mod && e.shiftKey && (e.key === "W" || e.key === "w")) {
      closeSession(this);
      e.preventDefault();
      return false;
    }
    if (e.ctrlKey && e.shiftKey && (e.key === "[" || e.key === "{" || e.key === "]" || e.key === "}")) {
      cycleSession(e.key === "]" || e.key === "}" ? 1 : -1);
      e.preventDefault();
      return false;
    }
    if (e.metaKey && (e.key === "=" || e.key === "+" || e.key === "-" || e.key === "0")) {
      const size = e.key === "0" ? DEFAULT_SETTINGS.fontSize
        : settings.fontSize + (e.key === "-" ? -1 : 1);
      settings.fontSize = Math.min(40, Math.max(8, size));
      sessions.forEach((s) => s.applySettings());
      e.preventDefault();
      return false;
    }
    return true;
  }

  send(message) {
    if (!this.port || this.exited) return;
    try {
      this.port.postMessage(message);
    } catch (err) {
      this.showError("Connection lost", String(err));
    }
  }

  connect() {
    this.exited = false;
    this.hideOverlay();
    this.setStatus("connecting");
    try {
      this.port = chrome.runtime.connectNative(HOST_NAME);
    } catch (err) {
      const info = explainNativeError(String(err && err.message || err));
      this.showError(info.title, info.detail);
      return;
    }
    this.port.onMessage.addListener((msg) => this.onMessage(msg));
    this.port.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError;
      this.port = null;
      if (this.exited) return;
      this.exited = true;
      this.setStatus("error");
      const info = explainNativeError(err ? err.message : "");
      this.showError(info.title, info.detail, err ? err.message : "");
    });
    // Fit first so the shell starts with the right size.
    this.fitNow();
    this.send({
      type: "spawn",
      cols: this.term.cols,
      rows: this.term.rows,
      shell: settings.shell || undefined,
      cwd: settings.cwd || undefined,
    });
  }

  onMessage(msg) {
    switch (msg.type) {
      case "data":
        this.term.write(base64ToBytes(msg.data));
        break;
      case "ready":
        this.setStatus("connected");
        this.shellInfo = msg;
        if (this === activeSession) this.term.focus();
        break;
      case "exit": {
        this.exited = true;
        this.setStatus("exited");
        const how = msg.signal != null ? "signal " + msg.signal : "code " + msg.code;
        this.term.write("\r\n\x1b[90m[Process exited with " + how + "]\x1b[0m\r\n");
        this.showOverlay("Shell exited",
          "The shell finished with " + how + ". Reconnect to start a new one.");
        if (this.port) { this.port.disconnect(); this.port = null; }
        break;
      }
      case "error":
        this.term.write("\r\n\x1b[31m[host error] " + msg.message + "\x1b[0m\r\n");
        if (!this.shellInfo) {
          this.exited = true;
          this.setStatus("error");
          this.showError("Could not start the shell", msg.message);
        }
        break;
      case "pong":
        break;
    }
  }

  restart() {
    if (this.port) { try { this.port.disconnect(); } catch (_) {} }
    this.port = null;
    this.shellInfo = null;
    this.term.reset();
    this.connect();
  }

  destroy() {
    this.exited = true;
    if (this.port) { try { this.port.disconnect(); } catch (_) {} }
    this.port = null;
    this.term.dispose();
    this.pane.remove();
    this.tab.remove();
  }

  fitNow() {
    if (!this.pane.classList.contains("active")) return;
    try { this.fit.fit(); } catch (_) {}
  }

  applySettings() {
    const t = this.term;
    t.options.fontSize = settings.fontSize;
    t.options.fontFamily = settings.fontFamily;
    t.options.cursorBlink = settings.cursorBlink;
    t.options.cursorStyle = settings.cursorStyle;
    t.options.scrollback = settings.scrollback;
    t.options.macOptionIsMeta = settings.macOptionIsMeta;
    t.options.theme = THEMES[resolveTheme(settings.theme)];
    this.fitNow();
  }

  setTitle(title) {
    this.title = title || "Terminal";
    this.tabTitle.textContent = this.title;
    this.tab.title = this.title;
    if (this === activeSession) document.title = this.title;
  }

  setStatus(state) {
    this.tabStatus.className = "status " +
      (state === "connected" ? "connected" : state === "error" ? "error" : "");
  }

  showOverlay(title, detail, code) {
    this.overlayTitle.textContent = title;
    this.overlayDetail.textContent = detail || "";
    if (code) {
      this.overlayCode.textContent = code;
      this.overlayCode.classList.remove("hidden");
    } else {
      this.overlayCode.classList.add("hidden");
    }
    this.overlay.classList.remove("hidden");
  }

  showError(title, detail, code) {
    this.exited = true;
    this.setStatus("error");
    this.showOverlay(title, detail, code);
  }

  hideOverlay() {
    this.overlay.classList.add("hidden");
  }
}

function newSession() {
  const s = new Session();
  sessions.push(s);
  activateSession(s);
  s.connect(); // after activation so the first fit() sees the real pane size
  return s;
}

function activateSession(s) {
  activeSession = s;
  for (const other of sessions) {
    const on = other === s;
    other.pane.classList.toggle("active", on);
    other.tab.classList.toggle("active", on);
  }
  document.title = s.title;
  s.tab.scrollIntoView({ inline: "nearest", block: "nearest" });
  s.term.focus(); // synchronously, so keystrokes right after a tab switch are not lost
  requestAnimationFrame(() => { s.fitNow(); s.term.focus(); });
}

function closeSession(s) {
  const idx = sessions.indexOf(s);
  if (idx === -1) return;
  sessions.splice(idx, 1);
  s.destroy();
  if (sessions.length === 0) {
    if (isPanel) newSession(); else window.close();
    return;
  }
  if (activeSession === s) activateSession(sessions[Math.min(idx, sessions.length - 1)]);
}

function cycleSession(delta) {
  if (sessions.length < 2) return;
  const idx = sessions.indexOf(activeSession);
  activateSession(sessions[(idx + delta + sessions.length) % sessions.length]);
}

document.getElementById("new-tab").addEventListener("click", () => newSession());
document.getElementById("open-options").addEventListener("click", () => chrome.runtime.openOptionsPage());

let resizeTimer = null;
const scheduleFit = () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => activeSession && activeSession.fitNow(), 40);
};
window.addEventListener("resize", scheduleFit);
new ResizeObserver(scheduleFit).observe(panesEl);

window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  applyPageTheme();
  sessions.forEach((s) => s.applySettings());
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync") return;
  for (const [key, { newValue }] of Object.entries(changes)) {
    settings[key] = newValue === undefined ? DEFAULT_SETTINGS[key] : newValue;
  }
  applyPageTheme();
  sessions.forEach((s) => s.applySettings());
});

window.addEventListener("beforeunload", () => sessions.forEach((s) => s.destroy()));

// Keep focus in the terminal when clicking dead space.
panesEl.addEventListener("mousedown", (e) => {
  if (e.target === panesEl && activeSession) activeSession.term.focus();
});

loadSettings().then((loaded) => {
  settings = loaded;
  applyPageTheme();
  newSession();
});
