import {
  createSceneId,
  normalizeColorValue,
  type DesignImportOptions,
  type DesignImportReport,
  type NormalizedDesignDocument,
  type NormalizedDesignNode
} from "@grapix/shared-types";
import { addDesignImportIssue } from "./importReport.js";
import { resolveClipsAndMasks } from "./clipResolution.js";


export function normalizeDesignDocument(
  document: NormalizedDesignDocument,
  options: DesignImportOptions,
  report: DesignImportReport
): NormalizedDesignDocument {
  /** Mask layers that became masks. They are no longer nodes, but they were imported. */
  const consumedMaskIds: string[] = [];
  const selectedPages = new Set(options.selectedPageIds ?? []);
  const selectedNodes = new Set(options.selectedNodeIds ?? []);
  const scale = Number.isFinite(options.scale) && options.scale > 0 ? options.scale : 1;
  const pages = document.pages
    .filter((page) => selectedPages.size === 0 || selectedPages.has(page.id))
    .map((page) => {
      const targetScaleX = options.targetWidth ? options.targetWidth / Math.max(1, page.width) : scale;
      const targetScaleY = options.targetHeight ? options.targetHeight / Math.max(1, page.height) : scale;
      const scaleX = options.targetWidth && options.targetHeight ? targetScaleX : scale;
      const scaleY = options.targetWidth && options.targetHeight ? targetScaleY : scale;
      const normalizedNodes = page.nodes
        .filter((node) => selectedNodes.size === 0 || selectedNodes.has(node.id) || containsSelectedNode(node, selectedNodes))
        .map((node) => normalizeNode(node, options, report, scaleX, scaleY, selectedNodes, selectedNodes.size === 0))
        .filter((node): node is NormalizedDesignNode => Boolean(node));

      /*
       * Clipping becomes masks here, after scaling and before any flattening.
       *
       * After scaling, because a clip rectangle is geometry and must be in the same space as the
       * layers it cuts. Before flattening, because `flattenNodes` drops containers and keeps
       * leaves: a clip that lived only as a container property would vanish with the container,
       * which is how clipped artwork ends up painted across a whole canvas.
       */
      const clipped = resolveClipsAndMasks(normalizedNodes, report);
      report.counts.clippedContainers += clipped.clippedContainers;
  report.counts.syntheticLayers += clipped.syntheticLayers;
      report.counts.masks += clipped.resolvedMasks;
      consumedMaskIds.push(...clipped.consumedMaskIds);

      return {
        ...page,
        id: page.id || createSceneId("design-page"),
        width: Math.max(1, Math.round(page.width * scaleX)),
        height: Math.max(1, Math.round(page.height * scaleY)),
        background: normalizeColorValue(page.background, "#ffffff"),
        nodes: options.preserveHierarchy ? clipped.nodes : flattenNodes(clipped.nodes),
        guides: page.guides?.map((guide) => ({
          ...guide,
          position: guide.position * (guide.orientation === "horizontal" ? scaleY : scaleX)
        }))
      };
    });

  const families = referencedFamilies(pages);
  return {
    ...document,
    width: pages[0]?.width ?? Math.max(1, Math.round(document.width * scale)),
    height: pages[0]?.height ?? Math.max(1, Math.round(document.height * scale)),
    // Adapters collect fonts from the whole source document. A family used only by
    // layers that selection or the hidden-layer filter removed is not missing from
    // the scene, and reporting it sends an author looking for a font nothing needs.
    fonts: document.fonts.filter((font) => families.has(font.family)),
    pages,
    sourceMetadata: {
      ...document.sourceMetadata,
      // Read by the report's pruning pass: these layers are accounted for as masks, so the lines
      // explaining what happened to them must not be deleted as belonging to a discarded layer.
      ...(consumedMaskIds.length ? { consumedMaskNodeIds: consumedMaskIds } : {})
    }
  };
}

