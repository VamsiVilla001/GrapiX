import assert from "node:assert/strict";
import test from "node:test";
import type { SceneObject } from "@grapix/shared-types";
import { containerContains } from "../src/store/objectHierarchy";
import { resolveDrop } from "../src/modules/object-manager/services/objectManagerDrop";

/**
 * The drop grammar, decided on hover.
 *
 * Every refusal here is one the author must see *before* releasing. A gesture that accepts a drop and
 * then does nothing is the defect the Inspector's parent checkbox already ships — it lists every
 * object as a candidate, discards `setContainerChild`'s `false`, and says nothing.
 *
 * `noop` and `invalid` are deliberately different. Dropping something back where it already is is not
 * a mistake and must not be dressed as one.
 */

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
    opacity: 1,
    visible: true,
    locked: false,
    bindings: {},
    materialSlots: {},
    ...overrides
  } as unknown as SceneObject;
}

const group = (id: string, childIds: string[], overrides: Partial<SceneObject> = {}) =>
  object(id, { type: "group", childIds, ...overrides } as Partial<SceneObject>);

const layerObject = (id: string, childIds: string[], layerKind: "object" | "camera") =>
  object(id, { type: "layer", layerKind, childIds } as unknown as Partial<SceneObject>);

/** A leaf, a group holding one child, and a loose leaf below it. */
const scene = () => [
  object("top"),
  group("grp", ["inner"]),
  object("inner"),
  object("bottom")
];

test("the top and bottom quarters of a row are always before and after", () => {
  const objects = scene();
  assert.equal(resolveDrop(objects, ["top"], { kind: "object", id: "bottom" }, 0.1).kind, "before");
  assert.equal(resolveDrop(objects, ["top"], { kind: "object", id: "bottom" }, 0.9).kind, "after");
});

test("the middle half of a container is into", () => {
  const objects = scene();
  for (const fraction of [0.4, 0.5, 0.6]) {
    const drop = resolveDrop(objects, ["top"], { kind: "object", id: "grp" }, fraction);
    assert.equal(drop.kind, "into", `fraction ${fraction}`);
    assert.equal(drop.targetId, "grp");
    assert.equal(drop.depth, 1, "a child of a root container lands at depth 1");
  }
});

test("a leaf has no dead middle: it takes the nearer edge", () => {
  const objects = scene();
  assert.equal(resolveDrop(objects, ["top"], { kind: "object", id: "bottom" }, 0.4).kind, "before");
  assert.equal(resolveDrop(objects, ["top"], { kind: "object", id: "bottom" }, 0.6).kind, "after");
});

test("into is never offered for a leaf", () => {
  const objects = scene();
  for (const fraction of [0.1, 0.4, 0.6, 0.9]) {
    assert.notEqual(
      resolveDrop(objects, ["top"], { kind: "object", id: "bottom" }, fraction).kind,
      "into",
      `fraction ${fraction}`
    );
  }
});

test("a group dropped onto its own descendant is refused, and the store agrees", () => {
  const objects = [object("a"), group("outer", ["mid"]), group("mid", ["leaf"]), object("leaf")];
  const drop = resolveDrop(objects, ["outer"], { kind: "object", id: "leaf" }, 0.5);
  assert.equal(drop.kind, "invalid");
  assert.match(drop.reason ?? "", /inside what you are moving/);
  // Cross-checked against the rule the store enforces, so the indicator cannot promise what the
  // mutation would refuse.
  assert.equal(containerContains(objects, "outer", "leaf"), true);
});

test("a group dropped into a descendant group is refused as a cycle", () => {
  const objects = [group("outer", ["mid"]), group("mid", []), object("other")];
  const drop = resolveDrop(objects, ["outer"], { kind: "object", id: "mid" }, 0.5);
  assert.equal(drop.kind, "invalid");
});

test("a camera layer holds cameras only", () => {
  const objects = [
    layerObject("camera-layer", [], "camera"),
    layerObject("object-layer", [], "object"),
    object("rect"),
    object("cam", { type: "camera", cameraKind: "perspective" } as unknown as Partial<SceneObject>)
  ];

  const rectIntoCameraLayer = resolveDrop(objects, ["rect"], { kind: "object", id: "camera-layer" }, 0.5);
  assert.equal(rectIntoCameraLayer.kind, "invalid");
  assert.equal(rectIntoCameraLayer.reason, "A camera layer holds cameras only");

  const camIntoObjectLayer = resolveDrop(objects, ["cam"], { kind: "object", id: "object-layer" }, 0.5);
  assert.equal(camIntoObjectLayer.kind, "invalid");

  assert.equal(resolveDrop(objects, ["cam"], { kind: "object", id: "camera-layer" }, 0.5).kind, "into");
  assert.equal(resolveDrop(objects, ["rect"], { kind: "object", id: "object-layer" }, 0.5).kind, "into");
});

