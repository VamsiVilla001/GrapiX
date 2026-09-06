import assert from "node:assert/strict";
import test from "node:test";
import {
  FIGMA_MOTION_FIELDS,
  buildMotionManifest,
  convertNodeAnimations,
  figmaMotionEasingToManifest,
  normalizedSpringToPhysical,
  secondsToMs
} from "../dist/index.js";

/**
 * The export bridge's conversion, tested without Figma.
 *
 * Everything here is the part of the bridge that can be wrong silently: a unit, an axis, a curve
 * that gets flattened. The plugin shell around it (`tools/figma-motion-bridge`) only walks the
 * document and downloads the result, and cannot be exercised outside Figma at all — which is
 * exactly why the conversion lives here rather than in the plugin.
 */

const EXPORT_OPTIONS = {
  generator: "grapix-figma-motion-bridge/test",
  exportedAt: "2026-08-06T00:00:00.000Z"
};

function floatKey(timelinePosition, value, easing) {
  return { timelinePosition, value: { type: "FLOAT", value }, easing };
}

test("timelinePosition is read as seconds, not milliseconds", () => {
  // Rule 124's trap by a second road: Figma states 0.3 seconds and the manifest is milliseconds
  // throughout. Reading one as the other is a thousand-fold error that looks like a broken
  // importer rather than a unit bug.
  assert.equal(secondsToMs(0.3), 300);
  assert.equal(secondsToMs(1), 1000);
  assert.equal(secondsToMs(0), 0);

  const node = convertNodeAnimations({
    id: "1:2",
    animations: { OPACITY: { tracks: [{ keyframes: [floatKey(0, 0), floatKey(0.4, 1)] }] } }
  });

  assert.deepEqual(node.tracks[0].keyframes.map((key) => key.timeMs), [0, 400]);
});

test("TRANSLATION_XY splits into an x track and a y track", () => {
  // Figma writes the combined field when a layer is simply dragged, so a converter that only knew
  // TRANSLATION_X would drop the most common case entirely.
  const node = convertNodeAnimations({
    id: "1:2",
    name: "Title",
    animations: {
      TRANSLATION_XY: {
        tracks: [{
          keyframes: [
            { timelinePosition: 0, value: { type: "VECTOR", value: { x: 0, y: 0 } } },
            { timelinePosition: 0.5, value: { type: "VECTOR", value: { x: 120, y: -40 } } }
          ]
        }]
      }
    }
  });

  assert.equal(node.tracks.length, 2);
  const [x, y] = node.tracks;
  assert.equal(x.property, "x");
  assert.equal(y.property, "y");
  assert.deepEqual(x.keyframes.map((key) => key.value), [0, 120]);
  assert.deepEqual(y.keyframes.map((key) => key.value), [0, -40]);
  // Both halves must name the field they came from, or the report cannot tell the author which
  // of their tracks it is describing.
  assert.equal(x.sourceField, "TRANSLATION_XY");
  assert.equal(y.sourceField, "TRANSLATION_XY");
});

test("transform tracks are offsets and opacity/scale are absolute", () => {
  assert.equal(FIGMA_MOTION_FIELDS.TRANSLATION_X.valueSpace, "offset");
  assert.equal(FIGMA_MOTION_FIELDS.TRANSLATION_XY.valueSpace, "offset");
  assert.equal(FIGMA_MOTION_FIELDS.ROTATION.valueSpace, "offset");
  // Scale is a multiplier in both models with 1 meaning "as designed", so adding it to a base of
  // 1 would double every animation.
  assert.equal(FIGMA_MOTION_FIELDS.SCALE_X.valueSpace, "absolute");
  assert.equal(FIGMA_MOTION_FIELDS.SCALE_XY.valueSpace, "absolute");
  assert.equal(FIGMA_MOTION_FIELDS.OPACITY.valueSpace, "absolute");
});

