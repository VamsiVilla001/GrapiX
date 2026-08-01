/**
 * The capability map: what a GrapiX scene can actually contain, derived from
 * the contracts themselves rather than from prose.
 *
 * Two sources, on purpose:
 *
 *   runtime constants  imported from `@grapix/shared-types`, so an implemented
 *                      list is whatever the code says today
 *   declared unions    parsed out of the contract source, because a TypeScript
 *                      union has no runtime representation to import
 *
 * The pair matters more than either half. `docs/material-system.md` and
 * `memory.md` both record the same recurring failure: an option that is
 * selectable, saved and validated as fine, but that the renderers ignore — six
 * of the eight `TextureFitMode` values drew as `stretch` for as long as the
 * mode existed. So every list here reports *declared* and *implemented*
 * separately and names the difference, which is the single fact an agent needs
 * before it writes a value into a scene.
 */

import {
  ANIMATABLE_PROPERTIES,
  CANONICAL_MATERIAL_TYPE,
  DEFAULT_PROJECT_SETTINGS,
  DEFAULT_SLAB_PROPERTIES,
  IMPLEMENTED_BLEND_MODES,
  IMPLEMENTED_MASK_MODES,
  IMPLEMENTED_TEXTURE_FIT_MODES,
  MAX_PROJECT_DIMENSION,
  MIN_PROJECT_DIMENSION,
  PRIMARY_MATERIAL_SLOT,
  PROJECT_COLOR_SPACES,
  PROJECT_COLOR_SPACE_INFO,
  PROJECT_PIXEL_ASPECT_RATIO,
  RESOLUTION_PRESETS,
  RESOLUTION_PRESET_INFO,
  STANDARD_MATERIAL_WIRE_TYPES
} from "@grapix/shared-types";
import { readFile } from "node:fs/promises";
import path from "node:path";

export interface CapabilityList {
  name: string;
  /** Every value the type system accepts. */
  declared: string[];
  /**
   * The subset the renderers honour. `undefined` means the contract makes no
   * implemented/declared distinction for this list.
   */
  implemented?: string[];
  /** Declared values that render as something else, with what actually happens. */
  unimplemented?: string[];
  note?: string;
}

export interface CapabilityMap {
  objects: CapabilityList;
  bindableProperties: CapabilityList;
  animatableProperties: CapabilityList;
  meshPrimitives: CapabilityList;
  lights: CapabilityList;
  cameras: CapabilityList;
  materialTypes: CapabilityList;
  blendModes: CapabilityList;
  alphaModes: CapabilityList;
  cullModes: CapabilityList;
  depthModes: CapabilityList;
  textureFitModes: CapabilityList;
  textureWrapModes: CapabilityList;
  textureFilteringModes: CapabilityList;
  maskModes: CapabilityList;
  assetKinds: CapabilityList;
  easings: CapabilityList;
  transitions: CapabilityList;
  triggerEvents: CapabilityList;
  scriptPermissions: CapabilityList;
  timelineMarkers: CapabilityList;
  project: {
    colorSpaces: { id: string; label?: string }[];
    resolutionPresets: { id: string; width?: number; height?: number; label?: string }[];
    defaults: Record<string, unknown>;
    minDimension: number;
    maxDimension: number;
    pixelAspectRatio: number;
  };
  materials: {
    canonicalType: string;
    wireTypes: string[];
    primarySlot: string;
    slabDefaults: Record<string, unknown>;
  };
}

/**
 * Extracts `export type Name = "a" | "b" | "c";` from contract source. Only
 * pure string-literal unions are returned — a union with object members has no
 * useful flat list, and guessing one would misreport the contract.
 */
export function extractStringUnion(source: string, typeName: string): string[] {
  const pattern = new RegExp(`export type ${typeName}\\s*=([\\s\\S]*?);`, "m");
  const match = source.match(pattern);
  if (!match) return [];

  const body = match[1];
  // Reject unions carrying anything other than string literals and separators.
  const withoutLiterals = body.replace(/"[^"]*"/g, "").replace(/[|\s]/g, "");
  if (withoutLiterals.length > 0) return [];

  return [...body.matchAll(/"([^"]*)"/g)].map((literal) => literal[1]);
}

function list(
  name: string,
  declared: string[],
  implemented?: readonly string[],
  note?: string
): CapabilityList {
  if (!implemented) return { name, declared, ...(note ? { note } : {}) };

  const implementedList = [...implemented];
  const unimplemented = declared.filter((value) => !implementedList.includes(value));

  return {
    name,
    declared,
    implemented: implementedList,
    ...(unimplemented.length ? { unimplemented } : {}),
    ...(note ? { note } : {})
  };
}