test("a locked dragged object refuses the whole drop", () => {
  const objects = [object("locked", { locked: true }), object("free"), group("grp", [])];
  const drop = resolveDrop(objects, ["locked"], { kind: "object", id: "grp" }, 0.5);
  assert.equal(drop.kind, "invalid");
  assert.match(drop.reason ?? "", /locked/);
});

test("an unlocked group containing a locked child refuses the drop", () => {
  // The reason this is checked at all: `setContainerChild` rewrites every descendant's `layerId`
  // without a lock check, so moving the parent would quietly move the locked child too.
  const objects = [group("outer", ["locked"]), object("locked", { locked: true }), group("target", [])];
  const drop = resolveDrop(objects, ["outer"], { kind: "object", id: "target" }, 0.5);
  assert.equal(drop.kind, "invalid");
  assert.match(drop.reason ?? "", /inside what you are moving/);
});

test("dropping an object on itself is a calm noop, not an error", () => {
  const objects = scene();
  const drop = resolveDrop(objects, ["top"], { kind: "object", id: "top" }, 0.5);
  assert.equal(drop.kind, "noop");
  assert.equal(drop.reason, undefined);
});

test("dropping into the container that already holds it is a noop", () => {
  const objects = scene();
  const drop = resolveDrop(objects, ["inner"], { kind: "object", id: "grp" }, 0.5);
  assert.equal(drop.kind, "noop");
});

test("a sibling placement inside a group reports the child's depth", () => {
  const objects = [group("grp", ["inner"]), object("inner"), object("loose")];
  const drop = resolveDrop(objects, ["loose"], { kind: "object", id: "inner" }, 0.1);
  assert.equal(drop.kind, "before");
  assert.equal(drop.targetId, "inner");
  assert.equal(drop.depth, 1, "it becomes a sibling of inner, so it lands inside the group");
});

test("a band row moves objects out of their group and into that layer", () => {
  const objects = [group("grp", ["inner"]), object("inner"), object("elsewhere", { layerId: "lower" })];
  const drop = resolveDrop(objects, ["inner"], { kind: "layer", id: "lower" }, 0.5);
  assert.equal(drop.kind, "into-layer");
  assert.equal(drop.targetId, "lower");
});

test("a band row is a noop for an object already loose in that band", () => {
  const objects = [object("free", { layerId: "main" })];
  assert.equal(resolveDrop(objects, ["free"], { kind: "layer", id: "main" }, 0.5).kind, "noop");
});

test("a band row is not a noop for an object in that band but inside a group", () => {
  const objects = [group("grp", ["inner"]), object("inner")];
  assert.equal(resolveDrop(objects, ["inner"], { kind: "layer", id: "main" }, 0.5).kind, "into-layer");
});

test("the scene row places after the band's last root", () => {
  const objects = [object("first"), group("grp", ["inner"]), object("inner"), object("last")];
  const drop = resolveDrop(objects, ["first"], { kind: "scene", id: "main" }, 0.5);
  assert.equal(drop.kind, "after");
  assert.equal(drop.targetId, "last", "inner is not a root, so the last root is `last`");
});

test("an empty drag resolves to nothing at all", () => {
  assert.equal(resolveDrop(scene(), [], { kind: "object", id: "top" }, 0.5).kind, "noop");
});

test("a target that has left the scene is refused rather than crashing", () => {
  const drop = resolveDrop(scene(), ["top"], { kind: "object", id: "ghost" }, 0.5);
  assert.equal(drop.kind, "invalid");
});

test("a cyclic legacy group does not hang the resolver", () => {
  // Two containers naming each other. The tree is malformed, but the panel must stay usable.
  const objects = [group("a", ["b"]), group("b", ["a"]), object("free")];
  const drop = resolveDrop(objects, ["free"], { kind: "object", id: "a" }, 0.5);
  assert.ok(["into", "invalid"].includes(drop.kind));
});
