export interface ParsedCssFontSource {
  url: string;
  format?: "otf" | "ttf" | "woff" | "woff2";
}

export interface ParsedCssFontFace {
  family: string;
  weight: number;
  style: "normal" | "italic" | "oblique";
  stretch?: string;
  unicodeRange?: string;
  sources: ParsedCssFontSource[];
}

export interface ParsedFontStylesheet {
  imports: string[];
  faces: ParsedCssFontFace[];
}

/**
 * Parse only the inert pieces of CSS needed by the font importer. The returned
 * CSS is never injected or executed. Unknown rules and declarations are
 * intentionally ignored.
 */
export function parseFontStylesheet(css: string, stylesheetUrl: string): ParsedFontStylesheet {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const imports = [...clean.matchAll(/@import\s+(?:url\(\s*)?["']?([^"')\s;]+)["']?\s*\)?[^;]*;/gi)]
    .map((match) => absoluteUrl(match[1] ?? "", stylesheetUrl))
    .filter((url): url is string => Boolean(url));
  const faces: ParsedCssFontFace[] = [];

  for (const match of clean.matchAll(/@font-face\s*\{([\s\S]*?)\}/gi)) {
    const declarations = parseDeclarations(match[1] ?? "");
    const family = unquote(declarations.get("font-family") ?? "").trim();
    if (!family) continue;
    const sources = parseSources(declarations.get("src") ?? "", stylesheetUrl);
    if (!sources.length) continue;
    faces.push({
      family,
      weight: parseWeight(declarations.get("font-weight")),
      style: parseStyle(declarations.get("font-style")),
      stretch: declarations.get("font-stretch")?.trim() || undefined,
      unicodeRange: declarations.get("unicode-range")?.trim() || undefined,
      sources
    });
  }

  return {
    imports: [...new Set(imports)],
    faces
  };
}

function parseDeclarations(block: string): Map<string, string> {
  const declarations = new Map<string, string>();
  let start = 0;
  let quote = "";
  let depth = 0;
  const commit = (end: number) => {
    const declaration = block.slice(start, end);
    const separator = declaration.indexOf(":");
    if (separator > 0) {
      declarations.set(
        declaration.slice(0, separator).trim().toLowerCase(),
        declaration.slice(separator + 1).trim()
      );
    }
  };
  for (let index = 0; index < block.length; index += 1) {
    const character = block[index]!;
    if (quote) {
      if (character === quote && block[index - 1] !== "\\") quote = "";
    } else if (character === "'" || character === "\"") {
      quote = character;
    } else if (character === "(") {
      depth += 1;
    } else if (character === ")") {
      depth = Math.max(0, depth - 1);
    } else if (character === ";" && depth === 0) {
      commit(index);
      start = index + 1;
    }
  }
  commit(block.length);
  return declarations;
}

function parseSources(value: string, baseUrl: string): ParsedCssFontSource[] {
  const sources: ParsedCssFontSource[] = [];
  for (const match of value.matchAll(/url\(\s*(?:"([^"]+)"|'([^']+)'|([^)'"\s]+))\s*\)\s*(?:format\(\s*["']?([^"')\s]+)["']?\s*\))?/gi)) {
    const url = absoluteUrl(match[1] ?? match[2] ?? match[3] ?? "", baseUrl);
    if (!url) continue;
    sources.push({ url, format: normalizeFormat(match[4] ?? url) });
  }
  return sources;
}

function absoluteUrl(value: string, baseUrl: string): string | null {
  try {
    const url = new URL(value, baseUrl);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function normalizeFormat(value: string): ParsedCssFontSource["format"] {
  const normalized = value.toLowerCase().split(/[?#]/)[0]?.replace(/.*\./, "");
  if (normalized === "truetype" || normalized === "ttf") return "ttf";
  if (normalized === "opentype" || normalized === "otf") return "otf";
  if (normalized === "woff") return "woff";
  if (normalized === "woff2") return "woff2";
  return undefined;
}

function parseWeight(value: string | undefined): number {
  const first = value?.match(/\d{1,4}/)?.[0];
  const number = first ? Number(first) : value?.trim().toLowerCase() === "bold" ? 700 : 400;
  return Math.max(1, Math.min(1000, Math.round(number)));
}

function parseStyle(value: string | undefined): ParsedCssFontFace["style"] {
  const normalized = value?.trim().toLowerCase() ?? "normal";
  if (normalized.startsWith("italic")) return "italic";
  if (normalized.startsWith("oblique")) return "oblique";
  return "normal";
}

function unquote(value: string): string {
  const trimmed = value.trim();
  return (trimmed.startsWith("\"") && trimmed.endsWith("\""))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
    ? trimmed.slice(1, -1)
    : trimmed;
}
