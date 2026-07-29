import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PlayoutStore } from "../dist/store.js";

test("publishes immutable monotonic scene versions and restores them after restart", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "grapix-playout-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const firstStore = new PlayoutStore(root);
  const firstScene = sceneFixture("scene_news", "2026-07-28T10:00:00.000Z");

  const first = await firstStore.publishScene(firstScene, { tags: ["news"] });
  const second = await firstStore.publishScene(
    { ...firstScene, name: "News Lower Third v2", updatedAt: "2026-07-28T10:01:00.000Z" },
    { tags: ["news", "lower-third"] }
  );

  assert.equal(first.version, 1);
  assert.equal(second.version, 2);
  assert.notEqual(first.packageChecksum, second.packageChecksum);

  const restartedStore = new PlayoutStore(root);
  const restoredFirst = await restartedStore.readScene("scene_news", 1);
  const restoredLatest = await restartedStore.readScene("scene_news");
  assert.equal(restoredFirst?.scene.name, "News Lower Third");
  assert.equal(restoredLatest?.scene.name, "News Lower Third v2");
  assert.deepEqual(
    (await restartedStore.listScenes()).map((entry) => entry.version),
    [2, 1]
  );
});

test("atomically autosaves rundown revisions and validates segment ownership", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "grapix-playout-rundown-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new PlayoutStore(root);
  const created = await store.createRundown("Election Night");
  const segmentId = created.segments[0].segmentId;

  const saved = await store.saveRundown({
    ...created,
    items: [
      {
        itemId: "item_open",
        sceneId: "scene_news",
        sceneVersion: 1,
        versionPolicy: "pinned",
        name: "Open",
        pageNumber: "100",
        segmentId,
        layer: "Fullscreen",
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
      }
    ]
  });

  assert.equal(saved.revision, 2);
  const onDisk = JSON.parse(
    await readFile(path.join(root, "rundowns", `${created.rundownId}.json`), "utf8")
  );
  assert.equal(onDisk.items[0].pageNumber, "100");

  await assert.rejects(
    store.saveRundown({
      ...saved,
      items: [{ ...saved.items[0], segmentId: "missing_segment" }]
    }),
    /missing segment/
  );
});

function sceneFixture(id, updatedAt) {
  return {
    id,
    name: "News Lower Third",
    version: 1,
    canvas: { width: 1920, height: 1080, background: "#00000000" },
    dataContext: {},
    assets: [],
    materials: [],
    objects: [],
    timeline: { fps: 50, durationFrames: 250, keyframes: [] },
    createdAt: updatedAt,
    updatedAt
  };
}
