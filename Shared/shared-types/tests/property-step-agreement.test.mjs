import assert from "node:assert/strict";
import test from "node:test";
import { labelWithUnit, propertyConstraint, propertyStep } from "../dist/index.js";

/**
 * One editing grammar: a step belongs to the property, not to the panel showing it.
 *
 * What this defends. The Object Manager's grid cells and the Inspector's animated fields edit the same
 * properties, and each decided its own step — the grid with an inline
 * `column.startsWith("scale") ? 0.01 : 0.1`, the field with `props.step ?? 1` plus a `step={0.05}` at
 * six call sites. Measured live before the fix: a 27-pixel drag on `x` moved the object **2.7px in the
 * Object Manager and 27px in the Inspector**. Both panels now read `propertyStep`, so a divergence has
 * to be introduced here, in one place, where it is visible.
 */

/** Every property both panels put a number field on. */
const SHARED_PROPERTIES = [
  "x",
  "y",
  "zDepth",
  "rotation",
  "rotationX",
  "rotationY",
  "rotationZ",
  "scaleX",
  "scaleY",
  "scaleZ",
  "opacity"
];

test("every property both panels edit declares a step", () => {
  for (const property of SHARED_PROPERTIES) {
    const constraint = propertyConstraint("rect", property);
    assert.ok(constraint, `${property} should be in the table`);
    assert.ok(
      Number.isFinite(constraint.step) && constraint.step > 0,
      `${property} step should be a positive finite number, got ${constraint.step}`
    );
  }
});

test("a step is the same whichever panel asks for it", () => {
  // The accessor is the whole agreement: there is no per-panel argument to pass.
  for (const property of SHARED_PROPERTIES) {
    assert.equal(propertyStep("rect", property), propertyConstraint("rect", property).step);
  }
});

test("scale steps finer than position, because a scale is a multiplier", () => {
  assert.ok(
    propertyStep("rect", "scaleX") < propertyStep("rect", "x"),
    "one pixel of drag should move a multiplier less than it moves a coordinate"
  );
});

test("an unconstrained property steps by one rather than by nothing", () => {
  // A zero step would freeze the field; an undefined one would make `step` invalid markup.
  assert.equal(propertyStep("rect", "notAProperty"), 1);
});

test("opacity is stored 0..1, so its step is a hundredth and not a whole unit", () => {
  // The grid displays it as a percentage and scales the step with the display; the Inspector edits the
  // stored number. Both move the object by the same amount per pixel, which is what "equal" means here.
  const opacity = propertyConstraint("rect", "opacity");
  assert.equal(opacity.min, 0);
  assert.equal(opacity.max, 1);
  assert.equal(opacity.step, 0.01);
});

test("a label carries the unit the property is measured in", () => {
  assert.equal(labelWithUnit("X", "rect", "x"), "X (px)");
  assert.equal(labelWithUnit("Scale X", "rect", "scaleX"), "Scale X (×)");
  assert.equal(labelWithUnit("Cone", "light", "coneAngleDeg"), "Cone (°)");
  // Unitless stays bare rather than gaining an empty pair of brackets.
  assert.equal(labelWithUnit("Opacity", "rect", "opacity"), "Opacity");
});
