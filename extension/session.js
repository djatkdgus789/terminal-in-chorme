// One terminal pane: an xterm.js instance plus its native messaging port.
// Sessions live inside a Tab (workspace.js); App (terminal.js) wires them up.
"use strict";

const THEMES = {
  // Dracula, from the official spec (https://draculatheme.com/contribute).
  dracula: {
    background: "#282a36", foreground: "#f8f8f2", cursor: "#f8f8f2",
    cursorAccent: "#282a36", selectionBackground: "#44475a",
    selectionInactiveBackground: "rgba(68, 71, 90, 0.6)",
    black: "#21222c", red: "#ff5555", green: "#50fa7b", yellow: "#f1fa8c",
    blue: "#bd93f9", magenta: "#ff79c6", cyan: "#8be9fd", white: "#f8f8f2",
    brightBlack: "#6272a4", brightRed: "#ff6e6e", brightGreen: "#69ff94",
    brightYellow: "#ffffa5", brightBlue: "#d6acff", brightMagenta: "#ff92df",
    brightCyan: "#a4ffff", brightWhite: "#ffffff",
  },
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

// Flow control (xterm.js "flow control" guide): stop the daemon reading the
// pty while xterm has more than FLOW_HIGH bytes still to render.
const FLOW_HIGH = 1024 * 1024;
const FLOW_LOW = 128 * 1024;

function resolveTheme(name) {
  if (name === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return THEMES[name] ? name : "dracula";
}

let nextSessionId = 1;

class Session {
  // opts: { attach: daemon session id, title, profile: profile id, cwd }
  constructor(opts = {}) {
    this.id = nextSessionId++;
    this.tab = null;
    this.attachId = opts.attach || null;
    this.sessionId = this.attachId;
    this.profileId = opts.profile || "";
    this.startCwd = opts.cwd || "";
    this.cwd = "";
    this.port = null;
    this.exited = false;
    this.shellInfo = null;
    this.title = opts.title || "Terminal";
    this.pending = 0;
    this.paused = false;
    this.commands = [];      // shell-integration command records
    this.currentCommand = null;
    this.cfg = effectiveSettings(App.settings, getProfile(App.settings, this.profileId));
    this.buildDom();
    this.buildTerminal();
  }

  // -- DOM ----------------------------------------------------------------------
  buildDom() {
    const frag = document.getElementById("pane-template").content.cloneNode(true);
    const q = (sel) => frag.querySelector(sel);
    this.pane = q(".pane");
    this.termEl = q(".term");
    this.overlay = q(".overlay");
    this.overlayTitle = q(".overlay-title");
    this.overlayDetail = q(".overlay-detail");
    this.overlayCode = q(".overlay-code");
    q(".overlay-retry").addEventListener("click", () => this.restart());
    q(".overlay-close").addEventListener("click", () => App.closeSession(this));

    this.findBar = q(".findbar");
    this.findInput = q(".find-input");
    this.findCount = q(".find-count");
    this.findRegex = q(".find-regex");
    this.findCase = q(".find-case");
    q(".find-prev").addEventListener("click", () => this.find(-1));
    q(".find-next").addEventListener("click", () => this.find(1));
    q(".find-close").addEventListener("click", () => this.closeFind());
    for (const btn of [this.findRegex, this.findCase]) {
      btn.addEventListener("click", () => {
        btn.setAttribute("aria-pressed", btn.getAttribute("aria-pressed") === "true" ? "false" : "true");
        this.find(1, true);
        this.findInput.focus();
      });
    }
    this.findInput.addEventListener("input", () => this.find(1, true));
    this.findInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { this.find(e.shiftKey ? -1 : 1); e.preventDefault(); }
      else if (e.key === "Escape") { this.closeFind(); e.preventDefault(); }
    });

    this.pasteBox = q(".paste-guard");
    this.pastePreview = q(".paste-preview");
    this.pasteSummary = q(".paste-summary");
    q(".paste-confirm").addEventListener("click", () => this.confirmPaste(false));
    q(".paste-oneline").addEventListener("click", () => this.confirmPaste(true));
    q(".paste-cancel").addEventListener("click", () => this.cancelPaste());
    this.pasteBox.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { this.cancelPaste(); e.preventDefault(); }
      else if (e.key === "Enter") { this.confirmPaste(false); e.preventDefault(); }
    });

    q(".bc-badge").addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      App.toggleBroadcastExclusion(this);
    });

    // Clicking anywhere in the pane focuses it (for split layouts).
    this.pane.addEventListener("mousedown", () => App.focusSession(this), true);
  }

  // -- xterm ----------------------------------------------------------------------
  buildTerminal() {
    const cfg = this.cfg;
    this.term = new Terminal({
      allowProposedApi: true,
      cursorBlink: cfg.cursorBlink,
      cursorStyle: cfg.cursorStyle,
      fontSize: cfg.fontSize,
      fontFamily: cfg.fontFamily,
      scrollback: cfg.scrollback,
      macOptionIsMeta: cfg.macOptionIsMeta,
      macOptionClickForcesSelection: true,
      theme: THEMES[resolveTheme(cfg.theme)],
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
    this.loadImages();
    this.installShellIntegration();
    this.installFileLinks();
    this.installPasteGuard();

    // Tell keyboard/paste/IME input apart from replies xterm generates itself
    // (cursor position, device attributes, focus reports...). Only the former
    // may be broadcast to other panes; a reply belongs to the shell that
    // asked. xterm fires the internal onUserInput event synchronously right
    // before onData for user input (CoreService.triggerDataEvent).
    this.userInputPending = false;
    const core = this.term._core && this.term._core.coreService;
    this.canTellUserInput = !!(core && core.onUserInput);
    if (this.canTellUserInput) core.onUserInput(() => { this.userInputPending = true; });
    this.term.onData((data) => {
      const fromUser = this.userInputPending;
      this.userInputPending = false;
      this.send({ type: "input", data: stringToBase64(data) });
      if (fromUser && !Session.isMouseReport(data)) App.broadcastInput(this, data);
    });
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
      if (App.settings.copyOnSelect && this.term.hasSelection()) {
        navigator.clipboard.writeText(this.term.getSelection()).catch(() => {});
      }
    });
    this.term.attachCustomKeyEventHandler((e) => App.handleKey(e, this));
  }

  loadWebgl() {
    // GPU rendering as VS Code and Termium do; falls back to the DOM
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

  // Inline images: iTerm2 protocol (OSC 1337 File=, used by imgcat) and sixel.
  loadImages() {
    if (!this.cfg.imageSupport || !window.ImageAddon) return;
    try {
      this.images = new ImageAddon.ImageAddon({
        sixelSupport: true,
        iipSupport: true,
        enableSizeReports: true,   // answer CSI 14/16 t so tools can size images
        showPlaceholder: true,
        storageLimit: 128,         // MB of decoded pixels kept per pane
        pixelLimit: 16777216,      // refuse single images above 16 megapixels
        iipSizeLimit: 20000000,    // ~20 MB of encoded image data
      });
      this.term.loadAddon(this.images);
    } catch (err) {
      console.warn("image support unavailable", err);
      this.images = null;
    }
  }

  static isMouseReport(data) {
    return /^\x1b\[(M|<\d)/.test(data);
  }

  // -- shell integration (OSC 133 prompt marks, OSC 7 cwd) ------------------------
  installShellIntegration() {
    const term = this.term;
    term.parser.registerOscHandler(133, (data) => {
      const [kind, arg] = data.split(";");
      const buf = term.buffer.active;
      switch (kind) {
        case "A": { // prompt start
          const marker = term.registerMarker(0);
          if (!marker) break;
          this.currentCommand = { marker, exitCode: null, command: "", promptX: 0 };
          this.commands.push(this.currentCommand);
          if (this.commands.length > 2000) this.commands.shift();
          break;
        }
        case "B": // command (user input) start
          if (this.currentCommand) this.currentCommand.promptX = buf.cursorX;
          break;
        case "C": { // command output start: capture the typed command
          const c = this.currentCommand;
          if (!c || c.marker.isDisposed) break;
          const lines = [];
          for (let y = c.marker.line; y <= buf.baseY + buf.cursorY && y < buf.length; y++) {
            const line = buf.getLine(y);
            if (!line) break;
            let text = line.translateToString(true);
            if (y === c.marker.line) text = text.slice(c.promptX);
            lines.push(text);
          }
          c.command = lines.join("\n").trim();
          c.outputMarker = term.registerMarker(0);
          break;
        }
        case "D": { // command finished
          const c = this.currentCommand;
          if (!c) break;
          // No "C" mark means nothing ran (Ctrl+C at the prompt, empty Enter);
          // the status the shell reports then is stale, so do not mark it.
          if (!c.outputMarker) break;
          c.exitCode = arg === undefined || arg === "" ? null : parseInt(arg, 10);
          this.decorateCommand(c);
          break;
        }
      }
      return true;
    });
    term.parser.registerOscHandler(7, (data) => {
      const path = fileUrlToPath(data);
      if (path) this.setCwd(path);
      return true;
    });
  }

  decorateCommand(c) {
    if (!c.marker || c.marker.isDisposed) return;
    const failed = c.exitCode !== null && c.exitCode !== 0;
    try {
      const deco = this.term.registerDecoration({
        marker: c.marker, x: 0, width: 1,
        overviewRulerOptions: { color: failed ? "#ff6b6b" : "rgba(127,127,127,0.5)", position: "left" },
      });
      if (deco) {
        deco.onRender((el) => {
          el.classList.add("cmd-mark", failed ? "failed" : "ok");
          el.title = (failed ? "exit " + c.exitCode + ": " : "") + c.command;
        });
        c.decoration = deco;
      }
    } catch (_) { /* decorations need the DOM/WebGL renderer; ignore otherwise */ }
  }

  // Scroll to the previous (-1) / next (+1) prompt.
  jumpPrompt(delta) {
    const buf = this.term.buffer.active;
    const top = buf.viewportY;
    const lines = this.commands.map((c) => c.marker).filter((m) => !m.isDisposed).map((m) => m.line);
    let target;
    if (delta < 0) target = lines.filter((l) => l < top).pop();
    else target = lines.find((l) => l > top);
    if (target === undefined && delta > 0) { this.term.scrollToBottom(); return; }
    if (target !== undefined) this.term.scrollToLine(target);
  }

  setCwd(path) {
    this.cwd = path;
    App.sessionCwdChanged(this);
  }

  // -- Cmd-click on file paths ---------------------------------------------------
  installFileLinks() {
    const term = this.term;
    const tokenRe = /[\w~.@%+\/-]+(?::\d+)?(?::\d+)?/g;
    term.registerLinkProvider({
      provideLinks: (lineNo, cb) => {
        const line = term.buffer.active.getLine(lineNo - 1);
        if (!line) return cb(undefined);
        const text = line.translateToString(true);
        const links = [];
        let m;
        while ((m = tokenRe.exec(text))) {
          const token = m[0];
          if (!Session.looksLikePath(token)) continue;
          links.push({
            range: { start: { x: m.index + 1, y: lineNo }, end: { x: m.index + token.length, y: lineNo } },
            text: token,
            decorations: { pointerCursor: true, underline: true },
            activate: (event, t) => {
              if (!(event.metaKey || event.ctrlKey)) return;
              const parts = /^(.*?)(?::(\d+))?(?::(\d+))?$/.exec(t);
              let path = parts[1];
              if (!path.startsWith("/") && !path.startsWith("~")) {
                path = (this.cwd || this.startCwd || "~") + "/" + path.replace(/^\.\//, "");
              }
              this.send({ type: "open", path, line: parts[2] ? parseInt(parts[2], 10) : undefined,
                command: App.settings.openCommand || undefined });
            },
          });
        }
        cb(links.length ? links : undefined);
      },
    });
  }

  static looksLikePath(token) {
    if (token.includes("://") || /^[\d.:]+$/.test(token) || token.length < 2) return false;
    if (token.startsWith("~") || token.startsWith("./") || token.startsWith("../")) return true;
    if (token.includes("/")) return !/^[-+]+$/.test(token.replace(/\//g, ""));
    return /\.[A-Za-z]\w{0,7}:\d+/.test(token); // main.py:12
  }

  // -- paste guard ---------------------------------------------------------------
  installPasteGuard() {
    this.termEl.addEventListener("paste", (e) => {
      if (!App.settings.pasteGuard) return;
      const text = e.clipboardData ? e.clipboardData.getData("text/plain") : "";
      if (!/[\r\n]/.test(text.replace(/[\r\n]+$/, ""))) return; // single line: let xterm handle it
      e.preventDefault();
      e.stopPropagation();
      this.pendingPaste = text;
      const lines = text.split(/\r\n|\r|\n/);
      this.pasteSummary.textContent = "Paste " + lines.length + " lines? Each line will run as it is entered.";
      this.pastePreview.textContent = lines.slice(0, 8).join("\n") + (lines.length > 8 ? "\n…" : "");
      this.pasteBox.classList.remove("hidden");
      this.pasteBox.querySelector(".paste-confirm").focus();
    }, true);
  }

  confirmPaste(asOneLine) {
    const text = this.pendingPaste || "";
    this.cancelPaste();
    this.term.paste(asOneLine ? text.split(/\r\n|\r|\n/).map((l) => l.trim()).filter(Boolean).join(" ") : text);
  }

  cancelPaste() {
    this.pendingPaste = null;
    this.pasteBox.classList.add("hidden");
    this.term.focus();
  }

  // -- find bar ------------------------------------------------------------------
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
      regex: this.findRegex.getAttribute("aria-pressed") === "true",
      caseSensitive: this.findCase.getAttribute("aria-pressed") === "true",
      decorations: resolveTheme(this.cfg.theme) === "dracula" ? {
        matchBackground: "#6272a4", matchOverviewRuler: "#f1fa8c",
        activeMatchBackground: "#ffb86c", activeMatchColorOverviewRuler: "#ffb86c",
      } : {
        matchBackground: "#6b5a1e", matchOverviewRuler: "#e5c07b",
        activeMatchBackground: "#c9a227", activeMatchColorOverviewRuler: "#ffffff",
      },
    };
    try {
      if (direction < 0) this.search.findPrevious(query, opts);
      else this.search.findNext(query, opts);
    } catch (_) {
      this.findCount.textContent = "bad regex";
    }
  }

  // -- native port ---------------------------------------------------------------
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
    this.fitNow(); // so the shell starts with the right size
    if (this.attachId) {
      this.send({ type: "attach", session: this.attachId, cols: this.term.cols, rows: this.term.rows });
    } else {
      this.send({
        type: "spawn",
        cols: this.term.cols,
        rows: this.term.rows,
        shell: this.cfg.shell || undefined,
        cwd: this.startCwd || this.cfg.cwd || undefined,
        integration: !!App.settings.shellIntegration,
        profile: this.profileId || undefined,
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
        if (msg.profile && !this.profileId) this.profileId = msg.profile;
        if (!this.cwd && msg.cwd) this.cwd = msg.cwd;
        this.setStatus("connected");
        if (msg.title && this.title === "Terminal") this.setTitle(msg.title);
        if (App.isFocused(this)) this.term.focus();
        App.layoutChanged();
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
        App.layoutChanged();
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
      default:
        break; // hello, pong, sessions, opened
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
    this.commands = [];
    this.currentCommand = null;
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
  }

  isVisible() {
    return this.pane.isConnected && this.pane.getClientRects().length > 0;
  }

  fitNow() {
    if (!this.isVisible()) return;
    try { this.fit.fit(); } catch (_) {}
  }

  applySettings() {
    this.cfg = effectiveSettings(App.settings, getProfile(App.settings, this.profileId));
    const cfg = this.cfg;
    const t = this.term;
    t.options.fontSize = cfg.fontSize;
    t.options.fontFamily = cfg.fontFamily;
    t.options.cursorBlink = cfg.cursorBlink;
    t.options.cursorStyle = cfg.cursorStyle;
    t.options.scrollback = cfg.scrollback;
    t.options.macOptionIsMeta = cfg.macOptionIsMeta;
    t.options.theme = THEMES[resolveTheme(cfg.theme)];
    this.fitNow();
  }

  setTitle(title) {
    this.title = title || "Terminal";
    App.sessionTitleChanged(this);
  }

  setStatus(state) {
    this.status = state;
    App.sessionStatusChanged(this);
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
