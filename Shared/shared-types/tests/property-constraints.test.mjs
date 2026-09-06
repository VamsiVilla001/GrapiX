import assert from "node:assert/strict";
import test from "node:test";
import {
  MIN_CAMERA_FAR_SPAN,
  labelWithUnit,
  normalizeCameraPlanes,
  normalizeSlabBevels,
  normalizePropertyValue,
  propertyConstraint
} from "../dist/index.js";

/**
 * The clamps an author's typing has to pass through.
 *
 * Every bound here is transcribed from what a renderer already does on read, and these tests are the
 * only thing holding the two together. Before this, typing 500 into a spot light's cone angle saved 500,
 * showed 500 and drew 179 — three numbers for one property, with nothing to say which was real.
 */

test("a cone wider than the renderer accepts is brought back to 179 degrees", () => {
  assert.equal(normalizePropertyValue("light", "coneAngleDeg", 500), 179);
  assert.equal(normalizePropertyValue("light", "coneAngleDeg", 0), 1);
  assert.equal(normalizePropertyValue("light", "coneAngleDeg", 45), 45);
});

test("a field of view is held between 1 and 179 degrees", () => {
  assert.equal(normalizePropertyValue("camera", "fov", 400), 179);
  assert.equal(normalizePropertyValue("camera", "fov", -10), 1);
});

test("zoom is held between 0.01 and 100", () => {
  assert.equal(normalizePropertyValue("camera", "zoom", 1000), 100);
  assert.equal(normalizePropertyValue("camera", "zoom", 0), 0.01);
});

test("penumbra is a fraction, not a percentage", () => {
  assert.equal(normalizePropertyValue("light", "penumbra", 50), 1);
  assert.equal(normalizePropertyValue("light", "penumbra", -1), 0);
});

test("a negative dimension is floored at zero", () => {
  assert.equal(normalizePropertyValue("rect", "width", -40), 0);
  assert.equal(normalizePropertyValue("rect", "height", -1), 0);
  assert.equal(normalizePropertyValue("rect", "strokeWidth", -5), 0);
});

test("opacity stays inside 0..1 whichever way it is overshot", () => {
  assert.equal(normalizePropertyValue("rect", "opacity", 5), 1);
  assert.equal(normalizePropertyValue("rect", "opacity", -5), 0);
});

test("a mesh cannot be extruded to nothing", () => {
  // A zero-depth mesh is a plane, which is a different object; `slabGeometry` floors it on read.
  assert.equal(normalizePropertyValue("mesh", "depth", 0), 0.01);
  assert.equal(normalizePropertyValue("mesh", "depth", -100), 0.01);
});

test("NaN and Infinity become the documented fallback rather than being stored", () => {
  // The worst case: NaN in a transform propagates through every matrix that touches it and the object
  // disappears with no error anywhere.
  assert.equal(normalizePropertyValue("rect", "x", Number.NaN), 0);
  assert.equal(normalizePropertyValue("rect", "scaleX", Number.NaN), 1);
  assert.equal(normalizePropertyValue("camera", "fov", Number.POSITIVE_INFINITY), 50);
  assert.equal(normalizePropertyValue("light", "coneAngleDeg", Number.NEGATIVE_INFINITY), 45);
  assert.equal(normalizePropertyValue("rect", "x", "120"), 0, "a string is not a number");
});

test("a scale defaults to 1, not 0, so a bad value does not collapse the object", () => {
  assert.equal(propertyConstraint("rect", "scaleX")?.fallback, 1);
  assert.equal(propertyConstraint("rect", "scaleY")?.fallback, 1);
  assert.equal(propertyConstraint("mesh", "scaleZ")?.fallback, 1);
});

test("an unconstrained property passes a finite number through untouched", () => {
  assert.equal(normalizePropertyValue("rect", "radius", 12), 12);
  assert.equal(normalizePropertyValue("rect", "someUnknownProperty", 12), 12);
  assert.equal(normalizePropertyValue("rect", "someUnknownProperty", Number.NaN), undefined);
});

test("inverted clipping planes are put back in order", () => {
  // The one cross-property rule: the renderer pushes `far` beyond `near` on read, so an authored pair
  // with far <= near saves one thing and draws another.
  const fixed = normalizeCameraPlanes(1000, 10);
  assert.ok(fixed.far > fixed.near, `expected far > near, got ${JSON.stringify(fixed)}`);
  assert.equal(fixed.far, 1000 + MIN_CAMERA_FAR_SPAN);
});

test("planes already in order are left alone", () => {
  assert.deepEqual(normalizeCameraPlanes(1, 5000), { near: 1, far: 5000 });
});

