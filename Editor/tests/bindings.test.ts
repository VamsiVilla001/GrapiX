// Data binding panel and resolver (11.19): text, images and transforms are
// driven from one strict data path grammar without mutating authored values.

import { describe, expect, it } from "vitest";

import type { SceneDocument, SceneObject } from "@grapix/contracts";
import {
  applyBindingEdit,
  bindingPanel,
  dataFields,
  parseBindingPath,
  resolveSceneBindings,
} from "../src/bindings";

function base(id: string): Record<string, unknown> {
  return {
    id,
    name: id,
    visible: true,
    locked: false,
    opacity: 1,
    x: 10,
    y: 20,
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

function text(bindings: Record<string, unknown> = {}): SceneObject {
  return {
    type: "text",
    ...base("headline"),
    text: "Authored headline",
    fontId: "inter",
    size: 48,
    bindings,
  } as unknown as SceneObject;
}

function image(bindings: Record<string, unknown> = {}): SceneObject {
  return {
    type: "image",
    ...base("crest"),
    assetId: "home-crest",
    fit: "contain",
    bindings,
  } as unknown as SceneObject;
}

function scene(objects: SceneObject[]): SceneDocument {
  return {
    id: "scoreboard",
    name: "Scoreboard",
    version: 1,
    canvas: { width: 1920, height: 1080, frameRate: { num: 50, den: 1 } },
    timeline: { durationFrames: 1 },
    dataContext: {
      match: {
        headline: "Falcons lead",
        home: { crest: "away-crest" },
        position: { x: 640, y: 72 },
        visible: false,
      },
      teams: [{ name: "Falcons" }, { name: "Owls" }],
    },
    assets: [
      {
        assetId: "home-crest",
        name: "Home crest",
        kind: "image",
        path: "home.png",
        mimeType: "image/png",
      },
      {
        assetId: "away-crest",
        name: "Away crest",
        kind: "image",
        path: "away.png",
        mimeType: "image/png",
      },
    ],
    fonts: [],
    materials: [],
    objects,
  } as unknown as SceneDocument;
}

describe("binding path grammar", () => {
  it("accepts nested object paths and numeric array segments", () => {
    expect(parseBindingPath("match.home.crest")).toMatchObject({ ok: true });
    expect(parseBindingPath("teams.0.name")).toEqual({
      ok: true,
      segments: ["teams", "0", "name"],
    });
  });

  it("refuses empty, ambiguous and prototype-reaching segments", () => {
    expect(parseBindingPath("match..score")).toMatchObject({ ok: false });
    expect(parseBindingPath("match.home score")).toMatchObject({ ok: false });
    expect(parseBindingPath("match.__proto__.score")).toMatchObject({ ok: false });
  });

  it("flattens only bindable leaf values", () => {
    expect(dataFields(scene([]).dataContext).map((field) => field.path)).toEqual([
      "match.headline",
      "match.home.crest",
      "match.position.x",
      "match.position.y",
      "match.visible",
      "teams.0.name",
      "teams.1.name",
    ]);
  });
});

describe("preview resolution", () => {
  it("drives text, image asset and transforms without mutating authored values", () => {
    const authored = scene([
      text({ text: "match.headline", x: "match.position.x", y: "match.position.y" }),
      image({ assetId: "match.home.crest", visible: "match.visible" }),
    ]);
    const resolution = resolveSceneBindings(authored);
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;

    expect(resolution.document.objects[0]).toMatchObject({
      text: "Falcons lead",
      x: 640,
      y: 72,
    });
    expect(resolution.document.objects[1]).toMatchObject({
      assetId: "away-crest",
      visible: false,
    });
    expect(authored.objects[0]).toMatchObject({
      text: "Authored headline",
      x: 10,
      y: 20,
    });
  });

  it("refuses the whole resolution when one value has the wrong type", () => {
    const resolution = resolveSceneBindings(scene([text({ x: "match.headline" })]));
    expect(resolution).toMatchObject({
      ok: false,
      issues: [
        {
          code: "bindingTypeMismatch",
          objectId: "headline",
          property: "x",
          path: "match.headline",
        },
      ],
    });
  });

  it("names unsupported properties and non-string paths", () => {
    const resolution = resolveSceneBindings(scene([text({ madeUp: "match.headline", text: 42 })]));
    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.issues.map((issue) => issue.code)).toEqual([
      "bindingPropertyUnsupported",
      "bindingPathNotString",
    ]);
  });

  it("refuses an image binding to an asset the scene does not carry", () => {
    const document = scene([image({ assetId: "match.home.crest" })]);
    (document.dataContext.match as Record<string, unknown>).home = { crest: "missing" };
    expect(resolveSceneBindings(document)).toMatchObject({
      ok: false,
      issues: [{ code: "bindingAssetUnknown", property: "assetId" }],
    });
  });
});

describe("binding property panel", () => {
  it("offers kind-aware properties and exposes the scene data fields", () => {
    const panel = bindingPanel(scene([text({ text: "match.headline" })]), ["headline"]);
    expect(panel.description).toContain("headline (text)");
    const properties = panel.children?.[0]?.children ?? [];
    expect(properties.find((node) => node.id === "binding/property/text")?.value).toBe(
      'match.headline → "Falcons lead"',
    );
    expect(properties.some((node) => node.id === "binding/property/assetId")).toBe(false);
    expect(panel.children?.[1]?.children?.map((node) => node.label)).toContain("teams.0.name");
  });

  it("names why multi-selection cannot edit object-local bindings", () => {
    expect(bindingPanel(scene([text(), image()]), ["headline", "crest"]).description).toBe(
      "Select one object; 2 are selected",
    );
  });

  it("adds and removes one binding as one undoable transaction", () => {
    const document = scene([text()]);
    const added = applyBindingEdit(document, "headline", "text", "match.headline");
    expect(added).toMatchObject({
      ok: true,
      transaction: {
        label: "Bind Text binding",
        changes: [{ objectId: "headline", field: "bindings.text", to: "match.headline" }],
      },
    });
    if (!added.ok) return;
    expect(added.document.objects[0]?.bindings).toEqual({ text: "match.headline" });

    const removed = applyBindingEdit(added.document, "headline", "text", undefined);
    expect(removed).toMatchObject({ ok: true, transaction: { label: "Remove Text binding" } });
    if (removed.ok) expect(removed.document.objects[0]?.bindings).toBeUndefined();
  });

  it("refuses a path whose current value cannot drive the property", () => {
    expect(applyBindingEdit(scene([text()]), "headline", "x", "match.headline")).toEqual({
      ok: false,
      reason: "match.headline is string; X requires number",
    });
  });
});
