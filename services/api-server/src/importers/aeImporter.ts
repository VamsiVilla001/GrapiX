export interface AeImportReport {
  sourceType: "aep" | "lottie" | "alpha-video" | "image-sequence";
  accepted: boolean;
  importedItems: string[];
  convertedItems: string[];
  bakedItems: string[];
  unsupportedItems: string[];
  missingFonts: string[];
  missingFootage: string[];
  colorWarnings: string[];
  estimatedRuntimeCost: {
    layers: number;
    vectorPaths: number;
    mediaStreams: number;
    score: "low" | "medium" | "high";
  };
}

export function inspectAeImport(fileName: string, document?: unknown): AeImportReport {
  const extension = fileName.toLowerCase().split(".").pop() ?? "";
  if (extension === "aep") {
    return report("aep", false, {
      unsupportedItems: [
        "Direct .aep runtime execution is forbidden; export Lottie, alpha video, an image sequence, or a structured GrapiX conversion."
      ]
    });
  }
  if (extension === "json") return inspectLottie(document);
  if (["mov", "webm", "mp4"].includes(extension)) {
    return report("alpha-video", true, {
      importedItems: [fileName],
      colorWarnings: ["Alpha mode and colour space must be confirmed by the media probe before Take."],
      mediaStreams: 1
    });
  }
  return report("image-sequence", false, {
    unsupportedItems: ["Image sequences require an explicit ordered manifest; loose files are not accepted."]
  });
}

function inspectLottie(document: unknown): AeImportReport {
  if (!isRecord(document) || typeof document.v !== "string" || !Array.isArray(document.layers)) {
    return report("lottie", false, { unsupportedItems: ["JSON is not a valid Lottie document."] });
  }
  const importedItems: string[] = [];
  const convertedItems: string[] = [];
  const bakedItems: string[] = [];
  const unsupportedItems: string[] = [];
  const missingFonts: string[] = [];
  const missingFootage: string[] = [];
  let vectorPaths = 0;
  let mediaStreams = 0;

  for (const [index, rawLayer] of document.layers.entries()) {
    if (!isRecord(rawLayer)) continue;
    const name = typeof rawLayer.nm === "string" ? rawLayer.nm : `layer ${index + 1}`;
    importedItems.push(name);
    if (rawLayer.ddd === 1) {
      bakedItems.push(`${name}: 3D layer must be pre-rendered`);
      continue;
    }
    if (typeof rawLayer.x === "string" && rawLayer.x.trim()) {
      unsupportedItems.push(`${name}: expressions are not executable`);
    }
    switch (rawLayer.ty) {
      case 4:
        convertedItems.push(`${name}: shape layer`);
        vectorPaths += countShapePaths(rawLayer.shapes);
        break;
      case 5:
        convertedItems.push(`${name}: text layer`);
        break;
      case 2:
        convertedItems.push(`${name}: image layer`);
        mediaStreams += 1;
        if (!rawLayer.refId) missingFootage.push(name);
        break;
      case 0:
        convertedItems.push(`${name}: precomposition`);
        break;
      default:
        bakedItems.push(`${name}: unsupported Lottie layer type ${String(rawLayer.ty)}`);
    }
    if (Array.isArray(rawLayer.ef) && rawLayer.ef.length) {
      bakedItems.push(`${name}: effects must be baked`);
    }
  }
  const fonts = isRecord(document.fonts) && Array.isArray(document.fonts.list)
    ? document.fonts.list
    : [];
  for (const font of fonts) {
    if (isRecord(font) && typeof font.fName === "string") missingFonts.push(font.fName);
  }
  const layers = document.layers.length;
  return {
    sourceType: "lottie",
    accepted: unsupportedItems.length === 0,
    importedItems,
    convertedItems,
    bakedItems,
    unsupportedItems,
    missingFonts,
    missingFootage,
    colorWarnings: ["Lottie colours are interpreted as sRGB; verify project output transform."],
    estimatedRuntimeCost: {
      layers,
      vectorPaths,
      mediaStreams,
      score: layers + vectorPaths + mediaStreams * 10 > 100 ? "high" : layers > 20 ? "medium" : "low"
    }
  };
}

function report(
  sourceType: AeImportReport["sourceType"],
  accepted: boolean,
  partial: {
    importedItems?: string[];
    convertedItems?: string[];
    bakedItems?: string[];
    unsupportedItems?: string[];
    colorWarnings?: string[];
    mediaStreams?: number;
  }
): AeImportReport {
  return {
    sourceType,
    accepted,
    importedItems: partial.importedItems ?? [],
    convertedItems: partial.convertedItems ?? [],
    bakedItems: partial.bakedItems ?? [],
    unsupportedItems: partial.unsupportedItems ?? [],
    missingFonts: [],
    missingFootage: [],
    colorWarnings: partial.colorWarnings ?? [],
    estimatedRuntimeCost: {
      layers: partial.importedItems?.length ?? 0,
      vectorPaths: 0,
      mediaStreams: partial.mediaStreams ?? 0,
      score: "low"
    }
  };
}

function countShapePaths(shapes: unknown): number {
  if (!Array.isArray(shapes)) return 0;
  return shapes.reduce((count, shape) => {
    if (!isRecord(shape)) return count;
    return count + (shape.ty === "sh" ? 1 : 0) + countShapePaths(shape.it);
  }, 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
