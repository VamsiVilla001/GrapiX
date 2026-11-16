// 2.13 live check: drive the real Editor and Playout windows against a real engine
// and follow each action's correlation id across the log files.
//
//   node docs/evidence/2.13/live-check.mjs
//
// Needs the debug binaries (`cargo build -p gx-render-worker -p gx-editor-shell -p
// gx-playout-shell`). It starts a worker on free ports, starts each shell with
// `GX_LOG_DIR` in a scratch folder (never the user's log root) and a WebView2
// remote-debugging port, drives the page through the DevTools protocol as an
// operator would (clicks, typed fields), closes each window gracefully, and reads
// the files back. The Playout and Editor files are read for the ids the front end
// minted; the engine's file for the same ids.
//
// What is checked is in `check()` below; the script exits 1 if any of it fails.

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const BIN = join(ROOT, "target", "debug");
const EXE = (name) => join(BIN, `${name}.exe`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const scratch = mkdtempSync(join(tmpdir(), "gx-live-2-13-"));
const logs = join(scratch, "logs");
const packages = join(scratch, "packages");
mkdirSync(packages, { recursive: true });
const children = [];

async function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function until(what, predicate, ms = 30_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(150);
  }
}

function start(name, exe, args, env = {}) {
  const child = spawn(exe, args, {
    env: { ...process.env, GX_LOG_DIR: logs, ...env },
    stdio: "ignore",
    windowsHide: false,
  });
  children.push({ name, child });
  return child;
}

/** Ask a window to close, as its close button does (a force-kill runs no shutdown code). */
function closeGracefully(processName) {
  spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", `Get-Process ${processName} -ErrorAction SilentlyContinue | ForEach-Object { [void]$_.CloseMainWindow() }`],
    { timeout: 25_000 },
  );
}

async function exited(child, ms = 20_000) {
  return until("the window to close", () => child.exitCode !== null, ms).then(() => child.exitCode);
}

