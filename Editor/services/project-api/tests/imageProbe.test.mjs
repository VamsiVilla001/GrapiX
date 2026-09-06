/**
 * Reading geometry and alpha out of an image header.
 *
 * Bit-level parsing, so the fixtures are real bytes rather than descriptions of bytes. The PNGs are
 * genuinely valid files with correct CRCs — a decoder would accept them — because a parser tested
 * only against buffers the test itself invented will agree with the test and disagree with the
 * world.
 *
 * The cases that matter are the ones where the obvious implementation is wrong: a palette PNG whose
 * transparency lives in a `tRNS` chunk rather than its colour type, a JPEG whose frame header sits
 * behind a large EXIF block, and a lossless WebP that states alpha in a bit nobody reads by
 * accident.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { after, before, test } from "node:test";

const { probeImageFile, clearImageProbeCache } = await import("../dist/imageProbe.js");

let root;

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), "grapix-probe-"));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

/* ── Fixture builders ─────────────────────────────────────────────────────────────────────── */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A PNG chunk: length, type, data, CRC over type+data. */
function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

/** A real, decodable PNG of the given geometry and colour type. */
function png({ width, height, colorType, trns = false }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;           // bit depth
  ihdr[9] = colorType;

  const chunks = [
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr)
  ];
  if (colorType === 3) chunks.push(pngChunk("PLTE", Buffer.from([0, 0, 0, 255, 255, 255])));
  if (trns) chunks.push(pngChunk("tRNS", Buffer.from([0])));
  chunks.push(pngChunk("IDAT", deflateSync(Buffer.alloc(width * height * 4 + height))));
  chunks.push(pngChunk("IEND", Buffer.alloc(0)));
  return Buffer.concat(chunks);
}

/** A JPEG whose SOF0 sits behind `padBytes` of APP1, the way a camera file carries EXIF. */
function jpeg({ width, height, padBytes = 0 }) {
  const parts = [Buffer.from([0xff, 0xd8])];

  if (padBytes > 0) {
    const app1 = Buffer.alloc(padBytes + 2);
    app1.writeUInt16BE(padBytes + 2, 0);
    parts.push(Buffer.from([0xff, 0xe1]), app1);
  }

  const sof = Buffer.alloc(17);
  sof.writeUInt16BE(17, 0);   // segment length
  sof[2] = 8;                 // sample precision
  sof.writeUInt16BE(height, 3);
  sof.writeUInt16BE(width, 5);
  sof[7] = 3;                 // component count
  parts.push(Buffer.from([0xff, 0xc0]), sof, Buffer.from([0xff, 0xda]));
  return Buffer.concat(parts);
}

function riff(fourcc, payload) {
  const header = Buffer.alloc(12);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(payload.length + 4, 4);
  header.write("WEBP", 8, "ascii");
  const chunk = Buffer.alloc(8);
  chunk.write(fourcc, 0, "ascii");
  chunk.writeUInt32LE(payload.length, 4);
  return Buffer.concat([header, chunk, payload, Buffer.alloc(32)]);
}

function webpExtended({ width, height, alpha }) {
  const payload = Buffer.alloc(10);
  payload[0] = alpha ? 0x10 : 0x00;
  payload.writeUIntLE(width - 1, 4, 3);
  payload.writeUIntLE(height - 1, 7, 3);
  return riff("VP8X", payload);
}

function webpLossless({ width, height, alpha }) {
  const payload = Buffer.alloc(9);
  payload[0] = 0x2f; // signature
  const bits = (width - 1) | ((height - 1) << 14) | (alpha ? 1 << 28 : 0);
  payload.writeUInt32LE(bits >>> 0, 1);
  return riff("VP8L", payload);
}

/**
 * A lossy WebP's geometry sits at absolute offsets 26 and 28 — that is, 6 and 8 into the `VP8 `
 * chunk payload, immediately after the 3-byte frame tag and the 3-byte start code.
 */
