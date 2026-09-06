import { ANIMATABLE_PROPERTIES, isPropertyAnimatable, resolveDataPath, sampleChannel } from "./index.js";
import type { AnimatableProperty, SceneObject, SceneProperty } from "./index.js";

/**
 * Which value is in force for one property, and which renderer agrees.
 *
 * A property can get its number from three places — the authored field, a keyframe channel, or a data
 * binding — and until now the panel showed only the first two while the renderer preferred the third.
 * The Editor's Preview prepares a scene in this order:
 *
 * 1. `evaluateSceneAtFrame` samples every channel into the objects,
 * 2. `resolveSceneObjectHierarchy` composes parent transforms into children,
 * 3. `applyBindings` writes resolved data over whatever is there (`sceneMaterial.ts:35-38`).
 *
 * So **a binding wins over a keyframe**, and the field that samples only the channel shows a number
 * nothing draws. That is the defect this closes.
 *
 * The second fact is larger and was not written down anywhere: **the native renderer resolves no data
 * bindings at all.** `SceneDocumentDto` has no `dataContext` field
 * (`services/render-daemon/src/scene/document.rs:41-54`), nothing in `services/render-engine/src`
 * resolves a path, and `dataContext` is read in exactly one place in the Editor — `sceneMaterial.ts`.
 * Channels *are* sampled on air (`services/render-engine/src/animation.rs:70-86`). So a bound property
 * animates in Preview and holds its authored value on Program, and only saying so makes the panel
 * honest.
 *
 * This module is pure: it reads, it never writes, and it has no React or DOM dependency, so the whole
 * precedence question is testable without a renderer.
 */

export type PropertySourceKind =
  /** No channel and no binding: the authored field is the value. */
  | "static"
  /** A channel with keys, and no binding over it. */
  | "keyframed"
  /** A binding whose path resolves to a value the renderer will assign. */
  | "bound"
  /** A binding whose path resolves to nothing. */
  | "binding-missing"
  /** A binding whose path resolves to a value of the wrong JavaScript type. */
  | "binding-type-mismatch"
  /** A binding the renderer cannot assign to this object type however well the path resolves. */
  | "binding-unsupported";

export interface PropertySource {
  kind: PropertySourceKind;
  /** The value the Editor's Preview draws at this frame. */
  preview: unknown;
  /**
   * The value Program draws at this frame.
   *
   * Equal to `preview` except where a binding is involved, because the native renderer resolves none.
   */
  program: unknown;
  /** False when Preview and Program draw different values for this property. */
  agrees: boolean;
  /** The bound path, for every kind that begins `binding-` and for `bound`. */
  path?: string;
  /** Number of keys on the channel, for `keyframed`. */
  keyCount?: number;
  /** The JavaScript type the path resolved to, for `binding-type-mismatch`. */
  found?: string;
  /** The type the renderer requires, for `binding-type-mismatch`. */
  expected?: string;
  /** Why the renderer cannot assign it, for `binding-unsupported`. */
  reason?: string;
}

/**
 * The JavaScript type each bindable property requires, mirroring `assignBoundValue`.
 *
 * Read from the assigner rather than invented: `text` and `src` are `String(value)`-coerced so anything
 * goes, `fill`/`stroke` require a string, `visible` is `Boolean(value)`-coerced, and every numeric
 * property is written only `if (typeof value === "number")` — with **no else**, which is why a string
 * bound to `x` disappears without a word today.
 */
const BINDING_VALUE_TYPE: Readonly<Record<string, "number" | "string" | "any">> = {
  text: "any",
  src: "any",
  visible: "any",
  fill: "string",
  stroke: "string",
  x: "number",
  y: "number",
  zDepth: "number",
  width: "number",
  height: "number",
  rotation: "number",
  rotationX: "number",
  rotationY: "number",
  rotationZ: "number",
  scaleX: "number",
  scaleY: "number",
  scaleZ: "number",
  opacity: "number"
};

