// Real Tauri window check of the Playout Stacks panel (claude-grapix-f1, 25 Nov 2026). Not part of the repo.
// Starts gx-mock-engine on the default port 4400 (checked free) and a Playout shell built with a debug port, drives the page through
// DevTools only (page-level input, no OS key or click), asserts, then ends exactly the two PIDs it started.
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

const TARGET = "D:/Project KK/cargo-target-f1/debug";
const OUT = path.resolve(process.argv[2]);
const CDP_PORT = 9468;
const HASH = "d".repeat(64);
const watchdog = setTimeout(() => {
  console.error("watchdog: 170 s");
  process.exit(3);
}, 170000);

const results = [];
const check = (name, ok, detail) => results.push({ name, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const free = (port) =>
  new Promise((resolve) => {
    const s = net.connect({ port, host: "127.0.0.1" });
    s.setTimeout(500);
    s.on("connect", () => {
      s.destroy();
      resolve(false);
    });
    s.on("timeout", () => {
      s.destroy();
      resolve(true);
    });
    s.on("error", () => resolve(true));
  });

for (const port of [4400, CDP_PORT]) {
  if (!(await free(port))) {
    console.error(`port ${port} is in use: not starting anything`);
    process.exit(2);
  }
}

const scratch = path.join(OUT, "real");
fs.rmSync(scratch, { recursive: true, force: true });
fs.mkdirSync(path.join(scratch, "logs"), { recursive: true });
fs.mkdirSync(path.join(scratch, "webview"), { recursive: true });
const engineOut = fs.openSync(path.join(scratch, "engine.out"), "w");
const shellOut = fs.openSync(path.join(scratch, "shell.out"), "w");

const engine = spawn(path.join(TARGET, "gx-mock-engine.exe"), ["--port", "4400", "--genlocked", "--publish", `bug:1:${HASH}`], { stdio: ["ignore", engineOut, engineOut] });
const pids = { engine: engine.pid };
let shell;

try {
  for (let i = 0; i < 40 && (await free(4400)); i += 1) await wait(250);
  check("the mock engine is listening on 4400", !(await free(4400)));

  shell = spawn(path.join(TARGET, "gx-playout.exe"), [], {
    stdio: ["ignore", shellOut, shellOut],
    env: { ...process.env, GX_LOG_DIR: path.join(scratch, "logs"), WEBVIEW2_USER_DATA_FOLDER: path.join(scratch, "webview") },
  });
  pids.shell = shell.pid;

  let targets;
  for (let i = 0; i < 80; i += 1) {
    try {
      targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
      if (targets.some((t) => t.type === "page" && !String(t.url).startsWith("devtools"))) break;
    } catch {
      /* not up yet */
    }
    await wait(500);
  }
  const page = targets?.find((t) => t.type === "page" && !String(t.url).startsWith("devtools"));
  if (!page) throw new Error("no page target from the Playout window");
  check("the page is served by the real shell, not a file or a server", /^(https?:\/\/(tauri|ipc)\.localhost|tauri:\/\/)/.test(page.url), page.url);

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
    if (r.exceptionDetails) throw new Error(`eval: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  };
  const shot = async (name) => fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from((await send("Page.captureScreenshot", { format: "png" })).data, "base64"));
  const centre = (selector) => ev(`(() => { const n = document.querySelector(${JSON.stringify(selector)}); n.scrollIntoView({ block: "center" }); const r = n.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  const press = async (selector, ms) => {
    const { x, y } = await centre(selector);
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await wait(ms);
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  };
  const click = (selector) => press(selector, 40);
  const type = async (selector, text) => {
    await ev(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); e.focus(); e.select(); })()`);
    await send("Input.insertText", { text });
  };
  const text = (id) => ev(`document.getElementById(${JSON.stringify(id)}).textContent`);
  const rows = () => ev(`JSON.stringify([...document.querySelectorAll("#stacksList tbody tr")].map((tr) => ({ stack: tr.dataset.stack, scene: tr.querySelector(".stacks__scene").textContent, chips: [...tr.querySelectorAll(".chip")].filter((c) => !c.hidden).map((c) => c.textContent), disabled: [...tr.querySelectorAll("button")].filter((b) => !b.classList.contains("stacks__pick")).map((b) => b.disabled) })))`).then(JSON.parse);

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Log.enable");
  await send("Page.reload");
  await wait(3000);

  check("the Stacks panel and the Stack field exist in the real window", (await ev("!!document.getElementById('stacksList') && !!document.getElementById('stackInput')")) === true);
  check("the module imports loaded: the table drew its header", (await ev("document.querySelectorAll('#stacksList th').length")) === 4);
  check("the window attached to the mock engine on its own", (await text("connectionState")) === "CONNECTED", await text("connectionDetail"));

  // sign in through the real shell
  await type("#operatorInput", "Check Operator");
  await click("#signInButton");
  await wait(600);
  check("signed in through the real shell", (await text("operatorHint")) === "signed in", await text("operatorHint"));

  let r = await rows();
  check("an engine that sends no list: one row, stack 0, and the page says so", r.length === 1 && r[0].stack === "0" && (await ev("document.querySelector('.stacks__note').textContent")).includes("reports Stack 0 only"), { r, note: await ev("document.querySelector('.stacks__note').textContent") });
  await shot("real-1-empty");

  // TAKE on stack 0 (no layer) through the real IPC
  await type("#takeIdInput", "bug");
  await type("#revisionInput", "1");
  await type("#hashInput", HASH);
  await click("#takeButton");
  await wait(1200);
  r = await rows();
  check("a TAKE on stack 0 goes on air: the row shows the scene and ON AIR, from program", r[0]?.scene.startsWith("bug") && r[0].chips.includes("ON AIR"), r);
  check("the Stacks panel carries the engine's committed result", (await text("stacksResult")).startsWith("TAKE") && (await text("stacksResult")).includes("engine committed frame"), await text("stacksResult"));
  check("its row controls are enabled", r[0].disabled.join() === "false,false,false", r[0].disabled);

  // a stack other than 0 reaches the engine: this one-layer engine refuses it by name, saying which
  await type("#stackInput", "+60");
  await click("#takeButton");
  await wait(1000);
  const refused = await text("stacksResult");
  check("TAKE on +60 reaches the engine through the shell and is refused by name, naming the stack", /refused/i.test(refused) && /layerNotSupported/i.test(refused) && refused.includes("stack +60"), refused);
  check("and the main stack is still on air (nothing landed on layer zero)", (await rows()).some((x) => x.stack === "0" && x.scene.startsWith("bug")), await rows());
  await shot("real-2-refused");

  // the Transport CLEAR on +60: a layer, no page (the table shows nothing on +60), refused by name
  await click("#clearButton");
  await wait(800);
  const clearRefused = await text("stacksResult");
  check("CLEAR on +60 is a named refusal too, and stack 0 stays on air", /layerNotSupported/i.test(clearRefused) && (await rows()).some((x) => x.stack === "0" && x.scene.startsWith("bug")), clearRefused);

  // a row's Clear, held: the shell accepts `expected` (take and revision) and the engine clears
  await type("#stackInput", "0");
  await ev("document.getElementById('stackInput').blur()");
  await press("tr[data-stack='0'] .btn--clear-row", 500);
  await wait(300);
  check("a hold released at 0.5 s sends nothing", (await rows()).some((x) => x.stack === "0" && x.scene.startsWith("bug")));
  await press("tr[data-stack='0'] .btn--clear-row", 1300);
  await wait(1500);
  const cleared = await text("stacksResult");
  check("a row Clear held for a second is accepted by the shell with its expected page and the engine commits it", cleared.startsWith("CLEAR") && cleared.includes("engine committed frame") && !/unhandledBridgeFailure|invalid|missing/i.test(cleared), cleared);
  r = await rows();
  check("and the table reads the engine's answer: stack 0 is empty again", r.length === 1 && r[0].scene === "empty", r);

  // Cue out on a row: take again, hold Cue out, read the engine's answer (ok or a named refusal), never an unhandled failure
  await type("#stackInput", "0");
  await click("#takeButton");
  await wait(1000);
  await press("tr[data-stack='0'] .btn--out", 1300);
  await wait(1200);
  const outText = await text("stacksResult");
  check("Cue out held on a row reaches the engine and its answer is shown, named", outText.startsWith("OUT") && !/unhandledBridgeFailure/.test(outText), outText);
  await shot("real-3-after-out");

  const errors = events
    .filter((e) => e.method === "Runtime.exceptionThrown" || (e.method === "Log.entryAdded" && e.params.entry.level === "error") || (e.method === "Runtime.consoleAPICalled" && e.params.type === "error"))
    .map((e) => JSON.stringify(e.params).slice(0, 400));
  check("no script error, console error or CSP violation in the real window", errors.length === 0, errors);
  ws.close();
} catch (error) {
  check("the real-window run itself", false, String(error?.stack ?? error));
} finally {
  clearTimeout(watchdog);
  for (const [name, pid] of Object.entries(pids)) {
    try {
      process.kill(pid);
    } catch {
      /* already gone */
    }
    check(`ended ${name} by PID ${pid}`, true);
  }
  const failed = results.filter((r) => !r.ok);
  fs.writeFileSync(path.join(OUT, "real-results.json"), JSON.stringify(results, null, 1));
  console.log(JSON.stringify({ total: results.length, failed: failed.length, failures: failed, pids }, null, 1));
  setTimeout(() => process.exit(failed.length === 0 ? 0 : 1), 500);
}
