import assert from "node:assert/strict";
import test from "node:test";
import type { SceneDocument, SceneObject } from "@grapix/shared-types";
import { useEditorStore } from "../src/store/editorStore";

/**
 * Scene history, driven through the real store.
 *
 * What this defends: a step knows what it was and who made it, a gesture is one step, an
 * empty gesture is no step, and Ctrl+Z during a gesture abandons the gesture rather than popping the
 * stack behind it. That last one is the difference between "undo what I am doing" and "undo the thing
 * before it while my half-finished drag stands".
 */

const now = "2026-08-08T00:00:00.000Z";

function rect(id: string, name: string, zIndex: number): SceneObject {
  return {
    id,
    name,
    type: "rect",
    x: 100 * zIndex,
    y: 50,
    zDepth: 0,
    zIndex,
    layerId: "main",
    width: 120,
    height: 60,
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
    materialSlots: {}
  } as unknown as SceneObject;
}

function scene(objects: SceneObject[]): SceneDocument {
  return {
    id: "scene_history",
    name: "History",
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
}

function withScene() {
  const store = useEditorStore.getState();
  store.loadScene(scene([rect("a", "A", 0), rect("b", "B", 1)]));
  store.setHistoryScope(null);
  return useEditorStore.getState;
}

const topUndo = () => useEditorStore.getState().undoStack.at(-1);
const topRedo = () => useEditorStore.getState().redoStack.at(-1);

test("loading a scene clears the history", () => {
  const state = withScene();
  assert.deepEqual(state().undoStack, []);
  assert.deepEqual(state().redoStack, []);
});

test("a step records what the change was", () => {
  const state = withScene();
  state().updateObject("a", { visible: false });
  assert.equal(topUndo()?.label, "Hide object");
  state().updateObject("a", { visible: true });
  assert.equal(topUndo()?.label, "Show object");
  state().updateObject("a", { x: 10, y: 20 });
  assert.equal(topUndo()?.label, "Move object");
  state().updateObject("a", { locked: true });
  assert.equal(topUndo()?.label, "Lock object");
});

test("a step is credited to the module that made it", () => {
  const state = withScene();
  state().setHistoryScope("material-manager");
  state().updateObject("a", { visible: false });
  assert.equal(topUndo()?.scope, "material-manager");

  state().setHistoryScope("scene-manager");
  state().updateObject("b", { visible: false });
  assert.equal(topUndo()?.scope, "scene-manager");
});

test("a transaction's own label and scope win over the ambient ones", () => {
  const state = withScene();
  state().setHistoryScope("canvas");
  state().beginHistory("Delete 3 objects", "scene-manager");
  state().updateObject("a", { x: 5 });
  state().commitHistory();
  assert.equal(topUndo()?.label, "Delete 3 objects");
  assert.equal(topUndo()?.scope, "scene-manager");
});

test("a transaction with no explicit scope takes the ambient one", () => {
  const state = withScene();
  state().setHistoryScope("timeline");
  state().beginHistory("Move keyframe");
  state().updateObject("a", { x: 5 });
  state().commitHistory();
  assert.equal(topUndo()?.scope, "timeline");
  assert.equal(topUndo()?.label, "Move keyframe");
});

test("many changes inside one transaction are one step", () => {
  const state = withScene();
  const before = state().undoStack.length;
  state().beginHistory("Scrub x");
  for (const x of [1, 2, 3, 4, 5]) state().updateObject("a", { x });
  state().commitHistory();
  assert.equal(state().undoStack.length, before + 1);
  assert.equal(topUndo()?.label, "Scrub x");
});

test("a transaction that changed nothing deposits no step", () => {
  const state = withScene();
  const before = state().undoStack.length;
  state().beginHistory("Scrub x");
  state().commitHistory();
  assert.equal(state().undoStack.length, before, "a click that never dragged is not an undo step");
});

test("undo during a gesture abandons the gesture instead of popping the stack", () => {
  const state = withScene();
  state().updateObject("a", { x: 500 });
  const committed = state().scene.objects.find((object) => object.id === "a")?.x;
  assert.equal(committed, 500);
  const depth = state().undoStack.length;

  // A drag starts and moves, then the author hits Ctrl+Z mid-gesture.
  state().beginHistory("Scrub x");
  state().updateObject("a", { x: 900 });
  state().undo();

  assert.equal(state().scene.objects.find((object) => object.id === "a")?.x, 500,
    "the in-flight change is abandoned, back to where the gesture started");
  assert.equal(state().undoStack.length, depth, "and the committed step behind it is untouched");
  assert.equal(state().historyTransaction, null, "the transaction is closed");
});

test("redo re-applies the same step and carries its description", () => {
  const state = withScene();
  state().updateObject("a", { visible: false });
  state().undo();
  assert.equal(state().scene.objects.find((object) => object.id === "a")?.visible, true);
  assert.equal(topRedo()?.label, "Hide object", "redo knows what it will re-apply");

  state().redo();
  assert.equal(state().scene.objects.find((object) => object.id === "a")?.visible, false);
  assert.equal(topUndo()?.label, "Hide object", "and it is undoable again with the same name");
});

test("a new change after an undo clears the redo stack", () => {
  const state = withScene();
  state().updateObject("a", { visible: false });
  state().undo();
  assert.equal(state().redoStack.length, 1);
  state().updateObject("b", { visible: false });
  assert.deepEqual(state().redoStack, [], "the branch that was undone is gone");
});

test("undo and redo are no-ops on an empty history rather than throwing", () => {
  const state = withScene();
  state().undo();
  state().redo();
  assert.equal(state().scene.objects.length, 2);
});

test("stack order is last-in-first-out across several modules", () => {
  const state = withScene();
  state().setHistoryScope("canvas");
  state().updateObject("a", { x: 11 });
  state().setHistoryScope("scene-manager");
  state().updateObject("b", { visible: false });

  // The newest step is the Object Manager's, whichever panel the author is looking at now.
  assert.equal(topUndo()?.scope, "scene-manager");
  state().undo();
  assert.equal(state().scene.objects.find((object) => object.id === "b")?.visible, true);
  // And the one behind it belongs to the canvas.
  assert.equal(topUndo()?.scope, "canvas");
  state().undo();
  assert.equal(state().scene.objects.find((object) => object.id === "a")?.x, 0);
});
