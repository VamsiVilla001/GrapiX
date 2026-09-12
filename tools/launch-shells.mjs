// Bring up the render engine and both application shells together.
//
// This is a development launcher, not a supervisor. The real supervisor is
// `services/render-engine/host`, and the rule it exists to keep — the host
// ensures an engine but never stops one (ADR B.4) — is deliberately *not*
// copied here. This script owns the processes it starts and kills them on
// exit, because a developer pressing ctrl-c expects their machine back.
//
// Order matters. The engine is started first and waited for, because both
// shells connect on launch and a shell that starts first would open showing a
// connection failure it then has to recover from.

import { spawn } from "node:child_process";
import { once } from "node:events";
import { createConnection } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

const CONTROL_PORT = 4400;
const ASSET_PORT = 4401;
const ENGINE_READY_TIMEOUT_MS = 20_000;

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

function start(label, colour, command, args) {
  const child = spawn(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
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

start("engine", "36", worker, ["--port", String(CONTROL_PORT)]);

if (!(await waitForEngine())) {
  console.error(`the render engine did not answer on ${CONTROL_PORT}; not starting the shells`);
  shutdown(1);
} else {
  console.log("engine ready — starting shells\n");
  start("editor", "34", "npx", [
    "tauri",
    "dev",
    "--config",
    "Editor/shell/tauri.conf.json",
    "--no-watch",
  ]);
  start("playout", "31", "npx", [
    "tauri",
    "dev",
    "--config",
    "Playout/shell/tauri.conf.json",
    "--no-watch",
  ]);
  await once(process, "SIGINT").catch(() => {});
}
