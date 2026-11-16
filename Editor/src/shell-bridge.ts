// The one place the Editor's web layer calls its shell from (build-plan 2.13,
// ADR-0004 §2, §6).
//
// Every call gets a correlation id, minted here and sent as a request header,
// so the shell scopes the command to it and every record the command causes,
// in the shell, the asset plane and the engine, carries it. The call's end (its
// command, its id, how long it took, `ok` or the error's code) is reported to
// the shell's log through `cmd_log`. Never its arguments: a call can carry a
// path, a document or a credential, and the shell already records what it did
// with them.
//
// An error that comes back from the shell is remembered with the id of the call
// that caused it (`corrOf`), so the line the author reads can quote it. Uncaught
// errors, unhandled promise rejections and `console.error` are reported too,
// each with an id of its own.
//
// This file is the one place a command name is passed as a variable: every
// other call site names its command literally (the boundary guard, R4).

/** The request header a call's id travels in. Must match `gx_telemetry::ui`. */
export const CORR_HEADER = "x-gx-corr";

/** The slice of Tauri's core bridge this layer uses. */
export interface RawCore {
  invoke<T>(
    command: string,
    args?: Record<string, unknown>,
    options?: { headers?: Record<string, string> },
  ): Promise<T>;
}

/** One entry for the shell's log (`gx_telemetry::ui::UiEntry`). */
export interface UiEntry {
  readonly kind: "ui.call" | "ui.error" | "ui.rejection" | "ui.console";
  readonly level?: "debug" | "info";
  readonly corr?: string;
  readonly command?: string;
  readonly result?: string;
  readonly durationMs?: number;
  readonly message?: string;
  readonly source?: string;
  readonly stack?: string;
}

export interface Bridge {
  /** Call a shell command inside a correlation id of its own. */
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  /** Write one entry to the shell's log. Best effort: never throws. */
  report(entry: UiEntry): void;
  /** A new id. */
  mint(): string;
}

export interface BridgeOptions {
  /** What mints the id: `ed` for the Editor. */
  readonly prefix?: string;
  /** Commands whose successful calls are written at debug (polls). */
  readonly quiet?: ReadonlySet<string>;
  readonly now?: () => number;
  readonly random?: () => string;
}

const failures = new WeakMap<object, string>();

/** The id of the call an error came back from, if it came back from one. */
export function corrOf(error: unknown): string | undefined {
  return typeof error === "object" && error !== null ? failures.get(error) : undefined;
}

/** `text` with the id of the call that caused `error` after it, so the line an
 *  author reads can be quoted and its records found. */
export function quoteCorr(text: string, error: unknown): string {
  const corr = corrOf(error);
  return corr === undefined ? text : `${text} [${corr}]`;
}

function randomPart(): string {
  const bytes = new Uint8Array(4);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** `commandRefused:revisionMismatch`, `unreachable`, `error`: what to call a failure in a log. */
function codeOf(error: unknown): string {
  if (typeof error !== "object" || error === null) return "error";
  const failure = error as { error?: unknown; code?: unknown; name?: unknown; cause?: { refusal?: unknown } };
  for (const candidate of [failure.error, failure.code, failure.name]) {
    if (typeof candidate === "string" && candidate !== "") {
      const refusal = failure.cause?.refusal;
      return candidate === "commandRefused" && typeof refusal === "string"
        ? `${candidate}:${refusal}`
        : candidate;
    }
  }
  return "error";
}

/** Wrap `core` so each call has an id and its end is on record. */
export function createBridge(core: RawCore, options: BridgeOptions = {}): Bridge {
  const prefix = options.prefix ?? "ed";
  const quiet = options.quiet ?? new Set<string>();
  const now = options.now ?? (() => performance.now());
  const random = options.random ?? randomPart;
  let count = 0;
  const mint = (): string => {
    count += 1;
    return `${prefix}-${random()}-${count}`;
  };

  const report = (entry: UiEntry): void => {
    try {
      // The log's own call is not reported, or every report would cause another.
      void Promise.resolve(
        core.invoke<void>("cmd_log", { entry }, { headers: { [CORR_HEADER]: mint() } }),
      ).catch(() => undefined);
    } catch {
      // A log that cannot be written is not a reason to fail the call it describes.
    }
  };

  const invoke = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
    if (command === "cmd_log") return core.invoke<T>(command, args);
    const corr = mint();
    const started = now();
    try {
      const value = await core.invoke<T>(command, args, { headers: { [CORR_HEADER]: corr } });
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

/** What `installCapture` needs of a window. */
export interface CaptureHost {
  addEventListener(type: string, listener: (event: unknown) => void): void;
}

/** At most this many reports in one window of this length; the rest are counted. */
const MAX_REPORTS = 60;
const REPORT_WINDOW_MS = 10_000;
const MAX_TEXT = 2_000;

function text(value: unknown): string {
  if (typeof value === "string") return value.slice(0, MAX_TEXT);
  if (value instanceof Error) return `${value.name}: ${value.message}`.slice(0, MAX_TEXT);
  try {
    return (JSON.stringify(value) ?? String(value)).slice(0, MAX_TEXT);
  } catch {
    return String(value).slice(0, MAX_TEXT);
  }
}

function stackOf(value: unknown): string | undefined {
  if (typeof value === "object" && value !== null && "stack" in value) {
    const stack = (value as { stack?: unknown }).stack;
    if (typeof stack === "string") return stack;
  }
  return undefined;
}

/**
 * Report uncaught errors, unhandled promise rejections and `console.error` to
 * the shell's log, each under an id of its own, so a failure no call reported is
 * still on record. At most {@link MAX_REPORTS} in {@link REPORT_WINDOW_MS}; what
 * is over the limit is counted and said in the next window's first report.
 */
export function installCapture(
  host: CaptureHost,
  console: { error: (...args: unknown[]) => void },
  bridge: Pick<Bridge, "report" | "mint">,
  now: () => number = () => Date.now(),
): void {
  let windowStart = now();
  let sent = 0;
  let dropped = 0;
  const allow = (): boolean => {
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
    const failure = event as {
      message?: unknown; filename?: unknown; lineno?: unknown; colno?: unknown; error?: unknown;
    };
    const stack = stackOf(failure.error);
    bridge.report({
      kind: "ui.error",
      corr: bridge.mint(),
      message: text(failure.message ?? failure.error),
      source: `${String(failure.filename ?? "")}:${String(failure.lineno ?? 0)}:${String(failure.colno ?? 0)}`,
      ...(stack === undefined ? {} : { stack }),
    });
  });

  host.addEventListener("unhandledrejection", (event) => {
    if (!allow()) return;
    const reason = (event as { reason?: unknown }).reason;
    const stack = stackOf(reason);
    bridge.report({
      kind: "ui.rejection",
      corr: bridge.mint(),
      message: text(reason),
      ...(stack === undefined ? {} : { stack }),
    });
  });

  const original = console.error.bind(console);
  let reporting = false;
  console.error = (...args: unknown[]): void => {
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
