/**
 * The operator console.
 *
 * Playout used to report a failure as one line in a banner that the next action replaced. So
 * `asset asset_b5350b45cd6cca4ff8f7 returned HTTP 404` was the whole of what an operator
 * could ever know: an id with no name, no scene, no URL, no remedy, and no way to look at it
 * again once it was gone. On an operator station there is no devtools console to fall back on,
 * and on the packaged desktop build there is no console at all.
 *
 * This is that missing surface. It shows every failure the control service refused a command
 * with, every engine-link event, and everything this window itself could not do — each with
 * the cause, the remedy, and the identifiers needed to act. Records persist until cleared, so
 * a failure during a take can be read after the take.
 *
 * Deliberately a drawer rather than a dock panel: it is opened when something is wrong and
 * must not take space from Scene Manager, Take List or the monitors when nothing is.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Copy,
  Info,
  Trash2,
  TriangleAlert,
  X
} from "lucide-react";

import { playoutApi, type DiagnosticLevel } from "./api";
import { clearUiDiagnostics, onUiDiagnostic, recordUiDiagnostic, uiDiagnostics, type ConsoleRecord } from "./diagnostics";

interface DiagnosticsConsoleProps {
  open: boolean;
  onClose: () => void;
  /** Bumped by the parent on every `diagnostics.logged` event, so the tail is fetched at once. */
  serviceRevision: number;
  /** Sequence to scroll to and expand when the console is opened from an error banner. */
  focusRecord: { origin: ConsoleRecord["origin"]; sequence: number } | null;
}

type LevelFilter = "all" | DiagnosticLevel;

const LEVEL_ICON: Record<DiagnosticLevel, typeof CircleAlert> = {
  error: CircleAlert,
  warning: TriangleAlert,
  info: Info
};

