import assert from "node:assert/strict";
import test from "node:test";
import type { SceneDocument, SceneObject } from "@grapix/shared-types";
import { useEditorStore } from "../src/store/editorStore";

/**
 * The selection invariant, driven through the real store.
 *
 * The reducer is tested on its own in `object-selection.test.ts`; what this file defends is the
 * part a reducer cannot: that **every** path which adds or removes objects leaves the active object
 * inside the set. Add, duplicate, delete, undo, redo and the four scene-lifecycle entry points all
 * used to assign `selectedObjectId` directly, and any one of them left behind would break the
 * invariant with no type error and no visible symptom until the alignment toolbar counted a ghost.
 *
 * Reconciliation is asserted on the state *immediately* after the action, with no effect having
 * run. That is the difference between pruning inside the store's own `set` and pruning in a
 * `useEffect`, which paints one frame with dead ids.
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
    id: "scene_selection",
    name: "Selection",
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

/** Three objects, nothing selected but the first — what `loadScene` leaves behind. */
function withThreeObjects() {
  const store = useEditorStore.getState();
  store.loadScene(scene([rect("a", "A", 0), rect("b", "B", 1), rect("c", "C", 2)]));
  return useEditorStore.getState;
}

/** The invariant every test below re-checks. */
function assertInvariant(label: string) {
  const { selectedObjectIds, selectedObjectId, scene: current } = useEditorStore.getState();
  const ids = new Set(current.objects.map((object) => object.id));
  for (const id of selectedObjectIds) {
    assert.ok(ids.has(id), `${label}: ${id} is selected but not in the scene`);
  }
  if (selectedObjectIds.length === 0) {
    assert.equal(selectedObjectId, null, `${label}: an empty selection must have no active object`);
  } else {
    assert.ok(selectedObjectId, `${label}: a non-empty selection must have an active object`);
    assert.ok(
      selectedObjectIds.includes(selectedObjectId as string),
      `${label}: the active object must be a member`
    );
  }
}

test("loadScene selects the first object and nothing else", () => {
  const state = withThreeObjects();
  assert.deepEqual(state().selectedObjectIds, ["a"]);
  assert.equal(state().selectedObjectId, "a");
  assert.equal(state().objectSelectionAnchorId, "a");
  assertInvariant("loadScene");
});

test("selectObjects normalises an active object that is not a member", () => {
  const state = withThreeObjects();
  state().selectObjects(["a", "b"], { active: "c" });
  assert.deepEqual(state().selectedObjectIds, ["a", "b"]);
  assert.equal(state().selectedObjectId, "a", "c is not a member, so the first member takes over");
  assertInvariant("selectObjects with a foreign active id");
});

test("selectObjects drops ids the scene does not contain", () => {
  const state = withThreeObjects();
  state().selectObjects(["a", "ghost", "c"]);
  assert.deepEqual(state().selectedObjectIds, ["a", "c"]);
  assertInvariant("selectObjects with a stale id");
});

test("selectObject is exactly a one-object selection", () => {
  const state = withThreeObjects();
  state().selectObjects(["a", "b", "c"]);
  state().selectObject("b");
  assert.deepEqual(state().selectedObjectIds, ["b"]);
  assert.equal(state().selectedObjectId, "b");
  assertInvariant("selectObject");
});

test("selectObject(null) clears every selection field", () => {
  const state = withThreeObjects();
  state().selectObjects(["a", "b"]);
  state().selectObject(null);
  assert.deepEqual(state().selectedObjectIds, []);
  assert.equal(state().selectedObjectId, null);
  assert.equal(state().objectSelectionAnchorId, null);
  assertInvariant("cleared");
});

test("adding an object selects it and keeps the invariant", () => {
  const state = withThreeObjects();
  state().selectObjects(["a", "b"]);
  state().addRectObject();
  assert.equal(state().selectedObjectIds.length, 1, "a new object replaces the selection");
  assertInvariant("addRectObject");
});

test("duplicating selects the copy and keeps the invariant", () => {
  const state = withThreeObjects();
  state().selectObjects(["a", "b"], { active: "b" });
  state().duplicateObject("b");
  assert.equal(state().selectedObjectIds.length, 1);
  assert.notEqual(state().selectedObjectId, "b", "the copy is selected, not the original");
  assertInvariant("duplicateObject");
});

