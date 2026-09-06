import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  SCENE_KEYFRAME_EASINGS,
  applyEasing,
  isSceneKeyframeEasing,
  onAnimationDiagnostic,
  resetAnimationDiagnostics,
  sampleChannel
} from "../dist/index.js";

/**
 * The easing specification, from the TypeScript side.
 *
 * The Rust twin (`services/render-engine/src/easing.rs`) runs the identical sweep against the
 * identical file, which is the entire point: the Editor previews with this implementation and
 * Program renders with that one, so a curve that differs anywhere is a graphic that eases
 * differently on air than it did in the viewport.
 *
 * The fixture is read, never recomputed. A test that regenerates its own expectation proves
 * only that the implementation equals itself.
 */

const fixture = JSON.parse(
  readFileSync(new URL("../../animation-engine/fixtures/easing-vectors.json", import.meta.url), "utf8")
);

test("every easing reproduces the shared conformance vectors", () => {
  const { times, tolerance, easings } = fixture;
  assert.ok(times.length > 0 && Object.keys(easings).length > 0, "the fixture has content");

  for (const [name, expected] of Object.entries(easings)) {
    assert.equal(expected.length, times.length, `${name} sample count`);
    for (const [index, t] of times.entries()) {
      const actual = applyEasing(name, t);
      assert.notEqual(actual, undefined, `TypeScript does not implement easing "${name}"`);
      const difference = Math.abs(actual - expected[index]);
      assert.ok(
        difference <= tolerance,
        `${name} at t=${t}: got ${actual}, fixture ${expected[index]}, difference ${difference} > ${tolerance}`
      );
    }
  }
});

test("the implemented set and the fixture are the same set", () => {
  const inFixture = new Set(Object.keys(fixture.easings));
  for (const name of SCENE_KEYFRAME_EASINGS) {
    assert.ok(inFixture.has(name), `${name} is implemented but absent from the fixture`);
  }
  for (const name of inFixture) {
    assert.ok(
      SCENE_KEYFRAME_EASINGS.includes(name),
      `${name} is in the fixture but not in SCENE_KEYFRAME_EASINGS`
    );
  }
});

/**
 * The three names already written into scenes on disk are quadratic. Their shape is frozen:
 * every project authored before the library existed must animate exactly as it did.
 */
test("the legacy three keep their exact quadratic curves", () => {
  assert.equal(applyEasing("ease-in", 0.5), 0.25);
  assert.equal(applyEasing("ease-out", 0.5), 0.75);
  assert.equal(applyEasing("ease-in-out", 0.25), 0.125);
  assert.equal(applyEasing("ease-in-out", 0.75), 0.875);
  // And they are the same curves as their explicit `-quad` names.
  for (const t of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
    assert.equal(applyEasing("ease-in", t), applyEasing("ease-in-quad", t));
    assert.equal(applyEasing("ease-out", t), applyEasing("ease-out-quad", t));
    assert.equal(applyEasing("ease-in-out", t), applyEasing("ease-in-out-quad", t));
  }
});

test("every easing starts at 0 and ends at 1, and t is clamped", () => {
  for (const name of SCENE_KEYFRAME_EASINGS) {
    assert.ok(Math.abs(applyEasing(name, 0) - 0) < 1e-12, `${name} at t=0`);
    assert.ok(Math.abs(applyEasing(name, 1) - 1) < 1e-12, `${name} at t=1`);
    // Outside the segment the curve is clamped, never extrapolated: an elastic curve run past
    // 1 produces a value nobody authored.
    assert.equal(applyEasing(name, -0.5), applyEasing(name, 0), `${name} below 0`);
    assert.equal(applyEasing(name, 1.5), applyEasing(name, 1), `${name} above 1`);
  }
});

test("hold steps at the next key rather than interpolating", () => {
  assert.equal(applyEasing("hold", 0), 0);
  assert.equal(applyEasing("hold", 0.99), 0);
  assert.equal(applyEasing("hold", 1), 1);

  const channel = { keys: [
    { id: "a", frame: 0, value: 100, easing: "hold" },
    { id: "b", frame: 10, value: 200, easing: "linear" }
  ] };
  assert.equal(sampleChannel(channel, 0), 100);
  assert.equal(sampleChannel(channel, 9), 100, "a hold key does not drift toward the next value");
  assert.equal(sampleChannel(channel, 10), 200, "it steps at the next key");
});

test("an unknown easing holds the previous value and reports itself", () => {
  const seen = [];
  const stop = onAnimationDiagnostic((diagnostic) => seen.push(diagnostic));

  const channel = { keys: [
    { id: "a", frame: 0, value: 100, easing: "ease-in-out-quintic-ish" },
    { id: "b", frame: 10, value: 200, easing: "linear" }
  ] };
  const midpoint = sampleChannel(channel, 5, { objectId: "rect_1", property: "x" });
  stop();

  // Held, not interpolated and above all not silently linear — which would have given 150.
  assert.equal(midpoint, 100);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].code, "animation.unknown-easing");
  assert.equal(seen[0].value, "ease-in-out-quintic-ish");
  assert.equal(seen[0].objectId, "rect_1");
  assert.equal(seen[0].property, "x");
  assert.equal(seen[0].frame, 5);
});

test("isSceneKeyframeEasing accepts the set and nothing else", () => {
  assert.ok(isSceneKeyframeEasing("ease-out-bounce"));
  assert.ok(isSceneKeyframeEasing("linear"));
  assert.ok(!isSceneKeyframeEasing("ease-out-bouncy"));
  assert.ok(!isSceneKeyframeEasing(undefined));
  assert.ok(!isSceneKeyframeEasing(7));
});

test("a listener that throws cannot stop a scene evaluating", () => {
  const stop = onAnimationDiagnostic(() => {
    throw new Error("a badly behaved console");
  });
  const channel = { keys: [
    { id: "a", frame: 0, value: 0, easing: "nope" },
    { id: "b", frame: 4, value: 80, easing: "linear" }
  ] };
  assert.equal(sampleChannel(channel, 2), 0);
  stop();
});

/**
 * The sampler runs per property per frame — fifty times a second during playback. One real
 * fault must therefore produce one record, not one per sample, or a bounded console fills with
 * copies of a single problem and hides everything else.
 */
test("a repeated fault is reported once, not once per sampled frame", () => {
  resetAnimationDiagnostics();
  const seen = [];
  const stop = onAnimationDiagnostic((diagnostic) => seen.push(diagnostic));

  const channel = { keys: [
    { id: "a", frame: 0, value: 0, easing: "flood-me" },
    { id: "b", frame: 50, value: 100, easing: "linear" }
  ] };
  for (let frame = 1; frame < 50; frame += 1) {
    sampleChannel(channel, frame, { objectId: "rect_1", property: "x" });
  }
  stop();

  assert.equal(seen.length, 1, `49 sampled frames produced ${seen.length} records`);

  // A different property with the same bad easing is a different thing to fix, so it reports.
  const seenAgain = [];
  const stopAgain = onAnimationDiagnostic((diagnostic) => seenAgain.push(diagnostic));
  sampleChannel(channel, 25, { objectId: "rect_1", property: "y" });
  stopAgain();
  assert.equal(seenAgain.length, 1);

  resetAnimationDiagnostics();
});
