/**
 * The preview renderer's blend-mode mapping, and its refusal.
 *
 * The defect this pins: `pixiBlendMode` used to end in `default: return "normal"`, so an author who
 * selected `overlay` got ordinary blending in the viewport, the scene validator's warning was the
 * only trace, and the native Rust renderer did something different again. A silent visual fallback
 * is worse than a loud failure, because the picture looks deliberate.
 *
 * Neither list is written out here. Both come from `@grapix/shared-types`, so a mode added to the
 * vocabulary is covered by these tests without anyone remembering to add it.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  IMPLEMENTED_BLEND_MODES,
  MATERIAL_BLEND_MODES,
  UNIMPLEMENTED_BLEND_MODES,
  type MaterialBlendMode
} from "@grapix/shared-types";

import { pixiBlendMode } from "../src/rendering/GpuSceneRenderer";

/**
 * Adobe's darken/lighten are per-channel min/max, which Pixi exposes as the fixed-function
 * "min"/"max" modes rather than under their Adobe names. Every other supported mode keeps its name.
 */
const EXPECTED_PIXI_CONSTANT: Record<string, string> = {
  normal: "normal",
  add: "add",
  multiply: "multiply",
  screen: "screen",
  darken: "min",
  lighten: "max"
};

test("every supported mode maps to its Pixi constant", () => {
  for (const mode of IMPLEMENTED_BLEND_MODES) {
    assert.equal(
      pixiBlendMode(mode),
      EXPECTED_PIXI_CONSTANT[mode],
      `${mode} must map to the Pixi constant the render-shaders contract names`
    );
  }
});

/** If a mode is added to the supported list, this test fails until its expectation is stated. */
test("the expectation table covers exactly the supported modes", () => {
  assert.deepEqual(
    [...IMPLEMENTED_BLEND_MODES].sort(),
    Object.keys(EXPECTED_PIXI_CONSTANT).sort(),
    "a newly supported mode needs an expected Pixi constant here"
  );
});

test("every unsupported mode is refused, by name", () => {
  assert.ok(UNIMPLEMENTED_BLEND_MODES.length > 0, "there are unsupported modes to refuse");

  for (const mode of UNIMPLEMENTED_BLEND_MODES) {
    assert.throws(
      () => pixiBlendMode(mode),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(
          error.message.includes(mode),
          `the refusal must name the mode; got: ${error.message}`
        );
        return true;
      },
      `${mode} must throw rather than substitute`
    );
  }
});

/**
 * The specific mode that motivated this. `overlay` is the one an author is most likely to reach
 * for, and the one PixiJS core would silently alias to `screen` if it were ever passed through.
 */
test("overlay is refused rather than drawn as screen or normal", () => {
  assert.ok(UNIMPLEMENTED_BLEND_MODES.includes("overlay"));
  assert.throws(() => pixiBlendMode("overlay"), /overlay/);

  // The two values it must never quietly become.
  for (const wrong of ["screen", "normal"]) {
    assert.notEqual(
      (() => { try { return pixiBlendMode("overlay"); } catch { return null; } })(),
      wrong
    );
  }
});

/**
 * `undefined` is an absence, not an unsupported mode: the object carries no resolved material,
 * either because nothing is bound or because the render guard rejected what was. Normal blending is
 * correct for that, and it must not throw — every unstyled object in a scene takes this path.
 */
test("no resolved material draws with normal blending and does not throw", () => {
  assert.equal(pixiBlendMode(undefined), "normal");
});

/** Every mode in the vocabulary is either mapped or refused. Nothing falls between. */
test("the vocabulary is exhaustively partitioned into mapped and refused", () => {
  for (const mode of MATERIAL_BLEND_MODES) {
    const supported = (IMPLEMENTED_BLEND_MODES as readonly MaterialBlendMode[]).includes(mode);
    if (supported) {
      assert.ok(typeof pixiBlendMode(mode) === "string", `${mode} must map`);
    } else {
      assert.throws(() => pixiBlendMode(mode), `${mode} must be refused`);
    }
  }

  assert.equal(
    IMPLEMENTED_BLEND_MODES.length + UNIMPLEMENTED_BLEND_MODES.length,
    MATERIAL_BLEND_MODES.length,
    "the two sets must partition the vocabulary with no overlap and no gap"
  );
});
