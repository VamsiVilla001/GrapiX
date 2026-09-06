import {
  propertyRendererSupport,
  type PropertySupport,
  type SceneObject,
  type SceneObjectType
} from "@grapix/shared-types";

/**
 * What the Inspector is allowed to offer for one property, and what it must say about it.
 *
 * The panel used to decide this inline, control by control, with the explanation typed next to each
 * `disabled` prop. That is how the shape fill-rule note came to claim the opposite of what the
 * renderers do, and how `paragraphSpacing` stayed enabled while its neighbours `textIndent` and
 * `overflow` were correctly disabled — two properties with the same support, treated differently,
 * because the decision lived in two places.
 *
 * Now there is one question — `inspectorControl(type, property)` — answered from
 * `PROPERTY_RENDERER_SUPPORT` in `@grapix/shared-types`. The panel cannot disagree with the contract
 * because it no longer holds an opinion, and `CONTROL_MANIFEST` below lets the audit test check the
 * whole panel without a browser.
 */

export interface InspectorControl {
  /** False when no renderer consumes the value: the control must be disabled or absent. */
  enabled: boolean;
  /** The gap, in the operator's words. Present whenever the contract has something to say. */
  note?: string;
  /** The contract's verdict, for tests and for callers that want to style by it. */
  support?: PropertySupport["support"];
}

const AUTHORABLE: InspectorControl = { enabled: true };

export function inspectorControl(objectType: SceneObjectType, property: string): InspectorControl {
  const claim = propertyRendererSupport(objectType, property);
  if (!claim) return AUTHORABLE;
  return {
    // `editor` is authoring state — a name, a lock — and stays fully editable. Only `neither` is a
    // value that was meant to reach the screen and does not.
    enabled: claim.support !== "neither",
    note: claim.note,
    support: claim.support
  };
}

/**
 * Object types whose pixels a bound material actually reaches.
 *
 * One definition, read by the quick-field filter in `Inspector.tsx` and by the tab descriptors in
 * `objectInspectorTabs.ts`, which had drifted: `paint` was a material surface in both, and a paint
 * layer draws every stroke from `stroke.color`, opacity and flow (`GpuSceneRenderer.ts:795-829`) while
 * `sceneMaterial.ts:77-80` excludes paint from face resolution altogether. So an author could bind a
 * material to a paint layer, see the strokes keep their own colours, and have no way to tell why.
 *
 * `line` was already excluded for the same reason — a stroke is not a surface — which is the precedent
 * this follows.
 */
export const MATERIAL_SURFACE_TYPES: ReadonlySet<SceneObjectType> = new Set<SceneObjectType>([
  "text",
  "rect",
  "ellipse",
  "image",
  "shape",
  "mesh"
]);

export function isMaterialSurface(objectType: SceneObjectType): boolean {
  return MATERIAL_SURFACE_TYPES.has(objectType);
}

/**
 * A value the panel reports but refuses to edit.
 *
 * `textCase` is the case this exists for: the browser Preview **applies** it (`GpuSceneRenderer.ts:965`)
 * and no UI has ever set it, so only an importer can. Leaving it invisible meant Preview silently
 * upper-cased a caption with nothing in the panel accounting for it; offering a control would let an
 * author choose a case the native renderer ignores, publishing text they never approved. Reporting it
 * is the only honest third option.
 *
 * Resolved here rather than in JSX so the panel's behaviour is provable without a browser.
 */
export interface ReadOnlyDisclosure {
  property: string;
  label: string;
  value: string;
  note?: string;
}

export function importedDisclosures(object: SceneObject): ReadOnlyDisclosure[] {
  const disclosures: ReadOnlyDisclosure[] = [];

  if (object.type === "text" && object.textCase && object.textCase !== "original") {
    disclosures.push({
      property: "textCase",
      label: "Letter case (imported)",
      value: object.textCase,
      note: inspectorControl("text", "textCase").note
    });
  }

  return disclosures;
}

