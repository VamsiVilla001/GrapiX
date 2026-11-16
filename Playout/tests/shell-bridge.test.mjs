// Correlation ids and front-end capture (build-plan 2.13), Playout's copy of the
// bridge. The Editor's `shell-bridge.test.ts` holds the same expectations: every
// shell call has an id sent as a header, its end is reported to the shell's log
// without its arguments, a failure remembers the id of its call, and uncaught
// errors, rejections and console.error are reported under ids of their own.

import assert from "node:assert/strict";
import test from "node:test";

import { CORR_HEADER, corrOf, createBridge, installCapture } from "../web/shell-bridge.js";

const PLAIN = /^[A-Za-z0-9_:-]{1,64}$/;

/** A shell that records every call and answers each by `answer`. */
function shellDouble(answer = () => "ok") {
  const calls = [];
  const core = {
    invoke(command, args, options) {
      calls.push({ command, args, corr: options?.headers?.[CORR_HEADER] });
      const result = answer(command);
      return result && typeof result === "object" && "rejects" in result
        ? Promise.reject(result.rejects)
        : Promise.resolve(result);
    },
  };
  const logged = () => calls.filter((call) => call.command === "cmd_log").map((call) => call.args.entry);
  return { core, calls, logged };
}

test("a shell call carries an id of its own as a header and has its end reported with that id", async () => {
  const shell = shellDouble();
  const bridge = createBridge(shell.core, { prefix: "po", now: () => 1000 });

  await bridge.invoke("cmd_take", { takeId: "lower-third" });
  await bridge.invoke("cmd_clear", {});

  const sent = shell.calls.filter((call) => call.command !== "cmd_log");
  assert.deepEqual(sent.map((call) => call.command), ["cmd_take", "cmd_clear"]);
  const [first, second] = sent.map((call) => call.corr);
  assert.match(first, PLAIN);
  assert.match(first, /^po-/);
  assert.match(second, PLAIN);
  assert.notEqual(first, second);
  assert.deepEqual(shell.logged(), [
    { kind: "ui.call", level: "info", corr: first, command: "cmd_take", result: "ok", durationMs: 0 },
    { kind: "ui.call", level: "info", corr: second, command: "cmd_clear", result: "ok", durationMs: 0 },
  ]);
});

test("a call is reported without its arguments, however sensitive they are", async () => {
  const shell = shellDouble();
  const bridge = createBridge(shell.core);
  const secret = "gx1.eyJzdWIiOiJvcCJ9.0123456789abcdef";

  await bridge.invoke("cmd_connect", { endpoint: "127.0.0.1:4100", token: secret });

  assert.ok(JSON.stringify(shell.calls[0].args).includes(secret), "the shell gets the arguments");
  assert.ok(!JSON.stringify(shell.logged()).includes(secret));
  assert.ok(!JSON.stringify(shell.logged()).includes("127.0.0.1"));
});

test("a poll is written at debug when it succeeds and at info when it fails", async () => {
  let failing = false;
  const shell = shellDouble(() => (failing ? { rejects: { error: "notConnected" } } : "ok"));
  const bridge = createBridge(shell.core, { quiet: new Set(["cmd_status"]) });

  await bridge.invoke("cmd_status");
  failing = true;
  await assert.rejects(bridge.invoke("cmd_status"), { error: "notConnected" });

  assert.deepEqual(shell.logged().map((entry) => [entry.level, entry.result]), [
    ["debug", "ok"],
    ["info", "notConnected"],
  ]);
});

test("an error is returned as it came, and remembers which call caused it", async () => {
  const refusal = { error: "refused", refusal: { refusal: "unknownTake" }, detail: "no such take" };
  const shell = shellDouble(() => ({ rejects: refusal }));
  const bridge = createBridge(shell.core);

  const caught = await bridge.invoke("cmd_take", {}).catch((error) => error);

  assert.equal(caught, refusal);
  const id = shell.calls[0].corr;
  assert.equal(corrOf(caught), id);
  assert.equal(shell.logged()[0].corr, id);
  assert.equal(shell.logged()[0].result, "refused:unknownTake");
  assert.equal(corrOf("a string"), undefined);
  assert.equal(corrOf(undefined), undefined);
});

