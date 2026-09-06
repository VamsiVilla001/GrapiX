import assert from "node:assert/strict";
import test from "node:test";
import { deriveAeAnimation } from "../dist/ae/aeAnimationDerivation.js";

/**
 * The derivation is where a designer's `GRAPIX:` markers become the broadcast actions a package
 * carries. These tests pin that mapping: which cues become which regions, that `holds` lands on the
 * sustain and nowhere else, and that a composition with no markers — or an unresolvable map — stays
 * silent rather than guessing.
 */

const CLOCK = { frameDuration: "1000", timeScale: "25000" }; // 25000/1000 = exactly 25 fps
const RATE = "25/1";

function composition(markers) {
  return {
    id: "7",
    name: "GX_lower",
    width: 1920,
    height: 1080,
    duration: 10,
    frameRate: 25,
    displayStartTime: 0,
    workAreaStart: 0,
    workAreaDuration: 10,
    backgroundColor: "#000000",
    layers: [],
    markers
  };
}

const at = (seconds, text) => ({ time: seconds, comment: text });

test("a complete cue map becomes the three broadcast actions", () => {
  const derived = deriveAeAnimation(
    composition([
      at(0, "GRAPIX:CUE"),
      at(1, "GRAPIX:IN"),
      at(2, "GRAPIX:HOLD"),
      at(8, "GRAPIX:OUT"),
      at(9, "GRAPIX:END")
    ]),
    RATE,
    CLOCK
  );

  assert.ok(derived.cueMap, "a complete map must produce a cue map");
  assert.deepEqual(
    derived.actions.map((action) => action.role),
    ["IN", "HOLD", "OUT"]
  );

  const [entrance, sustain, exit] = derived.actions;
  // At 25 fps, 1s is frame 25 — and it is exact, because the whole chain works in rationals.
  assert.deepEqual([entrance.startFrame, entrance.endFrame], [25, 50]);
  assert.deepEqual([sustain.startFrame, sustain.endFrame], [50, 200]);
  assert.deepEqual([exit.startFrame, exit.endFrame], [200, 225]);
  // Only the sustain holds: it is where Playout parks until told to continue.
  assert.equal(entrance.holds, undefined);
  assert.equal(sustain.holds, true);
  assert.equal(exit.holds, undefined);

  // The cue map carries what Playout needs to seek, and a digest to pin it.
  assert.ok(derived.cueMap.cueMapDigest.length === 64);
  assert.deepEqual(derived.cueMap.cues.map((cue) => cue.role), ["CUE", "IN", "HOLD", "OUT", "END"]);
});

test("a composition with no markers derives nothing rather than guessing", () => {
  const derived = deriveAeAnimation(composition([at(1, "chapter marker")]), RATE, CLOCK);
  assert.deepEqual(derived.actions, []);
  assert.equal(derived.cueMap, null);
});

test("an incomplete map is refused, not partially played", () => {
  // Missing OUT/END: the resolver refuses, and the derivation surfaces that as silence.
  const derived = deriveAeAnimation(
    composition([at(0, "GRAPIX:CUE"), at(1, "GRAPIX:IN"), at(2, "GRAPIX:HOLD")]),
    RATE,
    CLOCK
  );
  assert.deepEqual(derived.actions, []);
  assert.equal(derived.cueMap, null);
});

test("CONTINUE markers are cues, not regions", () => {
  const derived = derivedMap();
  // CONTINUE:replay appears among the cues Playout can drive to, but adds no fourth action.
  assert.deepEqual(derived.actions.map((action) => action.role), ["IN", "HOLD", "OUT"]);
  assert.ok(derived.cueMap.cues.some((cue) => cue.role === "CONTINUE" && cue.id === "replay"));
});

function derivedMap() {
  return deriveAeAnimation(
    composition([
      at(0, "GRAPIX:CUE"),
      at(1, "GRAPIX:IN"),
      at(2, "GRAPIX:HOLD"),
      at(5, "GRAPIX:CONTINUE:replay"),
      at(8, "GRAPIX:OUT"),
      at(9, "GRAPIX:END")
    ]),
    RATE,
    CLOCK
  );
}
