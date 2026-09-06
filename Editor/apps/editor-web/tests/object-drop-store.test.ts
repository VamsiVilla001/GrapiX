import assert from "node:assert/strict";
import test from "node:test";
import type { SceneDocument, SceneObject } from "@grapix/shared-types";
import { useEditorStore } from "../src/store/editorStore";
import { parentOfObject } from "../src/store/objectHierarchy";

/**
 * What a drop actually does to the scene.
 *
 * Order is asserted **after** the store has normalised it and re-sorted the way a renderer does, not
 * on an intermediate `zIndex`: the number is an implementation detail, the order is the contract. The
 * inversion trap is checked explicitly, because `before`/`after` in render order is the opposite of
 * what the panel draws and getting it backwards is invisible in a unit test that only counts moves.
 */

const now = "2026-08-08T00:00:00.000Z";

function object(id: string, overrides: Partial<SceneObject> = {}): SceneObject {
  return {
    id,
    name: id,
    type: "rect",
    x: 0,
    y: 0,
    zDepth: 0,
    zIndex: 0,
    layerId: "main",
    width: 10,
    height: 10,
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
    ...overrides
  } as unknown as SceneObject;
}

const group = (id: string, childIds: string[], overrides: Partial<SceneObject> = {}) =>
  object(id, { type: "group", childIds, ...overrides } as Partial<SceneObject>);

function sceneOf(objects: SceneObject[]): SceneDocument {
  return {
    id: "scene_drop",
    name: "Drop",
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

/** Four leaves in one band, in render order a → d. */
function withFourLeaves() {
  const store = useEditorStore.getState();
  store.loadScene(sceneOf([
    object("a", { zIndex: 0 }),
    object("b", { zIndex: 1 }),
    object("c", { zIndex: 2 }),
    object("d", { zIndex: 3 })
  ]));
  return useEditorStore.getState;
}

/** The band's ids in the order a renderer would draw them. */
function renderOrder(layerId = "main"): string[] {
  return useEditorStore.getState().scene.objects
    .filter((object) => object.layerId === layerId)
    .slice()
    .sort((left, right) => left.zDepth - right.zDepth || left.zIndex - right.zIndex)
    .map((object) => object.id);
}

test("reorder places an object before a sibling in render order", () => {
  const state = withFourLeaves();
  state().reorderObjectsInStack(["d"], "b", "before");
  assert.deepEqual(renderOrder(), ["a", "d", "b", "c"]);
});

test("reorder places an object after a sibling — the inversion trap", () => {
  const state = withFourLeaves();
  state().reorderObjectsInStack(["a"], "c", "after");
  assert.deepEqual(renderOrder(), ["b", "c", "a", "d"]);
});

test("a multi-object reorder keeps the moved objects' relative order", () => {
  const state = withFourLeaves();
  state().reorderObjectsInStack(["a", "c"], "d", "after");
  assert.deepEqual(renderOrder(), ["b", "d", "a", "c"]);
});

test("reorder onto itself changes nothing and deposits no step", () => {
  const state = withFourLeaves();
  const depth = state().undoStack.length;
  state().reorderObjectsInStack(["b"], "b", "after");
  assert.deepEqual(renderOrder(), ["a", "b", "c", "d"]);
  assert.equal(state().undoStack.length, depth);
});

test("a drop into a group adopts the object as its child", () => {
  const store = useEditorStore.getState();
  store.loadScene(sceneOf([group("grp", []), object("leaf")]));
  const state = useEditorStore.getState;

  assert.equal(state().applyObjectDrop(["leaf"], { kind: "into", targetId: "grp" }), true);
  assert.equal(parentOfObject(state().scene.objects, "leaf")?.id, "grp");
});

test("a drop of three objects is one undo step, and one undo restores every parent", () => {
  const store = useEditorStore.getState();
  store.loadScene(sceneOf([group("grp", []), object("x"), object("y"), object("z")]));
  const state = useEditorStore.getState;
  const depth = state().undoStack.length;

  state().applyObjectDrop(["x", "y", "z"], { kind: "into", targetId: "grp" });
  assert.equal(state().undoStack.length, depth + 1, "three adoptions, one step");
  for (const id of ["x", "y", "z"]) {
    assert.equal(parentOfObject(state().scene.objects, id)?.id, "grp", id);
  }

  state().undo();
  for (const id of ["x", "y", "z"]) {
    assert.equal(parentOfObject(state().scene.objects, id), undefined, `${id} is loose again`);
  }
});

test("a group dragged to another band takes its descendants with it", () => {
  const store = useEditorStore.getState();
  store.loadScene(sceneOf([
    group("grp", ["child"]),
    object("child"),
    object("other", { layerId: "lower" })
  ]));
  const state = useEditorStore.getState;

  state().applyObjectDrop(["grp"], { kind: "into-layer", targetId: "lower" });

  const byId = new Map(state().scene.objects.map((object) => [object.id, object]));
  assert.equal(byId.get("grp")?.layerId, "lower");
  assert.equal(
    byId.get("child")?.layerId,
    "lower",
    "a descendant left in the old band would draw detached from the group that positions it"
  );
  // The invariant, stated as the plan's gate does: no descendant disagrees with its parent's band.
  for (const object of state().scene.objects) {
    const parent = parentOfObject(state().scene.objects, object.id);
    if (parent) assert.equal(object.layerId, parent.layerId, `${object.id} vs ${parent.id}`);
  }
});

test("a band drop takes an object out of its group", () => {
  const store = useEditorStore.getState();
  store.loadScene(sceneOf([group("grp", ["child"]), object("child"), object("other", { layerId: "lower" })]));
  const state = useEditorStore.getState;

  state().applyObjectDrop(["child"], { kind: "into-layer", targetId: "lower" });
  assert.equal(parentOfObject(state().scene.objects, "child"), undefined);
  assert.equal(state().scene.objects.find((object) => object.id === "child")?.layerId, "lower");
});

test("a sibling drop across parents reparents and then orders", () => {
  const store = useEditorStore.getState();
  store.loadScene(sceneOf([
    group("grp", ["inner"]),
    object("inner", { zIndex: 1 }),
    object("loose", { zIndex: 2 })
  ]));
  const state = useEditorStore.getState;

  state().applyObjectDrop(["loose"], { kind: "before", targetId: "inner" });
  assert.equal(parentOfObject(state().scene.objects, "loose")?.id, "grp", "it joined inner's parent");
  const order = renderOrder();
  assert.ok(order.indexOf("loose") < order.indexOf("inner"), "and it sits before inner");
});

test("a refused drop kind changes nothing", () => {
  const state = withFourLeaves();
  const depth = state().undoStack.length;
  assert.equal(state().applyObjectDrop(["a"], { kind: "invalid", targetId: "b" }), false);
  assert.deepEqual(renderOrder(), ["a", "b", "c", "d"]);
  assert.equal(state().undoStack.length, depth);
});

test("a drop with no target changes nothing", () => {
  const state = withFourLeaves();
  assert.equal(state().applyObjectDrop(["a"], { kind: "into" }), false);
  assert.deepEqual(renderOrder(), ["a", "b", "c", "d"]);
});

test("the store still refuses a cycle even if a caller asks for one", () => {
  // The resolver refuses this on hover; the store is the second line of defence, and it holds.
  const store = useEditorStore.getState();
  store.loadScene(sceneOf([group("outer", ["mid"]), group("mid", []), object("leaf")]));
  const state = useEditorStore.getState;

  state().applyObjectDrop(["outer"], { kind: "into", targetId: "mid" });
  assert.equal(parentOfObject(state().scene.objects, "outer"), undefined, "outer is still a root");
});