/**
 * Every property a data binding can target, in the order an authoring surface should list them.
 *
 * This is the one home. The Editor kept its own `BINDABLE_PROPERTIES` beside its own per-type support
 * rule, and that copy had already drifted from the applier it described: it advertised `scaleZ` on
 * layers and groups "because a container inherits it", while `assignBoundValue` writes `scaleZ` for
 * meshes only — so the option existed, resolved, type-checked, and moved nothing. A list kept next to
 * the code that honours it cannot make that claim.
 */
export const BINDABLE_SCENE_PROPERTIES: readonly SceneProperty[] = [
  // Content first, because that is what most bindings are for.
  "text",
  "src",
  "fill",
  "stroke",
  "visible",
  // Then the transform, in the order the Inspector reads it.
  "x",
  "y",
  "zDepth",
  "width",
  "height",
  "rotation",
  "rotationX",
  "rotationY",
  "rotationZ",
  "scaleX",
  "scaleY",
  "scaleZ",
  "opacity"
];

/**
 * Properties `assignBoundValue` writes for meshes only, and the reason.
 *
 * `index.ts:4548-4551` guards `rotationX`, `rotationY`, `rotationZ` and `scaleZ` behind
 * `object.type === "mesh"`. A binding on any other type resolves, passes its type check, and is then
 * dropped on the floor.
 */
const MESH_ONLY_BINDINGS: ReadonlySet<string> = new Set(["rotationX", "rotationY", "rotationZ", "scaleZ"]);

/** Whether the renderer's binding applier can write this property onto this object at all. */
export function isBindingAssignable(object: SceneObject, property: string): boolean {
  if (!(property in BINDING_VALUE_TYPE)) return false;
  if (property === "text") return object.type === "text";
  if (property === "src") return object.type === "image";
  if (MESH_ONLY_BINDINGS.has(property)) return object.type === "mesh";
  return true;
}

function unassignableReason(object: SceneObject, property: string): string {
  if (property === "text") return `Only a text object has text; this is a ${object.type}.`;
  if (property === "src") return `Only an image object has a source; this is a ${object.type}.`;
  if (MESH_ONLY_BINDINGS.has(property)) {
    return `Three-axis rotation and depth scale are written for meshes only, so a ${object.type} ignores this.`;
  }
  return `Nothing assigns ${property} on a ${object.type}.`;
}

/** The authored value of a property, as the object holds it. */
function authoredValue(object: SceneObject, property: string): unknown {
  return (object as unknown as Record<string, unknown>)[property];
}

/**
 * The value in force for one property of one object at one frame.
 *
 * `dataContext` is the scene's, and `frame` the playhead. Neither the object nor the context is
 * mutated. The kinds are decided in the order the renderer applies them, so this cannot drift from the
 * picture without a test failing.
 */