export function DiagnosticsConsole({ open, onClose, serviceRevision, focusRecord }: DiagnosticsConsoleProps) {
  const [serviceRecords, setServiceRecords] = useState<ConsoleRecord[]>([]);
  const [uiRecords, setUiRecords] = useState<ConsoleRecord[]>(() => uiDiagnostics());
  const [level, setLevel] = useState<LevelFilter>("all");
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [copied, setCopied] = useState<string | null>(null);
  const [fetchFailure, setFetchFailure] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  /**
   * Highest sequence already held.
   *
   * A restarted control service starts its log again from 1, which would look like "nothing
   * new" forever, so a page whose `latestSequence` is below what we hold is treated as a
   * fresh log and replaces the list rather than appending to it.
   */
  const heldSequence = useRef(0);

  const loadServiceRecords = useCallback(async () => {
    try {
      const page = await playoutApi.diagnostics(heldSequence.current);
      setFetchFailure(null);
      if (page.latestSequence < heldSequence.current) {
        heldSequence.current = page.latestSequence;
        setServiceRecords(page.records.map((record) => ({ ...record, origin: "service" as const })));
        return;
      }
      if (page.records.length === 0) return;
      heldSequence.current = page.latestSequence;
      setServiceRecords((current) => {
        const known = new Set(current.map((record) => record.sequence));
        const added = page.records
          .filter((record) => !known.has(record.sequence))
          .map((record) => ({ ...record, origin: "service" as const }));
        return added.length === 0 ? current : [...current, ...added].slice(-400);
      });
    } catch (error) {
      // Reported in the panel rather than recorded: recording it would fail the same way on
      // the next poll and fill the console with its own inability to read the console.
      setFetchFailure(error instanceof Error ? error.message : String(error));
    }
  }, []);

  useEffect(() => onUiDiagnostic(() => setUiRecords([...uiDiagnostics()])), []);

  // Fetched whenever the panel opens and on every service-side record, so an open console is
  // live and a closed one costs nothing.
  useEffect(() => {
    if (!open) return;
    void loadServiceRecords();
  }, [open, serviceRevision, loadServiceRecords]);

  const records = useMemo(() => {
    const all = [...serviceRecords, ...uiRecords];
    // Newest first: during a failure the newest record is the one being read.
    all.sort((left, right) => (right.at === left.at ? right.sequence - left.sequence : right.at.localeCompare(left.at)));
    const needle = query.trim().toLocaleLowerCase();
    return all.filter((record) => {
      if (level !== "all" && record.level !== level) return false;
      if (!needle) return true;
      return (
        record.message.toLocaleLowerCase().includes(needle) ||
        record.source.toLocaleLowerCase().includes(needle) ||
        (record.detail ? JSON.stringify(record.detail).toLocaleLowerCase().includes(needle) : false)
      );
    });
  }, [serviceRecords, uiRecords, level, query]);

  const errorCount = records.filter((record) => record.level === "error").length;

  // Opening from a banner must land on the record the banner was about, expanded. Runs after
  // the fetch that the same open triggered, hence the dependency on the record list.
  useEffect(() => {
    if (!open || !focusRecord) return;
    const key = `${focusRecord.origin}:${focusRecord.sequence}`;
    if (!records.some((record) => recordKey(record) === key)) return;
    setExpanded((current) => (current.has(key) ? current : new Set(current).add(key)));
    listRef.current?.querySelector(`[data-record="${key}"]`)?.scrollIntoView({ block: "nearest" });
  }, [open, focusRecord, records]);

  const clearAll = useCallback(async () => {
    clearUiDiagnostics();
    setUiRecords([]);
    setServiceRecords([]);
    try {
      const { latestSequence } = await playoutApi.clearDiagnostics();
      heldSequence.current = latestSequence;
    } catch (error) {
      // The service still holds those records, and a console showing an empty list while the
      // log is full is the failure this panel exists to end. Rewind and refetch so what is
      // shown is what is there, with the reason it could not be cleared beside it.
      recordUiDiagnostic({ level: "warning", source: "ui/console", message: "Could not clear the service-side log", error });
      heldSequence.current = 0;
      await loadServiceRecords();
    }
  }, [loadServiceRecords]);

  const copyRecord = useCallback(async (record: ConsoleRecord) => {
    const key = recordKey(record);
    try {
      await navigator.clipboard.writeText(asPlainText(record));
      setCopied(key);
      window.setTimeout(() => setCopied((current) => (current === key ? null : current)), 1500);
    } catch (error) {
      recordUiDiagnostic({ level: "warning", source: "ui/console", message: "Clipboard write was refused", error });
    }
  }, []);

  if (!open) return null;

  return (
    <section className="diagnostics-console" aria-label="Diagnostics console">
      <header>
        <strong>Console</strong>
        <span className="console-count">
          {records.length} record{records.length === 1 ? "" : "s"}
          {errorCount > 0 ? ` · ${errorCount} error${errorCount === 1 ? "" : "s"}` : ""}
        </span>
        <div className="console-filters">
          {(["all", "error", "warning", "info"] as const).map((option) => (
            <button
              key={option}
              className={`console-chip ${level === option ? "active" : ""}`}
              onClick={() => setLevel(option)}
            >
              {option}
            </button>
          ))}
        </div>
        <input
          className="console-search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Filter by text, code, source or id"
          aria-label="Filter diagnostics"
        />
        <button className="small-button" onClick={() => void clearAll()} title="Clear every record, here and in the service">
          <Trash2 size={13} />
          Clear
        </button>
        <button className="icon-button" onClick={onClose} title="Close the console">
          <X size={16} />
        </button>
      </header>

      {fetchFailure && (
        <p className="console-note">
          Showing this window's records only — the control service's log could not be read: {fetchFailure}
        </p>
      )}

      <div className="console-list" ref={listRef}>
        {records.map((record) => {
          const key = recordKey(record);
          const isOpen = expanded.has(key);
          const Icon = LEVEL_ICON[record.level];
          return (
            <article key={key} className={`console-record ${record.level}`} data-record={key}>
              <button
                className="console-row"
                onClick={() =>
                  setExpanded((current) => {
                    const next = new Set(current);
                    if (next.has(key)) next.delete(key);
                    else next.add(key);
                    return next;
                  })
                }
              >
                {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                <Icon size={13} className="console-level-icon" />
                <time>{record.at.slice(11, 23)}</time>
                <span className="console-source">{record.source}</span>
                <span className="console-message">{record.message}</span>
                {record.detail?.code && <code className="console-code">{record.detail.code}</code>}
              </button>

              {isOpen && (
                <div className="console-detail">
                  {record.detail?.cause && (
                    <p>
                      <span className="console-label">Cause</span>
                      <span className="console-value">{record.detail.cause}</span>
                    </p>
                  )}
                  {record.detail?.causeChain && record.detail.causeChain.length > 1 && (
                    <p>
                      <span className="console-label">Chain</span>
                      <span className="console-value">{record.detail.causeChain.join(" ← ")}</span>
                    </p>
                  )}
                  {record.detail?.remedy && (
                    <p className="console-remedy">
                      <span className="console-label">Do this</span>
                      <span className="console-value">{record.detail.remedy}</span>
                    </p>
                  )}
                  {record.detail?.context && Object.keys(record.detail.context).length > 0 && (
                    <dl className="console-context">
                      {Object.entries(record.detail.context).map(([name, value]) => (
                        <div key={name}>
                          <dt>{name}</dt>
                          <dd>{renderValue(value)}</dd>
                        </div>
                      ))}
                    </dl>
                  )}
                  {record.detail?.stack && <pre className="console-stack">{record.detail.stack}</pre>}
                  <div className="console-detail-actions">
                    <span className="console-origin">
                      {record.origin === "ui" ? "This operator window" : "Control service"} · {record.at}
                    </span>
                    <button className="small-button" onClick={() => void copyRecord(record)}>
                      {copied === key ? <Check size={13} /> : <Copy size={13} />}
                      {copied === key ? "Copied" : "Copy"}
                    </button>
                  </div>
                </div>
              )}
            </article>
          );
        })}

        {records.length === 0 && (
          <p className="console-empty">
            {query || level !== "all"
              ? "No record matches this filter."
              : "Nothing has failed since this log was cleared. Failures, engine-link changes and anything this window cannot do are recorded here with their cause and remedy."}
          </p>
        )}
      </div>
    </section>
  );
}

/** Unique across both logs: the two sequences are independent counters. */
function recordKey(record: ConsoleRecord): string {
  return `${record.origin}:${record.sequence}`;
}

/**
 * The whole record as text, for pasting into a ticket or a message to an engineer.
 *
 * Everything is included, in reading order. An operator copying a failure has no way to know
 * which field an engineer needs.
 */
function asPlainText(record: ConsoleRecord): string {
  const lines = [
    `[${record.at}] ${record.level.toUpperCase()} ${record.source} (${record.origin === "ui" ? "operator window" : "control service"})`,
    record.message
  ];
  if (record.detail?.code) lines.push(`code: ${record.detail.code}`);
  if (record.detail?.cause) lines.push(`cause: ${record.detail.cause}`);
  if (record.detail?.causeChain && record.detail.causeChain.length > 1) {
    lines.push(`chain: ${record.detail.causeChain.join(" <- ")}`);
  }
  if (record.detail?.remedy) lines.push(`remedy: ${record.detail.remedy}`);
  if (record.detail?.context) {
    for (const [name, value] of Object.entries(record.detail.context)) lines.push(`${name}: ${renderValue(value)}`);
  }
  if (record.detail?.stack) lines.push(record.detail.stack);
  return lines.join("\n");
}

function renderValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}