function referencedFamilies(pages: NormalizedDesignDocument["pages"]): Set<string> {
  const families = new Set<string>();
  const walk = (nodes: NormalizedDesignNode[]): void => {
    for (const node of nodes) {
      if (node.text?.fontFamily) families.add(node.text.fontFamily);
      walk(node.children);
    }
  };
  pages.forEach((page) => walk(page.nodes));
  return families;
}

function normalizeNode(
  node: NormalizedDesignNode,
  options: DesignImportOptions,
  report: DesignImportReport,
  scaleX: number,
  scaleY: number,
  selectedNodes: Set<string>,
  includeSubtree: boolean
): NormalizedDesignNode | null {
  if (!options.importHiddenLayers && !node.visible) return null;
  const selectedHere = includeSubtree || selectedNodes.has(node.id);
  if (!selectedHere && !containsSelectedNode(node, selectedNodes)) return null;
  const children = node.children
    .map((child) => normalizeNode(child, options, report, scaleX, scaleY, selectedNodes, selectedHere))
    .filter((child): child is NormalizedDesignNode => Boolean(child));
  const normalized: NormalizedDesignNode = {
    ...node,
    type: !options.convertComponents && ["component", "component-set", "instance"].includes(node.type)
      ? "group"
      : node.type,
    componentId: options.convertComponents ? node.componentId : undefined,
    componentProperties: options.convertComponents ? node.componentProperties : undefined,
    id: node.id || createSceneId("design-node"),
    x: finite(node.x) * scaleX,
    y: finite(node.y) * scaleY,
    width: Math.max(0.01, finite(node.width, 1) * scaleX),
    height: Math.max(0.01, finite(node.height, 1) * scaleY),
    scaleX: finite(node.scaleX, 1),
    scaleY: finite(node.scaleY, 1),
    rotation: finite(node.rotation),
    opacity: clamp01(node.opacity),
    fillOpacity: clamp01(node.fillOpacity ?? 1),
    fills: node.fills.map((paint) => normalizeColorValue(paint, "transparent")),
    strokes: node.strokes.map((paint) => normalizeColorValue(paint, "transparent")),
    strokeWidth: Math.max(0, finite(node.strokeWidth) * Math.max(scaleX, scaleY)),
    masks: node.masks.map((mask) => ({
      ...mask,
      opacity: clamp01(mask.opacity),
      feather: { x: mask.feather.x * scaleX, y: mask.feather.y * scaleY },
      expansion: mask.expansion * Math.max(scaleX, scaleY),
      path: scalePath(mask.path, scaleX, scaleY)
    })),
    path: node.path ? scalePath(node.path, scaleX, scaleY) : undefined,
    compoundPaths: node.compoundPaths?.map((path) => scalePath(path, scaleX, scaleY)),
    children
  };
  return applyUnsupportedFeaturePolicy(normalized, options, report);
}

function applyUnsupportedFeaturePolicy(
  node: NormalizedDesignNode,
  options: DesignImportOptions,
  report: DesignImportReport
): NormalizedDesignNode {
  if (!hasUnsupportedFeature(node) || options.unsupportedFeaturePolicy === "closest-editable") return node;

  if (options.unsupportedFeaturePolicy === "rasterize-layer") {
    return {
      ...node,
      sourceData: { ...node.sourceData, __unsupportedFeaturePolicy: "rasterize-layer" }
    };
  }

  if (node.children.length === 0) {
    addDesignImportIssue(report, {
      kind: "converted",
      severity: "warning",
      message: `${node.name} requested nested-composition for unsupported features, but it has no child subtree to preserve.`,
      sourceNodeId: node.sourceId,
      sourceNodeName: node.name,
      fallback: "Closest editable representation with retained source metadata"
    });
    return node;
  }

  addDesignImportIssue(report, {
    kind: "converted",
    severity: "warning",
    message: `${node.name} requested nested-composition for unsupported features; its subtree remains an editable group.`,
    sourceNodeId: node.sourceId,
    sourceNodeName: node.name,
    fallback: "Nested group with retained source metadata"
  });
  return {
    ...node,
    type: "group",
    genericContainer: true,
    sourceData: { ...node.sourceData, __unsupportedNestedComposition: true }
  };
}

