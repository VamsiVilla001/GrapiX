/**
 * The editor UI's own half of the console.
 *
 * Half of an editor failure never reaches the project service: a request that could not be
 * sent, a renderer that threw, an import the browser could not read. Those used to land in
 * the browser devtools console — which is not open while an author works, and on the
 * packaged desktop build is not reachable at all.
 *
 * So the UI keeps its own bounded log in the same shape as the service's, and the console
 * panel shows both merged. `origin` is the only added field, because "the service refused
 * this" and "this window could not ask" call for different actions.
 *
 * Ported from Playout's apps/playout-web/src/diagnostics.ts; the two consoles read the same
 * record shape so a failure means the same thing on both sides of the publish.
 */

import type { DiagnosticLevel, DiagnosticRecord, EditorDiagnosticDetail } from "./apiClient";
import { installApiDiagnosticReporter } from "./apiClient";
import { onAnimationDiagnostic } from "@grapix/shared-types";

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
 * `detail` wins over `error` when both are given: a caller that already knows the code and
 * the remedy — an apiClient refusal — should not be flattened back to an exception string.
 */
export function recordUiDiagnostic(entry: {
  level: DiagnosticLevel;
  source: string;
  message?: string;
  error?: unknown;
  detail?: EditorDiagnosticDetail;
  context?: Record<string, unknown>;
}): ConsoleRecord {
  const detail = entry.detail ?? describeUiError(entry.error, entry.message);
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
  for (const listener of listeners) {
    try {
      listener(record);
    } catch {
      // A listener that throws must not turn recording a failure into a second failure.
    }
  }
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
 * An uncaught error or a rejected promise with no handler is exactly the failure an author
 * describes as "it just stopped working", and it is the one case where there is no code path
 * left to report from. Installed once from main.tsx; calling it again is a no-op so a
 * re-render or a second mount cannot double-record.
 */
export function installUiDiagnosticCapture(): void {
  if (captureInstalled) return;
  captureInstalled = true;

  // Every refusal the API layer produces, with the URL and the remedy it already computed.
  installApiDiagnosticReporter((entry) => {
    recordUiDiagnostic({
      level: entry.level,
      source: `api ${entry.path}`,
      detail: entry.detail
    });
  });

  // Faults the scene evaluator finds while sampling — today, an easing this build does not
  // implement. Warning rather than error because the graphic still renders: the previous value
  // is held, which is visibly wrong but not a dead scene, and the author needs to know which
  // property on which object stopped moving.
  onAnimationDiagnostic((diagnostic) => {
    recordUiDiagnostic({
      level: "warning",
      source: "animation",
      message: diagnostic.message,
      detail: {
        code: diagnostic.code,
        summary: diagnostic.message,
        remedy:
          "Choose an easing this build implements from the keyframe's easing list, or re-publish from a build that has it.",
        context: {
          easing: diagnostic.value,
          frame: diagnostic.frame,
          ...(diagnostic.objectId ? { objectId: diagnostic.objectId } : {}),
          ...(diagnostic.property ? { property: diagnostic.property } : {})
        }
      }
    });
  });

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
function describeUiError(error: unknown, fallbackMessage?: string): EditorDiagnosticDetail | undefined {
  if (error === undefined && fallbackMessage === undefined) return undefined;

  if (error instanceof Error) {
    return {
      code: "ui.exception",
      summary: error.message || error.name,
      ...(error.stack ? { stack: error.stack } : {})
    };
  }

  if (error !== undefined) {
    return {
      code: "ui.thrown-value",
      summary: typeof error === "string" ? error : safeInspect(error)
    };
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
