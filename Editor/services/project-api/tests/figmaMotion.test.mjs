import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyFigmaMotion,
  msToFrames,
  springProgress
} from "../dist/importers/design/figmaMotion.js";

function scene(objects) {
  return {
    version: 1,
    id: "010",
    name: "Motion",
    updatedAt: "2026-08-06T00:00:00.000Z",
    objects,
    assets: [],
    materials: [],
    timeline: { fps: 50, durationFrames: 250, keyframes: [] },
    dataContext: {}
  };
}

function importedObject(id, nodeId) {
  return {
    id,
    type: "rect",
    name: id,
    x: 0,
    y: 0,
    opacity: 1,
    bindings: {},
    materialSlots: {},
    importedDesign: { sourceNodeId: nodeId }
  };
}

function manifest(timelines) {
  return {
    version: 1,
    generator: "test",
    exportedAt: "2026-08-06T00:00:00.000Z",
    timelines
  };
}

const OPTIONS = { fps: 50 };

test("a channel-backed track becomes editable keyframes on the matching object", () => {
  const result = applyFigmaMotion(
    scene([importedObject("obj_1", "12:34")]),
    manifest([{
      id: "t1",
      name: "Slide in",
      durationMs: 400,
      origin: "bridge-export",
      nodes: [{
        nodeId: "12:34",
        tracks: [{
          property: "x",
          keyframes: [
            { timeMs: 0, value: 0, easing: { kind: "preset", name: "EASE_OUT" } },
            { timeMs: 400, value: 200 }
          ]
        }]
      }]
    }]),
    OPTIONS
  );

  const channel = result.scene.objects[0].animation.x;
  assert.deepEqual(channel.keys.map((key) => [key.frame, key.value, key.easing]), [
    [0, 0, "ease-out"],
    [20, 200, "linear"]
  ]);
  assert.equal(result.report.entries[0].compatibility, "native-editable");
  assert.equal(result.report.keyframesCreated, 2);
});

/**
 * The rule the whole module exists for. GrapiX has no width channel, so nothing may be authored
 * from a width track — and nothing may be quietly dropped either.
 */
test("a property with no GrapiX channel writes nothing and keeps its original data", () => {
  const source = scene([importedObject("obj_1", "12:34")]);
  const track = {
    property: "cornerRadius",
    keyframes: [{ timeMs: 0, value: 0 }, { timeMs: 200, value: 24 }]
  };
  const result = applyFigmaMotion(
    source,
    manifest([{ id: "t1", name: "Round", durationMs: 200, origin: "bridge-export", nodes: [{ nodeId: "12:34", tracks: [track] }] }]),
    OPTIONS
  );

  assert.equal(result.scene.objects[0].animation, undefined, "no channel may be invented");
  assert.equal(result.scene, source, "an import that authors nothing must not rewrite the scene");
  const [entry] = result.report.entries;
  assert.equal(entry.compatibility, "unsupported");
  assert.equal(entry.keyframesCreated, 0);
  assert.deepEqual(entry.original.track, track, "the original track survives for the report");
});

test("a Figma cubic bezier is reproduced through tangents rather than swapped for a preset", () => {
  const result = applyFigmaMotion(
    scene([importedObject("obj_1", "12:34")]),
    manifest([{
      id: "t1",
      name: "Custom",
      durationMs: 1000,
      origin: "bridge-export",
      nodes: [{
        nodeId: "12:34",
        tracks: [{
          property: "opacity",
          keyframes: [
            { timeMs: 0, value: 0, easing: { kind: "cubic-bezier", points: [0.25, 0.1, 0.75, 0.9] } },
            { timeMs: 1000, value: 1 }
          ]
        }]
      }]
    }]),
    OPTIONS
  );

  const [first, second] = result.scene.objects[0].animation.opacity.keys;
  // span = 50 frames; x1 = 0.25 -> out.x = 12.5, x2 = 0.75 -> in.x = -(1 - 0.75) * 50 = -12.5
  assert.deepEqual(first.outTangent, { x: 12.5, y: 0.1 });
  assert.deepEqual(second.inTangent, { x: -12.5, y: -0.09999999999999998 });
  assert.equal(result.report.entries[0].compatibility, "native-editable");
});

test("a spring is baked into traceable keys and reported as sampled, not as an exact curve", () => {
  const result = applyFigmaMotion(
    scene([importedObject("obj_1", "12:34")]),
    manifest([{
      id: "t1",
      name: "Bouncy",
      durationMs: 1000,
      origin: "bridge-export",
      nodes: [{
        nodeId: "12:34",
        tracks: [{
          property: "y",
          keyframes: [
            { timeMs: 0, value: 0, easing: { kind: "spring", mass: 1, stiffness: 200, damping: 12 } },
            { timeMs: 1000, value: 100 }
          ]
        }]
      }]
    }]),
    OPTIONS
  );

  const keys = result.scene.objects[0].animation.y.keys;
  assert.ok(keys.length > 3, "a spring needs several keys to trace");
  assert.ok(keys.length <= 48, "and must stay editable rather than one key per frame");
  assert.equal(keys[0].frame, 0);
  assert.equal(result.report.entries[0].compatibility, "sampled");
  assert.match(result.report.entries[0].detail, /approximation/);

  // An under-damped spring overshoots; that is why no polynomial preset was substituted.
  assert.ok(Math.max(...keys.map((key) => key.value)) > 100);
});