function hasUnsupportedFeature(node: NormalizedDesignNode): boolean {
  return node.genericContainer === true || node.effects.some(
    (effect) => effect.enabled && (effect.type === "layer-blur" || effect.type === "background-blur" || effect.type === "unknown")
  );
}

interface AffineTransform {
  a: number;
  b: number;
  c: number;
  d: number;
  tx: number;
  ty: number;
}

const IDENTITY_TRANSFORM: AffineTransform = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };

function flattenNodes(nodes: NormalizedDesignNode[], parent: AffineTransform = IDENTITY_TRANSFORM): NormalizedDesignNode[] {
  return nodes.flatMap((node) => {
    const world = composeTransform(parent, nodeTransform(node));
    if (isNestedComposition(node)) return [{ ...withWorldTransform(node, world), children: node.children }];
    const children = flattenNodes(node.children, world);
    if (["group", "artboard", "frame", "component", "component-set", "instance"].includes(node.type)) return children;
    return [{ ...withWorldTransform(node, world), children: [] }, ...children];
  });
}

function nodeTransform(node: NormalizedDesignNode): AffineTransform {
  const angle = node.rotation * (Math.PI / 180);
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const a = cosine * node.scaleX;
  const b = sine * node.scaleX;
  const c = -sine * node.scaleY;
  const d = cosine * node.scaleY;
  return {
    a, b, c, d,
    tx: node.x + node.anchor.x - a * node.anchor.x - c * node.anchor.y,
    ty: node.y + node.anchor.y - b * node.anchor.x - d * node.anchor.y
  };
}

function composeTransform(parent: AffineTransform, child: AffineTransform): AffineTransform {
  return {
    a: parent.a * child.a + parent.c * child.b,
    b: parent.b * child.a + parent.d * child.b,
    c: parent.a * child.c + parent.c * child.d,
    d: parent.b * child.c + parent.d * child.d,
    tx: parent.a * child.tx + parent.c * child.ty + parent.tx,
    ty: parent.b * child.tx + parent.d * child.ty + parent.ty
  };
}

function withWorldTransform(node: NormalizedDesignNode, world: AffineTransform): NormalizedDesignNode {
  const scaleX = Math.hypot(world.a, world.b);
  const determinant = world.a * world.d - world.b * world.c;
  const scaleY = scaleX > Number.EPSILON ? determinant / scaleX : Math.hypot(world.c, world.d);
  const rotation = Math.atan2(world.b, world.a) * (180 / Math.PI);
  return {
    ...node,
    x: world.tx - node.anchor.x + world.a * node.anchor.x + world.c * node.anchor.y,
    y: world.ty - node.anchor.y + world.b * node.anchor.x + world.d * node.anchor.y,
    scaleX, scaleY, rotation
  };
}

function isNestedComposition(node: NormalizedDesignNode): boolean {
  return node.sourceData?.__unsupportedNestedComposition === true;
}



function scalePath<T extends { vertices: Array<{ x: number; y: number }>; inTangents: Array<{ x: number; y: number }>; outTangents: Array<{ x: number; y: number }> }>(
  path: T,
  scaleX: number,
  scaleY: number
): T {
  return {
    ...path,
    vertices: path.vertices.map((point) => ({ x: point.x * scaleX, y: point.y * scaleY })),
    inTangents: path.inTangents.map((point) => ({ x: point.x * scaleX, y: point.y * scaleY })),
    outTangents: path.outTangents.map((point) => ({ x: point.x * scaleX, y: point.y * scaleY }))
  };
}

function containsSelectedNode(node: NormalizedDesignNode, selected: Set<string>): boolean {
  return node.children.some((child) => selected.has(child.id) || containsSelectedNode(child, selected));
}

function finite(value: number | undefined, fallback = 0): number {
  return Number.isFinite(value) ? value! : fallback;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, finite(value, 1)));
}
