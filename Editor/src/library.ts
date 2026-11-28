// The Library panel (the new Figma UI, B13 Library; plan rows 11.18, 11.39, 11.52 and 11.122).
//
// The Assets panel, rebuilt in place (owner and Jev A, Laya A: docs/evidence/figma-ui/jev-laya-library-data.json): the project's assets as a grid of
// cards with the one state tag each can honestly carry, a filter row, a selected-asset card with its path, size, status, fingerprint, the scenes that use
// it and its provenance, and the tabs and the folder column of the design where each waits for a row.
//
// Drawn only where the Editor can stand behind it:
//   - the cards, filters and the selected card come from the project's assets (`AssetLibraryItem`: name, kind, path, content hash, size, availability,
//     provenance) and from the shell's project-wide usage (`cmd_project_asset_usage`, task 119, which reads the stored scenes itself); the open graphic is
//     counted as it is now, so unsaved changes show. Nothing says "2 SCENES" or "UNUSED" until the shell has answered;
//   - Fonts and Text styles bring the existing panels forward; Colours, Layer styles and Backgrounds are shown dimmed with the row that owns them (11.122);
//   - the folder tree, Import folder and dragging into a folder wait for virtual folders (row 11.122, codex task 120): only "All assets" is listed, and
//     the note says why; "Reveal in folder" waits for a shell command that shows a file in the file manager.
// It is a `UiNode` tree, so what a person reads and what an agent reads are the same description (invariant 27).

import type { AssetLibraryItem, EffectInstance, LibraryColour, LibraryFolderView, LibraryLayerStyle, SceneDocument } from "@grapix/contracts";

import type { UiNode } from "./agent-surface";
import {
  FONT_ASSET_RELINK_UNAVAILABLE,
  assetUsers,
  availability,
  previewNodes,
  provenanceCells,
  storageStatement,
  type AssetManagerState,
} from "./asset-manager";
import { COLOURS_NOTE, coloursNodes } from "./library-colours";
import { layerStylesNodes, STYLES_NOTE } from "./library-layer-styles";
import {
  FOLDERS_NOTE,
  effectiveSelection,
  folderPath,
  foldersNode,
  importPlanNode,
  inFolderScope,
  moveToNode,
  type FolderSelection,
  type PendingImport,
} from "./library-folders";

export type LibraryTab = "colours" | "text-styles" | "layer-styles" | "backgrounds" | "fonts" | "assets";
export type LibraryFilter = "all" | "scene" | "unused" | "missing";

/** A stored scene that uses an asset. */
export interface SceneUsage {
  readonly sceneId: string;
  readonly name: string;
}

export interface LibraryState extends AssetManagerState {
  readonly filter?: LibraryFilter;
  /** The scenes that use each asset, by content hash (an asset without one, by `id:<assetId>`). Absent until the project's scenes have been read. */
  readonly usage?: ReadonlyMap<string, readonly SceneUsage[]>;
  /** Stored scenes that could not be read, named: their usage is not counted, and the panel says so. */
  readonly usageProblems?: readonly string[];
  /** The project's folders and which folder each asset is in; absent until the shell has answered (or when the graphic is not in a project). */
  readonly folders?: LibraryFolderView;
  /** What the Folders list has selected: "all", "unfiled" or a folder id. */
  readonly folder?: FolderSelection;
  /** Why the project's folders could not be read. */
  readonly foldersProblem?: string;
  /** A folder import waiting for the designer to choose Import. */
  readonly importPlan?: PendingImport;
  /** The tab shown: Assets when absent. Colours has its own cards (11.122); Fonts and Text styles bring their own panels forward instead. */
  readonly tab?: LibraryTab;
  /** The project's library colours; absent until the shell has answered (or when the graphic is not in a project). */
  readonly colours?: readonly LibraryColour[];
  readonly coloursProblem?: string;
  readonly selectedColourId?: string;
  /** The project's library layer styles (11.122); absent until the shell has answered (or when the graphic is not in a project). */
  readonly layerStyles?: readonly LibraryLayerStyle[];
  readonly layerStylesProblem?: string;
  readonly selectedLayerStyleId?: string;
  /** An effect's catalogue name, for the style cards; the wire tag as words when absent. */
  readonly effectName?: (instance: EffectInstance) => string;
  /** The objects selected in the open graphic: Apply acts on them and New from fill reads the first. */
  readonly selectedObjectIds?: readonly string[];
}

