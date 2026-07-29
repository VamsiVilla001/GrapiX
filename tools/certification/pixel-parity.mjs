/**
 * Pixel comparison for parity testing.
 *
 * The comparison core, separate from any particular capture route, because the two things
 * fail differently: a capture problem is plumbing, a comparison result is evidence.
 *
 * What it measures, and why these and not just "are they equal":
 *
 * - **Max channel delta.** The single worst pixel. A large max with a tiny mean is a
 *   localised fault — one glyph, one edge, one seam — which is exactly what a mean hides.
 * - **Mean absolute error.** Overall drift. A small max with a large mean is a systematic
 *   difference: a colour-space or gamma mismatch, not a rendering bug.
 * - **Pixels beyond tolerance.** How much of the frame is affected, as a percentage.
 * - **Worst 16×16 block.** *Where* the difference is. Broadcast faults cluster: a seam is
 *   a line, a wrong glyph is a box. A single coordinate would not show that.
 * - **Alpha handled explicitly.** Two renderers can agree on visible colour and disagree
 *   on premultiplication. Comparing straight RGB over a mismatched alpha reports a
 *   difference that is not visible, and comparing composited colour hides one that is.
 *
 * Tolerance is not zero by default. Two GPUs, or a GPU and a CPU rasteriser, legitimately
 * differ in the last bit or two on antialiased edges; demanding exactness would make the
 * harness fail on correct output and be switched off. What must not differ is anything a
 * viewer could see.
 */

import { deflateSync, inflateSync } from "node:zlib";

/** A comparable image: 8-bit RGBA, row-major, no padding. */
export function createImage(width, height, pixels) {
  if (pixels.length !== width * height * 4) {
    throw new Error(
      `image is ${width}x${height} (${width * height * 4} bytes) but ${pixels.length} were supplied`
    );
  }
  return { width, height, pixels };
}

/** Convert BGRA — what the engine's recording output writes — to RGBA. */
export function bgraToRgba(width, height, bgra) {
  const rgba = new Uint8Array(width * height * 4);
  for (let index = 0; index < rgba.length; index += 4) {
    rgba[index] = bgra[index + 2];
    rgba[index + 1] = bgra[index + 1];
    rgba[index + 2] = bgra[index];
    rgba[index + 3] = bgra[index + 3];
  }
  return createImage(width, height, rgba);
}

/**
 * Undo premultiplication.
 *
 * The native renderer produces premultiplied alpha; a canvas read-back is straight. One of
 * the two has to be converted or every semi-transparent pixel reads as a difference that
 * is not visible.
 */
export function unpremultiply(image) {
  const pixels = new Uint8Array(image.pixels);
  for (let index = 0; index < pixels.length; index += 4) {
    const alpha = pixels[index + 3];
    if (alpha === 0 || alpha === 255) continue;
    const scale = 255 / alpha;
    pixels[index] = Math.min(255, Math.round(pixels[index] * scale));
    pixels[index + 1] = Math.min(255, Math.round(pixels[index + 1] * scale));
    pixels[index + 2] = Math.min(255, Math.round(pixels[index + 2] * scale));
  }
  return createImage(image.width, image.height, pixels);
}

/** Composite over an opaque background, so alpha differences become visible ones. */
export function flattenOnto(image, background = [0, 0, 0]) {
  const pixels = new Uint8Array(image.pixels);
  for (let index = 0; index < pixels.length; index += 4) {
    const alpha = pixels[index + 3] / 255;
    for (let channel = 0; channel < 3; channel += 1) {
      pixels[index + channel] = Math.round(
        pixels[index + channel] * alpha + background[channel] * (1 - alpha)
      );
    }
    pixels[index + 3] = 255;
  }
  return createImage(image.width, image.height, pixels);
}

const BLOCK = 16;

/**
 * Compare two images.
 *
 * `tolerance` is the per-channel 0–255 delta below which a pixel counts as matching.
 * `maxDifferentRatio` is the share of pixels allowed to exceed it.
 */
