// Loads the real unpacked extension into Chromium with the real native
// messaging host registered, then drives it like a user would. Nothing is
// stubbed: chrome.runtime.connectNative, the manifest key (extension ID),
// the extension CSP, the service worker and storage are all Chrome's own.
//
// Linux only (Chromium reads <user-data-dir>/NativeMessagingHosts there);
// on macOS use install.sh and a normal Chrome instead.
//
//   node test/real_extension_test.mjs
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require("playwright")); }
catch { ({ chromium } = require(path.join(process.env.NPM_GLOBAL_ROOT || "/opt/node22/lib/node_modules", "playwright"))); }

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXT = path.join(ROOT, "extension");
const HOST = path.join(ROOT, "host", "terminal_host.py");
const EXPECTED_ID = "njljokdmmbkdlmllndefhngkjcdgllma";
const OUT = process.env.SCREENSHOT_DIR || path.join(ROOT, "test", "output");
await mkdir(OUT, { recursive: true });

const tmp = await mkdtemp(path.join(os.tmpdir(), "tic-real-"));
const userData = path.join(tmp, "profile");
const runtime = path.join(tmp, "runtime");
await mkdir(path.join(userData, "NativeMessagingHosts"), { recursive: true });
await mkdir(runtime, { recursive: true });

// Same shape as what install.sh writes on macOS.
const launcher = path.join(tmp, "run_host.sh");
await writeFile(launcher, `#!/bin/sh\nTIC_RUNTIME_DIR='${runtime}' exec python3 '${HOST}'\n`, { mode: 0o755 });
await writeFile(path.join(userData, "NativeMessagingHosts", "com.terminal_in_chrome.host.json"), JSON.stringify({
  name: "com.terminal_in_chrome.host",
  description: "Terminal in Chrome native messaging host",
  path: launcher,
  type: "stdio",
  allowed_origins: [`chrome-extension://${EXPECTED_ID}/`],
}, null, 2));

function makePng(w, h) {
  const rows = [];
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * 3);
    for (let x = 0; x < w; x++) {
      const d = Math.hypot(x - w / 2, y - h / 2) / (h / 2);
      row[1 + x * 3] = d < 1 ? 240 : 30;
      row[2 + x * 3] = d < 1 ? 136 : 30;
      row[3 + x * 3] = d < 1 ? 62 : 40;
    }
    rows.push(row);
  }
  const chunk = (tag, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(tag), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from("\x89PNG\r\n\x1a\n", "latin1"), chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0))]);
}
const pngPath = path.join(tmp, "circle.png");
await writeFile(pngPath, makePng(120, 120));

const context = await chromium.launchPersistentContext(userData, {
  channel: "chromium",   // full Chromium in new headless mode: extensions work
  headless: true,
  viewport: { width: 1100, height: 640 },
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});

const errors = [];
const watch = (page) => {
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
};

const bufferHas = (page, index, text) => page.evaluate(([i, t]) => {
  const s = window.terminalInChrome.sessions[i];
  if (!s) return false;
  const buf = s.term.buffer.active;
  for (let y = 0; y < buf.length; y++) if (buf.getLine(y).translateToString(true).includes(t)) return true;
  return false;
}, [index, text]);
async function waitText(page, index, text, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await bufferHas(page, index, text)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`pane ${index} never showed ${JSON.stringify(text)}`);
}

