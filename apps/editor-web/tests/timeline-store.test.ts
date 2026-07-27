import assert from "node:assert/strict";
import test from "node:test";
import type { PropertyChannelMap } from "@grapix/shared-types";
import {
  clonePropertyAnimation,
  removePropertyKeyframe
} from "../src/store/timelineAnimation";

test("duplicating an animated object deep-clones channels with fresh keyframe IDs", () => {
  const source: PropertyChannelMap = {
    x: {
      keys: [
        {
          id: "pkf_x_0",
          frame: 0,
          value: 100,
          easing: "ease-in-out",
          inTangent: { x: -5, y: -10 },
          outTangent: { x: 7, y: 14 }
        },
        { id: "pkf_x_30", frame: 30, value: 420, easing: "linear" }
      ]
    },
    rotationX: {
      keys: [{ id: "pkf_rx_12", frame: 12, value: 20, easing: "ease-in-out" }]
    }
  };

  const duplicate = clonePropertyAnimation(source);
  assert.ok(duplicate);
  assert.notStrictEqual(duplicate, source);
  assert.notStrictEqual(duplicate.x, source.x);
  assert.notStrictEqual(duplicate.x?.keys, source.x?.keys);

  const sourceKeys = Object.values(source)
    .flatMap((channel) => channel?.keys ?? []);
  const duplicateKeys = Object.values(duplicate)
    .flatMap((channel) => channel?.keys ?? []);
  assert.equal(duplicateKeys.length, sourceKeys.length);
  assert.equal(new Set(duplicateKeys.map((key) => key.id)).size, duplicateKeys.length);
  assert.ok(duplicateKeys.every((key) => !sourceKeys.some((sourceKey) => sourceKey.id === key.id)));

  const sourceTangent = source.x?.keys[0]?.outTangent;
  const duplicateTangent = duplicate.x?.keys[0]?.outTangent;
  assert.deepEqual(duplicateTangent, sourceTangent);
  assert.notStrictEqual(duplicateTangent, sourceTangent);
});

test("deleting the last property key removes empty channels and animation maps", () => {
  const initial: PropertyChannelMap = {
    x: {
      keys: [
        { id: "pkf_x_0", frame: 0, value: 100, easing: "linear" },
        { id: "pkf_x_20", frame: 20, value: 240, easing: "linear" }
      ]
    },
    y: {
      keys: [{ id: "pkf_y_0", frame: 0, value: 200, easing: "linear" }]
    }
  };

  const afterFirstXDelete = removePropertyKeyframe(initial, "x", "pkf_x_0");
  assert.equal(afterFirstXDelete?.x?.keys.length, 1);

  const afterLastXDelete = removePropertyKeyframe(afterFirstXDelete, "x", "pkf_x_20");
  assert.equal(afterLastXDelete?.x, undefined);
  assert.equal(afterLastXDelete?.y?.keys.length, 1);

  const afterLastChannelDelete = removePropertyKeyframe(afterLastXDelete, "y", "pkf_y_0");
  assert.equal(afterLastChannelDelete, undefined);
});
