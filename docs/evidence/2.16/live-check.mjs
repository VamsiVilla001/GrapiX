// 2.16 live check: a real Ctrl+C ends a real engine with `engine.stop`, and a real
// kill is named by the next start.
//
//   node docs/evidence/2.16/live-check.mjs
//
// Needs the debug worker (`cargo build -p gx-render-worker`). Each engine is
// started with PowerShell's Start-Process, which gives a console program its own
// console window, and `GX_LOG_DIR` names a scratch folder (never the user's log
// root). Ctrl+C is sent the way a person's keystroke reaches it: a helper
// PowerShell process detaches from its own console, attaches to the engine's, and
// raises CTRL_C_EVENT there. Then:
//
//   1. engine A is interrupted: it must exit 0 and leave `engine.stop` (info, with
//      its reason) and `log.stop` as its last two records;
//   2. engine B starts beside nothing: it must not name A (A finished) and is then
//      killed outright (a forced stop runs none of its code);
//   3. engine C starts: it must name B (`log.previous_unfinished`: B's file, last
//      sequence number and last timestamp) and not A.
//   4. the same three runs for the Editor's MCP server, the Playout shell and the
//      Editor shell (`cargo build -p gx-editor-mcp -p gx-playout-shell -p
//      gx-editor-shell`): the first ends in order (the MCP server's input is
//      closed; a shell's window is asked to close, as its close button does) and
//      must end with `log.stop`; the second must not name it and is killed; the
//      third must name the second. Each shell gets a scratch WebView2 folder, the
//      Editor a scratch package folder and the MCP server a scratch store.
//
// Other ways to end engine A, for the record (`live-check-result.json` is written by
// the last run, so run the default last):
//
//   --break   Ctrl+Break instead: the same result is required.
//   (Since 2.18 a window close is orderly and engine.stop names the exact event:
//   see docs/evidence/2.18. The --close note below describes 2.16 as it was.)
//   --close   the console window's close button: NOT required to pass and expected
//             not to. Windows ends the process as soon as the `ctrlc` crate's
//             system handler returns, before the engine has finished its log, so
//             `engine.stop` is usually written and `log.stop` is not, and engine B
//             then names A (its last event is `engine.stop`).
//
// The script exits 1 if any of it fails, and stops everything it started.

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const EXE = (name) => join(ROOT, "target", "debug", `${name}.exe`);
const WORKER = EXE("gx-render-worker");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const scratch = mkdtempSync(join(tmpdir(), "gx-live-2-16-"));
const logs = join(scratch, "logs");
mkdirSync(logs, { recursive: true });
const journal = join(scratch, "journal.json");
const started = [];

