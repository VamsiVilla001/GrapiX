// 2.14 live check: the real Editor and Playout windows, their Help menu, and the diagnostic bundle
// each export item writes.
//
//   node docs/evidence/2.14/live-check.mjs
//
// Needs the debug binaries (`cargo build -p gx-render-worker -p gx-editor-shell -p gx-playout-shell`;
// a stale binary has no menu). It starts a real engine and each shell in turn with `GX_LOG_DIR` in a
// scratch folder (never the user's log root) and `GX_DIAG_NO_REVEAL` so no file manager opens. The menu
// item is chosen the way Windows does when a person clicks it: `menu-click.ps1` reads the window's
// native menu (GetMenu, GetSubMenu, GetMenuString), finds the item by its text and posts WM_COMMAND
// with its id. `zip-read.ps1` opens each bundle. It refuses to run if an Editor, Playout or engine is
// already open on the machine, because it closes windows by process name. The script exits 1 if any
// check fails.

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const BIN = join(ROOT, "target", "debug");
const EXE = (name) => join(BIN, `${name}.exe`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const scratch = mkdtempSync(join(tmpdir(), "gx-live-2-14-"));
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
  // Never close a window that is not this run's: if an Editor, Playout or engine of the user's is
  // open, stop before touching anything (`closeGracefully` closes by process name).
  const running = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-Process gx-editor,gx-playout,gx-render-worker -ErrorAction SilentlyContinue | ForEach-Object { $_.Name }"], { encoding: "utf8" }).stdout.trim();
  if (running) throw new Error(`refusing to run: ${running.split(/\s+/).join(", ")} already running on this machine`);

  // --- the engine, so the bundle has a second module to leave out or to hold ---------
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
  await until("the engine's first heartbeat", () => readLogs().some((r) => r.file === "engine/worker" && r.event === "engine.heartbeat"));

  const here = dirname(fileURLToPath(import.meta.url));
  const bundlesDir = join(logs, "bundles");
  const known = new Set();
  const listBundles = () => { try { return readdirSync(bundlesDir).filter((n) => n.endsWith(".zip")); } catch { return []; } };
  const newBundle = async (what) => {
    const name = await until(what, () => listBundles().find((n) => !known.has(n)), 60_000);
    known.add(name);
    await sleep(300);
    return join(bundlesDir, name);
  };
  const readZip = (path, members) => {
    const out = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", join(here, "zip-read.ps1"), "-Path", path, "-Read", members.join(",")], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    return JSON.parse(out.stdout);
  };
  const clickMenu = (pid, item) => {
    const out = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", join(here, "menu-click.ps1"), "-ProcessId", String(pid), "-Item", item], { encoding: "utf8" });
    return { status: out.status, output: out.stdout.trim() };
  };
  const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

  const shells = [
    { name: "Editor", exe: "gx-editor", module: "editor", file: "editor/shell", started: "editor.start", stopped: "editor.stop",
      env: { GX_EDITOR_PACKAGE_DIR: packages, WEBVIEW2_USER_DATA_FOLDER: join(scratch, "webview-editor") } },
    { name: "Playout", exe: "gx-playout", module: "playout", file: "playout/shell", started: "playout.start", stopped: "playout.stop",
      env: { WEBVIEW2_USER_DATA_FOLDER: join(scratch, "webview-playout") } },
  ];
  const summary = {};
  for (const shell of shells) {
    step(`${shell.name}: starts`);
    const child = start(shell.module, EXE(shell.exe), [], { ...shell.env, GX_DIAG_NO_REVEAL: "1" });
    await until(`${shell.name}'s start record`, () => readLogs().some((r) => r.file === shell.file && r.event === shell.started));
    await sleep(3000);

    // This module only, chosen from the real window's Help menu.
    step(`${shell.name}: Help, this module only`);
    const own = clickMenu(child.pid, `Export diagnostic bundle (${shell.module} only)`);
    check(`${shell.name}: the window's Help menu holds both export items, and the module item was chosen`,
      own.status === 0 && own.output.includes(`Help > Export diagnostic bundle (all modules)`) && own.output.includes(`Help > Export diagnostic bundle (${shell.module} only)`), own.output);
    const ownPath = await newBundle(`${shell.name}'s module bundle`);
    const ownZip = readZip(ownPath, ["manifest.json", `modules/${shell.module}/summary.json`, "versions.json"]);
    const ownManifest = JSON.parse(ownZip.files["manifest.json"] ?? "{}");
    const ownSummary = JSON.parse(ownZip.files[`modules/${shell.module}/summary.json`] ?? "{}");
    const shellLog = ownZip.names.filter((n) => n.startsWith(`modules/${shell.module}/logs/`));
    check(`${shell.name}: the module bundle holds this shell's log and its summary, and nothing of the engine's`,
      shellLog.length >= 1 && ownZip.names.includes(`modules/${shell.module}/summary.json`) && !ownZip.names.some((n) => n.startsWith("modules/engine/")),
      ownZip.names.join(", "));
    check(`${shell.name}: its summary names the run and says the module wrote in the window`,
      ownSummary.module === shell.module && ownSummary.wroteInWindow === true && Array.isArray(ownSummary.runs) && ownSummary.runs.length >= 1 && JSON.stringify(ownManifest.modulesRequested) === JSON.stringify([shell.module]),
      JSON.stringify({ module: ownSummary.module, runs: ownSummary.runs?.length, requested: ownManifest.modulesRequested }));
    const own256 = JSON.parse(ownZip.files["versions.json"] ?? "{}").binaries?.find((b) => b.name === `${shell.exe}.exe`);
    check(`${shell.name}: the bundle's SHA-256 of ${shell.exe}.exe is the file's own`, own256?.sha256 === sha256(EXE(shell.exe)) && own256?.module === shell.module, `${own256?.sha256} against ${sha256(EXE(shell.exe))}`);

    // Every module.
    step(`${shell.name}: Help, all modules`);
    await sleep(1200);
    const all = clickMenu(child.pid, "Export diagnostic bundle (all modules)");
    check(`${shell.name}: the all-modules item was chosen`, all.status === 0, all.output);
    const allPath = await newBundle(`${shell.name}'s all-modules bundle`);
    const allZip = readZip(allPath, ["manifest.json", "modules/engine/devices.json"]);
    const allManifest = JSON.parse(allZip.files["manifest.json"] ?? "{}");
    const devices = JSON.parse(allZip.files["modules/engine/devices.json"] ?? "{}");
    check(`${shell.name}: the all-modules bundle holds this shell's module and the engine's, with the engine's device`,
      allZip.names.includes(`modules/${shell.module}/summary.json`) && allZip.names.includes("modules/engine/summary.json") && allManifest.modulesRequested === "all" && typeof devices.starts?.[0]?.tier === "string",
      `${allZip.names.filter((n) => n.endsWith("summary.json")).join(", ")}; tier ${devices.starts?.[0]?.tier}`);
    check(`${shell.name}: neither bundle holds a credential, and the collector replaced none`, ownZip.credential.length === 0 && allZip.credential.length === 0 && ownManifest.credentialsRedacted === 0 && allManifest.credentialsRedacted === 0,
      `${ownZip.credential} ${allZip.credential}`);

    // Its own record of both exports, each under an id.
    step(`${shell.name}: closes`);
    closeGracefully(shell.exe);
    const code = await exited(child);
    const records = readLogs().filter((r) => r.file === shell.file);
    const exports = records.filter((r) => r.event === "diag.bundle");
    check(`${shell.name}: both exports are on its own record, each under a diag- id, naming the modules`,
      exports.length === 2 && exports.every((r) => /^diag-/.test(r.corr ?? "")) && exports[0].fields?.modules === shell.module && exports[1].fields?.modules.split(",").includes("engine") && exports[1].fields.modules.split(",").includes(shell.module),
      JSON.stringify(exports.map((r) => ({ corr: r.corr, modules: r.fields?.modules, files: r.fields?.files }))));
    check(`${shell.name}: it closed gracefully and finished its log`, code === 0 && records.some((r) => r.event === shell.stopped) && records.at(-1)?.event === "log.stop", `exit ${code}`);
    summary[shell.name] = { own: ownZip.names, all: allZip.names, exports: exports.map((r) => ({ corr: r.corr, modules: r.fields?.modules, files: r.fields?.files, bytes: r.fields?.bytes })), menu: own.output };
  }

  writeFileSync(join(ROOT, "docs", "evidence", "2.14", "live-check-result.json"), JSON.stringify({ checks: report, shells: summary }, null, 2) + "\n");
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
