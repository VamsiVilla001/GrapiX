/**
 * Design ingest. Every importer is a pure function from a source file (or a Figma payload)
 * to a DesignIR, runnable headlessly and testable against the committed fixtures in
 * `test-fixtures/`. Importers never touch rig state.
 *
 * See docs/middle-layer-arch.md section 5.2.
 */

export {
  parseFigmaUrl,
  type FigmaImagePayload,
  type FigmaImportPayload,
  type FigmaNodePayload,
  type FigmaPaint,
  type FigmaPayloadOrigin,
  type FigmaTextSegment,
  type FigmaTypeStyle,
  type FigmaVectorPath,
  type ParsedFigmaUrl
} from "./figma-payload.js";

export { FIGMA_IMPORTER_VERSION, mapFigmaPayloadToDesignIR } from "./figma-mapper.js";
export { fetchFigmaPayload, FigmaRestError, type FigmaRestOptions } from "./figma-rest.js";
export { importPsd, PSD_IMPORTER_VERSION, type PsdImportOptions } from "./psd-importer.js";
export {
  importIllustrator,
  ILLUSTRATOR_IMPORTER_VERSION,
  type IllustratorImportOptions
} from "./illustrator-importer.js";

import type { DesignIR, DesignSource } from "@grapix/design-ir";
import { importIllustrator } from "./illustrator-importer.js";
import { importPsd } from "./psd-importer.js";

export interface FileImportRequest {
  fileName: string;
  data: Uint8Array;
}

/** File extensions each file-based importer claims. Figma is URL/plugin based. */
export const FILE_IMPORT_EXTENSIONS: Record<"psd" | "ai", string[]> = {
  psd: [".psd", ".psb"],
  ai: [".ai", ".pdf"]
};

export function detectFileSource(fileName: string): Extract<DesignSource, "psd" | "ai"> | null {
  const lower = fileName.toLowerCase();

  if (FILE_IMPORT_EXTENSIONS.psd.some((extension) => lower.endsWith(extension))) {
    return "psd";
  }

  if (FILE_IMPORT_EXTENSIONS.ai.some((extension) => lower.endsWith(extension))) {
    return "ai";
  }

  return null;
}

/** Routes an uploaded file to its importer. Throws on an unsupported extension. */
export async function importDesignFile(request: FileImportRequest): Promise<DesignIR> {
  const source = detectFileSource(request.fileName);

  if (source === "psd") {
    return importPsd(request);
  }

  if (source === "ai") {
    return importIllustrator(request);
  }

  throw new Error(
    `Unsupported design file: ${request.fileName}. Expected one of ${[
      ...FILE_IMPORT_EXTENSIONS.psd,
      ...FILE_IMPORT_EXTENSIONS.ai
    ].join(", ")}.`
  );
}
