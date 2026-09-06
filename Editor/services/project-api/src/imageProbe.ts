/**
 * What an image file says about itself, read from its header.
 *
 * The Material Manager lists a project's asset folders, and until now a reference carried only what
 * the directory entry knows: a name and a size. An author choosing between two logos cannot see
 * which one is 4K, and — the one that actually costs a show — cannot see which one has an alpha
 * channel. A key that arrives on air as an opaque black rectangle is found at exactly the wrong
 * moment.
 *
 * ## Header, not decode
 *
 * Every answer here comes from the first few hundred bytes of the file. Decoding a folder of 4K
 * plates to learn their dimensions would cost seconds and hundreds of megabytes for information the
 * format states in its first chunk. The cost is that `hasAlphaChannel` means "the format carries an
 * alpha channel", not "some pixel is actually transparent" — a fully opaque RGBA PNG reports `true`.
 * That distinction is honest and it is the one the field is named for; the Editor refines it to real
 * per-pixel transparency when it decodes the image for a thumbnail.
 *
 * ## What is not guessed
 *
 * A format this cannot parse returns `null` for every field rather than a plausible default. A
 * width of 0 or a `hasAlphaChannel: false` invented for an unreadable file is worse than an absent
 * answer: the panel would state it as fact, and an operator would believe it.
 */

import { open } from "node:fs/promises";

export interface ImageProbe {
  width: number | null;
  height: number | null;
  /** Whether the format carries an alpha channel. `null` when the format could not be read. */
  hasAlphaChannel: boolean | null;
}

const UNKNOWN: ImageProbe = { width: null, height: null, hasAlphaChannel: null };

/**
 * How much of the file to read.
 *
 * PNG states its geometry in the first 33 bytes, JPEG within the first frame header, WebP in its
 * first 30. The generous bound exists for JPEGs that carry a large EXIF thumbnail before their
 * `SOF` marker; past this the answer is simply unknown rather than a longer read of every file in a
 * project.
 */
const HEADER_BYTES = 64 * 1024;

/**
 * Probed results, keyed on identity *and* content.
 *
 * A scan runs on every panel mount and window focus, so re-reading every header each time would
 * make browsing a large project an I/O loop. Size and mtime are in the key rather than just the
 * path: a file replaced in place is the same reference deliberately, and its geometry may have
 * changed completely. This is the same pair the content route uses for its etag, so the cache and
 * the browser invalidate together.
 */
const probeCache = new Map<string, ImageProbe>();

/**
 * Bounded so a long-lived service browsing many projects cannot grow this without limit. Dropping
 * the oldest entry costs one header read the next time it is asked for.
 */
const PROBE_CACHE_LIMIT = 4096;

function remember(key: string, probe: ImageProbe): ImageProbe {
  if (probeCache.size >= PROBE_CACHE_LIMIT) {
    const oldest = probeCache.keys().next();
    if (!oldest.done) probeCache.delete(oldest.value);
  }
  probeCache.set(key, probe);
  return probe;
}

