import assert from "node:assert/strict";
import test from "node:test";
import type { SceneDocument, SceneObject } from "@grapix/shared-types";
import { useEditorStore } from "../src/store/editorStore";

/**
 * A batch edit, driven through the real store.
 *
 * What this defends: **one** history entry for a batch however many objects it touches, the exact set
 * of ids written, and a single undo that restores every one of them. A loop over `updateObject` would
 * pass a "did it move?" test and fail all three of these — twelve entries, twelve scene rebuilds, and
 * twelve presses of Ctrl+Z to get back.
 */

const now = "2026-08-08T00:00:00.000Z";

function rect(id: string, x: number, opacity = 1, locked = false): SceneObject {
  return {
    id,
    name: id,
    type: "rect",
    x,
    y: 0,
    zDepth: 0,
    zIndex: 0,
    layerId: "main",
    width: 100,
    height: 50,
    rotation: 0,
    opacity,
    visible: true,
    locked,
    fill: "#ffffff",
    stroke: "#000000",
    strokeWidth: 1,
    bindings: {},
    materialSlots: {},
    radius: 0
  } as SceneObject;
}

function scene(objects: SceneObject[]): SceneDocument {
  return {
    id: "scene_batch",
    name: "Batch",
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

const twelve = () => Array.from({ length: 12 }, (_, index) => rect(`r${index}`, index * 10));

function load(objects: SceneObject[]) {
  useEditorStore.getState().loadScene(scene(objects));
  return useEditorStore.getState;
}

const xOf = (id: string) => useEditorStore.getState().scene.objects.find((o) => o.id === id)?.x;

test("a batch over twelve objects writes every one of them", () => {
  const state = load(twelve());
  const written = state().updateObjects(twelve().map((object) => object.id), { x: 500 }, "Set x on 12 objects");
  assert.equal(written, 12);
  for (let index = 0; index < 12; index += 1) {
    assert.equal(xOf(`r${index}`), 500, `r${index} should have moved`);
  }
});

test("a batch deposits exactly one history entry, whatever its size", () => {
  const state = load(twelve());
  const before = state().undoStack.length;
  state().updateObjects(twelve().map((object) => object.id), { x: 42 }, "Set x on 12 objects");
  assert.equal(state().undoStack.length, before + 1, "twelve objects, one entry");
  assert.equal(state().undoStack.at(-1)?.label, "Set x on 12 objects");
});

test("one undo takes back the whole batch", () => {
  const state = load(twelve());
  state().updateObjects(twelve().map((object) => object.id), { x: 999 }, "Set x on 12 objects");
  state().undo();
  for (let index = 0; index < 12; index += 1) {
    assert.equal(xOf(`r${index}`), index * 10, `r${index} should be back where it started`);
  }
});

test("redo re-applies the whole batch, once", () => {
  const state = load(twelve());
  state().updateObjects(twelve().map((object) => object.id), { opacity: 0.25 }, "Set opacity on 12 objects");
  state().undo();
  state().redo();
  const opacities = new Set(state().scene.objects.map((object) => object.opacity));
  assert.deepEqual([...opacities], [0.25]);
});

test("only the named ids are written", () => {
  const state = load(twelve());
  state().updateObjects(["r0", "r1", "r2"], { x: 7 }, "Set x on 3 objects");
  assert.equal(xOf("r0"), 7);
  assert.equal(xOf("r2"), 7);
  assert.equal(xOf("r3"), 30, "an unlisted object must not move");
});

test("an empty id list writes nothing and deposits no entry", () => {
  const state = load(twelve());
  const before = state().undoStack.length;
  assert.equal(state().updateObjects([], { x: 1 }, "Set x on 0 objects"), 0);
  assert.equal(state().undoStack.length, before, "an empty batch is not a history step");
});

test("ids that do not exist write nothing rather than an entry that undoes to itself", () => {
  const state = load(twelve());
  const before = state().undoStack.length;
  assert.equal(state().updateObjects(["ghost", "phantom"], { x: 1 }, "Set x on 2 objects"), 0);
  assert.equal(state().undoStack.length, before);
});

test("a batch writes the same value even where objects already agreed", () => {
  // Idempotence matters for the Mixed → single-value transition: after one batch, a mixed field
  // becomes uniform, and a second identical batch must not fail or double-count.
  const state = load(twelve());
  state().updateObjects(twelve().map((object) => object.id), { x: 3 }, "Set x on 12 objects");
  const written = state().updateObjects(twelve().map((object) => object.id), { x: 3 }, "Set x on 12 objects");
  assert.equal(written, 12);
  assert.equal(xOf("r5"), 3);
});

test("a locked object is written when the caller asks, because the gate decides, not the store", () => {
  // The refusal is the Inspector's: the store stays a mechanism. Putting the policy here too would
  // give the rule two homes, and the batch gate is the one that can explain itself to an author.
  const state = load([rect("a", 0), rect("b", 10, 1, true)]);
  assert.equal(state().updateObjects(["a", "b"], { x: 5 }, "Set x on 2 objects"), 2);
});

/**
 * The clamp at the mutation boundary.
 *
 * A control's `min`/`max` is a browser hint: it stops the spinner, not a paste, a scrub or a data
 * binding, and the store never consulted it. So the same value that reaches the scene is the one the
 * renderer will accept — proven here through the real write paths rather than through the table.
 */

function light(id: string): SceneObject {
  return {
    id, name: id, type: "light", x: 0, y: 0, zDepth: 0, zIndex: 0, layerId: "main",
    width: 10, height: 10, rotation: 0, opacity: 1, visible: true, locked: false,
    fill: "#fff", stroke: "#000", strokeWidth: 0, bindings: {}, materialSlots: {},
    lightKind: "spot", intensity: 1, color: "#ffffff", coneAngleDeg: 45
  } as SceneObject;
}

test("an out-of-range cone angle is clamped on the way into the scene", () => {
  const state = load([light("l1")]);
  state().updateObject("l1", { coneAngleDeg: 500 } as Partial<SceneObject>);
  const stored = state().scene.objects.find((object) => object.id === "l1");
  assert.ok(stored && stored.type === "light");
  assert.equal(stored.coneAngleDeg, 179, "the scene must not store a value the renderer will refuse");
});

test("NaN never reaches the scene, because it propagates through every matrix that touches it", () => {
  const state = load(twelve());
  state().updateObject("r0", { x: Number.NaN });
  assert.equal(xOf("r0"), 0);
});

test("a negative dimension is floored rather than stored", () => {
  const state = load(twelve());
  state().updateObject("r1", { width: -50 });
  const stored = state().scene.objects.find((object) => object.id === "r1");
  assert.equal(stored?.width, 0);
});

test("a batch is clamped per target, not once for the set", () => {
  // Each object's type decides its own bounds, so the clamp has to run inside the loop.
  const state = load([...twelve(), light("l1")]);
  state().updateObjects(["r0", "l1"], { opacity: 9 }, "Set opacity on 2 objects");
  for (const id of ["r0", "l1"]) {
    const stored = state().scene.objects.find((object) => object.id === id);
    assert.equal(stored?.opacity, 1, `${id} opacity should be clamped to 1`);
  }
});

test("a value already inside its bounds is written untouched", () => {
  const state = load(twelve());
  state().updateObject("r2", { x: 123.5 });
  assert.equal(xOf("r2"), 123.5);
});

/*
 * Escape on a mixed field.
 *
 * The gesture used to revert by writing the number the field displayed back through `onChange`. On a
 * mixed field there is no such number — the field is deliberately empty — so a revert would have
 * written the active object's value onto all twelve and called it "restoring". That is the invented
 * data the mixed field exists to prevent, arriving through the abandon path instead of the edit path.
 *
 * `cancelHistory` restores the scene the transaction opened on, so every object keeps its own value
 * and the field is mixed again because nothing was written.
 */

test("abandoning a batch edit restores every object, not just the one on screen", () => {
  const state = load(twelve());
  const before = twelve().map((object) => object.x);
  state().beginHistory("Edit X");
  state().updateObjects(twelve().map((object) => object.id), { x: 777 }, "Set X on 12 objects");
  assert.equal(xOf("r0"), 777, "the batch wrote before the abandon");
  state().cancelHistory();
  const after = twelve().map((object) => xOf(object.id));
  assert.deepEqual(after, before, "each object should hold the value it had before the edge began");
});

test("abandoning deposits no history entry, so there is nothing to undo twice", () => {
  const state = load(twelve());
  const depth = state().undoStack.length;
  state().beginHistory("Edit X");
  state().updateObjects(["r0", "r1"], { x: 500 }, "Set X on 2 objects");
  state().cancelHistory();
  assert.equal(state().undoStack.length, depth, "an abandoned gesture is not an undo step");
});

test("a mixed selection is mixed again after the abandon", () => {
  // Distinct values are what "mixed" means, so the test is that they are still distinct.
  const state = load(twelve());
  state().beginHistory("Edit X");
  state().updateObjects(twelve().map((object) => object.id), { x: 42 }, "Set X on 12 objects");
  assert.equal(new Set(twelve().map((object) => xOf(object.id))).size, 1, "one shared value while edited");
  state().cancelHistory();
  assert.equal(
    new Set(twelve().map((object) => xOf(object.id))).size,
    12,
    "twelve distinct values again, which is what the field reports as Mixed"
  );
});

test("committing after an abandon still works, so the field is not left in a dead transaction", () => {
  const state = load(twelve());
  state().beginHistory("Edit X");
  state().cancelHistory();
  state().beginHistory("Edit X");
  state().updateObject("r3", { x: 88 });
  state().commitHistory();
  assert.equal(xOf("r3"), 88);
  state().undo();
  assert.equal(xOf("r3"), 30, "one undo, back to the seeded value");
});
