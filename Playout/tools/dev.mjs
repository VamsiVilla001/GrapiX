import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const playoutRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const repositoryRoot = path.resolve(playoutRoot, "..");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

const processes = [
  {
    name: "native renderer",
    command: "cargo",
    shell: false,
    args: [
      "run",
      "--manifest-path",
      "services/render-daemon/Cargo.toml"
    ]
  },
  {
    name: "Playout control",
    command: npmCommand,
    shell: process.platform === "win32",
    args: ["run", "dev", "-w", "@grapix/playout-control"]
  },
  {
    name: "Playout web",
    command: npmCommand,
    shell: process.platform === "win32",
    args: ["run", "dev", "-w", "@grapix/playout-web"]
  }
].map((definition) => ({
  ...definition,
  child: spawn(definition.command, definition.args, {
    cwd: repositoryRoot,
    stdio: "inherit",
    shell: definition.shell,
    windowsHide: true
  })
}));

let shuttingDown = false;

for (const processDefinition of processes) {
  processDefinition.child.once("error", (error) => {
    console.error(
      `[playout] ${processDefinition.name} failed to start: ${error.message}`
    );
    shutdown(1);
  });
  processDefinition.child.once("exit", (code, signal) => {
    if (shuttingDown) return;
    console.error(
      `[playout] ${processDefinition.name} exited (${signal ?? code ?? "unknown"})`
    );
    shutdown(code && code !== 0 ? code : 1);
  });
}

process.once("SIGINT", () => shutdown(0));
process.once("SIGTERM", () => shutdown(0));

function shutdown(exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const processDefinition of processes) {
    if (!processDefinition.child.killed) {
      processDefinition.child.kill();
    }
  }
  setTimeout(() => process.exit(exitCode), 250);
}
