// The Library panel (Figma B13; rows 11.18, 11.39, 11.52, 11.122): what the cards, the filters and the selected asset say, and what is shown as waiting.

import { describe, expect, it } from "vitest";

import type { SceneDocument, SceneObject } from "@grapix/contracts";
import { agentView, findNode, type UiNode } from "../src/agent-surface";
import { FONT_ASSET_RELINK_UNAVAILABLE } from "../src/asset-manager";
import {
  LIBRARY_WAITS,
  cardTag,
  libraryEntries,
  libraryPanel,
  projectAssetUsage,
  shortHash,
  sizeWords,
  usageKey,
  type LibraryState,
} from "../src/library";

const base = (id: string): Record<string, unknown> => ({
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
});

const imageObject = (id: string, assetId: string): SceneObject => ({ ...base(id), type: "image", assetId }) as unknown as SceneObject;

function scene(objects: SceneObject[], assets: unknown[], name = "Library test", id = "scene"): SceneDocument {
  return {
    id,
    name,
    version: 1,
    canvas: { width: 1920, height: 1080, frameRate: { num: 50, den: 1 } },
    timeline: { durationFrames: 1 },
    dataContext: {},
    fonts: [],
    objects,
    assets,
    materials: [],
  } as unknown as SceneDocument;
}

const hashA = "a".repeat(64);
const hashB = "b".repeat(64);
const hashC = "c".repeat(64);

const logo = {
  assetId: "logo",
  name: "Logo",
  kind: "image",
  path: "branding/logo.png",
  checksum: hashA,
  mimeType: "image/png",
  sizeBytes: 524288n,
  status: "ready",
  provenance: { origin: "human", tool: { name: "GrapiX asset import", version: "0.1.0" }, sources: ["logo.png"] },
};
const backdrop = { ...logo, assetId: "backdrop", name: "Backdrop", checksum: hashB, path: "assets/images/b.png", sizeBytes: 2048n };
const gone = { ...logo, assetId: "gone", name: "Gone", checksum: hashC, path: "assets/images/gone.png", status: "missing" };
const arriving = { assetId: "lower-third", name: "Lower third", kind: "svg", path: "graphics/lower-third.svg", status: "importing", provenance: { sources: [] } };

const project = (library: unknown[], extra: Partial<LibraryState> = {}): LibraryState =>
  ({ project: "news", projectLibrary: library as never, projectStored: new Set(library.map((a) => (a as { checksum?: string }).checksum).filter((h): h is string => h !== undefined)), ...extra });

const ids = (node: UiNode): string[] => [node.id, ...(node.children ?? []).flatMap(ids)];
const cardIds = (panel: UiNode): string[] => findNode(panel, "asset-manager/list")!.children!.map((c) => c.id);

describe("which assets the Library lists", () => {
  it("lists the project's assets, then any the open graphic holds that the project does not yet", () => {
    const document = scene([], [logo, arriving]);
    const entries = libraryEntries(document, project([logo, backdrop]));
    expect(entries.map((e) => [e.asset.assetId, e.inScene])).toEqual([
      ["logo", true],
      ["backdrop", false],
      ["lower-third", true],
    ]);
  });

  it("lists only the graphic's own assets when it is not in a project", () => {
    expect(libraryEntries(scene([], [logo]), { projectLibrary: [backdrop] as never }).map((e) => e.asset.assetId)).toEqual(["logo"]);
  });

  it("treats the same file under another asset id as the same asset: usage is by content", () => {
    const sameFile = { ...logo, assetId: "logo-2" };
    expect(usageKey(sameFile)).toBe(usageKey(logo));
    expect(libraryEntries(scene([], [sameFile]), project([logo])).map((e) => [e.asset.assetId, e.inScene])).toEqual([["logo", true]]);
  });
});

