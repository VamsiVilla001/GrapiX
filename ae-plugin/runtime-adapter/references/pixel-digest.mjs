#!/usr/bin/env node
// Digest and describe the *pixels* of a baseline TIFF, never the file.
//
// AE-F0's gate asks for byte-for-byte equality against an independently exported reference. A
// file-level SHA-256 cannot express that: After Effects embeds per-render XMP metadata, so three
// renders of one unchanged frame produced three different file digests over byte-identical pixels
// (measured — see certification/AE-F0-references.json). Comparing files would report a pixel
// defect that does not exist, and a reviewer chasing it would be chasing a timestamp.
//
// So the comparable unit is the decoded strip payload plus the format facts that give it meaning:
// dimensions, bit depth, sample count, and the alpha association the container claims.
//
// Usage: node pixel-digest.mjs <file.tif> [...]   → one JSON object per file on stdout.

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename } from "node:path";

const ALPHA_ASSOCIATION = {
  0: "unspecified",
  1: "premultiplied",
  2: "straight",
};

/** Minimal baseline-TIFF reader: only the tags that decide what a pixel means. */
function readTiff(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const order = view.getUint16(0, true);
  const little = order === 0x4949;
  if (!little && order !== 0x4d4d) throw new Error("not a TIFF: bad byte-order mark");
  const u16 = (offset) => view.getUint16(offset, little);
  const u32 = (offset) => view.getUint32(offset, little);
  if (u16(2) !== 42) throw new Error("not a TIFF: bad magic");

  const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };
  const ifd = u32(4);
  const entryCount = u16(ifd);
  const tags = new Map();

  for (let index = 0; index < entryCount; index += 1) {
    const entry = ifd + 2 + index * 12;
    const tag = u16(entry);
    const type = u16(entry + 2);
    const count = u32(entry + 4);
    const inline = (TYPE_SIZE[type] ?? 1) * count <= 4;
    const base = inline ? entry + 8 : u32(entry + 8);
    const values = [];
    for (let i = 0; i < count && i < 64; i += 1) {
      if (type === 3) values.push(u16(base + i * 2));
      else if (type === 4) values.push(u32(base + i * 4));
      else if (type === 1 || type === 2 || type === 6 || type === 7) values.push(bytes[base + i]);
    }
    tags.set(tag, values);
  }

  const first = (tag) => tags.get(tag)?.[0];
  const compression = first(259) ?? 1;
  if (compression !== 1) {
    throw new Error(`compression ${compression} is not supported; the reference must be uncompressed`);
  }
  // Strips are concatenated in file order, so a multi-strip image still hashes as one payload.
  const offsets = tags.get(273) ?? [];
  const counts = tags.get(279) ?? [];
  if (offsets.length === 0 || offsets.length !== counts.length) {
    throw new Error("missing or mismatched StripOffsets/StripByteCounts");
  }

  return {
    width: first(256),
    height: first(257),
    bitsPerSample: tags.get(258) ?? [],
    samplesPerPixel: first(277),
    photometric: first(262),
    planarConfiguration: first(284) ?? 1,
    extraSamples: tags.get(338) ?? [],
    software: (tags.get(305) ?? []).map((c) => String.fromCharCode(c)).join("").replace(/\0/g, ""),
    strips: offsets.map((offset, i) => ({ offset, bytes: counts[i] })),
  };
}

let failed = false;

for (const file of process.argv.slice(2)) {
  try {
    const bytes = readFileSync(file);
    const tiff = readTiff(bytes);

    const pixels = createHash("sha256");
    let payloadBytes = 0;
    for (const strip of tiff.strips) {
      pixels.update(bytes.subarray(strip.offset, strip.offset + strip.bytes));
      payloadBytes += strip.bytes;
    }

    const expected = (tiff.width ?? 0) * (tiff.height ?? 0) * (tiff.samplesPerPixel ?? 0);
    const declared = tiff.extraSamples.length > 0
      ? (ALPHA_ASSOCIATION[tiff.extraSamples[0]] ?? `unknown(${tiff.extraSamples[0]})`)
      : "absent";

    console.log(JSON.stringify({
      file: basename(file),
      fileBytes: bytes.length,
      fileSha256: createHash("sha256").update(bytes).digest("hex"),
      pixelSha256: pixels.digest("hex"),
      payloadBytes,
      width: tiff.width,
      height: tiff.height,
      bitsPerSample: tiff.bitsPerSample,
      samplesPerPixel: tiff.samplesPerPixel,
      photometricInterpretation: tiff.photometric,
      planarConfiguration: tiff.planarConfiguration,
      // What the container claims about alpha — which for After Effects output is nothing at all.
      declaredAlphaAssociation: declared,
      software: tiff.software,
      payloadMatchesGeometry: payloadBytes === expected,
    }));
  } catch (error) {
    console.error(`${basename(file)}: ${error.message}`);
    failed = true;
  }
}

process.exit(failed ? 1 : 0);
