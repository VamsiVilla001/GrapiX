// Keeping the session copy of a workspace (plan row 11.94): written a moment after the author stops changing the
// arrangement, never while a drag is under way, and once more when the window closes.
//
// The page calls `schedule` when a change is *committed* (a drop, a resize ended, a tab closed), not on every pointer
// move, so a drag writes nothing. A change that comes before the pause is over replaces the one waiting, so a run of
// changes is one write. A write that fails does not lose the arrangement and is never reported as saved: the value
// stays waiting, the error is reported, and the next change or the close tries again.

export interface SaverTimers {
  set(run: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface SaverOptions<T> {
  /** How long after the last change the write happens. The hand-off suggests 350 to 600 ms. */
  readonly delayMs: number;
  readonly write: (key: string, value: T) => Promise<void>;
  /** Told of every failed write, with the key, so the page can say so without blocking. */
  readonly onError: (key: string, error: unknown) => void;
  readonly timers?: SaverTimers;
}

export const SESSION_SAVE_DELAY_MS = 500;

export interface SessionSaver<T> {
  /** Keep this value for the key a moment from now, in place of one that is waiting. */
  schedule(key: string, value: T): void;
  /** Drop what is waiting for a key (its workspace was deleted), so it is not written back. */
  cancel(key: string): void;
  /** Write everything that is waiting now. Resolves when every write has ended, with the keys that failed. */
  flush(): Promise<string[]>;
  /** Keys with a value that has not been written: waiting, being written, or failed. */
  pending(): string[];
  /** Keys whose last write failed and whose value is still waiting. */
  failed(): string[];
}

interface Entry<T> {
  value: T;
  /** The value is newer than the last write that was started for it. */
  dirty: boolean;
  timer: unknown;
  writing: Promise<void> | undefined;
  failed: boolean;
  /** Its workspace was deleted while a write was under way: whatever that write does, nothing is kept. */
  cancelled: boolean;
  /** The value the last write that was started sent. */
  sent: T | undefined;
}

const REAL_TIMERS: SaverTimers = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function createSessionSaver<T>(options: SaverOptions<T>): SessionSaver<T> {
  const timers = options.timers ?? REAL_TIMERS;
  const entries = new Map<string, Entry<T>>();

  /** Write what is waiting for one key. At most one write per key runs at a time; a value that arrives meanwhile is
   *  written when it ends, so writes never overtake each other. */
  function start(key: string): Promise<void> {
    const entry = entries.get(key);
    if (entry === undefined) return Promise.resolve();
    if (entry.writing !== undefined) return entry.writing;
    if (!entry.dirty) return Promise.resolve();
    const sent = entry.value;
    entry.sent = sent;
    entry.dirty = false;
    entry.timer = undefined;
    const run = options.write(key, sent).then(
      () => {
        entry.failed = false;
      },
      (error: unknown) => {
        if (entry.cancelled) return;
        entry.failed = true;
        // Not written: it is still waiting, so the next change or the close tries again.
        if (entry.value === sent) entry.dirty = true;
        options.onError(key, error);
      },
    );
    entry.writing = run.then(() => {
      entry.writing = undefined;
      if (entries.get(key) !== entry) return;
      if (entry.cancelled) {
        entries.delete(key);
        return undefined;
      }
      if (entry.dirty && !entry.failed) return start(key);
      if (!entry.dirty && !entry.failed) entries.delete(key);
      return undefined;
    });
    return entry.writing;
  }

  return {
    schedule(key, value) {
      const entry = entries.get(key) ?? { value, dirty: true, timer: undefined, writing: undefined, failed: false, cancelled: false, sent: undefined };
      entry.value = value;
      entry.dirty = true;
      entry.cancelled = false;
      if (entry.timer !== undefined) timers.clear(entry.timer);
      entry.timer = timers.set(() => void start(key), options.delayMs);
      entries.set(key, entry);
    },
    cancel(key) {
      const entry = entries.get(key);
      if (entry === undefined) return;
      if (entry.timer !== undefined) timers.clear(entry.timer);
      entry.dirty = false;
      entry.failed = false;
      entry.cancelled = true;
      if (entry.writing === undefined) entries.delete(key);
    },
    async flush() {
      for (const [key, entry] of entries) {
        if (entry.timer !== undefined) timers.clear(entry.timer);
        entry.timer = undefined;
        // A failed value is tried again by a flush.
        if (entry.failed && !entry.dirty) entry.dirty = true;
        void start(key);
      }
      // A write that started while others ended may have started another; wait until none is left.
      const settle = async (): Promise<void> => {
        for (let round = 0; round < 1000; round += 1) {
          const running = [...entries.values()].map((entry) => entry.writing).filter((p): p is Promise<void> => p !== undefined);
          if (running.length === 0) break;
          await Promise.all(running);
        }
      };
      await settle();
      // A write that was under way when the flush began may have failed while a newer value waited behind it. That
      // newer value has not been tried yet: try it once now, before saying anything failed.
      for (const [key, entry] of entries) {
        if (entry.dirty && entry.value !== entry.sent) void start(key);
      }
      await settle();
      return [...entries.entries()].filter(([, entry]) => entry.failed).map(([key]) => key);
    },
    pending() {
      return [...entries.keys()];
    },
    failed() {
      return [...entries.entries()].filter(([, entry]) => entry.failed).map(([key]) => key);
    },
  };
}