test("only the six channel-backed fields claim a channel", () => {
  const channelled = Object.entries(FIGMA_MOTION_FIELDS)
    .filter(([, mapping]) => mapping.channels)
    .flatMap(([, mapping]) => mapping.channels);

  assert.deepEqual([...new Set(channelled)].sort(), ["opacity", "rotation", "scaleX", "scaleY", "x", "y"]);

  // The absences are the specification. Trim paths are the interesting one: GrapiX has trim
  // paths, but they are not an animation channel and animation.rs excludes path geometry, so a
  // trim track can only ever be reported.
  for (const field of ["WIDTH", "HEIGHT", "CORNER_RADIUS", "STROKE_WEIGHT", "PATH_TRIM_START", "PATH_TRIM_END"]) {
    assert.equal(FIGMA_MOTION_FIELDS[field].channels, undefined, `${field} must not claim a channel`);
  }
});

test("an unmapped field survives under its own name", () => {
  // The Motion API is beta and will add fields. Skipping what we do not recognise would turn a
  // future Figma release into silent data loss.
  const node = convertNodeAnimations({
    id: "1:2",
    animations: { SOME_FUTURE_FIELD: { tracks: [{ keyframes: [floatKey(0, 1)] }] } }
  });

  assert.equal(node.tracks[0].property, "SOME_FUTURE_FIELD");
});

test("the seven polynomial presets pass through and the four named springs do not", () => {
  for (const type of ["EASE_IN", "EASE_OUT", "EASE_IN_AND_OUT", "EASE_IN_BACK", "EASE_OUT_BACK", "EASE_IN_AND_OUT_BACK"]) {
    assert.deepEqual(figmaMotionEasingToManifest({ type }), { kind: "preset", name: type });
  }
  assert.deepEqual(figmaMotionEasingToManifest({ type: "LINEAR" }), { kind: "linear" });
  assert.deepEqual(figmaMotionEasingToManifest({ type: "HOLD" }), { kind: "hold" });

  // Mapping BOUNCY onto ease-out-back would be the fallback that renders different pixels:
  // a spring overshoots by an amount its parameters decide, and no fixed polynomial matches it.
  for (const type of ["GENTLE", "QUICK", "BOUNCY", "SLOW"]) {
    assert.equal(figmaMotionEasingToManifest({ type }).kind, "normalized-spring");
  }
});

test("CUSTOM_SPRING keeps Figma's normalized bounce", () => {
  // Figma Motion states a bounce from 0 to 1 and publishes no inverse of
  // physicalSpringToNormalized, so the physical triple genuinely cannot be recovered here.
  assert.deepEqual(
    figmaMotionEasingToManifest({ type: "CUSTOM_SPRING", easingFunctionSpring: { bounce: 0.4 } }),
    { kind: "normalized-spring", bounce: 0.4 }
  );
});

test("CUSTOM_CUBIC_BEZIER carries its control points, and yields nothing without them", () => {
  assert.deepEqual(
    figmaMotionEasingToManifest({
      type: "CUSTOM_CUBIC_BEZIER",
      easingFunctionCubicBezier: { x1: 0.2, y1: 0, x2: 0.8, y2: 1 }
    }),
    { kind: "cubic-bezier", points: [0.2, 0, 0.8, 1] }
  );

  // Defaulting a curve with no points to linear would quietly flatten the designer's easing.
  assert.equal(figmaMotionEasingToManifest({ type: "CUSTOM_CUBIC_BEZIER" }), undefined);
});

test("a variable-bound easing resolves to no curve rather than a guessed one", () => {
  assert.equal(figmaMotionEasingToManifest({ type: "VARIABLE_ALIAS", id: "VariableID:1:2" }), undefined);
  assert.equal(figmaMotionEasingToManifest(undefined), undefined);
});

test("bounce maps to damping ratio, and never reaches undamped", () => {
  // The one assumption the sampler makes: damping ratio = 1 - bounce, with the segment as the
  // period. Stated here so a future change to it breaks a test rather than a broadcast.
  const critical = normalizedSpringToPhysical(0, 0.5);
  const zeta = (spring) => spring.damping / (2 * Math.sqrt(spring.stiffness * spring.mass));
  assert.ok(Math.abs(zeta(critical) - 1) < 1e-9, "bounce 0 settles without overshoot");

  const bouncy = normalizedSpringToPhysical(0.6, 0.5);
  assert.ok(Math.abs(zeta(bouncy) - 0.4) < 1e-9);

  // A truly undamped spring never settles, so the imported motion would end somewhere other
  // than where the design ends.
  assert.ok(zeta(normalizedSpringToPhysical(1, 0.5)) >= 0.08);

  // A shorter segment is a stiffer spring: the period comes from the keyframe times.
  assert.ok(normalizedSpringToPhysical(0.3, 0.2).stiffness > normalizedSpringToPhysical(0.3, 1).stiffness);
});

