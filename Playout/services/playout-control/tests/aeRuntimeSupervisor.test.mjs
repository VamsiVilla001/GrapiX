import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AeRuntimeSupervisor } from "../dist/aeRuntimeSupervisor.js";

class FakeClient extends EventEmitter {
  connected = false;
  calls = [];
  eventListeners = new Set();
  constructor(options, behavior = {}) { super(); this.options = options; this.behavior = behavior; }
  async connect() {
    if (this.behavior.connectError) throw this.behavior.connectError;
    this.connected = true;
    return {
      kind: "hello-ack", protocolMajor: 2, protocolMinor: 0, sessionId: this.options.sessionId,
      capabilities: [], hostPid: this.behavior.hostPid ?? 200,
      fingerprint: { aeVersion: "26.3", adapterVersion: "1", adapterSha256: "a".repeat(64), pluginSetSha256: "b".repeat(64), suiteVersions: {} }
    };
  }
  onEvent(listener) {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }
  emitEvent(event) { for (const listener of this.eventListeners) listener(event); }
  async call(operation) {
    this.calls.push(operation);
    if (this.behavior.healthError && operation === "HEALTH") throw this.behavior.healthError;
    const result = operation === "HEALTH"
      ? { resident: true, driverMajor: 26, driverMinor: 3, pluginId: 1, projectPath: this.behavior.projectPath ?? null }
      : {};
    return { kind: "result", protocolMajor: 2, protocolMinor: 0, sessionId: this.options.sessionId, requestId: "r", sequence: 1, operation, ok: true, surface: "aegp-sdk", projectDigest: null, time: null, result };
  }
  async close() { this.connected = false; }
}

class FakeChild extends EventEmitter {
  pid = 200;
  exitCode = null;
  signals = [];
  kill(signal) { this.signals.push(signal); this.exitCode = 0; queueMicrotask(() => this.emit("exit", 0, signal)); return true; }
}

async function fixture(options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "grapix-ae-supervisor-"));
  const children = [];
  const clients = [];
  const behavior = { ...(options.behavior ?? {}) };
  // FakeChild deliberately lacks ChildProcess typing; the supervisor only needs pid/kill/once.
  // The factory accepts any runtime so tests can model the Windows process without spawning AE.
  const supervisor = new AeRuntimeSupervisor({
    dataRoot: root,
    autoHealth: false,
    maxRestartAttempts: 0,
    ...(options.projectLoadTimeoutMs !== undefined ? { projectLoadTimeoutMs: options.projectLoadTimeoutMs } : {}),
    spawnProcess: () => { const child = new FakeChild(); children.push(child); return child; },
    clientFactory: (clientOptions) => { const client = new FakeClient(clientOptions, behavior); clients.push(client); return client; }
  });
  return { root, supervisor, children, clients, behavior };
}

async function cleanup(state) { await state.supervisor.stop(); await rm(state.root, { recursive: true, force: true }); }

test("owned launch is ready only after authenticated health", async () => {
  const state = await fixture();
  try {
    const status = await state.supervisor.start({ executablePath: "afterfx.exe", projectDigest: "c".repeat(64) });
    assert.equal(status.state, "ready");
    assert.equal(status.ownership, "owned");
    assert.equal(status.pid, 200);
    assert.equal(status.aeBuild, "26.3");
    assert.deepEqual(state.clients[0].calls, ["HEALTH"]);
  } finally { await cleanup(state); }
});

test("a pinned mutation rechecks the live project bytes before dispatch", async () => {
  const state = await fixture();
  const projectPath = path.join(state.root, "live.aep");
  const original = "original project";
  const digest = createHash("sha256").update(original).digest("hex");
  await writeFile(projectPath, original);
  state.behavior.projectPath = projectPath;
  try {
    await state.supervisor.start({ executablePath: "afterfx.exe", projectPath, projectDigest: digest });
    await writeFile(projectPath, "replacement project");
    await assert.rejects(
      state.supervisor.call("SET_PROPERTY", {}, { expectedProjectDigest: digest }),
      (error) => error?.code === "PROJECT_DIGEST_MISMATCH"
    );
    assert.deepEqual(state.clients[0].calls, ["HEALTH", "HEALTH"], "only the identity read reached AE");
  } finally { await cleanup(state); }
});

