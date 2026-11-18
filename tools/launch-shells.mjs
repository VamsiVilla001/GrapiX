// Bring up the render engine and both application shells together.
//
// This is a development launcher, not a supervisor. The real supervisor is
// `services/render-engine/host`, and the rule it exists to keep — the host
// ensures an engine but never stops one (ADR B.4) — is deliberately *not*
// copied here. This script owns the processes it starts and kills them on
// exit, because a developer pressing ctrl-c expects their machine back.
//
// Order matters. The engine and both shells are built first, in one `cargo
// build`; then the engine is started and waited for, because both shells connect
// on launch and a shell that starts first would open showing a connection
// failure it then has to recover from (Playout attaches once, at launch, and
// does not retry).
//
// The shells are run as the executables they are, not through `tauri dev`: with
// both configs side by side, `tauri dev --config Playout/shell/tauri.conf.json`
// finds the Editor's app folder first and runs the Editor's program, and two of
// those then fight over one `gx-editor.exe` ("Access is denied"), which tears the
// whole arrangement down, engine included. Each shell embeds its web files
// (`frontendDist`) when it is built, so `npm run shells` builds the Editor's
// bundle first (package.json).

import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync } from "node:fs";
import { createConnection } from "node:net";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { enginePorts } from "./engine-ports.mjs";
import { shellArguments } from "./shell-args.mjs";

// The ports are the engine's, from the one place that names them (2.21).
const { control: CONTROL_PORT, asset: ASSET_PORT } = enginePorts();
const ENGINE_READY_TIMEOUT_MS = 20_000;
// The one folder the Editor writes its packages into and a co-located engine
// reads them from by path (5.10). The engine is started with it as
// --package-dir and the Editor is told it as GX_EDITOR_PACKAGE_DIR, so the two
// agree by construction. Nothing about it goes over the wire.
const PACKAGE_DIR = resolve("target", "dev-packages");

const children = [];
let shuttingDown = false;

/** Prefix every line a child prints, so three interleaved logs stay readable. */
function pipe(child, label, colour) {
  const tag = `\u001b[${colour}m${label.padEnd(8)}\u001b[0m`;
  for (const stream of [child.stdout, child.stderr]) {
    if (!stream) continue;
    let carry = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      const lines = (carry + chunk).split(/\r?\n/);
      carry = lines.pop() ?? "";
      for (const line of lines) if (line.length > 0) console.log(`${tag} ${line}`);
    });
  }
}

function start(label, colour, command, args, env = {}) {
  // The Windows shell is for the `.cmd` programs (npx); an `.exe` is started
  // directly. Either way an argument with a space in it stays one argument.
  const shell = process.platform === "win32" && !command.toLowerCase().endsWith(".exe");
  const child = spawn(command, shellArguments(args, { shell }), {
    stdio: ["ignore", "pipe", "pipe"],
    shell,
    env: { ...process.env, ...env },
  });
  pipe(child, label, colour);
  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    console.log(`\u001b[${colour}m${label.padEnd(8)}\u001b[0m exited (${signal ?? code})`);
    // One process leaving means the arrangement is no longer what was asked
    // for. Tearing the rest down is honest; leaving orphans is not.
    shutdown(typeof code === "number" && code !== 0 ? code : 0);
  });
  children.push(child);
  return child;
}

/** Wait until the control port accepts a connection. */
async function waitForEngine() {
  const deadline = Date.now() + ENGINE_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const reachable = await new Promise((resolve) => {
      const socket = createConnection({ host: "127.0.0.1", port: CONTROL_PORT });
      const settle = (value) => {
        socket.destroy();
        resolve(value);
      };
      socket.once("connect", () => settle(true));
      socket.once("error", () => settle(false));
      socket.setTimeout(500, () => settle(false));
    });
    if (reachable) return true;
    await delay(150);
  }
  return false;
}

/** Run `command` to its end with its output shown, and say whether it succeeded. */
function runToEnd(label, colour, command, args) {
  return new Promise((resolve) => {
    const shell = process.platform === "win32" && !command.toLowerCase().endsWith(".exe");
    const child = spawn(command, shellArguments(args, { shell }), {
      stdio: ["ignore", "pipe", "pipe"],
      shell,
    });
    pipe(child, label, colour);
    children.push(child);
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (child.exitCode === null) child.kill();
  }
  // Give the children a moment to die before the parent does, so their
  // last lines are not lost.
  setTimeout(() => process.exit(code), 250);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

const worker =
  process.platform === "win32"
    ? "target\\debug\\gx-render-worker.exe"
    : "target/debug/gx-render-worker";

console.log("GrapiX — render engine, Editor, Playout");
console.log(`  control plane  127.0.0.1:${CONTROL_PORT}`);
console.log(`  asset plane    127.0.0.1:${ASSET_PORT}`);
console.log("");

mkdirSync(PACKAGE_DIR, { recursive: true });
console.log(`  package folder ${PACKAGE_DIR}`);
// The engine and the shells are built together, so none of them is older than the
// others: a shell and an engine on different wire versions refuse each other (2.20).
const built = await runToEnd("build", "33", "cargo", [
  "build",
  "-p",
  "gx-render-worker",
  "-p",
  "gx-editor-shell",
  "-p",
  "gx-playout-shell",
]);

if (!built) {
  console.error("the engine and the shells did not build; nothing was started");
  shutdown(1);
} else {
  start("engine", "36", worker, ["--port", String(CONTROL_PORT), "--package-dir", PACKAGE_DIR]);

  if (!(await waitForEngine())) {
    console.error(`the render engine did not answer on ${CONTROL_PORT}; not starting the shells`);
    shutdown(1);
  } else {
    console.log("engine ready — starting shells\n");
    const exe = (name) =>
      process.platform === "win32" ? `target\\debug\\${name}.exe` : `target/debug/${name}`;
    start("editor", "34", exe("gx-editor"), [], { GX_EDITOR_PACKAGE_DIR: PACKAGE_DIR });
    start("playout", "31", exe("gx-playout"), []);
    await once(process, "SIGINT").catch(() => {});
  }
}
