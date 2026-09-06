import assert from "node:assert/strict";
import { test } from "node:test";
import {
  collectPrototypeTimelines,
  smartAnimateNodes
} from "../dist/importers/design/figmaPrototype.js";

function node(id, name, overrides = {}) {
  return {
    id,
    sourceId: id,
    name,
    type: "frame",
    x: 0, y: 0, width: 400, height: 300,
    rotation: 0, scaleX: 1, scaleY: 1,
    anchor: { x: 0, y: 0 },
    opacity: 1, visible: true, locked: false,
    blendMode: "normal",
    fills: [], strokes: [], strokeWidth: 0,
    masks: [], effects: [], children: [],
    ...overrides
  };
}

function doc(nodes) {
  return { sourceFormat: "figma-json", sourceName: "test", pages: [{ id: "p", name: "Page", nodes }], assets: [], fonts: [] };
}

function interaction(destinationId, transition, trigger = { type: "ON_CLICK" }) {
  return { interactions: [{ trigger, actions: [{ type: "NODE", destinationId, transition }] }] };
}

test("a Push transition moves the destination in and the source out", () => {
  const source = node("1:1", "Home", { sourceData: interaction("1:2", { type: "PUSH", duration: 0.3, direction: "LEFT", easing: { type: "EASE_OUT" } }) });
  const destination = node("1:2", "Details");
  const [timeline] = collectPrototypeTimelines(doc([source, destination]));

  assert.equal(timeline.durationMs, 300, "Figma states transition duration in seconds");
  assert.equal(timeline.transition.type, "PUSH");
  assert.equal(timeline.origin, "rest-prototype");
  assert.equal(timeline.destinationFrameId, "1:2");
  assert.deepEqual(timeline.nodes.map((entry) => entry.nodeId), ["1:2", "1:1"]);

  const arriving = timeline.nodes[0].tracks[0];
  assert.equal(arriving.property, "x");
  assert.deepEqual(arriving.keyframes.map((key) => key.value), [400, 0], "it arrives from one frame width away");
  assert.deepEqual(arriving.keyframes[0].easing, { kind: "preset", name: "EASE_OUT" });
});

test("a Dissolve fades the destination up", () => {
  const source = node("2:1", "A", { sourceData: interaction("2:2", { type: "DISSOLVE", duration: 0.2, easing: { type: "LINEAR" } }) });
  const [timeline] = collectPrototypeTimelines(doc([source, node("2:2", "B")]));

  const [track] = timeline.nodes[0].tracks;
  assert.equal(track.property, "opacity");
  assert.deepEqual(track.keyframes.map((key) => key.value), [0, 1]);
});

/** No motion exists, so none is invented — but the navigation still reaches the report. */
test("an Instant transition produces a timeline with no tracks", () => {
  const source = node("3:1", "A", { sourceData: interaction("3:2", { type: "INSTANT", duration: 0 }) });
  const [timeline] = collectPrototypeTimelines(doc([source, node("3:2", "B")]));

  assert.equal(timeline.transition.type, "INSTANT");
  assert.deepEqual(timeline.nodes, []);
});

/** The older per-node fields state duration in milliseconds, not seconds. */
test("legacy transition fields are read without a thousand-fold timing error", () => {
  const source = node("4:1", "A", {
    sourceData: { transitionNodeID: "4:2", transitionDuration: 450, transitionEasing: "EASE_IN_AND_OUT" }
  });
  const [timeline] = collectPrototypeTimelines(doc([source, node("4:2", "B")]));

  assert.equal(timeline.durationMs, 450);
  assert.deepEqual(timeline.transition.easing, { kind: "preset", name: "EASE_IN_AND_OUT" });
});

test("a custom bezier and a spring keep their parameters instead of collapsing to a name", () => {
  const bezier = node("5:1", "A", {
    sourceData: interaction("5:2", {
      type: "SMART_ANIMATE", duration: 0.4,
      easing: { type: "CUSTOM_CUBIC_BEZIER", easingFunctionCubicBezier: { x1: 0.2, y1: 0, x2: 0.8, y2: 1 } }
    })
  });
  const [first] = collectPrototypeTimelines(doc([bezier, node("5:2", "B")]));
  assert.deepEqual(first.transition.easing, { kind: "cubic-bezier", points: [0.2, 0, 0.8, 1] });

  const spring = node("6:1", "A", {
    sourceData: interaction("6:2", {
      type: "SMART_ANIMATE", duration: 0.4,
      easing: { type: "CUSTOM_SPRING", easingFunctionSpring: { mass: 1, stiffness: 220, damping: 14 } }
    })
  });
  const [second] = collectPrototypeTimelines(doc([spring, node("6:2", "B")]));
  assert.deepEqual(second.transition.easing, { kind: "spring", mass: 1, stiffness: 220, damping: 14, initialVelocity: undefined });
});

/**
 * Smart Animate's whole meaning: the difference between the frames is the animation, and it is
 * recovered from data the REST API does return.
 */
