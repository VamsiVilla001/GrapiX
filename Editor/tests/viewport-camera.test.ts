// Panning and zooming the viewport (11.105): the point under the pointer stays under it, the picture cannot be lost, and
// the readout says what the picture is shown at.
import { describe, expect, it } from "vitest";
import {
  FIT,
  KEEP_IN_VIEW,
  MAX_ZOOM,
  MIN_ZOOM,
  ZOOM_STEP,
  atPercent,
  cameraTransform,
  clampPan,
  clampZoom,
  isFit,
  panBy,
  wheelFactor,
  zoomAt,
  zoomLabel,
  type Camera,
} from "../src/viewport-camera";

const pane = { width: 1000, height: 600 };
const picture = { width: 800, height: 450 };

/** Where a point of the surface (offset from its middle) is on the screen, from the pane's middle. */
const onScreen = (camera: Camera, point: { x: number; y: number }) => ({
  x: camera.zoom * point.x + camera.panX,
  y: camera.zoom * point.y + camera.panY,
});

describe("zooming", () => {
  it("keeps the point under the pointer where it is on the screen", () => {
    let camera: Camera = FIT;
    const at = { x: 120, y: -80 };
    // The picture point under the pointer, from the surface's middle.
    const under = { x: (at.x - camera.panX) / camera.zoom, y: (at.y - camera.panY) / camera.zoom };
    for (const factor of [2, 1.25, 0.5, 3, 0.8]) {
      camera = zoomAt(camera, factor, at, pane, picture);
      const now = onScreen(camera, under);
      expect(now.x).toBeCloseTo(at.x, 6);
      expect(now.y).toBeCloseTo(at.y, 6);
    }
  });

  it("keeps the point under the pointer from a panned camera too", () => {
    const start: Camera = { zoom: 2, panX: 60, panY: -40 };
    const at = { x: -200, y: 100 };
    const under = { x: (at.x - start.panX) / start.zoom, y: (at.y - start.panY) / start.zoom };
    const next = zoomAt(start, 1.5, at, pane, picture);
    expect(onScreen(next, under).x).toBeCloseTo(at.x, 6);
    expect(onScreen(next, under).y).toBeCloseTo(at.y, 6);
  });

  it("zooms about the middle when the pointer is on the middle, so the pan does not move", () => {
    expect(zoomAt(FIT, 2, { x: 0, y: 0 }, pane, picture)).toEqual({ zoom: 2, panX: 0, panY: 0 });
  });

  it("stops at the least and most zoom, and changes nothing there", () => {
    const most = zoomAt(FIT, 1000, { x: 0, y: 0 }, pane, picture);
    expect(most.zoom).toBe(MAX_ZOOM);
    expect(zoomAt(most, 2, { x: 5, y: 5 }, pane, picture)).toBe(most);
    const least = zoomAt(FIT, 0.0001, { x: 0, y: 0 }, pane, picture);
    expect(least.zoom).toBe(MIN_ZOOM);
    expect(zoomAt(least, 0.5, { x: 5, y: 5 }, pane, picture)).toBe(least);
  });

  it("clamps a zoom that is not a number to Fit's, and a number outside the range to its edge", () => {
    expect(clampZoom(Number.NaN)).toBe(1);
    expect(clampZoom(Number.POSITIVE_INFINITY)).toBe(1);
    expect(clampZoom(0)).toBe(MIN_ZOOM);
    expect(clampZoom(1e9)).toBe(MAX_ZOOM);
    expect(clampZoom(3)).toBe(3);
  });

  it("goes in by a quarter at a time", () => {
    expect(ZOOM_STEP).toBe(1.25);
    expect(zoomAt(FIT, ZOOM_STEP, { x: 0, y: 0 }, pane, picture).zoom).toBe(1.25);
  });

  it("goes in and out by the same step, so one undoes the other", () => {
    const there = zoomAt(FIT, ZOOM_STEP, { x: 0, y: 0 }, pane, picture);
    const back = zoomAt(there, 1 / ZOOM_STEP, { x: 0, y: 0 }, pane, picture);
    expect(back.zoom).toBeCloseTo(1, 9);
  });
});

describe("panning", () => {
  it("moves the camera by the drag", () => {
    expect(panBy({ zoom: 2, panX: 10, panY: 20 }, 30, -15, pane, picture)).toEqual({ zoom: 2, panX: 40, panY: 5 });
  });

  it("cannot push the picture out of reach: at least a margin of it stays in the pane", () => {
    const far = panBy({ zoom: 1, panX: 0, panY: 0 }, 100000, -100000, pane, picture);
    // The picture is 800 wide in a 1000 pane: its middle may be at most (1000 + 800) / 2 - margin from the pane's middle.
    expect(far.panX).toBe((1000 + 800) / 2 - KEEP_IN_VIEW);
    expect(far.panY).toBe(-((600 + 450) / 2 - KEEP_IN_VIEW));
    // So its near edge is still the margin inside the pane.
    expect(far.panX - 400).toBe(1000 / 2 - KEEP_IN_VIEW);
  });

  it("allows more room when zoomed in, since the picture is bigger", () => {
    const small = clampPan({ zoom: 1, panX: 1e6, panY: 0 }, pane, picture).panX;
    const big = clampPan({ zoom: 4, panX: 1e6, panY: 0 }, pane, picture).panX;
    expect(big).toBeGreaterThan(small);
  });

  it("repairs a camera that is not numbers", () => {
    expect(clampPan({ zoom: Number.NaN, panX: Number.NaN, panY: Number.POSITIVE_INFINITY }, pane, picture)).toEqual({
      zoom: 1,
      panX: 0,
      panY: expect.any(Number),
    });
    expect(Number.isFinite(clampPan({ zoom: 1, panX: 0, panY: Number.POSITIVE_INFINITY }, pane, picture).panY)).toBe(true);
  });

  it("never gives a negative room for a pane smaller than the margin", () => {
    const tiny = clampPan({ zoom: MIN_ZOOM, panX: 500, panY: 500 }, { width: 10, height: 10 }, { width: 10, height: 10 });
    expect(tiny.panX).toBe(0);
    expect(tiny.panY).toBe(0);
  });
});

