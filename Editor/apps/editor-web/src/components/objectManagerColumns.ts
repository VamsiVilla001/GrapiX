/**
 * Which property columns the Object Manager can show, and which of them apply to an object.
 *
 * The panel used to hard-code ten transform columns for every object in the scene — a fixed
 * spreadsheet nobody chose. Columns are now the author's, so this module owns the catalogue,
 * the canonical order and the support rule; the component only renders what it is given.
 *
 * Support routes through `isPropertySupported` rather than a local list. The panel's own copy
 * had already drifted from it: it offered Rotate X and Rotate Y cells on layers and groups,
 * which `resolveSceneObjectHierarchy` never reads, so scrubbing them moved nothing. That is the
 * second-copy failure rule 84 exists to prevent, and one definition is the fix.
 */
import { isPropertyAnimatable, type AnimatableProperty, type SceneObject } from "@grapix/shared-types";
import { isPropertySupported } from "../store/objectPropertySupport";

export type ObjectColumnId =
  | "opacity"
  | "x"
  | "y"
  | "zDepth"
  | "rotationX"
  | "rotationY"
  | "rotationZ"
  | "scaleX"
  | "scaleY"
  | "scaleZ";

export interface ObjectColumn {
  id: ObjectColumnId;
  /** Header text. Short, because the column is as wide as its numbers need. */
  label: string;
  /** Longer name for the picker and for assistive technology. */
  description: string;
}

/**
 * The catalogue, in the order columns always appear.
 *
 * Chosen columns are re-sorted into this order rather than kept in click order: a table whose
 * columns sit wherever they happened to be enabled is one an author has to re-read every time.
 */
export const OBJECT_COLUMNS: readonly ObjectColumn[] = [
  { id: "opacity", label: "Alpha", description: "Opacity, shown as 0–100" },
  { id: "x", label: "X", description: "Horizontal position" },
  { id: "y", label: "Y", description: "Vertical position" },
  { id: "zDepth", label: "Z", description: "Depth position" },
  { id: "rotationX", label: "Rot X", description: "Rotation about the X axis" },
  { id: "rotationY", label: "Rot Y", description: "Rotation about the Y axis" },
  { id: "rotationZ", label: "Rot Z", description: "Rotation about the Z axis" },
  { id: "scaleX", label: "Scale X", description: "Horizontal scale" },
  { id: "scaleY", label: "Scale Y", description: "Vertical scale" },
  { id: "scaleZ", label: "Scale Z", description: "Depth scale" }
];

/** Enough to be useful on first open, far short of a spreadsheet. */
export const DEFAULT_OBJECT_COLUMNS: readonly ObjectColumnId[] = ["opacity", "x", "y"];

/**
 * The animation channel a column edits.
 *
 * `rotationZ` is the one column that resolves differently per object: a mesh carries its Z
 * angle on `rotationZ`, everything else carries the same angle on `rotation`, and offering both
 * would be two controls for one value.
 */
export function columnProperty(object: SceneObject, column: ObjectColumnId): AnimatableProperty {
  if (column === "rotationZ") return object.type === "mesh" ? "rotationZ" : "rotation";
  return column;
}

export function isColumnSupported(object: SceneObject, column: ObjectColumnId): boolean {
  return isPropertySupported(object, columnProperty(object, column));
}

/**
 * Whether this column's cell may offer a stopwatch.
 *
 * A supported column is not automatically an animatable one: Z-Pos is editable on a rect — depth is
 * real paint order — while a *channel* on it is discarded by Program, so the cell shows the value
 * and no stopwatch. The rule is `isPropertyAnimatable` in `@grapix/shared-types`, which package
 * preflight also consults; this panel must not decide it locally.
 */
export function isColumnAnimatable(object: SceneObject, column: ObjectColumnId): boolean {
  return isPropertyAnimatable(object.type, columnProperty(object, column));
}

/** Read the object's own value for a column, ignoring animation. */
export function readColumnValue(object: SceneObject, column: ObjectColumnId): number {
  const record = object as unknown as Record<string, unknown>;
  const value = record[columnProperty(object, column)];
  if (typeof value === "number") return value;
  return column === "scaleX" || column === "scaleY" || column === "scaleZ" ? 1 : 0;
}

/**
 * Normalise a stored column choice.
 *
 * Unknown ids are dropped rather than rendered as empty columns, because the set is persisted
 * and a build that removes a column would otherwise leave a permanent blank stripe in the grid.
 */
export function orderColumns(ids: readonly string[]): ObjectColumnId[] {
  const chosen = new Set(ids);
  return OBJECT_COLUMNS.filter((column) => chosen.has(column.id)).map((column) => column.id);
}

export function toggleColumn(ids: readonly ObjectColumnId[], column: ObjectColumnId): ObjectColumnId[] {
  return orderColumns(ids.includes(column) ? ids.filter((id) => id !== column) : [...ids, column]);
}

/**
 * How the visible columns are decided.
 *
 * `keyframed` is a **mode**, not a one-shot selection: enabling a stopwatch on Scale X makes
 * that column appear, and removing its last key makes it leave again. A snapshot taken once
 * would go stale the moment the author animated anything, which is the whole reason to have the
 * toggle rather than a button that fills the set in.
 */
export type ObjectColumnMode = "all" | "keyframed" | "custom";

/**
 * The columns to render.
 *
 * `custom` is the only mode that reads the stored set; the other two derive it, so switching
 * back to `custom` restores whatever the author had picked rather than whatever the mode last
 * happened to show.
 */
export function resolveColumns(
  mode: ObjectColumnMode,
  custom: readonly string[],
  objects: readonly SceneObject[]
): ObjectColumnId[] {
  if (mode === "all") return OBJECT_COLUMNS.map((column) => column.id);
  if (mode === "keyframed") return animatedColumns(objects);
  return orderColumns(custom);
}

/**
 * Columns that at least one object actually animates.
 *
 * Answering from the scene rather than from the selection keeps the set stable while an author
 * clicks through objects — a column that vanished on selecting a still object would be unusable.
 *
 * A channel on a property the object cannot animate does not count. A scene authored before the
 * animatability gate can hold an inert `zDepth` channel, and surfacing a Z-Pos column for it would
 * put a stopwatch-less column under a heading that claims something in this scene keyframes depth.
 */
export function animatedColumns(objects: readonly SceneObject[]): ObjectColumnId[] {
  return OBJECT_COLUMNS.filter((column) =>
    objects.some((object) => {
      if (!isColumnSupported(object, column.id)) return false;
      if (!isColumnAnimatable(object, column.id)) return false;
      return Boolean(object.animation?.[columnProperty(object, column.id)]?.keys.length);
    })
  ).map((column) => column.id);
}