describe("the state tag on a card", () => {
  const usage = new Map([[hashA, [{ sceneId: "s1", name: "One" }, { sceneId: "s2", name: "Two" }]], [hashB, [{ sceneId: "s1", name: "One" }]]]);

  it("says how many scenes use it, or Unused, once the project's scenes have been read", () => {
    expect(cardTag(logo as never, usage)).toEqual({ text: "2 scenes", tone: "ok" });
    expect(cardTag(backdrop as never, usage)).toEqual({ text: "1 scene", tone: "ok" });
    expect(cardTag({ ...logo, checksum: "d".repeat(64) } as never, usage)).toEqual({ text: "Unused", tone: "warn" });
  });

  it("says nothing about usage before the scenes have been read: no tag beats a wrong tag", () => {
    expect(cardTag(logo as never, undefined)).toBeUndefined();
  });

  it("names a missing, broken, unsupported or arriving asset ahead of any usage", () => {
    expect(cardTag(gone as never, usage)).toEqual({ text: "Missing", tone: "danger" });
    expect(cardTag({ ...logo, status: "error" } as never, usage)).toEqual({ text: "Error", tone: "danger" });
    expect(cardTag({ ...logo, status: "unsupported" } as never, usage)).toEqual({ text: "Unsupported", tone: "warn" });
    expect(cardTag(arriving as never, usage)).toEqual({ text: "Importing", tone: "neutral" });
  });
});

describe("what each stored scene uses", () => {
  const drawn = scene([imageObject("o", "logo")], [logo], "Drawn", "s-drawn");
  const declaredOnly = scene([], [logo, backdrop], "Declared", "s-declared");
  const sameFileOtherId = scene([imageObject("o", "logo-2")], [{ ...logo, assetId: "logo-2" }], "Other id", "s-other");

  it("counts a scene only when an object draws the asset, not when it merely declares it", () => {
    const usage = projectAssetUsage([
      { sceneId: "s-drawn", name: "Drawn", document: drawn },
      { sceneId: "s-declared", name: "Declared", document: declaredOnly },
    ]);
    expect(usage.get(hashA)?.map((s) => s.sceneId)).toEqual(["s-drawn"]);
    expect(usage.get(hashB)).toBeUndefined();
  });

  it("counts a scene once even when it holds the same file twice under two asset ids", () => {
    const twice = scene(
      [imageObject("a", "logo"), imageObject("b", "logo-2")],
      [logo, { ...logo, assetId: "logo-2" }],
      "Twice",
      "s-twice",
    );
    expect(projectAssetUsage([{ sceneId: "s-twice", name: "Twice", document: twice }]).get(hashA)).toEqual([{ sceneId: "s-twice", name: "Twice" }]);
  });

  it("joins the same file under different asset ids in different scenes", () => {
    const usage = projectAssetUsage([
      { sceneId: "s-drawn", name: "Drawn", document: drawn },
      { sceneId: "s-other", name: "Other id", document: sameFileOtherId },
    ]);
    expect(usage.get(hashA)?.map((s) => s.name)).toEqual(["Drawn", "Other id"]);
  });
});

describe("the filter row", () => {
  const document = scene([imageObject("o", "logo")], [logo]);
  const library = [logo, backdrop, gone];
  const usage = new Map([[hashA, [{ sceneId: "s", name: "S" }]]]);

  it("counts All, This scene, Unused and Missing, and leaves Unused uncounted until the scenes are read", () => {
    const before = libraryPanel(document, project(library));
    expect(findNode(before, "library/filter/all")!.value).toBe("3");
    expect(findNode(before, "library/filter/scene")!.value).toBe("1");
    expect(findNode(before, "library/filter/missing")!.value).toBe("1");
    expect(findNode(before, "library/filter/unused")!.value).toBeUndefined();
    expect(findNode(before, "library/filter/unused")!.actions![0]!.unavailable).toBe("the project's scenes are still being read");

    const after = libraryPanel(document, project(library, { usage }));
    expect(findNode(after, "library/filter/unused")!.value).toBe("1");
    expect(findNode(after, "library/filter/unused")!.actions![0]!.unavailable).toBeUndefined();
  });

  it("shows the cards each filter keeps; a missing asset is never counted as unused", () => {
    const shown = (filter: "all" | "scene" | "unused" | "missing") => cardIds(libraryPanel(document, project(library, { usage, filter })));
    expect(shown("all")).toEqual(["asset/logo", "asset/backdrop", "asset/gone"]);
    expect(shown("scene")).toEqual(["asset/logo"]);
    expect(shown("unused")).toEqual(["asset/backdrop"]);
    expect(shown("missing")).toEqual(["asset/gone"]);
    expect(findNode(libraryPanel(document, project(library, { usage, filter: "missing" })), "library/filter/missing")!.selected).toBe(true);
  });

  it("says why the grid is empty", () => {
    expect(findNode(libraryPanel(scene([], []), {}), "asset-manager/list")!.description).toBe("no assets yet: import files to start the library");
    expect(findNode(libraryPanel(document, project([logo], { usage, filter: "missing" })), "asset-manager/list")!.description).toBe("no asset matches this filter");
  });
});