const watchdog = setTimeout(() => {
  console.log(`\nFAILED: the check did not finish in 6 minutes; scratch kept at ${scratch}`);
  for (const pid of started) spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`]);
  process.exit(2);
}, 360_000);

function powershell(script, timeout = 60_000) {
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", timeout });
  if (result.error) throw result.error;
  return result;
}

/** Start the engine in its own console; the process id. */
function startEngine() {
  const script = `$env:GX_LOG_DIR = '${logs}'; $p = Start-Process -FilePath '${WORKER}' -ArgumentList '--port','0','--asset-port','0','--recovery-journal','${journal}' -PassThru; $p.Id`;
  const pid = Number.parseInt(powershell(script).stdout.trim(), 10);
  if (!Number.isInteger(pid)) throw new Error("the engine did not start");
  started.push(pid);
  return pid;
}

/**
 * Engine A's whole life in one PowerShell, so that its exit code is real: start it
 * in its own console, give it time to write a heartbeat, raise a Ctrl+C in that
 * console from a helper that is not part of it (the helper detaches from its own
 * console, attaches to the engine's, ignores the event itself and raises
 * CTRL_C_EVENT), and wait for it to end.
 */
function runAndInterrupt(event) {
  const helper = join(scratch, "interrupt.ps1");
  writeFileSync(helper, [
    "param([int]$TargetPid, [int]$Event = 0)",
    "Add-Type -Namespace W -Name K -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern bool FreeConsole(); [DllImport(\"kernel32.dll\")] public static extern bool AttachConsole(uint p); [DllImport(\"kernel32.dll\")] public static extern bool SetConsoleCtrlHandler(IntPtr h, bool a); [DllImport(\"kernel32.dll\")] public static extern bool GenerateConsoleCtrlEvent(uint e, uint g);'",
    "[void][W.K]::FreeConsole()",
    "if (-not [W.K]::AttachConsole($TargetPid)) { Write-Output 'attach failed'; exit 3 }",
    "[void][W.K]::SetConsoleCtrlHandler([IntPtr]::Zero, $true)",
    "[void][W.K]::GenerateConsoleCtrlEvent($Event, 0)",
    "Start-Sleep -Milliseconds 800",
    "[void][W.K]::FreeConsole()",
  ].join("\r\n"));
  const run = join(scratch, "run-a.ps1");
  writeFileSync(run, [
    // A process inherits "ignore Ctrl+C" from the one that started it, and the
    // harness that runs this script may have set it. Clear it here, so the engine
    // is started as it would be from an ordinary terminal.
    "Add-Type -Namespace W -Name K -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern bool SetConsoleCtrlHandler(IntPtr h, bool a);'",
    "[void][W.K]::SetConsoleCtrlHandler([IntPtr]::Zero, $false)",
    `$env:GX_LOG_DIR = '${logs}'`,
    `$p = Start-Process -FilePath '${WORKER}' -ArgumentList '--port','0','--asset-port','0','--recovery-journal','${journal}' -PassThru`,
    "'pid=' + $p.Id",
    "Start-Sleep -Seconds 4",
    // 0 is Ctrl+C, 1 is Ctrl+Break, "close" is the console window's close button.
    event === "close"
      ? "[void]$p.CloseMainWindow(); 'helper=' + $(if ($p.MainWindowHandle -ne 0) { 0 } else { 'no window' })"
      : `& powershell.exe -NoProfile -NonInteractive -File '${helper}' -TargetPid $p.Id -Event ${event}`,
    event === "close" ? "" : "'helper=' + $LASTEXITCODE",
    "if ($p.WaitForExit(20000)) { 'exit=' + $p.ExitCode } else { 'exit=timeout' }",
  ].join("\r\n"));
  const out = powershell(`& '${run}'`, 90_000).stdout;
  const get = (key) => out.match(new RegExp(`${key}=([^\\s]+)`))?.[1];
  const pid = Number.parseInt(get("pid") ?? "", 10);
  if (!Number.isInteger(pid)) throw new Error(`engine A did not start: ${out}`);
  started.push(pid);
  return { pid, helper: get("helper"), exit: get("exit") };
}

function exited(pid) {
  return powershell(`if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { 'running' } else { 'gone' }`).stdout.trim() === "gone";
}

async function until(what, predicate, ms = 30_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(250);
  }
}

function recordsOf(pid, product = "engine") {
  const folder = join(logs, product);
  let files = [];
  try {
    files = readdirSync(folder).filter((name) => name.endsWith(".jsonl") && name.includes(`-${pid}-`));
  } catch {
    return [];
  }
  return files.sort().flatMap((file) =>
    readFileSync(join(folder, file), "utf8").split("\n").filter(Boolean).flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    }),
  );
}

const report = [];
const failures = [];
function check(name, ok, detail = "") {
  report.push({ name, ok, detail });
  if (!ok) failures.push(`${name} ${detail}`);
}
const heartbeat = (pid) => () => recordsOf(pid).some((r) => r.event === "engine.heartbeat");

/** The other processes that log through the sink, each run three times as the engine is. */
const OTHERS = [
  {
    name: "the Editor's MCP server", product: "mcp", exe: "gx-editor-mcp", ready: "mcp.start", stop: "mcp.stop",
    args: () => ["--root", join(scratch, "mcp-store")], env: {}, stdin: "pipe",
    // Closing its input ends the session, as its client closing the connection does.
    endInOrder: (child) => child.stdin.end(),
  },
  {
    name: "the Playout shell", product: "playout", exe: "gx-playout", ready: "playout.start", stop: "playout.stop",
    args: () => [], env: { WEBVIEW2_USER_DATA_FOLDER: join(scratch, "webview-playout") }, stdin: "ignore",
    endInOrder: (child) => closeWindow(child.pid),
  },
  {
    name: "the Editor shell", product: "editor", exe: "gx-editor", ready: "editor.start", stop: "editor.stop",
    args: () => [], env: { GX_EDITOR_PACKAGE_DIR: join(scratch, "packages"), WEBVIEW2_USER_DATA_FOLDER: join(scratch, "webview-editor") }, stdin: "ignore",
    endInOrder: (child) => closeWindow(child.pid),
  },
];

function launch(other) {
  mkdirSync(join(scratch, "mcp-store"), { recursive: true });
  const child = spawn(EXE(other.exe), other.args(), {
    env: { ...process.env, GX_LOG_DIR: logs, ...other.env },
    stdio: [other.stdin, "ignore", "ignore"],
    windowsHide: false,
  });
  child.on("error", () => {});
  if (!child.pid) throw new Error(`${other.name} did not start`);
  started.push(child.pid);
  return child;
}

/** Ask a window to close, as its close button does, once it has one (a kill runs no shutdown code). */
function closeWindow(pid) {
  powershell(`$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; for ($i = 0; $p -and $i -lt 40; $i++) { $p.Refresh(); if ($p.HasExited) { break }; if ($p.MainWindowHandle -ne 0) { [void]$p.CloseMainWindow() }; Start-Sleep -Milliseconds 500 }`, 30_000);
}

const gone = (child) => () => child.exitCode !== null || child.signalCode !== null;

/** One process, three runs: ended in order (not named), killed (named by the next). */
async function lifecycle(other) {
  const of = (child) => recordsOf(child.pid, other.product);
  const ready = (child) => () => of(child).some((r) => r.event === other.ready);
  const tag = other.name;

  const first = launch(other);
  await until(`${tag}: its first start`, ready(first), 60_000);
  other.endInOrder(first);
  await until(`${tag}: its orderly end`, gone(first), 30_000);
  const firstEvents = of(first).map((r) => r.event);
  check(`${tag} ended in order, with ${other.stop} and log.stop last`, firstEvents.includes(other.stop) && firstEvents.at(-1) === "log.stop", firstEvents.slice(-3).join(", "));

  const second = launch(other);
  await until(`${tag}: its second start`, ready(second), 60_000);
  const unfinished = of(second).find((r) => r.event === "log.previous_unfinished");
  check(`${tag}: the next start does not name a run that ended in order`, !unfinished, JSON.stringify(unfinished?.fields ?? null));
  second.kill();
  await until(`${tag}: the kill`, gone(second), 20_000);
  const secondRecords = of(second);
  check(`${tag}: a killed run writes no stop record`, !secondRecords.some((r) => r.event === other.stop || r.event === "log.stop"), secondRecords.slice(-2).map((r) => r.event).join(", "));

  const third = launch(other);
  await until(`${tag}: its third start`, ready(third), 60_000);
  const named = of(third).find((r) => r.event === "log.previous_unfinished");
  const last = secondRecords.at(-1);
  check(
    `${tag}: the next start names the killed run at warn, with its pid, last sequence number and last timestamp`,
    named?.level === "warn" && named?.fields?.predecessor_pid === second.pid && named?.fields?.last_seq === last?.seq && named?.fields?.last_ts === last?.ts,
    `${JSON.stringify(named?.fields ?? null)} against pid ${second.pid} seq ${last?.seq} ts ${last?.ts}`,
  );
  third.kill();
  await until(`${tag}: the last kill`, gone(third), 20_000);
  return { process: tag, ended_in_order_with: firstEvents.slice(-2), named: named?.fields ?? null };
}

let result = {};
try {
  // 1. A is interrupted from its console.
  const { pid: a, helper, exit } = runAndInterrupt(process.argv.includes("--close") ? "close" : process.argv.includes("--break") ? 1 : 0);
  // A Ctrl+Break kills the helper too (it only ignores Ctrl+C): its death is delivery.
  const breakKilledHelper = process.argv.includes("--break") && helper === "-1073741510";
  check("the Ctrl+C was delivered", helper === "0" || breakKilledHelper, `helper exit ${helper}`);
  const aRecords = recordsOf(a);
  const aEvents = aRecords.map((r) => r.event);
  const aStop = aRecords.find((r) => r.event === "engine.stop");
  check("engine A ended on its own after the interrupt, with exit code 0", exit === "0", `exit ${exit}`);
  check("engine A wrote engine.stop at info with its reason", aStop?.level === "info" && /console/.test(aStop?.fields?.reason ?? ""), JSON.stringify(aStop ?? null));
  check("engine A's last two records are engine.stop and log.stop", aEvents.at(-2) === "engine.stop" && aEvents.at(-1) === "log.stop", aEvents.slice(-4).join(", "));
  check("engine A started with no predecessor to name", !aEvents.includes("log.previous_unfinished"));

  // 2. B is killed outright.
  const b = startEngine();
  await until("engine B's first heartbeat", heartbeat(b));
  const bBefore = recordsOf(b);
  check("engine B did not name A, which finished", !bBefore.some((r) => r.event === "log.previous_unfinished"), JSON.stringify(bBefore.find((r) => r.event === "log.previous_unfinished") ?? null));
  powershell(`Stop-Process -Id ${b} -Force`);
  await until("engine B to end", () => exited(b), 20_000);
  const bRecords = recordsOf(b);
  check("a killed engine writes no stop record", !bRecords.some((r) => r.event === "engine.stop" || r.event === "log.stop"), bRecords.slice(-2).map((r) => r.event).join(", "));

  // 3. C names B.
  const c = startEngine();
  await until("engine C to name its predecessor", () => recordsOf(c).some((r) => r.event === "log.previous_unfinished"));
  const named = recordsOf(c).find((r) => r.event === "log.previous_unfinished");
  const last = bRecords.at(-1);
  check("engine C names engine B's file", named?.fields?.predecessor_pid === b && /^worker-.*-1\.jsonl$/.test(named?.fields?.file ?? ""), JSON.stringify(named?.fields ?? null));
  check("it gives B's last sequence number and last timestamp", named?.fields?.last_seq === last?.seq && named?.fields?.last_ts === last?.ts, `${named?.fields?.last_seq} ${named?.fields?.last_ts} against ${last?.seq} ${last?.ts}`);
  check("it logs the finding at warn", named?.level === "warn");
  powershell(`Stop-Process -Id ${c} -Force`);

  // 4. The same for the other processes that log through the sink.
  const others = [];
  for (const other of OTHERS) others.push(await lifecycle(other));
  result = { engineA: { pid: a, tail: aRecords.slice(-3).map(({ event, level, fields }) => ({ event, level, fields })) }, engineC: { named }, others };
  writeFileSync(join(ROOT, "docs", "evidence", "2.16", "live-check-result.json"), JSON.stringify({ checks: report, ...result }, null, 2) + "\n");
} catch (error) {
  failures.push(`the check could not run: ${error.stack ?? error}`);
} finally {
  clearTimeout(watchdog);
  for (const pid of started) powershell(`Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`);
  await sleep(300);
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
