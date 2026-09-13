// The asset manager (11.18) exposes the scene library without concealing an
// unavailable payload behind a filename or an implicit ready state.

import { describe, expect, it } from "vitest";

import type { SceneDocument, SceneObject } from "@grapix/contracts";
import { findNode } from "../src/agent-surface";
import { assetManagerPanel, assetUsers } from "../src/asset-manager";

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

function scene(objects: SceneObject[], assets: unknown[], materials: unknown[] = []): SceneDocument {
  return {
    id: "scene",
    name: "Asset test",
    version: 1,
    canvas: { width: 1920, height: 1080, frameRate: { num: 50, den: 1 } },
    timeline: { durationFrames: 1 },
    dataContext: {},
    fonts: [],
    objects,
    assets,
    materials,
  } as unknown as SceneDocument;
}

const ready = {
  assetId: "logo",
  name: "Logo",
  kind: "image",
  path: "branding/logo.png",
  checksum: "a".repeat(64),
  status: "ready",
};

const importing = {
  assetId: "lower-third",
  name: "Lower third",
  kind: "svg",
  path: "graphics/lower-third.svg",
  status: "importing",
};

describe("asset manager library addresses", () => {
  it("shows the distinct store and library addresses", () => {
    const panel = assetManagerPanel(scene([], [ready]));

    expect(findNode(panel, "asset/logo/content-hash")!.label).toBe("Content hash (store address)");
    expect(findNode(panel, "asset/logo/content-hash")!.value).toBe(ready.checksum);
    expect(findNode(panel, "asset/logo/path")!.label).toBe(
      "Project-relative path (library address)",
    );
    expect(findNode(panel, "asset/logo/path")!.value).toBe(ready.path);
  });

  it("distinguishes an importing declared asset from an available one", () => {
    const panel = assetManagerPanel(scene([], [ready, importing]));

    expect(findNode(panel, "asset/logo/availability")!.value).toBe("ready — bytes are available");
    expect(findNode(panel, "asset/lower-third/availability")!.value).toBe(
      "importing — declared but bytes have not arrived",
    );
    expect(findNode(panel, "asset/lower-third/content-hash")!.value).toBe(
      "not available — no content hash has arrived",
    );
  });

  it("says when an asset is used by no objects", () => {
    const panel = assetManagerPanel(scene([], [ready]));

    expect(findNode(panel, "asset/logo/usage")!.value).toBe("used by no objects");
  });
});

describe("asset usage is read from every documented reference path", () => {
  it("returns image, mesh model, and material texture users in document order", () => {
    const image = { type: "image", ...base("image"), assetId: "logo", fit: "contain" };
    const mesh = {
      type: "mesh",
      ...base("mesh"),
      meshKind: "model",
      depth: 0,
      modelAssetId: "logo",
      animationLoop: false,
    };
    const textured = {
      type: "rect",
      ...base("textured"),
      cornerRadius: 0,
      materialSlots: { surface: { materialId: "brand" } },
    };
    const document = scene(
      [image, mesh, textured] as unknown as SceneObject[],
      [ready],
      [{ materialId: "brand", textures: [{ slot: "baseColor", assetId: "logo" }] }],
    );

    expect(assetUsers(document, "logo")).toEqual(["image", "mesh", "textured"]);
    expect(findNode(assetManagerPanel(document), "asset/logo/usage")!.value).toBe(
      "used by 3 object(s): image, mesh, textured",
    );
  });
});
