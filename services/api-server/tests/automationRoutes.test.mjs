import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

test("stores multi-sequence rundowns and evaluates conditional scene/rundown events", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "grapix-automation-test-"));
  process.env.GRAPIX_DATA_ROOT = root;
  const { createApiServer } = await import("../dist/index.js");
  const app = await createApiServer({ logger: false });
  context.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });

  const fontBytes = Buffer.alloc(16);
  fontBytes.writeUInt32BE(0x00010000, 0);
  const fontResponse = await app.inject({
    method: "POST",
    url: "/api/fonts/import?fileName=Score.ttf&family=Score%20Sans&weight=700",
    headers: { "content-type": "application/octet-stream" },
    payload: fontBytes
  });
  assert.equal(fontResponse.statusCode, 415);
  assert.equal(fontResponse.json().code, "FONT_INVALID");

  const adobeResponse = await app.inject({
    method: "POST",
    url: "/api/fonts/link",
    payload: { source: "adobe-fonts", family: "Acumin Pro", projectId: "abc123" }
  });
  assert.equal(adobeResponse.statusCode, 200);
  assert.equal(adobeResponse.json().font.faces[0].source.url, "https://use.typekit.net/abc123.css");

  const scriptResponse = await app.inject({
    method: "POST",
    url: "/api/import/scene-script?fileName=score.mjs&permissions=read-data,emit-event",
    headers: { "content-type": "application/octet-stream" },
    payload: Buffer.from("export default defineSceneScript({ apiVersion: 1, onEvent(api) { api.emit('ready'); } });")
  });
  assert.equal(scriptResponse.statusCode, 200);
  assert.equal(scriptResponse.json().script.execution, "control-sandbox");

  const timestamp = "2026-07-25T00:00:00.000Z";
  const scene = {
    id: "score_scene",
    name: "Score",
    version: 1,
    canvas: { width: 1920, height: 1080, background: "#000000" },
    dataContext: { score: { home: 12 } },
    assets: [],
    materials: [],
    objects: [{
      id: "plate",
      name: "Plate",
      type: "rect",
      x: 0, y: 0, zDepth: 0, zIndex: 0, layerId: "main",
      width: 100, height: 100, rotation: 0, opacity: 1,
      visible: true, locked: false, fill: "#fff", stroke: "#000",
      strokeWidth: 0, bindings: {}, materialSlots: {}, radius: 0
    }],
    timeline: { fps: 50, durationFrames: 250, keyframes: [] },
    automation: {
      version: 1,
      transitions: [],
      triggers: [{
        triggerId: "scene_score_trigger",
        name: "Take at twelve",
        enabled: true,
        event: { type: "data-change", name: "score.changed" },
        condition: {
          kind: "compare",
          left: { source: "scene-data", path: "score.home" },
          operator: "gte",
          right: { source: "literal", value: 10 }
        },
        actions: [{ type: "take-scene", sceneId: "score_scene" }],
        priority: 1
      }]
    },
    createdAt: timestamp,
    updatedAt: timestamp
  };
  assert.equal((await app.inject({ method: "POST", url: "/api/scenes", payload: scene })).statusCode, 200);

  const rundown = {
    rundownId: "game_day",
    name: "Game day",
    version: 1,
    activeSequenceId: "main",
    variables: { period: 2 },
    sequences: [{
      sequenceId: "main",
      name: "Main",
      fps: 50,
      durationFrames: 1000,
      tracks: [{
        trackId: "program",
        name: "Program",
        role: "program",
        enabled: true,
        cues: [{
          cueId: "score_cue",
          name: "Score",
          sceneId: "score_scene",
          startFrame: 0,
          durationFrames: 250,
          prewarmFrames: 50,
          autoTake: false
        }]
      }],
      transitions: [],
      triggers: [{
        triggerId: "period_trigger",
        name: "Period two",
        enabled: true,
        event: { type: "api", name: "period.ready" },
        condition: {
          kind: "compare",
          left: { source: "rundown-variable", path: "period" },
          operator: "eq",
          right: { source: "literal", value: 2 }
        },
        actions: [{ type: "preview-scene", sceneId: "score_scene" }],
        priority: 5
      }]
    }],
    createdAt: timestamp,
    updatedAt: timestamp
  };
  const saved = await app.inject({ method: "POST", url: "/api/rundowns", payload: rundown });
  assert.equal(saved.statusCode, 200);

  const rundownEvent = await app.inject({
    method: "POST",
    url: "/api/rundowns/game_day/events",
    payload: {
      event: { type: "api", name: "period.ready", timestampMs: 1000, payload: {} }
    }
  });
  assert.equal(rundownEvent.statusCode, 200);
  assert.deepEqual(rundownEvent.json().evaluation.actions, [{ type: "preview-scene", sceneId: "score_scene" }]);
  assert.equal(rundownEvent.json().dryRun, true);

  const sceneEvent = await app.inject({
    method: "POST",
    url: "/api/scenes/score_scene/events",
    payload: {
      event: { type: "data-change", name: "score.changed", timestampMs: 2000, payload: {} }
    }
  });
  assert.equal(sceneEvent.statusCode, 200);
  assert.deepEqual(sceneEvent.json().evaluation.actions, [{ type: "take-scene", sceneId: "score_scene" }]);
});
