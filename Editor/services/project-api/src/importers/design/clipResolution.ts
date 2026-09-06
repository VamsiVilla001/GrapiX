/**
 * Turning a source's clipping into structure GrapiX renders and an author can edit.
 *
 * Design tools express "do not draw outside this" two ways, and both are resolved here, once, for
 * every importer:
 *
 * 1. **A clipping container** — Figma's `clipsContent` on a frame, section, component or instance;
 *    an SVG `clipPath` on a group; a Photoshop clip group. It becomes a **nested clip composition**:
 *
 *    ```text
 *    Clip Composition          the container itself, at its own position and rotation
 *    ├── Clip Shape            its exact geometry: size, corners, vector outline, and its paint
 *    └── Content Composition    carries the clip; everything inside is clipped by it
 *        ├── Child Layer 1      original order, original transforms
 *        └── Child Layer 2
 *    ```
 *
 *    Why a composition rather than a mask copied onto every descendant, which is what this did
 *    before: one clip, in one place, that an author can select, move and reshape — reshape the Clip
 *    Shape and everything inside follows. A copy per descendant meant fifty masks to keep in step,
 *    and a child moved out of the frame kept a mask that no longer meant anything. Nesting is
 *    recursive: a clipping frame inside a clipping frame produces a clip composition inside a
 *    content composition, and the clips intersect because both are in force.
 *
 * 2. **A mask layer** — Figma's `isMask`: the layer is not drawn, and its outline masks the siblings
 *    above it in the same parent. Its geometry is its own path, or the union of its children's paths
 *    when the mask is a group.
 *
 * Why here rather than in each importer: one implementation for Figma, Illustrator, Photoshop and
 * SVG, and it runs before flattening, so a clip cannot be lost with the container that carried it.
 *
 * Coordinates: a mask path is in the **masked object's own** space, because that is what
 * `ObjectMask.path` means to both renderers. A container's mask reaches its descendants through
 * `resolveSceneObjectHierarchy`, which restates the path in each one's local space — a container is
 * never drawn itself, so a mask that stayed on it would clip nothing.
 */

import {
  createSceneId,
  type BezierPath,
  type DesignImportReport,
  type NormalizedDesignMask,
  type NormalizedDesignNode
} from "@grapix/shared-types";

import { addDesignImportIssue } from "./importReport.js";
import { rectanglePath, roundedRectanglePath } from "./svgPath.js";

/** Node types whose `clipsContent` is honoured. A group never clips in any source tool. */
const CLIPPING_TYPES = new Set(["frame", "artboard", "section", "component", "component-set", "instance"]);

export interface ClipResolutionResult {
  nodes: NormalizedDesignNode[];
  /** Clip compositions built, and mask layers resolved. */
  clippedContainers: number;
  resolvedMasks: number;
  /** Layers this pass created: the clip shape and the content composition, per clipped container. */
  syntheticLayers: number;
  /**
   * Ids of the mask layers that were consumed into masks, ours and the source's.
   *
   * They are no longer nodes, but they *were* imported — as masks. The report's pruning pass drops
   * issues about layers that are not in the finished document, so without these the line explaining
   * that a mask was resolved (and that an alpha mask is an approximation) was deleted before an
   * author ever saw it.
   */
  consumedMaskIds: string[];
}

/** The mutable tally threaded through the walk. */
interface Counters {
  clippedContainers: number;
  resolvedMasks: number;
  syntheticLayers: number;
  consumedMaskIds: string[];
}

/**
 * Resolve every clip and mask in a page's node tree.
 *
 * Returns a new tree; nothing is mutated, because the caller keeps the normalized document as the
 * import's provenance record and a mutated copy would make the report describe something the
 * document no longer says.
 */
export function resolveClipsAndMasks(
  nodes: NormalizedDesignNode[],
  report: DesignImportReport
): ClipResolutionResult {
  const counters: Counters = { clippedContainers: 0, resolvedMasks: 0, syntheticLayers: 0, consumedMaskIds: [] };
  const resolved = resolveSiblings(nodes, report, counters);
  return { nodes: resolved, ...counters };
}

/**
 * One sibling run, in document order.
 *
 * A mask layer applies to the siblings that come after it — those drawn above it — until the end of
 * the parent or the next mask layer, which starts its own group. That is Figma's rule, and it is why
 * this walks a run rather than a set.
 */
