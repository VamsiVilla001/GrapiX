/**
 * RIFX container reader — the binary layer of an After Effects `.aep`.
 *
 * An `.aep` is a RIFX file: RIFF with big-endian integers, form type `Egg!`. This module reads
 * the container and nothing else; every field meaning lives in `aepParser.ts`. Splitting them
 * matters because the container is the one part of the format that is genuinely specified
 * (RIFF, 1991) while the chunk payloads are reverse-engineered — a bug in the tree walk would
 * otherwise be indistinguishable from a bug in a field offset.
 *
 * Three rules the format demands and a naive RIFF reader gets wrong:
 *
 * 1. **An odd-sized chunk is followed by one pad byte** that is not counted in its size. Miss it
 *    and every following chunk is read one byte short, which looks like corrupt data rather than
 *    a reader bug.
 * 2. **`LIST btdk` is not a LIST.** It carries a COS (PDF-syntax) text document whose bytes
 *    contain `LIST`-looking sequences. Recursing into it produces garbage chunks, so its payload
 *    is kept raw for the COS parser.
 * 3. **The file is longer than the RIFX size declares.** After Effects appends XMP metadata after
 *    the RIFX data, so the walk must stop at the declared end, not at the end of the buffer.
 *
 * The reader never throws on a malformed interior: a chunk whose size runs past its parent stops
 * that level and sets `truncated`, so a partially readable project still yields the items it did
 * read. A file that is not RIFX/`Egg!` at all is a different thing — that throws, because
 * guessing at a non-AEP file is worse than refusing it.
 */

const FOURCC_LENGTH = 4;
const CHUNK_HEADER_LENGTH = 8;

/** A leaf chunk: a four-character type and its raw payload. */
export interface RifxChunk {
  kind: "chunk";
  type: string;
  data: Uint8Array;
}

/**
 * A `LIST` chunk: a four-character list id and its children.
 *
 * `raw` is set instead of `children` for lists whose payload is not RIFF-structured (`btdk`).
 */
export interface RifxList {
  kind: "list";
  id: string;
  children: RifxNode[];
  raw?: Uint8Array;
}

export type RifxNode = RifxChunk | RifxList;

export interface RifxFile {
  /** Form type; `Egg!` for an After Effects project. */
  form: string;
  children: RifxNode[];
  /** True when a chunk declared a size past its container and the walk stopped early. */
  truncated: boolean;
}

export class RifxFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RifxFormatError";
  }
}

/** List ids whose payload is opaque: not RIFF, must not be recursed into. */
const OPAQUE_LISTS: Record<string, true> = { btdk: true };

const ascii = (bytes: Uint8Array, offset: number, length: number): string => {
  let out = "";
  for (let index = 0; index < length; index += 1) out += String.fromCharCode(bytes[offset + index] ?? 0);
  return out;
};

/**
 * Read a RIFX buffer into a chunk tree.
 *
 * @throws RifxFormatError when the buffer does not start with a RIFX header.
 */
