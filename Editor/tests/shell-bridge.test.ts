// Correlation ids and front-end capture (build-plan 2.13): every shell call has
// an id sent as a header, its end is reported to the shell's log without its
// arguments, a failure remembers the id of its call, and uncaught errors,
// rejections and console.error are reported under ids of their own.

import { describe, expect, it } from "vitest";

import {
  CORR_HEADER,
  corrOf,
  createBridge,
  installCapture,
  quoteCorr,
  type CaptureHost,
  type RawCore,
  type UiEntry,
} from "../src/shell-bridge";

interface Call {
  readonly command: string;
  readonly args: Record<string, unknown> | undefined;
  readonly corr: string | undefined;
}

/** A shell that records every call and answers each by `answer`. */
function shellDouble(answer: (command: string) => unknown = () => "ok") {
  const calls: Call[] = [];
  const core: RawCore = {
    invoke: <T>(
      command: string,
      args?: Record<string, unknown>,
      options?: { headers?: Record<string, string> },
    ): Promise<T> => {
      calls.push({ command, args, corr: options?.headers?.[CORR_HEADER] });
      const result = answer(command);
      return result instanceof Error || (typeof result === "object" && result !== null && "rejects" in result)
        ? Promise.reject((result as { rejects?: unknown }).rejects ?? result)
        : Promise.resolve(result as T);
    },
  };
  const logged = (): UiEntry[] =>
    calls
      .filter((call) => call.command === "cmd_log")
      .map((call) => (call.args as { entry: UiEntry }).entry);
  return { core, calls, logged };
}

const PLAIN = /^[A-Za-z0-9_:-]{1,64}$/;

describe("a shell call", () => {
  it("carries an id of its own as a header and has its end reported with that id", async () => {
    const shell = shellDouble();
    const bridge = createBridge(shell.core, { prefix: "ed", now: () => 1000 });

    await bridge.invoke("cmd_scene_list", { project: "news" });
    await bridge.invoke("cmd_project_list");

    const sent = shell.calls.filter((call) => call.command !== "cmd_log");
    expect(sent.map((call) => call.command)).toEqual(["cmd_scene_list", "cmd_project_list"]);
    const [first, second] = sent.map((call) => call.corr);
    expect(first).toMatch(PLAIN);
    expect(first).toMatch(/^ed-/);
    expect(second).toMatch(PLAIN);
    expect(first).not.toBe(second);
    expect(shell.logged()).toEqual([
      { kind: "ui.call", level: "info", corr: first, command: "cmd_scene_list", result: "ok", durationMs: 0 },
      { kind: "ui.call", level: "info", corr: second, command: "cmd_project_list", result: "ok", durationMs: 0 },
    ]);
  });

  it("is reported without its arguments, however sensitive they are", async () => {
    const shell = shellDouble();
    const bridge = createBridge(shell.core, { prefix: "po" });
    const secret = "gx1.eyJzdWIiOiJvcCJ9.0123456789abcdef";

    await bridge.invoke("cmd_connect", { endpoint: "127.0.0.1:4100", token: secret });

    // The shell gets the arguments (that is the call); the log entry has none.
    expect(JSON.stringify(shell.calls[0]?.args)).toContain(secret);
    expect(JSON.stringify(shell.logged())).not.toContain(secret);
    expect(JSON.stringify(shell.logged())).not.toContain("127.0.0.1");
  });

  it("is written at debug when it is a poll and succeeds, and at info when it fails", async () => {
    let failing = false;
    const shell = shellDouble(() => (failing ? { rejects: { error: "notConnected" } } : "ok"));
    const bridge = createBridge(shell.core, { quiet: new Set(["cmd_status"]) });

    await bridge.invoke("cmd_status");
    failing = true;
    await expect(bridge.invoke("cmd_status")).rejects.toEqual({ error: "notConnected" });

    expect(shell.logged().map((entry) => [entry.level, entry.result])).toEqual([
      ["debug", "ok"],
      ["info", "notConnected"],
    ]);
  });

  it("returns the error it got, and remembers which call caused it", async () => {
    const refusal = { error: "commandRefused", detail: "stale", cause: { refusal: "revisionMismatch" } };
    const shell = shellDouble(() => ({ rejects: refusal }));
    const bridge = createBridge(shell.core);

    const caught = await bridge.invoke("cmd_execute", { command: {} }).catch((error: unknown) => error);

    expect(caught).toBe(refusal);
    const id = shell.calls[0]?.corr;
    expect(corrOf(caught)).toBe(id);
    expect(shell.logged()[0]).toMatchObject({ corr: id, command: "cmd_execute", result: "commandRefused:revisionMismatch" });
    // An error that is not an object has nowhere to keep it.
    expect(corrOf("a string")).toBeUndefined();
    expect(corrOf(undefined)).toBeUndefined();
  });

  it("is quoted after the line an author reads, when the line is about that call's failure", async () => {
    const failure = { error: "unreachable", detail: "no engine" };
    const shell = shellDouble(() => ({ rejects: failure }));
    const caught = await createBridge(shell.core).invoke("cmd_publish", {}).catch((error: unknown) => error);

    expect(quoteCorr("asset plane unreachable", caught)).toBe(`asset plane unreachable [${shell.calls[0]?.corr}]`);
    // An error from nowhere near a call is not given an id it never had.
    expect(quoteCorr("asset plane unreachable", { error: "unreachable" })).toBe("asset plane unreachable");
    expect(quoteCorr("plain", "a string")).toBe("plain");
  });

  it("does not report the log's own call, and a log that fails does not fail the call", async () => {
    const shell = shellDouble((command) => (command === "cmd_log" ? { rejects: "no log" } : "answer"));
    const bridge = createBridge(shell.core);

    await expect(bridge.invoke("cmd_object_kinds")).resolves.toBe("answer");
    await bridge.invoke("cmd_log", { entry: { kind: "ui.console", message: "x" } }).catch(() => undefined);

    // One call, one report of it; the log call (rejected) was not reported again.
    expect(shell.calls.map((call) => call.command)).toEqual(["cmd_object_kinds", "cmd_log", "cmd_log"]);
  });

  it("survives a shell whose invoke throws at once", async () => {
    let first = true;
    const core: RawCore = {
      invoke: <T>(command: string): Promise<T> => {
        if (command === "cmd_log") throw new Error("the bridge is gone");
        if (first) {
          first = false;
          return Promise.resolve("fine" as T);
        }
        return Promise.resolve("fine" as T);
      },
    };
    await expect(createBridge(core).invoke("cmd_default_endpoint")).resolves.toBe("fine");
  });
});

