// The material manager (11.12) and font manager (11.13).
//
// Two failures under test. First, a usage index that drifts: materials usage
// is computed from the document here, so adding an object that binds a
// material changes its count with nothing to update. Second, an unresolved
// font reaching air: both platforms will substitute a system face if allowed,
// producing the right-looking graphic in the wrong typeface while every check
// reports success (invariants 29 and 18).

import { describe, expect, it } from "vitest";

import type { SceneDocument, SceneObject } from "@grapix/contracts";
import { findNode } from "../src/agent-surface";
import { fontManagerPanel, fontUsers } from "../src/font-manager";
import { materialManagerPanel, relinkMaterial, usersOf } from "../src/material-manager";

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
    width: 10,
    height: 10,
    rotation: 0,
    rotationX: 0,
    rotationY: 0,
    scaleX: 1,
    scaleY: 1,
    scaleZ: 1,
    strokeWidth: 0,
  };
}

function meshWith(id: string, materialId: string): SceneObject {
  return {
    type: "rect",
    ...base(id),
    cornerRadius: 0,
    materialSlots: { surface: { materialId } },
  } as unknown as SceneObject;
}

function textWith(id: string, fontId: string): SceneObject {
  return {
    type: "text",
    ...base(id),
    text: "Hello",
    fontId,
    fontSize: 24,
  } as unknown as SceneObject;
}

function scene(
  objects: SceneObject[],
  materials: unknown[] = [],
  fonts: unknown[] = [],
): SceneDocument {
  return {
    id: "s",
    name: "Scene",
    version: 1,
    canvas: { width: 1920, height: 1080, frameRate: { num: 50, den: 1 } },
    timeline: { durationFrames: 1 },
    dataContext: {},
    assets: [],
    fonts,
    materials,
    textStyles: [],
    objects,
  } as unknown as SceneDocument;
}

const brandMaterial = { materialId: "brand", name: "Brand", kind: "unlit" };
const altMaterial = { materialId: "alt", name: "Alt", kind: "unlit" };

const font = (fontId: string, displayName: string): unknown => ({
  fontId,
  family: displayName,
  displayName,
  faces: [
    {
      faceId: `${fontId}-400`,
      family: displayName,
      weight: 400,
      style: "normal",
      source: { kind: "file", assetId: `${fontId}-asset`, format: "woff2" },
    },
  ],
  fallbackFamilies: ["Arial"],
  embeddingPolicy: "installable",
  enabled: true,
});

describe("material usage is read from the document, never indexed", () => {
  it("adding a user changes the count with nothing to update", () => {
    // The failure prevented: a stored index that an edit forgets to refresh.
    const one = scene([meshWith("a", "brand")], [brandMaterial]);
    expect(usersOf(one, "brand")).toEqual(["a"]);

    const two = scene([meshWith("a", "brand"), meshWith("b", "brand")], [brandMaterial]);
    expect(usersOf(two, "brand")).toEqual(["a", "b"]);
  });

  it("a shared material is marked shared, with its count", () => {
    const document = scene(
      [meshWith("a", "brand"), meshWith("b", "brand"), meshWith("c", "alt")],
      [brandMaterial, altMaterial],
    );
    const panel = materialManagerPanel(document);

    expect(findNode(panel, "material/brand")!.description).toBe("shared by 2 objects");
    expect(findNode(panel, "material/alt")!.description).toBe("used by 1 object");
    expect(findNode(panel, "material/brand/usage")!.value).toBe("a, b");
  });

  it("an unused material reports as unused and can be deleted", () => {
    const document = scene([], [brandMaterial]);
    const panel = materialManagerPanel(document);

    expect(findNode(panel, "material/brand")!.description).toBe("unused");
    const del = findNode(panel, "material/brand")!.actions!.find((a) => a.name === "delete")!;
    expect(del.unavailable).toBeUndefined();
  });

  it("marks the selected material for the rendered panel", () => {
    const document = scene([], [brandMaterial, altMaterial]);
    const panel = materialManagerPanel(document, { selectedMaterialId: "alt" });

    expect(findNode(panel, "material/brand")!.selected).toBe(false);
    expect(findNode(panel, "material/alt")!.selected).toBe(true);
  });

  it("deleting an in-use material is refused, naming the count", () => {
    const document = scene([meshWith("a", "brand"), meshWith("b", "brand")], [brandMaterial]);
    const panel = materialManagerPanel(document);

    const del = findNode(panel, "material/brand")!.actions!.find((a) => a.name === "delete")!;
    expect(del.unavailable).toBe("Brand is used by 2 object(s)");
  });
});

