// End-to-end test of extension/terminal.html in headless Chromium.
//
// The chrome.* extension APIs are stubbed inside the page; the stubbed native
// messaging port is bridged to a real host/terminal_host.py process, so this
// exercises the real UI code, the real xterm.js build and the real host.
//
//   npm i -g playwright   (or: npm i playwright)
//   node test/e2e_page_test.mjs
import { createServer } from "node:http";
import { readFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  ({ chromium } = require(path.join(process.env.NPM_GLOBAL_ROOT || "/opt/node22/lib/node_modules", "playwright")));
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXT = path.join(ROOT, "extension");
const HOST = path.join(ROOT, "host", "terminal_host.py");
const OUT = process.env.SCREENSHOT_DIR || path.join(ROOT, "test", "output");
await mkdir(OUT, { recursive: true });
const RUNTIME = await mkdtemp(path.join(os.tmpdir(), "tic-e2e-"));
const HOST_ENV = { ...process.env, TIC_RUNTIME_DIR: RUNTIME };
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png" };

const server = createServer(async (req, res) => {
  const file = path.join(EXT, decodeURIComponent(new URL(req.url, "http://x").pathname));
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404); res.end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

// ---- native host bridge -----------------------------------------------------
const hosts = new Map();
function startHost(portId, page) {
  const proc = spawn("python3", [HOST], { stdio: ["pipe", "pipe", "inherit"], env: HOST_ENV });
  let buf = Buffer.alloc(0);
  proc.stdout.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4) {
      const len = buf.readUInt32LE(0);
      if (buf.length < 4 + len) break;
      const msg = JSON.parse(buf.subarray(4, 4 + len).toString("utf8"));
      buf = buf.subarray(4 + len);
      page.evaluate(([id, m]) => window.__deliver(id, m), [portId, msg]).catch(() => {});
    }
  });
  proc.on("exit", () => {
    hosts.delete(portId);
    page.evaluate((id) => window.__disconnected(id), portId).catch(() => {});
  });
  hosts.set(portId, proc);
}

// Talk to the daemon through a throwaway host process (no browser involved).
function hostRequest(messages, wantType) {
  return new Promise((resolve, reject) => {
    const proc = spawn("python3", [HOST], { stdio: ["pipe", "pipe", "inherit"], env: HOST_ENV });
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => { proc.kill(); reject(new Error("hostRequest timeout")); }, 5000);
    proc.stdout.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 4) {
        const len = buf.readUInt32LE(0);
        if (buf.length < 4 + len) break;
        const msg = JSON.parse(buf.subarray(4, 4 + len).toString("utf8"));
        buf = buf.subarray(4 + len);
        if (msg.type === wantType) { clearTimeout(timer); proc.stdin.end(); resolve(msg); }
      }
    });
    for (const m of messages) {
      const payload = Buffer.from(JSON.stringify(m), "utf8");
      const header = Buffer.alloc(4); header.writeUInt32LE(payload.length, 0);
      proc.stdin.write(Buffer.concat([header, payload]));
    }
  });
}
const listSessions = async () => (await hostRequest([{ type: "list" }], "sessions")).sessions;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1000, height: 600 } });
page.on("pageerror", (e) => { console.error("PAGE ERROR:", e); process.exitCode = 1; });
page.on("console", (m) => { if (m.type() === "error") console.error("console.error:", m.text()); });

await page.exposeFunction("__hostConnect", (portId) => startHost(portId, page));
await page.exposeFunction("__hostSend", (portId, msg) => {
  const proc = hosts.get(portId);
  if (!proc) return;
  const payload = Buffer.from(JSON.stringify(msg), "utf8");
  const header = Buffer.alloc(4); header.writeUInt32LE(payload.length, 0);
  proc.stdin.write(Buffer.concat([header, payload]));
});
await page.exposeFunction("__hostDisconnect", (portId) => {
  const proc = hosts.get(portId);
  if (proc) proc.stdin.end();
});

await page.addInitScript(() => {
  const ports = new Map();
  let nextPort = 1;
  const store = {};
  const listeners = (list) => ({ addListener: (fn) => list.push(fn), removeListener: () => {} });
  window.__deliver = (id, msg) => { const p = ports.get(id); if (p) p._onMessage.forEach((fn) => fn(msg)); };
  window.__disconnected = (id) => { const p = ports.get(id); if (p) { ports.delete(id); p._onDisconnect.forEach((fn) => fn()); } };
  window.__openedUrls = [];
  window.chrome = {
    runtime: {
      id: "njljokdmmbkdlmllndefhngkjcdgllma",
      lastError: undefined,
      getURL: (p) => location.origin + "/" + p,
      openOptionsPage: () => {},
      connectNative(name) {
        if (name !== "com.terminal_in_chrome.host") throw new Error("bad host name " + name);
        const id = nextPort++;
        const port = {
          _onMessage: [], _onDisconnect: [],
          postMessage: (m) => window.__hostSend(id, m),
          disconnect: () => { ports.delete(id); window.__hostDisconnect(id); },
        };
        port.onMessage = listeners(port._onMessage);
        port.onDisconnect = listeners(port._onDisconnect);
        ports.set(id, port);
        window.__hostConnect(id);
        return port;
      },
    },
    tabs: { create: ({ url }) => window.__openedUrls.push(url) },
    storage: {
      sync: {
        get: (defaults, cb) => cb({ ...defaults, ...store }),
        set: (items, cb) => { Object.assign(store, items); cb && cb(); },
      },
      onChanged: listeners([]),
    },
  };
});

