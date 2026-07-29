import assert from "node:assert/strict";
import test from "node:test";
import {
  frameFromClientX,
  frameToMarkerPosition,
  frameToPercent
} from "../src/components/timelineMath";
import { useUiStore } from "../src/store/uiStore";

test("timeline percentages and pointer frames are bounded", () => {
  assert.equal(frameToPercent(-1, 100), 0);
  assert.equal(frameToPercent(50, 100), 50);
  assert.equal(frameToPercent(200, 100), 100);
  assert.equal(frameToPercent(Number.NaN, 100), 0);

  assert.equal(frameFromClientX(90, 100, 800, 100), 0);
  assert.equal(frameFromClientX(500, 100, 800, 100), 50);
  assert.equal(frameFromClientX(1000, 100, 800, 100), 100);
});

test("edge keyframes stay fully inside the ruler", () => {
  assert.equal(frameToMarkerPosition(0, 100), "8px");
  assert.equal(frameToMarkerPosition(50, 100), "50%");
  assert.equal(frameToMarkerPosition(100, 100), "calc(100% - 8px)");
});

test("current frame rejects non-finite values and honors scene duration", () => {
  const store = useUiStore.getState();

  store.setCurrentFrame(120, 60);
  assert.equal(useUiStore.getState().currentFrame, 60);

  store.setCurrentFrame(Number.NaN, 60);
  assert.equal(useUiStore.getState().currentFrame, 0);
});