test("the log's own call is not reported, and a log that fails does not fail the call", async () => {
  const shell = shellDouble((command) => (command === "cmd_log" ? { rejects: "no log" } : "answer"));
  const bridge = createBridge(shell.core);

  assert.equal(await bridge.invoke("cmd_default_endpoint"), "answer");
  await bridge.invoke("cmd_log", { entry: { kind: "ui.console", message: "x" } }).catch(() => undefined);

  assert.deepEqual(shell.calls.map((call) => call.command), ["cmd_default_endpoint", "cmd_log", "cmd_log"]);
});

test("a shell whose invoke throws at once does not fail the call it was asked to describe", async () => {
  const core = {
    invoke(command) {
      if (command === "cmd_log") throw new Error("the bridge is gone");
      return Promise.resolve("fine");
    },
  };
  assert.equal(await createBridge(core).invoke("cmd_default_endpoint"), "fine");
});

/** A window and a console that can be made to misbehave. */
function pageDouble() {
  const listeners = new Map();
  const host = { addEventListener: (type, listener) => listeners.set(type, listener) };
  const written = [];
  const console = { error: (...args) => written.push(args) };
  const entries = [];
  let count = 0;
  const bridge = { report: (entry) => entries.push(entry), mint: () => `po-t-${(count += 1)}` };
  return { listeners, host, console, written, entries, bridge };
}

test("an uncaught error is written with its source and stack under an id of its own", () => {
  const page = pageDouble();
  installCapture(page.host, page.console, page.bridge);
  const failure = new Error("boom");

  page.listeners.get("error")({ message: "Uncaught Error: boom", filename: "main.js", lineno: 12, colno: 5, error: failure });

  assert.deepEqual(page.entries, [
    { kind: "ui.error", corr: "po-t-1", message: "Uncaught Error: boom", source: "main.js:12:5", stack: failure.stack },
  ]);
});

test("an unhandled rejection is written, whatever was thrown", () => {
  const page = pageDouble();
  installCapture(page.host, page.console, page.bridge);

  page.listeners.get("unhandledrejection")({ reason: new TypeError("not a function") });
  page.listeners.get("unhandledrejection")({ reason: { error: "unreachable" } });
  page.listeners.get("unhandledrejection")({ reason: "plain text" });

  assert.deepEqual(page.entries.map((entry) => [entry.kind, entry.message]), [
    ["ui.rejection", "TypeError: not a function"],
    ["ui.rejection", '{"error":"unreachable"}'],
    ["ui.rejection", "plain text"],
  ]);
  assert.equal(new Set(page.entries.map((entry) => entry.corr)).size, 3);
});

test("console.error still prints, and is reported once", () => {
  const page = pageDouble();
  const original = page.console.error;
  installCapture(page.host, page.console, page.bridge);

  page.console.error("it failed:", { code: 7 }, new Error("deep"));

  assert.equal(page.written.length, 1);
  assert.notEqual(page.console.error, original);
  assert.equal(page.entries.length, 1);
  assert.equal(page.entries[0].kind, "ui.console");
  assert.equal(page.entries[0].message, 'it failed: {"code":7} Error: deep');
});

test("a long message is bounded", () => {
  const page = pageDouble();
  installCapture(page.host, page.console, page.bridge);
  page.console.error("x".repeat(10_000));
  assert.equal(page.entries[0].message.length, 2_000);
});

test("at most sixty reports in ten seconds are written, and the next window says how many were dropped", () => {
  const page = pageDouble();
  let clock = 0;
  installCapture(page.host, page.console, page.bridge, () => clock);

  for (let i = 0; i < 100; i += 1) page.console.error(`noise ${i}`);
  assert.equal(page.entries.length, 60);
  assert.equal(page.written.length, 100);

  clock = 10_000;
  page.console.error("after the window");
  assert.deepEqual(page.entries.slice(-2).map((entry) => entry.message), ["40 front-end reports were dropped", "after the window"]);
});