describe("the tabs and the folder column that wait for rows", () => {
  const panel = libraryPanel(scene([], [logo]), project([logo]));
  const action = (id: string) => findNode(panel, id)!.actions![0]!;

  it("shows Assets selected, Colours, Layer styles, Fonts and Text styles working, and Backgrounds dimmed with the row", () => {
    expect(findNode(panel, "library/tab/assets")!.selected).toBe(true);
    expect(action("library/tab/fonts").unavailable).toBeUndefined();
    expect(action("library/tab/text-styles").unavailable).toBeUndefined();
    expect(action("library/tab/colours").unavailable).toBeUndefined();
    expect(action("library/tab/layer-styles").unavailable).toBeUndefined();
    expect(action("library/tab/backgrounds").unavailable).toBe(LIBRARY_WAITS.backgrounds);
    expect(LIBRARY_WAITS.backgrounds).toContain("11.122");
  });

  it("lists only All assets until the project's folders are read: New folder waits, Import folder does not", () => {
    const folders = findNode(panel, "library/folders")!;
    expect(folders.children!.map((c) => [c.label, c.value])).toEqual([["All assets", "1"]]);
    expect(folders.description).toBe("reading the project's folders…");
    expect(folders.actions!.map((a) => [a.name, a.unavailable])).toEqual([
      ["newFolder", "the project's folders have not been read"],
      ["importFolder", undefined],
    ]);
    expect(findNode(panel, "library/folders-note")!.value).toContain("stay where they are on disk");
  });

  it("offers an agent the same unavailable reasons a person sees", () => {
    const view = agentView(panel);
    const find = (node: typeof view, id: string): typeof view | undefined => (node.id === id ? node : node.children.map((c) => find(c, id)).find(Boolean));
    expect(find(view, "library/tab/backgrounds")!.actions[0]).toMatchObject({ available: false, unavailableReason: LIBRARY_WAITS.backgrounds });
  });
});

