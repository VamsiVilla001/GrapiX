import assert from "node:assert/strict";
import test from "node:test";

import {
  RENDERER_PROTOCOL_VERSION,
  createRendererCommand,
  isRendererEvent,
  isRendererReply
} from "../dist/index.js";

test("creates a versioned and correlated renderer command", () => {
  assert.deepEqual(
    createRendererCommand(
      { type: "status" },
      { requestId: "req_7", sequence: 7, timestampMs: 1234 }
    ),
    {
      type: "status",
      protocolVersion: RENDERER_PROTOCOL_VERSION,
      requestId: "req_7",
      sequence: 7,
      timestampMs: 1234,
      expectedRendererState: "any",
      sceneId: null,
      sceneRevision: null,
      channel: null
    }
  );
});

test("creates a revision-safe small data patch", () => {
  const command = createRendererCommand(
    {
      type: "scene.patch",
      patch: {
        type: "PATCH_DATA_CONTEXT",
        sceneId: "scene_1",
        path: "player.name",
        value: "Vamsi"
      },
      nextSceneRevision: "r2"
    },
    {
      requestId: "req_9",
      sequence: 9,
      timestampMs: 1236,
      sceneId: "scene_1",
      sceneRevision: "r1"
    }
  );
  assert.equal(command.sceneRevision, "r1");
  assert.equal(command.nextSceneRevision, "r2");
});

test("recognizes sequenced server events", () => {
  assert.equal(isRendererEvent({
    type: "event",
    protocolVersion: 2,
    eventType: "channel.changed",
    eventSequence: 3,
    timestampMs: 1234,
    payload: { channel: "program" }
  }), true);
  assert.equal(isRendererEvent({
    type: "event",
    protocolVersion: 2,
    eventType: "channel.changed",
    eventSequence: 0,
    timestampMs: 1234,
    payload: {}
  }), false);
});

test("rejects an empty request id", () => {
  assert.throws(
    () => createRendererCommand({ type: "status" }, { requestId: "  ", sequence: 1 }),
    /requestId/
  );
});

test("derives scene identity and revision from a scene command", () => {
  const scene = {
    id: "scene_1",
    updatedAt: "2026-07-25T00:00:00.000Z"
  };
  const command = createRendererCommand(
    { type: "scene.load", scene },
    { requestId: "req_8", sequence: 8, timestampMs: 1235 }
  );

  assert.equal(command.sceneId, scene.id);
  assert.equal(command.sceneRevision, scene.updatedAt);
});

test("recognizes success and error replies for the current protocol", () => {
  assert.equal(isRendererReply({
    type: "ack",
    protocolVersion: 2,
    requestType: "scene.load",
    requestId: "req_1",
    sequence: 1
  }), true);
  assert.equal(isRendererReply({
    type: "error",
    protocolVersion: 2,
    code: "INVALID_SCENE",
    message: "bad scene"
  }), true);
  assert.equal(isRendererReply({
    type: "ack",
    protocolVersion: 1,
    requestType: "scene.load",
    requestId: "req_1",
    sequence: 1
  }), false);
});
