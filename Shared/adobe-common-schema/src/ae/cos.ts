/**
 * COS reader — the text document inside an After Effects `.aep`.
 *
 * A text layer's content does not live in the chunk tree like every other property. It lives in
 * the `btdk` chunk as a COS document: Adobe's Carousel Object Structure, the object syntax PDF is
 * built from (`<< /key value >>` dictionaries, `[ ... ]` arrays, `(...)` strings, `/name`s).
 * Keys are decimal strings, so the document reads as an unlabelled tree and the interesting
 * paths have to be named — that is what `readTextDocument` is for.
 *
 * What the shape looks like, from an AE-authored file:
 *
 * ```
 * /0 <<                       document resources
 *   /1 /0 [ ... ]             font list: each entry's /0 /0 /0 is a PostScript name
 * >>
 * /1 <<
 *   /1 [ <<                   one entry per keyframe of the Source Text property
 *     /0 <<
 *       /0 (text)             the characters, CR-separated lines
 *       /5 /0 [ runs ]        paragraph runs: each { /0 /0 /5: style, /1: length }
 *       /6 /0 [ runs ]        character runs: each { /0 /0 /6: style, /1: length }
 *     >>
 *   >> ]
 * >>
 * ```
 *
 * Only the first run of each kind is read. A layer whose characters carry more than one style
 * cannot be represented by GrapiX's one-style-per-object text model, so the extra runs are
 * reported as a warning instead of being silently flattened to the first style — a
 * two-colour title arriving as one colour with no explanation is the failure this avoids.
 *
 * Values whose key is not established are left absent rather than guessed. That is why leading,
 * baseline shift and stroke width are missing here: the manifest contract reads absence as "not
 * readable", and inventing a stroke would put a black outline on a title that has none.
 */

/** A parsed COS value. Dictionaries are plain objects keyed by their decimal-string keys. */
export type CosValue = string | number | boolean | null | CosName | CosValue[] | CosDict;
export interface CosDict {
  [key: string]: CosValue | undefined;
}
/** A `/name` used as a value, e.g. `/CoolTypeFont`. Distinct from a dictionary key. */
export interface CosName {
  cosName: string;
}

/**
 * Parse a COS document.
 *
 * The top level of a `btdk` payload is a dictionary body without the enclosing `<< >>`, so a
 * leading key is read as the start of a dictionary.
 */
export function parseCos(bytes: Uint8Array): CosValue {
  return new CosParser(bytes).parseDocument();
}

const CHAR = {
  lf: 0x0a,
  cr: 0x0d,
  tab: 0x09,
  nul: 0x00,
  formFeed: 0x0c,
  space: 0x20,
  percent: 0x25,
  lparen: 0x28,
  rparen: 0x29,
  slash: 0x2f,
  lt: 0x3c,
  gt: 0x3e,
  lbracket: 0x5b,
  rbracket: 0x5d,
  backslash: 0x5c,
  zero: 0x30,
  seven: 0x37
} as const;

/** Escape sequences COS shares with PDF: `\n`, `\r`, `\t`, `\b`, `\f`. */
const STRING_ESCAPES: Record<string, number> = { n: 0x0a, r: 0x0d, t: 0x09, b: 0x08, f: 0x0c };

const latin1 = new TextDecoder("latin1");
const utf16be = new TextDecoder("utf-16be");

class CosParser {
  private cursor = 0;

  constructor(private readonly bytes: Uint8Array) {}

  parseDocument(): CosValue {
    this.skipBlanks();
    // A bare dictionary body (the `btdk` case) starts with a key; anything else is a lone value.
    return this.bytes[this.cursor] === CHAR.slash ? this.readDictBody() : this.readValue();
  }

  private skipBlanks(): void {
    for (;;) {
      while (this.cursor < this.bytes.length && this.isBlank(this.bytes[this.cursor])) this.cursor += 1;
      if (this.bytes[this.cursor] !== CHAR.percent) return;
      while (this.cursor < this.bytes.length && this.bytes[this.cursor] !== CHAR.lf && this.bytes[this.cursor] !== CHAR.cr) {
        this.cursor += 1;
      }
    }
  }

  private isBlank(code: number): boolean {
    return (
      code === CHAR.space ||
      code === CHAR.lf ||
      code === CHAR.cr ||
      code === CHAR.tab ||
      code === CHAR.nul ||
      code === CHAR.formFeed
    );
  }

  private isDelimiter(code: number): boolean {
    return (
      code === CHAR.lparen ||
      code === CHAR.rparen ||
      code === CHAR.lt ||
      code === CHAR.gt ||
      code === CHAR.lbracket ||
      code === CHAR.rbracket ||
      code === CHAR.slash ||
      code === CHAR.percent
    );
  }

  private readToken(): string {
    const start = this.cursor;
    while (
      this.cursor < this.bytes.length &&
      !this.isBlank(this.bytes[this.cursor]) &&
      !this.isDelimiter(this.bytes[this.cursor])
    ) {
      this.cursor += 1;
    }
    return latin1.decode(this.bytes.subarray(start, this.cursor));
  }

