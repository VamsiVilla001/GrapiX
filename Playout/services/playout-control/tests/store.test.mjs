import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PlayoutStore } from "../dist/store.js";

test("Editor sync forwards the authenticated operator token to every protected scene request", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "grapix-playout-sync-auth-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const seen = [];
  globalThis.fetch = async (input, init) => {
    seen.push(new Headers(init?.headers).get("authorization"));
    const url = String(input);
    if (url.endsWith("/api/scenes")) {
      return Response.json({
        scenes: [{ id: "scene_synced", name: "Synced", updatedAt: "2026-08-22T10:00:00.000Z" }]
      });
    }
    if (url.endsWith("/api/scenes/scene_synced")) {
      return Response.json({ scene: sceneFixture("scene_synced", "2026-08-22T10:00:00.000Z") });
    }
    return new Response(null, { status: 404 });
  };

  const result = await new PlayoutStore(root).syncFromEditor(
    "http://127.0.0.1:4100",
    "operator-access-token"
  );

  assert.equal(result.syncedCount, 1);
  assert.deepEqual(seen, ["Bearer operator-access-token", "Bearer operator-access-token"]);
});

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

  // The Scene Manager recall number must survive a republish: an operator who rehearsed
  // "take 101" cannot have it move because a designer published v2 mid-show.
  assert.equal(first.takeId, 101);
  assert.equal(second.takeId, 101, "republishing must not reassign the take ID");

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

test("take IDs are assigned from 101 and are unique per scene", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "grapix-playout-takeids-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new PlayoutStore(root);

  const a = await store.publishScene(sceneFixture("scene_a", "2026-07-28T10:00:00.000Z"));
  const b = await store.publishScene(sceneFixture("scene_b", "2026-07-28T10:00:00.000Z"));
  const c = await store.publishScene(sceneFixture("scene_c", "2026-07-28T10:00:00.000Z"));

  // Three digits with a gap below, the way an XPression operator expects.
  assert.deepEqual([a.takeId, b.takeId, c.takeId], [101, 102, 103]);

  // Recall by take ID finds the scene, and the newest version of it.
  await store.publishScene(
    { ...sceneFixture("scene_b", "2026-07-28T11:00:00.000Z"), name: "B v2" }
  );
  const recalled = await store.readSceneByTakeId(102);
  assert.equal(recalled?.sceneId, "scene_b");
  assert.equal(recalled?.version, 2, "a recall means the current version");

  assert.equal(await store.readSceneByTakeId(999), null);
});

test("autosaves a take list and keeps its cursor honest", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "grapix-playout-takelist-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new PlayoutStore(root);
  const created = await store.createTakeList("Election Night");

  assert.deepEqual(created.entries, []);
  assert.equal(created.cursorEntryId, null, "an empty list has nothing to take");

  const saved = await store.saveTakeList({
    ...created,
    entries: [entryFixture("entry_open"), entryFixture("entry_close")],
    cursorEntryId: "entry_open"
  });

  assert.equal(saved.entries.length, 2);
  assert.equal(saved.cursorEntryId, "entry_open");
  const onDisk = JSON.parse(
    await readFile(path.join(root, "take-lists", `${created.takeListId}.json`), "utf8")
  );
  assert.equal(onDisk.entries[0].entryId, "entry_open");
  // A take list is working state, not a publication: no revision counter to drift.
  assert.equal(onDisk.revision, undefined);

  // A cursor pointing at an entry that does not exist would leave Take In with nothing to
  // act on while the UI highlighted a row.
  await assert.rejects(
    store.saveTakeList({ ...saved, cursorEntryId: "entry_gone" }),
    /cursor references a missing entry/
  );

  await assert.rejects(
    store.saveTakeList({
      ...saved,
      entries: [entryFixture("entry_open"), entryFixture("entry_open")]
    }),
    /duplicate entry IDs/
  );

  await assert.rejects(
    store.saveTakeList({
      ...saved,
      entries: [{ ...entryFixture("entry_open"), sceneVersion: 0 }],
      cursorEntryId: "entry_open"
    }),
    /invalid scene version/
  );
});

test("a scene published before take IDs existed is backfilled, not left undefined", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "grapix-playout-backfill-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new PlayoutStore(root);

  // Publish twice, then strip the take IDs the way older on-disk data has them.
  await store.publishScene(sceneFixture("scene_legacy", "2026-07-28T10:00:00.000Z"));
  await store.publishScene(
    { ...sceneFixture("scene_legacy", "2026-07-28T11:00:00.000Z"), name: "Legacy v2" }
  );
  const indexPath = path.join(root, "library", "index.json");
  const stripped = JSON.parse(await readFile(indexPath, "utf8"));
  for (const entry of stripped.scenes) delete entry.takeId;
  await writeFile(indexPath, JSON.stringify(stripped));

  // `takeId` is not optional on the contract, so reading must repair rather than surface
  // "take undefined" in the Scene Manager.
  const scenes = await new PlayoutStore(root).listScenes();
  assert.ok(
    scenes.every((entry) => Number.isSafeInteger(entry.takeId)),
    `every version needs a take ID, got ${JSON.stringify(scenes.map((s) => s.takeId))}`
  );
  // Every version of one scene shares its number.
  assert.equal(new Set(scenes.map((entry) => entry.takeId)).size, 1);

  // And the repair is persisted, not recomputed on every read.
  const onDisk = JSON.parse(await readFile(indexPath, "utf8"));
  assert.ok(onDisk.scenes.every((entry) => Number.isSafeInteger(entry.takeId)));

  // A backfilled ID is recallable like any other.
  const recalled = await store.readSceneByTakeId(scenes[0].takeId);
  assert.equal(recalled?.sceneId, "scene_legacy");
});