test("deleting a non-active member drops it in the same update", () => {
  const state = withThreeObjects();
  state().selectObjects(["a", "b", "c"], { active: "c" });
  state().deleteObject("b");
  // Asserted immediately: no effect has run, so this proves the store reconciled inside its own set.
  assert.deepEqual(state().selectedObjectIds, ["a", "c"]);
  assert.equal(state().selectedObjectId, "c", "the active object was untouched");
  assertInvariant("deleteObject, non-active member");
});

test("deleting the active member hands the role to the member above it", () => {
  const state = withThreeObjects();
  state().selectObjects(["a", "b", "c"], { active: "c" });
  state().deleteObject("c");
  assert.deepEqual(state().selectedObjectIds, ["a", "b"]);
  assert.equal(state().selectedObjectId, "b");
  assertInvariant("deleteObject, active member");
});

test("deleting the only selected object empties the selection", () => {
  const state = withThreeObjects();
  state().selectObject("b");
  state().deleteObject("b");
  assert.deepEqual(state().selectedObjectIds, []);
  assert.equal(state().selectedObjectId, null);
  assertInvariant("deleteObject, last member");
});

test("deleting is one undo step and one undo restores the object", () => {
  const state = withThreeObjects();
  const before = state().undoStack.length;
  state().deleteObject("b");
  assert.equal(state().undoStack.length, before + 1, "delete must be undoable");
  state().undo();
  assert.ok(state().scene.objects.some((object) => object.id === "b"), "b is back");
  assertInvariant("after undo");
});

test("a multi-object command in one transaction is one undo step", () => {
  const state = withThreeObjects();
  const before = state().undoStack.length;
  state().selectObjects(["a", "b", "c"]);
  state().beginHistory("Delete 3 objects");
  for (const id of ["a", "b", "c"]) state().deleteObject(id);
  state().commitHistory();

  assert.equal(state().scene.objects.length, 0);
  assert.equal(state().undoStack.length, before + 1, "three deletes, one entry");
  assert.deepEqual(state().selectedObjectIds, []);

  state().undo();
  assert.equal(state().scene.objects.length, 3, "one undo brings all three back");
  assertInvariant("after undoing a batch");
});

test("undo prunes a selection the restored scene no longer contains", () => {
  const state = withThreeObjects();
  state().addRectObject();
  const added = state().selectedObjectId;
  assert.ok(added);
  state().undo();
  assert.ok(
    !state().scene.objects.some((object) => object.id === added),
    "the added object is gone after undo"
  );
  assertInvariant("undo of an insert");
});

test("a visibility toggle is undoable", () => {
  const state = withThreeObjects();
  const before = state().undoStack.length;
  state().updateObject("b", { visible: false });
  assert.equal(state().undoStack.length, before + 1);
  state().undo();
  assert.equal(state().scene.objects.find((object) => object.id === "b")?.visible, true);
});

test("a stack reorder is undoable", () => {
  const state = withThreeObjects();
  const before = state().undoStack.length;
  state().moveObjectInStack("a", "front");
  assert.equal(state().undoStack.length, before + 1);
});

test("a scrub wrapped in one transaction deposits one entry however many values it writes", () => {
  const state = withThreeObjects();
  const before = state().undoStack.length;
  state().beginHistory("Scrub x");
  for (const x of [110, 120, 130, 140]) state().setAnimatedPropertyValue("b", "x", x, 0);
  state().commitHistory();
  assert.equal(state().undoStack.length, before + 1, "one drag, one undo step");
  assert.equal(state().scene.objects.find((object) => object.id === "b")?.x, 140);
  state().undo();
  assert.equal(state().scene.objects.find((object) => object.id === "b")?.x, 100);
});

test("clearScene and resetScene leave no selection behind", () => {
  const state = withThreeObjects();
  state().selectObjects(["a", "b", "c"]);
  state().clearScene();
  assert.deepEqual(state().selectedObjectIds, []);
  assertInvariant("clearScene");

  withThreeObjects();
  useEditorStore.getState().selectObjects(["a", "b"]);
  useEditorStore.getState().resetScene();
  assert.deepEqual(useEditorStore.getState().selectedObjectIds, []);
  assertInvariant("resetScene");
});
