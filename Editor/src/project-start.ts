// The Start screen's rules (build plan 11.43): create a project at a path you choose, or open one,
// before any work starts, as in XPression, Viz and After Effects.
//
// Pure, so each rule is testable without a page. The shell decides what is allowed (a project name,
// whether a folder exists, whether unsaved work blocks a switch) and the page shows its refusal;
// nothing here re-states those rules.

import type { ColorDepth, WorkingColorSpace } from "@grapix/contracts";

/** What the shell reports once a project is open. */
export interface OpenedProject {
  readonly name: string;
  /** The project's `.gpx`. */
  readonly gpx: string;
  /** The folder that holds the project's folder. */
  readonly root: string;
  /** The space the project composites in. */
  readonly workingColorSpace: WorkingColorSpace;
  /** Bits per channel the project renders at: each layer and effect result is stored at it. */
  readonly colorDepth: ColorDepth;
  /** Scenes that were open in the project just left, closed with it. */
  readonly closedSessions: readonly number[];
}

/** A remembered project; `exists` is false when its `.gpx` has been moved or deleted. */
export interface ListedRecent {
  readonly gpx: string;
  readonly name: string;
  readonly openedMs: number;
  readonly exists: boolean;
}

/** A project in the folder the Editor used before projects had a chosen location: `[name, folder]`. */
export type DefaultProject = readonly [name: string, folder: string];

/** How a row of the Start screen opens its project. */
export type StartOpen =
  | { readonly kind: "gpx"; readonly gpx: string }
  | { readonly kind: "folder"; readonly folder: string };

export interface StartRow {
  readonly key: string;
  readonly title: string;
  /** The path shown under the name. */
  readonly detail: string;
  /** When it was last opened, in words; empty for a project that was never opened here. */
  readonly when: string;
  /** Its `.gpx` is gone: shown, not openable, and can be forgotten. */
  readonly missing: boolean;
  readonly open: StartOpen | undefined;
  /** Only a remembered project can be taken off the list. */
  readonly forgettable: boolean;
}

const separatorOf = (path: string): string => (path.includes("\\") && !path.includes("/") ? "\\" : "/");

/** The folder part of a path, whichever separator it uses. */
export function dirname(path: string): string {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut <= 0 ? "" : path.slice(0, cut);
}

/** Join path parts with the separator the parent already uses. */
export function joinPath(parent: string, ...parts: readonly string[]): string {
  const separator = separatorOf(parent);
  let out = parent.replace(/[\\/]+$/, "");
  for (const part of parts) out += separator + part;
  return out;
}

/** Where a project will be saved: `<parent>/<name>/<name>.gpx`; `undefined` until both are given. */
export function previewGpx(parent: string | undefined, name: string): string | undefined {
  const trimmed = name.trim();
  if (!parent || trimmed === "") return undefined;
  return joinPath(parent, trimmed, `${trimmed}.gpx`);
}

/** Creating needs a name and a chosen folder; whether the name is acceptable is the shell's answer. */
export function canCreate(parent: string | undefined, name: string): boolean {
  return Boolean(parent) && name.trim() !== "";
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "just now", "5 minutes ago", "3 hours ago", "yesterday", then the date. */
export function relativeTime(thenMs: number, nowMs: number): string {
  if (!Number.isFinite(thenMs) || thenMs <= 0) return "";
  const seconds = Math.max(0, Math.round((nowMs - thenMs) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  if (hours < 48) return "yesterday";
  const then = new Date(thenMs);
  return `${then.getUTCDate()} ${MONTHS[then.getUTCMonth()]} ${then.getUTCFullYear()}`;
}

const sameFolder = (a: string, b: string): boolean =>
  a.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() === b.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

/**
 * The rows of the Start screen: the remembered projects first, newest first as the shell lists
 * them, then projects found in the old default folder that are not already remembered, so work made
 * before projects had a chosen location is not stranded.
 */
export function startRows(
  recent: readonly ListedRecent[],
  defaults: readonly DefaultProject[],
  nowMs: number,
): StartRow[] {
  const rows: StartRow[] = recent.map((project) => ({
    key: `recent:${project.gpx}`,
    title: project.name,
    detail: project.gpx,
    when: relativeTime(project.openedMs, nowMs),
    missing: !project.exists,
    open: project.exists ? { kind: "gpx", gpx: project.gpx } : undefined,
    forgettable: true,
  }));
  for (const [name, folder] of defaults) {
    if (recent.some((project) => sameFolder(dirname(project.gpx), folder))) continue;
    rows.push({
      key: `folder:${folder}`,
      title: name,
      detail: folder,
      when: "",
      missing: false,
      open: { kind: "folder", folder },
      forgettable: false,
    });
  }
  return rows;
}

/** The name Save As offers: the project's own with " copy" after it, so it is never the original's. */
export function suggestCopyName(name: string): string {
  return `${name.trim()} copy`;
}

/** How the project renders, as After Effects words it: "16 bpc · sRGB". 32 is float. */
export function renderingLabel(project: Pick<OpenedProject, "colorDepth" | "workingColorSpace">): string {
  const space = project.workingColorSpace === "linear-srgb" ? "Linear sRGB" : "sRGB";
  const depth = project.colorDepth === "32" ? "32 bpc float" : `${project.colorDepth} bpc`;
  return `${depth} · ${space}`;
}

/** The line under the Scene Manager's title once a project is open. */
export function projectSummary(project: OpenedProject | undefined): string {
  return project === undefined
    ? "No project open"
    : `Project ${project.name} · ${renderingLabel(project)} · ${project.gpx}`;
}