test("PID mismatch is adopted and never killed", async () => {
  const state = await fixture({ behavior: { hostPid: 201 } });
  try {
    const status = await state.supervisor.start({ executablePath: "afterfx.exe" });
    assert.equal(status.ownership, "attached");
    await state.supervisor.stop();
    assert.deepEqual(state.children[0].signals, []);
  } finally { await cleanup(state); }
});

test("pipe loss degrades and process exit persists crash evidence", async () => {
  const state = await fixture();
  try {
    await state.supervisor.start({ executablePath: "afterfx.exe" });
    state.clients[0].emit("close");
    assert.equal(state.supervisor.status().state, "failed");
    state.children[0].emit("exit", 37, null);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(state.supervisor.status().crashCount, 1);
    assert.equal((await state.supervisor.readCrashState()).code, 37);
  } finally { await cleanup(state); }
});

test("attached runtime failure is explicit and never restarted", async () => {
  const state = await fixture({ behavior: { healthError: new Error("silent channel") } });
  try {
    await assert.rejects(state.supervisor.start({ attach: true, sessionId: "attached", token: "x".repeat(64) }), /silent channel/);
    assert.equal(state.supervisor.status().state, "failed");
    assert.match(state.supervisor.status().remedy, /will not kill/);
    assert.equal(state.children.length, 0);
  } finally { await cleanup(state); }
});

test("project change restarts the owned host and proves the replacement project", async () => {
  const state = await fixture();
  const replacementPath = path.join(state.root, "replacement.aep").replaceAll("\\", "/");
  const replacementContents = "replacement";
  const replacementDigest = createHash("sha256").update(replacementContents).digest("hex");
  await writeFile(replacementPath, replacementContents);
  state.behavior.projectPath = replacementPath;
  try {
    await state.supervisor.start({ executablePath: "afterfx.exe" });
    const status = await state.supervisor.restartWithProject({ projectPath: replacementPath, projectDigest: replacementDigest });
    assert.equal(status.state, "ready");
    assert.equal(status.ownership, "owned");
    assert.equal(status.projectDigest, replacementDigest);
    // The readiness HEALTH that proves the replacement is itself the successful command evidence.
    assert.equal(status.lastSuccessfulCommand, "HEALTH");
    assert.deepEqual(state.children[0].signals, ["SIGTERM"]);
    assert.equal(state.children.length, 2);
    assert.equal(state.clients.length, 2);
    assert.deepEqual(state.clients[1].calls, ["HEALTH"]);
  } finally { await cleanup(state); }
});

test("project replacement refuses the wrong project identity", async () => {
  const state = await fixture({ behavior: { projectPath: "C:/wrong/current.aep" }, projectLoadTimeoutMs: 20 });
  const replacementPath = path.join(state.root, "replacement.aep");
  await writeFile(replacementPath, "replacement");
  const replacementDigest = createHash("sha256").update("replacement").digest("hex");
  try {
    await state.supervisor.start({ executablePath: "afterfx.exe" });
    await assert.rejects(
      state.supervisor.restartWithProject({ projectPath: replacementPath, projectDigest: replacementDigest }),
      /opened C:\/wrong\/current\.aep instead of/
    );
    const status = state.supervisor.status();
    assert.equal(status.state, "failed");
    assert.equal(status.projectDigest, replacementDigest);
  } finally { await cleanup(state); }
});

test("automatic restarts keep their bounded attempt budget", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "grapix-ae-supervisor-budget-"));
  let attempts = 0;
  const supervisor = new AeRuntimeSupervisor({
    dataRoot: root,
    autoHealth: false,
    maxRestartAttempts: 1,
    spawnProcess: () => new FakeChild(),
    clientFactory: (options) => new FakeClient(options, { connectError: new Error(`failure ${++attempts}`) })
  });
  try {
    await assert.rejects(supervisor.start({ executablePath: "afterfx.exe" }), /failure 1/);
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    assert.equal(attempts, 2);
    assert.equal(supervisor.status().state, "failed");
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    assert.equal(attempts, 2);
  } finally {
    await supervisor.stop();
    await rm(root, { recursive: true, force: true });
  }
});
