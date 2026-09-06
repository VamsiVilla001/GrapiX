/**
 * Read a layered Photoshop file the way After Effects reads one.
 *
 * When After Effects imports a `.psd` it does not hand the renderer the `.psd`. It creates one
 * footage item per Photoshop layer, each carrying that layer's own pixels and its own bounds, and
 * the composition then positions those footage items. Reproducing the import means reproducing
 * that: a `.psd` registered as a single asset is a file no browser can decode, which is exactly
 * how an imported composition ends up drawing a grid of missing-texture placeholders.
 *
 * ## Retain Layer Sizes
 *
 * After Effects offers "Composition" and "Composition – Retain Layer Sizes". The second is the one
 * that round-trips: each footage item is the size of the layer's own bounding box, and the AE layer's
 * `position` / `anchorPoint` place it. The first pads every layer out to the document frame, which
 * throws away the bounds and makes every object canvas-sized — the state this importer was in when
 * every object came back 1920x1080. So this catalog always reports the layer's own rectangle.
 *
 * ## Groups
 *
 * A Photoshop group imported as one footage item is the group's *composite*. Photoshop usually
 * stores a raster for it, and `ag-psd` surfaces that as the group layer's own `imageData`. When it
 * does not, the children are drawn into a canvas here rather than reporting the group as missing —
 * a group that renders nothing is indistinguishable to an operator from a broken import.
 */

import { createCanvas } from "@napi-rs/canvas";
import { initializeCanvas, readPsd, type Layer, type Psd } from "ag-psd";
import { PNG } from "pngjs";

// `ag-psd` needs a canvas factory before it will decode pixel data at all; without this every
// `readPsd` with `useImageData` throws "Canvas not initialized".
initializeCanvas(createCanvas as never);

export interface PsdLayerEntry {
  /** Position in Photoshop document order, bottom layer first — the order AE enumerates. */
  index: number;
  name: string;
  /** The layer's own bounding box in document space. */
  left: number;
  top: number;
  width: number;
  height: number;
  /** 0–1. Photoshop stores 0–255; already normalised. */
  opacity: number;
  hidden: boolean;
  blendMode?: string;
  /** PNG bytes of this layer alone, at its own bounds. */
  png: Buffer;
}

export interface PsdCatalog {
  documentWidth: number;
  documentHeight: number;
  layers: PsdLayerEntry[];
}

/** Encode one RGBA buffer as PNG. */
function encodePng(width: number, height: number, data: ArrayLike<number>): Buffer {
  const png = new PNG({ width, height });
  png.data = Buffer.from(data as unknown as Uint8Array);
  return PNG.sync.write(png);
}

/**
 * Draw a group's descendants into one canvas, so a group with no stored composite still resolves.
 *
 * Photoshop writes child layers at document coordinates, so each is drawn at its own offset
 * relative to the group's bounding box.
 */
function compositeGroup(layer: Layer, bounds: { left: number; top: number; width: number; height: number }): Buffer | null {
  if (bounds.width <= 0 || bounds.height <= 0) return null;
  const canvas = createCanvas(bounds.width, bounds.height);
  const context = canvas.getContext("2d");
  let drew = false;

  const draw = (node: Layer): void => {
    if (node.children?.length) {
      for (const child of node.children) draw(child);
      return;
    }
    if (!node.imageData || node.hidden) return;
    const width = node.imageData.width;
    const height = node.imageData.height;
    if (width <= 0 || height <= 0) return;
    const tile = createCanvas(width, height);
    const tileContext = tile.getContext("2d");
    const image = tileContext.createImageData(width, height);
    image.data.set(node.imageData.data as unknown as Uint8ClampedArray);
    tileContext.putImageData(image, 0, 0);
    context.globalAlpha = (node.opacity ?? 255) / 255;
    context.drawImage(tile, (node.left ?? 0) - bounds.left, (node.top ?? 0) - bounds.top);
    drew = true;
  };

  for (const child of layer.children ?? []) draw(child);
  return drew ? canvas.toBuffer("image/png") : null;
}

/** Bounds of a layer, falling back to the union of its children for a group with no own rect. */
function layerBounds(layer: Layer): { left: number; top: number; width: number; height: number } {
  const left = layer.left ?? 0;
  const top = layer.top ?? 0;
  const right = layer.right ?? left;
  const bottom = layer.bottom ?? top;
  if (right > left && bottom > top) return { left, top, width: right - left, height: bottom - top };

  let minLeft = Number.POSITIVE_INFINITY;
  let minTop = Number.POSITIVE_INFINITY;
  let maxRight = Number.NEGATIVE_INFINITY;
  let maxBottom = Number.NEGATIVE_INFINITY;
  const walk = (node: Layer): void => {
    if (node.children?.length) {
      for (const child of node.children) walk(child);
      return;
    }
    if (!node.imageData) return;
    const nodeLeft = node.left ?? 0;
    const nodeTop = node.top ?? 0;
    minLeft = Math.min(minLeft, nodeLeft);
    minTop = Math.min(minTop, nodeTop);
    maxRight = Math.max(maxRight, nodeLeft + node.imageData.width);
    maxBottom = Math.max(maxBottom, nodeTop + node.imageData.height);
  };
  walk(layer);
  if (!Number.isFinite(minLeft) || maxRight <= minLeft || maxBottom <= minTop) {
    return { left, top, width: 0, height: 0 };
  }
  return { left: minLeft, top: minTop, width: maxRight - minLeft, height: maxBottom - minTop };
}

/**
 * Every top-level Photoshop layer, in the order After Effects enumerates them.
 *
 * Top-level only, deliberately: an AE import references a group as one merged footage item, not as
 * its members, so descending into groups here would produce entries no AE layer ever asks for and
 * would break the ordinal fallback, which counts on this list matching AE's own numbering.
 */
export function readPsdCatalog(bytes: Buffer): PsdCatalog {
  const psd: Psd = readPsd(Uint8Array.from(bytes).buffer, {
    useImageData: true,
    skipThumbnail: true,
    throwForMissingFeatures: false
  });

  const layers: PsdLayerEntry[] = [];
  const top = psd.children ?? [];
  for (let index = 0; index < top.length; index += 1) {
    const layer = top[index]!;
    const bounds = layerBounds(layer);
    let png: Buffer | null = null;

    if (layer.imageData && layer.imageData.width > 0 && layer.imageData.height > 0) {
      png = encodePng(layer.imageData.width, layer.imageData.height, layer.imageData.data);
      bounds.width = layer.imageData.width;
      bounds.height = layer.imageData.height;
    } else if (layer.children?.length) {
      png = compositeGroup(layer, bounds);
    }
    if (!png) continue;

    layers.push({
      index,
      name: layer.name ?? `Layer ${index + 1}`,
      left: bounds.left,
      top: bounds.top,
      width: bounds.width,
      height: bounds.height,
      opacity: (layer.opacity ?? 255) / 255,
      hidden: Boolean(layer.hidden),
      blendMode: layer.blendMode,
      png
    });
  }

  return { documentWidth: psd.width, documentHeight: psd.height, layers };
}
