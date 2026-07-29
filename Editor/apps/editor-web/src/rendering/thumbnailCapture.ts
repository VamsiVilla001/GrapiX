/**
 * Scene thumbnails, captured from the live editor viewport.
 *
 * A thumbnail is what an operator identifies a template by in the Playout scene
 * manager, so it has to be the real rendered scene rather than a coloured placeholder.
 * The viewport renderer already has the frame on screen; this reads it back and scales
 * it down.
 *
 * Deliberately captured from the *editor* renderer and not from the engine:
 *
 * - it costs nothing extra — the frame is already rendered
 * - it works with no engine running, which is the normal case while designing
 * - the interaction overlay is SVG/DOM and lives outside the canvas, so guides,
 *   handles and selection boxes cannot leak into the image
 *
 * The trade-off is that a thumbnail is a WebGL render, not a wgpu one, so it is
 * indicative rather than a pixel-accurate proof of what will go to air. That is what
 * the browser-versus-native parity harness is for; a library thumbnail is for
 * recognition.
 */

import type { ScenePreviewRenderer } from "./ScenePreviewRenderer";

/** The main viewport renderer, when one is mounted. */
let activeRenderer: ScenePreviewRenderer | null = null;

/**
 * Register the viewport renderer.
 *
 * Only the main scene viewport should call this — material previews mount their own
 * renderers, and a thumbnail of a material sphere is not a thumbnail of the scene.
 */
export function setThumbnailSourceRenderer(renderer: ScenePreviewRenderer | null): void {
  activeRenderer = renderer;
}

export interface CapturedThumbnail {
  dataUrl: string;
  width: number;
  height: number;
}

/**
 * Capture the current viewport as a PNG data URL, at most `maxDimension` on its
 * longest side.
 *
 * Returns null rather than throwing when no renderer is mounted or the read-back
 * fails: publishing without a thumbnail is a degraded result, not a failed publish.
 */
export async function captureSceneThumbnail(
  maxDimension = 320
): Promise<CapturedThumbnail | null> {
  const renderer = activeRenderer;
  if (!renderer?.captureFrame) return null;

  try {
    const source = await renderer.captureFrame();
    if (!source) return null;

    const scale = Math.min(1, maxDimension / Math.max(source.width, source.height));
    const width = Math.max(1, Math.round(source.width * scale));
    const height = Math.max(1, Math.round(source.height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return null;

    // Scenes are keyed graphics with transparent backgrounds, so the thumbnail is
    // drawn over a checker-free neutral dark fill: a transparent PNG on a dark panel
    // reads as an empty card.
    context.fillStyle = "#0d141b";
    context.fillRect(0, 0, width, height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(source, 0, 0, width, height);

    return { dataUrl: canvas.toDataURL("image/png"), width, height };
  } catch {
    // A read-back can fail on a lost context. Not worth failing a publish over.
    return null;
  }
}
