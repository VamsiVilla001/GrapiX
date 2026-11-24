// Keeping the session copy (11.94): written a moment after the last change, never during a drag, once on close, and
// never reported as saved when it was not.
import { describe, expect, it } from "vitest";
import { SESSION_SAVE_DELAY_MS, createSessionSaver, type SaverTimers } from "../src/session-saver";

/** A clock the test moves by hand. */
function fakeTimers(): SaverTimers & { advance(ms: number): void; readonly waiting: number } {
  let now = 0;
  let next = 1;
  const jobs = new Map<number, { at: number; run: () => void }>();
  return {
    set(run, ms) {
      const id = next++;
      jobs.set(id, { at: now + ms, run });
      return id;
    },
    clear(handle) {
      jobs.delete(handle as number);
    },
    advance(ms) {
      now += ms;
      for (const [id, job] of [...jobs]) {
        if (job.at <= now) {
          jobs.delete(id);
          job.run();
        }
      }
    },
    get waiting() {
      return jobs.size;
    },
  };
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

function harness(delayMs = 500) {
  const timers = fakeTimers();
  const written: [string, string][] = [];
  const errors: [string, unknown][] = [];
  let failing: ((key: string, value: string) => boolean) | undefined;
  let gate: Promise<void> | undefined;
  const saver = createSessionSaver<string>({
    delayMs,
    timers,
    write: async (key, value) => {
      if (gate !== undefined) await gate;
      if (failing?.(key, value) === true) throw new Error(`cannot write ${key}`);
      written.push([key, value]);
    },
    onError: (key, error) => errors.push([key, error]),
  });
  return {
    timers, written, errors, saver,
    failWhen: (f: typeof failing) => (failing = f),
    holdWrites: () => {
      let release!: () => void;
      gate = new Promise<void>((resolve) => (release = resolve));
      return () => {
        gate = undefined;
        release();
      };
    },
  };
}

describe("when the session copy is written", () => {
  it("is half a second after the last change by default", () => {
    expect(SESSION_SAVE_DELAY_MS).toBe(500);
  });

  it("writes nothing until the pause is over, then writes once", async () => {
    const h = harness();
    h.saver.schedule("design", "a");
    h.timers.advance(499);
    await settle();
    expect(h.written).toEqual([]);
    expect(h.saver.pending()).toEqual(["design"]);
    h.timers.advance(1);
    await settle();
    expect(h.written).toEqual([["design", "a"]]);
    expect(h.saver.pending()).toEqual([]);
  });

  it("turns a run of changes into one write of the last one, each change putting the pause off", async () => {
    const h = harness();
    h.saver.schedule("design", "a");
    h.timers.advance(400);
    h.saver.schedule("design", "b");
    h.timers.advance(400);
    h.saver.schedule("design", "c");
    h.timers.advance(400);
    await settle();
    expect(h.written, "still inside the pause of the last change").toEqual([]);
    h.timers.advance(100);
    await settle();
    expect(h.written).toEqual([["design", "c"]]);
    expect(h.timers.waiting).toBe(0);
  });

  it("keeps each workspace to its own pause", async () => {
    const h = harness();
    h.saver.schedule("one", "1");
    h.timers.advance(300);
    h.saver.schedule("two", "2");
    h.timers.advance(200);
    await settle();
    expect(h.written).toEqual([["one", "1"]]);
    h.timers.advance(300);
    await settle();
    expect(h.written).toEqual([["one", "1"], ["two", "2"]]);
  });

  it("uses a different pause when asked", async () => {
    const h = harness(1000);
    h.saver.schedule("a", "x");
    h.timers.advance(999);
    await settle();
    expect(h.written).toEqual([]);
    h.timers.advance(1);
    await settle();
    expect(h.written).toHaveLength(1);
  });
});

describe("closing the window", () => {
  it("writes everything that is waiting at once, and says nothing failed", async () => {
    const h = harness();
    h.saver.schedule("one", "1");
    h.saver.schedule("two", "2");
    expect(await h.saver.flush()).toEqual([]);
    expect(h.written.sort()).toEqual([["one", "1"], ["two", "2"]]);
    expect(h.timers.waiting, "the pauses are over").toBe(0);
    expect(h.saver.pending()).toEqual([]);
  });

  it("resolves at once when nothing is waiting", async () => {
    const h = harness();
    expect(await h.saver.flush()).toEqual([]);
    expect(h.written).toEqual([]);
  });

  it("waits for a write that is already under way, and then for the change that came after it", async () => {
    const h = harness();
    const release = h.holdWrites();
    h.saver.schedule("design", "a");
    h.timers.advance(500);
    await settle();
    expect(h.written).toEqual([]);
    h.saver.schedule("design", "b");
    const done = h.saver.flush();
    release();
    expect(await done).toEqual([]);
    expect(h.written).toEqual([["design", "a"], ["design", "b"]]);
  });
});

describe("a write that does not happen", () => {
  it("is reported, is not lost, and is not counted as saved", async () => {
    const h = harness();
    h.failWhen(() => true);
    h.saver.schedule("design", "a");
    h.timers.advance(500);
    await settle();
    expect(h.written).toEqual([]);
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]![0]).toBe("design");
    expect((h.errors[0]![1] as Error).message).toBe("cannot write design");
    expect(h.saver.failed()).toEqual(["design"]);
    expect(h.saver.pending()).toEqual(["design"]);
  });

  it("is tried again by the next change, and clears when it works", async () => {
    const h = harness();
    let broken = true;
    h.failWhen(() => broken);
    h.saver.schedule("design", "a");
    h.timers.advance(500);
    await settle();
    broken = false;
    h.saver.schedule("design", "b");
    h.timers.advance(500);
    await settle();
    expect(h.written).toEqual([["design", "b"]]);
    expect(h.saver.failed()).toEqual([]);
    expect(h.saver.pending()).toEqual([]);
  });

  it("is tried again when the window closes, and a flush that still fails says which", async () => {
    const h = harness();
    let broken = true;
    h.failWhen(() => broken);
    h.saver.schedule("design", "a");
    h.timers.advance(500);
    await settle();
    expect(await h.saver.flush()).toEqual(["design"]);
    expect(h.errors).toHaveLength(2);
    broken = false;
    expect(await h.saver.flush()).toEqual([]);
    expect(h.written).toEqual([["design", "a"]]);
  });

  it("does not hold up the other workspaces", async () => {
    const h = harness();
    h.failWhen((key) => key === "bad");
    h.saver.schedule("bad", "1");
    h.saver.schedule("good", "2");
    expect(await h.saver.flush()).toEqual(["bad"]);
    expect(h.written).toEqual([["good", "2"]]);
  });

  it("does not write an older value over a newer one if the newer was kept while the older was failing", async () => {
    const h = harness();
    let broken = true;
    h.failWhen(() => broken);
    h.saver.schedule("design", "old");
    h.timers.advance(500);
    await settle();
    h.saver.schedule("design", "new");
    broken = false;
    await h.saver.flush();
    expect(h.written).toEqual([["design", "new"]]);
  });
});

