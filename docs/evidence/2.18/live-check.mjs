// 2.18 live check: a real engine ended from its console (Ctrl+C, Ctrl+Break, and
// the console window's close button) stops in order, on record, naming the event.
//
//   node docs/evidence/2.18/live-check.mjs
//
// Needs the debug worker (`cargo build -p gx-render-worker`). Each engine is
// started with PowerShell's Start-Process, which gives a console program its own
// console window, and `GX_LOG_DIR` names a scratch folder (never the user's log
// root). Ctrl+C and Ctrl+Break are raised the way a keystroke reaches the engine:
// a helper PowerShell detaches from its own console, attaches to the engine's and
// raises the event there. The close is the window's own close request
// (`CloseMainWindow`, what the close button sends), which reaches a console
// program as CTRL_CLOSE_EVENT.
//
// For each of the three events, one engine:
//   - must end on its own with exit code 0;
//   - must write `engine.stop` at info whose reason names that event and no other;
//   - must have `engine.stop` and `log.stop` as its last two records.
// Then:
//   - an engine started after the three must name none of them (all finished);
//   - it is killed outright, and the engine after it must name it (so the naming
//     of a real kill, 2.16, still holds beside the new handler).
//
// Not run: logoff and shutdown (they would end the user's session, and Windows
// does not send them to a process that has loaded user32.dll).
//
// The script exits 1 if any of it fails, and stops everything it started.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const WORKER = join(ROOT, "target", "debug", "gx-render-worker.exe");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const scratch = mkdtempSync(join(tmpdir(), "gx-live-2-18-"));
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
 * One engine's whole life in one PowerShell, so that its exit code is real: start
 * it in its own console, give it time to write a heartbeat, end it from its
 * console (`event`: 0 is Ctrl+C, 1 is Ctrl+Break, "close" is the window's close
 * request) and wait for it to end.
 */
function runAndEnd(event) {
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
  const run = join(scratch, `run-${event}.ps1`);
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
    event === "close"
      ? "$p.Refresh(); if ($p.MainWindowHandle -ne 0) { 'helper=' + $(if ($p.CloseMainWindow()) { 0 } else { 'refused' }) } else { 'helper=nowindow' }"
      : `& powershell.exe -NoProfile -NonInteractive -File '${helper}' -TargetPid $p.Id -Event ${event}`,
    event === "close" ? "" : "'helper=' + $LASTEXITCODE",
    "if ($p.WaitForExit(20000)) { 'exit=' + $p.ExitCode } else { 'exit=timeout' }",
  ].join("\r\n"));
  const out = powershell(`& '${run}'`, 90_000).stdout;
  const get = (key) => out.match(new RegExp(`${key}=([^\\s]+)`))?.[1];
  const pid = Number.parseInt(get("pid") ?? "", 10);
  if (!Number.isInteger(pid)) throw new Error(`the engine did not start: ${out}`);
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

function recordsOf(pid) {
  const folder = join(logs, "engine");
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

const EVENTS = [
  { name: "Ctrl+C", event: 0, reason: "Ctrl+C at the console" },
  { name: "Ctrl+Break", event: 1, reason: "Ctrl+Break at the console" },
  { name: "a window close", event: "close", reason: "the console window was closed" },
];

let result = {};
try {
  const ended = [];
  for (const { name, event, reason } of EVENTS) {
    const { pid, helper, exit } = runAndEnd(event);
    // A Ctrl+Break kills the helper too (it only ignores Ctrl+C): its death is delivery.
    const delivered = helper === "0" || (event === 1 && helper === "-1073741510");
    check(`${name} was delivered`, delivered, `helper ${helper}`);
    const records = recordsOf(pid);
    const events = records.map((r) => r.event);
    const stop = records.find((r) => r.event === "engine.stop");
    check(`${name}: the engine ended on its own with exit code 0`, exit === "0", `exit ${exit}`);
    check(`${name}: engine.stop is at info and its reason is "${reason}"`, stop?.level === "info" && stop?.fields?.reason === reason, JSON.stringify(stop ?? null));
    check(`${name}: the last two records are engine.stop and log.stop`, events.at(-2) === "engine.stop" && events.at(-1) === "log.stop", events.slice(-4).join(", "));
    ended.push({ event: name, pid, exit, tail: records.slice(-2).map(({ event: e, level, fields }) => ({ event: e, level, fields })) });
  }

  // An engine after the three names none of them, and is then killed outright.
  const b = startEngine();
  await until("the next engine's first heartbeat", heartbeat(b));
  const bBefore = recordsOf(b);
  check("the next engine names none of the three, which all finished", !bBefore.some((r) => r.event === "log.previous_unfinished"), JSON.stringify(bBefore.find((r) => r.event === "log.previous_unfinished")?.fields ?? null));
  powershell(`Stop-Process -Id ${b} -Force`);
  await until("the killed engine to end", () => exited(b), 20_000);
  const bRecords = recordsOf(b);
  check("a killed engine still writes no stop record", !bRecords.some((r) => r.event === "engine.stop" || r.event === "log.stop"), bRecords.slice(-2).map((r) => r.event).join(", "));

  const c = startEngine();
  await until("the last engine to name its predecessor", () => recordsOf(c).some((r) => r.event === "log.previous_unfinished"));
  const named = recordsOf(c).filter((r) => r.event === "log.previous_unfinished");
  const last = bRecords.at(-1);
  check(
    "the engine after it names the killed one, once, with its pid, last sequence number and last timestamp",
    named.length === 1 && named[0].fields?.predecessor_pid === b && named[0].fields?.last_seq === last?.seq && named[0].fields?.last_ts === last?.ts,
    `${JSON.stringify(named.map((r) => r.fields))} against pid ${b} seq ${last?.seq} ts ${last?.ts}`,
  );
  powershell(`Stop-Process -Id ${c} -Force`);

  result = { ended, named: named[0]?.fields ?? null };
  writeFileSync(join(ROOT, "docs", "evidence", "2.18", "live-check-result.json"), JSON.stringify({ checks: report, ...result }, null, 2) + "\n");
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