export function parseRifx(bytes: Uint8Array): RifxFile {
  if (bytes.length < 12) {
    throw new RifxFormatError(`not a RIFX file: ${bytes.length} bytes is shorter than a RIFX header`);
  }
  const magic = ascii(bytes, 0, 4);
  if (magic !== "RIFX") {
    // RIFF (little-endian) is the same container with the other byte order; AE never writes it,
    // and reading it as big-endian would yield absurd chunk sizes, so name what was found.
    throw new RifxFormatError(`not a RIFX file: expected the magic "RIFX", found ${JSON.stringify(magic)}`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const declared = view.getUint32(4, false);
  // The declared size covers the form type and every chunk, but not the 8-byte header itself.
  const end = Math.min(CHUNK_HEADER_LENGTH + declared, bytes.length);
  const form = ascii(bytes, 8, 4);
  const state = { truncated: false };
  const children = readChunks(bytes, view, 12, end, state);
  return { form, children, truncated: state.truncated };
}

function readChunks(
  bytes: Uint8Array,
  view: DataView,
  start: number,
  end: number,
  state: { truncated: boolean }
): RifxNode[] {
  const nodes: RifxNode[] = [];
  let cursor = start;
  while (cursor + CHUNK_HEADER_LENGTH <= end) {
    const type = ascii(bytes, cursor, 4);
    const size = view.getUint32(cursor + 4, false);
    const dataStart = cursor + CHUNK_HEADER_LENGTH;
    const dataEnd = dataStart + size;
    if (dataEnd > end) {
      // A size past the container means the tree is not trustworthy from here on. Stop this
      // level rather than reading into the next chunk's header.
      state.truncated = true;
      break;
    }
    if (type === "LIST") {
      const id = ascii(bytes, dataStart, FOURCC_LENGTH);
      const bodyStart = dataStart + FOURCC_LENGTH;
      nodes.push(
        OPAQUE_LISTS[id]
          ? { kind: "list", id, children: [], raw: bytes.subarray(bodyStart, dataEnd) }
          : { kind: "list", id, children: readChunks(bytes, view, bodyStart, dataEnd, state) }
      );
    } else {
      nodes.push({ kind: "chunk", type, data: bytes.subarray(dataStart, dataEnd) });
    }
    cursor = dataEnd + (size % 2);
  }
  return nodes;
}

// ---------------------------------------------------------------------------
// Tree navigation
//
// Every lookup is "the first/all matching child", never "the child at index N": After Effects
// inserts chunks between versions, so positional reads break on the next release.
// ---------------------------------------------------------------------------

export const isList = (node: RifxNode): node is RifxList => node.kind === "list";
export const isChunk = (node: RifxNode): node is RifxChunk => node.kind === "chunk";

export function findChunk(nodes: RifxNode[], type: string): RifxChunk | undefined {
  for (const node of nodes) if (node.kind === "chunk" && node.type === type) return node;
  return undefined;
}

export function findChunks(nodes: RifxNode[], type: string): RifxChunk[] {
  return nodes.filter((node): node is RifxChunk => node.kind === "chunk" && node.type === type);
}

export function findList(nodes: RifxNode[], id: string): RifxList | undefined {
  for (const node of nodes) if (node.kind === "list" && node.id === id) return node;
  return undefined;
}

export function findLists(nodes: RifxNode[], id: string): RifxList[] {
  return nodes.filter((node): node is RifxList => node.kind === "list" && node.id === id);
}

/**
 * The children of every `LIST <id>` at this level, concatenated.
 *
 * A layer's properties arrive as several sibling `tdgp` lists rather than one, so a merged view
 * is what "this layer's property groups" actually means.
 */
export function mergeLists(nodes: RifxNode[], id: string): RifxNode[] {
  const merged: RifxNode[] = [];
  for (const list of findLists(nodes, id)) merged.push(...list.children);
  return merged;
}

/** Depth-first search for the first list with this id, at any depth. */
export function findListDeep(nodes: RifxNode[], id: string): RifxList | undefined {
  for (const node of nodes) {
    if (node.kind !== "list") continue;
    if (node.id === id) return node;
    const nested = findListDeep(node.children, id);
    if (nested) return nested;
  }
  return undefined;
}

const utf8 = new TextDecoder("utf-8");

const trimNul = (value: string): string => {
  const nul = value.indexOf("\u0000");
  return nul === -1 ? value : value.slice(0, nul);
};

/**
 * Decode a text chunk's payload.
 *
 * Three shapes occur and all three are this function's problem:
 * - a bare UTF-8 payload (`Utf8`),
 * - a NUL-terminated string with junk after the NUL, left over from renaming something to a
 *   shorter name — everything after the first NUL is dropped,
 * - a wrapper chunk (`tdsn`, `fnam`, `pdnm`) holding an embedded `Utf8` chunk with its own
 *   4-byte length, which is unwrapped here so callers never care which they were handed.
 */
export function chunkText(chunk: RifxChunk | undefined): string {
  if (!chunk) return "";
  let data = chunk.data;
  if (data.length >= CHUNK_HEADER_LENGTH && ascii(data, 0, 4).toLowerCase() === "utf8") {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const length = view.getUint32(4, false);
    if (CHUNK_HEADER_LENGTH + length <= data.length) {
      data = data.subarray(CHUNK_HEADER_LENGTH, CHUNK_HEADER_LENGTH + length);
    }
  }
  return trimNul(utf8.decode(data));
}

/** A fixed-width NUL-terminated string embedded in a binary chunk. */
export function fixedString(data: Uint8Array, offset: number, length: number): string {
  const available = Math.max(0, Math.min(length, data.length - offset));
  return trimNul(utf8.decode(data.subarray(offset, offset + available)));
}

/** A view over a chunk payload that answers "is this field even present?" instead of throwing. */
export class ChunkReader {
  private readonly view: DataView;

  constructor(readonly data: Uint8Array) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  has(offset: number, size: number): boolean {
    return offset >= 0 && offset + size <= this.data.length;
  }

  u8(offset: number): number {
    return this.has(offset, 1) ? this.data[offset] : 0;
  }

  u16(offset: number): number {
    return this.has(offset, 2) ? this.view.getUint16(offset, false) : 0;
  }

  u32(offset: number): number {
    return this.has(offset, 4) ? this.view.getUint32(offset, false) : 0;
  }

  s16(offset: number): number {
    return this.has(offset, 2) ? this.view.getInt16(offset, false) : 0;
  }

  s32(offset: number): number {
    return this.has(offset, 4) ? this.view.getInt32(offset, false) : 0;
  }

  f32(offset: number): number {
    return this.has(offset, 4) ? this.view.getFloat32(offset, false) : 0;
  }

  f64(offset: number): number {
    return this.has(offset, 8) ? this.view.getFloat64(offset, false) : 0;
  }

  /** `count` big-endian float64s from `offset`; short data yields a short array, never a throw. */
  f64Array(offset: number, count: number): number[] {
    const values: number[] = [];
    for (let index = 0; index < count; index += 1) {
      const at = offset + index * 8;
      if (!this.has(at, 8)) break;
      values.push(this.view.getFloat64(at, false));
    }
    return values;
  }

  /** Bit `bit` of the byte at `offset`, counting bit 0 as least significant. */
  bit(offset: number, bit: number): boolean {
    return ((this.u8(offset) >> bit) & 1) === 1;
  }

  /**
   * A rational stored as adjacent dividend/divisor words, in the unit the caller expects.
   *
   * After Effects stores every time and ratio this way. A zero divisor is not a rounding
   * problem to paper over — it means the field was not written — so it reads as 0.
   */
  ratio(dividendOffset: number, divisorOffset: number, signed = true): number {
    const dividend = signed ? this.s32(dividendOffset) : this.u32(dividendOffset);
    const divisor = this.u32(divisorOffset);
    return divisor === 0 ? 0 : dividend / divisor;
  }
}
