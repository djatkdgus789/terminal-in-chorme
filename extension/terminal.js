// Terminal page: one xterm.js instance per tab. Every tab has its own native
// messaging port; the port is a bridge to a per-user session daemon that owns
// the shells, so a shell survives the page being closed and is re-attached
// (with its recent output replayed) the next time the page opens.
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

// Flow control (see xterm.js "flow control" guide): stop the daemon reading
// the pty while xterm has more than HIGH bytes still to render.
const FLOW_HIGH = 1024 * 1024;
const FLOW_LOW = 128 * 1024;

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
  // opts.attach: daemon session id to re-attach to instead of spawning.
  constructor(opts = {}) {
    this.id = nextId++;
    this.attachId = opts.attach || null;
    this.sessionId = this.attachId;
    this.port = null;
    this.exited = false;
    this.shellInfo = null;
    this.title = opts.title || "Terminal";
    this.pending = 0;
    this.paused = false;
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

    this.findBar = frag.querySelector(".findbar");
    this.findInput = frag.querySelector(".find-input");
    this.findCount = frag.querySelector(".find-count");
    frag.querySelector(".find-prev").addEventListener("click", () => this.find(-1));
    frag.querySelector(".find-next").addEventListener("click", () => this.find(1));
    frag.querySelector(".find-close").addEventListener("click", () => this.closeFind());
    this.findInput.addEventListener("input", () => this.find(1, true));
    this.findInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { this.find(e.shiftKey ? -1 : 1); e.preventDefault(); }
      else if (e.key === "Escape") { this.closeFind(); e.preventDefault(); }
    });
    panesEl.appendChild(frag);

    this.tab = document.createElement("div");
    this.tab.className = "tab";
    this.tab.setAttribute("role", "tab");
    this.tab.innerHTML =
      '<span class="status"></span><span class="title"></span>' +
      '<button class="close" title="Close (kills the shell)">×</button>';
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
    this.search = new SearchAddon.SearchAddon();
    this.term.loadAddon(this.search);
    this.search.onDidChangeResults((r) => {
      this.findCount.textContent = r && r.resultCount > 0
        ? (r.resultIndex + 1) + "/" + r.resultCount
        : (this.findInput.value ? "0/0" : "");
    });
    this.term.loadAddon(new WebLinksAddon.WebLinksAddon((event, uri) => {
      // Require Cmd/Ctrl-click so ordinary clicks never leave the terminal.
      if (event.metaKey || event.ctrlKey) chrome.tabs.create({ url: uri });
    }));
    this.term.open(this.termEl);
    this.loadWebgl();

    this.term.onData((data) => this.send({ type: "input", data: stringToBase64(data) }));
    this.term.onBinary((data) => {
      const bytes = new Uint8Array(data.length);
      for (let i = 0; i < data.length; i++) bytes[i] = data.charCodeAt(i) & 0xff;
      this.send({ type: "input", data: bytesToBase64(bytes) });
    });
    this.term.onResize(({ cols, rows }) => this.send({ type: "resize", cols, rows }));
    this.term.onTitleChange((title) => {
      this.setTitle(title);
      this.send({ type: "title", title });
    });
    this.term.onSelectionChange(() => {
      if (settings.copyOnSelect && this.term.hasSelection()) {
        navigator.clipboard.writeText(this.term.getSelection()).catch(() => {});
      }
    });
    this.term.attachCustomKeyEventHandler((e) => this.handleKey(e));
  }

  loadWebgl() {
    // GPU rendering, as VS Code and Termium do. Falls back to the DOM
    // renderer when WebGL is unavailable or the context is lost.
    if (!window.WebglAddon) return;
    try {
      const webgl = new WebglAddon.WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      this.term.loadAddon(webgl);
    } catch (err) {
      console.warn("WebGL renderer unavailable, using DOM renderer", err);
    }
  }

  handleKey(e) {
    if (e.type !== "keydown") return true;
    const mod = e.metaKey || e.ctrlKey;
    const plainMeta = e.metaKey && !e.ctrlKey && !e.altKey;

    // Cmd+C with a selection copies; without a selection nothing is sent
    // (Ctrl+C is the interrupt, as in Terminal.app).
    if (plainMeta && e.key === "c" && this.term.hasSelection()) {
      return false; // let the browser fire the copy event
    }
    if (plainMeta && e.key === "v") {
      return false; // native paste event handled by xterm
    }
    if (plainMeta && e.key === "k") {
      this.term.clear();
      e.preventDefault();
      return false;
    }
    if (plainMeta && e.key === "f") {
      this.openFind();
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

  // -- find bar ---------------------------------------------------------------
  openFind() {
    this.findBar.classList.remove("hidden");
    this.findInput.focus();
    this.findInput.select();
  }

  closeFind() {
    this.findBar.classList.add("hidden");
    this.search.clearDecorations();
    this.findCount.textContent = "";
    this.term.focus();
  }

  find(direction, incremental = false) {
    const query = this.findInput.value;
    if (!query) { this.search.clearDecorations(); this.findCount.textContent = ""; return; }
    const opts = {
      incremental,
      decorations: {
        matchBackground: "#6b5a1e", matchOverviewRuler: "#e5c07b",
        activeMatchBackground: "#c9a227", activeMatchColorOverviewRuler: "#ffffff",
      },
    };
    if (direction < 0) this.search.findPrevious(query, opts);
    else this.search.findNext(query, opts);
  }

  // -- native port --------------------------------------------------------------
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
    this.pending = 0;
    this.paused = false;
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
    if (this.attachId) {
      this.send({ type: "attach", session: this.attachId, cols: this.term.cols, rows: this.term.rows });
    } else {
      this.send({
        type: "spawn",
        cols: this.term.cols,
        rows: this.term.rows,
        shell: settings.shell || undefined,
        cwd: settings.cwd || undefined,
      });
    }
  }

  onMessage(msg) {
    switch (msg.type) {
      case "data":
        this.writeData(base64ToBytes(msg.data));
        break;
      case "ready":
        this.shellInfo = msg;
        this.sessionId = msg.session;
        this.attachId = null;
        this.setStatus("connected");
        if (msg.title && this.title === "Terminal") this.setTitle(msg.title);
        if (this === activeSession) this.term.focus();
        break;
      case "exit": {
        this.exited = true;
        this.sessionId = null;
        this.setStatus("exited");
        const how = msg.signal != null ? "signal " + msg.signal : "code " + msg.code;
        this.term.write("\r\n\x1b[90m[Process exited with " + how + "]\x1b[0m\r\n");
        this.showOverlay("Shell exited",
          "The shell finished with " + how + ". Reconnect to start a new one.");
        if (this.port) { this.port.disconnect(); this.port = null; }
        break;
      }
      case "error":
        if (!this.shellInfo) {
          // Could not spawn or attach: a stale session id after a reboot, a
          // session already shown in another window, a missing shell, ...
          this.exited = true;
          this.setStatus("error");
          if (this.attachId) {
            this.showOverlay("Could not re-attach", msg.message + " Reconnect to start a new shell here.");
            this.attachId = null;
          } else {
            this.showError("Could not start the shell", msg.message);
          }
        } else {
          this.term.write("\r\n\x1b[31m[host error] " + msg.message + "\x1b[0m\r\n");
        }
        break;
      case "hello":
      case "pong":
      case "sessions":
        break;
    }
  }

  writeData(bytes) {
    this.pending += bytes.length;
    this.term.write(bytes, () => {
      this.pending -= bytes.length;
      if (this.paused && this.pending < FLOW_LOW) {
        this.paused = false;
        this.send({ type: "resume" });
      }
    });
    if (!this.paused && this.pending > FLOW_HIGH) {
      this.paused = true;
      this.send({ type: "pause" });
    }
  }

  restart() {
    if (this.port) { try { this.port.disconnect(); } catch (_) {} }
    this.port = null;
    this.shellInfo = null;
    this.attachId = null;
    this.term.reset();
    this.connect();
  }

  // Detach: the shell keeps running in the daemon.
  detach() {
    this.exited = true;
    if (this.port) { try { this.port.disconnect(); } catch (_) {} }
    this.port = null;
  }

  // Kill the shell, then drop the UI.
  destroy() {
    if (this.port && this.shellInfo && !this.exited) {
      try { this.port.postMessage({ type: "kill" }); } catch (_) {}
    }
    this.detach();
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

function newSession(opts) {
  const s = new Session(opts);
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

// Ask the daemon which shells are still running but not shown anywhere, and
// re-attach to each of them. Resolves with the number of tabs created.
function reattachDetached() {
  return new Promise((resolve) => {
    let port;
    try {
      port = chrome.runtime.connectNative(HOST_NAME);
    } catch (_) {
      resolve(0);
      return;
    }
    let done = false;
    const finish = (n) => { if (!done) { done = true; try { port.disconnect(); } catch (_) {} resolve(n); } };
    const timer = setTimeout(() => finish(0), 5000);
    port.onMessage.addListener((msg) => {
      if (msg.type !== "sessions") return;
      clearTimeout(timer);
      const detached = msg.sessions.filter((s) => !s.attached);
      for (const s of detached) newSession({ attach: s.session, title: s.title });
      finish(detached.length);
    });
    port.onDisconnect.addListener(() => { void chrome.runtime.lastError; clearTimeout(timer); finish(0); });
    port.postMessage({ type: "list" });
  });
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

// Closing the page detaches (shells keep running) unless persistence is off.
window.addEventListener("beforeunload", () => {
  sessions.forEach((s) => (settings.persistSessions ? s.detach() : s.destroy()));
});

// Keep focus in the terminal when clicking dead space.
panesEl.addEventListener("mousedown", (e) => {
  if (e.target === panesEl && activeSession) activeSession.term.focus();
});

// Debugging / test hook: inspect sessions from DevTools.
window.terminalInChrome = { sessions, get active() { return activeSession; } };

loadSettings().then(async (loaded) => {
  settings = loaded;
  applyPageTheme();
  const reattached = settings.persistSessions ? await reattachDetached() : 0;
  if (reattached === 0) newSession();
});
