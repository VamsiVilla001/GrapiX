/**
 * The project as a folder on disk.
 *
 * Until a project has a location the Editor is scratch: scenes live in the service's own data
 * root, which is a per-user AppData path an operator never opens and cannot hand to anyone. A
 * broadcast project is a deliverable — it moves between machines, gets archived after the show,
 * and has to carry its own footage — so it needs a directory the operator chose, with a layout
 * they can read without the application.
 *
 * ## Why a folder per asset class
 *
 * The layout is the one XPression and Viz Artist established: the project root holds a manifest
 * and one folder per kind of thing, so an operator looking for the video that plays under a lower
 * third finds it under `Assets/Videos` rather than in a flat content-addressed blob store. That
 * matters most for `AEP Footage`, which holds footage collected out of an After Effects project:
 * the whole point of collecting it is that the template stops depending on the artist's own
 * `(Footage)` folder, and a named directory is what makes that legible.
 *
 * Nothing here writes to the source `.aep` or its footage. Collection copies; removal deletes only
 * what the project itself collected.
 */

import type { AssetKind } from "./index.js";
import { DEFAULT_PROJECT_SETTINGS, type ProjectSettings } from "./project.js";

export const PROJECT_MANIFEST_VERSION = 1 as const;

/**
 * The extension that marks a GrapiX project file.
 *
 * A project is a folder, but a folder is not double-clickable and does not say what made it. The
 * `.gpxpkg` file at its root is the thing an operator opens, the thing a shortcut points at, and the
 * thing that says "this directory is a GrapiX project" — the same role `.aep` plays for After
 * Effects and `.xpf` for XPression. It holds the manifest; the heavy content stays in the folders
 * beside it so the project can still be inspected, synced and archived without the application.
 */
export const PROJECT_FILE_EXTENSION = ".gpxpkg" as const;

/**
 * What a `.gpxpkg` on disk actually is.
 *
 * One extension now carries two formats: the project manifest at a project root, and the sealed
 * scene package the Editor publishes to Playout. They are not interchangeable — one names a folder
 * of authoring work, the other is a checksum-addressed archive Playout takes to air — so a reader
 * must be told which it has rather than inferring it from which fields happen to be present.
 * Absence of a field is not a format: it is also what a truncated file and an older writer look
 * like, and guessing between "project" and "goes on air" is not a guess worth making.
 */
export type GpxpkgKind = "project" | "scene-package";

/** The project file for a project of this name. */
export function projectFileName(projectName: string): string {
  const safe = projectName.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/^\.+/, "").trim();
  return `${safe || "Untitled Project"}${PROJECT_FILE_EXTENSION}`;
}

/**
 * Directories created inside a project root, relative to it and POSIX-separated.
 *
 * A fixed record rather than a computed tree: the names are a contract an operator and an archive
 * script both rely on, and generating them would make a rename look like a code change rather than
 * a format break.
 */
export const PROJECT_FOLDERS = {
  scenes: "Scenes",
  /**
   * Collected After Effects footage, at the project root rather than under `Assets/`.
   *
   * It is not an asset class like images or fonts: it is a copy of somebody else's project
   * structure, arriving as a set the artist assembled, and it is the folder an operator is most
   * likely to open by hand when a template stops finding its footage. Giving it the top level and
   * a name in words is what makes that obvious from the file manager.
   */
  aepFootage: "AEP Footage",
  images: "Assets/Images",
  videos: "Assets/Videos",
  audio: "Assets/Audio",
  fonts: "Assets/Fonts",
  models: "Assets/Models",
  packages: "Packages",
  autosaves: "Autosaves",
  backups: "Backups"
} as const;

export type ProjectFolder = keyof typeof PROJECT_FOLDERS;

/** Every folder a project root contains, in creation order. */
export const PROJECT_FOLDER_PATHS: readonly string[] = Object.values(PROJECT_FOLDERS);

/* ── The project's assets, as the Material Manager sees them ─────────────────────────────────
 *
 * The asset folders *are* the library. Material Manager lists what is in them rather than what
 * some catalogue says should be there, so a file an operator drops in with the file manager shows
 * up, and a file they delete stops being offered. That is the XPression and Viz model, and it is
 * the only one where the answer to "why is this texture missing" is visible without the
 * application.
 *
 * A reference is therefore addressed by **where it is**, not by a hash of what it contains.
 * Content addressing is right for a transfer cache, where identical bytes must move once; it is
 * wrong for a library, where replacing `lower-third-bg.png` in place is a routine act that must
 * keep every material pointing at it. Same path, new bytes, same reference.
 */

