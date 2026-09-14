// The 2D/3D material library and what the preview can draw of it (11.12).
//
// Three failures under test.
//
// First, a **2D/3D split derived twice**. Which materials are lit is decided
// in Rust and enforced by the renderer, which refuses a PBR material in a
// scene with no light. If the panel decided it again from a kind's name, the
// two would disagree the first time a kind was added, and an author would file
// a material under a heading the engine does not agree with.
//
// Second, an **asset picker that offers what the validator refuses**. A video
// material bound to a still shows a frozen picture; an image material bound to
// a clip shows whichever frame the decoder handed over. Both look like working
// graphics to everything except the person watching, so the contract refuses
// them — and a picker that offers them anyway turns that refusal into an error
// message instead of a guardrail.
//
// Third, a **blend mode approximated rather than refused**. This is the
// recorded 1.x fault behind invariant 18: a renderer with no `overlay` drew
// `screen` instead and nobody was told.

import { describe, expect, it } from "vitest";

import type { MaterialDefinition, SceneDocument, SceneObject } from "@grapix/contracts";
import { findNode } from "../src/agent-surface";
import {
  bindableAssets,
  dimensionOf,
  isLit,
  materialElementsOf,
  materialManagerPanel,
  parseHex,
  rgbaHex,
  solidHex,
} from "../src/material-manager";
import {
  planPreviewMaterial,
  requiredTextureAssets,
  resolveObjectMaterial,
  type AssetSource,
} from "../src/material-preview";

function base(id: string): Record<string, unknown> {
  return {
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
    width: 100,
    height: 50,
    rotation: 0,
    rotationX: 0,
    rotationY: 0,
    scaleX: 1,
    scaleY: 1,
    scaleZ: 1,
    strokeWidth: 0,
  };
}

function material(over: Partial<MaterialDefinition> = {}): MaterialDefinition {
  return {
    materialId: "m",
    name: "Material",
    kind: "unlit",
    color: { type: "solid", color: { r: 1, g: 1, b: 1, a: 1, space: "srgb" } },
    opacity: 1,
    blendMode: "normal",
    alphaMode: "straight",
    cullMode: "back",
    depthMode: "read-write",
    doubleSided: false,
    textures: [],
    ...over,
  } as MaterialDefinition;
}

function scene(objects: SceneObject[], materials: MaterialDefinition[] = []): SceneDocument {
  return {
    id: "s",
    name: "Scene",
    version: 1,
    canvas: { width: 1920, height: 1080, frameRate: { num: 50, den: 1 } },
    timeline: { durationFrames: 1 },
    dataContext: {},
    assets: [
      { assetId: "logo", name: "Logo", kind: "image", path: "a/logo.png" },
      { assetId: "clip", name: "Clip", kind: "video", path: "a/clip.mp4" },
      { assetId: "brand-font", name: "Brand", kind: "font", path: "a/brand.otf" },
    ],
    fonts: [],
    materials,
    objects,
  } as unknown as SceneDocument;
}

const source = (assetId: string, mediaType: string): AssetSource => ({
  assetId,
  mediaType,
  dataUrl: `data:${mediaType};base64,AA==`,
});

