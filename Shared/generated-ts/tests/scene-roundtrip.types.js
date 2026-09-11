// Compile-time half of the 1.1 round-trip proof.
//
// This file is never executed — `npm run typecheck` compiles it, and a drift
// between the Rust scene definition and the generated TypeScript fails the
// build here. It assigns the exact wire JSON (the same shape the Rust test in
// `Shared/contracts/src/scene.rs` pins) to the generated `SceneDocument` type
// and asserts the assignment is sound. See `scene-roundtrip.test.mjs` for the
// runtime half.
const wire = {
    id: "scene_1",
    name: "Lower Third",
    version: 1,
    revision: 3,
    canvas: { width: 1920, height: 1080, frameRate: { num: 50, den: 1 } },
    timeline: { durationFrames: 250 },
    dataContext: {},
    assets: [
        {
            assetId: "asset_logo",
            name: "Logo",
            kind: "image",
            path: "images/logo.png",
            checksum: "abc123",
            mimeType: "image/png",
            sizeBytes: 1024,
            status: "ready",
        },
    ],
    fonts: [],
    objects: [
        { type: "rect", id: "bg", name: "bg", visible: true, opacity: 1, x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, width: 1920, height: 200, fill: "#102030" },
        { type: "text", id: "title", name: "title", visible: true, opacity: 1, x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, text: "Hello", fontId: "font_inter", size: 72, color: "#ffffff" },
        { type: "image", id: "logo", name: "logo", visible: true, opacity: 1, x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, assetId: "asset_logo", width: 120, height: 120 },
    ],
};
// If the generated type drifted from Rust — a renamed field, a wrong tag, a
// missed optional — this assignment stops compiling.
const scene = wire;
// Field access must be typed: the object tag discriminates the union.
const text = scene.objects[1];
if (text.type === "text") {
    const _fontId = text.fontId;
}
const image = scene.objects[2];
if (image.type === "image") {
    const _assetId = image.assetId;
}
const logo = scene.assets[0];
const _checksum = logo.checksum;
// An unknown object kind must not be assignable (invariant 18). If `hologram`
// ever becomes a valid `type`, the `@ts-expect-error` below itself errors.
// @ts-expect-error — "hologram" is not a known object type
const _bad = { type: "hologram", id: "h", name: "h" };
export { scene, _bad, _checksum };
