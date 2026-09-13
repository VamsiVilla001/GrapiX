// Device pixel ratio and scale-factor changes (11.3; ADR-0002 B.2).
//
// The failures these guard are quiet. A canvas sized in CSS pixels is not
// broken, it is *soft*. A ratio observed once is not broken either — it works
// for exactly one monitor move and then goes silent. Neither throws.

import { describe, expect, it, vi } from "vitest";

import {
  backingStore,
  sizeCanvasForRatio,
  watchDevicePixelRatio,
  type MediaQueryLike,
  type RatioSource,
} from "../src/dpi";

/// A window whose ratio can be changed, with the re-arming observable.
function fakeSource(initial: number) {
  const armed: { query: string; fire: () => void }[] = [];
  let ratio = initial;
  const source: RatioSource = {
    get devicePixelRatio() {
      return ratio;
    },
    matchMedia(query: string): MediaQueryLike {
      let listener: (() => void) | undefined;
      armed.push({ query, fire: () => listener?.() });
      return {
        addEventListener: (_type, next) => {
          listener = next;
        },
        removeEventListener: () => {
          listener = undefined;
        },
      };
    },
  };
  return { source, armed, set: (next: number) => (ratio = next) };
}

function fakeCanvas() {
  return { width: 0, height: 0, style: { width: "", height: "" } };
}

describe("backing store size", () => {
  it("is CSS size times the ratio at the four required scales", () => {
    // 11.3's done-when names exactly these.
    expect(backingStore(800, 600, 1)).toEqual({ width: 800, height: 600 });
    expect(backingStore(800, 600, 1.25)).toEqual({ width: 1000, height: 750 });
    expect(backingStore(800, 600, 1.5)).toEqual({ width: 1200, height: 900 });
    expect(backingStore(800, 600, 2)).toEqual({ width: 1600, height: 1200 });
  });

  it("rounds rather than truncating a fractional result", () => {
    // 905 at 150% is 1357.5. Flooring loses a column the compositor then has
    // to invent, which is the soft edge B.2 warns about at exactly this scale.
    expect(backingStore(905, 1, 1.5).width).toBe(1358);
  });

  it("treats a nonsense ratio as 1 rather than producing an empty canvas", () => {
    expect(backingStore(800, 600, 0)).toEqual({ width: 800, height: 600 });
  });
});

describe("sizing a canvas", () => {
  it("grows the backing store while the element keeps its CSS size", () => {
    // The document is in scene coordinates and the layout is in CSS pixels;
    // only the backing store follows the display.
    const canvas = fakeCanvas();
    expect(sizeCanvasForRatio(canvas, 400, 200, 1.25)).toBe(true);
    expect(canvas).toMatchObject({ width: 500, height: 250 });
    expect(canvas.style).toEqual({ width: "400px", height: "200px" });
  });

  it("reports no change when the size already matches", () => {
    // Assigning `width` clears a canvas even when the value is identical, so
    // a caller that repainted unconditionally would repaint every frame.
    const canvas = fakeCanvas();
    sizeCanvasForRatio(canvas, 400, 200, 2);
    expect(sizeCanvasForRatio(canvas, 400, 200, 2)).toBe(false);
  });

  it("resizes when only the ratio changed", () => {
    const canvas = fakeCanvas();
    sizeCanvasForRatio(canvas, 400, 200, 1);
    expect(sizeCanvasForRatio(canvas, 400, 200, 2)).toBe(true);
    expect(canvas.width).toBe(800);
  });
});

describe("watching the ratio", () => {
  it("arms a query against the current ratio", () => {
    const { source, armed } = fakeSource(1.25);
    watchDevicePixelRatio(source, () => {});
    expect(armed).toHaveLength(1);
    expect(armed[0]!.query).toBe("(resolution: 1.25dppx)");
  });

  it("re-arms after every change, so a second monitor move is still seen", () => {
    // The bug this exists to prevent: `matchMedia` pins one exact ratio and
    // stops matching once the ratio moves. Arming once sees the first move
    // and goes quiet for every one after it.
    const { source, armed, set } = fakeSource(1);
    const seen: number[] = [];
    watchDevicePixelRatio(source, (ratio) => seen.push(ratio));

    set(1.5);
    armed[0]!.fire();
    set(2);
    armed[1]!.fire();
    set(1.25);
    armed[2]!.fire();

    expect(seen).toEqual([1.5, 2, 1.25]);
    expect(armed.map((entry) => entry.query)).toEqual([
      "(resolution: 1dppx)",
      "(resolution: 1.5dppx)",
      "(resolution: 2dppx)",
      "(resolution: 1.25dppx)",
    ]);
  });

  it("reports the ratio only after re-arming, never a stale one", () => {
    // The caller usually repaints synchronously. If it read the ratio while
    // the old query was still live it would paint at the previous scale.
    const { source, armed, set } = fakeSource(1);
    let queriesWhenReported = 0;
    watchDevicePixelRatio(source, () => {
      queriesWhenReported = armed.length;
    });
    set(2);
    armed[0]!.fire();
    expect(queriesWhenReported).toBe(2);
  });

  it("stops reporting once disposed", () => {
    const { source, armed, set } = fakeSource(1);
    const onChange = vi.fn();
    const dispose = watchDevicePixelRatio(source, onChange);
    dispose();
    set(2);
    armed[0]!.fire();
    expect(onChange).not.toHaveBeenCalled();
  });
});