describe("the selected asset", () => {
  const document = scene([imageObject("o", "logo")], [logo]);
  const usage = new Map([[hashA, [{ sceneId: "s-one", name: "Final Four L3" }, { sceneId: "s-two", name: "Scorebug" }]]]);
  const selected = (assetId: string, extra: Partial<LibraryState> = {}, doc = document) =>
    libraryPanel(doc, project([logo, backdrop, gone, arriving], { selectedAssetId: assetId, usage, ...extra }));

  it("says nothing is selected until an asset is", () => {
    const detail = findNode(libraryPanel(document, project([logo])), "library/detail")!;
    expect(detail.label).toBe("Selected asset");
    expect(detail.children).toBeUndefined();
  });

  it("shows its path, size, status and a short fingerprint with the whole hash in the tooltip", () => {
    const panel = selected("logo");
    expect(findNode(panel, "library/detail")!.label).toBe("Logo");
    expect(findNode(panel, "asset/logo/path")!.value).toBe("branding/logo.png");
    expect(findNode(panel, "asset/logo/size")!.value).toBe("512 KB · image/png");
    expect(findNode(panel, "asset/logo/availability")!.value).toBe("ready — bytes are available");
    expect(findNode(panel, "asset/logo/content-hash")!.value).toBe("aaaa…aaaa");
    expect(findNode(panel, "asset/logo/content-hash")!.description).toBe(hashA);
  });

  it("lists the scenes that use it, with their ids", () => {
    const list = findNode(selected("logo"), "asset/logo/used-by-list")!;
    expect(list.children!.map((c) => [c.label, c.value])).toEqual([["Final Four L3", "s-one"], ["Scorebug", "s-two"]]);
  });

  it("says it is still reading the scenes, and when no stored scene uses it", () => {
    const reading = libraryPanel(document, project([logo], { selectedAssetId: "logo" }));
    expect(findNode(reading, "asset/logo/used-by")!.value).toBe("reading the project's scenes…");
    const none = libraryPanel(document, project([logo, backdrop], { selectedAssetId: "backdrop", usage }));
    expect(findNode(none, "asset/backdrop/used-by")!.value).toBe("no stored scene uses it");
  });

  it("says what this graphic does with it", () => {
    expect(findNode(selected("logo"), "asset/logo/usage")!.value).toBe("this graphic: 1 object(s): o");
    expect(findNode(selected("backdrop"), "asset/backdrop/usage")!.value).toBe("this graphic does not declare it");
    const declaredOnly = scene([], [logo]);
    expect(findNode(selected("logo", {}, declaredOnly), "asset/logo/usage")!.value).toBe("this graphic declares it and draws nothing with it");
  });

  it("shows what an import recorded and never guesses what nobody did (11.39)", () => {
    const panel = selected("logo");
    expect(findNode(panel, "asset/logo/provenance/origin")!.value).toBe("human");
    expect(findNode(panel, "asset/logo/provenance/tool")!.value).toBe("GrapiX asset import 0.1.0");
    expect(findNode(panel, "asset/logo/provenance/sources")!.value).toBe("logo.png");
    expect(findNode(panel, "asset/logo/provenance/approval")!.value).toBe("not approved");
    const arrivingPanel = selected("lower-third");
    expect(findNode(arrivingPanel, "asset/lower-third/provenance/origin")!.value).toBe("not recorded");
    expect(findNode(arrivingPanel, "asset/lower-third/provenance/license-class")!.value).toBe("not recorded");
    expect(findNode(arrivingPanel, "asset/lower-third/content-hash")!.value).toBe("not available");
  });

  it("states where its bytes live", () => {
    expect(findNode(selected("logo"), "asset/logo/storage")!.value).toBe("in project news");
    const alone = libraryPanel(document, { selectedAssetId: "logo" });
    expect(findNode(alone, "asset/logo/storage")!.value).toMatch(/^import cache only: save this scene into a project/);
    expect(alone.description).toContain("independent scene, not in a project");
  });
});

describe("the selected asset's actions", () => {
  const document = scene([imageObject("o", "logo")], [logo]);
  const actions = (assetId: string, extra: Partial<LibraryState> = {}, doc = document) =>
    findNode(libraryPanel(doc, project([logo, backdrop], { selectedAssetId: assetId, ...extra })), "library/detail")!.actions!;
  const named = (list: readonly { name: string }[], name: string) => list.find((a) => a.name === name) as { unavailable?: string } | undefined;

  it("replaces a file the graphic holds, and waits for a running import", () => {
    expect(named(actions("logo"), "relink")!.unavailable).toBeUndefined();
    expect(named(actions("logo", { importing: true }), "relink")!.unavailable).toBe("an import is already running");
  });

  it("will not replace a font here, nor a project asset the graphic does not hold yet", () => {
    const fontFile = { ...logo, assetId: "inter", name: "inter.woff2", kind: "font", checksum: hashC };
    const withFont = scene([], [fontFile]);
    const fontActions = findNode(libraryPanel(withFont, project([fontFile], { selectedAssetId: "inter" })), "library/detail")!.actions!;
    expect(named(fontActions, "relink")!.unavailable).toBe(FONT_ASSET_RELINK_UNAVAILABLE);
    expect(named(actions("backdrop"), "relink")!.unavailable).toContain("add it to this scene first");
  });

  it("offers Add to scene for a project asset the graphic does not hold, and refuses an id it already has", () => {
    expect(named(actions("backdrop"), "addToScene")!.unavailable).toBeUndefined();
    expect(named(actions("logo"), "addToScene")).toBeUndefined();
    const clash = { ...backdrop, assetId: "logo" };
    const clashPanel = libraryPanel(document, project([clash], { selectedAssetId: "logo" }));
    expect(named(findNode(clashPanel, "library/detail")!.actions!, "addToScene")!.unavailable).toBe("this scene already has an asset with id logo");
  });

  it("shows Reveal in folder as waiting for a shell command", () => {
    expect(named(actions("logo"), "reveal")!.unavailable).toBe(LIBRARY_WAITS.reveal);
  });
});