describe("2D and 3D are the split the engine already enforces", () => {
  it("files each kind under the dimension its lighting implies", () => {
    expect(dimensionOf("pbr")).toBe("three-d");
    expect(isLit("pbr")).toBe(true);
    for (const kind of ["solid-color", "image", "video", "unlit"] as const) {
      expect(dimensionOf(kind)).toBe("two-d");
      expect(isLit(kind)).toBe(false);
    }
    // A custom shader decides its own lighting, so the library says it does
    // not know rather than filing it under a plausible half.
    expect(dimensionOf("shader")).toBeNull();
  });

  it("groups the panel by dimension, and says when a group is empty", () => {
    const document = scene(
      [],
      [
        material({ materialId: "flat", name: "Flat", kind: "solid-color" }),
        material({
          materialId: "chrome",
          name: "Chrome",
          kind: "pbr",
          lighting: { metallic: 1, roughness: 0.2, emissive: { r: 0, g: 0, b: 0, a: 1, space: "srgb" }, emissiveIntensity: 1 },
        }),
      ],
    );
    const panel = materialManagerPanel(document);

    expect(findNode(panel, "material-manager/two-d")!.label).toBe("2D materials");
    expect(findNode(panel, "material-manager/two-d")!.children!.map((row) => row.id)).toEqual([
      "material/flat",
    ]);
    expect(findNode(panel, "material-manager/three-d")!.children!.map((row) => row.id)).toEqual([
      "material/chrome",
    ]);
    // An empty group says it is empty rather than silently not appearing:
    // "there are no 3D materials" is a different fact from "3D materials are
    // not a thing this panel has".
    expect(findNode(panel, "material-manager/shader")!.description).toBe(
      "no shader materials in this scene",
    );
  });

  it("shows a 3D material's surface response, and what governs it when absent", () => {
    const withLighting = scene(
      [],
      [
        material({
          materialId: "chrome",
          kind: "pbr",
          lighting: {
            metallic: 1,
            roughness: 0.25,
            emissive: { r: 1, g: 0, b: 0, a: 1, space: "srgb" },
            emissiveIntensity: 2,
          },
        }),
      ],
    );
    expect(findNode(materialManagerPanel(withLighting), "material/chrome/lighting")!.value).toBe(
      "metallic 1, roughness 0.25, emissive #ff0000 ×2",
    );

    // A lit material with no block of its own is governed by the contract's
    // defaults. An empty cell would read as "no lighting", which is a
    // different and wrong statement.
    const without = scene([], [material({ materialId: "chrome", kind: "pbr" })]);
    expect(findNode(materialManagerPanel(without), "material/chrome/lighting")!.value).toContain(
      "contract defaults",
    );
  });
});

describe("the asset picker offers exactly what the contract accepts", () => {
  it("a video material takes only moving assets, and an image material only stills", () => {
    const document = scene([]);
    expect(bindableAssets(document, "video", "baseColor").map((a) => a.assetId)).toEqual(["clip"]);
    expect(bindableAssets(document, "image", "baseColor").map((a) => a.assetId)).toEqual(["logo"]);
    // A lit 3D surface takes either: a video wall is a real graphic.
    expect(bindableAssets(document, "pbr", "baseColor").map((a) => a.assetId)).toEqual([
      "logo",
      "clip",
    ]);
    // A font has no texels, whatever the slot.
    expect(bindableAssets(document, "unlit", "normal").map((a) => a.assetId)).not.toContain(
      "brand-font",
    );
  });

  it("names a texture whose asset has left the library rather than showing a bare id", () => {
    const document = scene(
      [],
      [
        material({
          materialId: "m",
          textures: [
            {
              slot: "baseColor",
              assetId: "gone",
              fit: "cover",
              wrap: "clamp",
              filtering: "linear",
              colorSpace: "srgb",
            },
          ],
        }),
      ],
    );
    const row = findNode(materialManagerPanel(document), "material/m/texture/baseColor")!;
    expect(row.value).toBe("gone — missing from the asset library");
  });
});

describe("material slots are keyed by the names the renderer looks up", () => {
  it("offers a cube's six faces and a sphere's single surface", () => {
    const cube = { type: "mesh", ...base("cube"), meshKind: "cube", depth: 10 } as unknown as SceneObject;
    expect(materialElementsOf(cube)).toEqual([
      "front",
      "back",
      "left",
      "right",
      "top",
      "bottom",
    ]);
    const sphere = {
      type: "mesh",
      ...base("ball"),
      meshKind: "sphere",
      depth: 10,
    } as unknown as SceneObject;
    expect(materialElementsOf(sphere)).toEqual(["object"]);
    // A planar object has one surface, and `fill` is what the document calls
    // it — the same key `materials.usage` already reports.
    expect(materialElementsOf({ type: "rect", ...base("bar") } as unknown as SceneObject)).toEqual(
      ["fill"],
    );
  });

  it("grows a slab's list by one element per enabled bevel", () => {
    // The case a kind alone cannot state. Offering the unbevelled list would
    // leave `frontBevel` unassigned, and the engine refuses a partly assigned
    // mesh — for a face the author was never shown.
    const slab = {
      type: "mesh",
      ...base("slab"),
      meshKind: "slab",
      depth: 10,
      slab: {
        cornerRadius: 0,
        cornerSegments: 1,
        skew: 0,
        frontBevel: { enabled: true, size: 2, depth: 2 },
        backBevel: { enabled: false, size: 0, depth: 0 },
      },
    } as unknown as SceneObject;
    expect(materialElementsOf(slab)).toEqual(["front", "back", "side", "frontBevel"]);
  });
});

