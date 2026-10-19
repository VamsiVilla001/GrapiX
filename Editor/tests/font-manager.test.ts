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
  FONT_SAMPLE,
  fontAssignTargets,
  fontAssignUnavailable,
  fontLinkFor,
  fontManagerPanel,
  fontStatus,
  fontUpdateRefused,
  isFontRemovalRefused,
  parseFallbackFamilies,
  planFontRemoval,
  withIngestNames,
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

describe("the 1.x panel's per-font details", () => {
  const document = scene(
    [text("title", "Title", "inter")],
    [fileFont("inter", "Inter", ["inter-asset"]), fileFont("gotham", "Gotham", ["gotham-asset"])],
    [fontAsset("inter-asset"), fontAsset("gotham-asset")],
  );

  it("each font says its status, faces, source and a sample, and is loading until the registry answers", () => {
    const panel = fontManagerPanel(document);
    expect(findNode(panel, "font/inter/status")!.value).toBe("loading");
    expect(findNode(panel, "font/inter/faces")!.value).toBe("400 normal");
    expect(findNode(panel, "font/inter/source")!.value).toBe("file · package");
    expect(findNode(panel, "font/inter/sample")!.value).toBe(FONT_SAMPLE);
  });

  it("a failed face names its status and every reason; a loaded font is ready", () => {
    const panel = fontManagerPanel(document, {
      readyFontIds: ["inter"],
      problems: [
        { fontId: "gotham", faceId: "gotham-face-0", status: "Invalid", reason: "the browser could not decode gotham.woff2" },
      ],
    });
    expect(findNode(panel, "font/inter/status")!.value).toBe("ready");
    expect(findNode(panel, "font/inter/problem")).toBeUndefined();
    expect(findNode(panel, "font/gotham/status")!.value).toBe("invalid");
    expect(findNode(panel, "font/gotham/problem")!.value).toBe("the browser could not decode gotham.woff2");
  });

  it("a disabled font says so", () => {
    const disabled = { ...(fileFont("off", "Off", ["inter-asset"]) as object), enabled: false };
    expect(fontStatus(disabled as never, { readyFontIds: ["off"] }).status).toBe("disabled");
  });

  it("Replace is offered, and waits for a running ingest", () => {
    const replace = (state = {}) =>
      findNode(fontManagerPanel(document, state), "font/inter")!.actions!.find((action) => action.name === "replace")!;
    expect(replace().unavailable).toBeUndefined();
    expect(replace({ ingesting: true }).unavailable).toBe("a font ingest is already running");
  });

  it("the display name, fallbacks and enabled state are edited in place", () => {
    const panel = fontManagerPanel(document);
    expect(findNode(panel, "font/gotham/displayName")!.input).toEqual({ type: "text", value: "Gotham" });
    expect(findNode(panel, "font/gotham/fallbacks")!.input).toEqual({ type: "text", value: "Arial" });
    expect(findNode(panel, "font/gotham/enabled")!.input).toEqual({ type: "checkbox", value: "true" });
    // A font in use cannot be switched off; an unused one can.
    expect(findNode(panel, "font/inter/enabled")!.actions![0]!.unavailable).toBe(
      "Inter is used by text object(s) Title (title), so it cannot be disabled",
    );
    expect(findNode(panel, "font/gotham/enabled")!.actions![0]!.unavailable).toBeUndefined();
  });
});

