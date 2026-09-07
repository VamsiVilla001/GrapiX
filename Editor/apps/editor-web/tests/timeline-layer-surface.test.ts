/**
 * Backing-store sizing and DPR tracking.
 *
 * The pure half of the canvas layer: how big the pixel buffer must be, and whether it has to be
 * reallocated. Both matter more than they look — assigning `canvas.width` clears the canvas even
 * when the value is unchanged, so "should this resize?" decides whether a frame survives or is
 * thrown away, and a wrong answer shows up as flicker that is miserable to reproduce by hand.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  backingStoreSize,
  needsResize,
  watchDevicePixelRatio
} from "../src/components/timeline/layerSurface";

test("the backing store is the CSS box scaled by the device pixel ratio", () => {
  assert.deepEqual(backingStoreSize(800, 400, 1), { width: 800, height: 400 });
  assert.deepEqual(backingStoreSize(800, 400, 2), { width: 1_600, height: 800 });
  assert.deepEqual(backingStoreSize(800, 400, 1.5), { width: 1_200, height: 600 });
});

/** A 100.5px box at 2x is 201 device pixels; flooring leaves a half-pixel column unpainted. */
test("a fractional box rounds rather than truncates", () => {
  assert.deepEqual(backingStoreSize(100.5, 50.5, 2), { width: 201, height: 101 });
  assert.deepEqual(backingStoreSize(100.4, 50, 1), { width: 100, height: 50 });
});

test("a degenerate box or ratio still yields a usable buffer", () => {
  assert.deepEqual(backingStoreSize(0, 0, 2), { width: 1, height: 1 }, "zero-sized canvases throw on getContext");
  assert.deepEqual(backingStoreSize(800, 400, 0), { width: 800, height: 400 }, "a zero ratio falls back to 1");
  assert.deepEqual(backingStoreSize(800, 400, -2), { width: 800, height: 400 });
});

test("resize is required only when the buffer size actually differs", () => {
  assert.equal(needsResize({ width: 800, height: 400 }, { width: 800, height: 400 }), false);
  assert.equal(needsResize({ width: 800, height: 400 }, { width: 801, height: 400 }), true);
  assert.equal(needsResize({ width: 800, height: 400 }, { width: 800, height: 401 }), true);
});

/**
 * The case the check exists for: a CSS resize that lands on the same device-pixel buffer must not
 * reallocate, because reallocating clears every layer.
 */
test("a CSS change that rounds to the same buffer does not force a clear", () => {
  // Both land on 200 device pixels at 2x (200.4 and 200.48 round down), so the buffer is unchanged
  // and must not be reallocated. A layout that jitters by a fraction of a pixel is ordinary.
  const before = backingStoreSize(100.2, 50, 2);
  const after = backingStoreSize(100.24, 50, 2);

  assert.deepEqual(before, { width: 200, height: 100 });
  assert.deepEqual(before, after);
  assert.equal(needsResize(before, after), false);
});

/* ── DPR tracking ─────────────────────────────────────────────────────────────────────────── */

/** A fake `matchMedia` whose query can be made to stop matching, as moving displays does. */
function fakeScope(initialRatio: number) {
  const listeners: Array<{ query: string; handler: () => void }> = [];
  const scope = {
    devicePixelRatio: initialRatio,
    matchMedia(query: string) {
      const entry = { query, handler: () => {} };
      return {
        media: query,
        matches: true,
        addEventListener: (_type: string, handler: () => void) => {
          entry.handler = handler;
          listeners.push(entry);
        },
        removeEventListener: (_type: string, handler: () => void) => {
          const index = listeners.findIndex((item) => item.handler === handler);
          if (index >= 0) listeners.splice(index, 1);
        }
      } as unknown as MediaQueryList;
    }
  };
  return {
    scope,
    listeners,
    /** Simulate the window moving to a display of a different density. */
    moveTo(ratio: number) {
      scope.devicePixelRatio = ratio;
      // The query bound to the old ratio stops matching and fires.
      listeners.slice().forEach((entry) => entry.handler());
    }
  };
}

test("a ratio change is reported, and the watcher re-arms against the new ratio", () => {
  const { scope, listeners, moveTo } = fakeScope(2);
  const seen: number[] = [];

  const stop = watchDevicePixelRatio((ratio) => seen.push(ratio), scope);
  assert.equal(listeners.length, 1, "armed against the current ratio");
  assert.match(listeners[0].query, /2dppx/);

  moveTo(1);
  assert.deepEqual(seen, [1], "moving to a 1x display is reported");
  assert.equal(listeners.length, 1, "and the watcher re-armed");
  assert.match(listeners[0].query, /1dppx/, "against the new ratio, not the old one");

  moveTo(3);
  assert.deepEqual(seen, [1, 3], "and keeps working after the first change");

  stop();
  assert.equal(listeners.length, 0, "unsubscribing removes the listener");
});

test("no further reports arrive after unsubscribing", () => {
  const { scope, moveTo } = fakeScope(2);
  const seen: number[] = [];

  const stop = watchDevicePixelRatio((ratio) => seen.push(ratio), scope);
  stop();
  moveTo(1);

  assert.deepEqual(seen, [], "a stopped watcher must not resurrect itself when re-arming");
});

/** Tests and older engines have no matchMedia; the ratio is then never re-reported. */
test("an environment without matchMedia degrades quietly", () => {
  const stop = watchDevicePixelRatio(() => assert.fail("must not fire"), { devicePixelRatio: 2 });
  assert.equal(typeof stop, "function");
  stop();
});