/** The folders scanned to build the library, in the order they are presented. */
export const PROJECT_ASSET_FOLDERS = [
  "images",
  "videos",
  "audio",
  "models",
  "fonts",
  "aepFootage"
] as const satisfies readonly (keyof typeof PROJECT_FOLDERS)[];

export type ProjectAssetFolder = (typeof PROJECT_ASSET_FOLDERS)[number];

/** One file found in a project's asset folders. */
export interface ProjectAssetReference {
  /**
   * Project-root-relative, POSIX-separated. This is the reference's identity: it is what a
   * material stores, what the content route resolves, and what survives the project moving to
   * another machine.
   */
  path: string;
  /** File name, for display. */
  name: string;
  kind: AssetKind;
  mimeType: string;
  sizeBytes: number;
  /** Last modified, ISO. Changes when the file is replaced in place, which is how a stale
   *  decoded texture learns it is stale. */
  modifiedAt: string;
  /** Which asset folder it came from, so the library can group without re-deriving it. */
  folder: ProjectAssetFolder;
}

/**
 * Extension → asset kind, and the single place the two sides agree.
 *
 * The Editor and the project service both classify files, and when they disagreed the library
 * offered something the renderer then refused. One table, imported by both.
 */
const ASSET_KIND_BY_EXTENSION: Readonly<Record<string, AssetKind>> = {
  png: "image", jpg: "image", jpeg: "image", webp: "image", gif: "image", bmp: "image",
  tif: "image", tiff: "image", avif: "image", tga: "image", exr: "image", hdr: "image",
  svg: "svg",
  mp4: "video", mov: "video", webm: "video", mkv: "video", avi: "video", mxf: "video",
  glb: "model", gltf: "model", obj: "model", fbx: "model",
  otf: "font", ttf: "font", woff: "font", woff2: "font",
  wgsl: "wgsl",
  json: "json",
  cube: "lut"
};

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp",
  gif: "image/gif", bmp: "image/bmp", tif: "image/tiff", tiff: "image/tiff",
  avif: "image/avif", svg: "image/svg+xml",
  mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm", mkv: "video/x-matroska",
  glb: "model/gltf-binary", gltf: "model/gltf+json",
  otf: "font/otf", ttf: "font/ttf", woff: "font/woff", woff2: "font/woff2",
  wgsl: "text/wgsl", json: "application/json"
};

/** The lower-case extension of a file name, without the dot. `""` when it has none. */
function extensionOf(fileName: string): string {
  const index = fileName.lastIndexOf(".");
  return index <= 0 ? "" : fileName.slice(index + 1).toLowerCase();
}

/**
 * What kind of asset a file is, by extension.
 *
 * `"unknown"` rather than a refusal: an unrecognised file in an asset folder is still something
 * the operator put there, and hiding it would make the library disagree with the file manager —
 * which is the one thing this design exists to prevent. The Material Manager shows it and declines
 * to assign it, which is a visible answer rather than an absence.
 */
export function projectAssetKind(fileName: string): AssetKind {
  return ASSET_KIND_BY_EXTENSION[extensionOf(fileName)] ?? "unknown";
}

/** The media type for a file name, falling back to a type that promises nothing. */
export function projectAssetMimeType(fileName: string): string {
  return MIME_BY_EXTENSION[extensionOf(fileName)] ?? "application/octet-stream";
}

/**
 * Whether a reference can be bound to an object's surface as a material.
 *
 * Image and SVG only, because that is what the binding path actually accepts today — video is a
 * surface the renderers will carry, and claiming it here before `assignAssetToFaces` takes it
 * would enable a control whose only outcome is a refusal message. A model is added to the scene as
 * an object rather than bound to a face, so it is not assignable in this sense either.
 */
export function isAssignableProjectAsset(reference: ProjectAssetReference): boolean {
  return reference.kind === "image" || reference.kind === "svg";
}

