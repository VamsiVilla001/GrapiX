import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PlayoutRuntime } from "../dist/runtime.js";
import { PlayoutStore } from "../dist/store.js";

test("Cue drives Preview without mutating Program; Take promotes only the selected item", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "grapix-playout-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new PlayoutStore(root);
  const renderer = new FakeRenderer();
  const runtime = new PlayoutRuntime(store, renderer);

  await store.publishScene(sceneFixture());
  const rundown = await store.createRundown("Morning");
  const item = {
    itemId: "item_headline",
    sceneId: "scene_headline",
    sceneVersion: 1,
    versionPolicy: "pinned",
    name: "Headline",
    pageNumber: "101",
    segmentId: rundown.segments[0].segmentId,
    layer: "Lower Third",
    channel: "A",
    output: "Program",
    transitionIn: { type: "cut", durationFrames: 0, delayFrames: 0 },
    transitionOut: { type: "cut", durationFrames: 0, delayFrames: 0 },
    instanceData: {},
    notes: "",
    color: "#4077b8",
    cuePolicy: "manual",
    automationEnabled: false,
    completed: false
  };
  const saved = await store.saveRundown({ ...rundown, items: [item] });

  const previewStatus = await runtime.cue(saved.rundownId, item.itemId);
  assert.equal(previewStatus.previewItemId, item.itemId);
  assert.equal(previewStatus.programItemId, null);
  assert.equal(previewStatus.itemStates[item.itemId], "IN_PREVIEW");
  assert.deepEqual(renderer.actions, [
    ["load", "scene_headline"],
    ["preview", "scene_headline"]
  ]);

  const programStatus = await runtime.take(saved.rundownId, item.itemId);
  assert.equal(programStatus.previewItemId, item.itemId);
  assert.equal(programStatus.programItemId, item.itemId);
  assert.equal(programStatus.itemStates[item.itemId], "ONLINE");
  assert.deepEqual(renderer.actions.at(-1), ["take", "scene_headline"]);
});

class FakeRenderer {
  actions = [];
  async loadScene(scene) {
    this.actions.push(["load", scene.id]);
    return ack("scene.load");
  }
  async setPreview(sceneId) {
    this.actions.push(["preview", sceneId]);
    return ack("channel.preview.set");
  }
  async take(sceneId) {
    this.actions.push(["take", sceneId]);
    return ack("channel.take");
  }
  async heartbeat() {
    return ack("heartbeat");
  }
  close() {}
}

function ack(requestType) {
  return {
    type: "ack",
    protocolVersion: 2,
    requestType,
    requestId: "test",
    sequence: 1
  };
}

function sceneFixture() {
  const now = "2026-07-28T10:00:00.000Z";
  return {
    id: "scene_headline",
    name: "Headline",
    version: 1,
    canvas: { width: 1920, height: 1080, background: "#00000000" },
    dataContext: {},
    assets: [],
    materials: [],
    objects: [],
    timeline: { fps: 50, durationFrames: 250, keyframes: [] },
    createdAt: now,
    updatedAt: now
  };
}
