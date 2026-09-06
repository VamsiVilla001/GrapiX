import assert from "node:assert/strict";
import test from "node:test";
import type { SceneObject } from "@grapix/shared-types";
import {
  DEFAULT_OBJECT_COLUMNS,
  OBJECT_COLUMNS,
  animatedColumns,
  columnProperty,
  isColumnAnimatable,
  isColumnSupported,
  orderColumns,
  readColumnValue,
  resolveColumns,
  toggleColumn
} from "../src/components/objectManagerColumns";

function object(type: SceneObject["type"], overrides: Record<string, unknown> = {}): SceneObject {
  return {
    id: `${type}-1`,
    type,
    name: type,
    x: 10,
    y: 20,
    zDepth: 0,
    rotation: 45,
    opacity: 0.5,
    bindings: {},
    materialSlots: {},
    ...overrides
  } as unknown as SceneObject;
}

/**
 * The panel used to carry its own support list, and it had drifted: Rotate X and Rotate Y were
 * offered on layers and groups, which `resolveSceneObjectHierarchy` never reads. Routing through
 * `isPropertySupported` is what stops a cell from editing a value nothing renders.
 */
test("three-axis rotation is offered on meshes only, and depth scale on containers too", () => {
  assert.equal(isColumnSupported(object("mesh"), "rotationX"), true);
  assert.equal(isColumnSupported(object("layer"), "rotationX"), false);
  assert.equal(isColumnSupported(object("group"), "rotationY"), false);
  assert.equal(isColumnSupported(object("rect"), "rotationX"), false);

  assert.equal(isColumnSupported(object("mesh"), "scaleZ"), true);
  assert.equal(isColumnSupported(object("layer"), "scaleZ"), true);
  assert.equal(isColumnSupported(object("rect"), "scaleZ"), false);
});

/**
 * Editable is not the same question as animatable, and conflating them is what let a rect acquire
 * a `zDepth` channel: depth is real paint order on a rect, so the number must stay editable, while
 * Program resolves it during preparation and discards a channel on it. `shape` sits with `mesh`
 * because a bezier shape is tessellated into a prepared mesh and animates Z like one.
 */
test("the Z-Pos column stays editable everywhere and animatable only on the mesh path", () => {
  assert.equal(isColumnSupported(object("rect"), "zDepth"), true, "still editable");
  assert.equal(isColumnAnimatable(object("rect"), "zDepth"), false);
  assert.equal(isColumnAnimatable(object("text"), "zDepth"), false);
  assert.equal(isColumnAnimatable(object("image"), "zDepth"), false);
  assert.equal(isColumnAnimatable(object("layer"), "zDepth"), false);
  assert.equal(isColumnAnimatable(object("mesh"), "zDepth"), true);
  assert.equal(isColumnAnimatable(object("shape"), "zDepth"), true);
});

test("every other column is animatable wherever it is supported", () => {
  for (const column of OBJECT_COLUMNS.map((entry) => entry.id)) {
    if (column === "zDepth") continue;
    for (const type of ["rect", "text", "mesh", "layer"] as const) {
      if (!isColumnSupported(object(type), column)) continue;
      assert.equal(isColumnAnimatable(object(type), column), true, `${type}.${column}`);
    }
  }
});

test("Keyframed mode ignores a legacy channel the renderer will not play", () => {
  const inert = object("rect", { animation: { zDepth: { keys: [{ id: "a", frame: 0, value: 0 }] } } });
  const real = object("mesh", { animation: { zDepth: { keys: [{ id: "a", frame: 0, value: 0 }] } } });

  assert.deepEqual(animatedColumns([inert]), [], "an inert 2D depth channel is not a keyframed column");
  assert.deepEqual(animatedColumns([real]), ["zDepth"]);
});

/** A mesh keeps its Z angle on `rotationZ`; everything else keeps the same angle on `rotation`. */
test("the Rot Z column resolves to whichever property the object actually uses", () => {
  assert.equal(columnProperty(object("mesh"), "rotationZ"), "rotationZ");
  assert.equal(columnProperty(object("rect"), "rotationZ"), "rotation");
  assert.equal(columnProperty(object("rect"), "x"), "x");
});

test("column values read through the resolved property, with sane defaults", () => {
  assert.equal(readColumnValue(object("rect"), "rotationZ"), 45);
  assert.equal(readColumnValue(object("rect"), "opacity"), 0.5);
  assert.equal(readColumnValue(object("rect"), "scaleX"), 1, "absent scale reads as 1, not 0");
  assert.equal(readColumnValue(object("rect"), "rotationX"), 0);
});

/** Chosen columns are re-sorted, so the table reads the same however they were enabled. */
test("column choices are normalised into catalogue order and deduplicated", () => {
  assert.deepEqual(orderColumns(["y", "opacity", "x", "opacity"]), ["opacity", "x", "y"]);
  assert.deepEqual(orderColumns(["nonsense", "x"]), ["x"], "an unknown id cannot become a blank column");
  assert.deepEqual(orderColumns([]), []);
});

test("toggling adds in catalogue order and removes cleanly", () => {
  assert.deepEqual(toggleColumn(["opacity"], "x"), ["opacity", "x"]);
  assert.deepEqual(toggleColumn(["opacity", "x"], "opacity"), ["x"]);
  assert.deepEqual(toggleColumn(["scaleX"], "opacity"), ["opacity", "scaleX"], "insertion order never leaks");
});

test("the Animated shortcut reports only columns something in the scene keys", () => {
  const animated = object("rect", {
    animation: { x: { keys: [{ id: "k", frame: 0, value: 1, easing: "linear" }] } }
  });
  const still = object("rect", { id: "still" });

  assert.deepEqual(animatedColumns([animated, still]), ["x"]);
  assert.deepEqual(animatedColumns([still]), []);
});

test("the default column set is a working subset, not the whole catalogue", () => {
  assert.deepEqual([...DEFAULT_OBJECT_COLUMNS], ["opacity", "x", "y"]);
  assert.ok(DEFAULT_OBJECT_COLUMNS.length < OBJECT_COLUMNS.length);
});

/**
 * "Keyframed" is a mode, so it re-derives from the scene every time. A preset that filled the
 * custom set in once would be right until the next stopwatch was enabled and wrong after.
 */
test("column modes derive from the scene and leave the custom set alone", () => {
  const animated = object("rect", {
    animation: { scaleX: { keys: [{ id: "k", frame: 0, value: 1, easing: "linear" }] } }
  });
  const custom = ["opacity", "x"];

  assert.deepEqual(resolveColumns("all", custom, [animated]), OBJECT_COLUMNS.map((c) => c.id));
  assert.deepEqual(resolveColumns("keyframed", custom, [animated]), ["scaleX"]);
  assert.deepEqual(resolveColumns("custom", custom, [animated]), ["opacity", "x"]);

  // Animating another property changes what the mode shows, with no stored set to update.
  const alsoAnimated = object("rect", {
    id: "second",
    animation: { opacity: { keys: [{ id: "k2", frame: 0, value: 1, easing: "linear" }] } }
  });
  assert.deepEqual(resolveColumns("keyframed", custom, [animated, alsoAnimated]), ["opacity", "scaleX"]);
});

/** With nothing animated the keyframed mode is legitimately empty — the panel says so. */
test("keyframed mode resolves to no columns when the scene has no animation", () => {
  assert.deepEqual(resolveColumns("keyframed", ["opacity"], [object("rect")]), []);
});