describe("a font update is checked as Rust checks it", () => {
  const document = scene(
    [text("title", "Title", "inter")],
    [fileFont("inter", "Inter", ["a"]), fileFont("gotham", "Gotham", ["b"])],
    [fontAsset("a"), fontAsset("b")],
  );

  it("refuses a blank name, bad fallbacks, disabling a font in use, and no change", () => {
    expect(fontUpdateRefused(document, "nope", { enabled: true })?.refused).toBe("no font nope in Lower third");
    expect(fontUpdateRefused(document, "gotham", { displayName: "  " })?.refused).toBe("Gotham needs a display name");
    expect(fontUpdateRefused(document, "gotham", { fallbackFamilies: ["Arial", "arial"] })?.refused).toBe(
      "Gotham lists fallback arial twice",
    );
    expect(
      fontUpdateRefused(document, "gotham", { fallbackFamilies: Array.from({ length: 13 }, (_, i) => `F${i}`) })?.refused,
    ).toBe("Gotham lists 13 fallback families; at most 12");
    expect(fontUpdateRefused(document, "inter", { enabled: false })?.refused).toBe(
      "Inter is used by text object(s) Title (title), so it cannot be disabled",
    );
    expect(fontUpdateRefused(document, "gotham", { displayName: "Gotham", fallbackFamilies: ["Arial"] })?.refused).toBe(
      "nothing about Gotham would change",
    );
  });

  it("allows a real change", () => {
    expect(fontUpdateRefused(document, "gotham", { displayName: "Gotham Bold" })).toBeUndefined();
    expect(fontUpdateRefused(document, "gotham", { enabled: false })).toBeUndefined();
    expect(fontUpdateRefused(document, "inter", { fallbackFamilies: ["Helvetica", "Arial"] })).toBeUndefined();
  });

  it("reads the fallbacks box as comma-separated families", () => {
    expect(parseFallbackFamilies(" Helvetica , Arial,, sans-serif ,")).toEqual(["Helvetica", "Arial", "sans-serif"]);
    expect(parseFallbackFamilies("   ")).toEqual([]);
  });
});

describe("search and status filter", () => {
  const document = scene(
    [],
    [fileFont("inter", "Inter", ["a"]), fileFont("gotham", "Gotham", ["b"])],
    [fontAsset("a"), fontAsset("b")],
  );
  const listed = (state: Parameters<typeof fontManagerPanel>[1]) =>
    findNode(fontManagerPanel(document, state), "font-manager/list")!.children!.map((node) => node.id);

  it("narrows by name and by status, and says when nothing matches", () => {
    expect(listed({ search: "GOT" })).toEqual(["font/gotham"]);
    expect(listed({ readyFontIds: ["inter"], statusFilter: "ready" })).toEqual(["font/inter"]);
    expect(listed({ readyFontIds: ["inter"], statusFilter: "loading" })).toEqual(["font/gotham"]);
    const panel = fontManagerPanel(document, { search: "zzz" });
    expect(findNode(panel, "font-manager/no-match")!.value).toBe("No fonts match this filter");
    expect(panel.description).toBe("2 font(s) in Lower third, 0 shown");
  });

  it("a filter never hides a font from the take blocker", () => {
    const panel = fontManagerPanel(document, { search: "inter", unresolvedFontIds: ["gotham"] });
    expect(panel.actions!.find((action) => action.name === "publish")!.unavailable).toBe(
      "unresolved font(s): Gotham",
    );
  });
});

describe("assigning a font to the selected text", () => {
  const rect = { type: "rect", id: "box", name: "Box" } as unknown as SceneObject;
  const document = scene(
    [text("title", "Title", "gotham"), text("strap", "Strap", "inter"), rect],
    [fileFont("inter", "Inter", ["a"]), fileFont("gotham", "Gotham", ["b"])],
    [fontAsset("a"), fontAsset("b")],
  );
  const ready = { readyFontIds: ["inter", "gotham"] };
  const inter = document.fonts[0]!;

  it("names why it cannot run", () => {
    expect(fontAssignUnavailable(document, inter, ready)).toBe("select a text object to assign this font to");
    expect(fontAssignUnavailable(document, inter, { ...ready, selectedObjectIds: ["title", "box"] })).toBe(
      "only text takes a font; the selection also holds Box (box)",
    );
    expect(fontAssignUnavailable(document, inter, { selectedObjectIds: ["title"] })).toBe(
      "Inter is not ready (loading)",
    );
    expect(fontAssignUnavailable(document, inter, { ...ready, selectedObjectIds: ["strap"] })).toBe(
      "the selected text already uses Inter",
    );
  });

  it("changes only the selected text not already on the font", () => {
    const state = { ...ready, selectedObjectIds: ["title", "strap"] };
    expect(fontAssignUnavailable(document, inter, state)).toBeUndefined();
    expect(fontAssignTargets(document, inter, state)).toEqual(["title"]);
  });
});

