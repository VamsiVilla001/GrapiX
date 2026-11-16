// The one place Playout's web layer calls its shell from (build-plan 2.13,
// ADR-0004 §2, §6). The Editor has the same bridge in TypeScript
// (`Editor/src/shell-bridge.ts`); each product keeps its own copy because
// Playout has no bundler and neither product may import the other (invariant 1).
// Both are tested against the same behaviour.
//
// Every call gets a correlation id, minted here and sent as a request header, so
// the shell scopes the command to it and every record the command causes, in the
// shell, the control plane and the engine, carries it. The call's end (its
// command, its id, how long it took, `ok` or the error's code) is reported to the
// shell's log through `cmd_log`. Never its arguments: `cmd_connect` carries a
// token. An error that comes back remembers the id of its call (`corrOf`), so the
// line the operator reads can quote it. Uncaught errors, unhandled promise
// rejections and `console.error` are reported too, each with an id of its own.

/** The request header a call's id travels in. Must match `gx_telemetry::ui`. */
export const CORR_HEADER = "x-gx-corr";

const failures = new WeakMap();

/** The id of the call an error came back from, if it came back from one.
 *  @param {unknown} error
 *  @returns {string | undefined} */
export function corrOf(error) {
  return typeof error === "object" && error !== null ? failures.get(error) : undefined;
}

function randomPart() {
  const bytes = new Uint8Array(4);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** `refused:revisionMismatch`, `unreachable`, `error`: what to call a failure in a log. */
function codeOf(error) {
  if (typeof error !== "object" || error === null) return "error";
  for (const candidate of [error.error, error.code, error.name]) {
    if (typeof candidate === "string" && candidate !== "") {
      const refusal = error.refusal;
      const name = typeof refusal === "string" ? refusal : typeof refusal?.refusal === "string" ? refusal.refusal : undefined;
      return candidate === "refused" && name !== undefined ? `${candidate}:${name}` : candidate;
    }
  }
  return "error";
}

/**
 * Wrap `core` (Tauri's `window.__TAURI__.core`) so each call has an id and its
 * end is on record.
 * @param {{ invoke(command: string, args?: object, options?: object): Promise<any> }} core
 * @param {{ prefix?: string, quiet?: Set<string>, now?: () => number, random?: () => string }} [options]
 */
export function createBridge(core, options = {}) {
  const prefix = options.prefix ?? "po";
  const quiet = options.quiet ?? new Set();
  const now = options.now ?? (() => performance.now());
  const random = options.random ?? randomPart;
  let count = 0;
  const mint = () => {
    count += 1;
    return `${prefix}-${random()}-${count}`;
  };

  const report = (entry) => {
    try {
      // The log's own call is not reported, or every report would cause another.
      Promise.resolve(core.invoke("cmd_log", { entry }, { headers: { [CORR_HEADER]: mint() } })).catch(() => undefined);
    } catch {
      // A log that cannot be written is not a reason to fail the call it describes.
    }
  };

  const invoke = async (command, args) => {
    if (command === "cmd_log") return core.invoke(command, args);
    const corr = mint();
    const started = now();
    try {
      const value = await core.invoke(command, args, { headers: { [CORR_HEADER]: corr } });
      report({
        kind: "ui.call",
        level: quiet.has(command) ? "debug" : "info",
        corr,
        command,
        result: "ok",
        durationMs: Math.max(0, Math.round(now() - started)),
      });
      return value;
    } catch (error) {
      if (typeof error === "object" && error !== null) failures.set(error, corr);
      report({
        kind: "ui.call",
        level: "info",
        corr,
        command,
        result: codeOf(error),
        durationMs: Math.max(0, Math.round(now() - started)),
      });
      throw error;
    }
  };
  return { invoke, report, mint };
}

/** At most this many reports in one window of this length; the rest are counted. */
const MAX_REPORTS = 60;
const REPORT_WINDOW_MS = 10_000;
const MAX_TEXT = 2_000;

function text(value) {
  if (typeof value === "string") return value.slice(0, MAX_TEXT);
  if (value instanceof Error) return `${value.name}: ${value.message}`.slice(0, MAX_TEXT);
  try {
    return (JSON.stringify(value) ?? String(value)).slice(0, MAX_TEXT);
  } catch {
    return String(value).slice(0, MAX_TEXT);
  }
}

function stackOf(value) {
  return typeof value === "object" && value !== null && typeof value.stack === "string" ? value.stack : undefined;
}

/**
 * Report uncaught errors, unhandled promise rejections and `console.error` to the
 * shell's log, each under an id of its own, so a failure no call reported is still
 * on record. At most 60 in 10 seconds; what is over the limit is counted and said
 * in the next window's first report.
 * @param {{ addEventListener(type: string, listener: (event: any) => void): void }} host
 * @param {{ error: (...args: unknown[]) => void }} console
 * @param {{ report(entry: object): void, mint(): string }} bridge
 * @param {() => number} [now]
 */
export function installCapture(host, console, bridge, now = () => Date.now()) {
  let windowStart = now();
  let sent = 0;
  let dropped = 0;
  const allow = () => {
    const at = now();
    if (at - windowStart >= REPORT_WINDOW_MS) {
      windowStart = at;
      sent = 0;
      if (dropped > 0) {
        bridge.report({ kind: "ui.console", corr: bridge.mint(), message: `${dropped} front-end reports were dropped` });
        dropped = 0;
        sent += 1;
      }
    }
    if (sent >= MAX_REPORTS) {
      dropped += 1;
      return false;
    }
    sent += 1;
    return true;
  };

  host.addEventListener("error", (event) => {
    if (!allow()) return;
    const stack = stackOf(event.error);
    bridge.report({
      kind: "ui.error",
      corr: bridge.mint(),
      message: text(event.message ?? event.error),
      source: `${String(event.filename ?? "")}:${String(event.lineno ?? 0)}:${String(event.colno ?? 0)}`,
      ...(stack === undefined ? {} : { stack }),
    });
  });

  host.addEventListener("unhandledrejection", (event) => {
    if (!allow()) return;
    const stack = stackOf(event.reason);
    bridge.report({
      kind: "ui.rejection",
      corr: bridge.mint(),
      message: text(event.reason),
      ...(stack === undefined ? {} : { stack }),
    });
  });

  const original = console.error.bind(console);
  let reporting = false;
  console.error = (...args) => {
    original(...args);
    if (reporting) return;
    reporting = true;
    try {
      if (allow()) {
        bridge.report({ kind: "ui.console", corr: bridge.mint(), message: args.map(text).join(" ").slice(0, MAX_TEXT) });
      }
    } finally {
      reporting = false;
    }
  };
}
