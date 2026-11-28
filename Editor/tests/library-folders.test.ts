// The Library's virtual folders and Import folder (Figma B13; row 11.122): how the folder column, the folder scope, the Move to list and the import review read.

import { describe, expect, it } from "vitest";

import type { AssetLibraryItem, LibraryFolderView, SceneDocument } from "@grapix/contracts";
import { findNode } from "../src/agent-surface";
import { libraryPanel } from "../src/library";
import {
  FOLDERS_NEED_PROJECT,
  libraryRefusalWords,
  deleteBlocker,
  effectiveSelection,
  folderCounts,
  folderPath,
  folderRows,
  foldersNode,
  importPlanNode,
  inFolderScope,
  moveToNode,
  type FolderImportPlan,
} from "../src/library-folders";

const view = (
  folders: { id: string; name: string; parentId?: string }[],
  assetFolders: Record<string, string> = {},
): LibraryFolderView => ({ folders: folders.map((folder) => ({ ...folder, assetCount: 0 })), assetFolders, unfiledCount: 0 }) as LibraryFolderView;

const tree = view(
  [
    { id: "folder-2", name: "Logos", parentId: "folder-1" },
    { id: "folder-1", name: "BGIS 2026" },
    { id: "folder-3", name: "Backdrops", parentId: "folder-1" },
    { id: "folder-4", name: "Audio" },
  ],
  { logo: "folder-2", plate: "folder-2", sky: "folder-3" },
);
const listed = [
  { assetId: "logo", inProject: true },
  { assetId: "plate", inProject: true },
  { assetId: "sky", inProject: true },
  { assetId: "loose", inProject: true },
  { assetId: "sceneonly", inProject: false },
];

describe("the folders in the order they are drawn", () => {
  it("puts each folder's children right after it, siblings by name, with their depth", () => {
    expect(folderRows(tree)).toEqual([
      { id: "folder-4", name: "Audio", depth: 0 },
      { id: "folder-1", name: "BGIS 2026", depth: 0 },
      { id: "folder-3", name: "Backdrops", depth: 1 },
      { id: "folder-2", name: "Logos", depth: 1 },
    ]);
  });

  it("draws a folder whose parent is gone as a top-level one, and never loops on a cycle", () => {
    const orphan = view([{ id: "a", name: "Orphan", parentId: "missing" }]);
    expect(folderRows(orphan)).toEqual([{ id: "a", name: "Orphan", depth: 0 }]);
    const cycle = view([
      { id: "a", name: "A", parentId: "b" },
      { id: "b", name: "B", parentId: "a" },
    ]);
    expect(folderRows(cycle)).toEqual([]);
  });

  it("names a folder under its parents", () => {
    expect(folderPath(tree, "folder-2")).toBe("BGIS 2026 / Logos");
    expect(folderPath(tree, "folder-4")).toBe("Audio");
    expect(folderPath(tree, "gone")).toBe("");
  });
});

describe("what is selected", () => {
  it("falls back to All when the selected folder is gone or the folders were not read", () => {
    expect(effectiveSelection(tree, "folder-2")).toBe("folder-2");
    expect(effectiveSelection(tree, "folder-99")).toBe("all");
    expect(effectiveSelection(undefined, "folder-2")).toBe("all");
    expect(effectiveSelection(undefined, "unfiled")).toBe("unfiled");
  });

  it("shows a folder's own assets only, Unfiled the project's assets in no folder, and All everything", () => {
    const shows = (selection: string, assetId: string, inProject = true) => inFolderScope(tree, selection, { assetId, inProject });
    expect(shows("folder-2", "logo")).toBe(true);
    expect(shows("folder-2", "sky")).toBe(false);
    expect(shows("folder-1", "logo")).toBe(false); // direct only: BGIS 2026 holds Logos, not the logo
    expect(shows("unfiled", "loose")).toBe(true);
    expect(shows("unfiled", "logo")).toBe(false);
    expect(shows("all", "sceneonly", false)).toBe(true);
  });

  it("never files an asset only the open graphic has: it is in All and nowhere else", () => {
    expect(inFolderScope(tree, "unfiled", { assetId: "sceneonly", inProject: false })).toBe(false);
    expect(inFolderScope(tree, "folder-2", { assetId: "sceneonly", inProject: false })).toBe(false);
  });

  it("shows only All before the folders are read", () => {
    expect(inFolderScope(undefined, "unfiled", { assetId: "x", inProject: true })).toBe(false);
  });
});

