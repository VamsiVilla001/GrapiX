import assert from "node:assert/strict";
import test from "node:test";
import type { SceneObject } from "@grapix/shared-types";
import {
  batchConstraint,
  BATCH_REFUSED,
  batchGate,
  batchLabel,
  batchMaterialSurface,
  batchValue,
  batchableProperties,
  describeSelection
} from "../src/modules/object-inspector/services/multiSelection";

/**
 * Editing more than one object at a time.
 *
 * The scenarios are the ones the plan's exit gate names: twelve mixed rects, a rect+mesh set,
 * heterogeneous booleans, a homogeneous text set, and a set with two locked members. What each asserts
 * is the *offered field set* and the *refusals* — because the defect being fixed was a field that
 * looked ordinary and wrote to one object out of twelve.
 */

function base(id: string, extra: Partial<SceneObject> = {}) {
  return {
    id,
    name: id,
    x: 0,
    y: 0,
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
    strokeWidth: 1,
    bindings: {},
    materialSlots: {},
    ...extra
  };
}

function rect(id: string, extra: Partial<SceneObject> = {}): SceneObject {
  return { ...base(id, extra), type: "rect", radius: 0 } as SceneObject;
}

function mesh(id: string, extra: Partial<SceneObject> = {}): SceneObject {
  return { ...base(id, extra), type: "mesh", meshKind: "cube", depth: 10 } as SceneObject;
}

function text(id: string, extra: Partial<SceneObject> = {}): SceneObject {
  return {
    ...base(id, extra),
    type: "text",
    text: id,
    fontSize: 48,
    fontFamily: "Arial",
    fontWeight: "400",
    align: "left"
  } as SceneObject;
}

function line(id: string, extra: Partial<SceneObject> = {}): SceneObject {
  return { ...base(id, extra), type: "line", points: [{ x: 0, y: 0 }, { x: 10, y: 10 }] } as SceneObject;
}

const twelveRects = Array.from({ length: 12 }, (_, index) =>
  rect(`r${index}`, { x: index * 10, opacity: index % 2 === 0 ? 1 : 0.5 })
);

test("the summary counts what is selected, by type and by state", () => {
  const summary = describeSelection([
    rect("a"), rect("b"), mesh("c"), text("d", { visible: false }), text("e", { locked: true })
  ]);
  assert.equal(summary.count, 5);
  assert.deepEqual(summary.byType, [
    { type: "rect", count: 2 },
    { type: "text", count: 2 },
    { type: "mesh", count: 1 }
  ]);
  assert.equal(summary.visible, 4);
  assert.equal(summary.hidden, 1);
  assert.equal(summary.locked, 1);
  assert.equal(summary.homogeneous, false);
  assert.equal(summary.sharedType, null);
});

test("a homogeneous selection names its shared type", () => {
  const summary = describeSelection(twelveRects);
  assert.equal(summary.count, 12);
  assert.equal(summary.homogeneous, true);
  assert.equal(summary.sharedType, "rect");
});

test("twelve rects offer position, size, planar transform, opacity and appearance", () => {
  const offered = batchableProperties(twelveRects);
  for (const property of [
    "x", "y", "zDepth", "opacity", "width", "height", "rotation", "scaleX", "scaleY",
    "fill", "stroke", "strokeWidth"
  ]) {
    assert.ok(offered.includes(property), `${property} should be batchable across rects`);
  }
});

test("a rect and a mesh share only position, size and opacity", () => {
  // `rotation` means different things to the two: a mesh's is a legacy Z fallback. Writing one number
  // into two meanings is the kind of edit that looks fine and is not.
  const offered = batchableProperties([rect("a"), mesh("b")]);
  assert.deepEqual(offered.sort(), ["height", "opacity", "width", "x", "y", "zDepth"].sort());
  assert.ok(!offered.includes("rotation"));
  assert.ok(!offered.includes("scaleX"));
  assert.ok(!offered.includes("fill"));
});

test("a homogeneous mesh set gets three rotation axes and three scale axes", () => {
  const offered = batchableProperties([mesh("a"), mesh("b")]);
  for (const property of ["rotationX", "rotationY", "rotationZ", "scaleX", "scaleY", "scaleZ"]) {
    assert.ok(offered.includes(property), `${property} should be batchable across meshes`);
  }
  // A mesh's legacy 2D `rotation` is not offered beside its own Z axis: two controls, one angle.
  assert.ok(!offered.includes("rotation"));
});

test("a homogeneous text set adds type style but never content", () => {
  const offered = batchableProperties([text("a"), text("b"), text("c")]);
  for (const property of ["fontSize", "fontFamily", "fontWeight", "align", "lineHeight"]) {
    assert.ok(offered.includes(property), `${property} should be batchable across text`);
  }
  assert.ok(!offered.includes("text"), "content must never be batched");
  assert.ok(!offered.includes("name"), "names must never be batched");
});

test("a type whose geometry ignores its box is not offered a size", () => {
  // The same refusal P0 made for one object, applied to a set: a line draws from its points.
  const offered = batchableProperties([line("a"), line("b")]);
  assert.ok(!offered.includes("width"));
  assert.ok(!offered.includes("height"));
  assert.ok(offered.includes("x"), "position still means the same thing");
});

