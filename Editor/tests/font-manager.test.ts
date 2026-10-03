// The font manager's explicit ingest and remove actions (11.13).
//
// The failure prevented: a font leaving a scene while text still names it,
// which puts that text on air in a fallback face (invariant 18). Removal is
// only ever explicit, refused while in use with the users named, and planned
// rather than applied — the command executor owns the edit and its undo.

import { describe, expect, it } from "vitest";

import type { SceneDocument, SceneObject } from "@grapix/contracts";
import { findNode } from "../src/agent-surface";
import {
  fontManagerPanel,
  isFontRemovalRefused,
  planFontRemoval,
} from "../src/font-manager";

function text(id: string, name: string, fontId: string): SceneObject {
  return {
    type: "text",
    id,
    name,
    visible: true,
    locked: false,
    opacity: 1,
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    text: "On air",
    fontId,
    size: 24,
  } as unknown as SceneObject;
}

function fileFont(fontId: string, displayName: string, assetIds: string[]): unknown {
  return {
    fontId,
    family: displayName,
    displayName,
    faces: assetIds.map((assetId, index) => ({
      faceId: `${fontId}-face-${index}`,
      family: displayName,
      weight: 400,
      style: "normal",
      source: { kind: "file", assetId, format: "woff2" },
    })),
    fallbackFamilies: ["Arial"],
    embeddingPolicy: "package",
    license: "SIL Open Font License 1.1",
    enabled: true,
    status: "Ready",
  };
}

const fontAsset = (assetId: string): unknown => ({
  assetId,
  name: `${assetId}.woff2`,
  kind: "font",
  path: `assets/fonts/${assetId}.woff2`,
  checksum: "a".repeat(64),
  status: "ready",
});

function scene(
  objects: SceneObject[],
  fonts: unknown[],
  assets: unknown[],
  textStyles: unknown[] = [],
): SceneDocument {
  return {
    id: "s",
    name: "Lower third",
    version: 1,
    canvas: { width: 1920, height: 1080, frameRate: { num: 50, den: 1 } },
    timeline: { durationFrames: 1 },
    dataContext: {},
    assets,
    fonts,
    materials: [],
    textStyles,
    objects,
  } as unknown as SceneDocument;
}

describe("removing a font is explicit and refused while anything uses it", () => {
  const document = scene(
    [text("title", "Title", "inter"), text("strap", "Strap", "inter"), text("x", "X", "gotham")],
    [fileFont("inter", "Inter", ["inter-asset"]), fileFont("gotham", "Gotham", ["gotham-asset"])],
    [fontAsset("inter-asset"), fontAsset("gotham-asset")],
    [{ styleId: "headline", name: "Headline", fontId: "inter", size: 48, textCase: "original" }],
  );

  it("the panel's Remove names the text objects and styles that use the font", () => {
    const remove = findNode(fontManagerPanel(document), "font/inter")!.actions!.find(
      (action) => action.name === "remove",
    )!;
    expect(remove.unavailable).toBe(
      "Inter is used by text object(s) Title (title), Strap (strap); text style(s) Headline",
    );
  });

  it("planning the removal refuses with the panel's own sentence and changes nothing", () => {
    const before = JSON.stringify(document);
    const outcome = planFontRemoval(document, "inter");
    expect(isFontRemovalRefused(outcome)).toBe(true);
    expect(outcome).toEqual({
      code: "fontInUse",
      refused: "Inter is used by text object(s) Title (title), Strap (strap); text style(s) Headline",
    });
    expect(JSON.stringify(document)).toBe(before);
  });

  it("an unknown font is refused by id", () => {
    expect(planFontRemoval(document, "nope")).toEqual({
      code: "fontUnknown",
      refused: "no font nope in Lower third",
    });
  });
});

describe("removing an unused font plans exactly its own assets", () => {
  it("keeps an asset another font's face still stands on", () => {
    const document = scene(
      [text("t", "Title", "keep")],
      [
        fileFont("unused", "Unused", ["shared-asset", "own-asset"]),
        fileFont("keep", "Keep", ["shared-asset"]),
      ],
      [fontAsset("shared-asset"), fontAsset("own-asset")],
    );
    const remove = findNode(fontManagerPanel(document), "font/unused")!.actions!.find(
      (action) => action.name === "remove",
    )!;
    expect(remove.unavailable).toBeUndefined();
    expect(planFontRemoval(document, "unused")).toEqual({
      fontId: "unused",
      displayName: "Unused",
      assetIds: ["own-asset"],
    });
  });
});

describe("ingest is reachable from the panel", () => {
  const document = scene([], [fileFont("inter", "Inter", ["inter-asset"])], [fontAsset("inter-asset")]);

  it("offers file and link ingest beside publish, and the licence of each font", () => {
    const panel = fontManagerPanel(document);
    expect(panel.actions!.map((action) => action.name)).toEqual([
      "ingestFiles",
      "ingestLink",
      "publish",
    ]);
    expect(panel.actions!.every((action) => action.unavailable === undefined)).toBe(true);
    expect(findNode(panel, "font/inter/licence")!.value).toBe("SIL Open Font License 1.1");
  });

  it("a running ingest makes a second one unavailable, with the reason", () => {
    const panel = fontManagerPanel(document, { ingesting: true });
    for (const name of ["ingestFiles", "ingestLink"]) {
      expect(panel.actions!.find((action) => action.name === name)!.unavailable).toBe(
        "a font ingest is already running",
      );
    }
  });

  it("an ingest refusal is shown as the panel's status line", () => {
    const notice = "broken.woff2: invalid font data: WOFF2 container could not be read";
    const panel = fontManagerPanel(document, { notice });
    expect(findNode(panel, "font-manager/notice")).toMatchObject({ role: "status", value: notice });
  });

  it("an unresolved font still blocks the take by name", () => {
    const panel = fontManagerPanel(document, { unresolvedFontIds: ["inter"] });
    expect(panel.actions!.find((action) => action.name === "publish")!.unavailable).toBe(
      "unresolved font(s): Inter",
    );
  });
});
