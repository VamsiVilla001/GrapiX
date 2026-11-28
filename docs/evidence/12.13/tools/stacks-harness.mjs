// Throwaway verification harness for the Playout Stacks panel (claude-grapix-f1, 25 Nov 2026). Not part of the repo.
// Starts a static server on Playout/web, a headless Chrome of its own (own profile, own debug port, no OS input), injects a Tauri
// bridge stub that behaves like the shell+engine for stacks, drives the real page over CDP and asserts what an operator would see.
// Both child processes are ended by PID in `finally`.
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const WEB = path.resolve(process.argv[2]);
const OUT = path.resolve(process.argv[3]);
const HTTP_PORT = 8795;
const CDP_PORT = 9467;
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const watchdog = setTimeout(() => {
  console.error("watchdog: 150 s");
  process.exit(3);
}, 150000);

const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css", ".png": "image/png", ".woff2": "font/woff2" };
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const file = path.join(WEB, p === "/" ? "index.html" : p);
  if (!file.startsWith(WEB)) return void res.writeHead(403).end();
  fs.readFile(file, (error, body) => {
    if (error) return void res.writeHead(404).end("not found");
    res.writeHead(200, { "content-type": types[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-store" }).end(body);
  });
});
await new Promise((resolve) => server.listen(HTTP_PORT, "127.0.0.1", resolve));

const profile = path.join(OUT, "profile");
fs.mkdirSync(profile, { recursive: true });
const chrome = spawn(CHROME, [`--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, "--headless=new", "--window-size=1500,1000", "--no-first-run", "--disable-extensions", "about:blank"], { stdio: "ignore" });

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) });
};

try {
  let targets;
  for (let i = 0; i < 60; i += 1) {
    try {
      targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
      if (targets.some((t) => t.type === "page")) break;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  const page = targets.find((t) => t.type === "page");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error("websocket"));
  });
  let seq = 0;
  const waiting = new Map();
  const events = [];
  ws.onmessage = (message) => {
    const data = JSON.parse(message.data);
    if (data.id && waiting.has(data.id)) {
      waiting.get(data.id)(data);
      waiting.delete(data.id);
    } else if (data.method) events.push(data);
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => reject(new Error(`timeout ${method}`)), 20000);
      waiting.set(id, (reply) => {
        clearTimeout(timer);
        if (reply.error) reject(new Error(`${method}: ${reply.error.message}`));
        else resolve(reply.result);
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const ev = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`eval: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}\n${expression.slice(0, 200)}`);
    return r.result.value;
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const shot = async (name) => {
    const s = await send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(s.data, "base64"));
  };
  const centre = async (selector) => ev(`(() => { const n = document.querySelector(${JSON.stringify(selector)}); n.scrollIntoView({ block: 'center' }); const r = n.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  const press = async (selector, ms) => {
    const { x, y } = await centre(selector);
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await wait(ms);
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  };
  const click = (selector) => press(selector, 30);
  const type = async (selector, text) => {
    await ev(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); e.focus(); e.select(); })()`);
    await send("Input.insertText", { text });
  };
  const calls = () => ev("JSON.stringify(window.__sim.calls)").then(JSON.parse);
  const reset = () => ev("window.__sim.calls.length = 0");

  const STUB = fs.readFileSync(path.join(OUT, "stub.js"), "utf8");
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Page.addScriptToEvaluateOnNewDocument", { source: STUB });
  await send("Page.navigate", { url: `http://127.0.0.1:${HTTP_PORT}/index.html` });
  await wait(1800);
  check("viewport is wide enough for the desktop layout", (await ev("innerWidth")) >= 1180, await ev("innerWidth"));

  // ---- A: the table is drawn from the engine's list, front to back ------------------------------------------------------------
  const rowsText = () => ev(`JSON.stringify([...document.querySelectorAll("#stacksList tbody tr")].map((tr) => ({ stack: tr.dataset.stack, label: tr.querySelector(".stacks__pick").textContent, scene: tr.querySelector(".stacks__scene").textContent, then: tr.querySelector(".stacks__then").hidden ? "" : tr.querySelector(".stacks__then").textContent, chips: [...tr.querySelectorAll(".chip")].filter((c) => !c.hidden).map((c) => c.textContent), selected: tr.classList.contains("is-selected"), onair: tr.classList.contains("is-onair"), disabled: [...tr.querySelectorAll("button")].filter((b) => !b.classList.contains("stacks__pick")).map((b) => b.disabled) })))`).then(JSON.parse);
  let rows = await rowsText();
  check("connected and signed in: the page reads the status", (await ev("document.getElementById('connectionState').textContent")) === "CONNECTED", await ev("document.getElementById('connectionState').textContent"));
  check("rows are front to back: +60, 0, -50", rows.map((r) => r.label).join(",") === "+60,0,-50", rows.map((r) => r.label));
  check("stack 0 is selected at the start", rows.find((r) => r.stack === "0")?.selected === true);
  const r60 = rows.find((r) => r.stack === "60");
  check("a leaving scene with a queued replacement is one row with a second line", r60.scene.startsWith("old") && r60.then.startsWith("then new") && r60.then.includes("from frame 730"), r60);
  check("its chips say LEAVING and QUEUED", r60.chips.includes("LEAVING") && r60.chips.includes("QUEUED"), r60.chips);
  check("on-air rows are marked and have controls enabled; a leaving row has only Clear", rows.find((r) => r.stack === "0").onair && rows.find((r) => r.stack === "0").disabled.join() === "false,false,false" && r60.disabled.join() === "true,true,false", { zero: rows.find((r) => r.stack === "0").disabled, sixty: r60.disabled });
  await shot("a-initial");

  // ---- B: the Stack field -------------------------------------------------------------------------------------------------------
  await type("#stackInput", "+60");
  await wait(80);
  rows = await rowsText();
  check("typing +60 selects that row", rows.find((r) => r.stack === "60").selected && !rows.find((r) => r.stack === "0").selected);
  check("the note says where the next command goes", (await ev("document.getElementById('stackNote').textContent")).includes("stack +60"), await ev("document.getElementById('stackNote').textContent"));
  await type("#stackInput", "1.5");
  await wait(80);
  check("a fraction is refused by name, marked, and the table keeps the last valid stack", (await ev("document.getElementById('stackInput').getAttribute('aria-invalid')")) === "true" && (await ev("document.getElementById('stackNote').textContent")).includes("whole number") && (await rowsText()).find((r) => r.stack === "60").selected);
  await type("#stackInput", "100000");
  await wait(60);
  check("out of range says the range", (await ev("document.getElementById('stackNote').textContent")).includes("-99,999 to +99,999"));
  await type("#stackInput", "0");
  await ev("document.getElementById('stackInput').blur()");
  await click("#stackPlus");
  await wait(80);
  check("plus steps to +1 and adds an empty row marked as the Transport's target", (await ev("document.getElementById('stackInput').value")) === "+1" && (await rowsText()).some((r) => r.stack === "1" && r.scene === "empty" && r.selected), await ev("document.getElementById('stackInput').value"));
  await click("#stackMinus");
  await click("#stackMinus");
  await wait(60);
  check("minus twice reaches -1; the row for +1 is gone again", (await ev("document.getElementById('stackInput').value")) === "-1" && !(await rowsText()).some((r) => r.stack === "1"));
  await ev("document.getElementById('stackInput').focus()");
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 });
  check("ArrowUp steps the stack from the keyboard", (await ev("document.getElementById('stackInput').value")) === "0", await ev("document.getElementById('stackInput').value"));

  // ---- C: Transport buttons carry the stack; zero carries none --------------------------------------------------------------------
  await type("#takeIdInput", "scorebug");
  await type("#revisionInput", "2");
  await type("#hashInput", "d".repeat(64));
  await reset();
  await click("#takeButton");
  await wait(150);
  let c = await calls();
  check("TAKE on stack 0 sends no layer at all", c.length === 1 && c[0].command === "cmd_take" && !("layer" in c[0].args), c);
  await type("#stackInput", "+60");
  await reset();
  await click("#takeButton");
  await wait(150);
  c = await calls();
  check("TAKE on +60 sends layer 60", c.length === 1 && c[0].command === "cmd_take" && c[0].args.layer === 60 && c[0].args.takeId === "scorebug", c);
  check("a take onto an occupied stack shows both frames: the command and the new scene's start", (await ev("document.getElementById('commitNote').textContent")).includes("starts at frame 730") && (await ev("document.getElementById('commitHead').textContent")).includes("stack +60"), await ev("document.getElementById('commitNote').textContent"));
  await reset();
  await click("#cueButton");
  await wait(120);
  c = await calls();
  check("CUE on +60 sends layer 60", c[0]?.command === "cmd_cue" && c[0].args.layer === 60, c);
  await reset();
  await click("#outButton");
  await wait(120);
  c = await calls();
  check("TAKE OUT on +60 sends the out phase to layer 60", c[0]?.command === "cmd_phase" && c[0].args.phase === "out" && c[0].args.layer === 60, c);
  await type("#stackInput", "x");
  await reset();
  await click("#takeButton");
  await wait(120);
  c = await calls();
  check("an invalid stack sends nothing and says why in the activity log", c.length === 0 && (await ev("document.getElementById('logList').firstElementChild.textContent")).includes("not sent"), await ev("document.getElementById('logList').firstElementChild.textContent"));

  for (const [button, label] of [["#cueButton", "CUE"], ["#clearButton", "CLEAR"], ["#outButton", "TAKE OUT"], ["#holdButton", "HOLD"], ["#continueButton", "CONTINUE"], ["#updateButton", "UPDATE"]]) {
    await reset();
    await click(button);
    await wait(100);
    check(`an invalid stack stops ${label} too: nothing is sent`, (await calls()).length === 0, await calls());
  }

  // ---- D: the Transport's CLEAR -------------------------------------------------------------------------------------------------
  await type("#stackInput", "0");
  await reset();
  await click("#clearButton");
  await wait(150);
  c = await calls();
  check("CLEAR on stack 0 is what it always was: no layer, no expected page", c.length === 1 && c[0].command === "cmd_clear" && !("layer" in c[0].args) && !("expected" in c[0].args), c);
  await ev("window.__sim.reset()");
  await wait(700);
  await type("#stackInput", "-50");
  await reset();
  await click("#clearButton");
  await wait(150);
  c = await calls();
  check("CLEAR on -50 names the page the table shows", c.length === 1 && c[0].args.layer === -50 && c[0].args.expected?.takeId === "bumper" && c[0].args.expected?.revision === 1, c);
  await ev("window.__sim.reset()");
  await wait(700);
  await type("#stackInput", "+20");
  await reset();
  await click("#clearButton");
  await wait(150);
  c = await calls();
  check("CLEAR on a stack the table shows empty names no page; the engine answers for it", c.length === 1 && c[0].args.layer === 20 && !("expected" in c[0].args), c);
  await ev("window.__sim.reset()");
  await wait(700);

  // ---- E: the armed controls ----------------------------------------------------------------------------------------------------
  await reset();
  await press("tr[data-stack='0'] .btn--clear-row", 400);
  await wait(150);
  check("a hold released at 0.4 s sends nothing", (await calls()).length === 0);
  check("and the fill is back at nothing", (await ev("document.querySelector(\"tr[data-stack='0'] .btn--clear-row\").classList.contains('is-holding')")) === false);
  await press("tr[data-stack='0'] .btn--clear-row", 1250);
  await wait(250);
  c = await calls();
  check("a hold of one second sends one Clear that names the page the row showed", c.length === 1 && c[0].command === "cmd_clear" && !("layer" in c[0].args) && c[0].args.expected?.takeId === "l3" && c[0].args.expected?.revision === 4, c);
  check("the engine took stack 0 off and the row is empty on the next read", await (async () => { await wait(700); return (await rowsText()).find((r) => r.stack === "0")?.scene === "empty" || !(await rowsText()).some((r) => r.stack === "0" && r.onair); })());
  await ev("window.__sim.reset()");
  await wait(700);

  // a hold is not broken by the status read that happens every half second
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", ...(await centre("tr[data-stack='-50'] .btn--out")) });
  const outCentre = await centre("tr[data-stack='-50'] .btn--out");
  await ev("window.__marker = document.querySelector(\"tr[data-stack='-50'] .btn--out\")");
  await send("Input.dispatchMouseEvent", { type: "mousePressed", ...outCentre, button: "left", clickCount: 1 });
  await wait(1250); // two or three status reads happen in here
  const survived = await ev("window.__marker === document.querySelector(\"tr[data-stack='-50'] .btn--out\") && window.__marker.isConnected");
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", ...outCentre, button: "left", clickCount: 1 });
  await wait(200);
  c = await calls();
  check("the row's button is the same element after status reads, and the hold sent Out to -50", survived && c.some((x) => x.command === "cmd_phase" && x.args.phase === "out" && x.args.layer === -50), { survived, c });
  await ev("window.__sim.reset()");
  await wait(700);

  // the stack changes under the hold: the Clear still names the page that was shown, so the engine refuses and nothing is cleared
  await reset();
  const clearCentre = await centre("tr[data-stack='-50'] .btn--clear-row");
  await send("Input.dispatchMouseEvent", { type: "mousePressed", ...clearCentre, button: "left", clickCount: 1 });
  await wait(300);
  await ev("window.__sim.replace(-50, 'other', 9)");
  await wait(1100);
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", ...clearCentre, button: "left", clickCount: 1 });
  await wait(250);
  c = await calls();
  const refusedLine = await ev("document.getElementById('logList').firstElementChild.textContent");
  check("a scene replaced during the hold is refused by name and not cleared", c.some((x) => x.command === "cmd_clear" && x.args.expected.takeId === "bumper") && refusedLine.includes("clearExpectationUnmet") && refusedLine.includes("stack -50") && (await ev("window.__sim.status.layers.some((l) => l.layer === -50 && l.takeId === 'other')")), refusedLine);
  const resultText = await ev("document.getElementById('stacksResult').textContent");
  check("the refusal is also written in the Stacks panel, as a refusal, naming the stack", resultText.includes("clearExpectationUnmet") && resultText.includes("stack -50") && (await ev("document.getElementById('stacksResult').className")).includes("--refused"), resultText);
  check("a row is two lines tall, not three: its controls fit on one line", (await ev("document.querySelector(\"tr[data-stack='0']\").getBoundingClientRect().height")) < 62, await ev("document.querySelector(\"tr[data-stack='0']\").getBoundingClientRect().height"));
  await ev("window.__sim.reset()");
  await wait(700);

  // keyboard: Space held for a second sends once even though keydown repeats
  await reset();
  await ev("document.querySelector(\"tr[data-stack='60'] .btn--clear-row\").focus()");
  for (let i = 0; i < 4; i += 1) {
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: " ", code: "Space", windowsVirtualKeyCode: 32, autoRepeat: i > 0 });
    await wait(300);
  }
  await wait(150);
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: " ", code: "Space", windowsVirtualKeyCode: 32 });
  await wait(250);
  c = await calls();
  check("Space held one second sends one Clear, naming the leaving scene's page", c.filter((x) => x.command === "cmd_clear").length === 1 && c[0].args.layer === 60 && c[0].args.expected?.takeId === "old", c);
  await ev("window.__sim.reset()");
  await wait(700);

  // the pointer is dragged off the button during a hold: the hold ends, nothing is sent
  await reset();
  const dragFrom = await centre("tr[data-stack='0'] .btn--clear-row");
  await send("Input.dispatchMouseEvent", { type: "mousePressed", ...dragFrom, button: "left", clickCount: 1 });
  await wait(250);
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: dragFrom.x, y: dragFrom.y - 160, buttons: 1 });
  await wait(1200);
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: dragFrom.x, y: dragFrom.y - 160, button: "left", clickCount: 1 });
  await wait(150);
  check("a hold whose pointer is taken off the button sends nothing", (await calls()).length === 0, await calls());
  await ev("window.__sim.reset()");
  await wait(700);

  // focus leaves the button during a keyboard hold: the hold ends, nothing is sent
  await reset();
  await ev("document.querySelector(\"tr[data-stack='0'] .btn--clear-row\").focus()");
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: " ", code: "Space", windowsVirtualKeyCode: 32 });
  await wait(300);
  await ev("document.getElementById('stackInput').focus()");
  await wait(1200);
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: " ", code: "Space", windowsVirtualKeyCode: 32 });
  await wait(150);
  check("a keyboard hold whose button loses focus sends nothing", (await calls()).length === 0, await calls());
  await ev("window.__sim.reset()");
  await wait(700);

  // the operator signs out: every row control is disabled for real, with the status still on screen
  await click("#signInButton");
  await wait(250);
  const gated = await rowsText();
  check("signed out: the table still shows what is on air, and every row control is disabled", gated.some((r) => r.onair) && gated.every((r) => r.disabled.every(Boolean)), gated.map((r) => r.disabled));
  await reset();
  await press("tr[data-stack='0'] .btn--clear-row", 1250);
  await wait(200);
  check("and a hold on a disabled control sends nothing", (await calls()).length === 0, await calls());
  await ev("document.getElementById('operatorInput').readOnly = false");
  await type("#operatorInput", "Test Operator");
  await click("#signInButton");
  await wait(250);
  check("signed in again: the controls are back", (await rowsText()).find((r) => r.stack === "0").disabled.join() === "false,false,false");
  await ev("window.__sim.reset()");
  await wait(700);

  // Continue is a plain click on a row that is on air
  await reset();
  await click("tr[data-stack='0'] .btn--phase");
  await wait(150);
  c = await calls();
  check("Continue on the row sends the continue phase to its stack, none for stack 0", c.length === 1 && c[0].command === "cmd_phase" && c[0].args.phase === "continue" && !("layer" in c[0].args), c);

  // ---- F: not-built controls, selection by click, the sign-out gate, and a lost engine -------------------------------------------------
  const later = await ev("JSON.stringify([...document.querySelectorAll('.stacks__later button')].map((b) => [b.disabled, b.textContent.trim()]))").then(JSON.parse);
  check("the controls with no backend are dimmed and name their rows", later.length === 2 && later.every(([d]) => d) && later[0][1].includes("12.14") && later[1][1].includes("12.17"), later);
  await click("tr[data-stack='-50'] .stacks__col-scene");
  await wait(60);
  check("a click on a row selects its stack in the field", (await ev("document.getElementById('stackInput').value")) === "-50");
  await shot("b-selected");
  await ev("window.__sim.online = false");
  await wait(1200);
  const afterLoss = await rowsText();
  check("a lost engine clears the table: nothing is drawn from a status nobody reports", afterLoss.every((r) => r.scene === "empty") && afterLoss.length === 1 && (await ev("document.querySelector('.stacks__note').textContent")).includes("No engine status"), afterLoss);
  check("and every row control is disabled", afterLoss.every((r) => r.disabled.every(Boolean)));
  await shot("c-disconnected");

  // the target window
  await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });
  await ev("window.__sim.online = true; window.__sim.reset()");
  await wait(900);
  await ev("window.scrollTo(0,0); document.querySelector('.grid').scrollTop = 0");
  const m = await ev(`JSON.stringify(Object.fromEntries(["clockPanel","transportPanel","stacksPanel","logPanelTitle"].map((i) => { const r = document.getElementById(i).getBoundingClientRect(); return [i, [Math.round(r.top), Math.round(r.bottom)]]; })).constructor === Object ? { ...Object.fromEntries(["clockPanel","transportPanel","stacksPanel"].map((i) => { const r = document.getElementById(i).getBoundingClientRect(); return [i, [Math.round(r.top), Math.round(r.bottom)]]; })), log: (() => { const r = document.querySelector(".panel--log").getBoundingClientRect(); return [Math.round(r.top), Math.round(r.bottom)]; })(), program: (() => { const r = document.querySelector(".panel--program").getBoundingClientRect(); return [Math.round(r.top), Math.round(r.bottom)]; })(), viewport: [innerWidth, innerHeight], gridScroll: document.querySelector(".grid").scrollHeight - document.querySelector(".grid").clientHeight } : null)`).then(JSON.parse);
  check("layout at 1280x820 (measured, recorded)", true, m);
  await shot("e-1280x820");
  await send("Emulation.clearDeviceMetricsOverride");

  // narrow layout
  await send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 900, deviceScaleFactor: 1, mobile: false });
  await wait(300);
  await ev("window.__sim.online = true");
  await shot("d-narrow");
  await send("Emulation.clearDeviceMetricsOverride");

  const errors = events.filter((e) => e.method === "Runtime.exceptionThrown" || (e.method === "Runtime.consoleAPICalled" && e.params.type === "error")).map((e) => JSON.stringify(e.params).slice(0, 300));
  check("no script error or console.error during the whole run", errors.length === 0, errors);
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
  fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify(results, null, 1));
  console.log(JSON.stringify({ total: results.length, failed: failed.length, failures: failed }, null, 1));
  setTimeout(() => process.exit(failed.length === 0 ? 0 : 1), 300);
}
