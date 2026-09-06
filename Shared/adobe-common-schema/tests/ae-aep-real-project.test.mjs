import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { parseAepToManifest } from "../dist/ae/index.js";
import { summarise, collapseWarnings } from "../../../tools/ae/inspect-aep.mjs";

/**
 * The native `.aep` reader against a real, large After Effects project.
 *
 * The vendored fixtures (`fixtures/aep/*.aep`) are the right evidence for byte offsets — every
 * number they assert is one After Effects' own test suite asserts — but they are tiny,
 * metadata-only projects with no keyframe, no mask, and a handful of items. A decode that is
 * subtly wrong only at scale, or on a chunk shape those three files never contain, passes the
 * whole suite and fails on the first project a user actually opens.
 *
 * This test closes that gap with a real project (280 compositions, ~2,800 layers, ~1,000
 * keyframes). It cannot be vendored — it is 65 MB and not ours to redistribute — so it is
 * **presence-guarded**: point `GRAPIX_AEP_FIXTURE` at an `.aep` and it runs, otherwise it skips.
 * CI and a fresh clone stay green; a developer hardening the parser sets the variable once.
 *
 *   GRAPIX_AEP_FIXTURE="C:/path/to/Project.aep" npm test -w @grapix/adobe-common-schema
 *
 * Two kinds of assertion, and the distinction matters:
 *
 * - **Invariants** must hold for *any* correct parse of *any* project. A change that violates one
 *   is a bug in the reader.
 * - **The census** is pinned to the specific project the variable points at, as a regression
 *   tripwire. If you intentionally change decoding, or point the variable at a different file,
 *   these numbers change and you update them on purpose — that is the tripwire doing its job, not
 *   a failure. They are only checked when the pinned project is the one this was written against,
 *   identified by its size and top-line shape, so a different file exercises the invariants alone.
 */

const fixture = process.env.GRAPIX_AEP_FIXTURE;
const available = Boolean(fixture) && existsSync(fixture);

/** The project this file's census numbers were captured from: DYno_Format.aep. */
const PINNED = {
  bytes: 68918829,
  compositions: 280,
  layers: 2772,
  assets: 431,
  fonts: 7,
  warnings: 30,
  animatedStreams: 372,
  keyframes: 1036,
  masks: 279,
  effects: 2156,
  textLayers: 204,
  negativeTimeKeyframes: 64,
  interp: { linear: 725, bezier: 301, hold: 10 }
};

const KNOWN_WARNING_SHAPES = new Set([
  'Text layer "…": Text has N character style runs; GrapiX text carries one style, so the first was used.',
  'Text layer "…": Text has N paragraph style runs; GrapiX text carries one, so the first was used.'
]);

test("a real After Effects project parses without throwing or degrading", { skip: available ? false : "set GRAPIX_AEP_FIXTURE to a .aep to run" }, () => {
  const bytes = new Uint8Array(readFileSync(fixture));
  const manifest = parseAepToManifest(bytes, "real-project", fixture);

  // --- Invariants: true of any correct parse ---
  assert.equal(manifest.producer, "aep-native");
  assert.ok(manifest.compositions.length > 0, "a real project has at least one composition");

  // Warnings are allowed, but only the benign shapes we understand. An unrecognised warning shape
  // means the parser hit degradation this test has not accounted for — look before pinning it.
  for (const [shape] of collapseWarnings(manifest.warnings)) {
    assert.ok(KNOWN_WARNING_SHAPES.has(shape), `unexpected warning shape: ${shape}`);
  }

  for (const comp of manifest.compositions) {
    assert.ok(comp.width >= 0 && comp.height >= 0 && Number.isFinite(comp.frameRate), `comp "${comp.name}" geometry`);
    for (const layer of comp.layers) {
      for (const stream of layer.streams ?? []) {
        // A stream is in the list because it is animated or expression-driven. One with neither is
        // a decode that emitted an entry for nothing. In this project 137 keyframe-less streams
        // are all expression-driven, so this holds and would catch a stream emitted empty.
        assert.ok(
          stream.keyframes.length > 0 || Boolean(stream.expression),
          `stream ${layer.name}/${stream.property} must carry keyframes or an expression`
        );
        for (const key of stream.keyframes) {
          assert.ok(Number.isFinite(key.time), `keyframe time must be finite (${layer.name}/${stream.property})`);
          assert.ok(["linear", "bezier", "hold"].includes(key.interpolation), `interpolation ${key.interpolation}`);
          assert.notEqual(key.value, undefined, "a decoded keyframe must carry a value");
        }
      }
      for (const mask of layer.masks ?? []) {
        assert.ok(Array.isArray(mask.path?.vertices), `mask "${mask.name}" must have a vertex array`);
      }
    }
  }

  // --- Census tripwire: only when the pinned project is the one loaded ---
  const isPinnedProject = statSync(fixture).size === PINNED.bytes && manifest.compositions.length === PINNED.compositions;
  if (!isPinnedProject) return;

  const c = summarise(manifest);
  assert.equal(c.compositions, PINNED.compositions);
  assert.equal(c.layers, PINNED.layers);
  assert.equal(c.assets, PINNED.assets);
  assert.equal(c.fonts, PINNED.fonts);
  assert.equal(c.warnings, PINNED.warnings);
  assert.equal(c.animatedStreams, PINNED.animatedStreams);
  assert.equal(c.keyframes, PINNED.keyframes);
  assert.equal(c.masks, PINNED.masks);
  assert.equal(c.effects, PINNED.effects);
  assert.equal(c.textLayers, PINNED.textLayers);
  assert.equal(c.negativeTimeKeyframes, PINNED.negativeTimeKeyframes);
  assert.deepEqual(c.interp, PINNED.interp);

  // The interpolation counts must add up to the keyframe total — no keyframe silently uncounted.
  assert.equal(c.interp.linear + c.interp.bezier + c.interp.hold, c.keyframes);

  // A concrete decode assertion, independent of iteration order: this project contains an opacity
  // fade whose four keyframes decode to exactly 0 -> 1 -> 1 -> 0. If the value decode regresses,
  // this fails even if the counts happen to still add up.
  const opacityFades = manifest.compositions
    .flatMap((comp) => comp.layers)
    .flatMap((layer) => layer.streams ?? [])
    .filter((stream) => stream.property === "opacity")
    .map((stream) => stream.keyframes.map((key) => key.value));
  assert.ok(
    opacityFades.some((values) => values.length === 4 && values[0] === 0 && values[1] === 1 && values[2] === 1 && values[3] === 0),
    "expected a 0->1->1->0 opacity fade to decode from this project"
  );

  // Negative keyframe times are legitimate (a fade starting before the layer's in-point). Confirm
  // they are bounded — a wild negative time would mean a timebase or offset error, not authoring.
  assert.ok(c.minTime >= -1 && c.minTime < 0, `min keyframe time ${c.minTime} should be a small negative`);
});
