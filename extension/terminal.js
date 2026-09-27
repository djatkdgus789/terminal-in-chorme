// App: tabs, profiles, keyboard shortcuts, settings and session persistence.
"use strict";

const isPanel = document.body.classList.contains("panel");
const tabsEl = document.getElementById("tabs");
const panesEl = document.getElementById("panes");

const App = {
  settings: { ...DEFAULT_SETTINGS },
  tabs: [],
  activeTab: null,

  // -- sessions & tabs ---------------------------------------------------------------
  allSessions() {
    return this.tabs.flatMap((t) => t.sessions());
  },

  newTab(opts = {}) {
    const profile = opts.profile !== undefined ? opts.profile : this.settings.defaultProfile;
    const cwd = opts.cwd !== undefined ? opts.cwd : this.inheritedCwd();
    const tab = new Tab();
    const session = new Session({ profile, cwd, attach: opts.attach, title: opts.title });
    tab.addSession(session);
    this.tabs.push(tab);
    this.activateTab(tab);
    session.connect();
    this.layoutChanged();
    return tab;
  },

  inheritedCwd() {
    const s = this.activeTab && this.activeTab.focused;
    return this.settings.inheritCwd && s && s.cwd ? s.cwd : "";
  },

  splitSession(session, dir) {
    const tab = session.tab;
    if (!tab) return;
    const cwd = this.settings.inheritCwd && session.cwd ? session.cwd : "";
    const s = new Session({ profile: session.profileId, cwd });
    tab.split(session, dir, s);
    s.connect();
    this.layoutChanged();
    return s;
  },

  closeSession(session) {
    const tab = session.tab;
    session.destroy();
    if (tab) {
      tab.remove(session);
      if (!tab.tree) this.closeTab(tab, false);
    }
    this.layoutChanged();
  },

  closeTab(tab, killSessions = true) {
    const idx = this.tabs.indexOf(tab);
    if (idx === -1) return;
    if (killSessions) tab.sessions().forEach((s) => s.destroy());
    this.tabs.splice(idx, 1);
    tab.el.remove();
    tab.root.remove();
    if (this.tabs.length === 0) {
      if (isPanel) this.newTab(); else window.close();
      return;
    }
    if (this.activeTab === tab) this.activateTab(this.tabs[Math.min(idx, this.tabs.length - 1)]);
    this.layoutChanged();
  },

  activateTab(tab) {
    this.activeTab = tab;
    for (const t of this.tabs) t.setActive(t === tab);
    document.title = tab.title;
    if (tab.focused) tab.focus(tab.focused);
  },

  cycleTab(delta) {
    if (this.tabs.length < 2) return;
    const idx = this.tabs.indexOf(this.activeTab);
    this.activateTab(this.tabs[(idx + delta + this.tabs.length) % this.tabs.length]);
  },

  focusSession(session) {
    if (!session.tab) return;
    if (this.activeTab !== session.tab) this.activateTab(session.tab);
    if (session.tab.focused !== session) session.tab.focus(session);
  },

  isFocused(session) {
    return this.activeTab === session.tab && session.tab && session.tab.focused === session;
  },

  sessionTitleChanged(session) {
    if (session.tab) session.tab.updateLabel();
  },

  sessionStatusChanged(session) {
    if (session.tab) session.tab.updateLabel();
  },

  sessionCwdChanged() {},

  // -- keyboard ------------------------------------------------------------------------
  // Returns true when xterm should handle the event itself.
  handleKey(e, session) {
    if (e.type !== "keydown") return true;
    const mod = e.metaKey || e.ctrlKey;
    const plainMeta = e.metaKey && !e.ctrlKey && !e.altKey;
    const ctrlShift = e.ctrlKey && e.shiftKey && !e.metaKey && !e.altKey;
    const stop = () => { e.preventDefault(); return false; };
    const key = e.key.toLowerCase();

    // Cmd+C with a selection copies; without one nothing is sent (Ctrl+C is
    // the interrupt, as in Terminal.app). Cmd+V is the native paste event.
    if (plainMeta && key === "c" && session.term.hasSelection()) return false;
    if (plainMeta && key === "v") return false;
    if (plainMeta && key === "k") { session.term.clear(); return stop(); }
    if (plainMeta && key === "f") { session.openFind(); return stop(); }
    if (plainMeta && !e.shiftKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      session.jumpPrompt(e.key === "ArrowUp" ? -1 : 1);
      return stop();
    }
    if (e.metaKey && (e.key === "=" || e.key === "+" || e.key === "-" || e.key === "0")) {
      const size = e.key === "0" ? DEFAULT_SETTINGS.fontSize
        : this.settings.fontSize + (e.key === "-" ? -1 : 1);
      this.settings.fontSize = Math.min(40, Math.max(8, size));
      this.allSessions().forEach((s) => s.applySettings());
      return stop();
    }
    if (mod && e.shiftKey && key === "t") { this.newTab(); return stop(); }
    if (mod && e.shiftKey && key === "w") { this.closeSession(session); return stop(); }
    if (ctrlShift && key === "d") { this.splitSession(session, "row"); return stop(); }
    if (ctrlShift && key === "e") { this.splitSession(session, "col"); return stop(); }
    if (ctrlShift && (e.key === "[" || e.key === "{" || e.key === "]" || e.key === "}")) {
      this.cycleTab(e.key === "]" || e.key === "}" ? 1 : -1);
      return stop();
    }
    if (ctrlShift && e.key.startsWith("Arrow") && session.tab) {
      session.tab.navigate(e.key.slice(5).toLowerCase());
      return stop();
    }
    return true;
  },

  // -- persistence of the tab/split layout across page loads ---------------------------
  layoutChanged() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.saveLayout(), 150);
  },

  saveLayout() {
    if (!this.settings.persistSessions) return;
    const layouts = this.tabs.map((t) => t.serialize()).filter(Boolean);
    try { chrome.storage.local.set({ ["layout:" + (isPanel ? "panel" : "tab")]: layouts }); } catch (_) {}
  },

  loadLayout() {
    const key = "layout:" + (isPanel ? "panel" : "tab");
    return new Promise((resolve) => {
      try { chrome.storage.local.get({ [key]: [] }, (items) => resolve(items[key] || [])); }
      catch (_) { resolve([]); }
    });
  },

  // Ask the daemon which shells are running but not shown anywhere, rebuild
  // the saved tab/split layout from them, and give leftovers their own tab.
  listDaemonSessions() {
    return new Promise((resolve) => {
      let port;
      try { port = chrome.runtime.connectNative(HOST_NAME); } catch (_) { resolve([]); return; }
      let done = false;
      const finish = (v) => { if (!done) { done = true; try { port.disconnect(); } catch (_) {} resolve(v); } };
      const timer = setTimeout(() => finish([]), 5000);
      port.onMessage.addListener((msg) => {
        if (msg.type === "sessions") { clearTimeout(timer); finish(msg.sessions); }
      });
      port.onDisconnect.addListener(() => { void chrome.runtime.lastError; clearTimeout(timer); finish([]); });
      port.postMessage({ type: "list" });
    });
  },

  async reattach() {
    const [daemonSessions, layouts] = await Promise.all([this.listDaemonSessions(), this.loadLayout()]);
    const detached = new Map(daemonSessions.filter((s) => !s.attached).map((s) => [s.session, s]));
    const created = [];
    for (const layout of layouts) {
      const tab = Tab.deserialize(layout, (id, profile) => {
        const info = detached.get(id);
        if (!info) return null;
        detached.delete(id);
        const s = new Session({ attach: id, title: info.title, profile: info.profile || profile });
        created.push(s);
        return s;
      });
      if (tab) this.tabs.push(tab);
    }
    for (const info of detached.values()) {
      const tab = new Tab();
      const s = new Session({ attach: info.session, title: info.title, profile: info.profile });
      tab.addSession(s);
      this.tabs.push(tab);
      created.push(s);
    }
    if (this.tabs.length) {
      this.activateTab(this.tabs[0]);
      created.forEach((s) => s.connect());
    }
    return this.tabs.length;
  },

  // -- profiles menu ---------------------------------------------------------------------
  showProfileMenu(anchor) {
    const old = document.getElementById("profile-menu");
    if (old) { old.remove(); return; }
    const menu = document.createElement("div");
    menu.id = "profile-menu";
    const items = [{ id: "", name: "Default (global settings)" }, ...(this.settings.profiles || [])];
    for (const p of items) {
      const item = document.createElement("button");
      item.className = "menu-item" + (p.id === this.settings.defaultProfile ? " default" : "");
      item.textContent = p.name || "(unnamed)";
      item.addEventListener("click", () => { menu.remove(); this.newTab({ profile: p.id }); });
      menu.appendChild(item);
    }
    const manage = document.createElement("button");
    manage.className = "menu-item manage";
    manage.textContent = "Manage profiles…";
    manage.addEventListener("click", () => { menu.remove(); chrome.runtime.openOptionsPage(); });
    menu.appendChild(manage);
    document.body.appendChild(menu);
    const r = anchor.getBoundingClientRect();
    menu.style.top = r.bottom + 4 + "px";
    menu.style.right = Math.max(6, window.innerWidth - r.right) + "px";
    setTimeout(() => document.addEventListener("mousedown", function off(ev) {
      if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener("mousedown", off); }
    }), 0);
  },

  applyPageTheme() {
    document.documentElement.dataset.theme = resolveTheme(this.settings.theme);
  },
};

