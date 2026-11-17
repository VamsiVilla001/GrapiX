// 2.17 live check: a real Editor window edits a scene, then publishes it to a real engine,
// and one id follows each edit from the front end through the shell and the asset plane to
// the engine.
//
//   node docs/evidence/2.17/live-check.mjs
//
// Needs the debug binaries (`cargo build -p gx-render-worker -p gx-editor-shell`). It starts a
// worker on free ports, starts the Editor with `GX_LOG_DIR` in a scratch folder (never the
// user's log root) and a WebView2 remote-debugging port, drives the page through the DevTools
// protocol as an operator would (clicks), closes the window gracefully, and reads the files
// back. The front end mints an id per shell call (2.13); the publish writes the ids of the
// edits it holds on its own records (2.17); what is checked is in the `check` calls below, and
// the script exits 1 if any of it fails.

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
const scratch = mkdtempSync(join(tmpdir(), "gx-live-2-17-"));
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
  start("engine", EXE("gx-render-worker"), [
    "--port", String(control),
    "--asset-port", String(assets),
    "--recovery-journal", join(scratch, "recovery.json"),
    "--package-dir", packages,
  ]);
  await until("the engine's control port", () => new Promise((resolve) => {
    const probe = net.connect(control, "127.0.0.1").once("connect", () => { probe.destroy(); resolve(true); }).once("error", () => resolve(false));
  }));
  const fill = (id, value) => `(() => { const el = document.getElementById(${JSON.stringify(id)}); el.value = ${JSON.stringify(String(value))}; el.dispatchEvent(new Event('input', { bubbles: true })); })()`;

  // --- the Editor: edits from the front end, a publish, one more edit, a second publish ----
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
  const applied = () => readLogs().filter((r) => r.file === "editor/shell" && r.event === "editor.command" && r.fields?.command === "editScene" && r.fields?.result === "applied").length;
  // A click can arrive before the page is ready to act on it (seen: no edit followed the first
  // click of a run), so it is repeated until one more edit has applied. A repeat can add an
  // edit of its own, which is why the checks below count the edits that applied instead of
  // assuming how many there are.
  const edit = async () => {
    const before = applied();
    for (let attempt = 0; attempt < 5 && applied() === before; attempt++) {
      await ed.evaluate(`document.querySelector('[data-create-kind="rect"]').click(); undefined`);
      await until("an edit to land", () => applied() > before, 5_000).catch(() => undefined);
    }
    if (applied() === before) throw new Error("no edit applied after five clicks");
    await sleep(700);
  };
  const publish = async (n) => {
    await ed.evaluate(fill("endpoint", `127.0.0.1:${assets}`));
    await ed.evaluate(`document.getElementById('publish-result').textContent = ''; document.getElementById('publish').click(); undefined`);
    await until(`publish ${n} to report`, () => ed.evaluate(`(() => { const r = document.getElementById('publish-result'); return r && !r.hidden && r.textContent.length > 0; })()`), 30_000);
    await sleep(300);
  };
  step("Editor edits and publishes");
  await edit();
  await edit();
  await edit();
  const firstBatch = applied();
  await publish(1);
  await edit();
  const secondBatch = applied() - firstBatch;
  await publish(2);
  await publish(3);
  const publishText = await ed.evaluate(`document.getElementById('publish-result').textContent`);
  await sleep(1000);
  ed.close();
  closeGracefully("gx-editor");
  const editorCode = await exited(editor);

  // --- the engine goes last, so everything it was sent is in its file ----------------
  step("reading the files");
  await until("the engine to have written its three publishes", () => readLogs().filter((r) => r.file === "engine/worker" && r.event === "publish.accepted").length >= 3, 20_000).catch(() => undefined);
  const records = readLogs();

  // --- what the files say ----------------------------------------------------------
  const carries = (r) => (typeof r.fields?.carries === "string" ? r.fields.carries.split(",") : []);
  /** What a search for `id` finds: records written under it, and records that name it as a carried edit. */
  const follow = (id) => records.filter((r) => r.corr === id || carries(r).includes(id));
  const calls = (command) => records.filter((r) => r.file === "editor/shell" && r.event === "ui.call" && r.fields?.command === command);

  // The ids of the edits that applied, in order: each front-end call of cmd_execute whose
  // id has an applied editScene record under it.
  const editIds = calls("cmd_execute")
    .filter((r) => r.fields.result === "ok" && touching(records, r.corr).some((x) => x.event === "editor.command" && x.fields?.command === "editScene" && x.fields?.result === "applied"))
    .map((r) => r.corr);
  check(
    "the edits from the front end applied, each under an id of its own (three or more, a publish, then one or more)",
    firstBatch >= 3 && secondBatch >= 1 && editIds.length === firstBatch + secondBatch && new Set(editIds).size === editIds.length,
    `${firstBatch} then ${secondBatch}: ${editIds.join(", ")}`,
  );

  const publishCalls = calls("cmd_publish").filter((r) => r.fields.result === "ok");
  check("the Editor reported three publishes", publishCalls.length === 3, publishCalls.map((r) => r.corr).join(", "));
  const accepted = records.filter((r) => r.file === "engine/worker" && r.event === "publish.accepted");
  check("the engine accepted three publishes", accepted.length === 3, `${accepted.length}`);
  const publishIds = publishCalls.map((r) => r.corr);

  // Each publish is written by the engine under the id the front end gave the publish call, and
  // names the edits made since the one before.
  const shellPublish = (corr) => records.find((r) => r.file === "editor/shell" && r.event === "editor.publish" && r.corr === corr);
  const enginePublish = (corr) => accepted.find((r) => r.corr === corr);
  const want = [editIds.slice(0, firstBatch), editIds.slice(firstBatch), []];
  for (const [index, corr] of publishIds.entries()) {
    const engine = enginePublish(corr);
    const shell = shellPublish(corr);
    const ids = want[index] ?? [];
    check(`publish ${index + 1}: the engine's publish.accepted is under the publish call's id`, Boolean(engine), corr);
    check(
      `publish ${index + 1}: the engine names ${ids.length === 0 ? "no edits" : `the ${ids.length} edit${ids.length > 1 ? "s" : ""} made since the last publish`}`,
      JSON.stringify(carries(engine ?? {})) === JSON.stringify(ids),
      `${engine?.fields?.carries ?? "(none)"} against ${ids.join(",") || "(none)"}`,
    );
    check(`publish ${index + 1}: the shell's own record names the same edits`, JSON.stringify(carries(shell ?? {})) === JSON.stringify(ids), `${shell?.fields?.carries ?? "(none)"}`);
  }

  // One search for an edit's id finds its own records and the engine's publish that carried it.
  for (const [index, id] of editIds.entries()) {
    const found = follow(id);
    const carried = publishIds[index < firstBatch ? 0 : 1];
    check(
      `edit ${index + 1}: a search for its id finds the shell's record of the edit and the engine's publish`,
      found.some((r) => r.file === "editor/shell" && r.event === "editor.command" && r.fields?.result === "applied") &&
        found.some((r) => r.file === "engine/worker" && r.event === "publish.accepted" && r.corr === carried),
      found.map((r) => `${r.file}:${r.event}`).join(", "),
    );
  }
  // And it does not find a publish that did not carry it: the last edit is not in publish 1 or 3.
  const wrong = follow(editIds.at(-1) ?? "none").filter((r) => r.event === "publish.accepted" && r.corr !== publishIds[1]);
  check("an edit made after a publish is not found on that publish or on the one after it", wrong.length === 0, wrong.map((r) => r.corr).join(", "));
  check("a publish with no edit since the last names none", accepted.length === 3 && accepted[2].fields?.carries === undefined, JSON.stringify(accepted[2]?.fields ?? null));
  check("the Editor closed gracefully and finished its log", editorCode === 0 && records.some((r) => r.file === "editor/shell" && r.event === "editor.stop"), `exit ${editorCode}`);
  check("no token or credential text in any file", !records.some((r) => JSON.stringify(r).includes("gx1.")));

  writeFileSync(
    join(ROOT, "docs", "evidence", "2.17", "live-check-result.json"),
    JSON.stringify({
      checks: report,
      publishLine: publishText,
      editIds,
      publishIds,
      followed: Object.fromEntries(editIds.map((id) => [id, follow(id).map(({ file, level, event, corr, fields }) => ({ file, level, event, corr, command: fields?.command, result: fields?.result, carries: fields?.carries }))])),
      publishes: publishIds.map((corr) => ({
        corr,
        shell: shellPublish(corr) ? { event: "editor.publish", carries: shellPublish(corr).fields?.carries ?? null } : null,
        engine: enginePublish(corr) ? { event: "publish.accepted", carries: enginePublish(corr).fields?.carries ?? null } : null,
      })),
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
