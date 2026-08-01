import assert from "node:assert/strict";
import test from "node:test";
import { withColorStyles } from "../src/store/objectColorStyles";

test("a factory colour becomes the rich style the renderers actually draw from", () => {
  // The pen tool's exact case: it asked for these two colours and drew neither, because the base
  // object's unassigned styles were the ones `pixiColorValue(fillStyle, fill)` read.
  const painted = withColorStyles({ fill: "#7c5cff", stroke: "#ffffff" });

  assert.deepEqual(painted.fillStyle, { type: "solid", color: "#7c5cff" });
  assert.deepEqual(painted.strokeStyle, { type: "solid", color: "#ffffff" });
});

test("an explicit style wins, so a caller asking for a gradient keeps it", () => {
  const gradient = {
    type: "linear-gradient" as const,
    angle: 90,
    startX: 0,
    startY: 0,
    endX: 1,
    endY: 0,
    stops: [],
    spread: "pad" as const,
    coordinateMode: "object" as const
  };

  assert.equal(withColorStyles({ fill: "#7c5cff", fillStyle: gradient }).fillStyle, gradient);
});

test("transparent becomes no paint at all, not a transparent paint", () => {
  assert.deepEqual(withColorStyles({ fill: "transparent" }).fillStyle, { type: "none" });
  assert.deepEqual(withColorStyles({ stroke: "TRANSPARENT" }).strokeStyle, { type: "none" });
});

test("a layer that names no colour is left alone", () => {
  const layer = { fillEnabled: true };
  assert.deepEqual(withColorStyles(layer), layer);
  assert.equal("fillStyle" in withColorStyles(layer), false);
});