describe("the counts beside the folders", () => {
  it("count direct members of the assets the panel lists, so the numbers and the cards agree", () => {
    const { byFolder, unfiled } = folderCounts(tree, listed);
    expect(byFolder.get("folder-2")).toBe(2);
    expect(byFolder.get("folder-3")).toBe(1);
    expect(byFolder.get("folder-1")).toBeUndefined();
    expect(unfiled).toBe(1); // "loose"; "sceneonly" is not in the project
  });
});

describe("deleting a folder", () => {
  const { byFolder } = folderCounts(tree, listed);

  it("is dimmed with the reason while the folder holds folders or assets", () => {
    expect(deleteBlocker(tree, "folder-1", byFolder)).toBe("it holds other folders: move or delete them first");
    expect(deleteBlocker(tree, "folder-2", byFolder)).toBe("it holds 2 assets: move them out first");
    expect(deleteBlocker(tree, "folder-3", byFolder)).toBe("it holds 1 asset: move it out first");
  });

  it("is possible for an empty folder", () => {
    expect(deleteBlocker(tree, "folder-4", byFolder)).toBeUndefined();
  });
});

describe("the folder column", () => {
  const options = { project: true, busy: false } as const;
  const column = (selection: string) => foldersNode(tree, selection, listed, options);
  const action = (node: ReturnType<typeof column>, name: string) => node.actions!.find((a) => a.name === name)!;

  it("lists All assets, the folders nested with their counts, then Unfiled", () => {
    const node = column("all");
    expect(node.children!.map((c) => [c.label, c.level, c.value])).toEqual([
      ["All assets", undefined, "5"],
      ["Audio", 1, "0"],
      ["BGIS 2026", 1, "0"],
      ["Backdrops", 2, "1"],
      ["Logos", 2, "2"],
      ["Unfiled", undefined, "1"],
    ]);
    expect(node.children!.find((c) => c.selected)!.label).toBe("All assets");
  });

  it("marks the selected folder and addresses it by id", () => {
    const node = column("folder-2");
    expect(node.children!.filter((c) => c.selected).map((c) => c.id)).toEqual(["library/folder/folder-2"]);
    expect(findNode(node, "library/folder/folder-2")!.actions![0]).toEqual({ name: "folder", label: "Logos · 2" });
  });

  it("dims Rename and Delete until a folder is selected, and says to select one", () => {
    const node = column("all");
    expect(action(node, "renameFolder").unavailable).toBe("select a folder first");
    expect(action(node, "deleteFolder").unavailable).toBe("select a folder first");
    expect(action(node, "newFolder")).toEqual({ name: "newFolder", label: "+ New folder" });
    expect(action(column("unfiled"), "renameFolder").unavailable).toBe("select a folder first");
  });

  it("offers Rename, and Delete only for an empty folder, and makes the new folder inside the selected one", () => {
    const empty = column("folder-4");
    expect(action(empty, "renameFolder").unavailable).toBeUndefined();
    expect(action(empty, "deleteFolder").unavailable).toBeUndefined();
    expect(action(empty, "newFolder").label).toBe("+ New folder inside");
    expect(action(column("folder-2"), "deleteFolder").unavailable).toBe("it holds 2 assets: move them out first");
  });

  it("says when there are no folders yet", () => {
    const none = foldersNode(view([]), "all", listed, options);
    expect(none.description).toBe("no folders yet: make one, or import a folder");
    expect(none.children!.map((c) => c.label)).toEqual(["All assets", "Unfiled"]);
  });

  it("says why a graphic outside a project has no folders, and dims New folder and Import folder with that reason", () => {
    const node = foldersNode(undefined, "all", listed, { project: false, busy: false });
    expect(node.description).toBe(FOLDERS_NEED_PROJECT);
    expect(action(node, "newFolder").unavailable).toBe(FOLDERS_NEED_PROJECT);
    expect(action(node, "importFolder").unavailable).toBe(FOLDERS_NEED_PROJECT);
  });

  it("says what went wrong when the folders could not be read, and dims Import folder while an import runs", () => {
    const failed = foldersNode(undefined, "all", listed, { project: true, busy: false, problem: "project folders unreadable: disk error" });
    expect(failed.description).toBe("project folders unreadable: disk error");
    expect(foldersNode(tree, "all", listed, { project: true, busy: true }).actions!.find((a) => a.name === "importFolder")!.unavailable).toBe("an import is already running");
  });
});

