import assert from "node:assert/strict";
import test from "node:test";
import type { ObjectMask, SceneObject } from "@grapix/shared-types";
import { buildTreeRows, createLayerStacks } from "../src/modules/object-manager/services/objectManagerTree";

/**
 * The row projection: what a reader is told about the shape of the tree.
 *
 * The defence here is that the numbers match the *drawn* rows. `aria-posinset` is a promise about
 * what the author can reach next, so a set that counts a collapsed group's children, or that restarts
 * at 1 when masks give way to child objects, describes a panel that is not on screen.
 */

function object(id: string, patch: Partial<SceneObject> = {}): SceneObject {
  return {
    id,
    name: id,
    type: "rect",
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    rotation: 0,
    opacity: 1,
    visible: true,
    locked: false,
    layerId: "main",
    zIndex: 0,
    materialSlots: {},
    bindings: {},
    ...patch
  } as SceneObject;
}

function mask(id: string): ObjectMask {
  return {
    id,
    name: id,
    mode: "add",
    opacity: 1,
    visible: true,
    feather: { x: 0, y: 0 },
    expansion: 0,
    points: []
  } as ObjectMask;
}

function rows(objects: SceneObject[], collapsed: string[] = [], propertyColumns = 3) {
  return buildTreeRows(createLayerStacks(objects, ""), new Set(collapsed), propertyColumns);
}

test("a band and its objects are one flat list, band first, screen order reversed", () => {
  // Screen order is the inverse of render order: `b` is drawn later, so it is *above* `a` in the
  // panel. The projection inherits that from `createLayerStacks` rather than re-deciding it.
  const built = rows([object("a"), object("b")]);
  assert.deepEqual(built.map((row) => row.id), ["band:main", "b", "a"]);
  assert.deepEqual(built.map((row) => row.kind), ["band", "object", "object"]);
});

test("a band is level 1 and its root objects are level 2", () => {
  const built = rows([object("a")]);
  assert.equal(built[0].level, 1);
  assert.equal(built[1].level, 2);
});

test("a child object is one level deeper and one indent step in", () => {
  const built = rows([
    object("g", { type: "group", childIds: ["c"] } as Partial<SceneObject>),
    object("c")
  ]);
  const child = built.find((row) => row.id === "c");
  assert.equal(child?.level, 3);
  assert.equal(child?.depth, 1);
});

test("masks and child objects share one set", () => {
  const built = rows([
    object("g", { type: "group", childIds: ["c"], masks: [mask("m1"), mask("m2")] } as Partial<SceneObject>),
    object("c")
  ]);
  const maskRows = built.filter((row) => row.kind === "mask");
  const child = built.find((row) => row.id === "c");
  assert.deepEqual(maskRows.map((row) => row.posInSet), [1, 2]);
  assert.deepEqual(maskRows.map((row) => row.setSize), [3, 3]);
  // The child continues the run rather than restarting it.
  assert.equal(child?.posInSet, 3);
  assert.equal(child?.setSize, 3);
});

test("masks are drawn before child objects", () => {
  const built = rows([
    object("g", { type: "group", childIds: ["c"], masks: [mask("m1")] } as Partial<SceneObject>),
    object("c")
  ]);
  const ids = built.map((row) => row.id);
  assert.ok(ids.indexOf("g:m1") < ids.indexOf("c"), `masks first, got ${ids.join(" ")}`);
});

test("a collapsed object contributes no rows for its masks or children", () => {
  const built = rows([
    object("g", { type: "group", childIds: ["c"], masks: [mask("m1")] } as Partial<SceneObject>),
    object("c")
  ], ["g"]);
  assert.deepEqual(built.map((row) => row.id), ["band:main", "g"]);
  // Still expandable, and honestly reported as closed.
  assert.equal(built[1].expandable, true);
  assert.equal(built[1].expanded, false);
});

test("a collapsed band contributes only its own row", () => {
  const built = rows([object("a"), object("b")], ["main"]);
  assert.deepEqual(built.map((row) => row.id), ["band:main"]);
  assert.equal(built[0].expanded, false);
});

test("an object with masks only is expandable", () => {
  // The disclosure defect in reverse: a mask-only object that reported itself as a leaf had no way
  // to reveal the masks it was hiding.
  const built = rows([object("a", { masks: [mask("m1")] } as Partial<SceneObject>)]);
  assert.equal(built[1].expandable, true);
});

test("a leaf is not expandable and not expanded", () => {
  const built = rows([object("a")]);
  assert.equal(built[1].expandable, false);
  assert.equal(built[1].expanded, false);
});

test("mask rows carry the object they belong to and their own id", () => {
  const built = rows([object("a", { masks: [mask("m1")] } as Partial<SceneObject>)]);
  const row = built.find((entry) => entry.kind === "mask");
  assert.equal(row?.id, "a:m1");
  assert.equal(row?.objectId, "a");
  assert.equal(row?.maskId, "m1");
});

test("bands count each other, so a reader is told which band of how many", () => {
  const built = rows([object("a"), object("b", { layerId: "lower-third" })]);
  const bands = built.filter((row) => row.kind === "band");
  assert.equal(bands.length, 2);
  assert.deepEqual(bands.map((row) => row.posInSet), [1, 2]);
  assert.deepEqual(bands.map((row) => row.setSize), [2, 2]);
});

test("every row id is unique, which the tab stop depends on", () => {
  const built = rows([
    object("g", { type: "group", childIds: ["c"], masks: [mask("m1")] } as Partial<SceneObject>),
    object("c", { masks: [mask("m1")] } as Partial<SceneObject>)
  ]);
  const ids = built.map((row) => row.id);
  assert.equal(new Set(ids).size, ids.length, `duplicate row id in ${ids.join(" ")}`);
});

test("each kind of row reports how many cells it draws", () => {
  // A band has no property cells and a mask has one that spans them, so the keyboard cannot assume
  // one width for the grid — it asks the row.
  const built = rows([object("a", { masks: [mask("m1")] } as Partial<SceneObject>)], [], 3);
  const byKind = new Map(built.map((row) => [row.kind, row.cellCount]));
  assert.equal(byKind.get("band"), 4);
  assert.equal(byKind.get("object"), 7);
  assert.equal(byKind.get("mask"), 5);
});

test("an object row widens with the property columns and a band does not", () => {
  const none = rows([object("a")], [], 0);
  const many = rows([object("a")], [], 6);
  assert.equal(none[1].cellCount, 4);
  assert.equal(many[1].cellCount, 10);
  assert.equal(none[0].cellCount, 4);
  assert.equal(many[0].cellCount, 4);
});
