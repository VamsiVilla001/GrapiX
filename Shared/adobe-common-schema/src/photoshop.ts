/**
 * The Photoshop object model, taken from Adobe's own Photoshop API SDK
 * (`@adobe/aio-lib-photoshop-api`, the library behind `adobe/adobe-photoshop-api-sdk`).
 *
 * The same vocabulary is used by both Photoshop transports:
 * - **local** — the UXP plugin, which reads the document through Photoshop itself.
 * - **cloud** — the Photoshop API, whose `documentManifest` reports layers using exactly
 *   these `LayerType` and `BlendMode` strings.
 *
 * Keeping one vocabulary is the point: a PSD imported over the cloud API and the same PSD
 * imported through the plugin must produce the same GrapiX scene, or "import from Adobe"
 * means two different things depending on which machine the operator is sitting at.
 */

import type { MaterialBlendMode } from "@grapix/shared-types";
import type { CompatibilityStatus } from "./types.js";

/** `LayerType` from the Photoshop API SDK. */
export const PS_LAYER_TYPE: Record<string, string> = {
  layer: "layer",
  textLayer: "textLayer",
  adjustmentLayer: "adjustmentLayer",
  layerSection: "layerSection",
  smartObject: "smartObject",
  backgroundLayer: "backgroundLayer",
  fillLayer: "fillLayer"
};

/** The GrapiX layer kind each Photoshop layer type imports as. */
export const PS_LAYER_TYPE_TO_GRAPIX: Record<string, string> = {
  layer: "pixel",
  textLayer: "text",
  adjustmentLayer: "adjustment",
  layerSection: "group",
  smartObject: "smart-object",
  backgroundLayer: "pixel",
  fillLayer: "shape"
};

/**
 * How faithfully each Photoshop layer type survives the trip into a GrapiX scene.
 *
 * `adjustmentLayer` is `Rasterised` rather than `Converted` because GrapiX has no
 * adjustment pipeline: the only honest import bakes the adjusted result into pixels.
 */
export const PS_LAYER_TYPE_FIDELITY: Record<string, CompatibilityStatus> = {
  layer: "Native",
  textLayer: "Native",
  layerSection: "Native",
  backgroundLayer: "Native",
  fillLayer: "Converted",
  smartObject: "Converted",
  adjustmentLayer: "Rasterised"
};

/** `BlendMode` from the Photoshop API SDK — all 26 Photoshop blend modes. */
export const PS_BLEND_MODE: readonly string[] = [
  "normal",
  "dissolve",
  "darken",
  "multiply",
  "colorBurn",
  "linearBurn",
  "darkerColor",
  "lighten",
  "screen",
  "colorDodge",
  "linearDodge",
  "lighterColor",
  "overlay",
  "softLight",
  "hardLight",
  "vividLight",
  "linearLight",
  "pinLight",
  "hardMix",
  "difference",
  "exclusion",
  "subtract",
  "divide",
  "hue",
  "saturation",
  "color",
  "luminosity"
];

/**
 * Photoshop blend mode to the six GrapiX implements in *both* renderers
 * (`IMPLEMENTED_BLEND_MODES` in `@grapix/shared-types`).
 *
 * Only exact equivalences are listed. Everything else is absent on purpose: aliasing
 * `colorBurn` to `multiply` would put a different picture on air than the designer
 * approved, and the operator would never be told. Unlisted modes resolve through
 * `resolvePhotoshopBlendMode`, which reports the substitution.
 */
const PS_BLEND_MODE_EXACT: Record<string, MaterialBlendMode> = {
  normal: "normal",
  darken: "darken",
  multiply: "multiply",
  lighten: "lighten",
  screen: "screen",
  linearDodge: "add"
};

export interface ResolvedBlendMode {
  mode: MaterialBlendMode;
  status: CompatibilityStatus;
  /** Present whenever the authored mode is not what will be rendered. */
  warning?: string;
}

/**
 * Resolve a Photoshop blend mode into something both GrapiX renderers can draw.
 *
 * A mode GrapiX cannot express is *not* silently downgraded: the layer still renders as
 * `normal`, because a missing layer is worse than a wrong blend, but the substitution is
 * returned as a warning so the compatibility report names it.
 */
export function resolvePhotoshopBlendMode(mode: string | undefined): ResolvedBlendMode {
  if (!mode) return { mode: "normal", status: "Native" };

  const exact = PS_BLEND_MODE_EXACT[mode];
  if (exact) return { mode: exact, status: "Native" };

  if (!PS_BLEND_MODE.includes(mode)) {
    return {
      mode: "normal",
      status: "Unsupported",
      warning: `"${mode}" is not a Photoshop blend mode; the layer renders as Normal.`
    };
  }

  return {
    mode: "normal",
    status: "Converted",
    warning: `Photoshop's "${mode}" blend mode has no GrapiX equivalent; the layer renders as Normal. Flatten it in Photoshop to keep the intended look.`
  };
}

/** `ParagraphAlignment` from the Photoshop API SDK, mapped to GrapiX text alignment. */
export const PS_PARAGRAPH_ALIGNMENT: Record<string, "left" | "center" | "right" | "justify"> = {
  left: "left",
  center: "center",
  right: "right",
  justify: "justify",
  justifyLeft: "justify",
  justifyCenter: "justify",
  justifyRight: "justify"
};

/** `Storage` from the Photoshop API SDK: where the API reads and writes files. */
export const PS_STORAGE: Record<string, string> = {
  aio: "aio",
  adobe: "adobe",
  external: "external",
  azure: "azure",
  dropbox: "dropbox"
};

/** `MimeType` from the Photoshop API SDK. */
export const PS_MIME_TYPE: Record<string, string> = {
  dng: "image/x-adobe-dng",
  jpeg: "image/jpeg",
  png: "image/png",
  psd: "image/vnd.adobe.photoshop",
  tiff: "image/tiff"
};

/** `JobOutputStatus` from the Photoshop API SDK — the async job lifecycle. */
export const PS_JOB_STATUS: Record<string, string> = {
  pending: "pending",
  running: "running",
  uploading: "uploading",
  succeeded: "succeeded",
  failed: "failed"
};