// Read the active terminal's screen + scrollback through xterm's buffer API
// (the WebGL renderer draws to a canvas, so there is no text in the DOM).
const bufferLines = () => page.evaluate(() => {
  const s = window.terminalInChrome && window.terminalInChrome.active;
  if (!s) return [];
  const buf = s.term.buffer.active;
  const lines = [];
  for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i).translateToString(true));
  return lines;
});

async function waitForText(text, timeout = 8000) {
  await page.waitForFunction((t) => {
    const s = window.terminalInChrome && window.terminalInChrome.active;
    if (!s) return false;
    const buf = s.term.buffer.active;
    for (let i = 0; i < buf.length; i++) {
      if (buf.getLine(i).translateToString(true).includes(t)) return true;
    }
    return false;
  }, text, { timeout });
}

const findSizeLine = async () => (await bufferLines()).find((r) => /^\d+ \d+\s*$/.test(r.trim())).trim();

let failed = false;
try {
  await page.goto(`${base}/terminal.html`);
  await page.waitForSelector(".tab .status.connected", { timeout: 8000 });
  console.log("✓ shell spawned and reported ready");

  await page.keyboard.type("echo E2E_$((40+2)); stty size; echo $TERM");
  await page.keyboard.press("Enter");
  await waitForText("E2E_42");
  await waitForText("xterm-256color");
  console.log("✓ command output rendered in xterm");

  const dims = await findSizeLine();
  console.log("  shell reports window size:", dims);

  // Resize the viewport and check the pty follows.
  await page.setViewportSize({ width: 600, height: 400 });
  await page.waitForTimeout(300);
  await page.keyboard.type("clear; stty size; echo RE\"\"SIZED");
  await page.keyboard.press("Enter");
  await waitForText("RESIZED");
  const after = await findSizeLine();
  if (after === dims) throw new Error("pty size did not change after viewport resize: " + after);
  console.log("✓ resize propagated to pty:", dims, "->", after);

  // Second tab via the + button, then close it.
  await page.click("#new-tab");
  await page.waitForFunction(() => document.querySelectorAll(".tab").length === 2);
  await page.waitForFunction(() => document.querySelectorAll(".tab .status.connected").length === 2, null, { timeout: 8000 });
  console.log("✓ second tab spawned its own shell");
  await page.click(".tab.active .close");
  await page.waitForFunction(() => document.querySelectorAll(".tab").length === 1);
  console.log("✓ closing a tab works");

  // Exit the shell -> overlay appears, reconnect works.
  await page.keyboard.type("exit 7");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".pane.active .overlay:not(.hidden)", { timeout: 8000 });
  const overlayText = await page.textContent(".pane.active .overlay-detail");
  if (!overlayText.includes("code 7")) throw new Error("overlay did not report exit code: " + overlayText);
  console.log("✓ exit overlay shown with exit code");
  await page.click(".pane.active .overlay-retry");
  await page.waitForSelector(".pane.active .overlay.hidden", { state: "attached", timeout: 8000 });
  await page.waitForSelector(".tab .status.connected", { timeout: 8000 });
  await page.keyboard.type("echo BACK_\"\"AGAIN");
  await page.keyboard.press("Enter");
  await waitForText("BACK_AGAIN");
  console.log("✓ reconnect after exit works");

  // Persistence: the shell survives a page reload and its output is replayed.
  await page.keyboard.type('PERSIST=yes; cd /tmp; echo PERSIST_""MARK');
  await page.keyboard.press("Enter");
  await waitForText("PERSIST_MARK");
  let list = await listSessions();
  if (list.length !== 1 || !list[0].attached) throw new Error("expected 1 attached session, got " + JSON.stringify(list));
  await page.reload();
  await page.waitForSelector(".tab .status.connected", { timeout: 8000 });
  await page.waitForFunction(() => document.querySelectorAll(".tab").length === 1);
  await waitForText("PERSIST_MARK"); // replayed scrollback
  await page.keyboard.type('echo $PERSIST-$(pwd)-RE""ATTACHED');
  await page.keyboard.press("Enter");
  await waitForText("yes-/tmp-REATTACHED");
  list = await listSessions();
  if (list.length !== 1) throw new Error("reload must re-attach, not spawn: " + JSON.stringify(list));
  console.log("✓ shell survived page reload and was re-attached with replay");

  await page.screenshot({ path: path.join(OUT, "e2e-screenshot.png") });

  // Find bar (Cmd+F) finds text in the scrollback.
  await page.keyboard.press("Meta+f");
  await page.waitForSelector(".pane.active .findbar:not(.hidden)");
  await page.keyboard.type("PERSIST_MARK");
  await page.waitForFunction(() => /^1\/\d+$/.test(document.querySelector(".pane.active .find-count").textContent));
  await page.keyboard.press("Escape");
  await page.waitForSelector(".pane.active .findbar.hidden", { state: "attached" });
  console.log("✓ find bar works");

  // Closing the tab with × kills the shell in the daemon.
  await page.click(".tab.active .close");
  await new Promise((r) => setTimeout(r, 800));
  list = await listSessions();
  if (list.length !== 0) throw new Error("closing the tab should kill the shell: " + JSON.stringify(list));
  console.log("✓ closing a tab kills its shell");
  console.log("ALL E2E TESTS PASSED");
} catch (err) {
  failed = true;
  console.error("E2E FAILED:", err);
  await page.screenshot({ path: path.join(OUT, "e2e-failure.png") }).catch(() => {});
} finally {
  await browser.close();
  for (const p of hosts.values()) p.kill();
  server.close();
  try {
    for (const s of await listSessions()) await hostRequest([{ type: "kill", session: s.session }, { type: "list" }], "sessions");
  } catch {}
  await rm(RUNTIME, { recursive: true, force: true });
}
process.exit(failed || process.exitCode ? 1 : 0);
