// Compile-time half of the scene round-trip proof (1.1) and of the object
// catalogue (1.2).
//
// This file is never executed — `npm run typecheck` compiles it, and a drift
// between the Rust scene definition and the generated TypeScript fails the
// build here. It carries one object of every kind in the catalogue, as the
// exact wire JSON the Rust tests in `Shared/contracts/src/scene.rs` pin, and
// assigns it to the generated types **directly**: no `as`, no double cast, so
// a renamed field, a missing required one, a wrong enum spelling or a changed
// tag stops the build. See `scene-roundtrip.test.mjs` for the runtime half.

import type {
  AssetLibraryItem,
  HierarchyResolution,
  SceneDocument,
  SceneObject,
} from "../src/index";

// The shared base every kind flattens in. Written once here, because the
// point of this file is the per-kind fields and the base is proven by the
// same assignment.
const base = (id: string) => ({
  id,
  name: id,
  visible: true,
  locked: false,
  opacity: 1,
  x: 0,
  y: 0,
  zDepth: 0,
  zIndex: 0,
  layerId: "",
  width: 200,
  height: 100,
  rotation: 0,
  rotationX: 0,
  rotationY: 0,
  scaleX: 1,
  scaleY: 1,
  scaleZ: 1,
  strokeWidth: 0,
});

// Every kind in the catalogue (1.2). A kind added in Rust and forgotten here
// still compiles — the runtime half counts them against the expected set.
const catalogue: SceneObject[] = [
  {
    type: "text",
    ...base("title"),
    fill: "#ffffff",
    text: "Hello",
    fontId: "font_inter",
    size: 72,
    layout: "paragraph",
    autoFit: "shrink",
    writingMode: "horizontal-tb",
    verticalAlign: "middle",
    direction: "auto",
    textCase: "small-caps",
    decoration: { underline: true, strikethrough: false },
    overflow: "clip",
    align: "center",
    lineHeight: 1.2,
    letterSpacing: 20,
    wordSpacing: 0,
    paragraphSpacing: 12,
    textIndent: 0,
  },
  { type: "rect", ...base("bg"), fill: "#102030", radius: 8 },
  { type: "ellipse", ...base("dot"), fill: "#ff0000" },
  { type: "image", ...base("logo"), assetId: "asset_logo" },
  {
    type: "line",
    ...base("underline"),
    points: [
      { x: 0, y: 0 },
      { x: 10, y: 4 },
    ],
  },
  {
    type: "shape",
    ...base("swoosh"),
    path: {
      closed: true,
      vertices: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ],
      inTangents: [
        { x: 0, y: 0 },
        { x: -2, y: 0 },
      ],
      outTangents: [
        { x: 2, y: 0 },
        { x: 0, y: 0 },
      ],
    },
    fillEnabled: true,
    strokeEnabled: true,
    fillRule: "evenodd",
    trimStart: 0,
    trimEnd: 60,
    trimOffset: 10,
  },
  {
    type: "paint",
    ...base("brush"),
    strokes: [
      {
        id: "stroke_1",
        points: [{ x: 1, y: 2, pressure: 0.5, time: 0.25 }],
        size: 12,
        hardness: 0.8,
        opacity: 1,
        flow: 0.9,
        spacing: 0.1,
        smoothing: 0.3,
        roundness: 1,
        angle: 0,
        color: "#ff0000",
        blendMode: "multiply",
      },
    ],
    paintBlendMode: "normal",
  },
  {
    type: "mesh",
    ...base("slab"),
    meshKind: "slab",
    depth: 20,
    slab: {
      cornerRadius: 18,
      cornerSegments: 6,
      skew: 0,
      skewTexture: false,
      frontBevel: { enabled: true, size: 6, depth: 4 },
      backBevel: { enabled: false, size: 6, depth: 4 },
    },
    materialElements: ["front", "bevel"],
    anchor3d: { x: 0, y: 0, z: 0 },
    clipName: "intro",
    clipIndex: 2,
    timeScale: 0.5,
    frameOffset: -3,
    animationLoop: true,
  },
  {
    type: "light",
    ...base("key"),
    lightKind: "spot",
    intensity: 2,
    color: "#ffffff",
    range: 500,
    decay: 2,
    coneAngleDeg: 35,
    penumbra: 0.2,
    target: { x: 0, y: 0, z: -1 },
    castShadow: true,
  },
  {
    type: "camera",
    ...base("cam"),
    cameraKind: "perspective",
    fov: 40,
    zoom: 1,
    near: 0.1,
    far: 5000,
    target: { x: 0, y: 0, z: 0 },
    up: { x: 0, y: 1, z: 0 },
  },
  { type: "layer", ...base("cameras"), layerKind: "camera", childIds: ["cam"] },
  { type: "marker", ...base("cue"), markerKind: "event", eventName: "lower_third_in" },
  { type: "group", ...base("lower_third"), childIds: ["bg", "title"] },
];
// `Revision`, `durationFrames` and `sizeBytes` are `u64` in Rust, which the
// generator maps to `bigint` — the mapping the whole contract surface uses
// for frame numbers, epochs and sequences. The `n` literals here state that
// type honestly rather than casting it away; a TypeScript client that parses
// this document out of JSON receives `number` for those fields and owes the
// conversion. That gap belongs to the TS client codec, not to the schema.
const scene: SceneDocument = {
  id: "scene_1",
  name: "Lower Third",
  version: 1,
  revision: 3n,
  canvas: { width: 1920, height: 1080, frameRate: { num: 50, den: 1 } },
  timeline: { durationFrames: 250n },
  dataContext: {},
  assets: [
    {
      assetId: "asset_logo",
      name: "Logo",
      kind: "image",
      path: "images/logo.png",
      checksum: "abc123",
      mimeType: "image/png",
      sizeBytes: 1024n,
      status: "ready",
    },
  ],
  fonts: [],
  objects: catalogue,
};

