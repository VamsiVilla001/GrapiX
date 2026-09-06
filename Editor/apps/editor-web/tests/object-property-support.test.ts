import assert from "node:assert/strict";
import test from "node:test";
import type { SceneObject } from "@grapix/shared-types";
import { isBindingAssignable } from "@grapix/shared-types";
import {
  bindablePropertiesFor,
  isPropertySupported
} from "../src/store/objectPropertySupport";

function objectOfType(type: SceneObject["type"]): SceneObject {
  // Only `type` is read by the support rule; the rest is filler so the object typechecks.
  return {
    id: "object-1",
    name: "Object 1",
    type,
    x: 0,
    y: 0,
    zDepth: 0,
    zIndex: 0,
    layerId: "main",
    width: 100,
    height: 100,
    rotation: 0,
    opacity: 1,
    visible: true,
    locked: false,
    fill: "#ffffff",
    stroke: "#000000",
    strokeWidth: 0,
    bindings: {},
    materialSlots: {}
  } as SceneObject;
}

test("text and src are offered only on the type that has them", () => {
  assert.equal(isPropertySupported(objectOfType("text"), "text"), true);
  assert.equal(isPropertySupported(objectOfType("rect"), "text"), false);
  assert.equal(isPropertySupported(objectOfType("image"), "src"), true);
  assert.equal(isPropertySupported(objectOfType("text"), "src"), false);
});

test("three-axis rotation is mesh-only, because containers never inherit X or Y", () => {
  for (const property of ["rotationX", "rotationY", "rotationZ"] as const) {
    assert.equal(isPropertySupported(objectOfType("mesh"), property), true);
    assert.equal(isPropertySupported(objectOfType("layer"), property), false);
    assert.equal(isPropertySupported(objectOfType("group"), property), false);
    assert.equal(isPropertySupported(objectOfType("rect"), property), false);
  }
});

test("a mesh binds rotationZ and everything else binds rotation, never both", () => {
  assert.equal(isPropertySupported(objectOfType("mesh"), "rotation"), false);
  assert.equal(isPropertySupported(objectOfType("layer"), "rotation"), true);
  assert.equal(isPropertySupported(objectOfType("rect"), "rotation"), true);
});

test("depth scale reaches meshes directly and through the containers that inherit it", () => {
  assert.equal(isPropertySupported(objectOfType("mesh"), "scaleZ"), true);
  assert.equal(isPropertySupported(objectOfType("layer"), "scaleZ"), true);
  assert.equal(isPropertySupported(objectOfType("group"), "scaleZ"), true);
  assert.equal(isPropertySupported(objectOfType("rect"), "scaleZ"), false);
});

test("the bindable list keeps declaration order and drops what the type cannot use", () => {
  const properties = bindablePropertiesFor(objectOfType("rect"));
  assert.equal(properties.includes("text"), false);
  assert.equal(properties.includes("src"), false);
  assert.equal(properties.includes("rotationX"), false);
  assert.deepEqual(properties.slice(0, 4), ["fill", "stroke", "visible", "x"]);
});

/*
 * The container binding row, removed.
 *
 * The gate allows two outcomes and no third: a layer/group `scaleZ` binding either moves a mesh child
 * or is not offered. It cannot move one — `assignBoundValue` writes `scaleZ` for meshes only, and the
 * native renderer resolves no bindings — so it is not offered.
 *
 * The *column* is a different question and stays: setting a layer's `scaleZ` by hand does reach the
 * child, because hierarchy inheritance is not binding assignment.
 */

for (const containerType of ["layer", "group"] as const) {
  test(`a ${containerType} offers no scaleZ binding row`, () => {
    const properties = bindablePropertiesFor(objectOfType(containerType));
    assert.equal(properties.includes("scaleZ"), false);
  });

  test(`a ${containerType} still supports scaleZ for direct editing`, () => {
    // The grid cell keeps working: this is the half that was right all along.
    assert.equal(isPropertySupported(objectOfType(containerType), "scaleZ"), true);
  });
}

test("a mesh keeps its scaleZ binding row, because the applier writes it", () => {
  assert.equal(bindablePropertiesFor(objectOfType("mesh")).includes("scaleZ"), true);
});

test("no object is offered a binding row the applier would refuse", () => {
  // The general form of the same rule, so the next advertised-but-inert option fails here.
  const types = ["text", "rect", "ellipse", "image", "line", "shape", "paint", "mesh", "light", "camera", "layer", "group", "marker"] as const;
  for (const type of types) {
    const object = objectOfType(type);
    for (const property of bindablePropertiesFor(object)) {
      assert.equal(
        isBindingAssignable(object, property),
        true,
        `${type} is offered a ${property} binding the applier will not write`
      );
    }
  }
});
