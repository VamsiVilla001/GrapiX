import {
  createSceneId,
  normalizeColorValue,
  type DesignImportOptions,
  type NormalizedDesignDocument,
  type NormalizedDesignNode
} from "@grapix/shared-types";

export function normalizeDesignDocument(
  document: NormalizedDesignDocument,
  options: DesignImportOptions
): NormalizedDesignDocument {
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
        .map((node) => normalizeNode(node, options, scaleX, scaleY, selectedNodes, selectedNodes.size === 0))
        .filter((node): node is NormalizedDesignNode => Boolean(node));
      return {
        ...page,
        id: page.id || createSceneId("design-page"),
        width: Math.max(1, Math.round(page.width * scaleX)),
        height: Math.max(1, Math.round(page.height * scaleY)),
        background: normalizeColorValue(page.background, "#ffffff"),
        nodes: options.preserveHierarchy ? normalizedNodes : flattenNodes(normalizedNodes),
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
    pages
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
  scaleX: number,
  scaleY: number,
  selectedNodes: Set<string>,
  includeSubtree: boolean
): NormalizedDesignNode | null {
  if (!options.importHiddenLayers && !node.visible) return null;
  const selectedHere = includeSubtree || selectedNodes.has(node.id);
  if (!selectedHere && !containsSelectedNode(node, selectedNodes)) return null;
  const children = node.children
    .map((child) => normalizeNode(child, options, scaleX, scaleY, selectedNodes, selectedHere))
    .filter((child): child is NormalizedDesignNode => Boolean(child));
  return {
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
    fills: node.fills.map((paint) => normalizeColorValue(paint, "#ffffff")),
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
}

function flattenNodes(
  nodes: NormalizedDesignNode[],
  parent = { x: 0, y: 0 }
): NormalizedDesignNode[] {
  return nodes.flatMap((node) => {
    const world = { x: parent.x + node.x, y: parent.y + node.y };
    const children = flattenNodes(node.children, world);
    if (["group", "artboard", "frame", "component", "component-set", "instance"].includes(node.type)) {
      return children;
    }
    return [{ ...node, x: world.x, y: world.y, children: [] }, ...children];
  });
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
