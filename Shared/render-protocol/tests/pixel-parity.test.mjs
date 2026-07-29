import assert from "node:assert/strict";
import test from "node:test";

import {
  bgraToRgba,
  compareImages,
  createImage,
  decodePng,
  describeComparison,
  encodePng,
  flattenOnto,
  unpremultiply
} from "../../../tools/certification/pixel-parity.mjs";

/**
 * The comparison core is what decides pass or fail in the parity harness, so it is tested
 * on its own. A comparison that reports "identical" for two different images, or a
 * difference for two identical ones, would make every parity result meaningless.
 */

function solid(width, height, [r, g, b, a]) {
  const pixels = new Uint8Array(width * height * 4);
  for (let index = 0; index < pixels.length; index += 4) {
    pixels[index] = r;
    pixels[index + 1] = g;
    pixels[index + 2] = b;
    pixels[index + 3] = a;
  }
  return createImage(width, height, pixels);
}

test("an image with the wrong number of bytes is rejected on construction", () => {
  // Better than comparing garbage: a truncated capture is a plumbing fault, and it must
  // not be reported as a rendering difference.
  assert.throws(() => createImage(2, 2, new Uint8Array(8)), /16 bytes/);
});

test("identical images compare as matching with no difference", () => {
  const result = compareImages(solid(4, 4, [10, 20, 30, 255]), solid(4, 4, [10, 20, 30, 255]));
  assert.equal(result.comparable, true);
  assert.equal(result.maxChannelDelta, 0);
  assert.equal(result.differentPixels, 0);
  assert.equal(result.meanAbsoluteError, 0);
  assert.equal(result.matches, true);
  assert.equal(result.worstBlock, null);
});

test("images of different sizes are not comparable rather than failing silently", () => {
  const result = compareImages(solid(4, 4, [0, 0, 0, 255]), solid(4, 5, [0, 0, 0, 255]));
  assert.equal(result.comparable, false);
  assert.equal(result.matches, false);
  assert.match(result.reason, /sizes differ/);
});

test("a difference inside the tolerance is not counted, but is still reported", () => {
  const left = solid(4, 4, [100, 100, 100, 255]);
  const right = solid(4, 4, [102, 100, 100, 255]);

  // Two GPUs legitimately differ in the last bit on antialiased edges. Demanding
  // exactness would make the harness fail on correct output and get switched off.
  const result = compareImages(left, right, { tolerance: 2 });
  assert.equal(result.maxChannelDelta, 2);
  assert.equal(result.differentPixels, 0);
  assert.equal(result.matches, true);
});

test("a difference beyond the tolerance fails and is located", () => {
  const left = solid(32, 32, [0, 0, 0, 255]);
  const right = solid(32, 32, [0, 0, 0, 255]);
  // One bright pixel, well inside the second block.
  const base = (20 * 32 + 19) * 4;
  right.pixels[base] = 200;

  const result = compareImages(left, right, { tolerance: 2 });
  assert.equal(result.differentPixels, 1);
  assert.equal(result.maxChannelDelta, 200);
  assert.deepEqual(result.maxChannelDeltaAt, { x: 19, y: 20 });
  assert.equal(result.matches, false);
  // The block, not just the pixel: broadcast faults cluster, and a seam is a line.
  assert.deepEqual(
    { x: result.worstBlock.x, y: result.worstBlock.y },
    { x: 16, y: 16 }
  );
});

test("a large max with a small mean is distinguishable from the reverse", () => {
  const base = solid(16, 16, [50, 50, 50, 255]);

  const localised = solid(16, 16, [50, 50, 50, 255]);
  localised.pixels[0] = 250;
  const localisedResult = compareImages(base, localised, { tolerance: 1 });

  const systematic = solid(16, 16, [54, 54, 54, 255]);
  const systematicResult = compareImages(base, systematic, { tolerance: 1 });

  // A localised fault: one wrong glyph or one seam.
  assert.equal(localisedResult.maxChannelDelta, 200);
  assert.ok(localisedResult.meanAbsoluteError < 1);

  // A systematic one: a gamma or colour-space mismatch, not a rendering bug.
  assert.equal(systematicResult.maxChannelDelta, 4);
  assert.ok(systematicResult.meanAbsoluteError > 2);
});