let failed = false;
try {
  // 1. The extension loads with the fixed ID from the manifest key.
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: 10000 });
  const id = new URL(worker.url()).host;
  if (id !== EXPECTED_ID) throw new Error(`extension ID ${id}, expected ${EXPECTED_ID}`);
  console.log("✓ extension loaded, ID", id, "(fixed by the manifest key)");

  // 2. First install opens a terminal tab by itself (background.js onInstalled).
  const termUrl = `chrome-extension://${id}/terminal.html`;
  let page = context.pages().find((p) => p.url().startsWith(termUrl));
  if (!page) page = await context.waitForEvent("page", { predicate: (p) => p.url().startsWith(termUrl), timeout: 10000 });
  watch(page);
  await page.bringToFront();
  await page.waitForFunction(() => window.terminalInChrome && window.terminalInChrome.active &&
    window.terminalInChrome.active.status === "connected", null, { timeout: 15000 });
  const info = await page.evaluate(() => window.terminalInChrome.active.shellInfo);
  console.log("✓ install opened a terminal tab; shell", info.shell, "pid", info.pid, "via real connectNative");

  // 3. Typing runs commands in a real login shell.
  await page.click(".workspace.active .pane.focused .term");
  await page.keyboard.type("echo REAL_$((6*7)) $TERM_PROGRAM");
  await page.keyboard.press("Enter");
  await waitText(page, 0, "REAL_42 terminal-in-chrome");
  console.log("✓ keyboard input and output round trip");

  // 4. imgcat draws an image (image addon under the real extension CSP).
  await page.keyboard.type(`imgcat -W 12 ${pngPath}; echo IMG_""OK`);
  await page.keyboard.press("Enter");
  await waitText(page, 0, "IMG_OK");
  await page.waitForFunction(() => {
    const s = window.terminalInChrome.active, buf = s.term.buffer.active;
    for (let y = 0; y < buf.length; y++) for (let x = 0; x < s.term.cols; x++) if (s.images.getImageAtBufferCell(x, y)) return true;
    return false;
  }, null, { timeout: 10000 });
  await page.keyboard.type("printf '\\033Pq#0;2;20;60;100#0!60~-!60~-!60~\\033\\\\'; echo; echo SIXEL_\"\"OK");
  await page.keyboard.press("Enter");
  await waitText(page, 0, "SIXEL_OK");
  await page.waitForFunction(() => {
    const s = window.terminalInChrome.active, buf = s.term.buffer.active;
    let rows = new Set();
    for (let y = 0; y < buf.length; y++) for (let x = 0; x < s.term.cols; x++) if (s.images.getImageAtBufferCell(x, y)) rows.add(y);
    return rows.size >= 2 && [...rows].some((y) => buf.getLine(y).translateToString(true).trim() === "");
  }, null, { timeout: 10000 });
  console.log("✓ inline images: imgcat (iTerm2 protocol) and sixel (wasm decoder allowed by CSP)");

  // 5. Split + broadcast with real ports.
  await page.keyboard.press("Control+Shift+D");
  await page.waitForFunction(() => window.terminalInChrome.sessions.length === 2 &&
    window.terminalInChrome.sessions.every((s) => s.status === "connected"), null, { timeout: 15000 });
  await page.keyboard.press("Control+Shift+B");
  await page.keyboard.type("echo BOTH_$((1+1))");
  await page.keyboard.press("Enter");
  await waitText(page, 0, "BOTH_2");
  await waitText(page, 1, "BOTH_2");
  console.log("✓ split pane + broadcast input reached both shells");
  await page.screenshot({ path: path.join(OUT, "real-extension.png") });
  await page.keyboard.press("Control+Shift+B");
  await page.keyboard.press("Control+Shift+B"); // all -> off

  // 6. Close the browser tab and reopen: shells and layout come back.
  const pids = await page.evaluate(() => window.terminalInChrome.sessions.map((s) => s.shellInfo.pid));
  await page.close();
  page = await context.newPage();
  watch(page);
  await page.goto(termUrl);
  await page.waitForFunction(() => window.terminalInChrome && window.terminalInChrome.sessions.length === 2 &&
    window.terminalInChrome.sessions.every((s) => s.status === "connected"), null, { timeout: 15000 });
  const pidsAfter = await page.evaluate(() => window.terminalInChrome.sessions.map((s) => s.shellInfo.pid));
  if (pidsAfter.slice().sort().join() !== pids.slice().sort().join()) throw new Error(`shells changed: ${pids} -> ${pidsAfter}`);
  await waitText(page, 0, "BOTH_2");
  console.log("✓ closed and reopened the tab: same shells (pids", pidsAfter.join(", ") + "), split layout and output restored");

  // 7. Options page: "Test connection" talks to the real host.
  const opts = await context.newPage();
  watch(opts);
  await opts.goto(`chrome-extension://${id}/options.html`);
  await opts.click("#test-host");
  await opts.waitForFunction(() => document.getElementById("host-status").textContent.startsWith("✓"), null, { timeout: 10000 });
  console.log("✓ options page:", await opts.textContent("#host-status"));

  // 8. Side panel page works with the same host.
  const panel = await context.newPage();
  watch(panel);
  await panel.goto(`chrome-extension://${id}/panel.html`);
  await panel.waitForFunction(() => window.terminalInChrome && window.terminalInChrome.active &&
    window.terminalInChrome.active.status === "connected", null, { timeout: 15000 });
  console.log("✓ side panel page connects (", await panel.evaluate(() => window.terminalInChrome.sessions.length), "pane )");

  const real = errors.filter((e) => !/favicon/.test(e));
  if (real.length) throw new Error("errors in extension pages:\n  " + real.join("\n  "));
  console.log("ALL REAL-EXTENSION TESTS PASSED");
} catch (err) {
  failed = true;
  console.error("REAL-EXTENSION TEST FAILED:", err);
  for (const p of context.pages()) {
    if (p.url().startsWith("chrome-extension://")) {
      await p.screenshot({ path: path.join(OUT, "real-extension-failure.png") }).catch(() => {});
    }
  }
  if (errors.length) console.error("page errors:\n  " + errors.join("\n  "));
} finally {
  await context.close();
  // Stop the isolated daemon; closing its pty masters hangs up the shells.
  try {
    const log = await (await import("node:fs/promises")).readFile(path.join(runtime, "daemon.log"), "utf8");
    for (const m of log.matchAll(/listening on .* \(pid (\d+)\)/g)) {
      try { process.kill(Number(m[1]), "SIGTERM"); } catch {}
    }
  } catch {}
  await new Promise((r) => setTimeout(r, 500));
  await rm(tmp, { recursive: true, force: true }).catch(() => {});
}
process.exit(failed ? 1 : 0);
