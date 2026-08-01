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

import { evaluateSceneAtFrame, type SceneDocument, type Vec2 } from "@grapix/shared-types";
import type { ScenePreviewRenderer } from "./ScenePreviewRenderer";
import { resolveRenderableObjects } from "./sceneMaterial";

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

export interface SceneThumbnailCaptureOptions {
  /** Scene to render before capture. Omit to capture the frame already on screen. */
  scene?: SceneDocument;
  /** Deterministic representative frame to render for the library card. */
  frame?: number;
  /** Editor playhead frame to restore after the offscreen read-back. */
  restoreFrame?: number;
  maxDimension?: number;
}

/**
 * Capture a deterministic scene frame, or the frame already in the viewport, as a PNG
 * data URL at most `maxDimension` on its longest side.
 *
 * Returns null rather than throwing when no renderer is mounted or the read-back
 * fails: publishing without a thumbnail is a degraded result, not a failed publish.
 */
export async function captureSceneThumbnail(
  options: SceneThumbnailCaptureOptions = {}
): Promise<CapturedThumbnail | null> {
  const renderer = activeRenderer;
  if (!renderer?.captureFrame) return null;

  const renderFrame = async (scene: SceneDocument, frame: number) => {
    const evaluated = evaluateSceneAtFrame(scene, Math.max(0, Math.round(frame)));
    await renderer.renderScene(evaluated, resolveRenderableObjects(evaluated));
  };

  let thumbnail: CapturedThumbnail | null = null;
  try {
    if (options.scene && options.frame !== undefined) {
      await renderFrame(options.scene, options.frame);
    }

    const source = await renderer.captureFrame();
    if (!source) return null;

    const maxDimension = options.maxDimension ?? 320;
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

    thumbnail = { dataUrl: canvas.toDataURL("image/png"), width, height };
  } catch {
    // A read-back can fail on a lost context. Not worth failing a publish over.
  } finally {
    if (
      options.scene
      && options.restoreFrame !== undefined
      && options.restoreFrame !== options.frame
    ) {
      try {
        await renderFrame(options.scene, options.restoreFrame);
      } catch {
        // React will drive the renderer back to editor state on the next scene change.
      }
    }
  }
  return thumbnail;
}
/**
 * Read the colour the operator can actually see at a canvas point.
 *
 * Unlike scene-property sampling this includes textures, materials, opacity and
 * every composited layer. The small read-back is used only on an eyedropper click;
 * hover feedback stays property-based so moving the pointer cannot stall the GPU.
 */
export async function sampleRenderedSceneColor(
  point: Vec2,
  canvasSize: Vec2,
  sampleSize: 1 | 3 | 5 | 11
): Promise<string | null> {
  const source = await activeRenderer?.captureFrame?.();
  if (!source || source.width < 1 || source.height < 1) return null;
  const centerX = Math.round(point.x / Math.max(1, canvasSize.x) * source.width);
  const centerY = Math.round(point.y / Math.max(1, canvasSize.y) * source.height);
  const half = Math.floor(sampleSize / 2);
  const left = Math.max(0, Math.min(source.width - 1, centerX - half));
  const top = Math.max(0, Math.min(source.height - 1, centerY - half));
  const width = Math.max(1, Math.min(sampleSize, source.width - left));
  const height = Math.max(1, Math.min(sampleSize, source.height - top));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  try {
    context.drawImage(source, left, top, width, height, 0, 0, width, height);
    return averageImageData(context.getImageData(0, 0, width, height).data);
  } catch {
    return null;
  }
}

function averageImageData(data: Uint8ClampedArray): string {
  let alpha = 0;
  let red = 0;
  let green = 0;
  let blue = 0;
  for (let index = 0; index < data.length; index += 4) {
    const pixelAlpha = data[index + 3] / 255;
    alpha += pixelAlpha;
    red += data[index] * pixelAlpha;
    green += data[index + 1] * pixelAlpha;
    blue += data[index + 2] * pixelAlpha;
  }
  const pixels = Math.max(1, data.length / 4);
  const outputAlpha = alpha / pixels;
  const channel = (value: number) => Math.round(alpha > 0 ? value / alpha : 0)
    .toString(16)
    .padStart(2, "0");
  return `#${channel(red)}${channel(green)}${channel(blue)}${Math.round(outputAlpha * 255)
    .toString(16)
    .padStart(2, "0")}`;
}