/** Read at most `HEADER_BYTES` from the front of a file. */
async function readHeader(filePath: string): Promise<Buffer | null> {
  let handle;
  try {
    handle = await open(filePath, "r");
    const buffer = Buffer.alloc(HEADER_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEADER_BYTES, 0);
    return buffer.subarray(0, bytesRead);
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * PNG: `IHDR` is always the first chunk, at a fixed offset.
 *
 * Colour types 4 (grey+alpha) and 6 (RGBA) carry alpha in every pixel. Types 0 and 3 can still be
 * transparent through a `tRNS` chunk — a palette PNG with one transparent index is the classic
 * logo-on-transparent export — so the chunk list is walked for it rather than reporting those as
 * opaque.
 */
function probePng(header: Buffer): ImageProbe {
  if (header.length < 33) return UNKNOWN;
  const width = header.readUInt32BE(16);
  const height = header.readUInt32BE(20);
  const colorType = header[25];
  if (colorType === 4 || colorType === 6) return { width, height, hasAlphaChannel: true };

  // Walk chunks looking for tRNS. Each is length(4) + type(4) + data + crc(4), starting at 8.
  let offset = 8;
  while (offset + 8 <= header.length) {
    const length = header.readUInt32BE(offset);
    const type = header.toString("ascii", offset + 4, offset + 8);
    if (type === "tRNS") return { width, height, hasAlphaChannel: true };
    // IDAT is the pixel data: tRNS is required to appear before it, so there is nothing further to
    // find and no reason to walk a multi-megabyte image.
    if (type === "IDAT" || type === "IEND") break;
    if (length > header.length) break;
    offset += 12 + length;
  }
  return { width, height, hasAlphaChannel: false };
}

/**
 * JPEG: walk the marker segments to the frame header.
 *
 * The geometry lives in an `SOFn` marker, which sits after any EXIF, ICC and quantisation segments —
 * so it cannot be read at a fixed offset. JPEG has no alpha channel in any baseline or progressive
 * form, which is a fact about the format rather than about this file.
 */
function probeJpeg(header: Buffer): ImageProbe {
  let offset = 2;
  while (offset + 4 <= header.length) {
    if (header[offset] !== 0xff) {
      offset += 1; // Fill byte or padding; resynchronise on the next marker.
      continue;
    }
    const marker = header[offset + 1];
    // Standalone markers carry no length: restart markers, and TEM.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = header.readUInt16BE(offset + 2);
    // SOF0..SOF15, excluding the DHT/JPG/DAC markers interleaved in that range.
    const isFrameHeader = marker >= 0xc0 && marker <= 0xcf
      && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrameHeader) {
      if (offset + 9 > header.length) return UNKNOWN;
      return {
        height: header.readUInt16BE(offset + 5),
        width: header.readUInt16BE(offset + 7),
        hasAlphaChannel: false
      };
    }
    if (length < 2) return UNKNOWN;
    offset += 2 + length;
  }
  return UNKNOWN;
}

/**
 * WebP: three encodings, three places the answer lives.
 *
 * `VP8 ` is lossy and never has alpha. `VP8L` is lossless and states alpha in a header bit. `VP8X`
 * is the extended form used for animation and for lossy-plus-alpha, and carries its own flags and a
 * 24-bit width/height minus one.
 */
function probeWebp(header: Buffer): ImageProbe {
  if (header.length < 30) return UNKNOWN;
  const format = header.toString("ascii", 12, 16);

  if (format === "VP8X") {
    const hasAlphaChannel = (header[20] & 0x10) !== 0;
    const width = 1 + (header[24] | (header[25] << 8) | (header[26] << 16));
    const height = 1 + (header[27] | (header[28] << 8) | (header[29] << 16));
    return { width, height, hasAlphaChannel };
  }

  if (format === "VP8L") {
    // 14 bits of width-1, then 14 bits of height-1, then the alpha_is_used bit.
    const bits = header.readUInt32LE(21);
    return {
      width: 1 + (bits & 0x3fff),
      height: 1 + ((bits >> 14) & 0x3fff),
      hasAlphaChannel: ((bits >> 28) & 0x01) !== 0
    };
  }

  if (format === "VP8 ") {
    return {
      width: header.readUInt16LE(26) & 0x3fff,
      height: header.readUInt16LE(28) & 0x3fff,
      hasAlphaChannel: false
    };
  }

  return UNKNOWN;
}

/** GIF: geometry is fixed-offset; transparency is a flag on a graphic control extension. */
function probeGif(header: Buffer): ImageProbe {
  if (header.length < 10) return UNKNOWN;
  const width = header.readUInt16LE(6);
  const height = header.readUInt16LE(8);

  // A graphic control extension is 21 F9 04, and its first data byte's low bit is the
  // transparent-colour flag. Scanning for the introducer is enough: the block is short and always
  // precedes the image it applies to.
  for (let offset = 13; offset + 4 < header.length; offset += 1) {
    if (header[offset] === 0x21 && header[offset + 1] === 0xf9 && header[offset + 2] === 0x04) {
      return { width, height, hasAlphaChannel: (header[offset + 3] & 0x01) !== 0 };
    }
  }
  return { width, height, hasAlphaChannel: false };
}

/** BMP: `BITMAPINFOHEADER` onwards states geometry; 32-bit forms carry an alpha byte. */
function probeBmp(header: Buffer): ImageProbe {
  if (header.length < 30) return UNKNOWN;
  return {
    width: header.readInt32LE(18),
    // Negative means a top-down bitmap. The magnitude is the height either way.
    height: Math.abs(header.readInt32LE(22)),
    hasAlphaChannel: header.readUInt16LE(28) === 32
  };
}

/** Which parser a file's magic bytes select. `null` for anything not recognised. */
function probeByMagic(header: Buffer): ImageProbe | null {
  if (header.length >= 8 && header.toString("ascii", 1, 4) === "PNG") return probePng(header);
  if (header.length >= 3 && header[0] === 0xff && header[1] === 0xd8) return probeJpeg(header);
  if (
    header.length >= 12
    && header.toString("ascii", 0, 4) === "RIFF"
    && header.toString("ascii", 8, 12) === "WEBP"
  ) return probeWebp(header);
  if (header.length >= 6 && header.toString("ascii", 0, 3) === "GIF") return probeGif(header);
  if (header.length >= 2 && header[0] === 0x42 && header[1] === 0x4d) return probeBmp(header);
  return null;
}

/**
 * Probe one image file.
 *
 * `sizeBytes` and `modifiedMs` are the cache key's content half and come from the directory entry
 * the caller already has — this never stats the file itself, so a scan costs one read per *changed*
 * file rather than one per file.
 */
export async function probeImageFile(
  filePath: string,
  sizeBytes: number,
  modifiedMs: number
): Promise<ImageProbe> {
  const key = `${filePath}|${sizeBytes}|${Math.trunc(modifiedMs)}`;
  const cached = probeCache.get(key);
  if (cached) return cached;

  const header = await readHeader(filePath);
  if (!header || header.length === 0) return remember(key, UNKNOWN);
  return remember(key, probeByMagic(header) ?? UNKNOWN);
}

/** Drop every cached probe. For tests, and for a project close. */
export function clearImageProbeCache(): void {
  probeCache.clear();
}