describe("relink previews its blast radius", () => {
  it("returns exactly the objects that would change, and mutates nothing", () => {
    const document = scene(
      [meshWith("a", "brand"), meshWith("b", "brand"), meshWith("c", "alt")],
      [brandMaterial, altMaterial],
    );
    const before = JSON.stringify(document);

    expect(relinkMaterial(document, "brand", "alt")).toEqual(["a", "b"]);
    // A preview that edited would be a confirmation dialog that had already
    // done the thing it was asking about.
    expect(JSON.stringify(document)).toBe(before);
  });

  it("relinking a material to itself would change nothing, and says so", () => {
    const document = scene([meshWith("a", "brand")], [brandMaterial]);
    expect(relinkMaterial(document, "brand", "brand")).toEqual([]);
  });
});

// Relink and delete are `SceneEdit`s applied by Rust (gx_contracts::material_edit,
// with its own tests). What stays here is what the panel shows before either.
describe("the panel explains a delete it will not offer", () => {
  it("an in-use material's Delete is unavailable, naming its user count", () => {
    const document = scene([meshWith("a", "brand"), meshWith("b", "brand")], [brandMaterial, altMaterial]);
    const panel = materialManagerPanel(document);
    const action = (id: string) =>
      findNode(panel, `material/${id}`)!.actions!.find((candidate) => candidate.name === "delete")!;

    expect(action("brand").unavailable).toBe("Brand is used by 2 object(s)");
    expect(action("alt").unavailable).toBeUndefined();
  });
});

describe("an unresolved font blocks the take", () => {
  it("raises a blocking alert naming the font", () => {
    const document = scene(
      [textWith("t", "inter")],
      [],
      [font("inter", "Inter"), font("gotham", "Gotham")],
    );
    const panel = fontManagerPanel(document, { unresolvedFontIds: ["gotham"] });

    const alert = findNode(panel, "font-manager/blocked")!;
    expect(alert.role).toBe("alert");
    expect(alert.value).toBe("Gotham");
    expect(findNode(panel, "font/gotham")!.description).toContain("not resolved");
  });

  it("the blocked action names the font rather than only failing", () => {
    const document = scene([textWith("t", "inter")], [], [font("gotham", "Gotham")]);
    const panel = fontManagerPanel(document, { unresolvedFontIds: ["gotham"] });

    const publish = panel.actions!.find((action) => action.name === "publish")!;
    expect(publish.unavailable).toBe("unresolved font(s): Gotham");
  });

  it("a fully resolved list raises no alert and does not block", () => {
    const document = scene([textWith("t", "inter")], [], [font("inter", "Inter")]);
    const panel = fontManagerPanel(document, { unresolvedFontIds: [] });

    expect(findNode(panel, "font-manager/blocked")).toBeUndefined();
    expect(panel.actions!.find((a) => a.name === "publish")!.unavailable).toBeUndefined();
  });

  it("font usage is computed from the document", () => {
    const document = scene(
      [textWith("a", "inter"), textWith("b", "inter"), textWith("c", "gotham")],
      [],
      [font("inter", "Inter")],
    );
    expect(fontUsers(document, "inter")).toEqual(["a", "b"]);
    expect(findNode(fontManagerPanel(document), "font/inter/usage")!.value).toBe("a, b");
  });

  it("marks the selected font for the rendered panel", () => {
    const document = scene([], [], [font("inter", "Inter"), font("gotham", "Gotham")]);
    const panel = fontManagerPanel(document, { selectedFontId: "gotham" });

    expect(findNode(panel, "font/inter")!.selected).toBe(false);
    expect(findNode(panel, "font/gotham")!.selected).toBe(true);
  });
});