/** A DevTools-protocol session on the first page of a WebView2 remote-debugging port. */
async function page(port) {
  const target = await until(`a page on :${port}`, async () => {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      return list.find((entry) => entry.type === "page" && entry.webSocketDebuggerUrl);
    } catch {
      return undefined;
    }
  });
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = () => reject(new Error("devtools socket"));
  });
  let next = 0;
  const waiting = new Map();
  socket.onmessage = (message) => {
    const body = JSON.parse(message.data);
    // The Editor asks for a name with window.prompt, which holds the page (and every
    // call into it) until someone answers. Answer as the operator would: accept the
    // text the prompt offers.
    if (body.method === "Page.javascriptDialogOpening") {
      void send("Page.handleJavaScriptDialog", { accept: true, promptText: body.params?.defaultPrompt ?? "" }).catch(() => undefined);
      return;
    }
    waiting.get(body.id)?.resolve(body);
  };
  // A page that goes away must fail the call that was waiting on it, not hang the run.
  socket.onclose = () => {
    for (const { reject } of waiting.values()) reject(new Error("the devtools socket closed"));
    waiting.clear();
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      next += 1;
      const id = next;
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(new Error(`no answer to ${method} in 20 s`));
      }, 20_000);
      waiting.set(id, {
        resolve: (body) => { clearTimeout(timer); waiting.delete(id); resolve(body); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      socket.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const reply = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (reply.result?.exceptionDetails) throw new Error(`page threw: ${JSON.stringify(reply.result.exceptionDetails.exception?.description ?? reply.result.exceptionDetails.text)}`);
    return reply.result?.result?.value;
  };
  await send("Page.enable");
  return { evaluate, close: () => socket.close() };
}

function readLogs() {
  const records = [];
  for (const product of ["engine", "editor", "playout"]) {
    let files = [];
    try {
      files = readdirSync(join(logs, product));
    } catch {
      continue;
    }
    for (const file of files.filter((name) => name.endsWith(".jsonl"))) {
      for (const line of readFileSync(join(logs, product, file), "utf8").split("\n")) {
        if (line.trim()) records.push({ file: `${product}/${file.split("-")[0]}`, ...JSON.parse(line) });
      }
    }
  }
  return records;
}

let lastStep = "starting";
const step = (name) => {
  lastStep = name;
  console.log(`step: ${name}`);
};
// A hung step must end the run and say where, not keep two processes open for hours.
const watchdog = setTimeout(() => {
  console.log(`\nFAILED: the check did not finish in 4 minutes; last step: ${lastStep}; scratch kept at ${scratch}`);
  for (const { child } of children) child.kill();
  process.exit(2);
}, 240_000);

const failures = [];
const report = [];
function check(name, ok, detail = "") {
  report.push({ name, ok, detail });
  if (!ok) failures.push(`${name} ${detail}`);
}
const touching = (records, corr) => records.filter((record) => record.corr === corr);
const events = (records) => records.map((record) => `${record.file}:${record.event}`);

try {
  // --- the engine -------------------------------------------------------------
  step("engine");
  const control = await freePort();
  const assets = await freePort();
  const hash = "a".repeat(64);
  start("engine", EXE("gx-render-worker"), [
    "--port", String(control),
    "--asset-port", String(assets),
    "--recovery-journal", join(scratch, "recovery.json"),
    "--package-dir", packages,
    "--publish", `live/lower-third:1:${hash}`,
  ]);
  await until("the engine's control port", () => new Promise((resolve) => {
    const probe = net.connect(control, "127.0.0.1").once("connect", () => { probe.destroy(); resolve(true); }).once("error", () => resolve(false));
  }));

  // --- Playout: connect, a take that commits, a take that is refused, two failures ----
  step("Playout starts");
  const playoutPort = await freePort();
  const playout = start("playout", EXE("gx-playout"), [], {
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${playoutPort}`,
    WEBVIEW2_USER_DATA_FOLDER: join(scratch, "webview-playout"),
  });
  const po = await page(playoutPort);
  await until("Playout's surface", () => po.evaluate(`document.getElementById('connectButton') !== null && document.getElementById('logList').childElementCount > 0`));
  const fill = (id, value) => `(() => { const el = document.getElementById(${JSON.stringify(id)}); el.value = ${JSON.stringify(String(value))}; el.dispatchEvent(new Event('input', { bubbles: true })); })()`;
  // Playout tries its default endpoint when it opens and ignores a click while that
  // is running, so the click is repeated until the connection is up.
  await po.evaluate(fill("endpointInput", `127.0.0.1:${control}`));
  await until("Playout to connect", async () => {
    await po.evaluate(`document.getElementById('connectButton').click()`);
    await sleep(700);
    return po.evaluate(`document.getElementById('connectionState').textContent === 'CONNECTED'`);
  });

  step("Playout takes");
  await po.evaluate(fill("takeIdInput", "live/lower-third"));
  await po.evaluate(fill("revisionInput", 1));
  await po.evaluate(fill("hashInput", hash));
  await po.evaluate(`document.getElementById('takeButton').click()`);
  await until("the take to commit", () => po.evaluate(`document.getElementById('logList').textContent.includes('engine committed frame')`));

  await po.evaluate(fill("takeIdInput", "live/not-published"));
  await po.evaluate(`document.getElementById('takeButton').click()`);
  // The row for the take's refusal, not the first row that says "refused": Playout's
  // first attempt at its default endpoint is also refused, and is a CONNECT row.
  const takeRefusalRow = `[...document.querySelectorAll('#logList > li')].map((li) => li.textContent).find((text) => text.includes('TAKE') && text.includes('refused')) ?? ''`;
  await until("the refusal of the take", () => po.evaluate(`(${takeRefusalRow}) !== ''`));
  const refusedRow = await po.evaluate(takeRefusalRow);

  step("Playout failures and close");
  // A failure nobody caught, and a rejection nobody handled.
  await po.evaluate(`setTimeout(() => { throw new Error('live-check uncaught error'); }, 0); undefined`);
  await po.evaluate(`Promise.reject(new Error('live-check unhandled rejection')); undefined`);
  await sleep(1500);
  po.close();
  closeGracefully("gx-playout");
  const playoutCode = await exited(playout);

  // --- the Editor: an edit from the front end, then a publish to the engine ---------
  step("Editor starts");
  const editorPort = await freePort();
  const editor = start("editor", EXE("gx-editor"), [], {
    GX_EDITOR_PACKAGE_DIR: packages,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${editorPort}`,
    WEBVIEW2_USER_DATA_FOLDER: join(scratch, "webview-editor"),
  });
  const ed = await page(editorPort);
  await until("the Editor's surface", () => ed.evaluate(`document.querySelector('[data-create-kind="rect"]') !== null && document.getElementById('publish') !== null`));
  await until("the Editor to open its blank scene", () => readLogs().some((r) => r.file === "editor/shell" && r.event === "editor.command" && r.fields?.command === "openScene"));
  step("Editor edit");
  await ed.evaluate(`document.querySelector('[data-create-kind="rect"]').click(); undefined`);
  await until("the edit to land", () => readLogs().some((r) => r.file === "editor/shell" && r.event === "editor.command" && r.fields?.command === "editScene"), 15_000)
    .catch(async () => {
      await ed.evaluate(`document.getElementById('object-create')?.click(); undefined`);
      await until("the edit to land", () => readLogs().some((r) => r.file === "editor/shell" && r.event === "editor.command" && r.fields?.command === "editScene"), 15_000);
    });
  step("Editor publish");
  await ed.evaluate(fill("endpoint", `127.0.0.1:${assets}`));
  await ed.evaluate(`document.getElementById('publish').click(); undefined`);
  await until("the publish result", () => ed.evaluate(`(() => { const r = document.getElementById('publish-result'); return r && !r.hidden && r.textContent.length > 0; })()`), 30_000);
  const publishText = await ed.evaluate(`document.getElementById('publish-result').textContent`);
  await sleep(1000);
  ed.close();
  closeGracefully("gx-editor");
  const editorCode = await exited(editor);

  // --- the engine goes last, so everything it was sent is in its file ----------------
  step("reading the files");
  await sleep(500);
  const records = readLogs();

  // --- what the files say ----------------------------------------------------------
  const calls = (file, command) => records.filter((r) => r.file === file && r.event === "ui.call" && r.fields?.command === command);

  // Playout: one take, followed by its id from the front end to the engine.
  const take = calls("playout/shell", "cmd_take").find((r) => r.fields.result === "ok");
  check("Playout reported its take call with an id", Boolean(take?.corr), take ? take.corr : "no ui.call for cmd_take");
  if (take?.corr) {
    const chain = touching(records, take.corr);
    const shellTake = chain.find((r) => r.file === "playout/shell" && r.event === "operator.take");
    const engineTake = chain.find((r) => r.file === "engine/worker" && r.event === "program.take");
    check("the shell's own record of the take carries the id", shellTake?.fields?.result === "committed", events(chain).join(", "));
    check("the engine's record of the take carries the same id, with the frame it committed", engineTake?.fields?.result === "committed" && typeof engineTake.frame === "number", events(chain).join(", "));
    // The front end's report of its call is written by the shell (through cmd_log), so
    // the take's id is on three records in two files: no more, no fewer.
    const expected = ["engine/worker:program.take", "playout/shell:operator.take", "playout/shell:ui.call"];
    check("the take's id is on exactly three records: the front end's report of the call, the shell's record and the engine's record", JSON.stringify(events(chain).sort()) === JSON.stringify(expected), events(chain).join(", "));
    check("the shell and the engine name the same frame for the take", typeof shellTake?.frame === "number" && shellTake.frame === engineTake?.frame, `${shellTake?.frame} / ${engineTake?.frame}`);
  }
  const refused = calls("playout/shell", "cmd_take").find((r) => String(r.fields.result).startsWith("refused"));
  check("a refused take is reported with its refusal code", Boolean(refused), refused ? refused.fields.result : "none");
  if (refused?.corr) {
    const chain = touching(records, refused.corr);
    check("the engine's refusal carries the id the front end gave the call", chain.some((r) => r.file === "engine/worker" && r.event === "program.take" && r.fields?.result === "refused"), events(chain).join(", "));
    check("the operator can read the id in the line that shows the refusal", refusedRow.includes(refused.corr), refusedRow);
  }
  const uncaught = records.find((r) => r.file === "playout/shell" && r.event === "ui.error" && String(r.fields?.message).includes("live-check uncaught error"));
  check("an uncaught front-end error reaches the shell log with an id", Boolean(uncaught?.corr) && /^po-/.test(uncaught.corr), uncaught ? uncaught.corr : "not found");
  const rejection = records.find((r) => r.file === "playout/shell" && r.event === "ui.rejection" && String(r.fields?.message).includes("live-check unhandled rejection"));
  check("an unhandled rejection reaches the shell log with an id", Boolean(rejection?.corr), rejection ? rejection.corr : "not found");
  check("Playout closed gracefully and finished its log", playoutCode === 0 && records.some((r) => r.file === "playout/shell" && r.event === "playout.stop"), `exit ${playoutCode}`);
  check("no token or credential text in any file", !records.some((r) => JSON.stringify(r).includes("gx1.")));

  // Editor: an edit and a publish.
  const edit = calls("editor/shell", "cmd_execute").find((r) => r.fields.result === "ok" && touching(records, r.corr).some((x) => x.event === "editor.command" && x.fields?.command === "editScene"));
  check("an Editor edit from the front end: its call and the shell's record of the command carry one id", Boolean(edit?.corr), edit ? events(touching(records, edit.corr)).join(", ") : "no edit chain");
  const published = calls("editor/shell", "cmd_publish")[0];
  check("the Editor reported its publish call with an id", Boolean(published?.corr), published ? `${published.corr} ${published.fields.result}` : "no ui.call for cmd_publish");
  if (published?.corr) {
    const chain = touching(records, published.corr);
    check("the shell's record of the publish carries the id", chain.some((r) => r.file === "editor/shell" && r.event === "editor.publish"), events(chain).join(", "));
    check("the engine's record of the publish carries the same id", chain.some((r) => r.file === "engine/worker" && /^publish\./.test(r.event)), events(chain).join(", "));
  }
  check("the Editor closed gracefully and finished its log", editorCode === 0 && records.some((r) => r.file === "editor/shell" && r.event === "editor.stop"), `exit ${editorCode}`);

  writeFileSync(
    join(ROOT, "docs", "evidence", "2.13", "live-check-result.json"),
    JSON.stringify({
      checks: report,
      publishLine: publishText,
      refusedLine: refusedRow,
      followed: {
        take: take?.corr ? touching(records, take.corr).map(({ file, level, event, corr, frame, fields }) => ({ file, level, event, corr, frame, result: fields?.result, command: fields?.command, take_id: fields?.take_id })) : [],
        refusedTake: refused?.corr ? touching(records, refused.corr).map(({ file, level, event, corr, refusal, fields }) => ({ file, level, event, corr, refusal, result: fields?.result, command: fields?.command })) : [],
        editorEdit: edit?.corr ? touching(records, edit.corr).map(({ file, level, event, corr, fields }) => ({ file, level, event, corr, command: fields?.command, result: fields?.result })) : [],
        editorPublish: published?.corr ? touching(records, published.corr).map(({ file, level, event, corr, fields }) => ({ file, level, event, corr, command: fields?.command, result: fields?.result, take_id: fields?.take_id })) : [],
        uncaughtError: uncaught ? { file: uncaught.file, event: uncaught.event, corr: uncaught.corr, source: uncaught.fields?.source, message: uncaught.fields?.message } : null,
        rejection: rejection ? { file: rejection.file, event: rejection.event, corr: rejection.corr, message: rejection.fields?.message } : null,
      },
    }, null, 2) + "\n",
  );
} catch (error) {
  failures.push(`the check could not run: ${error.stack ?? error}`);
} finally {
  clearTimeout(watchdog);
  for (const { child } of children) {
    if (child.exitCode === null) child.kill();
  }
  await sleep(500);
  for (const row of report) console.log(`${row.ok ? "PASS" : "FAIL"}  ${row.name}${row.ok ? "" : `  ${row.detail}`}`);
  if (failures.length) {
    for (const failure of failures) console.log(`\nFAILED: ${failure}`);
    console.log(`\n${failures.length} failed; scratch kept at ${scratch}`);
    process.exitCode = 1;
  } else {
    rmSync(scratch, { recursive: true, force: true });
    console.log("\nall passed");
  }
}
