import {
  createSceneId,
  validateMaterialAssetImportDescriptor,
  type AssetKind,
  type AssetLibraryItem,
  type ShaderDefinition
} from "@grapix/shared-types";
import { importAssetFileToApi } from "../../../lib/apiClient";
import { validateWgslSource } from "./shaderRegistry";

export interface ImportedAssetResult {
  asset: AssetLibraryItem;
  shader?: ShaderDefinition;
  warning?: string;
}

export function validateAssetDescriptor(name: string, mimeType: string, sizeBytes: number): string[] {
  return validateMaterialAssetImportDescriptor(name, mimeType, sizeBytes);
}

export async function importMaterialAsset(file: File, replaceAssetId?: string): Promise<ImportedAssetResult> {
  const errors = validateAssetDescriptor(file.name, file.type, file.size);
  if (errors.length) throw new Error(errors.join(" "));

  const stored = await importAssetFileToApi(file, replaceAssetId);
  const extension = file.name.toLowerCase().split(".").pop() ?? "";
  const kind: AssetKind = extension === "wgsl" ? "wgsl" : extension === "svg" ? "svg" : "image";
  const metadata = kind === "wgsl" ? {} : await inspectImage(file);
  const asset: AssetLibraryItem = {
    assetId: stored.assetId,
    name: file.name,
    kind,
    source: stored.contentUrl,
    sourcePath: stored.relativePath,
    storageAssetId: stored.assetId,
    mimeType: stored.mimeType,
    sizeBytes: stored.sizeBytes,
    checksum: stored.checksum,
    importedAt: stored.importedAt,
    status: "READY",
    colorSpace: "srgb",
    tags: [],
    ...metadata
  };

  if (kind !== "wgsl") return { asset, warning: stored.duplicate ? "Duplicate content reused." : undefined };

  const source = await file.text();
  const shaderId = createSceneId("shader");
  const definition: ShaderDefinition = {
    shaderId,
    name: file.name.replace(/\.wgsl$/i, ""),
    version: 1,
    sourcePath: stored.relativePath,
    vertexEntry: "vs_main",
    fragmentEntry: "fs_main",
    textureSlots: [],
    parameters: [],
    supportedPrimitives: ["rect", "image"],
    validationStatus: "VALID",
    compilationErrors: [],
    builtIn: false,
    updatedAt: new Date().toISOString()
  };
  const shaderErrors = validateWgslSource(source, definition);

  return {
    asset,
    shader: {
      ...definition,
      validationStatus: shaderErrors.length ? "INVALID" : "VALID",
      compilationErrors: shaderErrors
    },
    warning: shaderErrors.length ? "Shader stored but not activated because validation failed." : undefined
  };
}

async function inspectImage(file: File): Promise<Partial<AssetLibraryItem>> {
  try {
    const bitmap = await createImageBitmap(file);
    const width = bitmap.width;
    const height = bitmap.height;
    const sampleWidth = Math.min(bitmap.width, 64);
    const sampleHeight = Math.min(bitmap.height, 64);
    if (typeof OffscreenCanvas === "undefined") {
      bitmap.close();
      return { width, height, hasAlpha: "unknown", alphaMode: "unknown" };
    }
    const canvas = new OffscreenCanvas(sampleWidth, sampleHeight);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    let hasAlpha: boolean | "unknown" = "unknown";

    if (context) {
      context.drawImage(bitmap, 0, 0, sampleWidth, sampleHeight);
      const pixels = context.getImageData(0, 0, sampleWidth, sampleHeight).data;
      hasAlpha = false;
      for (let index = 3; index < pixels.length; index += 4) {
        if (pixels[index] < 255) {
          hasAlpha = true;
          break;
        }
      }
    }
    bitmap.close();
    return {
      width,
      height,
      hasAlpha,
      alphaMode: hasAlpha === true ? "straight" : hasAlpha === false ? "opaque" : "unknown"
    };
  } catch {
    return {
      hasAlpha: "unknown",
      alphaMode: "unknown",
      status: file.name.toLowerCase().endsWith(".tif") || file.name.toLowerCase().endsWith(".tiff")
        ? "UNSUPPORTED"
        : "ERROR",
      error: "This browser could not decode the image; the source remains available for relinking or a future decoder."
    };
  }
}
