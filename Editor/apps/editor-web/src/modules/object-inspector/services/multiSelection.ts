import { propertyConstraint, type PropertyConstraint, type SceneObject, type SceneObjectType } from "@grapix/shared-types";
import { inspectorControl, MATERIAL_SURFACE_TYPES } from "./inspectorControls";

/**
 * What the Inspector may edit across a selection of more than one object, and what it must say.
 *
 * The defect this closes: selecting twelve objects and editing X moved **one** of them. The panel read
 * `selectedObjectId` — the *active* member — while the Object Manager maintained the whole set, so an
 * author who had just marquee-selected a row of lower thirds saw a normal-looking field, typed a
 * number, and eleven objects silently stayed put.
 *
 * Three rules, all decided here so they can be tested without a browser:
 *
 * 1. **A field appears only when the write means the same thing for every target.** Not merely "they
 *    all have the property" — a mesh's `rotation` is its Z fallback while a rect's is its only angle,
 *    so mixing them would write one number into two different meanings.
 * 2. **A differing value reads as `Mixed`, never as the active object's value.** Showing the active
 *    value invents data: the author sees `120`, accepts it, and eleven objects that were never 120
 *    become 120 on the next unrelated edit.
 * 3. **A locked target refuses the whole batch.** Writing the ten that are unlocked and skipping the
 *    two that are not is a partial mutation the author cannot see, which is worse than a refusal.
 */

/**
 * Properties that are never batch-edited, and why.
 *
 * Each of these is *identity* rather than *appearance*: writing one value across a set would destroy
 * information rather than align it. Twelve objects sharing one name, one text string or one path is
 * not an edit an author means to make.
 */
export const BATCH_REFUSED: Readonly<Record<string, string>> = {
  name: "Every object would end up with the same name.",
  text: "Each caption carries its own words.",
  src: "Each image points at its own asset.",
  path: "A path belongs to one shape.",
  points: "A line's points belong to one line.",
  strokes: "Brush strokes belong to one paint layer.",
  compoundPaths: "Subpaths belong to one shape.",
  childIds: "Container contents are edited per container.",
  materialSlots: "Bind a material from the Materials tab.",
  bindings: "A data binding names one property of one object.",
  masks: "A mask is drawn on one object.",
  effects: "No renderer draws layer styles.",
  animation: "Keyframes are edited in the Timeline.",
  anchor: "An anchor is measured from its own object's box.",
  cameraKind: "A camera is configured on its own.",
  markerKind: "A marker is configured on its own.",
  meshKind: "Changing a primitive rebuilds one object's geometry.",
  layerKind: "A band's kind is edited on the band."
};

/** Position and opacity mean the same thing on every object type that has them. */
const UNIVERSAL: readonly string[] = ["x", "y", "zDepth", "opacity"];

/** Only where every target's geometry is actually drawn from its box. */
const DIMENSIONS: readonly string[] = ["width", "height"];

/** 2D transform, for a homogeneous non-mesh set. */
const PLANAR_TRANSFORM: readonly string[] = ["rotation", "scaleX", "scaleY"];

/** A mesh rotates and scales in three axes, and its `rotation` is a legacy fallback. */
const MESH_TRANSFORM: readonly string[] = [
  "rotationX", "rotationY", "rotationZ", "scaleX", "scaleY", "scaleZ"
];

/** Paint that a homogeneous set shares. */
const APPEARANCE: readonly string[] = ["fill", "stroke", "strokeWidth"];

/** Type style, for a homogeneous text set. Content is refused; how it is set is not. */
const TEXT_STYLE: readonly string[] = [
  "fontSize", "fontFamily", "fontWeight", "fontStyle", "align", "lineHeight", "letterSpacing",
  "textLayout", "autoFit", "writingMode", "verticalAlign"
];

const DIMENSIONED_TYPES: ReadonlySet<SceneObjectType> = new Set<SceneObjectType>([
  "text", "rect", "ellipse", "image", "mesh"
]);

