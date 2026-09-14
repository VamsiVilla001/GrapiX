//! Turning an authored material into something the browser preview can draw
//! (build plan 11.12 in the viewport, ADR-0002 B.1).
//!
//! This module is the *policy*, kept pure so it runs headless: which material
//! an object's slot resolves to, what the preview can reproduce exactly, and
//! what it must refuse by name. `viewport.ts` is the wiring that turns a plan
//! into Three.js objects and needs a GL context; every decision worth testing
//! is here.
//!
//! **The preview refuses rather than approximates.** A blend mode this layer
//! cannot composite is named, not replaced with the nearest one that draws —
//! that substitution is the recorded 1.x fault behind invariant 18, where a
//! renderer with no `overlay` quietly drew `screen` and nobody was told. The
//! set it can do is not a list kept here either: it is
//! `FIXED_FUNCTION_BLEND_MODES`, generated from the Rust enum that records
//! which modes are a source/destination factor pair.
//!
//! **A texture that has not arrived is not a grey box.** An asset whose bytes
//! the shell could not read is reported by name, because "the logo is missing"
//! and "the logo is grey" are different facts and only one of them is true.

import type {
  MaterialDefinition,
  MaterialTextureSlot,
  SceneDocument,
  SceneObject,
} from "@grapix/contracts";

import { materialElementsOf } from "./material-manager";
import { FIXED_FUNCTION_BLEND_MODES } from "./material-reference";

/// One asset's bytes, as the shell hands them over.
export interface AssetSource {
  readonly assetId: string;
  readonly mediaType: string;
  readonly dataUrl: string;
}

export type AssetSources = ReadonlyMap<string, AssetSource>;

/// Which material an object draws with, and through which slot.
///
/// The preview draws one material per object because a Three mesh built from
/// this layer's geometry has one material. A mesh whose faces carry different
/// materials is named as such rather than drawn with whichever one happened to
/// be first: per-face assignment is the engine's (3.7), and picking one here
/// would show the author a surface they did not author.
export type MaterialResolution =
  | { readonly kind: "none" }
  | { readonly kind: "material"; readonly element: string; readonly material: MaterialDefinition }
  | { readonly kind: "unsupported"; readonly reason: string };

export function resolveObjectMaterial(
  document: SceneDocument,
  object: SceneObject,
): MaterialResolution {
  const slots = object.materialSlots;
  if (!slots) return { kind: "none" };
  const bound = Object.entries(slots).filter(
    (entry): entry is [string, { materialId: string }] => Boolean(entry[1]),
  );
  if (bound.length === 0) return { kind: "none" };

  const distinct = new Set(bound.map(([, binding]) => binding.materialId));
  if (distinct.size > 1) {
    return {
      kind: "unsupported",
      reason: `${bound.length} faces carry different materials; per-face assignment renders on the engine (3.7)`,
    };
  }

  // One material, but possibly not on every face the object has. Drawing it
  // across the whole object would be a different graphic from the authored
  // one, so the gap is named.
  const elements = materialElementsOf(object);
  const [firstEntry] = bound;
  if (firstEntry === undefined) return { kind: "none" };
  const [element, binding] = firstEntry;
  if (elements.length > 1 && bound.length !== elements.length) {
    const unassigned = elements.filter((name) => !(name in slots));
    return {
      kind: "unsupported",
      reason: `${unassigned.join(", ")} carry no material; the engine refuses a partly assigned mesh`,
    };
  }

  const material = document.materials.find(
    (candidate) => candidate.materialId === binding.materialId,
  );
  if (!material) {
    return {
      kind: "unsupported",
      reason: `material ${binding.materialId} is bound but not in this scene's library`,
    };
  }
  return { kind: "material", element, material };
}

/// Which side of a surface is drawn, in Three's vocabulary.
export type PreviewSide = "front" | "back" | "double";

/// The texture the preview should build for one slot.
export interface PreviewTexture {
  readonly slot: string;
  readonly source: AssetSource;
  readonly fit: MaterialTextureSlot["fit"];
  readonly wrap: MaterialTextureSlot["wrap"];
  readonly filtering: MaterialTextureSlot["filtering"];
  readonly colorSpace: MaterialTextureSlot["colorSpace"];
  /// Whether the source carries a moving picture and so needs a video
  /// element rather than an image decode.
  readonly moving: boolean;
}

