// GENERATED from gx-contracts::material by gx-contract-codegen.
// Do not edit. Regenerate with `npm run codegen` (1.3, 11.12, invariant 27).
//
// The authoring vocabulary, not the supported set: what a given peer
// can actually draw is declared in its capability exchange and never
// inferred from a list like this one (invariant 21).

import type { AlphaMode, BlendMode, CullMode, DepthMode, FitMode, MaterialKind }
  from "@grapix/contracts";

/// Whether a material shades with the scene's lights. `null` is the
/// honest answer for a custom shader, which decides its own.
export type MaterialDimension = "two-d" | "three-d";

export interface MaterialKindInfo {
  readonly kind: MaterialKind;
  readonly dimension: MaterialDimension | null;
  readonly lit: boolean;
  /// What the kind needs beyond a name before it can be created,
  /// or null when it can be completed from nothing.
  readonly needs: string | null;
}

export const MATERIAL_KINDS: readonly MaterialKindInfo[] = [
  { kind: "solid-color", dimension: "two-d", lit: false, needs: null },
  { kind: "image", dimension: "two-d", lit: false, needs: "a still image asset in the scene's asset library" },
  { kind: "video", dimension: "two-d", lit: false, needs: "a video asset in the scene's asset library" },
  { kind: "unlit", dimension: "two-d", lit: false, needs: null },
  { kind: "pbr", dimension: "three-d", lit: true, needs: null },
  { kind: "shader", dimension: null, lit: false, needs: "a WGSL shader asset; shader materials are not authored in this panel" },
] as const;

export const BLEND_MODES: readonly BlendMode[] = ["normal", "add", "multiply", "screen", "overlay", "darken", "lighten", "subtract", "alpha-mask", "inverse-alpha-mask"];

/// The blend modes expressible as fixed-function GPU blending.
export const FIXED_FUNCTION_BLEND_MODES: readonly BlendMode[] = ["normal", "add", "multiply", "screen", "darken", "lighten"];
export const FIT_MODES: readonly FitMode[] = ["stretch", "contain", "cover", "crop", "tile", "original", "pixel-perfect", "nine-slice"];
export const CULL_MODES: readonly CullMode[] = ["none", "front", "back"];
export const ALPHA_MODES: readonly AlphaMode[] = ["opaque", "straight", "premultiplied", "alpha-test"];
export const DEPTH_MODES: readonly DepthMode[] = ["disabled", "read", "read-write"];

/// The material slot keys each mesh primitive offers.
export const MESH_MATERIAL_ELEMENTS: Readonly<Record<string, readonly string[]>> = {
  "model": [],
  "cube": ["front", "back", "left", "right", "top", "bottom"],
  "sphere": ["object"],
  "cylinder": ["top", "bottom", "side"],
  "torus": ["object"],
  "slab": ["front", "back", "side"],
};

/// The single slot key a rect, ellipse, text or image offers.
export const PLANAR_MATERIAL_ELEMENT = "fill";

/// The texture inputs every kind but `shader` may declare.
export const STANDARD_TEXTURE_SLOTS = ["baseColor", "normal", "roughness", "metallic", "emissive", "occlusion"] as const;
