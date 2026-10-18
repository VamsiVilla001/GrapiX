// The asset manager (11.18) exposes the scene library without concealing an
// unavailable payload behind a filename or an implicit ready state.

import { describe, expect, it } from "vitest";

import type { SceneDocument, SceneObject } from "@grapix/contracts";
import { findNode } from "../src/agent-surface";
import { assetManagerPanel, assetUsers, describeVideoCodec } from "../src/asset-manager";

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

describe("asset provenance (11.39)", () => {
  it("shows what an import recorded and never guesses what nobody did", () => {
    const panel = assetManagerPanel(scene([], [ready, importing]));

    expect(findNode(panel, "asset/logo/provenance/origin")!.value).toBe("human");
    expect(findNode(panel, "asset/logo/provenance/tool")!.value).toBe("GrapiX asset import 0.1.0");
    expect(findNode(panel, "asset/logo/provenance/sources")!.value).toBe("logo.png");
    expect(findNode(panel, "asset/logo/provenance/approval")!.value).toBe("not approved");
    expect(findNode(panel, "asset/lower-third/provenance/origin")!.value).toBe("not recorded");
    expect(findNode(panel, "asset/lower-third/provenance/license-class")!.value).toBe("not recorded");
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

describe("asset previews and project ownership", () => {
  const hash = ready.checksum;
  const sceneWith = (assets: unknown[]): SceneDocument => scene([], assets);

  it("shows a thumbnail when one is ready", () => {
    const panel = assetManagerPanel(sceneWith([ready]), {
      previews: new Map([[hash, { kind: "ready", src: "data:image/png;base64,AAAA" }]]),
    });
    const card = findNode(panel, "asset/logo")!;
    expect(card.image).toEqual({ src: "data:image/png;base64,AAAA", alt: "Preview of Logo" });
    expect(findNode(panel, "asset/logo/preview")).toBeUndefined();
  });

  it("says why there is no preview, never leaves an empty box", () => {
    const loading = assetManagerPanel(sceneWith([ready]), { previews: new Map([[hash, { kind: "loading" }]]) });
    expect(findNode(loading, "asset/logo/preview")!.value).toBe("loading…");

    const refused = assetManagerPanel(sceneWith([ready]), {
      previews: new Map([[hash, { kind: "unavailable", reason: "this video cannot be decoded in this window (codec or container)" }]]),
    });
    expect(findNode(refused, "asset/logo")!.image).toBeUndefined();
    expect(findNode(refused, "asset/logo/preview")!.value).toBe(
      "unavailable — this video cannot be decoded in this window (codec or container)",
    );

    const unknown = assetManagerPanel(sceneWith([importing]));
    expect(findNode(unknown, "asset/lower-third/preview")!.value).toBe("unavailable — no content hash has arrived");
  });

  it("states where each asset's bytes live", () => {
    const independent = assetManagerPanel(sceneWith([ready]));
    expect(findNode(independent, "asset/logo/storage")!.value).toMatch(/^import cache only: save this graphic into a project/);
    expect(independent.description).toContain("independent graphic, not in a project");

    const stored = assetManagerPanel(sceneWith([ready]), { project: "news", projectStored: new Set([hash]) });
    expect(findNode(stored, "asset/logo/storage")!.value).toBe("in project news");
    expect(stored.description).toContain("kept in project news");

    const notYet = assetManagerPanel(sceneWith([ready]), { project: "news", projectStored: new Set() });
    expect(findNode(notYet, "asset/logo/storage")!.value).toBe("not in project news yet");
  });

  it("offers project assets this graphic does not use, and nothing for ones it does", () => {
    const other = { ...ready, assetId: "backdrop", name: "Backdrop", checksum: "b".repeat(64), path: "assets/images/b.png" };
    const panel = assetManagerPanel(sceneWith([ready]), {
      project: "news",
      projectStored: new Set([hash, other.checksum]),
      projectLibrary: [ready as never, other as never],
    });
    const library = findNode(panel, "asset-manager/project-library")!;
    expect(library.label).toBe("Project library · news");
    expect(library.children!.map((node) => node.id)).toEqual(["project-asset/backdrop"]);
    const action = findNode(panel, "project-asset/backdrop")!.actions![0]!;
    expect(action).toEqual({ name: "addToScene", label: "Add to graphic" });
  });

  it("refuses to add a project asset whose id the graphic already has", () => {
    const clash = { ...ready, checksum: "c".repeat(64) };
    const panel = assetManagerPanel(sceneWith([ready]), { project: "news", projectLibrary: [clash as never] });
    expect(findNode(panel, "project-asset/logo")!.actions![0]!.unavailable).toBe(
      "this graphic already has an asset with id logo",
    );
  });

  it("has no project library for an independent graphic, and reports assets that could not be taken in", () => {
    const independent = assetManagerPanel(sceneWith([ready]), { projectLibrary: [ready as never] });
    expect(findNode(independent, "asset-manager/project-library")).toBeUndefined();

    const problems = assetManagerPanel(sceneWith([ready]), {
      project: "news",
      projectProblems: ["Logo: the bytes are in neither the project nor the import cache; re-import the file"],
    });
    expect(findNode(problems, "asset-manager/problem/0")!.value).toContain("re-import the file");
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
