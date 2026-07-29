import assert from "node:assert/strict";
import test from "node:test";
import { placeMaterialContextMenu } from "../src/modules/material-manager/components/materialContextMenu";

test("material context menu remains inside the viewport", () => {
  assert.deepEqual(
    placeMaterialContextMenu(1200, 900, 1280, 960, 248, 390),
    { left: 1024, top: 562, openSubmenusLeft: true }
  );
});

test("material context menu keeps its pointer position when space is available", () => {
  assert.deepEqual(
    placeMaterialContextMenu(100, 80, 1600, 1000, 248, 390),
    { left: 100, top: 80, openSubmenusLeft: false }
  );
});

test("material context menu clamps negative coordinates to its gutter", () => {
  assert.deepEqual(
    placeMaterialContextMenu(-30, -20, 800, 600, 248, 390),
    { left: 8, top: 8, openSubmenusLeft: false }
  );
});