  private readValue(): CosValue {
    this.skipBlanks();
    if (this.cursor >= this.bytes.length) return null;
    const code = this.bytes[this.cursor];
    if (code === CHAR.lt) {
      if (this.bytes[this.cursor + 1] === CHAR.lt) {
        this.cursor += 2;
        return this.readDictBody();
      }
      return this.readHexString();
    }
    if (code === CHAR.lparen) return this.readLiteralString();
    if (code === CHAR.lbracket) {
      this.cursor += 1;
      return this.readArrayBody();
    }
    if (code === CHAR.slash) {
      this.cursor += 1;
      return { cosName: this.readToken() };
    }
    const token = this.readToken();
    if (token === "true") return true;
    if (token === "false") return false;
    // AE writes `/nil` for an absent object and bare `null` for an absent value; both are absent.
    if (token === "null" || token === "nil") return null;
    if (token === "") {
      // An unexpected delimiter: consume it so the caller cannot spin.
      this.cursor += 1;
      return null;
    }
    const numeric = Number(token);
    return Number.isNaN(numeric) ? { cosName: token } : numeric;
  }

  private readDictBody(): CosDict {
    const dict: CosDict = {};
    for (;;) {
      this.skipBlanks();
      if (this.cursor >= this.bytes.length) break;
      if (this.bytes[this.cursor] === CHAR.gt && this.bytes[this.cursor + 1] === CHAR.gt) {
        this.cursor += 2;
        break;
      }
      if (this.bytes[this.cursor] !== CHAR.slash) {
        // Not a key: skip one value so a malformed dictionary degrades instead of looping.
        this.readValue();
        continue;
      }
      this.cursor += 1;
      const key = this.readToken();
      dict[key] = this.readValue();
    }
    return dict;
  }

  private readArrayBody(): CosValue[] {
    const values: CosValue[] = [];
    for (;;) {
      this.skipBlanks();
      if (this.cursor >= this.bytes.length) break;
      if (this.bytes[this.cursor] === CHAR.rbracket) {
        this.cursor += 1;
        break;
      }
      values.push(this.readValue());
    }
    return values;
  }

  /**
   * A `( ... )` literal, which may nest parentheses and carry backslash escapes.
   *
   * After Effects writes visible text as UTF-16BE with a byte-order mark and flag strings as
   * plain bytes, and nothing in the syntax distinguishes them — the BOM is the only signal, so
   * decoding is decided per string.
   */
  private readLiteralString(): string {
    this.cursor += 1;
    const out: number[] = [];
    let depth = 1;
    while (this.cursor < this.bytes.length) {
      const code = this.bytes[this.cursor];
      if (code === CHAR.backslash) {
        const next = this.bytes[this.cursor + 1];
        this.cursor += 2;
        const escape = STRING_ESCAPES[String.fromCharCode(next)];
        if (escape !== undefined) {
          out.push(escape);
        } else if (next >= CHAR.zero && next <= CHAR.seven) {
          let octal = next - CHAR.zero;
          for (let digits = 1; digits < 3; digits += 1) {
            const digit = this.bytes[this.cursor];
            if (digit === undefined || digit < CHAR.zero || digit > CHAR.seven) break;
            octal = octal * 8 + (digit - CHAR.zero);
            this.cursor += 1;
          }
          out.push(octal & 0xff);
        } else if (next !== CHAR.lf) {
          // A backslash before a newline is a line continuation and contributes nothing.
          out.push(next);
        }
        continue;
      }
      if (code === CHAR.lparen) depth += 1;
      if (code === CHAR.rparen) {
        depth -= 1;
        if (depth === 0) {
          this.cursor += 1;
          break;
        }
      }
      out.push(code);
      this.cursor += 1;
    }
    return decodeCosBytes(Uint8Array.from(out));
  }

  private readHexString(): string {
    this.cursor += 1;
    const out: number[] = [];
    let high: number | undefined;
    while (this.cursor < this.bytes.length && this.bytes[this.cursor] !== CHAR.gt) {
      const digit = Number.parseInt(String.fromCharCode(this.bytes[this.cursor]), 16);
      this.cursor += 1;
      if (Number.isNaN(digit)) continue;
      if (high === undefined) high = digit;
      else {
        out.push(high * 16 + digit);
        high = undefined;
      }
    }
    // An odd digit count means the last nibble is the high half of its byte.
    if (high !== undefined) out.push(high * 16);
    this.cursor += 1;
    return decodeCosBytes(Uint8Array.from(out));
  }
}

function decodeCosBytes(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return utf16be.decode(bytes.subarray(2));
  return latin1.decode(bytes);
}

// ---------------------------------------------------------------------------
// The text document
// ---------------------------------------------------------------------------

const asDict = (value: CosValue | undefined): CosDict | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) && !("cosName" in value)
    ? (value as CosDict)
    : undefined;

/** Follow a path of dictionary keys and array indices, answering `undefined` at the first miss. */
function cosGet(root: CosValue | undefined, ...path: (string | number)[]): CosValue | undefined {
  let current: CosValue | undefined = root;
  for (const step of path) {
    if (current === undefined || current === null) return undefined;
    if (Array.isArray(current)) {
      current = typeof step === "number" ? current[step] : current[Number(step)];
      continue;
    }
    const dict = asDict(current);
    if (!dict) return undefined;
    current = dict[String(step)];
  }
  return current ?? undefined;
}

