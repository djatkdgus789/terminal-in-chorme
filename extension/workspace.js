// A Tab holds a binary tree of split panes, each leaf being a Session.
"use strict";

let nextTabId = 1;

class Tab {
  constructor() {
    this.id = nextTabId++;
    this.tree = null;       // {kind:"leaf", session} | {kind:"split", dir:"row"|"col", a, b, ratio}
    this.focused = null;

    this.root = document.createElement("div");
    this.root.className = "workspace";
    document.getElementById("panes").appendChild(this.root);

    this.el = document.createElement("div");
    this.el.className = "tab";
    this.el.setAttribute("role", "tab");
    this.el.innerHTML =
      '<span class="status"></span><span class="title"></span>' +
      '<button class="close" title="Close tab (kills its shells)">×</button>';
    this.titleEl = this.el.querySelector(".title");
    this.statusEl = this.el.querySelector(".status");
    this.el.addEventListener("mousedown", (e) => {
      if (e.target.classList.contains("close")) return;
      App.activateTab(this);
    });
    this.el.addEventListener("auxclick", (e) => { if (e.button === 1) App.closeTab(this); });
    this.el.querySelector(".close").addEventListener("click", (e) => {
      e.stopPropagation();
      App.closeTab(this);
    });
    document.getElementById("tabs").appendChild(this.el);
  }

  // -- tree helpers ----------------------------------------------------------------
  sessions(node = this.tree, out = []) {
    if (!node) return out;
    if (node.kind === "leaf") out.push(node.session);
    else { this.sessions(node.a, out); this.sessions(node.b, out); }
    return out;
  }

  findParent(target, node = this.tree, parent = null) {
    if (!node) return null;
    if (node === target) return parent;
    if (node.kind === "split") {
      return this.findParent(target, node.a, node) || this.findParent(target, node.b, node);
    }
    return null;
  }

  leafOf(session, node = this.tree) {
    if (!node) return null;
    if (node.kind === "leaf") return node.session === session ? node : null;
    return this.leafOf(session, node.a) || this.leafOf(session, node.b);
  }

  addSession(session) {
    session.tab = this;
    if (!this.tree) this.tree = { kind: "leaf", session };
    else this.split(this.focused || this.sessions()[0], "row", session, false);
    this.render();
    this.focus(session);
  }

  // Split the pane showing `session`; `dir` "row" = side by side, "col" = stacked.
  split(session, dir, newSession, render = true) {
    const leaf = this.leafOf(session);
    if (!leaf) return;
    newSession.tab = this;
    const newLeaf = { kind: "leaf", session: newSession };
    const node = { kind: "split", dir, a: { kind: "leaf", session }, b: newLeaf, ratio: 0.5 };
    const parent = this.findParent(leaf);
    if (!parent) this.tree = node;
    else if (parent.a === leaf) parent.a = node;
    else parent.b = node;
    if (render) { this.render(); this.focus(newSession); }
  }

  remove(session) {
    const leaf = this.leafOf(session);
    if (!leaf) return;
    const parent = this.findParent(leaf);
    if (!parent) {
      this.tree = null;
    } else {
      const sibling = parent.a === leaf ? parent.b : parent.a;
      const grand = this.findParent(parent);
      if (!grand) this.tree = sibling;
      else if (grand.a === parent) grand.a = sibling;
      else grand.b = sibling;
    }
    session.tab = null;
    if (!this.tree) return;
    this.render();
    if (this.focused === session) this.focus(this.sessions()[0]);
  }

  // -- rendering -------------------------------------------------------------------
  render() {
    // Panes are moved, not recreated, so the terminals (and their WebGL
    // contexts) survive re-layouts.
    this.root.textContent = "";
    if (this.tree) this.root.appendChild(this.build(this.tree));
    this.root.classList.toggle("multi", this.sessions().length > 1);
    requestAnimationFrame(() => this.fitAll());
  }

  build(node) {
    if (node.kind === "leaf") return node.session.pane;
    const el = document.createElement("div");
    el.className = "split " + node.dir;
    const a = document.createElement("div");
    a.className = "split-child";
    a.appendChild(this.build(node.a));
    const divider = document.createElement("div");
    divider.className = "divider";
    const b = document.createElement("div");
    b.className = "split-child";
    b.appendChild(this.build(node.b));
    el.append(a, divider, b);
    this.applyRatio(node, a, b);
    divider.addEventListener("mousedown", (e) => this.startDrag(e, node, el, a, b));
    return el;
  }

  applyRatio(node, a, b) {
    a.style.flex = node.ratio + " 1 0px";
    b.style.flex = (1 - node.ratio) + " 1 0px";
  }

