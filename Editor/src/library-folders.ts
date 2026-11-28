// The Library's virtual folders and Import folder (the new Figma UI, B13; plan row 11.122; the backend is codex's, messages 700 and 706).
//
// Asked of Jev and Laya before it was written (docs/evidence/figma-ui/jev-laya-library-folders.json). The decisions:
//   - a selected folder shows the assets directly in it, so the number beside the folder is the number of cards; the filter chips count the same scope;
//   - an asset is put in a folder from a "Move to" list in its card (a keyboard and an agent can use it; dragging is not built);
//   - Delete folder is dimmed, with the reason, while a folder holds anything (the backend refuses too, and nothing can be lost);
//   - Import folder shows its plan first (files, files already in the library, files skipped, the folders in it) and writes nothing until Import.
// Everything is a `UiNode`, so a person and an agent read the same description (invariant 27).

import type { LibraryFolderView } from "@grapix/contracts";

import type { UiAction, UiNode } from "./agent-surface";

/** What the Library is showing: "all", "unfiled" (assets in no folder), or one folder by its id (ids are `folder-N`, never those two words). */
export type FolderSelection = string;

/** One file the folder import would add, as the shell's plan reports it. */
export interface FolderImportFile {
  readonly relativePath: string;
  readonly checksum: string;
  /** Its content hash is already in the library: it is not added again and keeps its place. */
  readonly duplicate: boolean;
}

/** The shell's plan for importing a directory (`cmd_library_import_folder_plan`): nothing is written until it is applied with its fingerprint. */
export interface FolderImportPlan {
  readonly rootName: string;
  readonly folders: readonly string[];
  readonly files: readonly FolderImportFile[];
  readonly skipped: readonly string[];
  readonly planFingerprint: string;
}

/** A plan waiting for the designer's answer, with the directory it was made from. */
export interface PendingImport {
  readonly directory: string;
  readonly plan: FolderImportPlan;
}

/** What the shell says when a Library edit is refused. The project store reports every refused edit to a project document as "project X settings are
 *  unreadable: <reason>", which is wrong for a duplicate folder or colour name; the reason after it is what the person needs, so only that is shown. */
export function libraryRefusalWords(text: string): string {
  return text.replace(/^refused \[projectSettingsInvalid\]: project .+? settings are unreadable: /, "");
}

export const FOLDERS_NEED_PROJECT = "Folders belong to a project. This graphic is not in one yet: save it into a project first.";
export const FOLDERS_NOTE = "Folders only group the library: the files stay where they are on disk, and a graphic does not know which folder an asset is in.";

/** The folders in the order they are drawn: each folder's children right after it, siblings by name; a folder whose parent is gone is drawn as a top-level one. */
export function folderRows(view: LibraryFolderView): { id: string; name: string; depth: number }[] {
  const ids = new Set(view.folders.map((folder) => folder.id));
  const children = new Map<string | undefined, LibraryFolderView["folders"]>();
  for (const folder of view.folders) {
    const parent = folder.parentId !== undefined && ids.has(folder.parentId) ? folder.parentId : undefined;
    children.set(parent, [...(children.get(parent) ?? []), folder]);
  }
  const rows: { id: string; name: string; depth: number }[] = [];
  const seen = new Set<string>();
  const walk = (parent: string | undefined, depth: number): void => {
    const level = [...(children.get(parent) ?? [])].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.id.localeCompare(b.id));
    for (const folder of level) {
      if (seen.has(folder.id)) continue;
      seen.add(folder.id);
      rows.push({ id: folder.id, name: folder.name, depth });
      walk(folder.id, depth + 1);
    }
  };
  walk(undefined, 0);
  return rows;
}

/** The selection to draw: a folder that is no longer there falls back to All. */
export function effectiveSelection(view: LibraryFolderView | undefined, selection: FolderSelection): FolderSelection {
  if (selection === "all" || selection === "unfiled") return selection;
  return view !== undefined && view.folders.some((folder) => folder.id === selection) ? selection : "all";
}

/** `BGIS 2026 / Logos`: the folder's name under its parents'. */
export function folderPath(view: LibraryFolderView, id: string): string {
  const names: string[] = [];
  const seen = new Set<string>();
  let at: string | undefined = id;
  while (at !== undefined && !seen.has(at)) {
    seen.add(at);
    const folder = view.folders.find((candidate) => candidate.id === at);
    if (folder === undefined) break;
    names.unshift(folder.name);
    at = folder.parentId;
  }
  return names.join(" / ");
}

/** Whether an asset belongs to what is selected. An asset that is not in the project's library has no folder, so only All shows it. */
export function inFolderScope(view: LibraryFolderView | undefined, selection: FolderSelection, asset: { readonly assetId: string; readonly inProject: boolean }): boolean {
  if (selection === "all") return true;
  if (view === undefined || !asset.inProject) return false;
  const folder = view.assetFolders[asset.assetId];
  return selection === "unfiled" ? folder === undefined : folder === selection;
}

/** How many assets sit directly in each folder, and in none, counted from the assets the panel lists so the numbers and the cards agree. */
export function folderCounts(
  view: LibraryFolderView,
  assets: readonly { readonly assetId: string; readonly inProject: boolean }[],
): { byFolder: Map<string, number>; unfiled: number } {
  const byFolder = new Map<string, number>();
  let unfiled = 0;
  for (const asset of assets) {
    if (!asset.inProject) continue;
    const folder = view.assetFolders[asset.assetId];
    if (folder === undefined) unfiled += 1;
    else byFolder.set(folder, (byFolder.get(folder) ?? 0) + 1);
  }
  return { byFolder, unfiled };
}