describe("the Move to list", () => {
  it("offers Unfiled and every folder by its path, marks where the asset is, and dims that place", () => {
    const node = moveToNode(tree, "logo");
    expect(node.children!.map((c) => [c.id, c.label, c.selected])).toEqual([
      ["library/move/unfiled", "Unfiled", false],
      ["library/move/folder-4", "Audio", false],
      ["library/move/folder-1", "BGIS 2026", false],
      ["library/move/folder-3", "BGIS 2026 / Backdrops", false],
      ["library/move/folder-2", "BGIS 2026 / Logos", true],
    ]);
    expect(node.children!.find((c) => c.selected)!.actions![0]!.unavailable).toBe("it is already there");
    expect(node.children![0]!.actions![0]!.unavailable).toBeUndefined();
  });

  it("marks Unfiled for an asset in no folder", () => {
    expect(moveToNode(tree, "loose").children!.find((c) => c.selected)!.label).toBe("Unfiled");
  });
});

describe("the import review", () => {
  const plan = (files: FolderImportPlan["files"], extra: Partial<FolderImportPlan> = {}): { directory: string; plan: FolderImportPlan } => ({
    directory: "D:/Logos",
    plan: { rootName: "Logos", folders: ["Logos", "Logos/Teams"], files, skipped: [], planFingerprint: "sha256:abc", ...extra },
  });
  const file = (relativePath: string, duplicate = false) => ({ relativePath, checksum: `sha256:${relativePath}`, duplicate });
  const read = (node: ReturnType<typeof importPlanNode>, id: string) => findNode(node, id)!.value;

  it("counts the new files, the ones already in the library, the folders in it and what is skipped", () => {
    const node = importPlanNode(plan([file("a.png"), file("b.png"), file("c.png", true)], { skipped: ["notes.txt"] }), false);
    expect(node.label).toBe("Import folder: Logos");
    expect(node.description).toBe("Nothing is written until you choose Import.");
    expect(read(node, "library/import/files")).toBe("2 new files");
    expect(read(node, "library/import/duplicates")).toBe("1 (they keep their place)");
    expect(read(node, "library/import/folders")).toBe("Logos, Logos/Teams");
    expect(read(node, "library/import/skipped")).toBe("notes.txt");
  });

  it("offers Import with the number of new files, and Cancel", () => {
    const node = importPlanNode(plan([file("a.png"), file("b.png", true)]), false);
    expect(node.actions!.map((a) => [a.name, a.label, a.unavailable])).toEqual([
      ["importApply", "Import 1 file", undefined],
      ["importCancel", "Cancel", undefined],
    ]);
  });

  it("dims Import when every file is already in the library, or while an import runs", () => {
    expect(importPlanNode(plan([file("a.png", true)]), false).actions![0]!.unavailable).toBe("every file in it is already in the library");
    expect(importPlanNode(plan([]), false).actions![0]!.unavailable).toBe("every file in it is already in the library");
    expect(importPlanNode(plan([file("a.png")]), true).actions![0]!.unavailable).toBe("an import is already running");
  });

  it("says none when there is nothing to report", () => {
    const node = importPlanNode(plan([file("a.png")], { folders: [] }), false);
    expect(read(node, "library/import/folders")).toBe("none");
    expect(read(node, "library/import/skipped")).toBe("none");
    expect(read(node, "library/import/duplicates")).toBe("none");
  });
});