/** A window and a console that can be made to misbehave. */
function pageDouble() {
  const listeners = new Map<string, (event: unknown) => void>();
  const host: CaptureHost = { addEventListener: (type, listener) => void listeners.set(type, listener) };
  const written: unknown[][] = [];
  const console = { error: (...args: unknown[]): void => void written.push(args) };
  const entries: UiEntry[] = [];
  let count = 0;
  const bridge = { report: (entry: UiEntry) => void entries.push(entry), mint: () => `ed-t-${(count += 1)}` };
  return { listeners, host, console, written, entries, bridge };
}

describe("capture of what no call reported", () => {
  it("writes an uncaught error with its source and stack under an id of its own", () => {
    const page = pageDouble();
    installCapture(page.host, page.console, page.bridge);
    const failure = new Error("boom");

    page.listeners.get("error")?.({ message: "Uncaught Error: boom", filename: "main.js", lineno: 12, colno: 5, error: failure });

    expect(page.entries).toEqual([
      {
        kind: "ui.error",
        corr: "ed-t-1",
        message: "Uncaught Error: boom",
        source: "main.js:12:5",
        stack: failure.stack,
      },
    ]);
  });

  it("writes an unhandled rejection, whatever was thrown", () => {
    const page = pageDouble();
    installCapture(page.host, page.console, page.bridge);

    page.listeners.get("unhandledrejection")?.({ reason: new TypeError("not a function") });
    page.listeners.get("unhandledrejection")?.({ reason: { error: "unreachable" } });
    page.listeners.get("unhandledrejection")?.({ reason: "plain text" });

    expect(page.entries.map((entry) => [entry.kind, entry.message])).toEqual([
      ["ui.rejection", "TypeError: not a function"],
      ["ui.rejection", '{"error":"unreachable"}'],
      ["ui.rejection", "plain text"],
    ]);
    expect(new Set(page.entries.map((entry) => entry.corr)).size).toBe(3);
  });

  it("still prints to the console, and reports the message once", () => {
    const page = pageDouble();
    const original = page.console.error;
    installCapture(page.host, page.console, page.bridge);

    page.console.error("it failed:", { code: 7 }, new Error("deep"));

    expect(page.written).toEqual([["it failed:", { code: 7 }, expect.any(Error)]]);
    expect(page.console.error).not.toBe(original);
    expect(page.entries).toHaveLength(1);
    expect(page.entries[0]).toMatchObject({ kind: "ui.console", message: 'it failed: {"code":7} Error: deep' });
  });

  it("bounds a long message", () => {
    const page = pageDouble();
    installCapture(page.host, page.console, page.bridge);
    page.console.error("x".repeat(10_000));
    expect(page.entries[0]?.message?.length).toBe(2_000);
  });

  it("writes at most sixty reports in ten seconds and says how many it dropped in the next window", () => {
    const page = pageDouble();
    let clock = 0;
    installCapture(page.host, page.console, page.bridge, () => clock);

    for (let i = 0; i < 100; i += 1) page.console.error(`noise ${i}`);
    expect(page.entries).toHaveLength(60);
    expect(page.written).toHaveLength(100);

    clock = 10_000;
    page.console.error("after the window");
    expect(page.entries.map((entry) => entry.message).slice(-2)).toEqual(["40 front-end reports were dropped", "after the window"]);
  });
});