function resolveSiblings(
  nodes: NormalizedDesignNode[],
  report: DesignImportReport,
  counters: Counters
): NormalizedDesignNode[] {
  let active: { mask: NormalizedDesignMask; x: number; y: number } | null = null;
  const result: NormalizedDesignNode[] = [];

  for (const node of nodes) {
    if (node.isMask) {
      active = { mask: maskFromNode(node, report), x: node.x, y: node.y };
      counters.resolvedMasks += 1;
      counters.consumedMaskIds.push(node.id);
      if (node.sourceId) counters.consumedMaskIds.push(node.sourceId);
      addDesignImportIssue(report, {
        kind: "converted",
        severity: "info",
        message:
          node.maskType && node.maskType !== "vector"
            ? `${node.name} is a ${node.maskType} mask; it was converted to its outline, which is what GrapiX masks sample. A ${node.maskType} mask that relies on soft or partial pixels will look harder-edged.`
            : `${node.name} masks the layers above it; it was converted to an editable GrapiX mask on each of them.`,
        sourceNodeId: node.sourceId ?? node.id,
        sourceNodeName: node.name,
        ...(node.maskType && node.maskType !== "vector"
          ? { fallback: "Vector outline of the mask layer" }
          : {})
      });
      // The mask layer itself is not drawn. Its children are part of its geometry, not content.
      continue;
    }

    // A mask layer's geometry is measured from its own origin, so moving it into a sibling's space
    // shifts it by the difference between the two.
    const siblingMasks = active
      ? [shiftMask(active.mask, active.x - node.x, active.y - node.y)]
      : [];

    result.push(resolveNode(node, siblingMasks, report, counters));
  }

  return result;
}

/**
 * One node, with its subtree — and a clip composition around it when it clips.
 *
 * `siblingMasks` are the masks a mask layer in the same run imposes on this node, already in this
 * node's coordinate space.
 */
function resolveNode(
  node: NormalizedDesignNode,
  siblingMasks: NormalizedDesignMask[],
  report: DesignImportReport,
  counters: Counters
): NormalizedDesignNode {
  const children = resolveSiblings(node.children, report, counters);
  const clips = node.clipsContent === true && CLIPPING_TYPES.has(node.type);

  if (!clips) {
    return { ...node, masks: [...siblingMasks, ...node.masks], children };
  }

  counters.clippedContainers += 1;
  // The clip shape and the content composition: two layers with no source node behind them.
  counters.syntheticLayers += 2;
  addDesignImportIssue(report, {
    kind: "converted",
    severity: "info",
    message: `${node.name} clips its contents. It was imported as a clip composition: a "${node.name} clip shape" holding its exact geometry, and a "${node.name} contents" composition carrying the clip, with all ${children.length} child layer(s) inside it at their original transforms.`,
    sourceNodeId: node.sourceId ?? node.id,
    sourceNodeName: node.name,
    fallback: "Nested clip composition"
  });

  return buildClipComposition(node, children, siblingMasks);
}

/**
 * The clip composition.
 *
 * The outer node keeps the container's identity, position, rotation and transform — every reference
 * to it, in the report and in `importedDesign`, still points at the same layer. What changes is what
 * it contains:
 *
 * - **Clip Shape** holds the geometry, and the container's own paint with it: a frame's background
 *   is drawn by the shape that defines the clip, which is both true to the source and the thing an
 *   author reaches for when they want to change either.
 * - **Content Composition** carries the clip mask. It is a container, so it is never drawn itself;
 *   `resolveSceneObjectHierarchy` hands the mask to each descendant in that descendant's own space.
 *
 * Both are at the origin of the composition, so the children's transforms are untouched.
 */
function buildClipComposition(
  node: NormalizedDesignNode,
  children: NormalizedDesignNode[],
  siblingMasks: NormalizedDesignMask[]
): NormalizedDesignNode {
  const geometry = clipGeometry(node);

  const clipShape: NormalizedDesignNode = {
    ...node,
    id: `${node.id}-clip-shape`,
    ...(node.sourceId ? { sourceId: node.sourceId } : {}),
    name: `${node.name} clip shape`,
    // A path, so the shape is the container's exact outline — a rounded frame clips with its own
    // corners, and a vector clip keeps the outline the designer drew.
    type: "path",
    x: 0,
    y: 0,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    anchor: { x: 0, y: 0 },
    opacity: 1,
    path: geometry,
    compoundPaths: node.compoundPaths,
    // The container's paint moves here: it is the object that now draws that rectangle.
    fills: node.fills,
    strokes: node.strokes,
    masks: [],
    children: [],
    clipsContent: false,
    isMask: false,
    sourceData: {
      ...node.sourceData,
      role: "clip-shape",
      clipsContentSource: node.sourceId ?? node.id
    }
  };

  const contents: NormalizedDesignNode = {
    ...node,
    id: `${node.id}-contents`,
    ...(node.sourceId ? { sourceId: node.sourceId } : {}),
    name: `${node.name} contents`,
    type: "group",
    x: 0,
    y: 0,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    anchor: { x: 0, y: 0 },
    opacity: 1,
    fills: [],
    strokes: [],
    strokeWidth: 0,
    // The clip itself, and nothing else: one mask, on one object, for the whole subtree.
    masks: [clipMask(node, geometry)],
    children,
    clipsContent: false,
    isMask: false,
    assetId: undefined,
    text: undefined,
    path: undefined,
    compoundPaths: undefined,
    sourceData: {
      ...node.sourceData,
      role: "clip-contents",
      clipsContentSource: node.sourceId ?? node.id
    }
  };

  return {
    ...node,
    // The composition draws nothing itself: the clip shape carries the paint, and drawing it twice
    // would double a semi-transparent frame background.
    type: "group",
    fills: [],
    strokes: [],
    strokeWidth: 0,
    text: undefined,
    assetId: undefined,
    path: undefined,
    compoundPaths: undefined,
    // A mask layer in the container's own sibling run still applies to the whole composition.
    masks: [...siblingMasks, ...node.masks],
    children: [clipShape, contents],
    sourceData: { ...node.sourceData, role: "clip-composition" }
  };
}