  startDrag(e, node, el, a, b) {
    e.preventDefault();
    const rect = el.getBoundingClientRect();
    const horizontal = node.dir === "row";
    document.body.classList.add(horizontal ? "dragging-col" : "dragging-row");
    let raf = null;
    const move = (ev) => {
      const pos = horizontal ? (ev.clientX - rect.left) / rect.width : (ev.clientY - rect.top) / rect.height;
      node.ratio = Math.min(0.9, Math.max(0.1, pos));
      this.applyRatio(node, a, b);
      if (!raf) raf = requestAnimationFrame(() => { raf = null; this.fitAll(); });
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      document.body.classList.remove("dragging-col", "dragging-row");
      this.fitAll();
      App.layoutChanged();
      if (this.focused) this.focused.term.focus();
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  }

  fitAll() {
    for (const s of this.sessions()) s.fitNow();
  }

  // -- focus -----------------------------------------------------------------------
  focus(session) {
    if (!session) return;
    this.focused = session;
    for (const s of this.sessions()) s.pane.classList.toggle("focused", s === session);
    session.term.focus();
    this.updateLabel();
  }

  // Move focus to the neighbouring pane in a direction ("left", "right", "up", "down").
  navigate(direction) {
    const from = this.focused;
    if (!from) return;
    const fr = from.pane.getBoundingClientRect();
    const fx = (fr.left + fr.right) / 2, fy = (fr.top + fr.bottom) / 2;
    let best = null, bestDist = Infinity;
    for (const s of this.sessions()) {
      if (s === from) continue;
      const r = s.pane.getBoundingClientRect();
      const cx = (r.left + r.right) / 2, cy = (r.top + r.bottom) / 2;
      const ok = direction === "left" ? r.right <= fr.left + 1 && cy > fr.top - 1 && cy < fr.bottom + 1
        : direction === "right" ? r.left >= fr.right - 1 && cy > fr.top - 1 && cy < fr.bottom + 1
        : direction === "up" ? r.bottom <= fr.top + 1 && cx > fr.left - 1 && cx < fr.right + 1
        : r.top >= fr.bottom - 1 && cx > fr.left - 1 && cx < fr.right + 1;
      if (!ok) continue;
      const d = Math.hypot(cx - fx, cy - fy);
      if (d < bestDist) { bestDist = d; best = s; }
    }
    if (best) this.focus(best);
  }

  // -- tab strip -------------------------------------------------------------------
  get title() {
    return (this.focused && this.focused.title) || "Terminal";
  }

  updateLabel() {
    this.titleEl.textContent = this.title;
    this.el.title = this.sessions().map((s) => s.title).join(" | ");
    const states = this.sessions().map((s) => s.status);
    this.statusEl.className = "status " +
      (states.includes("error") ? "error" : states.every((st) => st === "connected") ? "connected" : "");
    if (App.activeTab === this) document.title = this.title;
  }

  setActive(on) {
    this.root.classList.toggle("active", on);
    this.el.classList.toggle("active", on);
    if (on) {
      this.el.scrollIntoView({ inline: "nearest", block: "nearest" });
      this.updateLabel();
      requestAnimationFrame(() => this.fitAll());
    }
  }

  // -- persistence -----------------------------------------------------------------
  serialize() {
    const ser = (node) => {
      if (!node) return null;
      if (node.kind === "leaf") {
        return node.session.sessionId ? { s: node.session.sessionId, profile: node.session.profileId || "" } : null;
      }
      const a = ser(node.a), b = ser(node.b);
      if (a && b) return { dir: node.dir, ratio: node.ratio, a, b };
      return a || b;
    };
    const tree = ser(this.tree);
    return tree ? { tree } : null;
  }

  // Rebuild from serialize() output. `makeSession(id, profile)` returns a
  // Session for a live daemon session id, or null to drop that leaf.
  static deserialize(data, makeSession) {
    const build = (node) => {
      if (!node) return null;
      if (node.s) {
        const session = makeSession(node.s, node.profile);
        return session ? { kind: "leaf", session } : null;
      }
      const a = build(node.a), b = build(node.b);
      if (a && b) return { kind: "split", dir: node.dir === "col" ? "col" : "row", a, b, ratio: node.ratio || 0.5 };
      return a || b;
    };
    const tree = build(data && data.tree);
    if (!tree) return null;
    const tab = new Tab();
    tab.tree = tree;
    for (const s of tab.sessions()) s.tab = tab;
    tab.render();
    tab.focused = tab.sessions()[0];
    tab.focused.pane.classList.add("focused");
    tab.updateLabel();
    return tab;
  }
}
