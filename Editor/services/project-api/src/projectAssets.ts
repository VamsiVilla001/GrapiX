/**
 * The project's asset folders, read as a library.
 *
 * Material Manager shows what is in the folders, not what a catalogue remembers being put there.
 * That is a deliberate inversion of the previous model, where an asset existed because an import
 * had once recorded it: a designer who copies four logos into `Assets/Images` with the file manager
 * expects to see four logos, and a catalogue cannot know they arrived. Reading the directory is the
 * only implementation where the library and the file manager can never disagree.
 *
 * ## What a reference is addressed by
 *
 * Its project-relative path. The content-addressed store beside this one is right for its own job —
 * moving identical bytes once — and wrong for this one: replacing `lower-third-bg.png` in place is
 * a routine act, and every material pointing at it must keep pointing at it. Path identity makes a
 * replacement a new version of the same reference; hash identity would make it a different asset
 * and silently orphan every binding.
 *
 * ## Reading is not writing
 *
 * Nothing here creates, moves or deletes a file. Scanning a folder an operator owns must not have
 * side effects on it — not even creating the folder, which is why a missing asset folder reads as
 * empty rather than being helpfully brought into existence.
 */

import {
  PROJECT_ASSET_FOLDERS,
  PROJECT_FOLDERS,
  projectAssetKind,
  projectAssetMimeType,
  type ProjectAssetFolder,
  type ProjectAssetReference
} from "@grapix/shared-types";
import { readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { ProjectWorkspaceError, currentProject } from "./projectWorkspace.js";

/**
 * How deep a scan will go inside an asset folder.
 *
 * Designers organise: `Assets/Images/Show A/Lower Thirds/bg.png` is normal, and a flat scan would
 * miss all of it. A bound is still needed, because a symlink or a junction pointing at a parent
 * turns a walk into a non-terminating one, and an operator's `Assets` folder is not a place to
 * discover that at run time.
 */
const MAX_SCAN_DEPTH = 8;

/** Files that are never library entries, whatever folder they are found in. */
function isIgnoredFile(name: string): boolean {
  if (name.startsWith(".")) return true;          // dotfiles, and the staging names we write
  if (name.endsWith(".tmp")) return true;         // an atomic write caught mid-rename
  if (name === "collected.json") return true;     // the AE collection index, not footage
  return name === "Thumbs.db" || name === "desktop.ini";
}

interface ScanContext {
  /** Real path of the project root, for the containment check. */
  readonly realRoot: string;
  /** Real paths already visited, so a link back up a tree terminates. */
  readonly seen: Set<string>;
  readonly references: ProjectAssetReference[];
}

/**
 * Walk one asset folder.
 *
 * Every directory is resolved to its real path before it is entered, and refused if that path is
 * outside the project. A junction in `Assets/Images` pointing at `C:\` is not a hypothetical on
 * Windows — it is what happens when someone links a shared media drive into a project — and the
 * consequences of following it are a scan that never ends and a library that offers files the
 * project does not own and cannot package.
 */
async function scanDirectory(
  directory: string,
  folder: ProjectAssetFolder,
  depth: number,
  context: ScanContext
): Promise<void> {
  if (depth > MAX_SCAN_DEPTH) return;

  let realDirectory: string;
  try {
    realDirectory = await realpath(directory);
  } catch {
    return; // Absent, or a link with no target. Either way there is nothing to list.
  }

  const withSeparator = `${context.realRoot}${path.sep}`;
  if (realDirectory !== context.realRoot && !realDirectory.startsWith(withSeparator)) return;
  if (context.seen.has(realDirectory)) return;
  context.seen.add(realDirectory);

  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (isIgnoredFile(entry.name)) continue;
    const absolute = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      await scanDirectory(absolute, folder, depth + 1, context);
      continue;
    }

    // `isFile()` is false for a symlink, so a linked-in file needs the stat to be seen at all.
    let info;
    try {
      info = await stat(absolute);
    } catch {
      continue; // A broken link, or a file deleted between readdir and stat.
    }
    if (!info.isFile()) continue;

    context.references.push({
      path: toProjectRelativePosix(context.realRoot, absolute),
      name: entry.name,
      kind: projectAssetKind(entry.name),
      mimeType: projectAssetMimeType(entry.name),
      sizeBytes: info.size,
      modifiedAt: new Date(info.mtimeMs).toISOString(),
      folder
    });
  }
}

/** The path a reference carries: relative to the project root, POSIX-separated, always. */
function toProjectRelativePosix(root: string, absolute: string): string {
  return path.relative(root, absolute).split(path.sep).join("/");
}

/**
 * Every asset in the open project, ordered by folder then by name.
 *
 * Sorted here rather than in the client so two panels listing the same library cannot present it
 * in two orders. `localeCompare` with `numeric` so `logo-2.png` precedes `logo-10.png`, which is
 * the order a person naming files that way meant.
 */
export async function listProjectAssets(): Promise<ProjectAssetReference[]> {
  const { root } = await currentProject();
  if (!root) {
    throw new ProjectWorkspaceError(
      "NO_PROJECT_OPEN",
      "no project is open: save the project to a folder before browsing its assets"
    );
  }

  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch {
    return [];
  }

  const context: ScanContext = { realRoot, seen: new Set(), references: [] };
  for (const folder of PROJECT_ASSET_FOLDERS) {
    await scanDirectory(path.join(root, ...PROJECT_FOLDERS[folder].split("/")), folder, 0, context);
  }

  const order = new Map(PROJECT_ASSET_FOLDERS.map((folder, index) => [folder, index]));
  return context.references.sort((left, right) => {
    const byFolder = (order.get(left.folder) ?? 0) - (order.get(right.folder) ?? 0);
    if (byFolder !== 0) return byFolder;
    return left.path.localeCompare(right.path, undefined, { numeric: true, sensitivity: "base" });
  });
}

/**
 * Resolve one project-relative asset path to the file it names.
 *
 * The client supplies this path, so it is treated as hostile. Three checks, and the order matters:
 * reject absolute and traversing forms syntactically, resolve inside the root, then re-check
 * containment **after** `realpath` — a syntax check alone cannot see a symlink, and a link is
 * exactly how a request for `Assets/Images/logo.png` reads `C:\Users\...\id_rsa`.
 *
 * Returns `null` rather than throwing for anything that is not a readable file inside the project,
 * so a caller answers 404 and tells an attacker nothing about which check failed.
 */
export async function resolveProjectAssetPath(relativePath: string): Promise<string | null> {
  const { root } = await currentProject();
  if (!root) return null;
  if (!relativePath || relativePath.length > 1024) return null;
  if (relativePath.includes("\0")) return null;
  if (path.posix.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)) return null;

  const segments = relativePath.split(/[\\/]/);
  if (segments.some((segment) => segment === ".." || segment === "." || segment === "")) return null;

  let realRoot: string;
  let realTarget: string;
  try {
    realRoot = await realpath(root);
    realTarget = await realpath(path.join(realRoot, ...segments));
  } catch {
    return null;
  }

  if (!realTarget.startsWith(`${realRoot}${path.sep}`)) return null;

  const info = await stat(realTarget).catch(() => null);
  return info?.isFile() ? realTarget : null;
}
