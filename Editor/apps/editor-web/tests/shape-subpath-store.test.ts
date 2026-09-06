import assert from "node:assert/strict";
import test from "node:test";
import type { BezierPath, SceneDocument, ShapeSceneObject } from "@grapix/shared-types";
import { useEditorStore } from "../src/store/editorStore";

const now = "2026-08-10T00:00:00.000Z";

function path(offset: number, vertexCount = 4): BezierPath {
  const vertices = Array.from({ length: vertexCount }, (_, index) => ({
    x: offset + (index % 2) * 40,
    y: offset + Math.floor(index / 2) * 40
  }));
  return {
    closed: true,
    vertices,
    inTangents: vertices.map(() => ({ x: 0, y: 0 })),
    outTangents: vertices.map(() => ({ x: 0, y: 0 }))
  };
}

function shape(): ShapeSceneObject {
  return {
    id: "shape-1",
    name: "Compound O",
    type: "shape",
    x: 0,
    y: 0,
    zDepth: 0,
    zIndex: 0,
    layerId: "main",
    width: 200,
    height: 200,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    anchor: { x: 0, y: 0 },
    opacity: 1,
    visible: true,
    locked: false,
    fill: "#ffffff",
    stroke: "#000000",
    strokeWidth: 0,
    bindings: {},
    materialSlots: {},
    path: path(0),
    compoundPaths: [path(25), path(60)],
    fillEnabled: true,
    strokeEnabled: false,
    fillRule: "evenodd"
  };
}

function load(): () => ReturnType<typeof useEditorStore.getState> {
  const scene: SceneDocument = {
    id: "scene-subpaths",
    name: "Subpaths",
    version: 1,
    canvas: { width: 1920, height: 1080, background: "#000000" },
    dataContext: {},
    assets: [],
    materials: [],
    objects: [shape()],
    timeline: { fps: 50, durationFrames: 100, keyframes: [] },
    createdAt: now,
    updatedAt: now
  } as SceneDocument;
  useEditorStore.getState().loadScene(scene);
  return useEditorStore.getState;
}

const storedShape = () => useEditorStore.getState().scene.objects[0] as ShapeSceneObject;
const assertParallelArrays = (candidate: BezierPath) => {
  assert.equal(candidate.inTangents.length, candidate.vertices.length, "one incoming tangent per vertex");
  assert.equal(candidate.outTangents.length, candidate.vertices.length, "one outgoing tangent per vertex");
};

test("adding a subpath leaves the primary compatibility path untouched and creates editable geometry", () => {
  const state = load();
  const primaryBefore = structuredClone(storedShape().path);
  const index = state().addShapeSubpath("shape-1");
  const object = storedShape();

  assert.equal(index, 2);
  assert.deepEqual(object.path, primaryBefore);
  assert.equal(object.compoundPaths?.length, 3);
  assert.ok((object.compoundPaths?.[index].vertices.length ?? 0) >= 3, "the new path is visible, not empty");
  assertParallelArrays(object.compoundPaths![index]);
});

test("editing a malformed subpath repairs its parallel tangent arrays", () => {
  const state = load();
  const malformed: BezierPath = {
    ...path(100, 5),
    inTangents: [{ x: 7, y: 8 }],
    outTangents: [...path(100, 7).outTangents]
  };

  assert.equal(state().updateShapeSubpath("shape-1", 0, malformed), true);
  const updated = storedShape().compoundPaths![0];
  assertParallelArrays(updated);
  assert.deepEqual(updated.inTangents[0], { x: 7, y: 8 });
  assert.deepEqual(updated.inTangents[4], { x: 0, y: 0 }, "missing handles are zero-filled");
  assert.equal(updated.outTangents.length, 5, "surplus handles are removed");
});

test("reordering and removing additional paths never replaces the primary path", () => {
  const state = load();
  const primaryBefore = structuredClone(storedShape().path);
  const firstBefore = structuredClone(storedShape().compoundPaths![0]);
  const secondBefore = structuredClone(storedShape().compoundPaths![1]);

  assert.equal(state().moveShapeSubpath("shape-1", 0, 1), true);
  assert.deepEqual(storedShape().compoundPaths, [secondBefore, firstBefore]);
  assert.deepEqual(storedShape().path, primaryBefore);

  assert.equal(state().removeShapeSubpath("shape-1", 1), true);
  assert.deepEqual(storedShape().compoundPaths, [secondBefore]);
  assert.deepEqual(storedShape().path, primaryBefore);
  assert.equal(state().moveShapeSubpath("shape-1", 0, -1), false, "cannot cross the primary path boundary");
});