export function compareImages(left, right, options = {}) {
  const tolerance = options.tolerance ?? 2;
  const maxDifferentRatio = options.maxDifferentRatio ?? 0;
  const ignoreAlpha = options.ignoreAlpha ?? false;

  if (left.width !== right.width || left.height !== right.height) {
    return {
      comparable: false,
      reason: `sizes differ: ${left.width}x${left.height} against ${right.width}x${right.height}`,
      matches: false
    };
  }

  const channels = ignoreAlpha ? 3 : 4;
  const pixelCount = left.width * left.height;
  const blockColumns = Math.ceil(left.width / BLOCK);
  const blockRows = Math.ceil(left.height / BLOCK);
  const blockScores = new Float64Array(blockColumns * blockRows);

  let maxDelta = 0;
  let maxDeltaAt = null;
  let totalDelta = 0;
  let differentPixels = 0;
  const diff = new Uint8Array(pixelCount * 4);

  for (let y = 0; y < left.height; y += 1) {
    for (let x = 0; x < left.width; x += 1) {
      const base = (y * left.width + x) * 4;
      let worstChannel = 0;

      for (let channel = 0; channel < channels; channel += 1) {
        const delta = Math.abs(left.pixels[base + channel] - right.pixels[base + channel]);
        if (delta > worstChannel) worstChannel = delta;
        totalDelta += delta;
      }

      if (worstChannel > maxDelta) {
        maxDelta = worstChannel;
        maxDeltaAt = { x, y };
      }
      if (worstChannel > tolerance) {
        differentPixels += 1;
        const blockIndex =
          Math.floor(y / BLOCK) * blockColumns + Math.floor(x / BLOCK);
        blockScores[blockIndex] += worstChannel;
      }

      // Differences in red over the darkened original, so a diff image is readable at a
      // glance rather than needing a colour key.
      const emphasis = Math.min(255, worstChannel * 8);
      diff[base] = emphasis;
      diff[base + 1] = Math.round(left.pixels[base + 1] * 0.25);
      diff[base + 2] = Math.round(left.pixels[base + 2] * 0.25);
      diff[base + 3] = 255;
    }
  }

  let worstBlockIndex = 0;
  for (let index = 1; index < blockScores.length; index += 1) {
    if (blockScores[index] > blockScores[worstBlockIndex]) worstBlockIndex = index;
  }

  const differentRatio = differentPixels / pixelCount;
  const meanAbsoluteError = totalDelta / (pixelCount * channels);

  return {
    comparable: true,
    width: left.width,
    height: left.height,
    tolerance,
    maxChannelDelta: maxDelta,
    maxChannelDeltaAt: maxDeltaAt,
    meanAbsoluteError,
    differentPixels,
    differentRatio,
    worstBlock:
      blockScores[worstBlockIndex] > 0
        ? {
            x: (worstBlockIndex % blockColumns) * BLOCK,
            y: Math.floor(worstBlockIndex / blockColumns) * BLOCK,
            size: BLOCK,
            score: blockScores[worstBlockIndex]
          }
        : null,
    matches: differentRatio <= maxDifferentRatio,
    diff: createImage(left.width, left.height, diff)
  };
}

/**
 * Encode as a PNG.
 *
 * Written by hand against `node:zlib` rather than pulled from a dependency: the harness has
 * to be able to write evidence on a machine with nothing installed. Rows are unfiltered,
 * which costs some size and no correctness — a diff image is an artefact, not a payload.
 */
export function encodePng(image) {
  const { width, height, pixels } = image;

  // Each row is preceded by its filter byte.
  const raw = new Uint8Array(height * (width * 4 + 1));
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0;
    raw.set(pixels.subarray(y * width * 4, (y + 1) * width * 4), rowStart + 1);
  }

  const chunks = [
    signature(),
    chunk("IHDR", ihdr(width, height)),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", new Uint8Array(0))
  ];

  const total = chunks.reduce((sum, part) => sum + part.length, 0);
  const png = new Uint8Array(total);
  let offset = 0;
  for (const part of chunks) {
    png.set(part, offset);
    offset += part.length;
  }
  return png;
}

function signature() {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
}

