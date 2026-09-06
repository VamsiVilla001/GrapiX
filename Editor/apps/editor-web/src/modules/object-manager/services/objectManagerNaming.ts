import type { SceneObject } from "@grapix/shared-types";
import { normalizeLayerId } from "../../../store/layerIds";

/**
 * Why a rename cannot be committed, in the words the author sees — or `null` when it can.
 *
 * Pure, because the interesting part is the *prediction*: the store already refuses a clashing rename
 * by returning `false`, and the panel used to discover that after the fact and raise a `window.alert`.
 * A modal for a condition you could have shown inline, on a draft the author is still typing, is the
 * worst of both — it blocks the app and it arrives too late to guide the keystroke.
 */

/** Whether a rename of a band would collide with another band that already exists. */
export function layerRenameError(
  objects: readonly SceneObject[],
  layerId: string,
  draft: string
): string | null {
  const trimmed = draft.trim();
  if (!trimmed) return null; // An empty draft is a cancel, not an error.

  const next = normalizeLayerId(trimmed);
  if (!next) return "A layer name needs at least one letter or number";
  if (next === layerId) return null;

  const existing = new Set(objects.map((object) => object.layerId || "main"));
  if (existing.has(next)) {
    // Name the slug, because that is what actually collided: "Lower Third" and "lower third" are one
    // band, and an author told only about the display name has no way to see why.
    return `Another layer already uses the id "${next}"`;
  }
  return null;
}

/**
 * Whether a rename of an object would collide.
 *
 * Object names are compared case-insensitively because `renameObject` compares them that way; the
 * panel must predict the store's answer, not a nicer one.
 */
export function objectRenameError(
  objects: readonly SceneObject[],
  objectId: string,
  draft: string
): string | null {
  const trimmed = draft.trim();
  if (!trimmed) return null;

  const clash = objects.find(
    (object) => object.id !== objectId && object.name.trim().toLocaleLowerCase() === trimmed.toLocaleLowerCase()
  );
  return clash ? `Another object is already called "${clash.name}"` : null;
}