export async function buildCapabilityMap(repositoryRoot: string): Promise<CapabilityMap> {
  const sharedTypesPath = path.join(repositoryRoot, "Shared", "shared-types", "src", "index.ts");
  let source = "";
  try {
    source = await readFile(sharedTypesPath, "utf8");
  } catch {
    // Without the source only the runtime constants are available. Declared
    // lists come back empty rather than fabricated.
  }

  const union = (typeName: string): string[] => extractStringUnion(source, typeName);

  return {
    objects: list("SceneObjectType", union("SceneObjectType")),
    bindableProperties: list(
      "SceneProperty",
      union("SceneProperty"),
      undefined,
      "Data-bindable properties. Which of them a given object type accepts is decided by " +
        "Editor/apps/editor-web/src/store/objectPropertySupport.ts, the single definition: " +
        "containers inherit scaleZ, do not inherit rotationX/rotationY, and rotationZ is read " +
        "from meshes alone."
    ),
    animatableProperties: list(
      "AnimatableProperty",
      union("AnimatableProperty"),
      ANIMATABLE_PROPERTIES,
      "Keyframed through per-property channels (PropertyChannelMap), not scalar keyframes."
    ),
    meshPrimitives: list("MeshPrimitiveKind", union("MeshPrimitiveKind")),
    lights: list("LightKind", union("LightKind")),
    cameras: list("CameraKind", union("CameraKind")),
    materialTypes: list(
      "MaterialType",
      union("MaterialType"),
      undefined,
      `One Standard Material model. The canonical type is "${CANONICAL_MATERIAL_TYPE}"; the ` +
        `accepted wire aliases are ${STANDARD_MATERIAL_WIRE_TYPES.join(", ")} and they normalise ` +
        "to the canonical type on load."
    ),
    blendModes: list("MaterialBlendMode", union("MaterialBlendMode"), IMPLEMENTED_BLEND_MODES),
    alphaModes: list("MaterialAlphaMode", union("MaterialAlphaMode")),
    cullModes: list("MaterialCullMode", union("MaterialCullMode")),
    depthModes: list("MaterialDepthMode", union("MaterialDepthMode")),
    textureFitModes: list(
      "TextureFitMode",
      union("TextureFitMode"),
      IMPLEMENTED_TEXTURE_FIT_MODES,
      "resolveTextureFit (TypeScript) and resolve_texture_fit (Rust) are one definition in two " +
        "languages so Preview and Program sample the same rectangle. An unimplemented mode " +
        "renders as stretch — do not author one."
    ),
    textureWrapModes: list("TextureWrapMode", union("TextureWrapMode")),
    textureFilteringModes: list("TextureFilteringMode", union("TextureFilteringMode")),
    maskModes: list("MaskMode", union("MaskMode"), IMPLEMENTED_MASK_MODES),
    assetKinds: list("AssetKind", union("AssetKind")),
    easings: list("SceneKeyframeEasing", union("SceneKeyframeEasing")),
    transitions: list("TransitionKind", union("TransitionKind")),
    triggerEvents: list(
      "TriggerEventType",
      union("TriggerEventType"),
      undefined,
      "The Editor evaluates triggers as a dry run only. Executing an automation action is a " +
        "Playout responsibility (docs/architecture.md invariant 4)."
    ),
    scriptPermissions: list("SceneScriptPermission", union("SceneScriptPermission")),
    timelineMarkers: list("SceneTimelineMarkerKind", union("SceneTimelineMarkerKind")),
    project: {
      colorSpaces: PROJECT_COLOR_SPACES.map((id) => ({
        id,
        label: PROJECT_COLOR_SPACE_INFO[id]?.label
      })),
      // `RESOLUTION_PRESETS` includes "custom", which by design has no fixed
      // size and so no entry in the info record. Reported without dimensions
      // rather than dropped: it is a real, selectable preset.
      resolutionPresets: RESOLUTION_PRESETS.map((id) => {
        const info = RESOLUTION_PRESET_INFO as Record<
          string,
          { width?: number; height?: number; label?: string } | undefined
        >;
        const preset = info[id];
        return { id, width: preset?.width, height: preset?.height, label: preset?.label };
      }),
      defaults: { ...DEFAULT_PROJECT_SETTINGS } as unknown as Record<string, unknown>,
      minDimension: MIN_PROJECT_DIMENSION,
      maxDimension: MAX_PROJECT_DIMENSION,
      pixelAspectRatio: PROJECT_PIXEL_ASPECT_RATIO
    },
    materials: {
      canonicalType: CANONICAL_MATERIAL_TYPE,
      wireTypes: [...STANDARD_MATERIAL_WIRE_TYPES],
      primarySlot: PRIMARY_MATERIAL_SLOT,
      slabDefaults: { ...DEFAULT_SLAB_PROPERTIES } as unknown as Record<string, unknown>
    }
  };
}

/** Every `CapabilityList` on the map, for search and markdown rendering. */
export function capabilityLists(map: CapabilityMap): CapabilityList[] {
  return Object.values(map).filter(
    (value): value is CapabilityList =>
      typeof value === "object" && value !== null && "declared" in value && "name" in value
  );
}

export function renderCapabilityList(entry: CapabilityList): string {
  const rows = [`### ${entry.name}`, ""];
  rows.push(`- **Declared**: ${entry.declared.length ? entry.declared.join(", ") : "—"}`);
  if (entry.implemented) {
    rows.push(`- **Implemented**: ${entry.implemented.join(", ")}`);
  }
  if (entry.unimplemented?.length) {
    rows.push(
      `- **Declared but NOT rendered**: ${entry.unimplemented.join(", ")} — authoring one of ` +
        "these produces a scene that validates and then renders as something else."
    );
  }
  if (entry.note) rows.push(`- **Note**: ${entry.note}`);
  rows.push("");
  return rows.join("\n");
}