function ihdr(width, height) {
  const data = new Uint8Array(13);
  const view = new DataView(data.buffer);
  view.setUint32(0, width, false);
  view.setUint32(4, height, false);
  data[8] = 8; // bit depth
  data[9] = 6; // truecolour with alpha
  return data;
}

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length, false);
  for (let index = 0; index < 4; index += 1) {
    out[4 + index] = type.charCodeAt(index);
  }
  out.set(data, 8);
  const crcInput = out.subarray(4, 8 + data.length);
  view.setUint32(8 + data.length, crc32(crcInput), false);
  return out;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(data) {
  let crc = 0xffffffff;
  for (let index = 0; index < data.length; index += 1) {
    crc = CRC_TABLE[(crc ^ data[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Decode an 8-bit RGBA PNG.
 *
 * Handles real deflate and all five row filters, because the images this reads are written
 * by the Rust `image` crate and by browsers — neither of which produces the simplified form
 * a hand-rolled writer emits. A reader that only understood its own output would pass its
 * own tests and fail on every real capture.
 */
export function decodePng(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8; // signature
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colourType = 0;
  const idat = [];

  while (offset < bytes.length) {
    const length = view.getUint32(offset, false);
    const type = String.fromCharCode(
      bytes[offset + 4],
      bytes[offset + 5],
      bytes[offset + 6],
      bytes[offset + 7]
    );
    const data = bytes.subarray(offset + 8, offset + 8 + length);

    if (type === "IHDR") {
      width = view.getUint32(offset + 8, false);
      height = view.getUint32(offset + 12, false);
      bitDepth = bytes[offset + 16];
      colourType = bytes[offset + 17];
      if (bytes[offset + 20] !== 0) {
        throw new Error("interlaced PNGs are not supported by this reader");
      }
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }

    offset += 12 + length;
  }

  if (bitDepth !== 8 || (colourType !== 6 && colourType !== 2)) {
    throw new Error(
      `only 8-bit RGB or RGBA PNGs are supported; this one is depth ${bitDepth}, colour type ${colourType}`
    );
  }

  const channels = colourType === 6 ? 4 : 3;
  const raw = new Uint8Array(inflateSync(concat(idat)));
  const stride = width * channels;
  const pixels = new Uint8Array(width * height * 4);
  let previousRow = new Uint8Array(stride);

  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    const filter = raw[rowStart];
    const row = new Uint8Array(raw.subarray(rowStart + 1, rowStart + 1 + stride));

    unfilterRow(filter, row, previousRow, channels);

    for (let x = 0; x < width; x += 1) {
      const from = x * channels;
      const to = (y * width + x) * 4;
      pixels[to] = row[from];
      pixels[to + 1] = row[from + 1];
      pixels[to + 2] = row[from + 2];
      // An RGB source is fully opaque; a capture without alpha must not read as invisible.
      pixels[to + 3] = channels === 4 ? row[from + 3] : 255;
    }

    previousRow = row;
  }

  return createImage(width, height, pixels);
}

/** Reverse one row's filter in place, per the PNG specification. */
function unfilterRow(filter, row, previous, bytesPerPixel) {
  const length = row.length;

  switch (filter) {
    case 0:
      return;
    case 1:
      for (let index = bytesPerPixel; index < length; index += 1) {
        row[index] = (row[index] + row[index - bytesPerPixel]) & 0xff;
      }
      return;
    case 2:
      for (let index = 0; index < length; index += 1) {
        row[index] = (row[index] + previous[index]) & 0xff;
      }
      return;
    case 3:
      for (let index = 0; index < length; index += 1) {
        const left = index >= bytesPerPixel ? row[index - bytesPerPixel] : 0;
        row[index] = (row[index] + ((left + previous[index]) >> 1)) & 0xff;
      }
      return;
    case 4:
      for (let index = 0; index < length; index += 1) {
        const left = index >= bytesPerPixel ? row[index - bytesPerPixel] : 0;
        const above = previous[index];
        const upperLeft = index >= bytesPerPixel ? previous[index - bytesPerPixel] : 0;
        row[index] = (row[index] + paeth(left, above, upperLeft)) & 0xff;
      }
      return;
    default:
      throw new Error(`unknown PNG row filter ${filter}`);
  }
}

function paeth(left, above, upperLeft) {
  const estimate = left + above - upperLeft;
  const distanceLeft = Math.abs(estimate - left);
  const distanceAbove = Math.abs(estimate - above);
  const distanceUpperLeft = Math.abs(estimate - upperLeft);
  if (distanceLeft <= distanceAbove && distanceLeft <= distanceUpperLeft) return left;
  return distanceAbove <= distanceUpperLeft ? above : upperLeft;
}

/** Join byte arrays, for IDAT chunks that arrive in pieces. */
function concat(parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** One-line summary for a report. */
export function describeComparison(result) {
  if (!result.comparable) return `not comparable: ${result.reason}`;

  const percentage = (result.differentRatio * 100).toFixed(4);
  const worst = result.worstBlock
    ? `, worst block at ${result.worstBlock.x},${result.worstBlock.y}`
    : "";
  const at = result.maxChannelDeltaAt
    ? ` at ${result.maxChannelDeltaAt.x},${result.maxChannelDeltaAt.y}`
    : "";

  return (
    `max channel delta ${result.maxChannelDelta}${at}, ` +
    `mean ${result.meanAbsoluteError.toFixed(3)}, ` +
    `${result.differentPixels} of ${result.width * result.height} pixels beyond ±${result.tolerance} (${percentage}%)${worst}`
  );
}