describe("a font link is read under the source the author chose", () => {
  it("a Google family name becomes its stylesheet, never an Adobe kit id", () => {
    expect(fontLinkFor("google", " Roboto Slab ")).toEqual({
      link: "https://fonts.googleapis.com/css2?family=Roboto+Slab&display=swap",
    });
    expect(fontLinkFor("google", "https://fonts.googleapis.com/css2?family=Inter")).toEqual({
      link: "https://fonts.googleapis.com/css2?family=Inter",
    });
    expect(fontLinkFor("google", "https://fonts.bunny.net/css?family=inter")).toEqual({
      refused:
        "https://fonts.bunny.net/css?family=inter is not a Google Fonts stylesheet; choose CSS / @import or Direct URL for it",
    });
  });

  it("CSS takes the URL out of a link tag or an @import", () => {
    expect(fontLinkFor("css", '<link href="https://fonts.bunny.net/css?family=inter" rel="stylesheet">')).toEqual({
      link: "https://fonts.bunny.net/css?family=inter",
    });
    expect(fontLinkFor("css", "@import url('https://fonts.bunny.net/css?family=inter');")).toEqual({
      link: "https://fonts.bunny.net/css?family=inter",
    });
    expect(fontLinkFor("css", "inter")).toEqual({ refused: "inter is not a stylesheet URL" });
  });

  it("Adobe takes a kit id or a use.typekit.net URL, passed on unchanged", () => {
    expect(fontLinkFor("adobe", "dgy5lkh")).toEqual({ link: "dgy5lkh" });
    expect(fontLinkFor("adobe", "https://use.typekit.net/dgy5lkh.css")).toEqual({
      link: "https://use.typekit.net/dgy5lkh.css",
    });
    // A credential is the shell policy's to refuse, not this function's to strip.
    expect(fontLinkFor("adobe", "https://user:secret@use.typekit.net/dgy5lkh.css")).toEqual({
      link: "https://user:secret@use.typekit.net/dgy5lkh.css",
    });
    expect(fontLinkFor("adobe", "https://example.com/kit.css")).toEqual({
      refused: "https://example.com/kit.css is not an Adobe Fonts kit; Adobe serves kits from use.typekit.net",
    });
    expect(fontLinkFor("adobe", "not a kit")).toEqual({ refused: "not a kit is not an Adobe Fonts project id" });
  });

  it("a direct URL must name a font file, and nothing empty is sent", () => {
    expect(fontLinkFor("direct", "https://fonts.gstatic.com/s/inter/v1/a.woff2?x=1")).toEqual({
      link: "https://fonts.gstatic.com/s/inter/v1/a.woff2?x=1",
    });
    expect(fontLinkFor("direct", "https://example.com/fonts.css")).toEqual({
      refused: "https://example.com/fonts.css is not the URL of a .ttf, .otf, .woff or .woff2 file",
    });
    expect(fontLinkFor("css", "   ")).toEqual({ refused: "enter a font link first" });
  });
});

describe("an ingest's optional names", () => {
  it("apply the family to the font and its faces, and the display name, to every prepared font", () => {
    const [font] = withIngestNames([fileFont("x", "Inter", ["a", "b"]) as never], {
      family: " Brand Sans ",
      displayName: "Brand",
    });
    expect(font!.family).toBe("Brand Sans");
    expect(font!.faces.map((face) => face.family)).toEqual(["Brand Sans", "Brand Sans"]);
    expect(font!.displayName).toBe("Brand");
  });

  it("blank names leave the prepared font as it was", () => {
    const prepared = fileFont("x", "Inter", ["a"]) as never;
    expect(withIngestNames([prepared], { family: " ", displayName: "" })).toEqual([prepared]);
  });
});