describe("assigning a material names what stops it", () => {
  it("refuses with the object named when the selection cannot take one", () => {
    const document = scene([{ type: "rect", ...base("bar") } as unknown as SceneObject], [
      material({ materialId: "m", name: "Bar fill" }),
    ]);

    const none = findNode(materialManagerPanel(document), "material/m")!.actions!.find(
      (action) => action.name === "assign",
    )!;
    expect(none.unavailable).toBe("select an object to assign this material to");

    const ok = findNode(
      materialManagerPanel(document, { selectedObjectIds: ["bar"] }),
      "material/m",
    )!.actions!.find((action) => action.name === "assign")!;
    expect(ok.unavailable).toBeUndefined();

    // A model with no element metadata has nowhere to put a material, and the
    // reason names it rather than saying "cannot assign".
    const withModel = scene(
      [{ type: "mesh", ...base("prop"), meshKind: "model", depth: 1 } as unknown as SceneObject],
      [material({ materialId: "m" })],
    );
    const blocked = findNode(
      materialManagerPanel(withModel, { selectedObjectIds: ["prop"] }),
      "material/m",
    )!.actions!.find((action) => action.name === "assign")!;
    expect(blocked.unavailable).toBe("prop has no material slot to assign to");
  });
});

describe("the preview refuses what it cannot draw, by name", () => {
  const sources = new Map([
    ["logo", source("logo", "image/png")],
    ["clip", source("clip", "video/mp4")],
  ]);

  it("names an unsupported blend mode instead of drawing the nearest one", () => {
    // The 1.x fault, unrepeatable: `overlay` must read the destination in a
    // shader, so the preview says so rather than compositing `screen`.
    const plan = planPreviewMaterial(material({ blendMode: "overlay" }), 1, sources);
    expect(plan.kind).toBe("unsupported");
    expect(plan.kind === "unsupported" && plan.reason).toContain("overlay");

    // The six the contract calls fixed-function all plan.
    for (const blendMode of ["normal", "add", "multiply", "screen", "darken", "lighten"] as const) {
      expect(planPreviewMaterial(material({ blendMode }), 1, sources).kind).toBe("plan");
    }
  });

  it("multiplies the object's opacity into the material's, and keeps depth authored", () => {
    const plan = planPreviewMaterial(
      material({ opacity: 0.5, depthMode: "read", cullMode: "front" }),
      0.5,
      sources,
    );
    expect(plan.kind === "plan" && plan.opacity).toBe(0.25);
    expect(plan.kind === "plan" && plan.depthTest).toBe(true);
    // `read` tests against what is already there without writing: an authored
    // decision the per-frame update must not overwrite.
    expect(plan.kind === "plan" && plan.depthWrite).toBe(false);
    // Culling the front face means drawing the back — the inversion that is
    // invisible until a 3D object is seen from behind.
    expect(plan.kind === "plan" && plan.side).toBe("back");
  });

  it("plans the material's own colour, never the object's fill", () => {
    // The failure prevented: a rect bound to a shared brand material showing
    // whatever fill it carried beforehand, which looks exactly like the
    // assignment silently failing.
    const brand = material({
      color: { type: "solid", color: { r: 0, g: 0.5, b: 1, a: 1, space: "srgb" } },
    });
    const plan = planPreviewMaterial(brand, 1, sources);
    expect(plan.kind === "plan" && plan.color).toEqual(brand.color);
  });

  it("an opaque alpha mode does not blend, whatever the opacity says", () => {
    const plan = planPreviewMaterial(material({ alphaMode: "opaque", opacity: 0.2 }), 1, sources);
    expect(plan.kind === "plan" && plan.transparent).toBe(false);
  });

  it("carries a moving texture as moving, and names one whose bytes never came", () => {
    const withClip = planPreviewMaterial(
      material({
        kind: "video",
        textures: [
          {
            slot: "baseColor",
            assetId: "clip",
            fit: "cover",
            wrap: "clamp",
            filtering: "linear",
            colorSpace: "srgb",
          },
        ],
      }),
      1,
      sources,
    );
    expect(withClip.kind === "plan" && withClip.textures[0]!.moving).toBe(true);

    const missing = planPreviewMaterial(
      material({
        textures: [
          {
            slot: "baseColor",
            assetId: "gone",
            fit: "cover",
            wrap: "clamp",
            filtering: "linear",
            colorSpace: "srgb",
          },
        ],
      }),
      1,
      sources,
    );
    // Not a grey box: "the logo is missing" and "the logo is grey" are
    // different facts and only one of them is true.
    expect(missing.kind === "plan" && missing.missingTextures).toEqual(["baseColor (gone)"]);
    expect(missing.kind === "plan" && missing.textures).toEqual([]);
  });

  it("refuses a partly assigned mesh rather than painting the whole of it", () => {
    const cube = {
      type: "mesh",
      ...base("cube"),
      meshKind: "cube",
      depth: 10,
      materialSlots: { front: { materialId: "m" } },
    } as unknown as SceneObject;
    const document = scene([cube], [material({ materialId: "m" })]);

    const resolved = resolveObjectMaterial(document, cube);
    expect(resolved.kind).toBe("unsupported");
    expect(resolved.kind === "unsupported" && resolved.reason).toContain("back, left, right");
  });

  it("resolves a fully assigned object, and names a binding with no material", () => {
    const bar = {
      type: "rect",
      ...base("bar"),
      materialSlots: { fill: { materialId: "m" } },
    } as unknown as SceneObject;

    const ok = resolveObjectMaterial(scene([bar], [material({ materialId: "m" })]), bar);
    expect(ok.kind === "material" && ok.material.materialId).toBe("m");

    const dangling = resolveObjectMaterial(scene([bar], []), bar);
    expect(dangling.kind === "unsupported" && dangling.reason).toContain("not in this scene");
  });

  it("asks for each texture asset once, however many materials use it", () => {
    const document = scene(
      [],
      [
        material({
          materialId: "a",
          textures: [
            { slot: "baseColor", assetId: "logo", fit: "cover", wrap: "clamp", filtering: "linear", colorSpace: "srgb" },
          ],
        }),
        material({
          materialId: "b",
          textures: [
            { slot: "baseColor", assetId: "logo", fit: "cover", wrap: "clamp", filtering: "linear", colorSpace: "srgb" },
            { slot: "normal", assetId: "clip", fit: "cover", wrap: "clamp", filtering: "linear", colorSpace: "linear" },
          ],
        }),
      ],
    );
    expect(requiredTextureAssets(document)).toEqual(["logo", "clip"]);
  });
});

describe("colours round-trip through the picker without inventing one", () => {
  it("reads and writes the hex the control uses", () => {
    expect(rgbaHex({ r: 1, g: 0, b: 0, a: 1, space: "srgb" })).toBe("#ff0000");
    expect(parseHex("#ff0000")).toEqual({ r: 1, g: 0, b: 0 });
    // The short form CSS allows, expanded the way Rust's parser expands it.
    expect(parseHex("#f00")).toEqual({ r: 1, g: 0, b: 0 });
    // Not a colour is refused, never defaulted to black: a fallback colour is
    // a value appearing in the author's scene that they never chose.
    expect(parseHex("teal")).toBeUndefined();
    expect(parseHex("#ff00")).toBeUndefined();
  });

  it("has no swatch for a gradient, because a gradient has no single colour", () => {
    expect(solidHex({ type: "solid", color: { r: 0, g: 0, b: 0, a: 1, space: "srgb" } })).toBe(
      "#000000",
    );
    expect(
      solidHex({
        type: "linear-gradient",
        angle: 0,
        startX: 0,
        startY: 0,
        endX: 1,
        endY: 0,
        stops: [],
        spread: "pad",
        coordinateMode: "object",
      }),
    ).toBeUndefined();
  });
});
