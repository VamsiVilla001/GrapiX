/**
 * The project the operator chose a location for.
 *
 * The service's own `dataRoot` is where scenes live while a session is scratch — a per-user
 * AppData path nobody opens by hand. A project is the opposite: a directory the operator named,
 * laid out so the folders mean something without the application, and self-contained enough to
 * archive after the show. This module owns that directory: creating the layout, reading and
 * writing the manifest, and holding which project is currently open.
 *
 * ## Why the current project is process state
 *
 * One Editor window edits one project, and every route that writes needs to know which. Threading
 * a root through each call would put the answer in the client's hands, where a stale value becomes
 * a scene written into the previous project. So the service holds it, the shell sets it once when
 * the operator picks a folder, and it is remembered across restarts in the data root — the
 * operator chose a project, not a session.
 */

import {
  COLLECTED_AE_INDEX_FILE,
  PROJECT_FILE_EXTENSION,
  PROJECT_FOLDERS,
  PROJECT_FOLDER_PATHS,
  PROJECT_MANIFEST_VERSION,
  createProjectManifest,
  projectFileName,
  type CollectedAeAssetIndex,
  type ProjectLocation,
  type ProjectManifest
} from "@grapix/shared-types";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { projectDataRoot } from "./dataRoot.js";

/** Thrown for every refusal here, so routes can map one error type to a status. */
export class ProjectWorkspaceError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ProjectWorkspaceError";
  }
}

/** Where the chosen project root is remembered between restarts. */
function openProjectPointerPath(): string {
  return path.join(projectDataRoot(), "open-project.json");
}

let currentRoot: string | null = null;
let currentManifest: ProjectManifest | null = null;
let pointerLoaded = false;

/**
 * Restore the remembered project, if its directory is still a project.
 *
 * A pointer to a folder that was moved, renamed or deleted is not an error worth refusing a boot
 * over — the operator simply has no project open and will be asked on the next save.
 */
async function loadPointer(): Promise<void> {
  if (pointerLoaded) return;
  pointerLoaded = true;

  // A launch that names its project does not need a pointer, and must not inherit the previous
  // one. This is how a headless run and the test suite get a project without a file dialog:
  // the caller states the root, and it is created if it is not there yet.
  const declared = process.env.GRAPIX_PROJECT_ROOT?.trim();
  if (declared) {
    try {
      await createOrOpenProject(declared);
      return;
    } catch {
      // A named root that cannot be created is worth no more than a missing pointer: the session
      // simply has no project, and the first save will ask for one.
    }
  }

  try {
    const raw = JSON.parse(await readFile(openProjectPointerPath(), "utf8")) as { root?: unknown };
    if (typeof raw.root !== "string" || !raw.root) return;
    const manifest = await readManifest(raw.root);
    currentRoot = path.resolve(raw.root);
    currentManifest = manifest;
  } catch {
    // No pointer, unreadable pointer, or a root that is no longer a project.
  }
}

async function writePointer(root: string | null): Promise<void> {
  await mkdir(projectDataRoot(), { recursive: true });
  await writeFile(openProjectPointerPath(), `${JSON.stringify({ root }, null, 2)}\n`);
}

/**
 * Every `.gpxpkg` in a directory, in directory order.
 *
 * Found by extension rather than by a fixed name so the project file can carry the project's own
 * name — `BMSD Show.gpxpkg` rather than a generic `project.gpxpkg`, which is what makes a folder full of
 * projects readable.
 *
 * All of them rather than the first, because the extension is shared with the published scene
 * package: a designer who exports a package beside their project puts a second `.gpxpkg` in the
 * root, and taking the first match alphabetically would report that the project is not a project.
 * The caller reads them until one says it is a project.
 */
async function findProjectFiles(root: string): Promise<string[]> {
  const entries = await readdir(root).catch(() => [] as string[]);
  return entries
    .filter((entry) => entry.toLowerCase().endsWith(PROJECT_FILE_EXTENSION))
    .map((entry) => path.join(root, entry));
}

/**
 * Whether a parsed `.gpxpkg` manifest is a project rather than a published scene package.
 *
 * `kind` is authoritative when present. A manifest written before the field existed is a project
 * if it carries a `projectId` and no `packageVersion` — the scene package has always had the
 * latter, so the two are distinguishable without guessing.
 */
function isProjectManifest(parsed: { kind?: unknown; projectId?: unknown; packageVersion?: unknown }): boolean {
  if (typeof parsed.kind === "string") return parsed.kind === "project";
  return typeof parsed.projectId === "string" && parsed.packageVersion === undefined;
}

/** Read and validate a directory's project file. Throws when the directory is not a project. */
async function readManifest(root: string): Promise<ProjectManifest> {
  const resolved = path.resolve(root);
  const candidates = await findProjectFiles(resolved);
  if (candidates.length === 0) {
    throw new ProjectWorkspaceError(
      "NOT_A_PROJECT",
      `${root} does not contain a ${PROJECT_FILE_EXTENSION} project file`
    );
  }

  let unsupported: ProjectWorkspaceError | null = null;
  for (const manifestPath of candidates) {
    let parsed: ProjectManifest;
    try {
      parsed = JSON.parse(await readFile(manifestPath, "utf8")) as ProjectManifest;
    } catch {
      continue; // Unreadable, or a zip: either way it is not this directory's project file.
    }
    if (!isProjectManifest(parsed)) continue;
    if (parsed.version !== PROJECT_MANIFEST_VERSION) {
      // Remember it, but keep looking: a stray package must not mask a readable project, and a
      // project of the wrong version must not be reported as "no project here".
      unsupported ??= new ProjectWorkspaceError(
        "UNSUPPORTED_PROJECT_VERSION",
        `project manifest version ${parsed.version} is not supported`
      );
      continue;
    }
    return parsed;
  }

  if (unsupported) throw unsupported;
  throw new ProjectWorkspaceError(
    "NOT_A_PROJECT",
    `${root} contains no readable GrapiX project file`
  );
}

