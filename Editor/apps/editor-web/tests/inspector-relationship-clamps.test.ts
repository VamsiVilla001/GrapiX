import assert from "node:assert/strict";
import test from "node:test";
import { normalizeSlabProperties, type SceneDocument, type SceneObject } from "@grapix/shared-types";
import { useEditorStore } from "../src/store/editorStore";

/**
 * The two clamps a per-property range cannot express, driven through the real store.
 *
 * A camera's clipping planes and a slab's bevels constrain *each other*, so the store has to consult
 * the object's current values and not only the patch. `clampPatch` used to take the object's **type**,
 * and a comment claimed the planes were enforced while the branch it guarded returned its input
 * unchanged; the bevels were never clamped at all. So `far` could be authored behind `near` and a
 * 500-unit bevel could sit on a 100-deep slab — saved as typed, drawn as something else.
 *
 * These go through `updateObject` because that is the path every control writes on.
 */

const now = "2026-08-08T00:00:00.000Z";

function camera(id: string, near: number, far: number): SceneObject {
  return {
    id,
    name: id,
    type: "camera",
    cameraKind: "perspective",
    fov: 50,
    zoom: 1,
    near,
    far,
    x: 0,
    y: 0,
    zDepth: 0,
    zIndex: 0,
    layerId: "main",
    width: 0,
    height: 0,
    rotation: 0,
    opacity: 1,
    visible: true,
    locked: false,
    fill: "#ffffff",
    stroke: "#ffffff",
    strokeWidth: 0,
    bindings: {},
    materialSlots: {}
  } as unknown as SceneObject;
}

function slab(id: string, depth: number, frontDepth: number, backDepth: number): SceneObject {
  return {
    id,
    name: id,
    type: "mesh",
    meshKind: "slab",
    depth,
    slab: normalizeSlabProperties({
      frontBevel: { enabled: true, size: 10, depth: frontDepth },
      backBevel: { enabled: true, size: 10, depth: backDepth }
    }),
    x: 0,
    y: 0,
    zDepth: 0,
    zIndex: 0,
    layerId: "main",
    width: 400,
    height: 200,
    rotation: 0,
    opacity: 1,
    visible: true,
    locked: false,
    fill: "#ffffff",
    stroke: "#ffffff",
    strokeWidth: 0,
    bindings: {},
    materialSlots: {}
  } as unknown as SceneObject;
}

function load(objects: SceneObject[]): () => ReturnType<typeof useEditorStore.getState> {
  const scene: SceneDocument = {
    id: "scene_relationships",
    name: "Relationships",
    version: 1,
    canvas: { width: 1920, height: 1080, background: "#000000" },
    dataContext: {},
    assets: [],
    materials: [],
    objects,
    timeline: { fps: 50, durationFrames: 100, keyframes: [] },
    createdAt: now,
    updatedAt: now
  } as unknown as SceneDocument;
  useEditorStore.setState({ scene });
  useEditorStore.getState().loadScene(scene);
  return () => useEditorStore.getState();
}

const objectOf = (id: string) =>
  useEditorStore.getState().scene.objects.find((object) => object.id === id) as Record<string, unknown>;

test("a far plane authored behind near is pushed in front of it", () => {
  const state = load([camera("c1", 10, 1000)]);
  state().updateObject("c1", { far: 5 } as Partial<SceneObject>);
  const stored = objectOf("c1");
  assert.ok(
    (stored.far as number) > (stored.near as number),
    `far ${stored.far} should end up in front of near ${stored.near}`
  );
});

test("a near plane authored past far pushes far along rather than inverting", () => {
  const state = load([camera("c1", 10, 1000)]);
  state().updateObject("c1", { near: 5000 } as Partial<SceneObject>);
  const stored = objectOf("c1");
  assert.equal(stored.near, 5000, "the authored near is honoured");
  assert.ok((stored.far as number) > 5000, `far ${stored.far} should be pushed beyond the new near`);
});

test("planes already in order are written exactly as authored", () => {
  const state = load([camera("c1", 10, 1000)]);
  state().updateObject("c1", { near: 2, far: 900 } as Partial<SceneObject>);
  const stored = objectOf("c1");
  assert.equal(stored.near, 2);
  assert.equal(stored.far, 900);
});

test("a bevel deeper than the slab it sits in is cut back on write", () => {
  const state = load([slab("m1", 100, 10, 10)]);
  state().updateObject("m1", {
    slab: normalizeSlabProperties({
      frontBevel: { enabled: true, size: 10, depth: 500 },
      backBevel: { enabled: true, size: 10, depth: 0 }
    })
  } as Partial<SceneObject>);
  const stored = objectOf("m1").slab as { frontBevel: { depth: number } };
  assert.equal(stored.frontBevel.depth, 100, "the store should hold what the renderer will draw");
});

test("shrinking the extrusion re-clamps bevels the patch never mentions", () => {
  // The patch says only `depth`. The relationship is with the bevels, so they have to be revisited.
  // 20 + 10 into a 20-deep slab: each depth is already inside the extrusion, so the proportional
  // scale is what runs, and a 2:1 bevel stays 2:1 — the shape survives the resize.
  const state = load([slab("m1", 100, 20, 10)]);
  state().updateObject("m1", { depth: 20 } as Partial<SceneObject>);
  const stored = objectOf("m1").slab as { frontBevel: { depth: number }; backBevel: { depth: number } };
  const total = stored.frontBevel.depth + stored.backBevel.depth;
  assert.equal(Number(total.toFixed(6)), 20, `bevels totalling ${total} should fit a 20-deep slab`);
  assert.equal(Number((stored.frontBevel.depth / stored.backBevel.depth).toFixed(6)), 2);
});

test("a bevel deeper than the whole slab loses its proportion, exactly as the renderer does", () => {
  /*
   * 60 and 30 into a 30-deep slab. `slabGeometry.ts:56-66` caps **each** depth at the extrusion first
   * and only then scales the pair, so both arrive at 30, the sum is 60, and the scale halves them to
   * 15 and 15. The 2:1 ratio is gone. That is a real property of the renderer and not a rounding
   * artefact, so the store agrees with it rather than inventing a nicer answer the picture would
   * contradict.
   */
  const state = load([slab("m1", 100, 60, 30)]);
  state().updateObject("m1", { depth: 30 } as Partial<SceneObject>);
  const stored = objectOf("m1").slab as { frontBevel: { depth: number }; backBevel: { depth: number } };
  assert.equal(stored.frontBevel.depth, 15);
  assert.equal(stored.backBevel.depth, 15);
});

test("bevels that fit the extrusion are left alone", () => {
  const state = load([slab("m1", 100, 20, 20)]);
  state().updateObject("m1", { depth: 100 } as Partial<SceneObject>);
  const stored = objectOf("m1").slab as { frontBevel: { depth: number }; backBevel: { depth: number } };
  assert.equal(stored.frontBevel.depth, 20);
  assert.equal(stored.backBevel.depth, 20);
});

test("a clamped write is still one history entry, and one undo restores the original", () => {
  const state = load([camera("c1", 10, 1000)]);
  const before = objectOf("c1").far;
  state().updateObject("c1", { far: 5 } as Partial<SceneObject>);
  assert.notEqual(objectOf("c1").far, before);
  state().undo();
  assert.equal(objectOf("c1").far, before, "the clamp must not cost a second undo step");
});
