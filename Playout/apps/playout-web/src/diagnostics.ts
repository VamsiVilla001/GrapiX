/**
 * The operator UI's own half of the console.
 *
 * Half of a Playout failure never reaches the control service: a request that could not be
 * sent, a monitor stream that stopped painting, a render that threw. Those used to land in
 * the browser devtools console — which is not open on an operator station, and on the
 * packaged desktop build is not reachable at all.
 *
 * So the UI keeps its own bounded log in the same shape as the service's, and the console
 * panel shows both merged. `origin` is the only added field, because "the service refused
 * this" and "this window could not ask" call for different actions.
 */

import type { DiagnosticLevel, DiagnosticRecord, PlayoutDiagnosticDetail } from "./api";
import { PlayoutRequestError } from "./api";

export interface ConsoleRecord extends DiagnosticRecord {
  origin: "ui" | "service";
}

/** Same ceiling as the service's log. Bounded so a repeating failure cannot grow the tab. */
const CAPACITY = 300;

let records: ConsoleRecord[] = [];
let sequence = 0;
const listeners = new Set<(record: ConsoleRecord) => void>();
let captureInstalled = false;

/**
 * Record something that failed in this window.
 *
 * `error` is unwrapped for its detail when it is a `PlayoutRequestError`, so a refused
 * request keeps the service's cause, remedy and context instead of being flattened back to
 * the one string this whole change exists to replace.
 */
export function recordUiDiagnostic(entry: {
  level: DiagnosticLevel;
  source: string;
  message?: string;
  error?: unknown;
  context?: Record<string, unknown>;
}): ConsoleRecord {
  const detail = describeUiError(entry.error, entry.message);
  const merged =
    detail && entry.context ? { ...detail, context: { ...entry.context, ...detail.context } } : detail;

  sequence += 1;
  const record: ConsoleRecord = {
    origin: "ui",
    sequence,
    at: new Date().toISOString(),
    level: entry.level,
    source: entry.source,
    message: entry.message ?? merged?.summary ?? "unspecified event",
    ...(merged ? { detail: merged } : {})
  };

  records = [...records, record].slice(-CAPACITY);
  for (const listener of listeners) listener(record);
  return record;
}

export function uiDiagnostics(): ConsoleRecord[] {
  return records;
}

export function clearUiDiagnostics(): void {
  records = [];
}

export function onUiDiagnostic(listener: (record: ConsoleRecord) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Catch what no component caught.
 *
 * An uncaught error or a rejected promise with no handler is exactly the failure an operator
 * describes as "it just stopped working", and it is the one case where there is no code path
 * left to report from. Installed once; calling it again is a no-op so a re-render or a second
 * mount cannot double-record.
 */
export function installUiDiagnosticCapture(): void {
  if (captureInstalled) return;
  captureInstalled = true;

  window.addEventListener("error", (event) => {
    recordUiDiagnostic({
      level: "error",
      source: "ui/uncaught",
      error: event.error ?? event.message,
      context: {
        ...(event.filename ? { file: `${event.filename}:${event.lineno}:${event.colno}` } : {})
      }
    });
  });

  window.addEventListener("unhandledrejection", (event) => {
    recordUiDiagnostic({
      level: "error",
      source: "ui/unhandled-rejection",
      error: event.reason
    });
  });
}

/** Turn anything thrown in the browser into a detail, keeping a service detail intact. */
function describeUiError(error: unknown, fallbackMessage?: string): PlayoutDiagnosticDetail | undefined {
  if (error === undefined && fallbackMessage === undefined) return undefined;
  if (error instanceof PlayoutRequestError && error.detail) return error.detail;

  if (error instanceof Error) {
    return {
      code: "ui.exception",
      summary: error.message || error.name,
      ...(error.stack ? { stack: error.stack } : {})
    };
  }

  if (error !== undefined) {
    return { code: "ui.thrown-value", summary: typeof error === "string" ? error : safeInspect(error) };
  }

  return { code: "ui.event", summary: fallbackMessage as string };
}

function safeInspect(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