describe("the wheel", () => {
  it("zooms in for a turn away and out for a turn towards, by the same amount each way", () => {
    expect(wheelFactor(-100)).toBeGreaterThan(1);
    expect(wheelFactor(100)).toBeLessThan(1);
    expect(wheelFactor(-100) * wheelFactor(100)).toBeCloseTo(1, 9);
  });

  it("does nothing for no turn or a turn that is not a number, and limits a huge one", () => {
    expect(wheelFactor(0)).toBe(1);
    expect(wheelFactor(Number.NaN)).toBe(1);
    expect(wheelFactor(-1e9)).toBe(wheelFactor(-600));
    expect(wheelFactor(1e9)).toBe(wheelFactor(600));
  });

  it("takes a small trackpad turn as a small zoom", () => {
    expect(Math.abs(Math.log(wheelFactor(-4)))).toBeLessThan(Math.abs(Math.log(wheelFactor(-100))));
  });
});

describe("the readout and 100 percent", () => {
  // The picture fits the pane at 0.5 screen pixels per canvas pixel.
  const fit = 0.5;

  it("says what the picture is shown at, as a percent of its own size", () => {
    expect(zoomLabel(FIT, fit)).toBe("50%");
    expect(zoomLabel({ zoom: 2, panX: 0, panY: 0 }, fit)).toBe("100%");
    expect(zoomLabel({ zoom: 0.3, panX: 0, panY: 0 }, fit)).toBe("15%");
    expect(zoomLabel({ zoom: 0.1, panX: 0, panY: 0 }, 0.5)).toBe("5%");
    expect(zoomLabel({ zoom: 0.1, panX: 0, panY: 0 }, 0.4)).toBe("4%");
    expect(zoomLabel({ zoom: 0.1, panX: 0, panY: 0 }, 0.37)).toBe("3.7%");
    // From ten percent up it is a whole number, below it one decimal.
    expect(zoomLabel({ zoom: 0.624, panX: 0, panY: 0 }, 0.5)).toBe("31%");
    expect(zoomLabel({ zoom: 0.2, panX: 0, panY: 0 }, 0.5)).toBe("10%");
    expect(zoomLabel({ zoom: 0.19, panX: 0, panY: 0 }, 0.5)).toBe("9.5%");
  });

  it("says nothing before the picture has a size", () => {
    expect(zoomLabel(FIT, 0)).toBe("");
    expect(zoomLabel(FIT, Number.NaN)).toBe("");
  });

  it("goes to 100 percent: one canvas pixel to one screen pixel, about the pane's middle", () => {
    const at100 = atPercent(FIT, 100, fit, pane, picture);
    expect(at100.zoom).toBeCloseTo(2, 9);
    expect(zoomLabel(at100, fit)).toBe("100%");
    // From a panned, zoomed camera it still lands on 100 percent.
    const from = atPercent({ zoom: 5, panX: 70, panY: 30 }, 100, fit, pane, picture);
    expect(zoomLabel(from, fit)).toBe("100%");
  });

  it("goes to any percent, and not when the picture has no size", () => {
    expect(atPercent(FIT, 25, fit, pane, picture).zoom).toBeCloseTo(0.5, 9);
    expect(atPercent(FIT, 100, 0, pane, picture)).toBe(FIT);
    // A size that is not positive is no size: the camera is left as it is, not sent to an edge of the range.
    expect(atPercent(FIT, 100, -1, pane, picture)).toBe(FIT);
    expect(atPercent(FIT, 100, Number.NaN, pane, picture)).toBe(FIT);
  });

  it("zooms about the middle of the pane, so a pan shrinks and grows with the picture", () => {
    const panned: Camera = { zoom: 2, panX: 100, panY: 50 };
    const at100 = atPercent(panned, 100, fit, pane, picture);
    // From zoom 2 to zoom 2 nothing changes at 100% of 0.5; go to 200%: zoom 4, the pan doubles.
    expect(at100).toEqual(panned);
    const at200 = atPercent(panned, 200, fit, pane, picture);
    expect(at200.zoom).toBeCloseTo(4, 9);
    expect(at200.panX).toBeCloseTo(200, 6);
    expect(at200.panY).toBeCloseTo(100, 6);
  });
});

describe("the transform", () => {
  it("is nothing at Fit, so a view that was never moved leaves the page's own layout alone", () => {
    expect(cameraTransform(FIT)).toBe("");
    expect(isFit(FIT)).toBe(true);
  });

  it("moves, then scales", () => {
    expect(cameraTransform({ zoom: 2, panX: 10.5, panY: -4 })).toBe("translate(10.5px, -4px) scale(2)");
    expect(isFit({ zoom: 2, panX: 0, panY: 0 })).toBe(false);
    expect(isFit({ zoom: 1, panX: 1, panY: 0 })).toBe(false);
  });

  it("rounds so the style does not change for noise", () => {
    expect(cameraTransform({ zoom: 1.00000001, panX: 0.0000001, panY: 0 })).toBe("translate(0px, 0px) scale(1)");
  });
});
