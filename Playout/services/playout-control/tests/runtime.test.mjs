import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PlayoutRuntime } from "../dist/runtime.js";
import { PlayoutStore } from "../dist/store.js";

/** Publish a scene and put one entry in a take list. Returns both ways to address it. */
async function seed(store, { refuseTake = null, connected = true } = {}) {
  const published = await store.publishScene(sceneFixture());
  const created = await store.createTakeList("Morning");
  const entry = entryFixture("entry_headline");
  const takeList = await store.saveTakeList({
    ...created,
    entries: [entry],
    cursorEntryId: entry.entryId
  });
  const engine = new FakeEngineSupervisor({ refuseTake, connected });
  return {
    engine,
    runtime: new PlayoutRuntime(store, engine),
    takeList,
    entryTarget: { kind: "entry", takeListId: takeList.takeListId, entryId: entry.entryId },
    sceneTarget: { kind: "scene", takeId: published.takeId },
    takeId: published.takeId
  };
}

test("Cue drives Preview without mutating Program; Take promotes only the selected take", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "grapix-playout-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { runtime, engine, entryTarget } = await seed(new PlayoutStore(root));

  const previewStatus = await runtime.cue(entryTarget);
  assert.equal(previewStatus.previewRef, "entry_headline");
  assert.equal(previewStatus.programRef, null);
  assert.equal(previewStatus.takeStates.entry_headline, "IN_PREVIEW");
  assert.deepEqual(engine.actions, [
    ["load", "scene_headline"],
    ["prepare", "scene_headline"],
    ["cue", "scene_headline", "preview"]
  ]);

  const programStatus = await runtime.take(entryTarget);
  assert.equal(programStatus.previewRef, "entry_headline");
  assert.equal(programStatus.programRef, "entry_headline");
  assert.equal(programStatus.takeStates.entry_headline, "ONLINE");
  assert.deepEqual(engine.actions.at(-1), ["takeOnline", "scene_headline"]);
});

test("a Scene Manager take ID goes to air with no take list involved", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "grapix-playout-recall-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { runtime, engine, sceneTarget, takeId } = await seed(new PlayoutStore(root));

  const status = await runtime.take(sceneTarget);

  // Tracked under a scene ref, not a borrowed entry id: the take list must not highlight a
  // row that is not what is on air.
  assert.equal(status.programRef, `scene:take-${takeId}`);
  assert.equal(status.takeStates[`scene:take-${takeId}`], "ONLINE");
  assert.equal(status.takeStates.entry_headline, undefined);
  assert.deepEqual(engine.actions.at(-1), ["takeOnline", "scene_headline"]);
});

test("an unknown take ID is refused rather than airing something else", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "grapix-playout-unknown-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { runtime, engine } = await seed(new PlayoutStore(root));

  await assert.rejects(
    () => runtime.take({ kind: "scene", takeId: 999 }),
    /no published scene has take ID 999/
  );
  assert.equal(runtime.getStatus().programRef, null);
  assert.deepEqual(engine.actions, [], "nothing reached the engine");
});

test("Take Out clears Program through the engine", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "grapix-playout-takeout-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { runtime, engine, entryTarget } = await seed(new PlayoutStore(root));

  await runtime.take(entryTarget);
  const status = await runtime.takeOut();

  assert.equal(status.programRef, null);
  assert.equal(status.takeStates.entry_headline, "OFFLINE");
  assert.deepEqual(engine.actions.at(-1), ["clear", "program"]);

  // Clearing an already-clear Program is a no-op, not an error.
  const again = await runtime.takeOut();
  assert.equal(again.programRef, null);
});

test("Continue advances the cursor and stops at the end of the list", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "grapix-playout-continue-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new PlayoutStore(root);
  const { runtime, takeList } = await seed(store);

  const withSecond = await store.saveTakeList({
    ...takeList,
    entries: [...takeList.entries, entryFixture("entry_second")],
    cursorEntryId: "entry_headline"
  });

  const afterFirst = await runtime.advanceCursor(withSecond.takeListId);
  assert.equal(afterFirst?.cursorEntryId, "entry_second");

  // Past the last entry the cursor clears rather than wrapping: a running order that silently
  // looped would re-air the top of the show.
  const afterSecond = await runtime.advanceCursor(withSecond.takeListId);
  assert.equal(afterSecond?.cursorEntryId, null);

  assert.equal(await runtime.advanceCursor("takelist_missing"), null);
});

test("a refused take leaves Program alone and surfaces the engine's reason", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "grapix-playout-refusal-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { runtime, entryTarget } = await seed(new PlayoutStore(root), {
    refuseTake: "output lease held elsewhere"
  });

  await assert.rejects(() => runtime.take(entryTarget), /output lease held elsewhere/);
  const status = runtime.getStatus();
  assert.equal(status.programRef, null);
  assert.equal(status.takeStates.entry_headline, "ERROR");
});

test("a disconnected engine is reported rather than worked around", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "grapix-playout-offline-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { runtime, engine, entryTarget } = await seed(new PlayoutStore(root), {
    connected: false
  });

  await assert.rejects(() => runtime.cue(entryTarget), /not connected/);
  assert.deepEqual(engine.actions, []);
  assert.equal(runtime.getStatus().rendererConnection, "error");
});

/**
 * Stands in for `EngineSupervisor`. Records the verbs the runtime issues, in order, so a
 * regression that cues before preparing — or takes without cueing — is visible rather than
 * merely still green.
 */
class FakeEngineSupervisor {
  actions = [];

  constructor({ connected = true, refuseTake = null } = {}) {
    this.connected = connected;
    this.refuseTake = refuseTake;
  }

  get id() {
    return "playout-engine";
  }

  status() {
    return { connected: this.connected, lastError: this.connected ? null : "no engine" };
  }

  async connect() {
    return this.connected;
  }

  requireConnected() {
    if (!this.connected) {
      throw new Error("render engine is not connected at 127.0.0.1:4400");
    }
    return {
      load: async (_engineId, scene) => {
        this.actions.push(["load", scene.id]);
      },
      prepare: async (_engineId, sceneId) => {
        this.actions.push(["prepare", sceneId]);
      },
      cue: async (_engineId, sceneId, _revision, channel) => {
        this.actions.push(["cue", sceneId, channel]);
      },
      takeOnline: async (_engineId, sceneId) => {
        this.actions.push(["takeOnline", sceneId]);
        return this.refuseTake
          ? { accepted: false, refusedReason: this.refuseTake }
          : { accepted: true };
      },
      clear: async (_engineId, channel) => {
        this.actions.push(["clear", channel]);
      }
    };
  }

  close() {}
}

function entryFixture(entryId) {
  return {
    entryId,
    sceneId: "scene_headline",
    sceneVersion: 1,
    versionPolicy: "pinned",
    name: "Headline",
    layer: "Lower Third",
    transitionIn: { type: "cut", durationFrames: 0, delayFrames: 0 },
    transitionOut: { type: "cut", durationFrames: 0, delayFrames: 0 },
    instanceData: {},
    notes: "",
    color: "#4077b8",
    completed: false
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
