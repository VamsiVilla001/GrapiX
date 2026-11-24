// DevTools driver helpers for the real Editor window (page-level input only; no OS key or click is ever sent).
import fs from "node:fs";

const SHOTS = "C:/Users/CG/AppData/Local/Temp/claude/0a3a2c92b3fb84eb/f0c91e73-cfef-42e2-b898-73dc1b45ee20/scratchpad/live/shots/";

export async function connect(port = 9333, seconds = 150) {
  const watchdog = setTimeout(() => { console.error("watchdog"); process.exit(3); }, seconds * 1000);
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const page = targets.find((t) => t.type === "page" && !String(t.url).startsWith("devtools"));
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error("websocket")); });
  let id = 0;
  const waiting = new Map();
  const dialogs = [];
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && waiting.has(d.id)) { waiting.get(d.id)(d); waiting.delete(d.id); }
    else if (d.method === "Page.javascriptDialogOpening") { dialogs.push(d.params.message); send("Page.handleJavaScriptDialog", { accept: true, promptText: d.params.defaultPrompt ?? "" }); }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const mine = ++id;
    const t = setTimeout(() => reject(new Error("timeout " + method)), 25000);
    waiting.set(mine, (r) => { clearTimeout(t); r.error ? reject(new Error(method + ": " + r.error.message)) : resolve(r.result); });
    ws.send(JSON.stringify({ id: mine, method, params }));
  });
  const ev = async (expression) => {
    const r = await send("Runtime.evaluate", { expression: `(async()=>{${expression}})()`, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const mouse = async (steps) => {
    for (const s of steps) {
      await send("Input.dispatchMouseEvent", {
        type: s.type, x: s.x, y: s.y,
        button: s.type === "mouseMoved" && !s.down ? "none" : "left",
        buttons: s.type === "mouseReleased" ? 0 : s.type === "mouseMoved" && !s.down ? 0 : 1,
        clickCount: s.type === "mouseMoved" ? 0 : (s.clicks ?? 1),
        modifiers: s.modifiers ?? 0,
      });
      await wait(s.wait ?? 60);
    }
  };
  const click = (p, modifiers = 0) => mouse([{ type: "mousePressed", ...p, modifiers }, { type: "mouseReleased", ...p, modifiers }]);
  const drag = (a, b, modifiers = 0) => mouse([{ type: "mousePressed", ...a, modifiers }, { type: "mouseMoved", ...b, down: true, wait: 120, modifiers }, { type: "mouseReleased", ...b, wait: 700, modifiers }]);
  const key = async (target, k, extra = {}) => ev(`(${target}).dispatchEvent(new KeyboardEvent("keydown",{key:${JSON.stringify(k)},bubbles:true,cancelable:true,...${JSON.stringify(extra)}})); await new Promise(r=>setTimeout(r,500)); return 1;`);
  const shot = async (name) => { const r = await send("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(`${SHOTS}${name}.png`, Buffer.from(r.data, "base64")); };
  await send("Page.enable");
  const geometry = () => ev(`const s = document.getElementById("viewport-overlay"); const r = s.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height };`);
  const done = () => { clearTimeout(watchdog); ws.close(); setTimeout(() => process.exit(0), 50); };
  return { send, ev, wait, mouse, click, drag, key, shot, geometry, dialogs, done };
}

export const LOG = `[...document.querySelectorAll("#log li")].map((li) => li.textContent.trim().replace(/^\\d\\d:\\d\\d:\\d\\d\\s*/, "").slice(0, 140))`;
export const at = (g, x, y) => ({ x: g.left + (x / 1920) * g.width, y: g.top + (y / 1080) * g.height });