/**
 * The container's exact clip outline, in its own coordinate space.
 *
 * A vector outline wins when the source gave one: a clipping frame is usually a rectangle, but a
 * clipping component can be any shape, and its bounding box is not the same thing. Otherwise the
 * rectangle of its size, with its corner radii.
 */
function clipGeometry(node: NormalizedDesignNode): BezierPath {
  if (node.path) return node.path;

  const radii = node.clipCornerRadii
    ?? node.independentCorners
    ?? (node.cornerRadius
      ? ([node.cornerRadius, node.cornerRadius, node.cornerRadius, node.cornerRadius] as [number, number, number, number])
      : undefined);

  return radii
    ? roundedRectanglePath(node.width, node.height, radii)
    : rectanglePath(node.width, node.height);
}

function clipMask(node: NormalizedDesignNode, geometry: BezierPath): NormalizedDesignMask {
  return {
    id: createSceneId("import-clip"),
    name: `${node.name} clip`,
    path: geometry,
    mode: "add",
    inverted: false,
    opacity: 1,
    feather: { x: 0, y: 0 },
    expansion: 0
  };
}

/**
 * A mask layer's geometry.
 *
 * A shape mask has its own path. A **mask group** has none of its own — its outline is the union of
 * what it contains, which is why the mask node keeps its children until this point. Falling back to
 * the group's bounding rectangle (which is what happened before) turns a masked logo into a masked
 * rectangle: the artwork stops being clipped to the shape the designer drew.
 */
function maskFromNode(node: NormalizedDesignNode, report: DesignImportReport): NormalizedDesignMask {
  const paths = collectPaths(node, 0, 0);
  const radii = node.independentCorners
    ?? (node.cornerRadius
      ? ([node.cornerRadius, node.cornerRadius, node.cornerRadius, node.cornerRadius] as [number, number, number, number])
      : undefined);

  let path: BezierPath;
  if (paths.length > 0) {
    path = paths[0];
    if (paths.length > 1) {
      addDesignImportIssue(report, {
        kind: "converted",
        severity: "warning",
        message: `${node.name} masks with ${paths.length} separate outlines; GrapiX masks take one path each, so the first was used and the rest are listed in the layer's source metadata.`,
        sourceNodeId: node.sourceId ?? node.id,
        sourceNodeName: node.name,
        fallback: "First outline of the mask"
      });
    }
  } else if (node.type === "ellipse") {
    // An ellipse mask with no explicit geometry: a rounded rectangle whose radii are half its
    // extent is the ellipse, exactly.
    path = roundedRectanglePath(node.width, node.height, [
      node.width / 2,
      node.width / 2,
      node.width / 2,
      node.width / 2
    ]);
  } else {
    path = radii ? roundedRectanglePath(node.width, node.height, radii) : rectanglePath(node.width, node.height);
  }

  return {
    id: createSceneId("import-mask"),
    name: node.name,
    path,
    mode: "add",
    inverted: false,
    opacity: node.opacity,
    feather: { x: 0, y: 0 },
    expansion: 0,
    /*
     * An alpha or luminance mask is its pixels, not its outline. When the importer managed to have
     * the source tool render it, the mask carries that image: the outline above keeps it usable in
     * the editor today, and the alpha is there for the renderer that samples it. A vector mask
     * needs none of this — its outline *is* the mask.
     */
    ...(node.maskType && node.maskType !== "vector" && node.renderedAssetId
      ? { alphaAssetId: node.renderedAssetId }
      : {})
  };
}

/**
 * Every path in a subtree, translated into the subtree root's coordinate space.
 *
 * Depth-first in document order, so "the first outline" is the first one a designer sees.
 */
function collectPaths(node: NormalizedDesignNode, offsetX: number, offsetY: number): BezierPath[] {
  const paths: BezierPath[] = [];
  if (node.path) paths.push(translatePath(node.path, offsetX, offsetY));
  for (const extra of node.compoundPaths ?? []) paths.push(translatePath(extra, offsetX, offsetY));
  for (const child of node.children) {
    paths.push(...collectPaths(child, offsetX + child.x, offsetY + child.y));
  }
  return paths;
}

function translatePath(path: BezierPath, x: number, y: number): BezierPath {
  if (x === 0 && y === 0) return path;
  return {
    ...path,
    vertices: path.vertices.map((vertex) => ({ x: vertex.x + x, y: vertex.y + y }))
  };
}

/**
 * Move a mask by an offset. Tangents are relative to their vertex, so only vertices shift.
 *
 * A fresh id per masked layer: two objects must not share a mask id, or editing one in the
 * Inspector would appear to edit the other.
 */
function shiftMask(mask: NormalizedDesignMask, x: number, y: number): NormalizedDesignMask {
  return { ...mask, id: createSceneId("import-mask"), path: translatePath(mask.path, x, y) };
}