const APPEARANCE_TYPES: ReadonlySet<SceneObjectType> = new Set<SceneObjectType>([
  "text", "rect", "ellipse", "line", "shape"
]);

export interface SelectionSummary {
  count: number;
  /** Type counts, most numerous first, so the header can say what is selected. */
  byType: Array<{ type: SceneObjectType; count: number }>;
  visible: number;
  hidden: number;
  locked: number;
  /** True when every selected object is the same type, which unlocks the type-specific fields. */
  homogeneous: boolean;
  /** The single type when homogeneous, else null. */
  sharedType: SceneObjectType | null;
}

export function describeSelection(objects: readonly SceneObject[]): SelectionSummary {
  const counts = new Map<SceneObjectType, number>();
  let visible = 0;
  let locked = 0;

  for (const object of objects) {
    counts.set(object.type, (counts.get(object.type) ?? 0) + 1);
    if (object.visible) visible += 1;
    if (object.locked) locked += 1;
  }

  const byType = [...counts.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((left, right) => right.count - left.count || left.type.localeCompare(right.type));

  return {
    count: objects.length,
    byType,
    visible,
    hidden: objects.length - visible,
    locked,
    homogeneous: byType.length === 1 && objects.length > 0,
    sharedType: byType.length === 1 ? byType[0].type : null
  };
}

/**
 * The properties this selection may be edited through, in a stable order.
 *
 * Derived from the existing definitions — `CONTROL_MANIFEST` through `inspectorControl`, and the
 * renderer contract behind it — rather than from a second capability table. A property nothing renders
 * is not offered to one object, so it is not offered to twelve either.
 */
export function batchableProperties(objects: readonly SceneObject[]): string[] {
  if (objects.length < 2) return [];
  const summary = describeSelection(objects);
  const candidates: string[] = [...UNIVERSAL];

  if (objects.every((object) => DIMENSIONED_TYPES.has(object.type))) {
    candidates.push(...DIMENSIONS);
  }

  // Beyond position and opacity, a shared meaning needs a shared type.
  if (summary.homogeneous && summary.sharedType) {
    const type = summary.sharedType;
    candidates.push(...(type === "mesh" ? MESH_TRANSFORM : PLANAR_TRANSFORM));
    if (APPEARANCE_TYPES.has(type)) candidates.push(...APPEARANCE);
    if (type === "text") candidates.push(...TEXT_STYLE);
  }

  return candidates.filter((property) => {
    if (property in BATCH_REFUSED) return false;
    // Every target must be allowed to author it. `inspectorControl` answers from the renderer
    // contract, so a property no renderer consumes never reaches a batch.
    return objects.every((object) => inspectorControl(object.type, property).enabled);
  });
}

export type BatchValue<T> =
  | { kind: "same"; value: T }
  /** The targets disagree. `count` is how many distinct values there are, for the label. */
  | { kind: "mixed"; count: number };

/**
 * One property's value across the selection.
 *
 * Returns `mixed` the moment two targets disagree — deliberately without a representative value, so a
 * caller cannot accidentally render the first one and pass it off as the selection's.
 */
export function batchValue<T>(
  objects: readonly SceneObject[],
  read: (object: SceneObject) => T
): BatchValue<T> {
  const seen: T[] = [];
  for (const object of objects) {
    const value = read(object);
    if (!seen.some((entry) => Object.is(entry, value))) seen.push(value);
  }
  if (seen.length === 1) return { kind: "same", value: seen[0] };
  return { kind: "mixed", count: seen.length };
}

export interface BatchGate {
  /** True when the batch may be written. */
  allowed: boolean;
  /** Ids that would be written. Empty when the gate refuses. */
  targetIds: string[];
  /** Locked members, which refuse the whole batch rather than being skipped. */
  lockedIds: string[];
  /** Why it is refused, in the operator's words. */
  reason?: string;
}

/**
 * Whether a batch may proceed, and over exactly which ids.
 *
 * A locked object refuses the batch. The alternative — writing the unlocked ones — is a partial
 * mutation with no indication, and the author's undo then takes back an edit they did not know the
 * shape of.
 */
export function batchGate(objects: readonly SceneObject[]): BatchGate {
  const lockedIds = objects.filter((object) => object.locked).map((object) => object.id);
  if (lockedIds.length > 0) {
    return {
      allowed: false,
      targetIds: [],
      lockedIds,
      reason: lockedIds.length === 1
        ? "1 locked object must be unlocked before this can be edited."
        : `${lockedIds.length} locked objects must be unlocked before this can be edited.`
    };
  }
  return { allowed: true, targetIds: objects.map((object) => object.id), lockedIds: [] };
}

/** A batch history label that says what happened and to how many. */
export function batchLabel(property: string, count: number): string {
  return `Set ${property} on ${count} object${count === 1 ? "" : "s"}`;
}

/** Whether a Materials tab can act on the whole selection: every target a compatible surface. */
export function batchMaterialSurface(objects: readonly SceneObject[]): boolean {
  return objects.length > 1 && objects.every((object) => MATERIAL_SURFACE_TYPES.has(object.type));
}

/**
 * How each batchable number is read from an object.
 *
 * Explicit accessors rather than an index: the per-type members live on union variants, so indexing
 * would need a cast that fabricates a shape the compiler never checked. Writing them out also puts each
 * property's **default** in one place — a missing `scaleX` is 1, not 0, and a mesh's `rotationZ` falls
 * back to its legacy `rotation`, exactly as `resolveSceneObjectHierarchy` reads it.
 */
const BATCH_READERS: Readonly<Record<string, (object: SceneObject) => number>> = {
  x: (object) => object.x,
  y: (object) => object.y,
  zDepth: (object) => object.zDepth,
  width: (object) => object.width,
  height: (object) => object.height,
  rotation: (object) => object.rotation,
  rotationX: (object) => object.rotationX ?? 0,
  rotationY: (object) => object.rotationY ?? 0,
  rotationZ: (object) => (object.type === "mesh" ? object.rotationZ ?? object.rotation : object.rotation),
  scaleX: (object) => object.scaleX ?? 1,
  scaleY: (object) => object.scaleY ?? 1,
  scaleZ: (object) => object.scaleZ ?? 1,
  opacity: (object) => object.opacity,
  strokeWidth: (object) => object.strokeWidth,
  fontSize: (object) => (object.type === "text" ? object.fontSize : 0),
  lineHeight: (object) => (object.type === "text" ? object.lineHeight ?? object.fontSize * 1.2 : 0),
  letterSpacing: (object) => (object.type === "text" ? object.letterSpacing ?? 0 : 0)
};

/** True when the panel knows how to draw a numeric editor for this property. */
export function isBatchNumber(property: string): boolean {
  return property in BATCH_READERS;
}

export function readBatchNumber(object: SceneObject, property: string): number {
  const reader = BATCH_READERS[property];
  return reader ? reader(object) : 0;
}

/**
 * The constraint every target in the selection agrees on, or nothing when they disagree.
 *
 * A batch can span types, and a range or a unit is per type: `depth` means pixels on a mesh and does
 * not exist elsewhere. Borrowing the first object's constraint would label a mixed selection with a
 * unit only some of it is measured in, and clamp the rest to a range that was never theirs. Unanimous
 * or bare — the same rule the batch itself follows for deciding a field appears at all.
 *
 * Today every batchable property is constrained identically for all types, so this returns a constraint
 * in practice; it is here so that adding one type-specific range cannot quietly mislabel a batch.
 */
export function batchConstraint(
  objects: readonly SceneObject[],
  property: string
): PropertyConstraint | undefined {
  if (objects.length === 0) return undefined;
  const first = propertyConstraint(objects[0].type, property);
  if (!first) return undefined;
  for (let index = 1; index < objects.length; index += 1) {
    const next = propertyConstraint(objects[index].type, property);
    if (!next
      || next.min !== first.min
      || next.max !== first.max
      || next.step !== first.step
      || next.unit !== first.unit) {
      return undefined;
    }
  }
  return first;
}
