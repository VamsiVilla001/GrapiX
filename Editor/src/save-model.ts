// The save model of the Editor (plan row 11.30): where a plain save goes. Pure, so the rules are held by tests and
// not only by the page that uses them.
//
//   Ctrl+S         saves in place and never makes a version.
//   Ctrl+Shift+S   is the one way to make a new version: the next numbered copy, beside the current one.
//   Neither fires while a text field has focus. The keys are decided by the one table in `command-registry.ts` (11.31).

import type { EditEffect } from "@grapix/contracts";

/** What a scene is saved to, as far as the page knows. */
export interface SaveState {
  /** The scene is stored in a project. */
  readonly stored: boolean;
  /** The scene has been saved to a scene file. */
  readonly file: boolean;
  /** A project is open. */
  readonly project: boolean;
}

/** Where a plain save goes: the stored copy it came from, the file it was saved to, the open project (a
 *  first save), or a file the author names (a first save with no project). */
export type SaveRoute = "stored" | "file" | "project" | "dialog";

export function saveRoute(state: SaveState): SaveRoute {
  if (state.stored) return "stored";
  if (state.file) return "file";
  return state.project ? "project" : "dialog";
}

/** A scene saved nowhere has no version to number from, so Save as next version is its first save. */
export function isFirstSave(state: SaveState): boolean {
  return !state.stored && !state.file;
}

/** The Activity line for a next-version save: the scene it made, or the file. */
export function versionLabel(effects: readonly EditEffect[]): string {
  for (const effect of effects) {
    if (effect.effect === "stored") return `Saved as the next version: ${effect.origin.project}/${effect.origin.sceneId}`;
  }
  return "Saved as the next version of the file";
}
