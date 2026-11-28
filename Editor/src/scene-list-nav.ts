// Keyboard and pointer rules of the Scene Manager's list view (build plan 11.72).
//
// Borrowed from XPression Designer's Scene Manager: a dense list where one click
// selects a scene, Enter opens it, Delete removes it (XPression asks "are you sure?"),
// and a right-click offers the scene's commands. Pure, so every rule is testable
// without a page.

export type ListKey = "ArrowDown" | "ArrowUp" | "Home" | "End";

/** The row a navigation key moves to, or `undefined` when the key is not a navigation key. */
export function moveRow(
  ids: readonly string[],
  current: string | undefined,
  key: string,
): string | undefined {
  if (ids.length === 0) return undefined;
  const at = current === undefined ? -1 : ids.indexOf(current);
  switch (key) {
    case "ArrowDown":
      return ids[Math.min(ids.length - 1, at + 1)];
    case "ArrowUp":
      return ids[Math.max(0, at - 1)];
    case "Home":
      return ids[0];
    case "End":
      return ids[ids.length - 1];
    default:
      return undefined;
  }
}

export type RowCommand = "open" | "delete" | "menu" | "rename" | "changeId";

/**
 * What a key does to the focused row. Shift+F10 and the menu key open the context menu; F2 renames the scene and F7 changes its Scene ID,
 * the keys XPression's Scene Manager uses (11.72).
 */
export function rowCommand(key: string, shift = false): RowCommand | undefined {
  if (key === "Enter") return "open";
  if (key === "Delete") return "delete";
  if (key === "F2" && !shift) return "rename";
  if (key === "F7" && !shift) return "changeId";
  if (key === "ContextMenu" || (key === "F10" && shift)) return "menu";
  return undefined;
}

/** How long a first Delete stays armed, in milliseconds. */
export const DELETE_ARM_MS = 3000;

/**
 * Delete is permanent, so it takes two presses on the same row: the first arms it and
 * says so, the second within `DELETE_ARM_MS` deletes. Pressing anything else, or Delete
 * on another row, disarms it. There is no dialog to dismiss by reflex.
 */
export interface DeleteArm {
  /** `true` when this press deletes; `false` when it only armed (or re-armed). */
  press(id: string, now: number): boolean;
  disarm(): void;
  armed(): string | undefined;
}

export function createDeleteArm(): DeleteArm {
  let target: string | undefined;
  let since = 0;
  return {
    press(id, now) {
      if (target === id && now - since <= DELETE_ARM_MS) {
        target = undefined;
        return true;
      }
      target = id;
      since = now;
      return false;
    },
    disarm() {
      target = undefined;
    },
    armed: () => target,
  };
}