/**
 * Every property the Object Inspector puts a control on, by object type.
 *
 * Declared rather than discovered, for one reason: there is no DOM in the test runner, so an audit
 * cannot walk the rendered panel. This list is the panel's own account of what it offers, and the
 * audit holds it against the contract — no enabled control for a `neither` property, and a note
 * wherever the contract has one.
 *
 * **Adding a control means adding it here.** That is the point: a new field cannot reach an author
 * without someone stating which renderers honour it, which is the check that was missing when eleven
 * dishonest controls accumulated.
 */
export const CONTROL_MANIFEST: Readonly<Record<SceneObjectType, readonly string[]>> = {
  text: [
    "text", "fontSize", "fontFamily", "fontWeight", "fontStyle", "align", "lineHeight",
    "letterSpacing", "wordSpacing", "paragraphSpacing", "textIndent", "overflow", "textLayout",
    "autoFit", "writingMode", "verticalAlign", "direction", "textDecoration",
    "x", "y", "width", "height", "rotation", "scaleX", "scaleY", "opacity", "fill", "stroke",
    "strokeWidth", "visible", "locked", "name", "anchor", "effects"
  ],
  rect: [
    "radius", "x", "y", "width", "height", "rotation", "scaleX", "scaleY", "opacity", "fill",
    "stroke", "strokeWidth", "visible", "locked", "name", "anchor", "effects"
  ],
  ellipse: [
    "x", "y", "width", "height", "rotation", "scaleX", "scaleY", "opacity", "fill", "stroke",
    "strokeWidth", "visible", "locked", "name", "anchor", "effects"
  ],
  image: [
    "src", "objectFit", "x", "y", "width", "height", "rotation", "scaleX", "scaleY", "opacity",
    "visible", "locked", "name", "anchor", "effects"
  ],
  // No width or height: a line is drawn from its points, and offering a size that changes nothing was
  // the second-worst control in the panel.
  line: [
    "points", "x", "y", "rotation", "scaleX", "scaleY", "opacity", "stroke", "strokeWidth",
    "visible", "locked", "name", "anchor", "effects"
  ],
  shape: [
    "path", "pathAnimation", "trimStart", "trimEnd", "trimOffset", "fillEnabled", "strokeEnabled",
    "fillRule", "x", "y", "rotation", "scaleX", "scaleY", "opacity", "fill", "stroke", "strokeWidth",
    "visible", "locked", "name", "anchor", "effects"
  ],
  paint: [
    "strokes", "x", "y", "rotation", "scaleX", "scaleY", "opacity", "visible", "locked", "name",
    "anchor", "effects"
  ],
  mesh: [
    "meshKind", "depth", "slab", "anchor3d", "clipName", "x", "y", "zDepth", "width", "height",
    "rotationX", "rotationY", "rotationZ", "scaleX", "scaleY", "scaleZ", "opacity", "fill",
    "visible", "locked", "name", "effects"
  ],
  light: [
    "lightKind", "intensity", "color", "range", "decay", "coneAngleDeg", "penumbra", "target",
    // A dimmer, not transparency: both renderers multiply intensity by it. It had no control at all
    // until the transform group stopped being gated by one flag for camera and light together.
    "opacity",
    "castShadow", "x", "y", "zDepth", "visible", "locked", "name", "effects"
  ],
  camera: [
    "cameraKind", "fov", "zoom", "near", "far", "target", "up", "x", "y", "zDepth", "visible",
    "locked", "name", "effects"
  ],
  layer: ["layerKind", "childIds", "x", "y", "opacity", "visible", "locked", "name", "effects"],
  group: ["childIds", "x", "y", "opacity", "visible", "locked", "name", "effects"],
  // Deliberately no `eventName`: nothing subscribes to it.
  marker: ["markerKind", "x", "y", "visible", "locked", "name"]
};
