// The asset manager (11.18) exposes the scene library without concealing an
// unavailable payload behind a filename or an implicit ready state.

import { describe, expect, it } from "vitest";

import type { SceneDocument, SceneObject } from "@grapix/contracts";
import { findNode } from "../src/agent-surface";
import { libraryPanel } from "../src/library";
import {
  FONT_ASSET_RELINK_UNAVAILABLE,
  assetUsers,
  describeVideoCodec,
  planAssetRelink,
} from "../src/asset-manager";

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
  provenance: {
    origin: "human",
    tool: { name: "GrapiX asset import", version: "0.1.0" },
    sources: ["logo.png"],
  },
};

const importing = {
  assetId: "lower-third",
  name: "Lower third",
  kind: "svg",
  path: "graphics/lower-third.svg",
  status: "importing",
  provenance: { sources: [] },
};

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
    // The Library says the same, from the same function.
    expect(findNode(libraryPanel(document, { selectedAssetId: "logo" }), "asset/logo/usage")!.value).toBe(
      "this graphic: 3 object(s): image, mesh, textured",
    );
  });
});

describe("naming a video's codec", () => {
  const withCode = (code: string, at = 575, size = 2000): Uint8Array => {
    const bytes = new Uint8Array(size);
    for (let index = 0; index < code.length; index += 1) bytes[at + index] = code.charCodeAt(index);
    return bytes;
  };

  it("names ProRes, HEVC and H.264 from their sample-description codes", () => {
    expect(describeVideoCodec(withCode("ap4x"))).toBe("ProRes 4444 XQ");
    expect(describeVideoCodec(withCode("apcn"))).toBe("ProRes 422");
    expect(describeVideoCodec(withCode("hvc1"))).toBe("HEVC (H.265)");
    expect(describeVideoCodec(withCode("avc1"))).toBe("H.264");
  });

  it("finds a movie header at the tail of a large file", () => {
    const big = new Uint8Array(9 * 1024 * 1024);
    const code = "apch";
    for (let index = 0; index < code.length; index += 1) big[big.length - 100 + index] = code.charCodeAt(index);
    expect(describeVideoCodec(big)).toBe("ProRes 422 HQ");
  });

  it("says nothing rather than guessing when no known code appears", () => {
    expect(describeVideoCodec(new Uint8Array(4096))).toBeUndefined();
  });
});

describe("relinking an asset keeps its id and changes only its bytes", () => {
  const document = scene([], [ready]);
  const file = (kind: string, checksum?: string) =>
    ({ name: "new-logo.png", kind, ...(checksum === undefined ? {} : { checksum }), sizeBytes: 42 }) as never;

  it("plans new bytes for the same id", () => {
    expect(planAssetRelink(document, "logo", file("image", "b".repeat(64)))).toEqual({
      assetId: "logo",
      newHash: "b".repeat(64),
      newSize: 42,
    });
  });

  it("refuses a font: its file is replaced in the Fonts panel", () => {
    const fontFile = { ...ready, assetId: "inter", name: "inter.woff2", kind: "font" };
    const withFont = scene([], [fontFile]);
    expect(planAssetRelink(withFont, "inter", { ...fontFile, checksum: "b".repeat(64) } as never)).toEqual({
      refused: FONT_ASSET_RELINK_UNAVAILABLE,
    });
  });

  it("refuses another kind, the same bytes, no hash, or an unknown asset", () => {
    expect(planAssetRelink(document, "logo", file("video", "b".repeat(64)))).toEqual({
      refused: "Logo is image; new-logo.png is video",
    });
    expect(planAssetRelink(document, "logo", file("image", "a".repeat(64)))).toEqual({
      refused: "Logo already holds the bytes of new-logo.png",
    });
    expect(planAssetRelink(document, "logo", file("image"))).toEqual({ refused: "new-logo.png has no content hash" });
    expect(planAssetRelink(document, "nope", file("image", "b".repeat(64)))).toEqual({
      refused: "no asset nope in Asset test",
    });
  });
});
