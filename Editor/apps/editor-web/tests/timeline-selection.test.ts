import assert from "node:assert/strict";
import test from "node:test";
import type { SceneObject } from "@grapix/shared-types";
import {
  clampFrameDelta,
  collectTimelineKeys,
  createTimelineRows,
  keysInMarquee,
  objectHasAnimation,
  rowIdForProperty
} from "../src/components/timelineModel";

function rect(id: string, overrides: Partial<SceneObject> = {}): SceneObject {
  return {
    id,
    type: "rect",
    name: id,
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    opacity: 1,
    bindings: {},
    ...overrides
  } as SceneObject;
}

function channel(frames: number[]) {
  return { keys: frames.map((frame, index) => ({ id: `k${index}`, frame, value: frame, easing: "linear" as const })) };
}

test("the keyframed filter keeps only objects that carry animation", () => {
  const animated = rect("animated", { animation: { x: channel([0, 30]) } } as Partial<SceneObject>);
  const still = rect("still");

  assert.equal(objectHasAnimation(animated), true);
  assert.equal(objectHasAnimation(still), false);

  const all = createTimelineRows([animated, still], "all");
  const keyframed = createTimelineRows([animated, still], "keyframed");

  assert.deepEqual(all.map((row) => row.id), [
    "object:animated",
    rowIdForProperty("animated", "x"),
    "object:still"
  ]);
  assert.deepEqual(keyframed.map((row) => row.id), ["object:animated", rowIdForProperty("animated", "x")]);
});

/** A shape morph is animation an author is looking for even with no numeric channel. */
test("shape path animation alone keeps an object in the keyframed filter", () => {
  const shape = {
    ...rect("morph"),
    type: "shape",
    pathAnimation: [{ id: "p0", frame: 5, value: { closed: false, vertices: [], inTangents: [], outTangents: [] } }]
  } as unknown as SceneObject;

  assert.equal(objectHasAnimation(shape), true);
  assert.equal(createTimelineRows([shape], "keyframed").length, 2);
});

test("every kind of key is collected with the row it is drawn on", () => {
  const object = rect("obj", { animation: { x: channel([0, 12]) } } as Partial<SceneObject>);
  const keys = collectTimelineKeys(
    [object],
    [{ id: "legacy1", objectId: "obj", frame: 4, properties: {}, easing: "linear" }]
  );

  assert.deepEqual(
    keys.map((key) => [key.kind, key.frame, key.rowId]),
    [
      ["legacy", 4, "object:obj"],
      ["property", 0, rowIdForProperty("obj", "x")],
      ["property", 12, rowIdForProperty("obj", "x")]
    ]
  );
});

test("a marquee catches keys inside its frame and row span, and nothing on a hidden row", () => {
  const object = rect("obj", { animation: { x: channel([0, 10, 40]) } } as Partial<SceneObject>);
  const keys = collectTimelineKeys([object], []);
  const rowIndexById = new Map([[rowIdForProperty("obj", "x"), 1]]);

  const caught = keysInMarquee(keys, { frameFrom: 5, frameTo: 20, rowFrom: 0, rowTo: 2 }, rowIndexById);
  assert.deepEqual(caught, [`property:obj:x:${"k1"}`]);

  // Reversed drags are the same box.
  assert.deepEqual(
    keysInMarquee(keys, { frameFrom: 20, frameTo: 5, rowFrom: 2, rowTo: 0 }, rowIndexById),
    caught
  );

  // A row the filter removed has no index, so its keys cannot be selected unseen.
  assert.deepEqual(keysInMarquee(keys, { frameFrom: 0, frameTo: 100, rowFrom: 0, rowTo: 9 }, new Map()), []);
});

/**
 * The selection moves as one or not at all. Clamping each key on its own is what collapses a
 * group against frame 0 and destroys the spacing the author built.
 */
test("a group delta is reduced until every key fits, never clamped per key", () => {
  assert.equal(clampFrameDelta([10, 20, 30], 5, 100), 5);
  assert.equal(clampFrameDelta([10, 20, 30], -25, 100), -10, "stops when the earliest key reaches 0");
  assert.equal(clampFrameDelta([10, 20, 90], 40, 100), 10, "stops when the latest key reaches the duration");
  assert.equal(clampFrameDelta([], 10, 100), 0);
  assert.equal(clampFrameDelta([10], Number.NaN, 100), 0);
});
