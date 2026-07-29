/**
 * Parity capture from the Editor.
 *
 * Saves the live viewport as a lossless PNG so it can be compared against a native engine
 * render. This is the manual half of the pixel-parity harness: the comparison is fully
 * automated, but producing a browser capture needs a browser, and there is no browser
 * automation in this repository.
 *
 * Read back from the scene root rather than the stage, so the SVG interaction overlay,
 * guides and selection handles cannot appear in the image. They live outside the canvas
 * entirely, but extracting the root keeps that true even if that ever changes.
 *
 * See `docs/pixel-parity.md` for where to put the file.
 */

import { captureSceneThumbnail } from "./thumbnailCapture";

export interface ParityCaptureResult {
  fileName: string;
  width: number;
  height: number;
}

/**
 * Capture the viewport and download it.
 *
 * Captured at full canvas resolution rather than scaled: a parity comparison against a
 * downscaled image measures the resampler, not the renderer. Returns null when no viewport
 * is mounted, rather than downloading an empty file.
 */
export async function captureParityFrame(
  maxDimension = 4096
): Promise<ParityCaptureResult | null> {
  const captured = await captureSceneThumbnail(maxDimension);
  if (!captured) return null;

  const fileName = `parity-browser-${captured.width}x${captured.height}.png`;

  // A data URL rather than a blob URL: the file is written once and the tab may be closed
  // immediately afterwards, and a revoked blob URL cancels an in-flight download.
  const anchor = document.createElement("a");
  anchor.href = captured.dataUrl;
  anchor.download = fileName;
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();

  return { fileName, width: captured.width, height: captured.height };
}
