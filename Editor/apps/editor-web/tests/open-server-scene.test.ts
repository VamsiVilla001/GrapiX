import assert from "node:assert/strict";
import test from "node:test";
import type { SceneDocument } from "@grapix/shared-types";
import {
  sceneToTemplateScene,
  serverSceneToTemplateScene
} from "../src/lib/templateCatalog";

function storedScene(overrides: Partial<SceneDocument> = {}): SceneDocument {
  return {
    id: "scene_4e51e528",
    name: "ClaudeTemplate",
    version: 1,
    revision: 5,
    canvas: { width: 1920, height: 1080, background: "#00000000" },
    dataContext: {},
    assets: [],
    materials: [],
    objects: [],
    timeline: { fps: 50, durationFrames: 100, keyframes: [] },
    createdAt: "2026-08-01T11:00:00.000Z",
    updatedAt: "2026-08-01T11:05:00.000Z",
    ...overrides
  } as SceneDocument;
}

test("a scene opened from the service keeps its server id", () => {
  // The fork hazard: `Save` posts `scene.id`. If opening renamed the scene to a
  // numeric catalogue id, saving would create a *second* scene on the service and
  // leave the original untouched — the author edits a copy and is never told.
  const template = serverSceneToTemplateScene(storedScene());

  assert.equal(template.scene.id, "scene_4e51e528");
  assert.equal(template.sceneId, "scene_4e51e528");
  assert.equal(template.sceneId, template.scene.id, "the catalogue id must track the scene id");
  assert.equal(template.name, "ClaudeTemplate");
});

test("the design-import wrapper still renumbers, because that scene has no server identity", () => {
  // Guards the distinction rather than the behaviour of one function: if these two
  // ever converge, one of the two callers is silently wrong.
  const imported = sceneToTemplateScene(storedScene(), 3);

  assert.equal(imported.sceneId, "004");
  assert.equal(imported.scene.id, "004");
  assert.notEqual(imported.scene.id, "scene_4e51e528");
});

test("timestamps come from the stored scene, not from the moment it was opened", () => {
  const template = serverSceneToTemplateScene(storedScene());

  assert.equal(template.createdAt, "2026-08-01T11:00:00.000Z");
  assert.equal(template.updatedAt, "2026-08-01T11:05:00.000Z");
});

test("a nameless scene falls back to its id rather than showing an empty card", () => {
  const template = serverSceneToTemplateScene(storedScene({ name: "" }));

  assert.equal(template.name, "scene_4e51e528");
  assert.equal(template.shortLabel, "scene_4e51e528");
});

test("the video profile is derived from the stored scene's own canvas and rate", () => {
  const template = serverSceneToTemplateScene(
    storedScene({
      canvas: { width: 3840, height: 2160, background: "#00000000" },
      timeline: { fps: 25, durationFrames: 50, keyframes: [] }
    })
  );

  assert.equal(template.videoProfile.width, 3840);
  assert.equal(template.videoProfile.height, 2160);
  assert.equal(template.videoProfile.frameRate, 25);
});