test("a frame with no motion produces no timeline", () => {
  // The report counts converted timelines against timelines offered; padding the denominator
  // with frames that never had motion would make a complete import look partial.
  const manifest = buildMotionManifest(
    [
      { id: "1:1", name: "Static", nodes: [{ id: "1:2", name: "Logo" }] },
      {
        id: "2:1",
        name: "Lower Third",
        nodes: [{ id: "2:2", name: "Title", animations: { OPACITY: { tracks: [{ keyframes: [floatKey(0, 0), floatKey(0.3, 1)] }] } } }]
      }
    ],
    EXPORT_OPTIONS
  );

  assert.equal(manifest.timelines.length, 1);
  assert.equal(manifest.timelines[0].name, "Lower Third");
  assert.equal(manifest.timelines[0].sourceFrameId, "2:1");
  // origin decides how the importer classifies these: real per-property tracks, not a
  // transition's implied motion.
  assert.equal(manifest.timelines[0].origin, "bridge-export");
  // Every frame the export covered is still listed, so the picker's offer is recorded even
  // where it produced nothing.
  assert.deepEqual(manifest.frames.map((frame) => frame.id), ["1:1", "2:1"]);
  assert.equal(manifest.version, 1);
});

test("a timeline is never shorter than its own last keyframe", () => {
  const manifest = buildMotionManifest(
    [{
      id: "1:1",
      name: "Bug",
      nodes: [{
        id: "1:2",
        // Figma declares 0.4s while a key sits at 0.9s: taking the declared duration would cut
        // the last keyframe off the timeline the importer builds.
        timelines: [{ id: "t1", duration: 0.4 }],
        animations: { OPACITY: { tracks: [{ keyframes: [floatKey(0, 0), floatKey(0.9, 1)] }] } }
      }]
    }],
    EXPORT_OPTIONS
  );

  assert.equal(manifest.timelines[0].durationMs, 900);
});

test("an animation style's name reaches the track", () => {
  const node = convertNodeAnimations({
    id: "1:2",
    animations: {
      TRANSLATION_X: { tracks: [{ keyframes: [floatKey(0, 0), floatKey(0.2, 40)], animationStyleName: "Slide In" }] }
    }
  });

  assert.equal(node.tracks[0].animationStyle, "Slide In");
});

test("a non-numeric value on a channel-backed field is passed through, not coerced", () => {
  // The importer's numeric filter then reports it as carrying nothing interpolable, which is the
  // truthful outcome. Coercing it here would invent a keyframe.
  const node = convertNodeAnimations({
    id: "1:2",
    animations: { OPACITY: { tracks: [{ keyframes: [{ timelinePosition: 0, value: { type: "BOOL", value: true } }] }] } }
  });

  assert.equal(node.tracks[0].keyframes[0].value, true);
});

test("an unsupported field keeps its whole value rather than an axis of it", () => {
  // A COLOR track's RGBA is what makes its report entry worth reading.
  const node = convertNodeAnimations({
    id: "1:2",
    animations: {
      FILL_COLOR: { tracks: [{ keyframes: [{ timelinePosition: 0, value: { type: "COLOR", value: { r: 1, g: 0, b: 0, a: 1 } } }] }] }
    }
  });

  assert.deepEqual(node.tracks[0].keyframes[0].value, { r: 1, g: 0, b: 0, a: 1 });
});

test("a node with no animations, or only empty tracks, produces nothing", () => {
  assert.equal(convertNodeAnimations({ id: "1:2" }), undefined);
  assert.equal(convertNodeAnimations({ id: "1:2", animations: {} }), undefined);
  assert.equal(convertNodeAnimations({ id: "1:2", animations: { OPACITY: { tracks: [] } } }), undefined);
  assert.equal(convertNodeAnimations({ id: "1:2", animations: { OPACITY: { tracks: [{ keyframes: [] }] } } }), undefined);
});
