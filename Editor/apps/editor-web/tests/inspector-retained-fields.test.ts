import assert from "node:assert/strict";
import test from "node:test";
import type { SceneDocument, SceneObject } from "@grapix/shared-types";
import { useEditorStore } from "../src/store/editorStore";

/**
 * The values whose editors P0 removed must still survive a load.
 *
 * Removing a dishonest control is only safe if the data behind it is untouched: an imported PSD or
 * After Effects scene carries a drop shadow, a marker event name and a paint blend mode that GrapiX
 * cannot draw, and losing them on load would turn "we do not render this yet" into "we destroyed your
 * source file". So the controls are gone and the fields are not.
 *
 * **Deep preservation, not byte identity.** `normalizeScene` writes defaults on load — `zDepth`,
 * `zIndex`, `layerId`, lock, scales, anchors, styles, masks, `materialSlots` — so a legacy import can
 * never round-trip byte-for-byte, whatever this phase does. The contract is that these specific values
 * come back unchanged, which is the promise the removals actually made.
 */

const now = "2026-08-08T00:00:00.000Z";

function baseObject(id: string, type: SceneObject["type"], extra: Record<string, unknown>): SceneObject {
  return {
    id,
    name: id,
    type,
    x: 10,
    y: 20,
    zDepth: 0,
    zIndex: 0,
    layerId: "main",
    width: 100,
    height: 50,
    rotation: 0,
    opacity: 1,
    visible: true,
    locked: false,
    fill: "#ffffff",
    stroke: "#000000",
    strokeWidth: 0,
    bindings: {},
    materialSlots: {},
    ...extra
  } as SceneObject;
}

function sceneWith(objects: SceneObject[]): SceneDocument {
  return {
    id: "scene_retained",
    name: "Retained fields",
    version: 1,
    canvas: { width: 1920, height: 1080, background: "#000000" },
    dataContext: {},
    assets: [],
    materials: [],
    objects,
    timeline: { fps: 50, durationFrames: 100, keyframes: [] },
    createdAt: now,
    updatedAt: now
  } as SceneDocument;
}

const IMPORTED_EFFECTS = [
  { id: "fx-1", type: "drop-shadow", enabled: true, color: "#000000", angle: 135, distance: 6, size: 4, opacity: 0.75 }
];

/**
 * Narrow a found object to its variant.
 *
 * `SceneObject` is a discriminated union, so asserting the type once gives every per-type field its
 * real type — no inline casts, and a wrong `type` fails the assertion instead of reading through a
 * shape nobody verified.
 */
function isOfType<T extends SceneObject["type"]>(
  object: SceneObject,
  type: T
): object is Extract<SceneObject, { type: T }> {
  return object.type === type;
}

function objectOfType<T extends SceneObject["type"]>(
  scene: SceneDocument,
  id: string,
  type: T
): Extract<SceneObject, { type: T }> {
  const found = scene.objects.find((entry) => entry.id === id);
  assert.ok(found, `scene has no object ${id}`);
  assert.ok(isOfType(found, type), `${id} should be a ${type}`);
  return found;
}
function loaded(objects: SceneObject[]) {
  useEditorStore.getState().loadScene(sceneWith(objects));
  return useEditorStore.getState().scene;
}

test("a marker keeps its event name after load, with no editor for it", () => {
  const scene = loaded([baseObject("m1", "marker", { markerKind: "event", eventName: "score.changed" })]);
  assert.equal(objectOfType(scene, "m1", "marker").eventName, "score.changed");
});

test("a paint layer keeps its blend mode after load", () => {
  const scene = loaded([baseObject("p1", "paint", { strokes: [], paintBlendMode: "multiply" })]);
  assert.equal(objectOfType(scene, "p1", "paint").paintBlendMode, "multiply");
});

test("typed layer effects survive load unchanged, including their enabled flag", () => {
  const scene = loaded([baseObject("r1", "rect", { radius: 0, effects: IMPORTED_EFFECTS })]);
  const rect = objectOfType(scene, "r1", "rect");
  assert.equal(rect.effects?.length, 1);
  const effect = rect.effects?.[0];
  assert.equal(effect?.type, "drop-shadow");
  assert.equal(effect?.enabled, true);
  assert.equal(effect?.opacity, 0.75);
});

test("an imported design's effect metadata survives load, now that it is only reported", () => {
  const scene = loaded([baseObject("r2", "rect", {
    radius: 0,
    importedDesign: {
      sourceFormat: "psd",
      sourceName: "Lower third.psd",
      sourceNodeType: "layer",
      effects: [{ type: "outer-glow", enabled: true, radius: 12, spread: 0.2, color: "#00ffcc" }]
    }
  })]);
  const rect = objectOfType(scene, "r2", "rect");
  const effect = rect.importedDesign?.effects?.[0];
  assert.equal(effect?.type, "outer-glow");
  assert.equal(effect?.radius, 12);
  assert.equal(effect?.color, "#00ffcc");
});

test("a shape keeps every subpath, which Preview draws and the panel cannot edit", () => {
  const primary = {
    closed: true,
    vertices: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }],
    inTangents: [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }],
    outTangents: [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }]
  };
  const hole = {
    closed: true,
    vertices: [{ x: 3, y: 3 }, { x: 6, y: 3 }, { x: 6, y: 6 }],
    inTangents: [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }],
    outTangents: [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }]
  };
  const scene = loaded([baseObject("s1", "shape", {
    path: primary,
    compoundPaths: [hole],
    fillEnabled: true,
    strokeEnabled: false,
    fillRule: "evenodd"
  })]);
  const shape = objectOfType(scene, "s1", "shape");
  assert.equal(shape.compoundPaths?.length, 1);
  // The rule stays as imported: Program tessellates even-odd even though Preview ignores it, so
  // discarding it on load would change a published frame.
  assert.equal(shape.fillRule, "evenodd");
});

test("a bound material slot survives load, including an instance binding", () => {
  const scene = loaded([baseObject("r3", "rect", {
    radius: 0,
    materialSlots: { main: { materialId: "mat-base", instanceId: "inst-7" } }
  })]);
  const rect = objectOfType(scene, "r3", "rect");
  assert.deepEqual(rect.materialSlots.main, { materialId: "mat-base", instanceId: "inst-7" });
});

test("a text object keeps an imported letter case, which only Preview applies", () => {
  const scene = loaded([baseObject("t1", "text", {
    text: "mvp",
    fontSize: 48,
    fontFamily: "Arial",
    fontWeight: "700",
    align: "left",
    textCase: "upper"
  })]);
  assert.equal(objectOfType(scene, "t1", "text").textCase, "upper");
});

test("width and height are still stored for the types whose controls were removed", () => {
  // The control is gone because nothing draws with it — but a mask fallback rectangle and any future
  // renderer still read the stored value, so normalisation must not zero it.
  const scene = loaded([
    baseObject("l1", "line", { points: [{ x: 0, y: 0 }, { x: 5, y: 5 }] }),
    baseObject("p2", "paint", { strokes: [], paintBlendMode: "normal" })
  ]);
  for (const id of ["l1", "p2"]) {
    const object = scene.objects.find((entry) => entry.id === id);
    assert.equal(object?.width, 100, `${id} width`);
    assert.equal(object?.height, 50, `${id} height`);
  }
});
