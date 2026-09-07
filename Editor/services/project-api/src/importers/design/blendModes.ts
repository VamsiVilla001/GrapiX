import { isImplementedBlendMode, type MaterialBlendMode } from "@grapix/shared-types";

export interface ResolvedSourceBlendMode {
  /** A mode both GrapiX renderers implement. Never a declared-but-unrendered value. */
  mode: MaterialBlendMode;
  /** False when the source mode has no GrapiX equivalent and `mode` is an approximation. */
  exact: boolean;
}

/**
 * Source blend mode -> a blend mode both renderers implement.
 *
 * `IMPLEMENTED_BLEND_MODES` is the whole vocabulary available: normal, add,
 * multiply, screen, darken, lighten. `overlay`, `subtract`, `alpha-mask` and
 * `inverse-alpha-mask` are declared in the contract and rendered by nothing, so an
 * importer that emits one produces a scene that validates and then draws as
 * something else - the trap `IMPLEMENTED_TEXTURE_FIT_MODES` exists to prevent for
 * texture fit. Photoshop, Illustrator/SVG and Figma names all normalize here.
 *
 * Photoshop's contrast family (overlay, soft/hard/vivid/linear/pin light, hard mix)
 * lightens far more often than it darkens in broadcast artwork, so `screen` is the
 * closest available approximation; the component modes (hue, saturation, color,
 * luminosity, difference, exclusion, divide) have no approximation at all and stay
 * `normal`. Every approximation is reported by the caller.
 */
const BLEND_MODE_TABLE: Record<string, ResolvedSourceBlendMode> = {
  // Exact
  "pass through": { mode: "normal", exact: true },
  normal: { mode: "normal", exact: true },
  darken: { mode: "darken", exact: true },
  "darker color": { mode: "darken", exact: true },
  lighten: { mode: "lighten", exact: true },
  "lighter color": { mode: "lighten", exact: true },
  multiply: { mode: "multiply", exact: true },
  screen: { mode: "screen", exact: true },
  "linear dodge": { mode: "add", exact: true },
  "linear dodge (add)": { mode: "add", exact: true },
  plus_lighter: { mode: "add", exact: true },
  "plus lighter": { mode: "add", exact: true },

  // Approximated
  dissolve: { mode: "normal", exact: false },
  "color burn": { mode: "multiply", exact: false },
  "linear burn": { mode: "multiply", exact: false },
  "color dodge": { mode: "add", exact: false },
  overlay: { mode: "screen", exact: false },
  "soft light": { mode: "screen", exact: false },
  "hard light": { mode: "screen", exact: false },
  "vivid light": { mode: "screen", exact: false },
  "linear light": { mode: "screen", exact: false },
  "pin light": { mode: "screen", exact: false },
  "hard mix": { mode: "screen", exact: false },
  difference: { mode: "normal", exact: false },
  exclusion: { mode: "normal", exact: false },
  subtract: { mode: "normal", exact: false },
  divide: { mode: "normal", exact: false },
  hue: { mode: "normal", exact: false },
  saturation: { mode: "normal", exact: false },
  color: { mode: "normal", exact: false },
  luminosity: { mode: "normal", exact: false }
};

/** Resolve any source blend-mode name (Photoshop, CSS/SVG or Figma) to a rendered mode. */
export function resolveSourceBlendMode(value: unknown): ResolvedSourceBlendMode {
  if (value === undefined || value === null || value === "") {
    return { mode: "normal", exact: true };
  }
  const key = String(value).trim().toLowerCase().replace(/[_-]+/g, " ");
  const resolved = BLEND_MODE_TABLE[key] ?? BLEND_MODE_TABLE[key.replace(/ /g, "_")];
  if (!resolved) {
    return { mode: "normal", exact: false };
  }
  // A table entry that names a mode the renderers dropped would reintroduce exactly
  // the class of bug this module exists to prevent.
  return isImplementedBlendMode(resolved.mode) ? resolved : { mode: "normal", exact: false };
}
