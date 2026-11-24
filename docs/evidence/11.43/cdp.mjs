// One DevTools call against the running Editor window's page.
//   node cdp.mjs <port> eval <file.js>            evaluate the file's expression (awaited), print the value as JSON
//   node cdp.mjs <port> shot <out.png>            capture the page as a PNG
// Safeguards (live-check note 5): a watchdog ends the process, every call has a timeout, and a modal
// dialog (prompt/confirm/alert) is answered so the page is never held. No OS key or click is sent.
import fs from "node:fs";

const [, , portArg, verb, argument] = process.argv;
const port = Number(portArg);
const watchdog = setTimeout(() => {
  console.error("watchdog: no answer in 40 s");
  process.exit(3);
}, 40000);

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((t) => t.type === "page" && !String(t.url).startsWith("devtools"));
if (!page) {
  console.error("no page target", JSON.stringify(targets.map((t) => [t.type, t.url])));
  process.exit(2);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = () => reject(new Error("websocket"));
});
let id = 0;
const waiting = new Map();
const dialogs = [];
ws.onmessage = (message) => {
  const data = JSON.parse(message.data);
  if (data.id && waiting.has(data.id)) {
    waiting.get(data.id)(data);
    waiting.delete(data.id);
  } else if (data.method === "Page.javascriptDialogOpening") {
    dialogs.push({ type: data.params.type, message: data.params.message });
    void send("Page.handleJavaScriptDialog", { accept: true, promptText: data.params.defaultPrompt ?? "" });
  }
};
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const mine = ++id;
    const timer = setTimeout(() => reject(new Error(`timeout ${method}`)), 25000);
    waiting.set(mine, (reply) => {
      clearTimeout(timer);
      if (reply.error) reject(new Error(`${method}: ${reply.error.message}`));
      else resolve(reply.result);
    });
    ws.send(JSON.stringify({ id: mine, method, params }));
  });
}

try {
  await send("Page.enable");
  if (verb === "shot") {
    const shot = await send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(argument, Buffer.from(shot.data, "base64"));
    console.log(JSON.stringify({ saved: argument }));
  } else if (verb === "eval") {
    const expression = fs.readFileSync(argument, "utf8");
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) {
      console.log(JSON.stringify({ exception: result.exceptionDetails.exception?.description ?? result.exceptionDetails.text, dialogs }));
    } else {
      console.log(JSON.stringify({ value: result.result.value, dialogs }));
    }
  } else {
    console.error("unknown verb");
  }
} catch (error) {
  console.error(String(error));
  process.exitCode = 4;
} finally {
  clearTimeout(watchdog);
  ws.close();
  setTimeout(() => process.exit(process.exitCode ?? 0), 50);
}