/** The project currently open, or `{ root: null }` when the session is still scratch. */
export async function currentProject(): Promise<ProjectLocation> {
  await loadPointer();
  return { root: currentRoot, manifest: currentManifest };
}

/**
 * The absolute path of one project folder, refusing when no project is open.
 *
 * Every writer goes through here rather than joining paths itself, so "there is no project yet"
 * is answered in one place instead of producing a write into a path built from `null`.
 */
export async function projectFolder(folder: keyof typeof PROJECT_FOLDERS): Promise<string> {
  const { root } = await currentProject();
  if (!root) {
    throw new ProjectWorkspaceError(
      "NO_PROJECT_OPEN",
      "no project location has been chosen yet: save the project to a folder first"
    );
  }
  return path.join(root, ...PROJECT_FOLDERS[folder].split("/"));
}

/**
 * Create the project layout inside a root, or adopt a directory that already is a project.
 *
 * `mkdir -p` semantics throughout: choosing an existing project folder re-opens it rather than
 * refusing, and choosing an empty directory fills it in. What it never does is overwrite a project
 * file — an existing project keeps its id, its name and its creation date.
 *
 * `projectFilePath` is the `.gpxpkg` the operator named in the save dialog. Passing it is what makes
 * "Save Project As…" behave: the file lands where they pointed, carrying the name they typed,
 * rather than at a path this module invented.
 */
export async function createOrOpenProject(
  root: string,
  name?: string,
  projectFilePath?: string
): Promise<ProjectLocation> {
  const resolved = path.resolve(root);
  let info;
  try {
    info = await stat(resolved);
  } catch {
    // A "Save As" dialog names a file that does not exist yet, and its folder may not either.
    await mkdir(resolved, { recursive: true });
    info = await stat(resolved).catch(() => null);
  }
  if (!info) {
    throw new ProjectWorkspaceError("ROOT_NOT_FOUND", `no directory exists at ${resolved}`);
  }
  if (!info.isDirectory()) {
    throw new ProjectWorkspaceError("ROOT_NOT_A_DIRECTORY", `${resolved} is not a directory`);
  }

  let manifest: ProjectManifest;
  try {
    manifest = await readManifest(resolved);
  } catch (error) {
    if (error instanceof ProjectWorkspaceError && error.code === "UNSUPPORTED_PROJECT_VERSION") throw error;
    const projectName = name?.trim()
      || (projectFilePath ? path.basename(projectFilePath, PROJECT_FILE_EXTENSION) : "")
      || path.basename(resolved);
    manifest = createProjectManifest(projectName);
    const target = projectFilePath && projectFilePath.toLowerCase().endsWith(PROJECT_FILE_EXTENSION)
      ? projectFilePath
      : path.join(resolved, projectFileName(projectName));
    await writeFile(target, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  for (const folder of PROJECT_FOLDER_PATHS) {
    await mkdir(path.join(resolved, ...folder.split("/")), { recursive: true });
  }

  currentRoot = resolved;
  currentManifest = manifest;
  pointerLoaded = true;
  await writePointer(resolved);
  return { root: resolved, manifest };
}

/** Close the open project without touching anything on disk. */
export async function closeProject(): Promise<void> {
  currentRoot = null;
  currentManifest = null;
  pointerLoaded = true;
  await writePointer(null);
}

/* ── Collected After Effects footage ───────────────────────────────────────────────────────── */

async function collectedIndexPath(): Promise<string> {
  return path.join(await projectFolder("aepFootage"), COLLECTED_AE_INDEX_FILE);
}

export async function readCollectedAeIndex(): Promise<CollectedAeAssetIndex> {
  try {
    const parsed = JSON.parse(await readFile(await collectedIndexPath(), "utf8")) as CollectedAeAssetIndex;
    if (parsed.version === 1 && Array.isArray(parsed.assets)) return parsed;
  } catch {
    // A missing or corrupt index means nothing has been collected that we can prove we own —
    // which is the safe reading, because it makes removal delete nothing rather than guess.
  }
  return { version: 1, assets: [] };
}

export async function writeCollectedAeIndex(index: CollectedAeAssetIndex): Promise<void> {
  const target = await collectedIndexPath();
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(index, null, 2)}\n`);
}

/** A file name that is safe on Windows and unique within the collected folder. */
export async function uniqueCollectedFileName(preferred: string): Promise<string> {
  const folder = await projectFolder("aepFootage");
  const safe = preferred.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/^\.+/, "") || "footage";
  const existing = new Set(await readdir(folder).catch(() => [] as string[]));
  if (!existing.has(safe)) return safe;

  const extension = path.extname(safe);
  const base = safe.slice(0, safe.length - extension.length);
  for (let index = 2; index < 10_000; index += 1) {
    const candidate = `${base} (${index})${extension}`;
    if (!existing.has(candidate)) return candidate;
  }
  throw new ProjectWorkspaceError("COLLECT_NAME_EXHAUSTED", `cannot find a free name for ${preferred}`);
}
