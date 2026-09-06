import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

/**
 * Motion on the file-upload route.
 *
 * The bridge's output is a file the author downloads, so the import path that takes files has to
 * be able to consume it — a motion path that existed only on the Figma link route would refuse the
 * bridge's own manifest whenever the design arrived as exported JSON.
 *
 * Only `importFile` is exercised here. Its HTTP route can carry the mode but not a manifest: the
 * request body is the design's raw bytes, leaving nowhere for a second file. In-process callers
 * (the desktop shells, the MCP server) have no such limit, which is why the manager takes it.
 */
async function withImportManager(run) {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "grapix-motion-file-"));
  process.env.GRAPIX_DATA_ROOT = dataRoot;
  const module = await import(`../dist/importers/design/designImportManager.js?root=${encodeURIComponent(dataRoot)}`);
  try {
    await run(new module.DesignImportManager(), module);
  } finally {
    delete process.env.GRAPIX_DATA_ROOT;
    await rm(dataRoot, { recursive: true, force: true });
  }
}

/** An exported Figma document with one rectangle, at a position an offset track can resolve against. */
function exportedFigmaJson() {
  return Buffer.from(JSON.stringify({
    name: "Lower Third",
    document: {
      id: "0:0",
      type: "DOCUMENT",
      children: [{
        id: "0:1",
        name: "Page 1",
        type: "CANVAS",
        children: [{
          id: "1:1",
          name: "Bar",
          type: "RECTANGLE",
          absoluteBoundingBox: { x: 240, y: 800, width: 900, height: 120 },
          fills: [{ type: "SOLID", visible: true, color: { r: 0.1, g: 0.2, b: 0.4, a: 1 } }]
        }]
      }]
    }
  }));
}

function bridgeManifest() {
  return {
    version: 1,
    generator: "grapix-figma-motion-bridge/1.0.0",
    fileName: "Lower Third",
    exportedAt: "2026-08-06T00:00:00.000Z",
    timelines: [{
      id: "frame_0:1",
      name: "Lower Third",
      durationMs: 400,
      origin: "bridge-export",
      nodes: [{
        nodeId: "1:1",
        name: "Bar",
        tracks: [
          {
            property: "x",
            sourceField: "TRANSLATION_XY",
            valueSpace: "offset",
            keyframes: [{ timeMs: 0, value: -900 }, { timeMs: 400, value: 0 }]
          },
          {
            // No GrapiX channel: carried, reported, never authored.
            property: "cornerRadius",
            sourceField: "CORNER_RADIUS",
            keyframes: [{ timeMs: 0, value: 0 }, { timeMs: 400, value: 12 }]
          }
        ]
      }]
    }]
  };
}

test("a file import with no motion argument is unchanged", async () => {
  await withImportManager(async (manager) => {
    const result = await manager.importFile(exportedFigmaJson(), "lower-third.figma.json");

    assert.equal(result.motion, undefined, "design-only stays the default for an existing caller");
    for (const scene of result.scenes) {
      for (const object of scene.objects) {
        assert.ok(!object.animation || Object.keys(object.animation).length === 0);
      }
    }
  });
});

test("a bridge manifest on the file route writes keyframes and reports what it could not", async () => {
  await withImportManager(async (manager) => {
    const result = await manager.importFile(
      exportedFigmaJson(),
      "lower-third.figma.json",
      {},
      { motionMode: "full-motion-manifest", motionManifest: bridgeManifest() }
    );

    assert.ok(result.motion, "the motion report reaches the caller");
    assert.equal(result.motion.matchedNodes, 1);
    assert.deepEqual(result.motion.missingNodes, []);

    const bar = result.scenes.flatMap((scene) => scene.objects)
      .find((object) => object.importedDesign?.sourceNodeId === "1:1");
    assert.ok(bar, "the imported object carries the Figma node id the manifest keys on");

    // The offset resolved against the layer's own x, so the bar slides in and lands where the
    // design puts it rather than at the canvas origin.
    const keys = bar.animation.x.keys;
    assert.equal(keys.length, 2);
    assert.equal(keys[1].value, bar.x);
    assert.ok(keys[0].value < keys[1].value);

    // The unsupported track is named and keeps its data, rather than being written somewhere
    // plausible or silently dropped.
    const radius = result.motion.entries.find((entry) => entry.property === "cornerRadius");
    assert.equal(radius.compatibility, "unsupported");
    assert.equal(radius.keyframesCreated, 0);
    assert.ok(radius.original, "the source track travels with the report entry");
  });
});

test("asking for a manifest without supplying one warns instead of failing", async () => {
  await withImportManager(async (manager) => {
    const result = await manager.importFile(
      exportedFigmaJson(),
      "lower-third.figma.json",
      {},
      { motionMode: "full-motion-manifest" }
    );

    // The design still lands. Only the motion is absent, and the report says why.
    assert.ok(result.scenes.length >= 1);
    assert.ok(result.report.warnings.some((message) => message.includes("Full motion manifest was requested")));
  });
});

test("an unknown motion mode is refused rather than silently treated as design-only", async () => {
  await withImportManager(async (_manager, module) => {
    // A caller that misspells the mode is asking for motion. Defaulting would give them a
    // design-only import with nothing to explain it.
    assert.equal(module.parseMotionMode(undefined), undefined);
    assert.equal(module.parseMotionMode("full-motion-manifest"), "full-motion-manifest");
    assert.throws(() => module.parseMotionMode("full-motion"), /Unknown motion mode/);
  });
});
