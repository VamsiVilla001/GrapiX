import assert from "node:assert/strict";
import test from "node:test";

import {
  applyScenePatch,
  checkSceneSeparation,
  compareRevisions,
  createScenePatch,
  evaluateRevision,
  isSceneTransportable,
  sanitizeSceneForEngine,
  SceneRevisionTracker,
  sceneRevision,
  shouldPreferFullSync
} from "../dist/index.js";

function baseScene(overrides = {}) {
  return {
    id: "scene_1",
    name: "Lower Third",
    version: 1,
    revision: 1,
    canvas: { width: 1920, height: 1080, background: "#000000" },
    dataContext: { player: { name: "Alice", score: 0 } },
    assets: [],
    materials: [],
    objects: [
      {
        id: "obj_a",
        name: "Title",
        type: "text",
        x: 100,
        y: 200,
        zDepth: 0,
        zIndex: 0,
        layerId: "layer_1",
        visible: true,
        text: "Hello"
      },
      {
        id: "obj_b",
        name: "Background",
        type: "rect",
        x: 0,
        y: 0,
        zDepth: 0,
        zIndex: 1,
        layerId: "layer_1",
        visible: true
      }
    ],
    timeline: { fps: 50, durationFrames: 100, keyframes: [] },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// Patch application
// ---------------------------------------------------------------------------

test("a transform patch advances the revision and leaves the input untouched", () => {
  const scene = baseScene();
  const patch = createScenePatch("scene_1", 1, [
    { type: "object.transform", objectId: "obj_a", transform: { x: 500, y: 250 } }
  ]);

  const result = applyScenePatch(scene, patch);
  assert.equal(result.applied, true);
  assert.equal(result.revision, 2);
  assert.equal(result.scene.objects[0].x, 500);
  assert.equal(result.scene.objects[0].y, 250);

  // Immutability: the caller's document is unchanged.
  assert.equal(scene.objects[0].x, 100);
  assert.equal(sceneRevision(scene), 1);
});

test("object create, delete, and reorder work", () => {
  let scene = baseScene();

  const created = applyScenePatch(
    scene,
    createScenePatch("scene_1", 1, [
      {
        type: "object.created",
        object: { id: "obj_c", name: "New", type: "ellipse", x: 0, y: 0, zDepth: 0, zIndex: 2, layerId: "layer_1", visible: true },
        index: 0
      }
    ])
  );
  assert.equal(created.applied, true);
  assert.deepEqual(created.scene.objects.map((o) => o.id), ["obj_c", "obj_a", "obj_b"]);
  scene = created.scene;

  const reordered = applyScenePatch(
    scene,
    createScenePatch("scene_1", 2, [
      { type: "layer.reorder", objectIds: ["obj_b", "obj_c", "obj_a"] }
    ])
  );
  assert.equal(reordered.applied, true);
  assert.deepEqual(reordered.scene.objects.map((o) => o.id), ["obj_b", "obj_c", "obj_a"]);
  scene = reordered.scene;

  const deleted = applyScenePatch(
    scene,
    createScenePatch("scene_1", 3, [{ type: "object.deleted", objectId: "obj_c" }])
  );
  assert.equal(deleted.applied, true);
  assert.deepEqual(deleted.scene.objects.map((o) => o.id), ["obj_b", "obj_a"]);
});

test("a reorder that is not a permutation is refused", () => {
  const scene = baseScene();

  const wrongCount = applyScenePatch(
    scene,
    createScenePatch("scene_1", 1, [{ type: "layer.reorder", objectIds: ["obj_a"] }])
  );
  assert.equal(wrongCount.applied, false);
  assert.equal(wrongCount.failure.code, "REORDER_MISMATCH");

  const unknownId = applyScenePatch(
    scene,
    createScenePatch("scene_1", 1, [{ type: "layer.reorder", objectIds: ["obj_a", "ghost"] }])
  );
  assert.equal(unknownId.applied, false);
  assert.equal(unknownId.failure.code, "REORDER_MISMATCH");
});

test("text, visibility, material, and data patches apply", () => {
  let scene = baseScene();

  scene = applyScenePatch(
    scene,
    createScenePatch("scene_1", 1, [
      { type: "object.text", objectId: "obj_a", text: "Goodbye" },
      { type: "object.visibility", objectId: "obj_b", visible: false },
      { type: "object.material", objectId: "obj_b", slot: "main", materialId: "mat_1" },
      { type: "dataContext.changed", path: "player.score", value: 42 }
    ])
  ).scene;

  assert.equal(scene.objects[0].text, "Goodbye");
  assert.equal(scene.objects[1].visible, false);
  assert.deepEqual(scene.objects[1].materialSlots, { main: "mat_1" });
  assert.equal(scene.dataContext.player.score, 42);

  // Unbinding removes the slot rather than storing null.
  const unbound = applyScenePatch(
    scene,
    createScenePatch("scene_1", 2, [
      { type: "object.material", objectId: "obj_b", slot: "main", materialId: null }
    ])
  );
  assert.deepEqual(unbound.scene.objects[1].materialSlots, {});
});

test("a text patch on a non-text object warns instead of corrupting it", () => {
  const result = applyScenePatch(
    baseScene(),
    createScenePatch("scene_1", 1, [{ type: "object.text", objectId: "obj_b", text: "nope" }])
  );

  assert.equal(result.applied, true);
  assert.equal(result.warnings.length, 1);
  assert.ok(result.warnings[0].includes("not text"));
  assert.equal(result.scene.objects[1].text, undefined);
});

test("nested data paths are created on demand", () => {
  const result = applyScenePatch(
    baseScene(),
    createScenePatch("scene_1", 1, [
      { type: "dataContext.changed", path: "stats.home.goals[0]", value: 3 }
    ])
  );

  assert.equal(result.applied, true);
  assert.equal(result.scene.dataContext.stats.home.goals["0"], 3);
});

test("prototype-polluting paths are refused", () => {
  for (const path of ["__proto__.polluted", "constructor.prototype.x", "a.__proto__.b"]) {
    const result = applyScenePatch(
      baseScene(),
      createScenePatch("scene_1", 1, [{ type: "dataContext.changed", path, value: true }])
    );
    assert.equal(result.applied, false, `expected ${path} to be refused`);
    assert.equal(result.failure.code, "INVALID_OPERATION");
  }
  assert.equal({}.polluted, undefined);
});

test("a patch is atomic: a later failure discards earlier operations", () => {
  const scene = baseScene();
  const result = applyScenePatch(
    scene,
    createScenePatch("scene_1", 1, [
      { type: "object.transform", objectId: "obj_a", transform: { x: 999 } },
      { type: "object.deleted", objectId: "ghost" }
    ])
  );

  assert.equal(result.applied, false);
  assert.equal(result.failure.code, "OBJECT_NOT_FOUND");
  assert.equal(result.failure.operationIndex, 1);
  // The first operation did not leak into the caller's document.
  assert.equal(scene.objects[0].x, 100);
});

test("patches are refused when the revision does not line up", () => {
  const scene = baseScene();

  const stale = applyScenePatch(scene, createScenePatch("scene_1", 0, [
    { type: "object.visibility", objectId: "obj_a", visible: false }
  ]));
  assert.equal(stale.applied, false);
  assert.equal(stale.failure.code, "REVISION_MISMATCH");
  assert.equal(stale.requiresFullSync, true);

  const notAdvancing = applyScenePatch(scene, {
    sceneId: "scene_1",
    baseRevision: 1,
    revision: 1,
    timestampMs: 0,
    operations: [{ type: "object.visibility", objectId: "obj_a", visible: false }]
  });
  assert.equal(notAdvancing.applied, false);
  assert.equal(notAdvancing.failure.code, "REVISION_NOT_ADVANCING");

  const wrongScene = applyScenePatch(scene, createScenePatch("scene_other", 1, [
    { type: "object.visibility", objectId: "obj_a", visible: false }
  ]));
  assert.equal(wrongScene.applied, false);
  assert.equal(wrongScene.failure.code, "SCENE_ID_MISMATCH");

  const empty = applyScenePatch(scene, createScenePatch("scene_1", 1, []));
  assert.equal(empty.applied, false);
  assert.equal(empty.failure.code, "EMPTY_PATCH");
});

test("creating a duplicate object is refused", () => {
  const result = applyScenePatch(
    baseScene(),
    createScenePatch("scene_1", 1, [
      {
        type: "object.created",
        object: { id: "obj_a", name: "Clash", type: "rect", x: 0, y: 0, zDepth: 0, zIndex: 0, layerId: "layer_1", visible: true }
      }
    ])
  );
  assert.equal(result.applied, false);
  assert.equal(result.failure.code, "DUPLICATE_OBJECT");
});

test("stage-scoped operations advance the revision and warn", () => {
  const result = applyScenePatch(
    baseScene(),
    createScenePatch("scene_1", 1, [
      { type: "surface.changed", surfaceId: "s1", value: { enabled: false } }
    ])
  );

  assert.equal(result.applied, true);
  assert.equal(result.revision, 2);
  assert.ok(result.warnings[0].includes("stage reload"));
});

test("full sync is preferred once a patch approaches the document size", () => {
  const patch = createScenePatch("scene_1", 1, [
    { type: "dataContext.changed", path: "blob", value: "x".repeat(5_000) }
  ]);

  assert.equal(shouldPreferFullSync(patch, 100_000), false);
  assert.equal(shouldPreferFullSync(patch, 10_000), true);
});

// ---------------------------------------------------------------------------
// Revision classification
// ---------------------------------------------------------------------------

test("revision classification distinguishes all four hazards", () => {
  const patch = (base, revision) => ({
    sceneId: "scene_1",
    baseRevision: base,
    revision,
    timestampMs: 0,
    operations: [{ type: "object.visibility", objectId: "obj_a", visible: false }]
  });

  assert.equal(evaluateRevision(5, patch(5, 6)).verdict, "apply");
  assert.equal(evaluateRevision(5, patch(4, 5)).verdict, "duplicate");
  assert.equal(evaluateRevision(5, patch(3, 4)).verdict, "duplicate");
  assert.equal(evaluateRevision(5, patch(7, 8)).verdict, "out-of-order");

  // Branched from an older state than we hold: two producers diverged.
  const conflict = evaluateRevision(5, patch(3, 6));
  assert.equal(conflict.verdict, "conflict");
  assert.equal(conflict.requiresFullSync, true);
});

// ---------------------------------------------------------------------------
// Ordered ingestion
// ---------------------------------------------------------------------------

function visibilityPatch(base, visible) {
  return createScenePatch("scene_1", base, [
    { type: "object.visibility", objectId: "obj_a", visible }
  ]);
}

test("in-sequence patches apply and advance the tracker", () => {
  const tracker = new SceneRevisionTracker(baseScene());
  assert.equal(tracker.revision, 1);

  const first = tracker.ingest(visibilityPatch(1, false));
  assert.equal(first.applied.length, 1);
  assert.equal(tracker.revision, 2);
  assert.equal(tracker.document.objects[0].visible, false);

  tracker.ingest(visibilityPatch(2, true));
  assert.equal(tracker.revision, 3);
  assert.equal(tracker.needsFullSync, false);
});

test("duplicate patches are dropped without changing anything", () => {
  const tracker = new SceneRevisionTracker(baseScene());
  const patch = visibilityPatch(1, false);

  tracker.ingest(patch);
  assert.equal(tracker.revision, 2);

  const repeat = tracker.ingest(patch);
  assert.equal(repeat.applied.length, 0);
  assert.equal(tracker.revision, 2);
  assert.equal(repeat.events[0].type, "duplicate-dropped");
  assert.equal(repeat.requiresFullSync, false);
});

test("out-of-order patches park and then drain in one pass", () => {
  const tracker = new SceneRevisionTracker(baseScene(), { parkLimit: 4 });

  // Patches 3 and 4 arrive before 2.
  const early3 = tracker.ingest(visibilityPatch(2, false));
  assert.equal(early3.applied.length, 0);
  assert.equal(tracker.parkedCount, 1);
  assert.equal(early3.events[0].type, "parked");

  tracker.ingest(visibilityPatch(3, true));
  assert.equal(tracker.parkedCount, 2);
  assert.equal(tracker.revision, 1);

  // Patch 2 arrives and unblocks both parked patches immediately.
  const drained = tracker.ingest(visibilityPatch(1, false));
  assert.equal(drained.applied.length, 3);
  assert.equal(tracker.revision, 4);
  assert.equal(tracker.parkedCount, 0);
  assert.ok(drained.events.some((event) => event.type === "unparked"));
});

test("too many parked patches force a full sync rather than waiting forever", () => {
  const tracker = new SceneRevisionTracker(baseScene(), { parkLimit: 2 });

  tracker.ingest(visibilityPatch(5, false));
  tracker.ingest(visibilityPatch(6, true));
  const third = tracker.ingest(visibilityPatch(7, false));

  assert.equal(third.requiresFullSync, true);
  assert.equal(tracker.needsFullSync, true);
  assert.equal(tracker.parkedCount, 0);
  assert.ok(third.events.some((event) => event.type === "gap-detected"));
});

test("while a full sync is outstanding, patches are ignored", () => {
  const tracker = new SceneRevisionTracker(baseScene(), { parkLimit: 0 });
  tracker.ingest(visibilityPatch(9, false)); // forces the pending flag

  const ignored = tracker.ingest(visibilityPatch(1, true));
  assert.equal(ignored.applied.length, 0);
  assert.equal(ignored.events[0].type, "full-sync-required");
  assert.equal(tracker.revision, 1);
});

test("a full sync clears the pending flag and re-seats the document", () => {
  const tracker = new SceneRevisionTracker(baseScene(), { parkLimit: 0 });
  tracker.ingest(visibilityPatch(9, false));
  assert.equal(tracker.needsFullSync, true);

  const synced = tracker.applyFullSync(baseScene({ revision: 10 }));
  assert.equal(tracker.needsFullSync, false);
  assert.equal(tracker.revision, 10);
  assert.equal(synced.events[0].type, "full-sync-applied");

  // Patching resumes from the synced revision.
  tracker.ingest(visibilityPatch(10, false));
  assert.equal(tracker.revision, 11);
});

test("a conflicting producer is named in the event", () => {
  const tracker = new SceneRevisionTracker(baseScene({ revision: 5 }), { origin: "engine" });
  const conflict = tracker.ingest({
    sceneId: "scene_1",
    baseRevision: 3,
    revision: 6,
    timestampMs: 0,
    origin: "editor-2",
    operations: [{ type: "object.visibility", objectId: "obj_a", visible: false }]
  });

  assert.equal(conflict.requiresFullSync, true);
  const event = conflict.events.find((candidate) => candidate.type === "conflict-detected");
  assert.ok(event.message.includes("editor-2"));
});

test("requestFullSync forces resync after an untrusted reconnect", () => {
  const tracker = new SceneRevisionTracker(baseScene());
  const event = tracker.requestFullSync("reconnected; revisions untrusted");

  assert.equal(event.type, "full-sync-required");
  assert.equal(tracker.needsFullSync, true);
});

// ---------------------------------------------------------------------------
// Reconnect comparison
// ---------------------------------------------------------------------------

test("revision comparison finds mismatches in both directions", () => {
  const client = new Map([
    ["scene_a", 5],
    ["scene_b", 3],
    ["scene_c", 7]
  ]);
  const engine = new Map([
    ["scene_a", 5],
    ["scene_b", 2],
    ["scene_d", 1]
  ]);

  const comparison = compareRevisions(client, engine);

  assert.deepEqual(comparison.mismatched, [
    { sceneId: "scene_b", clientRevision: 3, engineRevision: 2 }
  ]);
  assert.deepEqual(comparison.missingOnEngine, ["scene_c"]);
  assert.deepEqual(comparison.staleOnEngine, ["scene_d"]);
  assert.deepEqual(comparison.resyncSceneIds, ["scene_b", "scene_c"]);
});

test("a client that is ahead of the engine is still a mismatch", () => {
  const comparison = compareRevisions(new Map([["s", 9]]), new Map([["s", 12]]));
  assert.equal(comparison.mismatched.length, 1);
  assert.deepEqual(comparison.resyncSceneIds, ["s"]);
});

// ---------------------------------------------------------------------------
// State separation
// ---------------------------------------------------------------------------

test("a clean scene passes separation and is transportable", () => {
  const report = checkSceneSeparation(baseScene());
  assert.equal(report.clean, true);
  assert.deepEqual(report.issues, []);
  assert.equal(isSceneTransportable(baseScene()), true);
});

test("functions in a scene are an error", () => {
  const scene = baseScene();
  scene.objects[0].onClick = () => {};

  const report = checkSceneSeparation(scene);
  assert.equal(report.clean, false);
  const issue = report.issues.find((candidate) => candidate.code === "FUNCTION_IN_SCENE");
  assert.equal(issue.path, "objects[0].onClick");
});

test("renderer objects are detected by shape, not by instanceof", () => {
  const cases = [
    [{ nodeType: 1, nodeName: "DIV" }, "a DOM node"],
    [{ $$typeof: Symbol.for("react.element") }, "a React element"],
    [{ renderPipeId: "graphics" }, "a PixiJS display object"],
    [{ isObject3D: true }, "a Three.js object"],
    [{ destroy: () => {}, usage: 16 }, "a GPU resource handle"]
  ];

  for (const [value, expected] of cases) {
    const scene = baseScene();
    scene.objects[0].leaked = value;
    const report = checkSceneSeparation(scene);
    assert.equal(report.clean, false, `expected ${expected} to be rejected`);
    assert.ok(
      report.issues.some(
        (issue) =>
          issue.code === "RENDERER_OBJECT_IN_SCENE" && issue.message.includes(expected)
      ),
      `expected message about ${expected}, got ${JSON.stringify(report.issues)}`
    );
  }
});

test("binary data, cycles, and non-finite numbers are errors", () => {
  const withBinary = baseScene();
  withBinary.objects[0].pixels = new Uint8Array(4);
  assert.ok(
    checkSceneSeparation(withBinary).issues.some((issue) =>
      issue.message.includes("raw binary data")
    )
  );

  const withCycle = baseScene();
  withCycle.objects[0].self = withCycle.objects[0];
  assert.ok(
    checkSceneSeparation(withCycle).issues.some((issue) => issue.code === "CYCLIC_REFERENCE")
  );

  const withNaN = baseScene();
  withNaN.objects[0].x = Number.NaN;
  assert.ok(
    checkSceneSeparation(withNaN).issues.some((issue) => issue.code === "NON_FINITE_NUMBER")
  );
});

test("editor chrome is a warning, and sanitising removes it", () => {
  const scene = baseScene();
  scene.canvas.editorViewport = { showRulers: true, margins: { top: 0, right: 0, bottom: 0, left: 0 }, guides: [] };

  const report = checkSceneSeparation(scene);
  assert.equal(report.clean, true); // serialisable, just not scene content
  assert.ok(report.issues.some((issue) => issue.code === "EDITOR_STATE_IN_SCENE"));

  const { scene: sanitized, removed } = sanitizeSceneForEngine(scene);
  assert.deepEqual(removed, ["canvas.editorViewport"]);
  assert.equal(sanitized.canvas.editorViewport, undefined);
  // The original is untouched, so the editor keeps its chrome.
  assert.notEqual(scene.canvas.editorViewport, undefined);
  assert.equal(checkSceneSeparation(sanitized).issues.length, 0);
});
