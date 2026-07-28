import assert from "node:assert/strict";
import test from "node:test";
import { normalizeSlabProperties, type MeshSceneObject } from "@grapix/shared-types";
import { createSlabGeometry } from "../src/rendering/slabGeometry";

function slab(patch: Partial<MeshSceneObject> = {}): MeshSceneObject {
  return {
    id: "slab_test",
    type: "mesh",
    meshKind: "slab",
    name: "Slab",
    x: 0,
    y: 0,
    zDepth: 0,
    zIndex: 0,
    layerId: "main",
    width: 300,
    height: 100,
    depth: 40,
    rotation: 0,
    rotationX: 0,
    rotationY: 0,
    rotationZ: 0,
    scaleX: 1,
    scaleY: 1,
    scaleZ: 1,
    anchor: { x: 0, y: 0 },
    anchor3d: { x: 150, y: 50, z: 20 },
    opacity: 1,
    visible: true,
    locked: false,
    fill: "#ffffff",
    stroke: "transparent",
    strokeWidth: 0,
    bindings: {},
    materialSlots: {},
    slab: normalizeSlabProperties({
      cornerRadius: 20,
      cornerSegments: 5,
      skew: 30,
      frontBevel: { enabled: true, size: 8, depth: 5 },
      backBevel: { enabled: true, size: 6, depth: 4 }
    }),
    ...patch
  };
}

test("slab geometry creates XPression face, bevel, extrusion, back bevel and back-face regions", () => {
  const geometry = createSlabGeometry(slab());
  assert.deepEqual(geometry.groups.map((group) => group.materialIndex), [0, 1, 2, 3, 4]);
  assert.ok(geometry.groups.every((group) => group.count > 0));
  assert.equal(geometry.getAttribute("position").count, geometry.getAttribute("uv").count);
  geometry.dispose();
});

test("slab geometry preserves authored extrusion and expands its bounds for skew", () => {
  const geometry = createSlabGeometry(slab());
  assert.ok(geometry.boundingBox);
  const size = {
    x: geometry.boundingBox!.max.x - geometry.boundingBox!.min.x,
    y: geometry.boundingBox!.max.y - geometry.boundingBox!.min.y,
    z: geometry.boundingBox!.max.z - geometry.boundingBox!.min.z
  };
  assert.ok(size.x > 300, "positive skew should widen the visible slab bounds");
  assert.ok(size.x <= 330, "rounded corners keep the skewed outline within its theoretical extent");
  assert.ok(Math.abs(size.y - 100) < 0.01);
  assert.ok(Math.abs(size.z - 40) < 0.01);
  geometry.dispose();
});

test("disabled bevels leave only the face, extrusion and back-face material regions", () => {
  const geometry = createSlabGeometry(slab({
    slab: normalizeSlabProperties({
      frontBevel: { enabled: false },
      backBevel: { enabled: false }
    })
  }));
  assert.deepEqual(geometry.groups.map((group) => group.materialIndex), [0, 2, 4]);
  geometry.dispose();
});
