import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

function sceneDocument(overrides = {}) {
  return {
    version: 1,
    id: "010",
    name: "Lower Third",
    updatedAt: "2026-08-04T05:00:00.000Z",
    objects: [],
    assets: [],
    materials: [],
    ...overrides
  };
}

/**
 * One project path for the whole file, emptied before each test.
 *
 * `dist/storage.js` is re-imported per test behind a cache-busting query, but the
 * `projectWorkspace.js` it imports is not — so the module that remembers which project is open is
 * shared, and the first test to resolve it decides for every test after it. A per-test project
 * root would look isolated and quietly file every later snapshot under the first test's project,
 * which is how the ring test came to read an empty directory while its own assertions passed.
 *
 * Emptying rather than re-pathing is what keeps each test's ring its own: the path stays the one
 * `projectWorkspace` already resolved, and the folders are re-created on demand by the first write.
 */
const PROJECT_ROOT = path.join(tmpdir(), `grapix-autosave-project-${process.pid}`);

async function loadStorage(dataRoot) {
  process.env.GRAPIX_DATA_ROOT = dataRoot;
  process.env.GRAPIX_PROJECT_ROOT = PROJECT_ROOT;
  await rm(PROJECT_ROOT, { recursive: true, force: true });
  return import(`../dist/storage.js?root=${encodeURIComponent(dataRoot)}`);
}

/**
 * The revision on a snapshot is the recovery dialog's only way to warn that restoring one
 * would put superseded graphics to air, and it can only come from the service: `POST
 * /api/scenes` returns the new revision and no client reads it back, so a posted document
 * carries whatever revision it was loaded with — 0 for a scene that was never opened.
 * Trusting it filed every snapshot under revision 0 and turned the warning into a constant.
 */
test("an autosave records the stored scene's revision, not the posted document's", async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "grapix-autosave-"));
  const { autosaveScene, listSceneAutosaves, saveScene } = await loadStorage(dataRoot);

  try {
    await saveScene(sceneDocument());
    const saved = await saveScene(sceneDocument({ name: "Lower Third" }));
    assert.equal(saved.revision, 2, "two saves must leave the scene at revision 2");

    // A client that never learned the revision, and one that guesses: both must be ignored.
    const entry = await autosaveScene(sceneDocument({ revision: 99 }), 10);
    assert.equal(entry.revision, 2);

    const [listed] = await listSceneAutosaves("010");
    assert.equal(listed.revision, 2, "the index must hold the stamped revision too");
  } finally {
    delete process.env.GRAPIX_DATA_ROOT;
    delete process.env.GRAPIX_PROJECT_ROOT;
    await rm(dataRoot, { recursive: true, force: true });
    await rm(PROJECT_ROOT, { recursive: true, force: true });
  }
});

/**
 * The ring fills empty slots before it recycles, and recycles the oldest. Advancing past the
 * oldest slot instead would pin slot 1 forever, so the ring would keep its first snapshot and
 * silently discard newer ones.
 */
test("the autosave ring fills every slot before recycling the oldest", async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "grapix-autosave-ring-"));
  const { autosaveScene, listSceneAutosaves } = await loadStorage(dataRoot);

  try {
    const first = await autosaveScene(sceneDocument({ updatedAt: "2026-08-04T05:01:00.000Z" }), 2);
    const second = await autosaveScene(sceneDocument({ updatedAt: "2026-08-04T05:02:00.000Z" }), 2);
    assert.deepEqual([first.version, second.version], [1, 2]);

    const third = await autosaveScene(sceneDocument({ updatedAt: "2026-08-04T05:03:00.000Z" }), 2);
    assert.equal(third.version, 1, "the third snapshot must recycle the oldest slot");

    const entries = await listSceneAutosaves("010");
    assert.equal(entries.length, 2, "a cap of two must never hold three snapshots");
    assert.equal(entries[0].version, 1, "the list is newest first");

    const files = await readdir(path.join(PROJECT_ROOT, "Autosaves", "010"));
    assert.deepEqual(
      files.sort(),
      ["Lower Third autosave 1.json", "Lower Third autosave 2.json", "index.json"],
      "recycling must overwrite a slot rather than leak a file"
    );

    const restored = JSON.parse(
      await readFile(path.join(PROJECT_ROOT, "Autosaves", "010", "Lower Third autosave 1.json"), "utf8")
    );
    assert.equal(restored.updatedAt, "2026-08-04T05:03:00.000Z", "slot 1 must now hold the newest scene");
  } finally {
    delete process.env.GRAPIX_DATA_ROOT;
    delete process.env.GRAPIX_PROJECT_ROOT;
    await rm(dataRoot, { recursive: true, force: true });
    await rm(PROJECT_ROOT, { recursive: true, force: true });
  }
});

/** Snapshots live outside `scenes/`, or every scene picker would offer them — and publish one. */
test("an autosave never writes into the scene directory", async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "grapix-autosave-isolation-"));
  const { autosaveScene, listScenes } = await loadStorage(dataRoot);

  try {
    await autosaveScene(sceneDocument(), 5);
    assert.deepEqual(await listScenes(), [], "an autosave is not a scene");
    const sceneFiles = await readdir(path.join(PROJECT_ROOT, "Scenes")).catch(() => []);
    assert.deepEqual(sceneFiles, [], "Scenes/ must be absent or empty after an autosave");
  } finally {
    delete process.env.GRAPIX_DATA_ROOT;
    delete process.env.GRAPIX_PROJECT_ROOT;
    await rm(dataRoot, { recursive: true, force: true });
    await rm(PROJECT_ROOT, { recursive: true, force: true });
  }
});