test("Smart Animate diffs matched layers and writes tracks onto the destination node", () => {
  const source = node("7:1", "Home", {
    children: [node("7:10", "Card", { x: 0, y: 0, opacity: 1, width: 100 })]
  });
  const destination = node("7:2", "Details", {
    children: [node("7:20", "Card", { x: 120, y: 40, opacity: 0.5, width: 100 })]
  });

  const [motionNode] = smartAnimateNodes(source, destination, 300, { kind: "linear" });
  assert.equal(motionNode.nodeId, "7:20", "tracks belong to the destination layer");

  const byProperty = Object.fromEntries(motionNode.tracks.map((track) => [track.property, track.keyframes.map((k) => k.value)]));
  assert.deepEqual(byProperty.x, [0, 120]);
  assert.deepEqual(byProperty.y, [0, 40]);
  assert.deepEqual(byProperty.opacity, [1, 0.5]);
  assert.equal(byProperty.width, undefined, "an unchanged property produces no track");
});

/** Unanimatable changes still travel, so the compatibility report can name them. */
test("a size or fill change is reported rather than dropped at the diff", () => {
  const source = node("8:1", "A", { children: [node("8:10", "Box", { width: 100, fills: [{ kind: "solid", color: "#fff" }] })] });
  const destination = node("8:2", "B", { children: [node("8:20", "Box", { width: 220, fills: [{ kind: "solid", color: "#000" }] })] });

  const [motionNode] = smartAnimateNodes(source, destination, 300, { kind: "linear" });
  const properties = motionNode.tracks.map((track) => track.property);
  assert.ok(properties.includes("width"), "width is diffed even though nothing can play it");
  assert.ok(properties.includes("fill"), "so is paint");
});

/** Layers are matched by name path: two branches may each hold a "Title". */
test("layer matching uses the name path, not the bare name", () => {
  const source = node("9:1", "A", {
    children: [
      node("9:10", "Left", { children: [node("9:11", "Title", { x: 0 })] }),
      node("9:12", "Right", { children: [node("9:13", "Title", { x: 500 })] })
    ]
  });
  const destination = node("9:2", "B", {
    children: [
      node("9:20", "Left", { children: [node("9:21", "Title", { x: 30 })] }),
      node("9:22", "Right", { children: [node("9:23", "Title", { x: 470 })] })
    ]
  });

  const nodes = smartAnimateNodes(source, destination, 200, { kind: "linear" });
  const moves = Object.fromEntries(nodes.map((entry) => [entry.nodeId, entry.tracks[0].keyframes.map((k) => k.value)]));
  assert.deepEqual(moves["9:21"], [0, 30], "the left Title matched the left Title");
  assert.deepEqual(moves["9:23"], [500, 470], "and the right matched the right");
});

test("a destination outside the imported selection is reported, not silently skipped", () => {
  const report = { issues: [], counts: {} };
  const source = node("10:1", "A", { sourceData: interaction("10:99", { type: "DISSOLVE", duration: 0.2 }) });
  const [timeline] = collectPrototypeTimelines(doc([source]), report);

  assert.deepEqual(timeline.nodes, []);
  assert.equal(report.issues.length, 1);
  assert.match(report.issues[0].message, /was not imported/);
});

/**
 * The whole chain, through the real manager: REST JSON carrying an interaction → normalized
 * document → scenes → motion applied. Unit tests cover each stage; this is the one that catches
 * the wiring between them, which is where an import silently produces no motion at all.
 */
test("a REST import with motion enabled lands editable keyframes on the scene", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = (await import("node:path")).default;

  const dataRoot = await mkdtemp(path.join(tmpdir(), "grapix-figma-motion-"));
  process.env.GRAPIX_DATA_ROOT = dataRoot;
  const { DesignImportManager } = await import(`../dist/importers/design/designImportManager.js?root=${encodeURIComponent(dataRoot)}`);

  const frame = (id, name, x) => ({
    id, name, type: "FRAME",
    absoluteBoundingBox: { x, y: 0, width: 400, height: 300 },
    fills: [], children: [{
      id: `${id}:child`, name: "Card", type: "RECTANGLE",
      absoluteBoundingBox: { x: x + (id === "1:1" ? 0 : 80), y: 0, width: 100, height: 50 },
      fills: []
    }]
  });
  const source = frame("1:1", "Home", 0);
  source.interactions = [{
    trigger: { type: "ON_CLICK" },
    actions: [{ type: "NODE", destinationId: "1:2", transition: { type: "SMART_ANIMATE", duration: 0.4, easing: { type: "EASE_OUT" } } }]
  }];

  const fetchImpl = async () => new Response(
    JSON.stringify({ name: "Kit", nodes: { "1:1": { document: source }, "1:2": { document: frame("1:2", "Details", 0) } } }),
    { status: 200, headers: { "content-type": "application/json" } }
  );

  try {
    const result = await new DesignImportManager().importFigma(
      {
        url: "https://www.figma.com/design/abc123DEF456ghi789JK/Kit?node-id=1-1,1-2",
        transport: "rest",
        accessToken: "figd_test",
        motionMode: "design-and-prototype-motion"
      },
      { assetMode: "link" },
      { fetchImpl }
    );

    assert.ok(result.motion, "a motion import must return a motion report");
    assert.ok(result.motion.timelines >= 1, "the interaction became a timeline");

    const animated = result.scenes.flatMap((scene) => scene.objects).filter((object) => object.animation);
    assert.ok(animated.length > 0, "Smart Animate produced editable keyframes on a real object");
    assert.ok(result.motion.keyframesCreated > 0);

    // Design import is unaffected: the layers still arrived.
    assert.ok(result.scenes.length > 0);
    assert.equal(result.report.errors.length, 0);
  } finally {
    delete process.env.GRAPIX_DATA_ROOT;
    await rm(dataRoot, { recursive: true, force: true });
  }
});
