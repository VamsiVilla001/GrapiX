import type { FontFaceDefinition } from "@grapix/shared-types";
import { create, type Font, type FontCollection } from "fontkit";

export interface InspectedFontFile {
  family: string;
  displayName: string;
  weight: number;
  style: FontFaceDefinition["style"];
}

export function inspectFontFile(bytes: Buffer): InspectedFontFile {
  const parsed = create(bytes);
  const font = isCollection(parsed) ? parsed.fonts[0] : parsed;
  if (!font) throw new Error("Font collection contains no faces");
  const family = cleanName(font.familyName || font.fullName || font.postscriptName);
  if (!family) throw new Error("Font file has no readable family name");
  const subfamily = (font.subfamilyName ?? "").toLowerCase();
  return {
    family,
    displayName: cleanName(font.fullName) || family,
    weight: normalizeWeight(font["OS/2"]?.usWeightClass),
    style: font.italicAngle !== 0 || /italic/.test(subfamily)
      ? "italic"
      : /oblique/.test(subfamily) ? "oblique" : "normal"
  };
}

function isCollection(value: Font | FontCollection): value is FontCollection {
  return "fonts" in value;
}

function normalizeWeight(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(1, Math.min(1000, Math.round(value!))) : 400;
}

function cleanName(value: string | undefined): string {
  return (value ?? "").replace(/[\r\n\f]/g, " ").trim().slice(0, 128);
}
