#!/usr/bin/env node

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.resolve(scriptDirectory, "../..");
const executableSuffix = process.platform === "win32" ? ".exe" : "";
const daemonExecutable = path.join(
  workspace,
  "services",
  "render-daemon",
  "target",
  "debug",
  `grapix-render-daemon${executableSuffix}`
);
const apiEntry = path.join(workspace, "services", "api-server", "dist", "index.js");
const soakEntry = path.join(scriptDirectory, "run-soak.mjs");
const temporaryRoot = await mkdtemp(path.join(tmpdir(), "grapix-e2e-"));
const children = [];
const token = "0123456789abcdef".repeat(4);
const environment = {
  ...process.env,
  GRAPIX_DATA_ROOT: path.join(temporaryRoot, "data"),
  GRAPIX_RENDER_DAEMON_TOKEN: token,
  GRAPIX_RENDER_DAEMON_HOST: "127.0.0.1",
  GRAPIX_RENDER_DAEMON_PORT: "4200",
  GRAPIX_API_HOST: "127.0.0.1",
  GRAPIX_API_PORT: "4100",
  GRAPIX_SOAK_MINUTES: process.env.GRAPIX_SOAK_MINUTES ?? "0.05"
};

try {
  const daemon = startChild(daemonExecutable, [], "render daemon");
  const api = startChild(process.execPath, [apiEntry], "API server");
  await waitForHealth(api, daemon);

  const soak = spawn(process.execPath, [soakEntry], {
    cwd: workspace,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  const [exitCode, stdout, stderr] = await collect(soak);
  if (exitCode !== 0) {
    throw new Error(`soak exited with ${exitCode}: ${stderr || stdout}`);
  }

  const report = JSON.parse(stdout);
  process.stdout.write(`${JSON.stringify({
    pass: report.pass,
    sceneCount: report.sceneCount,
    takes: report.takes,
    patches: report.patches,
    automationActions: report.automationActions,
    samples: report.samples,
    final: report.final,
    limitations: report.limitations
  }, null, 2)}\n`);
  if (!report.pass) {
    process.exitCode = 1;
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  for (const child of children.reverse()) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
    }
  }
  await Promise.all(children.map((child) => waitForExit(child)));
  await rm(temporaryRoot, { recursive: true, force: true });
}

function startChild(command, args, name) {
  const child = spawn(command, args, {
    cwd: workspace,
    env: environment,
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true
  });
  child.processName = name;
  child.errorText = "";
  child.stderr.on("data", (chunk) => {
    child.errorText = `${child.errorText}${chunk}`.slice(-65_536);
  });
  children.push(child);
  return child;
}

async function waitForHealth(api, daemon) {
  const deadline = Date.now() + 15_000;
  let lastError = "not attempted";

  while (Date.now() < deadline) {
    assertRunning(api);
    assertRunning(daemon);
    try {
      const health = await fetch("http://127.0.0.1:4100/health");
      const status = await fetch("http://127.0.0.1:4100/api/render-daemon/status");
      if (health.ok && status.ok) return;
      lastError = `health=${health.status}, daemon=${status.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`local stack did not become healthy: ${lastError}`);
}

function assertRunning(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    throw new Error(
      `${child.processName} exited early (${child.exitCode ?? child.signalCode}): ${child.errorText}`
    );
  }
}

function collect(child) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code) => resolve([code, stdout, stderr]));
  });
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, 5_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}
