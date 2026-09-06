import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { resolveAeCueMap } from "../dist/index.js";

const fixture = JSON.parse(await readFile(new URL("../fixtures/ae-cue-vectors.json", import.meta.url), "utf8"));
const marker = (text, value, scale) => ({ text, time: { value: String(value), scale: String(scale) } });

function resolved() {
  return resolveAeCueMap(
    fixture.cueMap.markers.map(({ text, time }) => ({ text, time })),
    fixture.cueMap.rate
  );
}

const cueMapMarkers = () => fixture.cueMap.markers.map(({ text, time }) => ({ text, time }));

test("the shared fixture resolves declared cues to its exact frame/deadline pairs", () => {
  const result = resolved();
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(
    result.cues.map(({ role, id, frame, deadlineNanos }) => ({ role, id, frame, deadlineNanos })),
    fixture.cueMap.markers.map(({ text, frame, deadlineNanos }) => ({
      role: text === "GRAPIX:CONTINUE:1" ? "CONTINUE" : text.slice("GRAPIX:".length),
      id: text === "GRAPIX:CONTINUE:1" ? "1" : null,
      frame,
      deadlineNanos
    }))
  );
  assert.equal(result.digest, "066ac3920088ffed2dace78821f22cb52c04791bf4e4a6d5c9feaa6d1ed6fd93");
});

test("the shared fixture keeps exact absolute deadlines at every required rate", () => {
  for (const { rate, vectors } of fixture.rateVectors) {
    for (const { frame, deadlineNanos } of vectors) {
      const time = { value: String(frame * rate.denominator), scale: String(rate.numerator) };
      const result = resolveAeCueMap([
        marker("GRAPIX:CUE", 0, rate.numerator),
        marker("GRAPIX:IN", time.value, time.scale),
        marker("GRAPIX:HOLD", time.value, time.scale),
        marker("GRAPIX:OUT", time.value, time.scale),
        marker("GRAPIX:END", Number(time.value) + rate.denominator, time.scale)
      ], rate);
      assert.equal(result.ok, true, `${rate.numerator}/${rate.denominator} frame ${frame}`);
      if (!result.ok) continue;
      assert.equal(result.cues.find((cue) => cue.role === "IN")?.frame, frame);
      assert.equal(result.cues.find((cue) => cue.role === "IN")?.deadlineNanos, deadlineNanos);
    }
  }
});

test("an off-frame cue refuses the entire map before CUE can be accepted", () => {
  const result = resolveAeCueMap([
    marker("GRAPIX:CUE", 1, 2),
    marker("GRAPIX:IN", 1001, 30000),
    marker("GRAPIX:HOLD", 2002, 30000),
    marker("GRAPIX:OUT", 3003, 30000),
    marker("GRAPIX:END", 4004, 30000)
  ], { numerator: 30000, denominator: 1001 });
  assert.deepEqual(result.ok ? null : { code: result.code, marker: result.marker }, { code: "CUE_OFF_FRAME", marker: "GRAPIX:CUE" });
});

test("only declared complete grammar becomes a cue map", () => {
  const malformed = resolveAeCueMap([marker("GRAPIX:GO", 0, 1)], { numerator: 25, denominator: 1 });
  assert.deepEqual(malformed.ok ? null : { code: malformed.code, marker: malformed.marker }, { code: "CUE_MARKER_MALFORMED", marker: "GRAPIX:GO" });

  const invalidId = resolveAeCueMap([marker("GRAPIX:CONTINUE:bad id", 0, 1)], { numerator: 25, denominator: 1 });
  assert.deepEqual(invalidId.ok ? null : { code: invalidId.code, marker: invalidId.marker }, { code: "CUE_ID_INVALID", marker: "GRAPIX:CONTINUE:bad id" });

  const ignored = resolveAeCueMap([
    marker("ordinary AE marker", 0, 1),
    marker("GRAPIX:CUE", 0, 1), marker("GRAPIX:IN", 1, 25), marker("GRAPIX:HOLD", 2, 25),
    marker("GRAPIX:OUT", 3, 25), marker("GRAPIX:END", 4, 25)
  ], { numerator: 25, denominator: 1 });
  assert.equal(ignored.ok, true);

  const duplicate = resolveAeCueMap([
    marker("GRAPIX:CUE", 0, 1), marker("GRAPIX:CUE", 1, 25), marker("GRAPIX:IN", 1, 25),
    marker("GRAPIX:HOLD", 2, 25), marker("GRAPIX:OUT", 3, 25), marker("GRAPIX:END", 4, 25)
  ], { numerator: 25, denominator: 1 });
  assert.deepEqual(duplicate.ok ? null : { code: duplicate.code, marker: duplicate.marker }, { code: "CUE_ROLE_DUPLICATED", marker: "GRAPIX:CUE" });
});


test("clock-free resolution preserves every recorded cue-map pin", () => {
  const result = resolved();
  assert.equal(result.ok, true);
  if (!result.ok) return;
  // Existing pins predate composition clocks, so their canonical bytes must remain untouched.
  assert.equal(result.digest, "066ac3920088ffed2dace78821f22cb52c04791bf4e4a6d5c9feaa6d1ed6fd93");
  assert.equal(result.cues.some((cue) => cue.compositionTime !== undefined), false);
});

test("a matching composition clock binds every resolved cue to AE's own scale", () => {
  const clock = { frameDuration: "1001", timeScale: "60000" };
  const withoutClock = resolved();
  const result = resolveAeCueMap(cueMapMarkers(), fixture.cueMap.rate, clock);
  assert.equal(withoutClock.ok, true);
  assert.equal(result.ok, true);
  if (!withoutClock.ok || !result.ok) return;

  // Once the clocks are proven equal, every Program frame must be stated in AE's native units.
  for (const cue of result.cues) {
    assert.deepEqual(cue.compositionTime, {
      value: String(cue.frame * Number(clock.frameDuration)),
      scale: clock.timeScale
    });
  }
  assert.notEqual(result.digest, withoutClock.digest);
});

test("a composition with a different rate rejects the map before marker timing is considered", () => {
  const result = resolveAeCueMap(cueMapMarkers(), fixture.cueMap.rate, {
    frameDuration: "800",
    timeScale: "23976"
  });
  assert.equal(result.ok, false);
  if (result.ok) return;

  // The operator needs both the declared Program clock and AE's measured clock to repair the map.
  assert.equal(result.code, "CUE_RATE_NOT_IN_COMPOSITION_SCALE");
  assert.match(result.message, /60000\/1001/);
  assert.match(result.message, /800/);
  assert.match(result.message, /23976/);
});

test("a re-authored composition scale invalidates the prior clock-aware pin", () => {
  const nativeClock = { frameDuration: "1001", timeScale: "60000" };
  const reauthoredClock = { frameDuration: "2002", timeScale: "120000" };
  const native = resolveAeCueMap(cueMapMarkers(), fixture.cueMap.rate, nativeClock);
  const reauthored = resolveAeCueMap(cueMapMarkers(), fixture.cueMap.rate, reauthoredClock);
  assert.equal(native.ok, true);
  assert.equal(reauthored.ok, true);
  if (!native.ok || !reauthored.ok) return;

  // Equal rates are not enough: SET_TIME is expressed in the composition's selected scale.
  assert.notEqual(reauthored.digest, native.digest);
  assert.notDeepEqual(
    reauthored.cues.map((cue) => cue.compositionTime),
    native.cues.map((cue) => cue.compositionTime)
  );
});