describe("the Library panel with folders", () => {
  const asset = (assetId: string, checksum: string): AssetLibraryItem =>
    ({ assetId, name: `${assetId}.png`, kind: "image", path: `assets/images/${checksum}.png`, checksum, mimeType: "image/png", sizeBytes: 100, status: "ready", provenance: { origin: "human", sources: [] } }) as unknown as AssetLibraryItem;
  const library = [asset("logo", "h1"), asset("plate", "h2"), asset("sky", "h3"), asset("loose", "h4")];
  const document = { id: "s", name: "S", version: 1, objects: [], assets: [asset("only", "h9")], fonts: [], materials: [] } as unknown as SceneDocument;
  const panel = (extra: Record<string, unknown> = {}) => libraryPanel(document, { project: "show", projectLibrary: library, folders: tree, ...extra } as never);
  const cards = (node: ReturnType<typeof panel>) => findNode(node, "asset-manager/list")!.children!.map((c) => c.id);

  it("shows only the selected folder's assets and says how many of how many", () => {
    const node = panel({ folder: "folder-2" });
    expect(cards(node)).toEqual(["asset/logo", "asset/plate"]);
    expect(findNode(node, "asset-manager/list")!.description).toBe("2 of 2 in BGIS 2026 / Logos");
  });

  it("counts the filter chips in that scope too", () => {
    const node = panel({ folder: "folder-2" });
    expect(findNode(node, "library/filter/all")!.value).toBe("2");
    expect(findNode(panel(), "library/filter/all")!.value).toBe("5");
  });

  it("shows Unfiled as the project's assets in no folder, without the asset only the graphic has", () => {
    expect(cards(panel({ folder: "unfiled" }))).toEqual(["asset/loose"]);
  });

  it("says an empty folder is empty, and how to fill it", () => {
    expect(findNode(panel({ folder: "folder-4" }), "asset-manager/list")!.description).toBe("nothing directly in this folder: choose an asset under All assets, then Move to");
  });

  it("falls back to everything when the selected folder was deleted", () => {
    expect(cards(panel({ folder: "folder-99" }))).toHaveLength(5);
  });

  it("gives a selected project asset a Move to list, and an asset only the graphic has a reason instead", () => {
    const inProject = findNode(panel({ selectedAssetId: "logo" }), "library/detail/move-to")!;
    expect(inProject.children!.find((c) => c.selected)!.label).toBe("BGIS 2026 / Logos");
    const graphicOnly = findNode(panel({ selectedAssetId: "only" }), "library/detail/move-to")!;
    expect(graphicOnly.value).toContain("not in the project's library");
    expect(graphicOnly.children).toBeUndefined();
  });

  it("draws no Move to list before the folders are read", () => {
    expect(findNode(panel({ folders: undefined, selectedAssetId: "logo" }), "library/detail/move-to")).toBeUndefined();
  });

  it("puts the import review under the folder column only while a plan is waiting", () => {
    expect(findNode(panel(), "library/import")).toBeUndefined();
    const pending = { directory: "D:/Logos", plan: { rootName: "Logos", folders: [], files: [{ relativePath: "a.png", checksum: "h", duplicate: false }], skipped: [], planFingerprint: "sha256:abc" } };
    expect(findNode(panel({ importPlan: pending }), "library/import")!.label).toBe("Import folder: Logos");
    // while a plan waits, a second Import folder is dimmed
    expect(findNode(panel({ importPlan: pending }), "library/folders")!.actions!.find((a) => a.name === "importFolder")!.unavailable).toBe("an import is already running");
  });
});

describe("what a refused Library edit says", () => {
  it("is the reason, without the project store's lead-in about unreadable settings", () => {
    const shell = 'refused [projectSettingsInvalid]: project LiveFinals7 settings are unreadable: a Library colour named "MID GREY" already exists [ed-2ae04e7c-101]';
    expect(libraryRefusalWords(shell)).toBe('a Library colour named "MID GREY" already exists [ed-2ae04e7c-101]');
    expect(libraryRefusalWords("refused [projectSettingsInvalid]: project My show 2 settings are unreadable: Library folder \"Logos\" is not empty [ed-1]")).toBe('Library folder "Logos" is not empty [ed-1]');
  });

  it("leaves any other refusal as it is", () => {
    for (const text of ["refused [projectNotFound]: no project named show [ed-3]", "The folder could not be chosen", "refused [projectSettingsInvalid]: the document is unreadable [ed-4]"]) {
      expect(libraryRefusalWords(text)).toBe(text);
    }
  });
});