test("equal planes are separated, because a zero span renders nothing", () => {
  const fixed = normalizeCameraPlanes(10, 10);
  assert.ok(fixed.far > fixed.near);
});

test("a label states its unit, so a bare number cannot be misread", () => {
  assert.equal(labelWithUnit("Cone", "light", "coneAngleDeg"), "Cone (°)");
  assert.equal(labelWithUnit("X", "rect", "x"), "X (px)");
  assert.equal(labelWithUnit("Scale X", "rect", "scaleX"), "Scale X (×)");
  // Opacity is a 0..1 fraction with no unit to state.
  assert.equal(labelWithUnit("Opacity", "rect", "opacity"), "Opacity");
});

test("every constraint declares a step and a fallback inside its own bounds", () => {
  const types = ["rect", "text", "camera", "light", "mesh"];
  const properties = [
    "x", "y", "zDepth", "width", "height", "rotation", "scaleX", "opacity", "strokeWidth",
    "fov", "zoom", "near", "far", "intensity", "range", "decay", "coneAngleDeg", "penumbra",
    "depth", "fontSize", "radius"
  ];
  for (const type of types) {
    for (const property of properties) {
      const constraint = propertyConstraint(type, property);
      if (!constraint) continue;
      assert.ok(constraint.step > 0, `${type}.${property} needs a positive step`);
      if (constraint.min !== undefined) {
        assert.ok(constraint.fallback >= constraint.min, `${type}.${property} fallback below min`);
      }
      if (constraint.max !== undefined) {
        assert.ok(constraint.fallback <= constraint.max, `${type}.${property} fallback above max`);
      }
    }
  }
});

/*
 * The slab's bevels, which constrain each other the way the clipping planes do.
 *
 * Transcribed from `slabGeometry.ts:50-66`: each size is capped at half the smaller face dimension,
 * each depth at the extrusion, and when the two depths together exceed the extrusion **both** scale
 * down proportionally. Before this the store wrote whatever was typed and the renderer quietly drew
 * something else — a 500-unit bevel depth on a 100-deep slab saved 500 and drew 50.
 */
const BOX = { width: 400, height: 200, depth: 100 };
const bevel = (size, depth, enabled = true) => ({ enabled, size, depth });

test("a bevel wider than half the smaller face is cut back to it", () => {
  const { front } = normalizeSlabBevels(BOX, bevel(500, 10), bevel(0, 0, false));
  // Half of 200, less the renderer's epsilon.
  assert.equal(front.size, 99.999);
});

test("a bevel deeper than the extrusion is cut back to it", () => {
  const { front } = normalizeSlabBevels(BOX, bevel(10, 500), bevel(0, 0, false));
  assert.equal(front.depth, 100);
});

test("two bevels that together exceed the extrusion scale down in proportion", () => {
  // 80 + 40 = 120 into a 100-deep slab: the ratio is kept, so the shape stays the shape.
  const { front, back } = normalizeSlabBevels(BOX, bevel(10, 80), bevel(10, 40));
  assert.equal(Number((front.depth + back.depth).toFixed(6)), 100);
  assert.equal(Number((front.depth / back.depth).toFixed(6)), 2);
});

test("two bevels that fit are left exactly as authored", () => {
  const { front, back } = normalizeSlabBevels(BOX, bevel(10, 30), bevel(10, 20));
  assert.equal(front.depth, 30);
  assert.equal(back.depth, 20);
});

test("a disabled bevel contributes nothing, so it cannot squeeze the other", () => {
  const { front, back } = normalizeSlabBevels(BOX, bevel(10, 90), bevel(10, 90, false));
  assert.equal(front.depth, 90, "an enabled bevel keeps its depth when the other is off");
  assert.equal(back.depth, 0);
  assert.equal(back.size, 0);
});

test("a non-finite bevel becomes zero rather than propagating NaN through the mesh", () => {
  const { front } = normalizeSlabBevels(BOX, bevel(Number.NaN, Number.POSITIVE_INFINITY), bevel(0, 0, false));
  assert.equal(front.size, 0);
  assert.equal(front.depth, 0);
});

test("a slab with no extrusion keeps the renderer's floor rather than dividing by zero", () => {
  const { front, back } = normalizeSlabBevels({ width: 400, height: 200, depth: 0 }, bevel(10, 5), bevel(10, 5));
  assert.equal(Number((front.depth + back.depth).toFixed(6)), 0.01);
  assert.ok(Number.isFinite(front.depth) && Number.isFinite(back.depth));
});