// Field access must be typed: the object tag discriminates the union.
const text = scene.objects[0];
if (text && text.type === "text") {
  const _fontId: string = text.fontId;
  const _case: "original" | "upper" | "lower" | "title" | "small-caps" = text.textCase;
}
const image = scene.objects[3];
if (image && image.type === "image") {
  const _assetId: string = image.assetId;
}
const logo: AssetLibraryItem | undefined = scene.assets[0];
const _checksum = logo?.checksum;

// The hierarchy resolution (1.2) is a contract type, so the Editor consumes
// the one Rust implementation rather than re-deriving inheritance.
const resolution: HierarchyResolution = {
  effective: [
    {
      id: "bg",
      x: 0,
      y: 0,
      zDepth: 0,
      rotationZ: 0,
      rotationX: 0,
      rotationY: 0,
      scaleX: 1,
      scaleY: 1,
      scaleZ: 1,
      visible: true,
      opacity: 1,
      locked: false,
      isContainer: false,
    },
  ],
  edges: [{ parentId: "lower_third", childId: "bg" }],
  childrenByParent: [{ parentId: "lower_third", childIds: ["bg", "title"] }],
  diagnostics: [{ code: "missing-child", parentId: "lower_third", childId: "ghost" }],
};

// An unknown object kind must not be assignable (invariant 18). If `hologram`
// ever becomes a valid `type`, the `@ts-expect-error` below itself errors.
// @ts-expect-error — "hologram" is not a known object type
const _bad: SceneObject = { type: "hologram", id: "h", name: "h" };

// A misspelled enum member is not assignable either: the catalogue's enums are
// closed sets, not strings.
// @ts-expect-error — "vertical" is not a writing mode
const _badMode: SceneObject = { type: "text", ...base("t"), text: "", fontId: "f", size: 1, layout: "point", autoFit: "none", writingMode: "vertical", verticalAlign: "top", direction: "auto", textCase: "original", decoration: { underline: false, strikethrough: false }, overflow: "visible", align: "left", letterSpacing: 0, wordSpacing: 0, paragraphSpacing: 0, textIndent: 0 };

export { scene, catalogue, resolution, _bad, _badMode, _checksum };