test("a Smart Animate transition is reported as converted, and a REST transition as prototype", () => {
  const track = { property: "x", keyframes: [{ timeMs: 0, value: 0 }, { timeMs: 300, value: 60 }] };
  const smart = applyFigmaMotion(
    scene([importedObject("obj_1", "12:34")]),
    manifest([{
      id: "t1", name: "Smart", durationMs: 300, origin: "bridge-export",
      transition: { type: "SMART_ANIMATE", durationMs: 300, easing: { kind: "linear" } },
      nodes: [{ nodeId: "12:34", tracks: [track] }]
    }]),
    OPTIONS
  );
  assert.equal(smart.report.entries[0].compatibility, "smart-animate-converted");

  const proto = applyFigmaMotion(
    scene([importedObject("obj_1", "12:34")]),
    manifest([{
      id: "t2", name: "Push", durationMs: 300, origin: "rest-prototype",
      transition: { type: "PUSH", durationMs: 300, direction: "LEFT", easing: { kind: "linear" } },
      nodes: [{ nodeId: "12:34", tracks: [track] }]
    }]),
    OPTIONS
  );
  assert.equal(proto.report.entries[0].compatibility, "prototype-transition");
});

/** A frame the author did not import is the common case, and the fix is naming which one. */
test("motion for an unimported node is reported by id rather than dropped", () => {
  const result = applyFigmaMotion(
    scene([importedObject("obj_1", "12:34")]),
    manifest([{
      id: "t1", name: "Elsewhere", durationMs: 200, origin: "bridge-export",
      nodes: [{ nodeId: "99:99", name: "Off-screen card", tracks: [{ property: "x", keyframes: [{ timeMs: 0, value: 0 }] }] }]
    }]),
    OPTIONS
  );

  assert.deepEqual(result.report.missingNodes, ["99:99"]);
  assert.equal(result.report.entries[0].compatibility, "unsupported");
  assert.match(result.report.entries[0].detail, /not selected for import/);
});

/** Overlapping timelines are explicitly in scope: the second must add to the first. */
test("two timelines writing one channel merge instead of overwriting", () => {
  const result = applyFigmaMotion(
    scene([importedObject("obj_1", "12:34")]),
    manifest([
      {
        id: "t1", name: "In", durationMs: 200, origin: "bridge-export",
        nodes: [{ nodeId: "12:34", tracks: [{ property: "x", keyframes: [{ timeMs: 0, value: 0 }, { timeMs: 200, value: 50 }] }] }]
      },
      {
        id: "t2", name: "Out", durationMs: 200, delayMs: 400, origin: "bridge-export",
        nodes: [{ nodeId: "12:34", tracks: [{ property: "x", keyframes: [{ timeMs: 0, value: 50 }, { timeMs: 200, value: 0 }] }] }]
      }
    ]),
    OPTIONS
  );

  assert.deepEqual(
    result.scene.objects[0].animation.x.keys.map((key) => key.frame),
    [0, 10, 20, 30],
    "the delayed timeline lands after the first, not on top of it"
  );
  assert.equal(result.report.timelinesConverted, 2);
});

test("timing converts on the scene's own frame rate", () => {
  assert.equal(msToFrames(1000, 50), 50);
  assert.equal(msToFrames(300, 50), 15);
  assert.equal(msToFrames(0, 50), 0);
  assert.equal(msToFrames(Number.NaN, 50), 0);
});

test("spring progress starts at rest and settles at its target", () => {
  const spring = { kind: "spring", mass: 1, stiffness: 180, damping: 20 };
  assert.equal(springProgress(spring, 0), 0);
  assert.ok(Math.abs(springProgress(spring, 1) - 1) < 0.05, "a second in, it is essentially settled");

  const critical = { kind: "spring", mass: 1, stiffness: 100, damping: 20 };
  assert.equal(springProgress(critical, 0), 0);
  assert.ok(springProgress(critical, 0.5) > 0 && springProgress(critical, 0.5) <= 1, "critically damped never overshoots");
});

