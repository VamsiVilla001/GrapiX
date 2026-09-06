import assert from "node:assert/strict";
import test from "node:test";
import type { SceneObject } from "@grapix/shared-types";
import { expandSearchMatches } from "../src/modules/object-manager/services/objectSearch";

/**
 * What a search shows.
 *
 * The old behaviour filtered the flat list, which reported a parentage the scene did not have: a
 * matched group lost its children and a matched child was lifted to a root. Harmless while the panel
 * was read-only, a trap once you can drop things against that structure.
 */

function object(id: string, overrides: Partial<SceneObject> = {}): SceneObject {
  return {
    id,
    name: id,
    type: "rect",
    layerId: "main",
    zDepth: 0,
    zIndex: 0,
    bindings: {},
    materialSlots: {},
    ...overrides
  } as unknown as SceneObject;
}

const group = (id: string, childIds: string[], overrides: Partial<SceneObject> = {}) =>
  object(id, { type: "group", childIds, ...overrides } as Partial<SceneObject>);

/** Lower Third ▸ Strap ▸ Name, plus a loose logo. */
const nested = () => [
  group("outer", ["strap"], { name: "Lower Third" }),
  group("strap", ["name"], { name: "Strap" }),
  object("name", { name: "Name Text", type: "text" } as Partial<SceneObject>),
  object("logo", { name: "Logo" })
];

test("an empty search shows everything", () => {
  const visible = expandSearchMatches(nested(), "   ");
  assert.equal(visible.size, 4);
});

test("a matched descendant keeps its ancestors, so it stays in place", () => {
  const visible = expandSearchMatches(nested(), "name text");
  assert.deepEqual([...visible].sort(), ["name", "outer", "strap"]);
});

test("a matched container keeps its whole subtree", () => {
  const visible = expandSearchMatches(nested(), "lower third");
  assert.deepEqual([...visible].sort(), ["name", "outer", "strap"]);
});

test("a non-matching branch is left out", () => {
  const visible = expandSearchMatches(nested(), "logo");
  assert.deepEqual([...visible], ["logo"]);
});

test("objects are searchable by kind, band and primary material", () => {
  const objects = [
    object("a", { name: "Plate", type: "ellipse" } as Partial<SceneObject>),
    object("b", { name: "Bar", layerId: "background" }),
    object("c", { name: "Face", materialSlots: { main: "mat_team" } } as Partial<SceneObject>)
  ];
  assert.deepEqual([...expandSearchMatches(objects, "ellipse")], ["a"]);
  assert.deepEqual([...expandSearchMatches(objects, "background")], ["b"]);
  assert.deepEqual([...expandSearchMatches(objects, "mat_team")], ["c"]);
});

test("a container naming a child that does not exist is tolerated", () => {
  const objects = [group("grp", ["ghost"], { name: "Group" })];
  assert.deepEqual([...expandSearchMatches(objects, "group")], ["grp"]);
});

test("a cyclic legacy group terminates", () => {
  const objects = [group("a", ["b"], { name: "Alpha" }), group("b", ["a"], { name: "Beta" })];
  const visible = expandSearchMatches(objects, "alpha");
  assert.deepEqual([...visible].sort(), ["a", "b"]);
});