/** Why a folder cannot be deleted now, or undefined when it can: the backend refuses too, and this says so before the click. */
export function deleteBlocker(view: LibraryFolderView, id: string, counts: ReadonlyMap<string, number>): string | undefined {
  if (view.folders.some((folder) => folder.parentId === id)) return "it holds other folders: move or delete them first";
  const held = counts.get(id) ?? 0;
  return held > 0 ? `it holds ${held} asset${held === 1 ? "" : "s"}: move ${held === 1 ? "it" : "them"} out first` : undefined;
}

/** The folder column: All assets, the folders nested, Unfiled; and what can be done with the selected folder. */
export function foldersNode(
  view: LibraryFolderView | undefined,
  selection: FolderSelection,
  assets: readonly { readonly assetId: string; readonly inProject: boolean }[],
  options: { readonly project: boolean; readonly busy: boolean; readonly problem?: string },
): UiNode {
  const all: UiNode = {
    id: "library/folder/all",
    role: "listitem",
    label: "All assets",
    value: String(assets.length),
    selected: selection === "all",
    actions: [{ name: "folder", label: `All assets · ${assets.length}` }],
  };
  const importAction: UiAction = {
    name: "importFolder",
    label: "Import folder…",
    ...(!options.project ? { unavailable: FOLDERS_NEED_PROJECT } : options.busy ? { unavailable: "an import is already running" } : {}),
  };
  if (view === undefined) {
    return {
      id: "library/folders",
      role: "list",
      label: "Folders",
      description: options.project ? (options.problem ?? "reading the project's folders…") : FOLDERS_NEED_PROJECT,
      children: [all],
      actions: [
        { name: "newFolder", label: "+ New folder", unavailable: options.project ? "the project's folders have not been read" : FOLDERS_NEED_PROJECT },
        importAction,
      ],
    };
  }
  const { byFolder, unfiled } = folderCounts(view, assets);
  const children: UiNode[] = [all];
  for (const row of folderRows(view)) {
    const count = byFolder.get(row.id) ?? 0;
    children.push({
      id: `library/folder/${row.id}`,
      role: "listitem",
      label: row.name,
      level: row.depth + 1,
      value: String(count),
      selected: selection === row.id,
      actions: [{ name: "folder", label: `${row.name} · ${count}` }],
    });
  }
  children.push({
    id: "library/folder/unfiled",
    role: "listitem",
    label: "Unfiled",
    value: String(unfiled),
    selected: selection === "unfiled",
    actions: [{ name: "folder", label: `Unfiled · ${unfiled}` }],
  });
  const chosen = selection !== "all" && selection !== "unfiled" ? selection : undefined;
  const none = "select a folder first";
  const blocker = chosen === undefined ? none : deleteBlocker(view, chosen, byFolder);
  return {
    id: "library/folders",
    role: "list",
    label: "Folders",
    description: options.problem ?? (view.folders.length === 0 ? "no folders yet: make one, or import a folder" : `${view.folders.length} folder(s)`),
    children,
    actions: [
      { name: "newFolder", label: chosen === undefined ? "+ New folder" : "+ New folder inside" },
      { name: "renameFolder", label: "Rename", ...(chosen === undefined ? { unavailable: none } : {}) },
      { name: "deleteFolder", label: "Delete folder", ...(blocker === undefined ? {} : { unavailable: blocker }) },
      importAction,
    ],
  };
}

/** The "Move to" list of a selected asset: Unfiled and every folder, the current place marked. */
export function moveToNode(view: LibraryFolderView, assetId: string): UiNode {
  const current = view.assetFolders[assetId];
  const place = (id: string | undefined, label: string): UiNode => ({
    id: `library/move/${id ?? "unfiled"}`,
    role: "listitem",
    label,
    selected: current === id,
    actions: [{ name: "moveTo", label, ...(current === id ? { unavailable: "it is already there" } : {}) }],
  });
  return {
    id: "library/detail/move-to",
    role: "list",
    label: "Move to",
    children: [place(undefined, "Unfiled"), ...folderRows(view).map((row) => place(row.id, folderPath(view, row.id)))],
  };
}

/** The plan the designer reviews before anything is written. */
export function importPlanNode(pending: PendingImport, busy: boolean): UiNode {
  const { plan } = pending;
  const fresh = plan.files.filter((file) => !file.duplicate);
  const duplicates = plan.files.length - fresh.length;
  const children: UiNode[] = [
    { id: "library/import/files", role: "status", label: "To import", value: fresh.length === 0 ? "no new files" : `${fresh.length} new file${fresh.length === 1 ? "" : "s"}` },
    { id: "library/import/duplicates", role: "status", label: "Already in the library", value: duplicates === 0 ? "none" : `${duplicates} (they keep their place)` },
    {
      id: "library/import/folders",
      role: "status",
      label: "Folders in it",
      value: plan.folders.length === 0 ? "none" : plan.folders.join(", "),
    },
    { id: "library/import/skipped", role: "status", label: "Skipped", value: plan.skipped.length === 0 ? "none" : plan.skipped.join(", ") },
  ];
  return {
    id: "library/import",
    role: "region",
    label: `Import folder: ${plan.rootName}`,
    description: "Nothing is written until you choose Import.",
    children,
    actions: [
      {
        name: "importApply",
        label: fresh.length === 0 ? "Import" : `Import ${fresh.length} file${fresh.length === 1 ? "" : "s"}`,
        ...(fresh.length === 0 ? { unavailable: "every file in it is already in the library" } : busy ? { unavailable: "an import is already running" } : {}),
      },
      { name: "importCancel", label: "Cancel" },
    ],
  };
}