/** The row that owns a tab or a control that is not built, and what it will be. */
export const LIBRARY_WAITS = {
  backgrounds: "Library backgrounds are row 11.122.",
  reveal: "Showing a file in the file manager has no shell command yet.",
} as const;

export const LIBRARY_FOLDERS_NOTE = FOLDERS_NOTE;
export const LIBRARY_DROP_NOTE = "The library belongs to this project and cannot be copied to another.";

/** The key usage is kept under: the content hash, since the same file in two scenes has two asset ids. */
export const usageKey = (asset: Pick<AssetLibraryItem, "assetId" | "checksum">): string => asset.checksum ?? `id:${asset.assetId}`;

/** What each stored scene uses, by the asset's content hash. A declared asset no object draws does not count as used. */
export function projectAssetUsage(
  scenes: readonly { readonly sceneId: string; readonly name: string; readonly document: SceneDocument }[],
): Map<string, SceneUsage[]> {
  const usage = new Map<string, SceneUsage[]>();
  for (const scene of scenes) {
    for (const asset of scene.document.assets) {
      if (assetUsers(scene.document, asset.assetId).length === 0) continue;
      const key = usageKey(asset);
      const found = usage.get(key) ?? [];
      if (!found.some((entry) => entry.sceneId === scene.sceneId)) found.push({ sceneId: scene.sceneId, name: scene.name });
      usage.set(key, found);
    }
  }
  return usage;
}

export interface LibraryEntry {
  readonly asset: AssetLibraryItem;
  /** The open graphic declares this asset. */
  readonly inScene: boolean;
  /** The project's library holds it (so it can be in a folder); false for an asset only the open graphic has. */
  readonly inProject: boolean;
}

/** Every asset the panel lists: the project's, then any the open graphic holds that the project does not yet (by content hash). */
export function libraryEntries(document: SceneDocument, state: Pick<LibraryState, "project" | "projectLibrary">): LibraryEntry[] {
  const sceneKeys = new Set(document.assets.map(usageKey));
  const project = state.project === undefined ? [] : (state.projectLibrary ?? []);
  const entries: LibraryEntry[] = project.map((asset) => ({ asset, inScene: sceneKeys.has(usageKey(asset)), inProject: true }));
  const listed = new Set(project.map(usageKey));
  for (const asset of document.assets) if (!listed.has(usageKey(asset))) entries.push({ asset, inScene: true, inProject: false });
  return entries;
}

/** The state tag a card carries, or none when nothing is known: a wrong tag is worse than no tag. */
export function cardTag(
  asset: AssetLibraryItem,
  usage: LibraryState["usage"],
): { readonly text: string; readonly tone: "ok" | "warn" | "danger" | "neutral" } | undefined {
  switch (asset.status) {
    case "missing":
      return { text: "Missing", tone: "danger" };
    case "error":
      return { text: "Error", tone: "danger" };
    case "unsupported":
      return { text: "Unsupported", tone: "warn" };
    case "importing":
      return { text: "Importing", tone: "neutral" };
    default:
      break;
  }
  if (usage === undefined) return undefined;
  const scenes = usage.get(usageKey(asset))?.length ?? 0;
  return scenes === 0 ? { text: "Unused", tone: "warn" } : { text: scenes === 1 ? "1 scene" : `${scenes} scenes`, tone: "ok" };
}

const isMissing = (asset: AssetLibraryItem): boolean => asset.status === "missing" || asset.status === "error";

