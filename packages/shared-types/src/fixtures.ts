import type { SceneDocument } from "./index.js";

/**
 * Contract fixture shared with the Rust render daemon.
 *
 * This object is the TypeScript-side source of truth: it is compile-time
 * checked against the real `SceneDocument` type right here. Running
 * `npm run fixtures:emit -w @grapix/shared-types` serializes it to
 * `fixtures/scene-document.v1.json`, which the daemon's contract test
 * (`services/render-daemon/tests/scene_contract.rs`) parses. If the type
 * changes shape, this file stops compiling and/or the regenerated fixture
 * breaks the Rust test — that is the drift detector.
 *
 * Content is deliberately chosen for the daemon's v1 renderer: one visible
 * rect (renderable), plus one text and one ellipse object (must produce
 * explicit unsupported-type warnings on the Rust side).
 */
export const sceneDocumentContractFixtureV1: SceneDocument = {
  id: "scene_fixture_v1",
  name: "Shared Contract Fixture",
  version: 1,
  canvas: {
    width: 1920,
    height: 1080,
    background: "#070b12"
  },
  dataContext: {
    team: {
      name: "Home",
      color: "#f5b942"
    }
  },
  assets: [
    {
      assetId: "asset_fixture_logo",
      name: "Fixture Logo",
      kind: "image",
      source: "data:image/png;base64,iVBORw0KGgo=",
      mimeType: "image/png",
      sizeBytes: 68,
      importedAt: "2026-07-15T00:00:00.000Z"
    }
  ],
  materials: [
    {
      materialId: "mat_fixture_accent",
      name: "Fixture Accent Color",
      type: "solid-color",
      color: "#f5b942",
      dynamic: false,
      opacity: 1,
      readiness: "READY"
    }
  ],
  objects: [
    {
      id: "rect_fixture_plate",
      name: "Lower Third Plate",
      type: "rect",
      x: 140,
      y: 742,
      zDepth: 0,
      zIndex: 1,
      layerId: "main",
      width: 640,
      height: 120,
      rotation: 0,
      opacity: 1,
      visible: true,
      locked: false,
      fill: "#10305080",
      stroke: "#ffffff",
      strokeWidth: 0,
      bindings: {},
      materialSlots: {},
      radius: 0
    },
    {
      id: "text_fixture_name",
      name: "Player Name",
      type: "text",
      x: 180,
      y: 768,
      zDepth: 0,
      zIndex: 2,
      layerId: "main",
      width: 420,
      height: 48,
      rotation: 0,
      opacity: 1,
      visible: true,
      locked: false,
      fill: "#ffffff",
      stroke: "#000000",
      strokeWidth: 0,
      bindings: {
        text: "team.name"
      },
      materialSlots: {},
      text: "Player Name",
      fontSize: 36,
      fontFamily: "Inter",
      fontWeight: "700",
      align: "left"
    },
    {
      id: "ellipse_fixture_badge",
      name: "Badge",
      type: "ellipse",
      x: 90,
      y: 760,
      zDepth: 0,
      zIndex: 3,
      layerId: "main",
      width: 84,
      height: 84,
      rotation: 0,
      opacity: 1,
      visible: true,
      locked: false,
      fill: "#f5b942",
      stroke: "#ffffff",
      strokeWidth: 2,
      bindings: {},
      materialSlots: {
        main: "mat_fixture_accent"
      }
    }
  ],
  timeline: {
    fps: 50,
    durationFrames: 100,
    keyframes: [
      {
        id: "kf_fixture_in",
        objectId: "rect_fixture_plate",
        frame: 0,
        properties: {
          opacity: 0
        },
        easing: "ease-out"
      }
    ]
  },
  createdAt: "2026-07-15T00:00:00.000Z",
  updatedAt: "2026-07-15T00:00:00.000Z"
};