describe("keeping writes in order", () => {
  it("never has two writes for one workspace under way at once", async () => {
    const h = harness();
    const release = h.holdWrites();
    h.saver.schedule("design", "a");
    h.timers.advance(500);
    await settle();
    h.saver.schedule("design", "b");
    h.timers.advance(500);
    await settle();
    expect(h.written).toEqual([]);
    release();
    await settle();
    expect(h.written).toEqual([["design", "a"], ["design", "b"]]);
  });
});

describe("deleting a workspace", () => {
  it("drops what was waiting for it so it is not written back", async () => {
    const h = harness();
    h.saver.schedule("gone", "x");
    h.saver.cancel("gone");
    h.timers.advance(1000);
    await settle();
    expect(h.written).toEqual([]);
    expect(h.saver.pending()).toEqual([]);
    expect(await h.saver.flush()).toEqual([]);
    h.saver.cancel("never-there");
  });

  it("drops a failed value too", async () => {
    const h = harness();
    h.failWhen(() => true);
    h.saver.schedule("gone", "x");
    h.timers.advance(500);
    await settle();
    h.saver.cancel("gone");
    expect(h.saver.failed()).toEqual([]);
    expect(await h.saver.flush()).toEqual([]);
  });
});

describe("what the code review of 23 Nov found", () => {
  it("does not write back the session copy of a workspace deleted while its write was failing", async () => {
    const h = harness();
    h.failWhen(() => true);
    const release = h.holdWrites();
    h.saver.schedule("old", "x");
    h.timers.advance(500);
    await settle();
    h.saver.cancel("old");
    release();
    await settle();
    expect(h.errors, "the failure of a cancelled write is not reported as a failure").toEqual([]);
    h.failWhen(() => false);
    expect(await h.saver.flush()).toEqual([]);
    expect(h.written).toEqual([]);
    expect(h.saver.pending()).toEqual([]);
  });

  it("tries the newest value on close when the write under way fails, before saying anything failed", async () => {
    const h = harness();
    let attempts = 0;
    h.failWhen((_key, value) => {
      attempts += 1;
      return value === "a";
    });
    const release = h.holdWrites();
    h.saver.schedule("k", "a");
    h.timers.advance(500);
    await settle();
    h.saver.schedule("k", "b");
    const done = h.saver.flush();
    release();
    expect(await done).toEqual([]);
    expect(h.written).toEqual([["k", "b"]]);
    expect(attempts).toBe(2);
  });
});