/** The sizes in words: a count of bytes means nothing at a glance. */
export function sizeWords(size: number | bigint | undefined): string {
  if (size === undefined) return "not reported";
  const bytes = Number(size);
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 ? Math.round(value) : Math.round(value * 10) / 10} ${units[unit]}`;
}

/** The first and last four characters of a content hash: enough to tell two apart, the whole of it in the tooltip. */
export function shortHash(hash: string | undefined): string {
  if (hash === undefined) return "not available";
  const bare = hash.includes(":") ? hash.slice(hash.indexOf(":") + 1) : hash;
  return bare.length <= 10 ? bare : `${bare.slice(0, 4)}…${bare.slice(-4)}`;
}

const FILTERS: readonly { readonly id: LibraryFilter; readonly label: string }[] = [
  { id: "all", label: "All" },
  { id: "scene", label: "This scene" },
  { id: "unused", label: "Unused" },
  { id: "missing", label: "Missing" },
];

const TABS: readonly { readonly id: LibraryTab; readonly label: string; readonly waits?: string }[] = [
  { id: "colours", label: "Colours" },
  { id: "text-styles", label: "Text styles" },
  { id: "layer-styles", label: "Layer styles" },
  { id: "backgrounds", label: "Backgrounds", waits: LIBRARY_WAITS.backgrounds },
  { id: "fonts", label: "Fonts" },
  { id: "assets", label: "Assets" },
];

function matches(entry: LibraryEntry, filter: LibraryFilter, usage: LibraryState["usage"]): boolean {
  switch (filter) {
    case "all":
      return true;
    case "scene":
      return entry.inScene;
    case "missing":
      return isMissing(entry.asset);
    case "unused":
      return usage !== undefined && !isMissing(entry.asset) && (usage.get(usageKey(entry.asset))?.length ?? 0) === 0;
  }
}

function counts(entries: readonly LibraryEntry[], usage: LibraryState["usage"]): Record<LibraryFilter, number | undefined> {
  return {
    all: entries.length,
    scene: entries.filter((entry) => entry.inScene).length,
    unused: usage === undefined ? undefined : entries.filter((entry) => matches(entry, "unused", usage)).length,
    missing: entries.filter((entry) => isMissing(entry.asset)).length,
  };
}

function detail(document: SceneDocument, entry: LibraryEntry | undefined, state: LibraryState): UiNode {
  if (entry === undefined) {
    return { id: "library/detail", role: "region", label: "Selected asset", description: "Select an asset to see where it is kept and where it is used." };
  }
  const { asset } = entry;
  const users = entry.inScene ? assetUsers(document, document.assets.find((candidate) => usageKey(candidate) === usageKey(asset))?.assetId ?? asset.assetId) : [];
  const scenes = state.usage?.get(usageKey(asset));
  const usedBy: UiNode[] =
    state.usage === undefined
      ? [{ id: `asset/${asset.assetId}/used-by`, role: "status", label: "Used by", value: "reading the project's scenes…" }]
      : (scenes ?? []).length === 0
        ? [{ id: `asset/${asset.assetId}/used-by`, role: "status", label: "Used by", value: "no stored scene uses it" }]
        : (scenes ?? []).map((scene) => ({ id: `asset/${asset.assetId}/used-by/${scene.sceneId}`, role: "listitem" as const, label: scene.name, value: scene.sceneId }));
  const sceneUsers = entry.inScene
    ? users.length === 0
      ? "this graphic declares it and draws nothing with it"
      : `this graphic: ${users.length} object(s): ${users.join(", ")}`
    : "this graphic does not declare it";
  const preview = previewNodes(asset, state);
  const relinkUnavailable =
    asset.kind === "font"
      ? FONT_ASSET_RELINK_UNAVAILABLE
      : state.importing
        ? "an import is already running"
        : !entry.inScene
          ? "add it to this scene first: replacing a file works on the graphic's own copy"
          : undefined;
  return {
    id: "library/detail",
    role: "region",
    label: asset.name,
    description: `${asset.kind} · ${availability(asset)}`,
    ...(preview.image === undefined ? {} : { image: preview.image }),
    actions: [
      ...(entry.inScene
        ? []
        : [
            {
              name: "addToScene",
              label: "Add to scene",
              ...(document.assets.some((candidate) => candidate.assetId === asset.assetId)
                ? { unavailable: `this scene already has an asset with id ${asset.assetId}` }
                : {}),
            },
          ]),
      { name: "relink", label: "Replace file…", ...(relinkUnavailable === undefined ? {} : { unavailable: relinkUnavailable }) },
      { name: "reveal", label: "Reveal in folder", unavailable: LIBRARY_WAITS.reveal },
    ],
    children: [
      ...preview.cells.map((cell) => ({ ...cell, id: "library/detail/preview" })),
      { id: `asset/${asset.assetId}/path`, role: "gridcell", label: "Path", value: asset.path },
      { id: `asset/${asset.assetId}/size`, role: "gridcell", label: "Size", value: `${sizeWords(asset.sizeBytes)}${asset.mimeType === undefined ? "" : ` · ${asset.mimeType}`}` },
      { id: `asset/${asset.assetId}/availability`, role: "gridcell", label: "Status", value: availability(asset) },
      {
        id: `asset/${asset.assetId}/content-hash`,
        role: "gridcell",
        label: "Fingerprint",
        description: asset.checksum ?? "no content hash has arrived",
        value: shortHash(asset.checksum),
      },
      { id: `asset/${asset.assetId}/storage`, role: "gridcell", label: "Stored", value: storageStatement(asset, state) },
      { id: `asset/${asset.assetId}/kind`, role: "gridcell", label: "Kind", value: asset.kind },
      { id: `asset/${asset.assetId}/usage`, role: "gridcell", label: "In this graphic", value: sceneUsers },
      ...(state.folders === undefined
        ? []
        : entry.inProject
          ? [moveToNode(state.folders, asset.assetId)]
          : [{ id: "library/detail/move-to", role: "status" as const, label: "Move to", value: "only this graphic has it: it is not in the project's library, so it has no folder" }]),
      { id: `asset/${asset.assetId}/used-by-list`, role: "list", label: "Used by", children: usedBy },
      ...provenanceCells(asset),
    ],
  };
}

/** The tab strip, with the tab shown selected. Fonts and Text styles are never "shown" here: they bring their own panels forward. */
function tabsNode(shown: LibraryTab): UiNode {
  return {
    id: "library/tabs",
    role: "list",
    label: "Library",
    children: TABS.map((tab) => ({
      id: `library/tab/${tab.id}`,
      role: "listitem" as const,
      label: tab.label,
      selected: tab.id === shown,
      actions: [{ name: "tab", label: tab.label, ...(tab.waits === undefined ? {} : { unavailable: tab.waits }) }],
    })),
  };
}

export function libraryPanel(document: SceneDocument, state: LibraryState = {}): UiNode {
  const entries = libraryEntries(document, state);
  const filter = state.filter ?? "all";
  const selection = effectiveSelection(state.folders, state.folder ?? "all");
  const scoped = entries.filter((entry) => inFolderScope(state.folders, selection, { assetId: entry.asset.assetId, inProject: entry.inProject }));
  const tally = counts(scoped, state.usage);
  const shown = scoped.filter((entry) => matches(entry, filter, state.usage));
  const selected = entries.find((entry) => entry.asset.assetId === state.selectedAssetId);

  const children: UiNode[] = [];
  if (state.notice !== undefined) children.push({ id: "asset-manager/notice", role: "status", label: "Library", value: state.notice });
  for (const [index, problem] of (state.projectProblems ?? []).entries()) {
    children.push({ id: `asset-manager/problem/${index}`, role: "alert", label: "Asset not in project", value: problem });
  }
  for (const [index, problem] of (state.usageProblems ?? []).entries()) {
    children.push({ id: `library/usage-problem/${index}`, role: "status", label: "A scene was not counted", value: problem });
  }

  if (state.tab === "colours") {
    children.push(
      tabsNode("colours"),
      ...coloursNodes(document, {
        project: state.project !== undefined,
        ...(state.colours === undefined ? {} : { colours: state.colours }),
        ...(state.coloursProblem === undefined ? {} : { coloursProblem: state.coloursProblem }),
        ...(state.selectedColourId === undefined ? {} : { selectedColourId: state.selectedColourId }),
        ...(state.selectedObjectIds === undefined ? {} : { selectedObjectIds: state.selectedObjectIds }),
      }),
      { id: "library/note", role: "status", label: "About colours", value: COLOURS_NOTE },
    );
    return {
      id: "asset-manager",
      role: "region",
      label: "Library",
      description: state.project === undefined ? "colours · independent scene, not in a project" : `colours · kept in project ${state.project}`,
      children,
    };
  }

  if (state.tab === "layer-styles") {
    children.push(
      tabsNode("layer-styles"),
      ...layerStylesNodes(document, {
        project: state.project !== undefined,
        ...(state.layerStyles === undefined ? {} : { styles: state.layerStyles }),
        ...(state.layerStylesProblem === undefined ? {} : { stylesProblem: state.layerStylesProblem }),
        ...(state.selectedLayerStyleId === undefined ? {} : { selectedStyleId: state.selectedLayerStyleId }),
        ...(state.selectedObjectIds === undefined ? {} : { selectedObjectIds: state.selectedObjectIds }),
        ...(state.effectName === undefined ? {} : { effectName: state.effectName }),
      }),
      { id: "library/note", role: "status", label: "About layer styles", value: STYLES_NOTE },
    );
    return {
      id: "asset-manager",
      role: "region",
      label: "Library",
      description: state.project === undefined ? "layer styles · independent scene, not in a project" : `layer styles · kept in project ${state.project}`,
      children,
    };
  }

  children.push(
    foldersNode(
      state.folders,
      selection,
      entries.map((entry) => ({ assetId: entry.asset.assetId, inProject: entry.inProject })),
      {
        project: state.project !== undefined,
        busy: state.importing === true || state.importPlan !== undefined,
        ...(state.foldersProblem === undefined ? {} : { problem: state.foldersProblem }),
      },
    ),
  );
  if (state.importPlan !== undefined) children.push(importPlanNode(state.importPlan, state.importing === true));
  children.push({ id: "library/folders-note", role: "status", label: "About folders", value: LIBRARY_FOLDERS_NOTE });

  children.push(tabsNode("assets"));

  children.push({
    id: "library/filters",
    role: "list",
    label: "Show",
    children: FILTERS.map((entry) => {
      const count = tally[entry.id];
      const text = `${entry.label}${count === undefined ? "" : ` · ${count}`}`;
      return {
        id: `library/filter/${entry.id}`,
        role: "listitem" as const,
        label: entry.label,
        ...(count === undefined ? {} : { value: String(count) }),
        selected: entry.id === filter,
        actions: [
          {
            name: "filter",
            label: text,
            ...(count === undefined ? { unavailable: "the project's scenes are still being read" } : {}),
          },
        ],
      };
    }),
  });

  children.push({
    id: "asset-manager/list",
    role: "list",
    label: "Assets",
    description:
      shown.length === 0
        ? entries.length === 0
          ? "no assets yet: import files to start the library"
          : scoped.length === 0
            ? selection === "unfiled"
              ? "no unfiled assets"
              : "nothing directly in this folder: choose an asset under All assets, then Move to"
            : "no asset matches this filter"
        : `${shown.length} of ${scoped.length}${selection === "all" ? "" : ` in ${selection === "unfiled" ? "Unfiled" : (state.folders === undefined ? "this folder" : folderPath(state.folders, selection))}`}`,
    children: shown.map((entry): UiNode => {
      const tag = cardTag(entry.asset, state.usage);
      const preview = previewNodes(entry.asset, state);
      return {
        id: `asset/${entry.asset.assetId}`,
        role: "listitem",
        label: entry.asset.name,
        description: `${entry.asset.kind} · ${availability(entry.asset)}`,
        selected: entry.asset.assetId === state.selectedAssetId,
        ...(preview.image === undefined ? {} : { image: preview.image }),
        children: [
          ...(preview.image === undefined ? preview.cells : []),
          ...(tag === undefined ? [] : [{ id: `asset/${entry.asset.assetId}/tag`, role: "status" as const, label: "State", value: tag.text, tone: tag.tone }]),
        ],
      };
    }),
  });

  children.push(detail(document, selected, state));
  children.push({ id: "library/note", role: "status", label: "About the library", value: LIBRARY_DROP_NOTE });

  return {
    id: "asset-manager",
    role: "region",
    label: "Library",
    description:
      state.project === undefined
        ? `${entries.length} asset(s) · independent scene, not in a project`
        : `${entries.length} asset(s) · kept in project ${state.project}`,
    actions: [
      {
        name: "importFiles",
        label: "Import files…",
        ...(state.importing ? { unavailable: "an asset import is already running" } : {}),
      },
    ],
    children,
  };
}
