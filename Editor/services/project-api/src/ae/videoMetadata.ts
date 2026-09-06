/**
 * Read a movie's frame size out of its container, without decoding it.
 *
 * An imported After Effects layer needs the footage's intrinsic size or its anchor lands in the
 * wrong place — the same rule that governs stills. A still can be measured by handing it to the
 * canvas; a movie cannot, and no frame decoder ships with the service. The size is, however,
 * written in plain fixed-point in the MP4 track header, so it is read from there.
 *
 * Deliberately narrow: this answers "how big is the picture" and nothing else. It is not a
 * demuxer, it does not decode, and a container it does not understand returns `null` so the caller
 * falls back rather than guessing.
 */

/** One ISO-BMFF box: a 32-bit size, a four-character type, then the payload. */
interface Mp4Box {
  type: string;
  start: number;
  end: number;
}

/**
 * Walk the boxes directly inside `[start, end)`.
 *
 * Size 0 means "to the end of the file" and size 1 means a 64-bit length follows the type; both are
 * handled because a large movie routinely uses the extended form.
 */
function* boxesIn(bytes: Buffer, start: number, end: number): Generator<Mp4Box> {
  let offset = start;
  while (offset + 8 <= end) {
    let size = bytes.readUInt32BE(offset);
    const type = bytes.toString("latin1", offset + 4, offset + 8);
    let payload = offset + 8;

    if (size === 1) {
      if (offset + 16 > end) return;
      // A 64-bit size; anything beyond 2^53 is not a real file and would lose precision here.
      const high = bytes.readUInt32BE(offset + 8);
      const low = bytes.readUInt32BE(offset + 12);
      size = high * 2 ** 32 + low;
      payload = offset + 16;
    } else if (size === 0) {
      size = end - offset;
    }

    if (size < 8 || offset + size > end) return;
    yield { type, start: payload, end: offset + size };
    offset += size;
  }
}

/** 16.16 fixed point, as the track header stores width and height. */
function fixed1616(bytes: Buffer, offset: number): number {
  return bytes.readUInt32BE(offset) / 65_536;
}

/**
 * The display size of the first track that has one.
 *
 * Audio tracks carry a `tkhd` too, with width and height of zero, so the first non-zero track is
 * the picture. `tkhd` is versioned: the v1 header widens three timestamps, which moves everything
 * after them, so the offsets are computed from the version rather than assumed.
 */
export function readMp4Dimensions(bytes: Buffer): { width: number; height: number } | null {
  const fileEnd = bytes.length;

  for (const top of boxesIn(bytes, 0, fileEnd)) {
    if (top.type !== "moov") continue;
    for (const moovChild of boxesIn(bytes, top.start, top.end)) {
      if (moovChild.type !== "trak") continue;
      for (const trakChild of boxesIn(bytes, moovChild.start, moovChild.end)) {
        if (trakChild.type !== "tkhd") continue;

        const version = bytes[trakChild.start];
        // After version+flags: v0 carries creation(4) modification(4) trackID(4) reserved(4)
        // duration(4) = 20 bytes; v1 widens the three times to 8+8+4+4+8 = 32.
        const afterTiming = trakChild.start + 4 + (version === 1 ? 32 : 20);
        // Then reserved(8) layer(2) alternate_group(2) volume(2) reserved(2), then a 36-byte matrix.
        const dimensionsAt = afterTiming + 16 + 36;
        if (dimensionsAt + 8 > trakChild.end) continue;

        const width = Math.round(fixed1616(bytes, dimensionsAt));
        const height = Math.round(fixed1616(bytes, dimensionsAt + 4));
        if (width > 0 && height > 0) return { width, height };
      }
    }
  }
  return null;
}

/**
 * The video codec fourcc of the first picture track, whitespace-trimmed.
 *
 * Returned as the fourcc (`avc1`, `hev1`, `png`, `ap4h`, ...) or `null` when there is no video
 * track. This is what lets an import decide cheaply — from the header, before any decode — whether
 * a movie is a plain H.264 the browser plays directly or an alpha-carrying QuickTime that has to be
 * transcoded. `tmcd` (timecode) is not a picture and is skipped.
 */
export function readMp4VideoCodec(bytes: Buffer): string | null {
  const fileEnd = bytes.length;
  for (const top of boxesIn(bytes, 0, fileEnd)) {
    if (top.type !== "moov") continue;
    for (const moovChild of boxesIn(bytes, top.start, top.end)) {
      if (moovChild.type !== "trak") continue;
      for (const mdia of boxesIn(bytes, moovChild.start, moovChild.end)) {
        if (mdia.type !== "mdia") continue;
        for (const minf of boxesIn(bytes, mdia.start, mdia.end)) {
          if (minf.type !== "minf") continue;
          for (const stbl of boxesIn(bytes, minf.start, minf.end)) {
            if (stbl.type !== "stbl") continue;
            for (const stsd of boxesIn(bytes, stbl.start, stbl.end)) {
              if (stsd.type !== "stsd") continue;
              const entryCount = stsd.start + 8 <= stsd.end ? bytes.readUInt32BE(stsd.start + 4) : 0;
              for (let index = 0; index < entryCount; index += 1) {
                const entryAt = stsd.start + 8 + index * 8;
                if (entryAt + 8 > stsd.end) break;
                const fourcc = bytes.toString("latin1", entryAt + 4, entryAt + 8).trim();
                if (fourcc && fourcc !== "tmcd") return fourcc;
              }
            }
          }
        }
      }
    }
  }
  return null;
}