export function resolvePropertySource(
  object: SceneObject,
  property: string,
  dataContext: Record<string, unknown>,
  frame: number
): PropertySource {
  const authored = authoredValue(object, property);

  // Step 1, as the renderer does it: the channel, if the object's kind can animate this property.
  const channel = isAnimatableName(property) && isPropertyAnimatable(object.type, property)
    ? object.animation?.[property]
    : undefined;
  const sampled = channel && channel.keys.length > 0
    ? sampleChannel(channel, frame, { objectId: object.id, property })
    : undefined;
  const beforeBinding = sampled ?? authored;
  const keyCount = channel?.keys.length;

  // Step 2: the binding, which overwrites whatever step 1 produced.
  const path = object.bindings[property as SceneProperty];
  if (!path || !path.trim()) {
    const kind = sampled === undefined ? "static" : "keyframed";
    return {
      kind,
      preview: beforeBinding,
      program: beforeBinding,
      agrees: true,
      ...(kind === "keyframed" ? { keyCount } : {})
    };
  }

  // A binding the applier cannot write is inert however well its path resolves, so that is decided
  // before the path is read: otherwise a valid path would report `bound` for a value nothing assigns.
  if (!isBindingAssignable(object, property)) {
    return {
      kind: "binding-unsupported",
      preview: beforeBinding,
      program: beforeBinding,
      agrees: true,
      path,
      reason: unassignableReason(object, property)
    };
  }

  const resolved = resolveDataPath(dataContext, path);
  if (resolved === undefined) {
    // `applyBindings` skips an undefined resolution, so the value in force is whatever step 1 left.
    return {
      kind: "binding-missing",
      preview: beforeBinding,
      program: beforeBinding,
      agrees: true,
      path
    };
  }

  const expected = BINDING_VALUE_TYPE[property];
  if (expected !== "any" && typeof resolved !== expected) {
    // `assignBoundValue`'s type check fails and there is no else branch, so the write never happens.
    return {
      kind: "binding-type-mismatch",
      preview: beforeBinding,
      program: beforeBinding,
      agrees: true,
      path,
      found: describeType(resolved),
      expected
    };
  }

  const bound = coerceBoundValue(property, resolved);
  return {
    kind: "bound",
    preview: bound,
    // Program resolves no bindings, so it draws what step 1 left — which is the parity gap.
    program: beforeBinding,
    agrees: sameValue(bound, beforeBinding),
    path,
    ...(keyCount === undefined ? {} : { keyCount })
  };
}

/** What the applier actually stores, so a reported value is the drawn value. */
function coerceBoundValue(property: string, value: unknown): unknown {
  if (property === "text" || property === "src") return String(value);
  if (property === "visible") return Boolean(value);
  return value;
}

function sameValue(left: unknown, right: unknown): boolean {
  if (typeof left === "number" && typeof right === "number") {
    return left === right || (Number.isNaN(left) && Number.isNaN(right));
  }
  return left === right;
}

/** A type name an author can act on: `null` and arrays are not "object". */
export function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * Whether this name is one of the channel properties.
 *
 * Read at call time, not at module load. `index.ts` re-exports this module, so a `Set` built from
 * `ANIMATABLE_PROPERTIES` at the top level runs before the barrel has initialised it and throws
 * `Cannot access 'ANIMATABLE_PROPERTIES' before initialization` — which takes the whole package's
 * test suite down, not just this file. The sibling contract modules avoid it by importing only types.
 *
 * The list is twelve entries, so a scan costs less than the indirection to avoid it would.
 */
function isAnimatableName(property: string): property is AnimatableProperty {
  return (ANIMATABLE_PROPERTIES as readonly string[]).includes(property);
}

/**
 * A one-line statement of the source, for a field to show beside its number.
 *
 * The wording says what is drawn and where it came from, and names the renderer when they disagree —
 * "Bound: data.score" is only useful next to "Program draws 0", because otherwise an author reads the
 * bound number and believes it is on air.
 */
export function describePropertySource(source: PropertySource): string {
  switch (source.kind) {
    case "static":
      return "";
    case "keyframed":
      return `Keyframed · ${source.keyCount} ${source.keyCount === 1 ? "key" : "keys"}`;
    case "bound":
      return `Bound: ${source.path} · Program draws ${formatValue(source.program)}, which resolves no bindings`;
    case "binding-missing":
      return `Bound: ${source.path} — not found in the scene data, so ${formatValue(source.preview)} is drawn`;
    case "binding-type-mismatch":
      return `Bound: ${source.path} — resolves to a ${source.found}, and this property needs a ${source.expected}, so ${formatValue(source.preview)} is drawn`;
    case "binding-unsupported":
      return `Bound: ${source.path} — ${source.reason}`;
  }
}

function formatValue(value: unknown): string {
  if (typeof value === "number") return String(Math.round(value * 1000) / 1000);
  if (typeof value === "string") return `"${value}"`;
  return String(value);
}