/**
 * The scene-asset id a project asset gets, derived from its path.
 *
 * Deterministic, because the identity has to survive things a random id would not: assigning the
 * same file to a second object must reuse one entry rather than accumulate duplicates, and a scene
 * saved today must still resolve its texture when reopened next week. The path is the identity, so
 * the id is a function of the path.
 *
 * The alphabet is forced to `[A-Za-z0-9_-]` because the packager builds a file name out of this id
 * and refuses anything else — a path with a space or a non-Latin character would otherwise produce
 * an asset that authors fine and fails at publish, which is the worst moment to find out.
 *
 * A 64-bit FNV-1a, as two 32-bit passes over different seeds. Not a cryptographic hash and not
 * pretending to be: nothing here is a security boundary, and the only property needed is that two
 * different paths in one project practically never collide.
 */
export function projectAssetId(assetPath: string): string {
  const normalized = assetPath.replace(/\\/g, "/");
  let low = 0x811c9dc5;
  let high = 0x01000193;
  for (let index = 0; index < normalized.length; index += 1) {
    const code = normalized.charCodeAt(index);
    low = Math.imul(low ^ code, 0x01000193) >>> 0;
    high = Math.imul(high ^ (code + index), 0x85ebca6b) >>> 0;
  }
  const hex = `${low.toString(16).padStart(8, "0")}${high.toString(16).padStart(8, "0")}`;
  return `projectasset_${hex}`;
}

/** The service route that serves a project asset's bytes, relative to the project service. */
export function projectAssetContentPath(assetPath: string): string {
  return `/api/project/assets/content?path=${encodeURIComponent(assetPath)}`;
}

export interface ProjectManifest {
  /**
   * Always `"project"`. Written since the extension became shared; a manifest without it is a
   * project written by an earlier build, which readers normalize rather than refuse.
   */
  kind?: "project";
  version: typeof PROJECT_MANIFEST_VERSION;
  projectId: string;
  name: string;
  /** Canonical settings for scenes authored in this project. */
  settings: ProjectSettings;
  createdAt: string;
  updatedAt: string;
}

/**
 * One source file collected out of an After Effects project into `Assets/AEP`.
 *
 * `usedBy` is what makes removal safe. A single `.psd` is routinely referenced by dozens of AE
 * footage items across several compositions — this project's reference file is used by 54 — so a
 * remove that deleted the file because *one* import stopped needing it would break every other
 * import still pointing at it. The list holds import-unit ids; the file is deleted when it empties.
 */
export interface CollectedAeAsset {
  /** Stable identity of the source bytes: `<size>-<mtimeMs>-<basename>`, lowercased. */
  sourceKey: string;
  /** File name under `Assets/AEP`, unique within the folder. */
  fileName: string;
  /** Where it came from, recorded for provenance. Never written to. */
  sourcePath: string;
  sizeBytes: number;
  mediaType: string;
  /** Import-unit ids that reference this file. Empty means the file is collectable garbage. */
  usedBy: string[];
  collectedAt: string;
}

/** The index kept beside the collected footage, so removal knows what it may delete. */
export interface CollectedAeAssetIndex {
  version: 1;
  assets: CollectedAeAsset[];
}

export const COLLECTED_AE_INDEX_FILE = "collected.json";

/**
 * One import of one composition — the unit the author adds and removes.
 *
 * An import is a subtree, not a scene: the group object carrying this id owns every object the
 * composition produced, so removing the import is removing that subtree plus releasing this id
 * from every collected asset's `usedBy`.
 */
export interface AeImportUnit {
  importId: string;
  /** The `.aep` this came from, as a project-root-relative URI. */
  projectUri: string;
  compositionId: string;
  compositionName: string;
  /** Object id of the group that roots the imported subtree. */
  rootObjectId: string;
  importedAt: string;
}

/** A project's current state as the Editor sees it. `null` root means nothing chosen yet. */
export interface ProjectLocation {
  root: string | null;
  manifest: ProjectManifest | null;
}

export function createProjectManifest(name: string, settings?: ProjectSettings): ProjectManifest {
  const now = new Date().toISOString();
  return {
    kind: "project",
    version: PROJECT_MANIFEST_VERSION,
    projectId: `project_${Date.now().toString(36)}`,
    name: name.trim() || DEFAULT_PROJECT_SETTINGS.name,
    settings: settings ?? { ...DEFAULT_PROJECT_SETTINGS, name: name.trim() || DEFAULT_PROJECT_SETTINGS.name },
    createdAt: now,
    updatedAt: now
  };
}