describe("previews, notices and the panel as a whole", () => {
  const document = scene([], [logo]);

  it("shows a thumbnail when one is ready, and says why there is none: never an empty box", () => {
    const ready = libraryPanel(document, { previews: new Map([[hashA, { kind: "ready", src: "data:image/png;base64,AAAA" }]]) });
    expect(findNode(ready, "asset/logo")!.image).toEqual({ src: "data:image/png;base64,AAAA", alt: "Preview of Logo" });

    const loading = libraryPanel(document, { previews: new Map([[hashA, { kind: "loading" }]]) });
    expect(findNode(loading, "asset/logo/preview")!.value).toBe("loading…");

    const refused = libraryPanel(document, { previews: new Map([[hashA, { kind: "unavailable", reason: "no decoder in this window" }]]) });
    expect(findNode(refused, "asset/logo")!.image).toBeUndefined();
    expect(findNode(refused, "asset/logo/preview")!.value).toBe("unavailable — no decoder in this window");
  });

  it("never repeats an id, even for the selected asset's preview", () => {
    const panel = libraryPanel(document, { selectedAssetId: "logo", previews: new Map([[hashA, { kind: "loading" }]]) });
    const all = ids(panel);
    expect(new Set(all).size).toBe(all.length);
    expect(findNode(panel, "library/detail/preview")!.value).toBe("loading…");
  });

  it("offers Import files, and waits for a running import", () => {
    expect(libraryPanel(document).actions![0]).toEqual({ name: "importFiles", label: "Import files…" });
    expect(libraryPanel(document, { importing: true }).actions![0]!.unavailable).toBe("an asset import is already running");
  });

  it("reports an import's outcome, assets that could not be taken in, and scenes that were not counted", () => {
    const panel = libraryPanel(document, {
      notice: "Imported 2 files",
      projectProblems: ["Logo: the bytes are in neither the project nor the import cache"],
      usageProblems: ["Broken scene: scene file is not valid JSON"],
    });
    expect(findNode(panel, "asset-manager/notice")!.value).toBe("Imported 2 files");
    expect(findNode(panel, "asset-manager/problem/0")!.value).toContain("neither the project nor the import cache");
    expect(findNode(panel, "library/usage-problem/0")!.value).toBe("Broken scene: scene file is not valid JSON");
  });

  it("tones a state tag as presentation only: the words carry it", () => {
    const panel = libraryPanel(document, { usage: new Map() });
    const tag = findNode(panel, "asset/logo/tag")!;
    expect(tag.value).toBe("Unused");
    expect(tag.tone).toBe("warn");
    expect(agentView(tag)).not.toHaveProperty("tone");
  });
});

describe("words for a size and a hash", () => {
  it("writes a size in the unit a person reads", () => {
    expect(sizeWords(undefined)).toBe("not reported");
    expect(sizeWords(0)).toBe("0 B");
    expect(sizeWords(1023)).toBe("1023 B");
    expect(sizeWords(1536)).toBe("1.5 KB");
    expect(sizeWords(524288n)).toBe("512 KB");
    expect(sizeWords(5 * 1024 * 1024)).toBe("5 MB");
    expect(sizeWords(3n * 1024n ** 3n)).toBe("3 GB");
  });

  it("keeps the first and last four characters of a hash, and drops an algorithm prefix", () => {
    expect(shortHash(undefined)).toBe("not available");
    expect(shortHash("7c1e000000000000a90b")).toBe("7c1e…a90b");
    expect(shortHash("sha256:7c1e000000000000a90b")).toBe("7c1e…a90b");
    expect(shortHash("abcd")).toBe("abcd");
  });
});