function webpLossy({ width, height }) {
  const payload = Buffer.alloc(20);
  payload[3] = 0x9d;
  payload[4] = 0x01;
  payload[5] = 0x2a;
  payload.writeUInt16LE(width, 6);
  payload.writeUInt16LE(height, 8);
  return riff("VP8 ", payload);
}

function gif({ width, height, transparent }) {
  const parts = [Buffer.from("GIF89a", "ascii")];
  const screen = Buffer.alloc(7);
  screen.writeUInt16LE(width, 0);
  screen.writeUInt16LE(height, 2);
  parts.push(screen);
  const gce = Buffer.alloc(8);
  gce[0] = 0x21;
  gce[1] = 0xf9;
  gce[2] = 0x04;
  gce[3] = transparent ? 0x01 : 0x00;
  parts.push(gce);
  return Buffer.concat(parts);
}

function bmp({ width, height, bitCount }) {
  const buffer = Buffer.alloc(54);
  buffer.write("BM", 0, "ascii");
  buffer.writeInt32LE(width, 18);
  buffer.writeInt32LE(height, 22);
  buffer.writeUInt16LE(bitCount, 28);
  return buffer;
}

let fixtureCount = 0;
async function fixture(bytes, extension) {
  fixtureCount += 1;
  const file = path.join(root, `fixture-${fixtureCount}.${extension}`);
  await writeFile(file, bytes);
  return file;
}

/** Probe a freshly written fixture. A unique mtime key per call keeps the cache out of the way. */
async function probe(bytes, extension) {
  const file = await fixture(bytes, extension);
  return probeImageFile(file, bytes.length, Date.now() + fixtureCount);
}

/* ── PNG ──────────────────────────────────────────────────────────────────────────────────── */

test("a PNG states its geometry in IHDR", async () => {
  assert.deepEqual(
    await probe(png({ width: 1920, height: 1080, colorType: 2 }), "png"),
    { width: 1920, height: 1080, hasAlphaChannel: false }
  );
});

test("PNG colour types 4 and 6 carry alpha in every pixel", async () => {
  assert.equal((await probe(png({ width: 8, height: 8, colorType: 6 }), "png")).hasAlphaChannel, true);
  assert.equal((await probe(png({ width: 8, height: 8, colorType: 4 }), "png")).hasAlphaChannel, true);
});

/**
 * The case the obvious implementation gets wrong. A palette PNG with one transparent index is the
 * standard logo-on-transparent export, and its colour type is 3 — reading colour type alone reports
 * it opaque, and the key goes to air as a black rectangle.
 */
test("a palette PNG is transparent when it carries tRNS", async () => {
  assert.equal(
    (await probe(png({ width: 64, height: 64, colorType: 3, trns: true }), "png")).hasAlphaChannel,
    true
  );
  assert.equal(
    (await probe(png({ width: 64, height: 64, colorType: 3 }), "png")).hasAlphaChannel,
    false
  );
});

/* ── JPEG ─────────────────────────────────────────────────────────────────────────────────── */

test("a JPEG's geometry is found by walking to its frame header", async () => {
  assert.deepEqual(
    await probe(jpeg({ width: 3840, height: 2160 }), "jpg"),
    { width: 3840, height: 2160, hasAlphaChannel: false }
  );
});

/** A camera JPEG carries EXIF and often a thumbnail before SOF0. A fixed offset finds nothing. */
test("a frame header behind a large EXIF block is still found", async () => {
  const probed = await probe(jpeg({ width: 1280, height: 720, padBytes: 20_000 }), "jpg");
  assert.equal(probed.width, 1280);
  assert.equal(probed.height, 720);
});

/* ── WebP ─────────────────────────────────────────────────────────────────────────────────── */

test("an extended WebP reports alpha from its flag byte", async () => {
  assert.deepEqual(
    await probe(webpExtended({ width: 1000, height: 500, alpha: true }), "webp"),
    { width: 1000, height: 500, hasAlphaChannel: true }
  );
  assert.equal(
    (await probe(webpExtended({ width: 1000, height: 500, alpha: false }), "webp")).hasAlphaChannel,
    false
  );
});