test("alpha differences can be included or excluded deliberately", () => {
  const opaque = solid(4, 4, [10, 10, 10, 255]);
  const transparent = solid(4, 4, [10, 10, 10, 128]);

  const withAlpha = compareImages(opaque, transparent, { tolerance: 2 });
  assert.equal(withAlpha.maxChannelDelta, 127);

  // Two renderers can agree on visible colour and disagree on premultiplication.
  const ignoringAlpha = compareImages(opaque, transparent, { tolerance: 2, ignoreAlpha: true });
  assert.equal(ignoringAlpha.maxChannelDelta, 0);
});

test("BGRA from the recording output converts to RGBA", () => {
  // The engine writes BGRA. Comparing it as RGBA would swap red and blue and report every
  // coloured pixel as a difference.
  const bgra = new Uint8Array([30, 20, 10, 255]);
  const image = bgraToRgba(1, 1, bgra);
  assert.deepEqual([...image.pixels], [10, 20, 30, 255]);
});

test("unpremultiply recovers the straight colour", () => {
  // Half-transparent white, premultiplied, is 128,128,128,128.
  const premultiplied = createImage(1, 1, new Uint8Array([128, 128, 128, 128]));
  const straight = unpremultiply(premultiplied);
  assert.equal(straight.pixels[0], 255);
  assert.equal(straight.pixels[3], 128);
});

test("unpremultiply leaves fully opaque and fully transparent pixels alone", () => {
  const image = createImage(2, 1, new Uint8Array([10, 20, 30, 255, 40, 50, 60, 0]));
  const result = unpremultiply(image);
  assert.deepEqual([...result.pixels], [10, 20, 30, 255, 40, 50, 60, 0]);
});

test("flattening makes an alpha difference into a visible one", () => {
  const half = createImage(1, 1, new Uint8Array([255, 255, 255, 128]));
  const flattened = flattenOnto(half, [0, 0, 0]);
  assert.equal(flattened.pixels[0], 128);
  assert.equal(flattened.pixels[3], 255);
});

test("a PNG written by the harness reads back identically", () => {
  // The diff image is the evidence a failure leaves behind, so it has to be a real PNG
  // rather than something only this tool can open.
  const original = solid(9, 7, [1, 2, 3, 255]);
  original.pixels[(3 * 9 + 4) * 4] = 250;

  const decoded = decodePng(encodePng(original));
  assert.equal(decoded.width, 9);
  assert.equal(decoded.height, 7);
  assert.deepEqual([...decoded.pixels], [...original.pixels]);
});

test("a PNG larger than one deflate block still round-trips", () => {
  // Stored blocks are capped at 65535 bytes, so anything past that exercises the
  // multi-block path — which is every real frame.
  const image = solid(200, 200, [7, 8, 9, 255]);
  image.pixels[12345] = 200;

  const decoded = decodePng(encodePng(image));
  assert.deepEqual([...decoded.pixels], [...image.pixels]);
});

test("the summary states the numbers a reader needs to act on", () => {
  const left = solid(16, 16, [0, 0, 0, 255]);
  const right = solid(16, 16, [0, 0, 0, 255]);
  right.pixels[(5 * 16 + 6) * 4 + 1] = 90;

  const summary = describeComparison(compareImages(left, right, { tolerance: 2 }));
  assert.match(summary, /max channel delta 90 at 6,5/);
  assert.match(summary, /1 of 256 pixels beyond ±2/);
  assert.match(summary, /worst block at 0,0/);
});

test("a non-comparable result says why rather than reporting zero difference", () => {
  const summary = describeComparison(
    compareImages(solid(2, 2, [0, 0, 0, 255]), solid(3, 3, [0, 0, 0, 255]))
  );
  assert.match(summary, /not comparable/);
});