/// Everything the preview needs to build one Three material, with no Three
/// types in it — so the decisions can be asserted without a GL context.
export interface PreviewMaterialPlan {
  readonly kind: "plan";
  /// The material's own base paint — **not** the object's `fill`. An object
  /// bound to a material is painted by that material; reading the object's
  /// fill instead would show every object bound to one shared material in
  /// whatever colour it happened to carry before the material was assigned,
  /// which looks like the assignment silently failed.
  readonly color: MaterialDefinition["color"];
  readonly lit: boolean;
  readonly blending: MaterialDefinition["blendMode"];
  readonly side: PreviewSide;
  readonly opacity: number;
  readonly transparent: boolean;
  readonly premultipliedAlpha: boolean;
  /// `undefined` unless the alpha mode is a hard cutout.
  readonly alphaTest?: number;
  readonly depthTest: boolean;
  readonly depthWrite: boolean;
  readonly textures: readonly PreviewTexture[];
  /// Slots whose asset the shell could not hand over, named so the operator
  /// sees a missing texture rather than an unexplained flat colour.
  readonly missingTextures: readonly string[];
  readonly lighting?: {
    readonly metallic: number;
    readonly roughness: number;
    readonly emissiveIntensity: number;
  };
}

export type PreviewMaterial =
  | PreviewMaterialPlan
  | { readonly kind: "unsupported"; readonly reason: string };

/// Decide how one authored material is drawn in the preview.
///
/// `objectOpacity` multiplies the material's own, matching the contract's
/// "0–1, multiplied with the object's own opacity".
export function planPreviewMaterial(
  material: MaterialDefinition,
  objectOpacity: number,
  sources: AssetSources,
): PreviewMaterial {
  if (material.kind === "shader") {
    // A custom shader is WGSL compiled by the engine. There is nothing
    // truthful for a Three material to be here.
    return {
      kind: "unsupported",
      reason: `material ${material.name} is a custom shader; shaders run on the engine`,
    };
  }
  if (!FIXED_FUNCTION_BLEND_MODES.includes(material.blendMode)) {
    return {
      kind: "unsupported",
      reason: `blend mode ${material.blendMode} needs a shader compositing path the preview does not have`,
    };
  }

  const textures: PreviewTexture[] = [];
  const missingTextures: string[] = [];
  for (const texture of material.textures) {
    const source = sources.get(texture.assetId);
    if (!source) {
      missingTextures.push(`${texture.slot} (${texture.assetId})`);
      continue;
    }
    textures.push({
      slot: texture.slot,
      source,
      fit: texture.fit,
      wrap: texture.wrap,
      filtering: texture.filtering,
      colorSpace: texture.colorSpace,
      moving: source.mediaType.startsWith("video/"),
    });
  }

  const opacity = clampUnit(material.opacity * objectOpacity);
  const alpha = material.alphaMode;
  return {
    kind: "plan",
    color: material.color,
    lit: material.kind === "pbr",
    blending: material.blendMode,
    side: material.doubleSided ? "double" : sideFor(material.cullMode),
    opacity,
    // `opaque` means the alpha channel is not read at all, whatever the
    // opacity says; the other three all need blending once anything is
    // less than fully opaque.
    transparent: alpha !== "opaque" && (opacity < 1 || textures.length > 0),
    premultipliedAlpha: alpha === "premultiplied",
    ...(alpha === "alpha-test" ? { alphaTest: 0.5 } : {}),
    depthTest: material.depthMode !== "disabled",
    depthWrite: material.depthMode === "read-write",
    textures,
    missingTextures,
    ...(material.lighting
      ? {
          lighting: {
            metallic: material.lighting.metallic,
            roughness: material.lighting.roughness,
            emissiveIntensity: material.lighting.emissiveIntensity,
          },
        }
      : {}),
  };
}

/// Cull mode to the side that is drawn.
///
/// Culling the back face means drawing the front, which is the inversion that
/// is easy to get backwards and invisible until a 3D object is seen from
/// behind — so it is stated once, here.
function sideFor(cull: MaterialDefinition["cullMode"]): PreviewSide {
  switch (cull) {
    case "none":
      return "double";
    case "back":
      return "front";
    case "front":
      return "back";
  }
}

function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/// The asset ids a document's materials need bytes for, deduplicated.
///
/// The shell reads one asset at a time; this is the list to ask for, so the
/// preview does not fetch the same logo once per material that uses it.
export function requiredTextureAssets(document: SceneDocument): string[] {
  const needed = new Set<string>();
  for (const material of document.materials) {
    for (const texture of material.textures) {
      needed.add(texture.assetId);
    }
  }
  return [...needed];
}