test("an offset track resolves against the layer's design position", () => {
  // A Motion TRANSLATION track is a displacement, not a coordinate. Importing a 0 key as x = 0
  // would fling every animated layer to the canvas origin, which looks like a broken importer
  // rather than a value-space bug.
  const object = { ...importedObject("obj_1", "12:34"), x: 320, y: 180 };
  const result = applyFigmaMotion(
    scene([object]),
    manifest([{
      id: "t1",
      name: "Slide in",
      durationMs: 400,
      origin: "bridge-export",
      nodes: [{
        nodeId: "12:34",
        tracks: [
          { property: "x", valueSpace: "offset", sourceField: "TRANSLATION_XY", keyframes: [{ timeMs: 0, value: -120 }, { timeMs: 400, value: 0 }] },
          { property: "y", valueSpace: "offset", sourceField: "TRANSLATION_XY", keyframes: [{ timeMs: 0, value: 0 }, { timeMs: 400, value: 0 }] }
        ]
      }]
    }]),
    OPTIONS
  );

  assert.deepEqual(result.scene.objects[0].animation.x.keys.map((key) => key.value), [200, 320]);
  // The layer ends where the design put it, on both axes.
  assert.deepEqual(result.scene.objects[0].animation.y.keys.map((key) => key.value), [180, 180]);

  const entry = result.report.entries.find((item) => item.property === "x");
  // The report names the field the track came from and the position it resolved against, or an
  // author cannot tell a resolved offset from an absolute track that happens to match.
  assert.match(entry.detail, /TRANSLATION_XY/);
  assert.match(entry.detail, /320/);
});

test("an absolute track is not shifted by the layer's position", () => {
  const result = applyFigmaMotion(
    scene([{ ...importedObject("obj_1", "12:34"), x: 320 }]),
    manifest([{
      id: "t1",
      name: "Move",
      durationMs: 200,
      origin: "bridge-export",
      nodes: [{ nodeId: "12:34", tracks: [{ property: "x", keyframes: [{ timeMs: 0, value: 0 }, { timeMs: 200, value: 50 }] }] }]
    }]),
    OPTIONS
  );

  // Absent valueSpace means absolute, so a manifest written before the field existed keeps its
  // meaning.
  assert.deepEqual(result.scene.objects[0].animation.x.keys.map((key) => key.value), [0, 50]);
});

test("a second timeline offsets from the layout, not from the first timeline's keys", () => {
  // Base values are read once, before anything is written. Reading them per timeline would make
  // the second one offset from the first one's keyframes and drift the layer off its position.
  const result = applyFigmaMotion(
    scene([{ ...importedObject("obj_1", "12:34"), x: 100 }]),
    manifest([
      {
        id: "t1", name: "First", durationMs: 100, origin: "bridge-export",
        nodes: [{ nodeId: "12:34", tracks: [{ property: "x", valueSpace: "offset", keyframes: [{ timeMs: 0, value: 10 }] }] }]
      },
      {
        id: "t2", name: "Second", durationMs: 100, origin: "bridge-export",
        nodes: [{ nodeId: "12:34", tracks: [{ property: "x", valueSpace: "offset", keyframes: [{ timeMs: 200, value: 20 }] }] }]
      }
    ]),
    OPTIONS
  );

  assert.deepEqual(result.scene.objects[0].animation.x.keys.map((key) => key.value), [110, 120]);
});

test("an offset on an unset scale channel resolves against 1, not 0", () => {
  // A missing scaleX means "unscaled". Adding a displacement to 0 would collapse the layer.
  const result = applyFigmaMotion(
    scene([importedObject("obj_1", "12:34")]),
    manifest([{
      id: "t1", name: "Pop", durationMs: 100, origin: "bridge-export",
      nodes: [{ nodeId: "12:34", tracks: [{ property: "scaleX", valueSpace: "offset", keyframes: [{ timeMs: 0, value: 0.5 }] }] }]
    }]),
    OPTIONS
  );

  assert.equal(result.scene.objects[0].animation.scaleX.keys[0].value, 1.5);
});

test("a normalized spring bakes and is reported as sampled", () => {
  // Figma Motion states a bounce from 0 to 1 and publishes no inverse of
  // physicalSpringToNormalized, so this is the only honest treatment: trace the curve and say so.
  const result = applyFigmaMotion(
    scene([importedObject("obj_1", "12:34")]),
    manifest([{
      id: "t1",
      name: "Bounce in",
      durationMs: 500,
      origin: "bridge-export",
      nodes: [{
        nodeId: "12:34",
        tracks: [{
          property: "opacity",
          keyframes: [
            { timeMs: 0, value: 0, easing: { kind: "normalized-spring", bounce: 0.6 } },
            { timeMs: 500, value: 1 }
          ]
        }]
      }]
    }]),
    OPTIONS
  );

  const entry = result.report.entries[0];
  assert.equal(entry.compatibility, "sampled");
  assert.match(entry.detail, /approximation/);

  const keys = result.scene.objects[0].animation.opacity.keys;
  assert.ok(keys.length > 2, "a spring is traced by several keys rather than two");
  // Bounded so the result stays editable in the Timeline rather than one key per frame.
  assert.ok(keys.length <= 48);
  assert.equal(keys[0].value, 0);
  const overshoot = Math.max(...keys.map((key) => key.value));
  assert.ok(overshoot > 1, "a bounce of 0.6 overshoots, which is why a preset cannot stand in for it");
});
