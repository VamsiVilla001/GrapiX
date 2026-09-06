/**
 * The audit sink: an append-only JSON Lines writer that a caller can never wait on.
 *
 * ## Why nothing here returns a promise the caller must await
 *
 * The callers are a render-adjacent control service and a playout service. If appending a line
 * could block a take, the log would be a liability rather than a record - so `record()` is
 * synchronous, returns void, and does nothing but push onto an in-memory queue. A timer drains
 * the queue with one `appendFile` per batch. A disk that has gone away costs a warning and a
 * dropped batch, never a stalled Program.
 *
 * The queue is bounded. An unbounded queue in front of a failing disk is just a slower way to
 * run out of memory; when the ceiling is hit the *oldest* entries go, and the drop is itself
 * counted and reported, so the gap in the sequence numbers has an explanation.
 *
 * ## Rotation
 *
 * Daily or by size, whichever comes first. The rotated file is gzipped in the background and
 * the plain copy removed only once the compressed one is durably written - an interrupted
 * rotation must never be able to lose a day of evidence. Retention deletes by age.
 */
import { createReadStream, createWriteStream } from "node:fs";
import { appendFile, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";

import type { AuditAction, AuditRecord, AuditResult, AuditSink } from "./audit.js";
import { SINK_FOR_ACTION, sanitiseDetail } from "./audit.js";

export interface AuditLogOptions {
  /** Directory the `.jsonl` files live in. Created if absent. */
  directory: string;
  /** Rotate once the active file passes this size. Default 32 MiB. */
  maxBytes?: number;
  /** Delete rotated archives older than this. Default 90 days. */
  retentionDays?: number;
  /** Flush cadence. Default 250ms - long enough to batch, short enough to survive a crash. */
  flushIntervalMs?: number;
  /** Ceiling on unwritten records per sink. Default 10000. */
  maxQueued?: number;
  /** Injected in tests. */
  now?: () => Date;
  onWarning?: (message: string, error?: unknown) => void;
}

/** What a caller supplies; the writer fills in timestamp, sequence and sink. */
export interface AuditEntry {
  action: AuditAction;
  result: AuditResult;
  userId?: string | null;
  username?: string | null;
  role?: string | null;
  sessionId?: string | null;
  deviceName?: string | null;
  ipAddress?: string | null;
  connectionId?: string | null;
  sceneId?: string | null;
  revision?: number | null;
  error?: { code: string; message: string } | null;
  detail?: unknown;
}

/**
 * Capacity claimed ahead of an action that must not proceed unrecorded.
 *
 * A reserved record is written even if unreserved traffic has since filled the queue, because the
 * room was counted before the caller was allowed to start. That is the difference between a log
 * that drops the least interesting line and a log that drops the one line the caller was told it
 * could write.
 */
export interface AuditReservation {
  readonly sink: AuditSink;
  /** Records still claimable under this reservation. */
  readonly remaining: number;
  /** Give back whatever is left. Safe to call twice. */
  release(): void;
}

interface SinkState {
  queue: string[];
  sequence: number;
  bytes: number;
  day: string;
  dropped: number;
  initialised: boolean;
  /** Slots promised to reservations and not yet used. */
  reserved: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export class AuditLog {
  private readonly directory: string;
  private readonly maxBytes: number;
  private readonly retentionDays: number;
  private readonly flushIntervalMs: number;
  private readonly maxQueued: number;
  private readonly now: () => Date;
  private readonly onWarning: (message: string, error?: unknown) => void;

  private readonly sinks: Record<AuditSink, SinkState> = {
    audit: { queue: [], sequence: 0, bytes: 0, day: "", dropped: 0, initialised: false, reserved: 0 },
    events: { queue: [], sequence: 0, bytes: 0, day: "", dropped: 0, initialised: false, reserved: 0 }
  };

  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly reservations = new Set<AuditReservation & { consume(): boolean }>();
  private draining = false;
  private closed = false;
  private lastRetentionSweep = 0;

  constructor(options: AuditLogOptions) {
    this.directory = options.directory;
    this.maxBytes = options.maxBytes ?? 32 * 1024 * 1024;
    this.retentionDays = options.retentionDays ?? 90;
    this.flushIntervalMs = options.flushIntervalMs ?? 250;
    this.maxQueued = options.maxQueued ?? 10_000;
    this.now = options.now ?? (() => new Date());
    this.onWarning = options.onWarning ?? (() => {});
  }

  /**
   * Read back the last sequence number already on disk, so numbering survives a restart.
   *
   * Reading the whole file would be wasteful once it is large; only the tail matters, and the
   * tail of a line-delimited file is cheap to find by reading the final chunk.
   */
  async open(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    for (const sink of ["audit", "events"] as AuditSink[]) {
      const state = this.sinks[sink];
      const path = this.pathFor(sink);
      try {
        const info = await stat(path);
        state.bytes = info.size;
        state.sequence = await lastSequenceIn(path, info.size);
      } catch {
        state.bytes = 0;
        state.sequence = 0;
      }
      state.day = this.today();
      state.initialised = true;
    }

    this.timer = setInterval(() => {
      void this.drain();
    }, this.flushIntervalMs);
    // Never hold the process open for the sake of the logger.
    this.timer.unref?.();
  }

  /**
   * Claim room for `count` records ahead of an action that may not proceed unrecorded.
   *
   * Returns null when the queue cannot promise the room, which is the caller's cue to refuse the
   * work rather than do it silently. Reserving costs nothing but a counter; forgetting to release
   * costs the queue that much headroom until the process restarts, so callers release in a finally.
   */
  reserve(action: AuditAction, count: number): AuditReservation | null {
    if (this.closed || count < 1) return null;
    const sink = SINK_FOR_ACTION[action];
    const state = this.sinks[sink];
    if (state.queue.length + state.reserved + count > this.maxQueued) {
      this.onWarning(`the ${sink} log queue cannot reserve ${count} records; the caller must refuse the action.`);
      return null;
    }
    state.reserved += count;
    let remaining = count;
    const consume = (): boolean => {
      if (remaining < 1) return false;
      remaining -= 1;
      state.reserved -= 1;
      return true;
    };
    const reservation: AuditReservation & { consume(): boolean } = {
      sink,
      get remaining() { return remaining; },
      consume,
      release() {
        state.reserved -= remaining;
        remaining = 0;
      }
    };
    this.reservations.add(reservation);
    return reservation;
  }

  /**
   * Queue one record. Synchronous, non-throwing, and never blocks the caller.
   *
   * A record that cannot be serialised is dropped with a warning rather than propagating into
   * a take path - a broken log line must not become a broken show.
   */
  record(entry: AuditEntry, reservation?: AuditReservation | null): void {
    if (this.closed) return;
    const sink = SINK_FOR_ACTION[entry.action];
    const state = this.sinks[sink];

    state.sequence += 1;
    const record: AuditRecord = {
      timestamp: this.now().toISOString(),
      sequence: state.sequence,
      action: entry.action,
      result: entry.result,
      userId: entry.userId ?? null,
      username: entry.username ?? null,
      role: entry.role ?? null,
      sessionId: entry.sessionId ?? null,
      deviceName: entry.deviceName ?? null,
      ipAddress: entry.ipAddress ?? null,
      connectionId: entry.connectionId ?? null,
      sceneId: entry.sceneId ?? null,
      revision: entry.revision ?? null,
      error: entry.error ?? null
    };
    const detail = sanitiseDetail(entry.detail);
    if (detail) record.detail = detail;

    let line: string;
    try {
      line = `${JSON.stringify(record)}\n`;
    } catch (error) {
      this.onWarning(`an audit record for ${entry.action} could not be serialised`, error);
      return;
    }

    const reserved = reservation !== undefined && reservation !== null
      && this.reservations.has(reservation as AuditReservation & { consume(): boolean })
      && (reservation as AuditReservation & { consume(): boolean }).sink === sink
      && (reservation as AuditReservation & { consume(): boolean }).consume();

    if (!reserved && state.queue.length + state.reserved >= this.maxQueued) {
      state.queue.shift();
      state.dropped += 1;
      if (state.dropped === 1 || state.dropped % 1000 === 0) {
        this.onWarning(
          `the ${sink} log queue is full; ${state.dropped} records dropped. The sequence numbers will show the gap.`
        );
      }
    }
    state.queue.push(line);
  }

  /** Write everything queued right now. Used by tests and by shutdown. */
  async flush(): Promise<void> {
    await this.drain();
  }

  async close(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.drain();
    this.closed = true;
  }

  /** Records dropped so far, per sink. Surfaced in health output. */
  droppedCounts(): Record<AuditSink, number> {
    return { audit: this.sinks.audit.dropped, events: this.sinks.events.dropped };
  }

  private pathFor(sink: AuditSink): string {
    return join(this.directory, `${sink}.jsonl`);
  }

  private today(): string {
    return this.now().toISOString().slice(0, 10);
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      for (const sink of ["audit", "events"] as AuditSink[]) {
        const state = this.sinks[sink];
        if (!state.initialised || state.queue.length === 0) continue;

        const batch = state.queue.splice(0, state.queue.length).join("");
        const path = this.pathFor(sink);
        try {
          await this.rotateIfNeeded(sink, state, Buffer.byteLength(batch));
          await appendFile(path, batch, "utf8");
          state.bytes += Buffer.byteLength(batch);
        } catch (error) {
          this.onWarning(`could not append to ${basename(path)}`, error);
        }
      }
      await this.sweepRetention();
    } finally {
      this.draining = false;
    }
  }

  private async rotateIfNeeded(sink: AuditSink, state: SinkState, incomingBytes: number): Promise<void> {
    const today = this.today();
    const dayChanged = state.day !== "" && state.day !== today;
    const tooLarge = state.bytes + incomingBytes > this.maxBytes;
    if (!dayChanged && !tooLarge) return;

    const path = this.pathFor(sink);
    try {
      await stat(path);
    } catch {
      // Nothing to rotate yet.
      state.day = today;
      state.bytes = 0;
      return;
    }

    // The stamp carries the time as well as the date: a size rotation can happen twice in one
    // day, and an archive that silently overwrote its predecessor would destroy the evidence
    // rotation exists to preserve.
    const stamp = this.now().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const rotated = join(this.directory, `${sink}-${stamp}.jsonl`);
    try {
      await rename(path, rotated);
      state.bytes = 0;
      state.day = today;
      // Compress after the rename so the active file is available again immediately.
      void this.compress(rotated);
    } catch (error) {
      this.onWarning(`could not rotate ${basename(path)}`, error);
    }
  }

  private async compress(path: string): Promise<void> {
    const target = `${path}.gz`;
    try {
      await pipeline(createReadStream(path), createGzip(), createWriteStream(target));
      // Only now is the evidence safely in two places; removing the plain copy first would
      // make a crash mid-compress lose the file outright.
      await rm(path, { force: true });
    } catch (error) {
      this.onWarning(`could not compress ${basename(path)}; the uncompressed archive is kept`, error);
    }
  }

  private async sweepRetention(): Promise<void> {
    const nowMs = this.now().getTime();
    // Hourly is often enough for a daily retention policy, and keeps the drain cheap.
    if (nowMs - this.lastRetentionSweep < 60 * 60 * 1000) return;
    this.lastRetentionSweep = nowMs;

    const cutoff = nowMs - this.retentionDays * DAY_MS;
    let entries: string[];
    try {
      entries = await readdir(this.directory);
    } catch (error) {
      this.onWarning("could not read the log directory for retention", error);
      return;
    }

    for (const entry of entries) {
      // Only archives. The active `audit.jsonl` / `events.jsonl` are never swept.
      if (!/^(audit|events)-.*\.jsonl(\.gz)?$/.test(entry)) continue;
      const path = join(this.directory, entry);
      try {
        const info = await stat(path);
        if (info.mtimeMs < cutoff) await rm(path, { force: true });
      } catch (error) {
        this.onWarning(`could not apply retention to ${entry}`, error);
      }
    }
  }
}

/**
 * Find the highest sequence number in a JSONL file by reading only its tail.
 *
 * The last line is the highest by construction, since the writer only appends.
 */
async function lastSequenceIn(path: string, size: number): Promise<number> {
  if (size === 0) return 0;
  const window = Math.min(size, 64 * 1024);
  const start = size - window;
  return await new Promise<number>((resolve) => {
    let text = "";
    const stream = createReadStream(path, { start, encoding: "utf8" });
    stream.on("data", (chunk) => {
      text += chunk;
    });
    stream.on("error", () => resolve(0));
    stream.on("end", () => {
      const lines = text.trimEnd().split("\n");
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        try {
          const parsed = JSON.parse(lines[index]) as { sequence?: number };
          if (typeof parsed.sequence === "number") return resolve(parsed.sequence);
        } catch {
          // A partial first line is expected when the window starts mid-record.
        }
      }
      resolve(0);
    });
  });
}