test("a mixed set containing a line loses size but keeps position", () => {
  const offered = batchableProperties([rect("a"), line("b")]);
  assert.ok(!offered.includes("width"), "one line is enough to refuse size for the set");
  assert.deepEqual(offered.sort(), ["opacity", "x", "y", "zDepth"].sort());
});

test("a property nothing renders is not offered to a set either", () => {
  // `effects` is `neither` in the renderer contract, and it is also explicitly refused.
  const offered = batchableProperties(twelveRects);
  assert.ok(!offered.includes("effects"));
  assert.ok("effects" in BATCH_REFUSED);
});

test("every refusal states a reason, so the panel can explain itself", () => {
  for (const [property, reason] of Object.entries(BATCH_REFUSED)) {
    assert.ok(reason.length > 10, `${property} needs a real reason, got "${reason}"`);
  }
});

test("a single object offers no batch fields at all", () => {
  assert.deepEqual(batchableProperties([rect("a")]), []);
  assert.deepEqual(batchableProperties([]), []);
});

test("an agreeing property reports its shared value", () => {
  const value = batchValue(twelveRects, (object) => object.zDepth);
  assert.deepEqual(value, { kind: "same", value: 0 });
});

test("a disagreeing property reports Mixed and no value at all", () => {
  const value = batchValue(twelveRects, (object) => object.x);
  assert.equal(value.kind, "mixed");
  // The shape carries no `value` field, so a caller cannot render the first object's number by
  // accident — which is the whole point of the type.
  assert.ok(!("value" in value));
  if (value.kind === "mixed") assert.equal(value.count, 12);
});

test("heterogeneous booleans read as Mixed, not as the active object's state", () => {
  const objects = [rect("a", { visible: true }), rect("b", { visible: false })];
  const value = batchValue(objects, (object) => object.visible);
  assert.equal(value.kind, "mixed");
  if (value.kind === "mixed") assert.equal(value.count, 2);
});

test("agreeing booleans report the shared state", () => {
  const objects = [rect("a", { visible: false }), rect("b", { visible: false })];
  assert.deepEqual(batchValue(objects, (object) => object.visible), { kind: "same", value: false });
});

test("two distinct values across twelve objects still count two, not twelve", () => {
  const value = batchValue(twelveRects, (object) => object.opacity);
  assert.equal(value.kind, "mixed");
  if (value.kind === "mixed") assert.equal(value.count, 2);
});

test("a clean selection opens the gate over every id", () => {
  const gate = batchGate(twelveRects);
  assert.equal(gate.allowed, true);
  assert.equal(gate.targetIds.length, 12);
  assert.deepEqual(gate.lockedIds, []);
  assert.equal(gate.reason, undefined);
});

test("two locked members refuse the whole batch, not just themselves", () => {
  const objects = [
    ...twelveRects.slice(0, 10),
    rect("locked1", { locked: true }),
    rect("locked2", { locked: true })
  ];
  const gate = batchGate(objects);
  assert.equal(gate.allowed, false);
  // No partial write: the ten unlocked ids are not offered as targets.
  assert.deepEqual(gate.targetIds, []);
  assert.deepEqual(gate.lockedIds, ["locked1", "locked2"]);
  assert.match(gate.reason ?? "", /2 locked objects/);
});

test("one locked member is named in the singular", () => {
  const gate = batchGate([rect("a"), rect("b", { locked: true })]);
  assert.equal(gate.allowed, false);
  assert.match(gate.reason ?? "", /^1 locked object must be unlocked/);
});

test("a batch label says what changed and how many", () => {
  assert.equal(batchLabel("x", 12), "Set x on 12 objects");
  assert.equal(batchLabel("opacity", 1), "Set opacity on 1 object");
});

test("a Materials batch needs every target to be a material surface", () => {
  assert.equal(batchMaterialSurface([rect("a"), rect("b")]), true);
  assert.equal(batchMaterialSurface([rect("a"), line("b")]), false, "a stroke is not a surface");
  assert.equal(batchMaterialSurface([rect("a")]), false, "a single object is not a batch");
});

/*
 * The range and unit a batch may claim.
 *
 * A selection can span types, and a constraint is per type. Borrowing the first object's would label
 * a mixed set with a unit only part of it is measured in — the single-object panel says "X (px)", so
 * a set that says a bare "X" for the same property is the same panel disagreeing with itself.
 */

test("a property constrained the same for every target reports that constraint", () => {
  const constraint = batchConstraint([rect("a"), rect("b")], "x");
  assert.equal(constraint?.unit, "px");
  assert.equal(constraint?.step, 0.1);
});

test("the constraint is the same across types when the table declares it once", () => {
  // `x` has no per-type override, so a rect and a text agree and the batch can be labelled.
  const mixed = batchConstraint([rect("a"), text("t")], "x");
  assert.equal(mixed?.unit, "px");
});

test("a property the table constrains per type is reported bare across a mixed set", () => {
  // `fontSize` is text-only: a rect has no such constraint, so no unit or range may be claimed.
  assert.equal(batchConstraint([text("t"), rect("a")], "fontSize"), undefined);
  // Homogeneous, and it resolves.
  assert.equal(batchConstraint([text("t"), text("u")], "fontSize")?.unit, "px");
});

test("an unconstrained property reports nothing rather than a made-up range", () => {
  assert.equal(batchConstraint([rect("a"), rect("b")], "notAProperty"), undefined);
});

test("an empty selection reports nothing", () => {
  assert.equal(batchConstraint([], "x"), undefined);
});
