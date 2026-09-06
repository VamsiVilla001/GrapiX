/**
 * Author-facing diagnostics for the project service.
 *
 * The editor UI used to receive one string per failure and show it in a window.alert or a
 * save indicator. That is enough when the string is self-explanatory and useless when it is
 * not: `FONT_RESOLUTION_FAILED` names a code nobody can act on, does not say which family
 * failed, which URL was fetched, or what the author is supposed to do about it.
 *
 * So a failure carries structure: a stable `code`, a one-line `summary` for the banner line,
 * the `cause` in the words of whatever actually failed, a `remedy` naming the action that
 * resolves it, and a `context` bag with every identifier needed to find the thing. Every
 * failure is also appended to a bounded in-memory log the UI reads, so an error that flashed
 * past during an import is still there afterwards.
 *
 * Nothing here is persisted. A diagnostic is an aid to the author in front of the machine,
 * not an audit record — audit.ts already writes those — and a log on disk is one more thing
 * that can fill a volume on an unattended workstation.
 *
 * Ported from Playout/services/playout-control/src/diagnostics.ts: the operator console and
 * the author console read the same shape, so a failure means the same thing on both sides of
 * the publish.
 */

/** Severity, as the author reads it. */
export type DiagnosticLevel = "error" | "warning" | "info";

/**
 * The structured half of a failure.
 *
 * `summary` is the only required field because it is the one the console row shows.
 * Everything else is present when it is known — an unknown error yields a detail with just a
 * code and a summary rather than fabricated advice.
 */
export interface EditorDiagnosticDetail {
  /** Stable, greppable identifier, e.g. `font.resolution-failed`. */
  code: string;
  /** One line, in author language. Shown in the console row. */
  summary: string;
  /** What actually failed, in the words of the failing layer. */
  cause?: string;
  /** The action that resolves it. Omitted rather than guessed. */
  remedy?: string;
  /** Identifiers needed to find the thing: ids, URLs, statuses, sizes. */
  context?: Record<string, unknown>;
  /** `Error.cause` chain, outermost first, for a failure wrapped more than once. */
  causeChain?: string[];
  /** Present for unexpected failures, where the throw site is the useful information. */
  stack?: string;
}

/**
 * One entry in the console.
 */
export interface DiagnosticRecord {
  /** Monotonic within a process lifetime. The UI dedupes and orders on this. */
  sequence: number;
  at: string;
  level: DiagnosticLevel;
  /** Which part of the Editor produced it, e.g. `fonts` or `http POST /api/scenes`. */
  source: string;
  /** The row line. Same as `detail.summary` when there is a detail. */
  message: string;
  detail?: EditorDiagnosticDetail;
}

/**
 * Describe any thrown value.
 *
 * Never throws and never returns an empty summary — a diagnostic that itself fails to render
 * would hide the failure it is reporting.
 */
export function describeError(error: unknown, fallbackCode = "internal"): EditorDiagnosticDetail {
  if (error instanceof Error) {
    const chain = causeChain(error.cause);
    return {
      code: fallbackCode,
      summary: error.message || error.name || "an error with no message was thrown",
      ...(chain[0] ? { cause: chain[0] } : {}),
      ...(chain.length > 1 ? { causeChain: chain } : {}),
      ...(error.stack ? { stack: error.stack } : {})
    };
  }

  return {
    code: fallbackCode,
    summary:
      typeof error === "string" && error.trim()
        ? error
        : `a non-error value was thrown: ${safeInspect(error)}`
  };
}

/**
 * The bounded log the author console reads.
 *
 * A ring buffer rather than a growing array: the project service runs for the length of an
 * authoring session, and a failing retry loop can produce a record every few seconds.
 * `CAPACITY` records is more than an author will ever scroll and cannot grow into a leak.
 *
 * `onRecord` exists so the HTTP layer can push an SSE notification without the log knowing
 * what SSE is.
 */
export class DiagnosticsLog {
  static readonly CAPACITY = 300;

  private records: DiagnosticRecord[] = [];
  private sequence = 0;
  private readonly listeners = new Set<(record: DiagnosticRecord) => void>();

  record(entry: {
    level: DiagnosticLevel;
    source: string;
    message?: string;
    detail?: EditorDiagnosticDetail;
    error?: unknown;
    /** Merged into the detail's context. For the identifiers only the caller knows. */
    context?: Record<string, unknown>;
  }): DiagnosticRecord {
    const detail = entry.detail ?? (entry.error === undefined ? undefined : describeError(entry.error));
    const merged =
      detail && entry.context
        ? { ...detail, context: { ...entry.context, ...detail.context } }
        : detail;

    this.sequence += 1;
    const record: DiagnosticRecord = {
      sequence: this.sequence,
      at: new Date().toISOString(),
      level: entry.level,
      source: entry.source,
      message: entry.message ?? merged?.summary ?? "unspecified event",
      ...(merged ? { detail: merged } : {})
    };

    this.records.push(record);
    if (this.records.length > DiagnosticsLog.CAPACITY) {
      this.records.splice(0, this.records.length - DiagnosticsLog.CAPACITY);
    }

    // A listener that throws must not turn recording a failure into a second failure.
    for (const listener of this.listeners) {
      try {
        listener(record);
      } catch {
        // Ignored deliberately: the log is the last line of reporting.
      }
    }
    return record;
  }

  /**
   * Records, oldest first.
   *
   * `since` is the last sequence the client already holds, so a console that is polling asks
   * for the tail rather than re-rendering the whole buffer. `limit` keeps the newest.
   */
  list(options: { since?: number; limit?: number } = {}): DiagnosticRecord[] {
    const since = options.since ?? 0;
    const tail = since > 0 ? this.records.filter((record) => record.sequence > since) : this.records;
    const limit = options.limit;
    return limit !== undefined && limit >= 0 && tail.length > limit ? tail.slice(tail.length - limit) : [...tail];
  }

  /** Highest sequence issued, so a client can tell "nothing new" from "empty". */
  latestSequence(): number {
    return this.sequence;
  }

  /**
   * Drop every record. The sequence deliberately keeps counting: a client holding
   * `since: 40` must not be handed a fresh record 12 and treat it as already seen.
   */
  clear(): number {
    const dropped = this.records.length;
    this.records = [];
    return dropped;
  }

  onRecord(listener: (record: DiagnosticRecord) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/** `Error.cause` messages, outermost first. Bounded, because a cause chain can be cyclic. */
function causeChain(cause: unknown, depth = 0): string[] {
  if (cause === undefined || cause === null || depth >= 8) return [];
  if (cause instanceof Error) {
    const head = cause.message || cause.name;
    return head ? [head, ...causeChain(cause.cause, depth + 1)] : causeChain(cause.cause, depth + 1);
  }
  const rendered = typeof cause === "string" ? cause : safeInspect(cause);
  return rendered ? [rendered] : [];
}

/** Render an unknown value without throwing on a circular structure or a BigInt. */
function safeInspect(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