// -- wiring ----------------------------------------------------------------------------------
document.getElementById("new-tab").addEventListener("click", () => App.newTab());
document.getElementById("new-tab").addEventListener("contextmenu", (e) => {
  e.preventDefault();
  App.showProfileMenu(e.currentTarget);
});
document.getElementById("profile-menu-btn").addEventListener("click", (e) => App.showProfileMenu(e.currentTarget));
document.getElementById("split-right").addEventListener("click", () => {
  const s = App.activeTab && App.activeTab.focused;
  if (s) App.splitSession(s, "row");
});
document.getElementById("split-down").addEventListener("click", () => {
  const s = App.activeTab && App.activeTab.focused;
  if (s) App.splitSession(s, "col");
});
document.getElementById("open-options").addEventListener("click", () => chrome.runtime.openOptionsPage());

let resizeTimer = null;
const scheduleFit = () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => App.activeTab && App.activeTab.fitAll(), 40);
};
window.addEventListener("resize", scheduleFit);
new ResizeObserver(scheduleFit).observe(panesEl);

window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  App.applyPageTheme();
  App.allSessions().forEach((s) => s.applySettings());
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync") return;
  for (const [key, { newValue }] of Object.entries(changes)) {
    App.settings[key] = newValue === undefined ? DEFAULT_SETTINGS[key] : newValue;
  }
  App.applyPageTheme();
  App.allSessions().forEach((s) => s.applySettings());
});

// Closing the page detaches (shells keep running) unless persistence is off.
window.addEventListener("beforeunload", () => {
  App.saveLayout();
  App.allSessions().forEach((s) => (App.settings.persistSessions ? s.detach() : s.destroy()));
});

// Keep focus in the terminal when clicking dead space.
panesEl.addEventListener("mousedown", (e) => {
  if (e.target === panesEl && App.activeTab && App.activeTab.focused) App.activeTab.focused.term.focus();
});

// Debugging / test hook: inspect state from DevTools.
window.terminalInChrome = {
  App,
  get tabs() { return App.tabs; },
  get sessions() { return App.allSessions(); },
  get active() { return App.activeTab ? App.activeTab.focused : null; },
};

loadSettings().then(async (loaded) => {
  App.settings = loaded;
  App.applyPageTheme();
  const restored = App.settings.persistSessions ? await App.reattach() : 0;
  if (restored === 0) App.newTab();
});