test("removing a scene takes every version and leaves other Take IDs alone", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "grapix-playout-remove-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new PlayoutStore(root);

  const keep = await store.publishScene(sceneFixture("scene_keep", "2026-07-28T10:00:00.000Z"));
  await store.publishScene(sceneFixture("scene_junk", "2026-07-28T10:01:00.000Z"));
  const junkV2 = await store.publishScene({
    ...sceneFixture("scene_junk", "2026-07-28T10:02:00.000Z"),
    name: "junk v2"
  });
  assert.equal(junkV2.version, 2);

  const removal = await store.removeScene("scene_junk");
  assert.equal(removal.versionsRemoved, 2, "both versions must go, not just the newest");
  assert.equal(removal.takeId, junkV2.takeId);

  const remaining = await store.listScenes();
  assert.deepEqual(remaining.map((entry) => entry.sceneId), ["scene_keep"]);
  assert.equal(await store.readScene("scene_junk"), null);

  // Take IDs are memorised by operators, so a removal must never renumber what is left.
  assert.equal(remaining[0].takeId, keep.takeId);
  assert.equal((await store.readSceneByTakeId(keep.takeId))?.sceneId, "scene_keep");

  // And the freed Take ID is not handed to the next publish.
  const next = await store.publishScene(sceneFixture("scene_new", "2026-07-28T10:03:00.000Z"));
  assert.notEqual(next.takeId, removal.takeId, "a removed Take ID must not be reissued");
});

test("removing a scene that is on air is refused", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "grapix-playout-remove-onair-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new PlayoutStore(root);
  await store.publishScene(sceneFixture("scene_live", "2026-07-28T10:00:00.000Z"));

  // Deleting what is transmitting would make Program fail mid-show, so this refuses rather
  // than asking.
  await assert.rejects(
    () => store.removeScene("scene_live", { onAirSceneIds: ["scene_live"] }),
    (error) => error.reason === "ON_AIR" && /on air/.test(error.message)
  );
  assert.equal((await store.listScenes()).length, 1);

  // Off air, it goes.
  await store.removeScene("scene_live", { onAirSceneIds: ["something_else"] });
  assert.equal((await store.listScenes()).length, 0);
});

test("removing a scene a take list still references is refused", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "grapix-playout-remove-ref-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new PlayoutStore(root);
  await store.publishScene(sceneFixture("scene_news", "2026-07-28T10:00:00.000Z"));

  const list = await store.createTakeList("Morning");
  const saved = await store.saveTakeList({
    ...list,
    cursorEntryId: "entry_open",
    entries: [entryFixture("entry_open")]
  });

  // A take-list entry is an operator's recall path; removing the scene under it would turn a
  // Take In into a missing-asset error.
  await assert.rejects(
    () => store.removeScene("scene_news"),
    (error) => error.reason === "REFERENCED" && error.message.includes(saved.takeListId)
  );

  // Archiving the list releases the hold: an archived list is history, not a recall path.
  await store.saveTakeList({ ...saved, archived: true });
  const removal = await store.removeScene("scene_news");
  assert.equal(removal.versionsRemoved, 1);
});
test("removing a referenced scene with force cleans up take list entries", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "grapix-playout-remove-force-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new PlayoutStore(root);
  await store.publishScene(sceneFixture("scene_news", "2026-07-28T10:00:00.000Z"));

  const list = await store.createTakeList("Morning");
  const saved = await store.saveTakeList({
    ...list,
    cursorEntryId: "entry_open",
    entries: [entryFixture("entry_open")]
  });

  // With force = true, referenced entries are removed from active take lists
  const removal = await store.removeScene("scene_news", { force: true });
  assert.equal(removal.versionsRemoved, 1);

  const updatedList = await store.readTakeList(saved.takeListId);
  assert.deepEqual(updatedList?.entries, []);
});

test("removing an unknown scene reports not found rather than succeeding quietly", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "grapix-playout-remove-missing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new PlayoutStore(root);

  await assert.rejects(
    () => store.removeScene("scene_absent"),
    (error) => error.reason === "NOT_FOUND"
  );
});

function entryFixture(entryId) {
  return {
    entryId,
    sceneId: "scene_news",
    sceneVersion: 1,
    versionPolicy: "pinned",
    name: "Open",
    layer: "Fullscreen",
    transitionIn: { type: "cut", durationFrames: 0, delayFrames: 0 },
    transitionOut: { type: "cut", durationFrames: 0, delayFrames: 0 },
    instanceData: {},
    notes: "",
    color: "#4077b8",
    completed: false
  };
}

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