test("a PNG using every row filter decodes correctly", async () => {
  // The images this reads come from the Rust `image` crate and from browsers, both of which
  // choose filters per row. A reader that only handled unfiltered rows would pass against
  // its own output and fail on every real capture.
  const { deflateSync } = await import("node:zlib");

  const width = 4;
  const height = 5;
  const expected = createImage(
    width,
    height,
    new Uint8Array(
      Array.from({ length: width * height * 4 }, (_unused, index) => (index * 13) % 256)
    )
  );

  // Build the filtered stream by hand: one row per filter type, 0 through 4.
  const stride = width * 4;
  const raw = new Uint8Array(height * (stride + 1));
  let previous = new Uint8Array(stride);

  for (let y = 0; y < height; y += 1) {
    const filter = y; // 0..4
    const row = expected.pixels.subarray(y * stride, (y + 1) * stride);
    const encoded = new Uint8Array(stride);

    for (let index = 0; index < stride; index += 1) {
      const left = index >= 4 ? row[index - 4] : 0;
      const above = previous[index];
      const upperLeft = index >= 4 ? previous[index - 4] : 0;

      switch (filter) {
        case 0:
          encoded[index] = row[index];
          break;
        case 1:
          encoded[index] = (row[index] - left) & 0xff;
          break;
        case 2:
          encoded[index] = (row[index] - above) & 0xff;
          break;
        case 3:
          encoded[index] = (row[index] - ((left + above) >> 1)) & 0xff;
          break;
        default: {
          const estimate = left + above - upperLeft;
          const dl = Math.abs(estimate - left);
          const da = Math.abs(estimate - above);
          const du = Math.abs(estimate - upperLeft);
          const predictor = dl <= da && dl <= du ? left : da <= du ? above : upperLeft;
          encoded[index] = (row[index] - predictor) & 0xff;
        }
      }
    }

    raw[y * (stride + 1)] = filter;
    raw.set(encoded, y * (stride + 1) + 1);
    previous = row;
  }

  const png = buildPng(width, height, deflateSync(raw));
  const decoded = decodePng(png);
  assert.deepEqual([...decoded.pixels], [...expected.pixels]);
});

test("an RGB PNG with no alpha channel decodes as fully opaque", async () => {
  const { deflateSync } = await import("node:zlib");

  // A capture saved without alpha must not read as invisible.
  const stride = 2 * 3;
  const raw = new Uint8Array(2 * (stride + 1));
  for (let y = 0; y < 2; y += 1) {
    raw[y * (stride + 1)] = 0;
    raw.set(new Uint8Array([10, 20, 30, 40, 50, 60]), y * (stride + 1) + 1);
  }

  const png = buildPng(2, 2, deflateSync(raw), 2);
  const decoded = decodePng(png);
  assert.equal(decoded.pixels[3], 255);
  assert.equal(decoded.pixels[0], 10);
});

/** Assemble a PNG around an already-compressed IDAT, for the decoder tests. */
function buildPng(width, height, idat, colourType = 6) {
  const crcTable = (() => {
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

  const crc = (data) => {
    let value = 0xffffffff;
    for (let index = 0; index < data.length; index += 1) {
      value = crcTable[(value ^ data[index]) & 0xff] ^ (value >>> 8);
    }
    return (value ^ 0xffffffff) >>> 0;
  };

  const makeChunk = (type, data) => {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length, false);
    for (let index = 0; index < 4; index += 1) out[4 + index] = type.charCodeAt(index);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length)), false);
    return out;
  };

  const ihdrData = new Uint8Array(13);
  const ihdrView = new DataView(ihdrData.buffer);
  ihdrView.setUint32(0, width, false);
  ihdrView.setUint32(4, height, false);
  ihdrData[8] = 8;
  ihdrData[9] = colourType;

  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    makeChunk("IHDR", ihdrData),
    makeChunk("IDAT", new Uint8Array(idat)),
    makeChunk("IEND", new Uint8Array(0))
  ];

  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const png = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    png.set(part, offset);
    offset += part.length;
  }
  return png;
}
