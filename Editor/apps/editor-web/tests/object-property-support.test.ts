import assert from "node:assert/strict";
import test from "node:test";
import type { SceneObject } from "@grapix/shared-types";
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
