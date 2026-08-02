import {
  createSceneId,
  normalizeColorValue,
  type AssetKind,
  type AssetLibraryItem,
  type DesignImportOptions,
  type DesignImportReport,
  type FontDefinition,
  type GroupSceneObject,
  type Material,
  type NormalizedDesignDocument,
  type NormalizedDesignNode,
  type NormalizedDesignPage,
  type SceneDocument,
  type SceneObject
} from "@grapix/shared-types";
import { addDesignImportIssue } from "./importReport.js";

export function convertDesignDocumentToScenes(
  document: NormalizedDesignDocument,
  options: DesignImportOptions,
  report: DesignImportReport
): SceneDocument[] {
  return document.pages.map((page) => convertPage(page, document, options, report));
}

function convertPage(
  page: NormalizedDesignPage,
  document: NormalizedDesignDocument,
  options: DesignImportOptions,
  report: DesignImportReport
): SceneDocument {
  const timestamp = new Date().toISOString();
  const assets = convertAssets(document, report);
  const materials: Material[] = [];
  const objects: SceneObject[] = [];
  let stack = 0;

  /*
   * Nesting is expressed by `childIds` alone - `resolveSceneObjectHierarchy` reads
   * nothing else. `layerId` is a compositing layer (Background, Lower Third, ...)
   * and it is the FIRST key both renderers sort on, so writing a parent id into it
   * pushed every group's children into their own pseudo-layer, ordered
   * alphabetically against "main": a PSD's opaque bottom layer then painted over
   * every nested object in Preview and in Program. Imported objects stay on one
   * layer, and `zIndex` (document walk order) decides what is on top.
   */
  const convertNodes = (nodes: NormalizedDesignNode[]): string[] => {
    const ids: string[] = [];
    nodes.forEach((node) => {
      const object = convertNode(node, document, options, report, assets, materials, stack++);
      objects.push(object);
      ids.push(object.id);
      if (isContainer(object)) {
        object.childIds = convertNodes(node.children);
      } else if (node.children.length) {
        const wrapper = convertNode({
          ...node,
          id: `${node.id}-children`,
          name: `${node.name} contents`,
          type: "group",
          x: 0,
          y: 0,
          fills: [],
          strokes: [],
          masks: [],
          effects: [],
          children: node.children
        }, document, options, report, assets, materials, stack++) as GroupSceneObject;
        wrapper.childIds = convertNodes(node.children);
        objects.push(wrapper);
      }
    });
    return ids;
  };
  convertNodes(page.nodes);

  const background = normalizeColorValue(page.background, "#ffffff");
  return {
    id: createSceneId("imported-scene"),
    name: page.name || document.sourceName.replace(/\.[^.]+$/, ""),
    version: 1,
    canvas: {
      width: Math.max(1, Math.round(page.width)),
      height: Math.max(1, Math.round(page.height)),
      background: background.type === "solid" ? background.color : "#00000000",
      backgroundStyle: background,
      editorViewport: {
        showRulers: true,
        margins: { top: page.height * 0.05, right: page.width * 0.05, bottom: page.height * 0.05, left: page.width * 0.05 },
        guides: (page.guides ?? []).map((guide) => ({
          guideId: createSceneId("import-guide"),
          orientation: guide.orientation,
          position: guide.position
        }))
      }
    },
    dataContext: {
      __designImport: {
        sourceFormat: document.sourceFormat,
        sourceName: document.sourceName,
        sourceId: document.sourceId,
        importedAt: timestamp,
        pageId: page.id,
        // Provenance by reference. The source document stays in the project store but
        // out of the scene library: Playout ships every scene asset to the render
        // engine, and a 93 MB PSD is neither renderable nor wanted on air.
        sourceAssetIds: document.assets.filter((asset) => asset.kind === "source").map((asset) => asset.id),
        components: document.components,
        variables: document.variables,
        sourceMetadata: document.sourceMetadata
      }
    },
    assets,
    materials,
    materialInstances: [],
    shaders: [],
    materialFolders: [],
    gradientPresets: [],
    objects,
    timeline: { fps: 50, durationFrames: 300, keyframes: [] },
    fonts: convertFonts(document, options, report),
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function convertNode(
  node: NormalizedDesignNode,
  document: NormalizedDesignDocument,
  options: DesignImportOptions,
  report: DesignImportReport,
  assets: AssetLibraryItem[],
  materials: Material[],
  zIndex: number
): SceneObject {
  const firstFill = normalizeColorValue(node.fills[0], "#ffffff");
  const firstStroke = normalizeColorValue(node.strokes[0], "transparent");
  const fill = firstFill.type === "solid" ? firstFill.color : firstFill.type === "none" ? "transparent" : firstFill.stops[0]?.color ?? "#ffffff";
  const stroke = firstStroke.type === "solid" ? firstStroke.color : firstStroke.type === "none" ? "transparent" : firstStroke.stops[0]?.color ?? "transparent";
  const base = {
    id: `import-${safeId(node.id)}`,
    name: node.name,
    x: node.x,
    y: node.y,
    zDepth: 0,
    zIndex,
    layerId: "main",
    width: Math.max(0.01, node.width),
    height: Math.max(0.01, node.height),
    rotation: node.rotation,
    scaleX: node.scaleX,
    scaleY: node.scaleY,
    scaleZ: 1,
    anchor: node.anchor,
    opacity: node.opacity,
    visible: node.visible,
    locked: node.locked,
    fill,
    stroke,
    fillStyle: firstFill,
    strokeStyle: firstStroke,
    strokeWidth: node.strokeWidth,
    bindings: {},
    materialSlots: {},
    masks: node.masks.map((mask) => ({
      id: mask.id,
      name: mask.name,
      // "paint" means brush strokes. A bitmap mask has neither strokes nor a real
      // path, so it stays a bezier record carrying its alpha asset until the
      // renderers can sample one.
      type: "bezier" as const,
      path: mask.path,
      mode: mask.mode,
      inverted: mask.inverted,
      opacity: mask.opacity,
      feather: mask.feather,
      expansion: mask.expansion,
      alphaAssetId: mask.alphaAssetId,
      visible: true,
      locked: false,
      editorColor: "#f5b942"
    })),
    importedDesign: {
      sourceFormat: document.sourceFormat,
      sourceName: document.sourceName,
      sourceNodeId: node.sourceId ?? node.id,
      sourceNodeType: node.type,
      fillOpacity: node.fillOpacity,
      clipping: Boolean(node.sourceData?.clipping),
      componentId: node.componentId,
      componentProperties: node.componentProperties,
      responsiveLayout: node.layout as unknown as Record<string, unknown>,
      effects: node.effects as unknown as Array<Record<string, unknown>>,
      additionalFills: node.fills.slice(1),
      additionalStrokes: node.strokes.slice(1),
      raw: node.sourceData
    }
  };

  if (node.blendMode !== "normal") {
    const materialId = createSceneId("import-material");
    materials.push({
      materialId,
      name: `${node.name} appearance`,
      type: "pbr",
      color: fill,
      dynamic: false,
      opacity: node.opacity,
      readiness: "READY",
      blendMode: node.blendMode,
      enabled: true,
      supportedPrimitives: [sceneType(node)]
    });
    base.materialSlots = { main: materialId };
  }

  if (isContainerType(node.type) || node.type === "adjustment" || node.type === "unsupported") {
    return {
      ...base,
      type: "group",
      childIds: []
    };
  }
  const asset = assets.find((item) => item.assetId === node.assetId);
  if (node.type === "text" && node.text && options.keepTextEditable) {
    const family = options.missingFontPolicy === "replace" ? options.replacementFontFamily : node.text.fontFamily;
    return {
      ...base,
      type: "text",
      text: node.text.characters,
      textLayout: node.text.textLayout,
      writingMode: node.text.writingMode ?? "horizontal-tb",
      verticalAlign: node.text.verticalAlign ?? "top",
      direction: node.text.direction ?? "ltr",
      fontSize: node.text.fontSize,
      fontFamily: family,
      fontWeight: node.text.fontWeight,
      fontStyle: node.text.fontStyle ?? "normal",
      textDecoration: {},
      lineHeight: node.text.lineHeight,
      letterSpacing: node.text.letterSpacing,
      wordSpacing: 0,
      paragraphSpacing: node.text.paragraphSpacing,
      textIndent: 0,
      overflow: "visible",
      align: node.text.align
    };
  }
  if (node.type === "text" && !options.keepTextEditable && asset) {
    addDesignImportIssue(report, {
      kind: "rasterized",
      severity: "warning",
      message: `${node.name} was rasterised because editable text import was disabled.`,
      sourceNodeId: node.sourceId,
      sourceNodeName: node.name,
      fallback: "Source layer pixels"
    });
    return { ...base, type: "image", src: asset.source, objectFit: "stretch" };
  }
  if (node.type === "rectangle") {
    return { ...base, type: "rect", radius: node.cornerRadius ?? node.independentCorners?.[0] ?? 0 };
  }
  if (node.type === "ellipse") return { ...base, type: "ellipse" };
  if (node.type === "line") {
    return { ...base, type: "line", points: node.path?.vertices ?? [{ x: 0, y: 0 }, { x: node.width, y: node.height }] };
  }
  if (node.type === "path" && node.path) {
    return {
      ...base,
      type: "shape",
      path: node.path,
      compoundPaths: node.compoundPaths,
      fillEnabled: firstFill.type !== "none",
      strokeEnabled: firstStroke.type !== "none" && node.strokeWidth > 0,
      fillRule: String(node.sourceData?.fillRule ?? "").includes("even") ? "evenodd" : "nonzero"
    };
  }
  if ((node.type === "image" || node.type === "video" || node.type === "smart-object") && asset) {
    return {
      ...base,
      type: "image",
      src: asset.source,
      objectFit: "stretch"
    };
  }
  addDesignImportIssue(report, {
    kind: "converted",
    severity: "warning",
    message: `${node.name} (${node.type}) was converted to a transparent editable rectangle.`,
    sourceNodeId: node.sourceId,
    sourceNodeName: node.name,
    fallback: "Editable rectangle with retained source metadata"
  });
  return { ...base, type: "rect", radius: node.cornerRadius ?? 0 };
}

/**
 * Scene asset library from the normalized document.
 *
 * `checksum` is load-bearing, not decoration: the render engine registers assets by
 * SHA-256 and refuses a scene containing one without it ("asset … has no checksum and
 * cannot be sent to the render engine"). Only an asset that reached the project store
 * has one, so an asset that is still a bare external link is `MISSING` here rather
 * than a `READY` entry that fails at Take time.
 */
function convertAssets(
  document: NormalizedDesignDocument,
  report: DesignImportReport
): AssetLibraryItem[] {
  const timestamp = new Date().toISOString();
  // The authoring source (the PSD/AI/JSON the scene came from) is provenance, not scene
  // content: it is referenced by id from `dataContext.__designImport.sourceAssetIds`.
  return document.assets.filter((asset) => asset.kind !== "source").map((asset) => {
    const stored = Boolean(asset.checksum);
    const inline = Boolean(asset.dataBase64);
    if (!stored && !inline && asset.sourceUrl) {
      addDesignImportIssue(report, {
        kind: "missing-asset",
        severity: "warning",
        message: `${asset.name} is only an external reference, so it has no checksum and the render engine cannot register it.`,
        sourceNodeName: asset.name,
        fallback: "Editor preview only; not available to Program"
      });
    }
    return {
      assetId: asset.id,
      name: asset.name,
      kind: mapAssetKind(asset.kind),
      source: asset.sourceUrl ?? (inline ? `data:${asset.mimeType};base64,${asset.dataBase64}` : ""),
      mimeType: asset.mimeType,
      importedAt: timestamp,
      sourcePath: asset.sourceUrl,
      width: asset.width,
      height: asset.height,
      checksum: asset.checksum,
      sizeBytes: asset.sizeBytes,
      status: stored || inline ? "READY" as const : "MISSING" as const,
      colorSpace: "srgb" as const,
      alphaMode: "premultiplied" as const,
      tags: ["design-import", document.sourceFormat]
    };
  });
}

function convertFonts(
  document: NormalizedDesignDocument,
  options: DesignImportOptions,
  report: DesignImportReport
): FontDefinition[] {
  const fonts = new Map<string, FontDefinition>();
  for (const source of document.fonts) {
    const family = options.missingFontPolicy === "replace" ? options.replacementFontFamily : source.family;
    if (options.missingFontPolicy === "preserve-name") {
      addDesignImportIssue(report, {
        kind: "missing-font",
        severity: "warning",
        message: `Font ${source.family} is referenced but was not embedded by the source document.`,
        sourceNodeName: source.family,
        fallback: "Family name preserved for Font Manager resolution"
      });
    }
    if (!fonts.has(family)) {
      fonts.set(family, {
        fontId: `import-font-${safeId(family)}`,
        family,
        displayName: family,
        faces: [],
        fallbackFamilies: ["Arial", "sans-serif"],
        embeddingPolicy: "reference",
        status: options.missingFontPolicy === "replace" ? "UNVERIFIED" : "MISSING"
      });
    }
  }
  return [...fonts.values()];
}

function isContainer(object: SceneObject): object is GroupSceneObject {
  return object.type === "group";
}

function isContainerType(type: NormalizedDesignNode["type"]): boolean {
  return ["group", "artboard", "frame", "component", "component-set", "instance"].includes(type);
}

function sceneType(node: NormalizedDesignNode): SceneObject["type"] {
  if (node.type === "text") return "text";
  if (node.type === "ellipse") return "ellipse";
  if (node.type === "path") return "shape";
  if (node.type === "image" || node.type === "video" || node.type === "smart-object") return "image";
  return "rect";
}

function mapAssetKind(kind: NormalizedDesignDocument["assets"][number]["kind"]): AssetKind {
  return kind === "image" ? "image" : kind === "video" ? "video" : kind === "svg" ? "svg" : "unknown";
}

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-");
}