test("a lossless WebP reports alpha from its header bit", async () => {
  assert.deepEqual(
    await probe(webpLossless({ width: 300, height: 200, alpha: true }), "webp"),
    { width: 300, height: 200, hasAlphaChannel: true }
  );
  assert.equal(
    (await probe(webpLossless({ width: 300, height: 200, alpha: false }), "webp")).hasAlphaChannel,
    false
  );
});

test("a lossy WebP has no alpha, as a fact about the encoding", async () => {
  assert.deepEqual(
    await probe(webpLossy({ width: 640, height: 480 }), "webp"),
    { width: 640, height: 480, hasAlphaChannel: false }
  );
});

/* ── GIF and BMP ──────────────────────────────────────────────────────────────────────────── */

test("a GIF reports transparency from its graphic control extension", async () => {
  assert.deepEqual(
    await probe(gif({ width: 120, height: 90, transparent: true }), "gif"),
    { width: 120, height: 90, hasAlphaChannel: true }
  );
  assert.equal(
    (await probe(gif({ width: 120, height: 90, transparent: false }), "gif")).hasAlphaChannel,
    false
  );
});

test("a 32-bit BMP carries alpha; a 24-bit one does not", async () => {
  assert.equal((await probe(bmp({ width: 10, height: 10, bitCount: 32 }), "bmp")).hasAlphaChannel, true);
  assert.equal((await probe(bmp({ width: 10, height: 10, bitCount: 24 }), "bmp")).hasAlphaChannel, false);
});

/** A top-down BMP states a negative height. The magnitude is the height either way. */
test("a top-down BMP reports a positive height", async () => {
  assert.equal((await probe(bmp({ width: 10, height: -40, bitCount: 24 }), "bmp")).height, 40);
});

/* ── Refusals ─────────────────────────────────────────────────────────────────────────────── */

/**
 * Nothing is guessed. A width of 0 or an invented `hasAlphaChannel: false` would be stated as fact
 * by the panel, and an operator would believe it.
 */
test("an unreadable file answers null rather than a plausible default", async () => {
  for (const [bytes, extension] of [
    [Buffer.from("not an image at all"), "png"],
    [Buffer.alloc(0), "png"],
    [Buffer.from([0x89, 0x50, 0x4e, 0x47]), "png"],   // truncated PNG signature, no IHDR
    [Buffer.from([0xff, 0xd8, 0xff]), "jpg"]           // JPEG that stops before any frame header
  ]) {
    assert.deepEqual(
      await probe(bytes, extension),
      { width: null, height: null, hasAlphaChannel: null },
      `${extension} fixture of ${bytes.length} bytes must not be guessed at`
    );
  }
});

test("a file that does not exist is not an exception", async () => {
  assert.deepEqual(
    await probeImageFile(path.join(root, "absent.png"), 10, 1),
    { width: null, height: null, hasAlphaChannel: null }
  );
});

/* ── Caching ──────────────────────────────────────────────────────────────────────────────── */

/**
 * A scan runs on every panel mount and window focus, so an unchanged folder must cost no I/O. The
 * key carries size and mtime as well as the path, because a file replaced in place is deliberately
 * the same reference and its geometry may have changed completely.
 */
test("a replaced file is re-read; an unchanged one is not", async () => {
  clearImageProbeCache();
  const file = path.join(root, "replaced.png");
  await writeFile(file, png({ width: 100, height: 100, colorType: 2 }));

  const first = await probeImageFile(file, 1, 1000);
  assert.equal(first.width, 100);

  // Same key, different bytes on disk: the cached answer stands, which is the point.
  await writeFile(file, png({ width: 200, height: 200, colorType: 6 }));
  assert.equal((await probeImageFile(file, 1, 1000)).width, 100, "an unchanged key must not re-read");

  // A new mtime is a new key, and the new geometry is found.
  const second = await probeImageFile(file, 2, 2000);
  assert.equal(second.width, 200);
  assert.equal(second.hasAlphaChannel, true);
});
