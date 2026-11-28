// Real-browser check of the Settings window (claude-grapix-f1, 25 Nov 2026). Not part of the repo.
// A static server (the scratch page + the real Editor/web stylesheets), a headless Chrome of its own (own profile and port), page-level input only.
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const HERE = path.resolve(process.argv[2]);
const WEB = path.resolve(process.argv[3]);
const HTTP_PORT = 8796;
const CDP_PORT = 9469;
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const watchdog = setTimeout(() => {
  console.error("watchdog 120 s");
  process.exit(3);
}, 120000);
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css", ".png": "image/png", ".woff2": "font/woff2" };
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const own = ["/", "/index.html", "/bundle.js"].includes(p);
  const file = path.join(own ? HERE : WEB, p === "/" ? "index.html" : p);
  fs.readFile(file, (e, body) => (e ? res.writeHead(404).end("nf") : res.writeHead(200, { "content-type": types[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-store" }).end(body)));
});
await new Promise((r) => server.listen(HTTP_PORT, "127.0.0.1", r));
const profile = path.join(HERE, "profile");
fs.mkdirSync(profile, { recursive: true });
const chrome = spawn(CHROME, [`--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, "--headless=new", "--window-size=1440,900", "--no-first-run", "--disable-extensions", "about:blank"], { stdio: "ignore" });
const results = [];
const check = (name, ok, detail) => results.push({ name, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  let targets;
  for (let i = 0; i < 60; i += 1) {
    try {
      targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
      if (targets.some((t) => t.type === "page")) break;
    } catch {
      /* not up yet */
    }
    await wait(250);
  }
  const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error("ws"));
  });
  let seq = 0;
  const waiting = new Map();
  const events = [];
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && waiting.has(d.id)) {
      waiting.get(d.id)(d);
      waiting.delete(d.id);
    } else if (d.method) events.push(d);
  };
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const id = ++seq;
      const t = setTimeout(() => rej(new Error(`timeout ${method}`)), 20000);
      waiting.set(id, (r) => {
        clearTimeout(t);
        if (r.error) rej(new Error(`${method}: ${r.error.message}`));
        else res(r.result);
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const ev = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`eval: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  };
  const shot = async (name) => fs.writeFileSync(path.join(HERE, `${name}.png`), Buffer.from((await send("Page.captureScreenshot", { format: "png" })).data, "base64"));
  const centre = (sel) => ev(`(() => { const n = document.querySelector(${JSON.stringify(sel)}); n.scrollIntoView({ block: "center" }); const r = n.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  const click = async (sel) => {
    const { x, y } = await centre(sel);
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await wait(30);
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  };
  const type = async (sel, text) => {
    await ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.focus(); e.select(); })()`);
    await send("Input.insertText", { text });
  };
  const key = async (k, code, vk) => {
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, windowsVirtualKeyCode: vk });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk });
  };
  const visible = (sel) => ev(`(() => { const n = document.querySelector(${JSON.stringify(sel)}); if (!n) return null; const r = n.getBoundingClientRect(); return getComputedStyle(n).display !== "none" && r.width > 0 && r.height > 0; })()`);

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Log.enable");
  await send("Page.navigate", { url: `http://127.0.0.1:${HTTP_PORT}/index.html` });
  await wait(1500);
  const expected = await ev("window.__expected");

  check("the dialog is open and the viewport is the desktop one", (await ev("document.getElementById('settings-dialog').open")) === true && (await ev("innerWidth")) >= 1300, await ev("innerWidth"));
  const tabs = await ev("JSON.stringify([...document.querySelectorAll('[role=tab]')].map((t) => [t.textContent, t.getAttribute('aria-selected'), t.className.includes('is-soon')]))").then(JSON.parse);
  check("the nav lists General, Shortcuts and AI and MCP access; General is selected; only the AI entry is dimmed", JSON.stringify(tabs) === JSON.stringify([["General", "true", false], ["Shortcuts", "false", false], ["AI and MCP access", "false", true]]), tabs);
  const dialogBox = await ev("(() => { const r = document.getElementById('settings-dialog').getBoundingClientRect(); return { w: Math.round(r.width), top: Math.round(r.top), bottom: Math.round(r.bottom), h: innerHeight }; })()");
  check("the dialog is as wide as the design's (up to 1160) and fits the window", dialogBox.w >= 1000 && dialogBox.w <= 1160 && dialogBox.top >= 0 && dialogBox.bottom <= dialogBox.h, dialogBox);

  check("General holds the two sections and every setting of the contract", (await ev("document.querySelectorAll('#settings-page-general .settings-section h3').length")) === 2 && (await ev("document.querySelectorAll('#settings-page-general .settings-row').length")) === expected.fields, expected);
  check("General shows the lead and both reset buttons", (await visible("#settings-lead")) && (await visible("#settings-reset-user")) && (await visible("#settings-reset-machine")));
  const hGeneral = await ev("Math.round(document.getElementById('settings-dialog').getBoundingClientRect().height)");
  await shot("g1-general");

  await click("#settings-tab-shortcuts");
  await wait(150);
  check("Shortcuts is shown and General is hidden", (await visible("#settings-page-shortcuts")) === true && (await visible("#settings-page-general")) === false);
  check("the lead and the reset buttons belong to General and are hidden with it", !(await visible("#settings-lead")) && !(await visible("#settings-reset-user")) && !(await visible("#settings-reset-machine")) && (await visible("#settings-close")));
  check("one row per command of the Editor's table", (await ev("document.querySelectorAll('.settings-keys-row').length")) === expected.commands, expected);
  const summary = await ev("document.querySelector('.settings-keys-summary').textContent");
  check("the line under the table counts the commands and keys and says no key is shared", summary === `${expected.commands} commands, ${expected.keys} keys. No two commands share a key.`, summary);
  check("no clash chip is drawn for the Editor's own table", (await ev("document.querySelectorAll('.settings-clash').length")) === 0);
  const hShortcuts = await ev("Math.round(document.getElementById('settings-dialog').getBoundingClientRect().height)");
  await shot("g2-shortcuts");

  await type("#settings-shortcut-search", "ctrl s");
  await wait(100);
  const found = await ev("JSON.stringify([...document.querySelectorAll('.settings-keys-row')].map((r) => [r.dataset.command, r.querySelector('.settings-keys-label').textContent, [...r.querySelectorAll('kbd')].map((k) => k.textContent)]))").then(JSON.parse);
  check("typing 'ctrl s' finds Save on Ctrl S and not Ctrl Shift S", found.length === 1 && found[0][0] === "file.save" && found[0][2].join() === "Ctrl S", found);
  await shot("g3-search");
  await type("#settings-shortcut-search", "zzzz");
  await wait(100);
  check("a search that matches nothing says so", (await ev("document.querySelector('.settings-keys-empty').textContent")).includes('No command or key matches "zzzz"'));
  await type("#settings-shortcut-search", "pen");
  await wait(100);
  const pen = await ev("JSON.stringify([...document.querySelectorAll('.settings-keys-row')].filter((r) => r.dataset.command === 'edit.pen').map((r) => [...r.querySelectorAll('kbd')].map((k) => k.textContent)))").then(JSON.parse);
  check("a command with two keys shows both on one row (the Pen: G and P)", JSON.stringify(pen) === JSON.stringify([["G", "P"]]), pen);
  await type("#settings-shortcut-search", "");
  await wait(100);
  check("clearing the search brings every command back", (await ev("document.querySelectorAll('.settings-keys-row').length")) === expected.commands);
  check("nothing on the page can be edited: the search is the only control in the Shortcuts panel", (await ev("JSON.stringify([...document.querySelectorAll('#settings-page-shortcuts input, #settings-page-shortcuts button, #settings-page-shortcuts select')].map((n) => n.tagName + ':' + n.type))")) === '["INPUT:search"]');
  const pagesBox = await ev("(() => { const p = document.querySelector('.settings-pages'); const c = document.getElementById('settings-close').getBoundingClientRect(); return { scrolls: p.scrollHeight > p.clientHeight, closeBottom: Math.round(c.bottom), h: innerHeight }; })()");
  check("the long table scrolls inside the page and the Close button stays on screen", pagesBox.scrolls && pagesBox.closeBottom <= pagesBox.h, pagesBox);

  await ev("document.getElementById('settings-tab-shortcuts').focus()");
  await key("ArrowDown", "ArrowDown", 40);
  await wait(80);
  check("ArrowDown on the Shortcuts tab selects AI and MCP access and moves focus to it", (await ev("document.activeElement.id")) === "settings-tab-ai" && (await ev("document.getElementById('settings-tab-ai').getAttribute('aria-selected')")) === "true");
  check("tabindex follows the selection (only the shown tab is in the tab order)", (await ev("JSON.stringify([...document.querySelectorAll('[role=tab]')].map((t) => t.getAttribute('tabindex')))")) === '["-1","-1","0"]');
  const ai = await ev("document.getElementById('settings-page-ai').textContent");
  check("the AI page says it is not built, names row 8.14, and states the rule that no role can cue or clear", ai.includes("Not built yet (row 8.14).") && ai.includes("no role can cue, take out, clear or change what is on air"), ai.slice(0, 160));
  check("and draws no role table, token field or audit button", (await ev("document.querySelectorAll('#settings-page-ai table, #settings-page-ai input, #settings-page-ai button').length")) === 0);
  const colours = await ev("JSON.stringify([getComputedStyle(document.getElementById('settings-tab-general')).color, getComputedStyle(document.getElementById('settings-tab-ai')).color])").then(JSON.parse);
  check("the waiting entry is dimmer than a built one", colours[0] !== colours[1], colours);
  const hAi = await ev("Math.round(document.getElementById('settings-dialog').getBoundingClientRect().height)");
  check("the dialog is the same height on every page, so it does not jump", hGeneral === hShortcuts && hShortcuts === hAi, { hGeneral, hShortcuts, hAi });
  await shot("g4-ai");
  await key("Home", "Home", 36);
  await wait(80);
  check("Home returns to General, whose lead and reset buttons come back", (await visible("#settings-page-general")) === true && (await visible("#settings-lead")) === true && (await visible("#settings-reset-user")) === true);

  await send("Emulation.setDeviceMetricsOverride", { width: 1000, height: 700, deviceScaleFactor: 1, mobile: false });
  await wait(250);
  await click("#settings-tab-shortcuts");
  await wait(150);
  const narrow = await ev("(() => { const d = document.getElementById('settings-dialog').getBoundingClientRect(); const c = document.getElementById('settings-close').getBoundingClientRect(); return { dialogRight: Math.round(d.right), dialogBottom: Math.round(d.bottom), closeBottom: Math.round(c.bottom), w: innerWidth, h: innerHeight }; })()");
  check("at 1000 by 700 the dialog stays inside the window and Close stays on screen", narrow.dialogRight <= narrow.w && narrow.dialogBottom <= narrow.h && narrow.closeBottom <= narrow.h, narrow);
  await shot("g5-narrow");
  await send("Emulation.clearDeviceMetricsOverride");

  const errors = events.filter((e) => e.method === "Runtime.exceptionThrown" || (e.method === "Log.entryAdded" && e.params.entry.level === "error" && !String(e.params.entry.url).endsWith("/favicon.ico")) || (e.method === "Runtime.consoleAPICalled" && e.params.type === "error")).map((e) => JSON.stringify(e.params).slice(0, 300));
  check("no script error, console error or failed request", errors.length === 0, errors);
  ws.close();
} catch (error) {
  check("the harness itself ran", false, String(error?.stack ?? error));
} finally {
  clearTimeout(watchdog);
  try {
    chrome.kill();
  } catch {
    /* gone */
  }
  server.close();
  const failed = results.filter((r) => !r.ok);
  fs.writeFileSync(path.join(HERE, "results.json"), JSON.stringify(results, null, 1));
  console.log(JSON.stringify({ total: results.length, failed: failed.length, failures: failed }, null, 1));
  setTimeout(() => process.exit(failed.length === 0 ? 0 : 1), 300);
}