/** COS paragraph justification: 0-based from LEFT_JUSTIFY (AE's ParagraphJustification 7413). */
const JUSTIFICATION: Record<number, "left" | "center" | "right" | "justify"> = {
  0: "left",
  1: "right",
  2: "center",
  3: "justify",
  4: "justify",
  5: "justify",
  6: "justify"
};

/** Character-style keys inside a character run's style dictionary. */
const CHAR_STYLE = { font: "0", size: "1", fauxBold: "2", fauxItalic: "3", tracking: "8", fillPaint: "53" } as const;
/** Paragraph-style keys inside a paragraph run's style dictionary. */
const PARAGRAPH_STYLE = { justification: "0" } as const;

export interface CosTextDocument {
  /** The characters. After Effects separates lines with CR; callers normalise if they need to. */
  text: string;
  /** PostScript name of the font the first character run uses, when the font list resolves. */
  fontPostScriptName?: string;
  fontSize?: number;
  fauxBold?: boolean;
  fauxItalic?: boolean;
  tracking?: number;
  /** `#rrggbb` from the fill paint's RGB components. */
  fillColor?: string;
  align?: "left" | "center" | "right" | "justify";
  /** What this document carries that the single-style model above cannot represent. */
  warnings: string[];
}

/**
 * Read the first keyframe of a text document out of a parsed `btdk` payload.
 *
 * Source Text is an animatable property, so a document holds one entry per keyframe. The first
 * is the value GrapiX imports; more than one is reported, not merged.
 */
export function readTextDocument(root: CosValue): CosTextDocument | undefined {
  const frames = cosGet(root, "1", "1");
  if (!Array.isArray(frames) || frames.length === 0) return undefined;
  const frame = asDict(cosGet(frames[0], "0"));
  if (!frame) return undefined;
  const rawText = frame["0"];
  if (typeof rawText !== "string") return undefined;

  const warnings: string[] = [];
  if (frames.length > 1) {
    warnings.push(`Source Text is animated over ${frames.length} keyframes; the first value was imported.`);
  }

  const characterRuns = cosGet(frame, "6", "0");
  const paragraphRuns = cosGet(frame, "5", "0");
  if (Array.isArray(characterRuns) && characterRuns.length > 1) {
    warnings.push(
      `Text has ${characterRuns.length} character style runs; GrapiX text carries one style, so the first was used.`
    );
  }
  if (Array.isArray(paragraphRuns) && paragraphRuns.length > 1) {
    warnings.push(
      `Text has ${paragraphRuns.length} paragraph style runs; GrapiX text carries one, so the first was used.`
    );
  }

  const characterStyle = asDict(cosGet(characterRuns, 0, "0", "0", "6"));
  const paragraphStyle = asDict(cosGet(paragraphRuns, 0, "0", "0", "5"));

  const document: CosTextDocument = { text: rawText, warnings };

  const fontIndex = characterStyle?.[CHAR_STYLE.font];
  if (typeof fontIndex === "number") {
    const name = cosGet(root, "0", "1", "0", fontIndex, "0", "0", "0");
    if (typeof name === "string" && name.length > 0) document.fontPostScriptName = name;
  }
  const size = characterStyle?.[CHAR_STYLE.size];
  if (typeof size === "number") document.fontSize = size;
  const fauxBold = characterStyle?.[CHAR_STYLE.fauxBold];
  if (typeof fauxBold === "boolean") document.fauxBold = fauxBold;
  const fauxItalic = characterStyle?.[CHAR_STYLE.fauxItalic];
  if (typeof fauxItalic === "boolean") document.fauxItalic = fauxItalic;
  const tracking = characterStyle?.[CHAR_STYLE.tracking];
  if (typeof tracking === "number") document.tracking = tracking;

  // A paint is `{ /0 << /0 <type> /1 [ c r g b ] >> /99 /SimplePaint >> }`: the components array
  // leads with a constant, and RGB follows it in 0-1.
  const components = cosGet(characterStyle, CHAR_STYLE.fillPaint, "0", "1");
  if (Array.isArray(components) && components.length >= 4) {
    const [, red, green, blue] = components;
    if (typeof red === "number" && typeof green === "number" && typeof blue === "number") {
      document.fillColor = rgbToHex(red, green, blue);
    }
  }

  const justification = paragraphStyle?.[PARAGRAPH_STYLE.justification];
  if (typeof justification === "number") document.align = JUSTIFICATION[justification] ?? "left";

  return document;
}

/** Pack three 0-1 components into `#rrggbb`; After Effects stores colour that way throughout. */
export function rgbToHex(red: number, green: number, blue: number): string {
  const channel = (value: number): string =>
    Math.max(0, Math.min(255, Math.round(value * 255)))
      .toString(16)
      .padStart(2, "0");
  return `#${channel(red)}${channel(green)}${channel(blue)}`;
}
