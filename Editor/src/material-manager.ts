// The material manager (build plan 11.12, 11.18).
//
// Done when: shared instances, relink, usage lookup — and, since the panel is
// where an author actually makes a material, creating and editing 2D and 3D
// materials with their colour, image and video textures.
//
// **Usage is computed, never stored.** A stored index is a second
// representation of the same fact, and it drifts the moment an object is
// edited by anything that forgets to update it — the same reasoning the MCP
// `materials.usage` handler gives. The document is the truth; this reads it.
//
// **A shared material is marked as shared, with its count.** Editing one is
// not a local act: it changes every object bound to it. An author who thinks
// they are adjusting one lower-third and is in fact restyling the whole
// rundown has been failed by the interface, not by their own carelessness.
//
// **Relink previews before it commits.** `relinkPreview` returns the object
// ids that would change, so the author is shown the blast radius first. A
// blind repoint across an unknown number of objects is the operation nobody
// can safely confirm.
//
// **2D and 3D are the split the engine already enforces, not a new one.**
// Which kinds are lit is decided once, in `MaterialKind::is_lit`, enforced by
// the renderer's `prepare_meshes` (a PBR material with no light in the scene
// is refused), and read here from the generated `MATERIAL_KINDS` table. This
// module never re-derives it from a kind's name — that would be the second
// vocabulary build plan 1.3 exists to abolish.

import type {
  AssetKind,
  MaterialDefinition,
  MaterialTextureSlot,
  Rgba,
  SceneDocument,
  SceneObject,
} from "@grapix/contracts";

import type { UiNode } from "./agent-surface";
import {
  MATERIAL_KINDS,
  MESH_MATERIAL_ELEMENTS,
  PLANAR_MATERIAL_ELEMENT,
  type MaterialDimension,
} from "./material-reference";

export interface MaterialManagerState {
  readonly selectedMaterialId?: string;
  /// The texture slot whose sampler controls the panel is editing. A second
  /// selection rather than a second panel: the texture rows are where an
  /// author looks, so that is where the choice of which one to edit belongs.
  readonly selectedTextureSlot?: string;
  /// The current object selection, so the panel can offer — or refuse, with a
  /// reason — assigning the material to it.
  readonly selectedObjectIds?: readonly string[];
}

/// The object ids bound to a material, in document order.
///
/// A material reaches an object through a named slot, so an object may use
/// several and is counted once per material.
export function usersOf(document: SceneDocument, materialId: string): string[] {
  return document.objects
    .filter((object) => boundMaterials(object).includes(materialId))
    .map((object) => object.id);
}

function boundMaterials(object: SceneObject): string[] {
  const slots = object.materialSlots;
  if (!slots) return [];
  return Object.values(slots)
    .filter((binding): binding is { materialId: string } => Boolean(binding))
    .map((binding) => binding.materialId);
}

/// The object ids a relink would change, without changing anything.
///
/// Returns them rather than performing the edit so a caller can show the
/// consequence and let the author decide. The edit itself is Rust's
/// `relink_material`; this is the sentence shown before it runs. Empty means
/// the relink would be a no-op, which is worth saying out loud rather than
/// reporting as success.
export function relinkPreview(
  document: SceneDocument,
  fromMaterialId: string,
  toMaterialId: string,
): string[] {
  if (fromMaterialId === toMaterialId) return [];
  return usersOf(document, fromMaterialId);
}

/// Whether a kind is a 2D or a 3D material, or `null` for a custom shader
/// that decides its own. Read from the generated table, never re-derived.
export function dimensionOf(kind: MaterialDefinition["kind"]): MaterialDimension | null {
  return MATERIAL_KINDS.find((info) => info.kind === kind)?.dimension ?? null;
}

export function isLit(kind: MaterialDefinition["kind"]): boolean {
  return MATERIAL_KINDS.find((info) => info.kind === kind)?.lit ?? false;
}

/// The material slot keys an object offers.
///
/// Mirrors `MeshObject::material_element_names` in the contract, which is the
/// authoritative version and the one the renderer is pinned against: the
/// fixed part comes from the generated table, and the two cases a kind alone
/// cannot state are handled the same way Rust states them — an imported model
/// carries its own names, and a slab grows one element per enabled bevel.
/// Offering a slot the engine does not look up is how an author ends up with
/// an unassigned face and no explanation.
export function materialElementsOf(object: SceneObject): string[] {
  if (object.type !== "mesh") return [PLANAR_MATERIAL_ELEMENT];
  if (object.meshKind === "model") return [...(object.materialElements ?? [])];
  const fixed = [...(MESH_MATERIAL_ELEMENTS[object.meshKind] ?? [])];
  if (object.meshKind === "slab") {
    if (object.slab?.frontBevel.enabled) fixed.push("frontBevel");
    if (object.slab?.backBevel.enabled) fixed.push("backBevel");
  }
  return fixed;
}

/// The asset kinds that can be sampled as a texture, and the ones that move.
/// Mirrors the contract's own lists so the panel offers exactly the assets
/// `validate_material_textures` would accept — an asset picker that offers
/// what the validator then refuses is an interface setting a trap.
const SAMPLEABLE: readonly AssetKind[] = [
  "image",
  "svg",
  "video",
  "imageSequence",
  "renderTexture",
  "live",
];
const MOVING: readonly AssetKind[] = ["video", "imageSequence", "live"];

/// The assets a material of this kind may bind in a slot, in document order.
export function bindableAssets(
  document: SceneDocument,
  kind: MaterialDefinition["kind"],
  slot: string,
): SceneDocument["assets"] {
  return document.assets.filter((asset) => {
    if (!SAMPLEABLE.includes(asset.kind)) return false;
    if (slot !== "baseColor") return true;
    if (kind === "video") return MOVING.includes(asset.kind);
    if (kind === "image") return !MOVING.includes(asset.kind);
    return true;
  });
}

/// A solid paint's hex form, or `undefined` when the paint is not a solid
/// colour. A gradient has no single swatch, and showing its first stop as if
/// it were the colour would be a quietly wrong answer.
export function solidHex(color: MaterialDefinition["color"]): string | undefined {
  return color.type === "solid" ? rgbaHex(color.color) : undefined;
}

export function rgbaHex(color: Rgba): string {
  const channel = (value: number): string =>
    Math.round(Math.min(1, Math.max(0, value)) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`;
}

/// Parse `#rgb` or `#rrggbb` into channels, or report that it is not a colour.
///
/// The authoritative parser is Rust's `Rgba::from_css_hex`, which is what the
/// document is validated by; this is the browser-side mirror the colour input
/// needs before a value can be sent. It refuses exactly what Rust refuses
/// rather than falling back to black, because a fallback colour is a value the
/// author never chose appearing in their scene.
export function parseHex(hex: string): { r: number; g: number; b: number } | undefined {
  const text = hex.trim().replace(/^#/, "");
  const expand =
    text.length === 3
      ? [...text].map((digit) => digit + digit).join("")
      : text.length === 6
        ? text
        : undefined;
  if (expand === undefined || !/^[0-9a-fA-F]{6}$/.test(expand)) return undefined;
  const value = Number.parseInt(expand, 16);
  return {
    r: ((value >> 16) & 255) / 255,
    g: ((value >> 8) & 255) / 255,
    b: (value & 255) / 255,
  };
}

/// How a material's base paint reads in one line.
function describePaint(material: MaterialDefinition): string {
  switch (material.color.type) {
    case "none":
      return "no base colour";
    case "solid":
      return `base ${rgbaHex(material.color.color)} (${material.color.color.space})`;
    default:
      return `base ${material.color.type}`;
  }
}

function describeTextures(material: MaterialDefinition, document: SceneDocument): string {
  if (material.textures.length === 0) return "no textures";
  return material.textures
    .map((texture) => {
      const asset = document.assets.find((item) => item.assetId === texture.assetId);
      // A texture whose asset has left the library is named as missing rather
      // than shown as a bare id that looks like it resolves.
      return asset
        ? `${texture.slot}: ${asset.name} (${asset.kind})`
        : `${texture.slot}: ${texture.assetId} — missing from the library`;
    })
    .join("; ");
}

/// The 2D/3D group a material is filed under, as a heading an author reads.
function groupLabel(dimension: MaterialDimension | null): string {
  switch (dimension) {
    case "two-d":
      return "2D materials";
    case "three-d":
      return "3D materials";
    default:
      return "Shader materials";
  }
}

const GROUPS: readonly (MaterialDimension | null)[] = ["two-d", "three-d", null];

export function materialManagerPanel(
  document: SceneDocument,
  state: MaterialManagerState = {},
): UiNode {
  const selectedObjects = state.selectedObjectIds ?? [];
  const groups = GROUPS.map((dimension) => {
    const members = document.materials.filter(
      (material) => dimensionOf(material.kind) === dimension,
    );
    return {
      id: `material-manager/${dimension ?? "shader"}`,
      role: "list" as const,
      label: groupLabel(dimension),
      description:
        members.length === 0
          ? `no ${groupLabel(dimension).toLowerCase()} in this scene`
          : `${members.length} material(s)`,
      children: members.map((material) =>
        materialRow(document, material, state, selectedObjects),
      ),
    };
  });

  return {
    id: "material-manager",
    role: "region",
    label: "Materials",
    description: `${document.materials.length} material(s) in ${document.name}`,
    children: groups,
  };
}

function materialRow(
  document: SceneDocument,
  material: MaterialDefinition,
  state: MaterialManagerState,
  selectedObjects: readonly string[],
): UiNode {
  const users = usersOf(document, material.materialId);
  const shared = users.length > 1;
  const selected = state.selectedMaterialId === material.materialId;

  // Everything an author needs before they touch it: what it is, what it
  // paints, and how many other objects they are about to restyle.
  const summary = [
    material.kind,
    describePaint(material),
    describeTextures(material, document),
    material.blendMode === "normal" ? undefined : `blend ${material.blendMode}`,
    material.opacity === 1 ? undefined : `opacity ${Math.round(material.opacity * 100)}%`,
  ]
    .filter((part): part is string => part !== undefined)
    .join(" · ");

  return {
    id: `material/${material.materialId}`,
    role: "listitem",
    label: material.name,
    // The count is the warning. "Shared by 7 objects" is the sentence that
    // stops an author editing the wrong thing.
    description: shared
      ? `shared by ${users.length} objects — ${summary}`
      : users.length === 1
        ? `used by 1 object — ${summary}`
        : `unused — ${summary}`,
    selected,
    value: material.kind,
    actions: [
      {
        name: "edit",
        label: "Edit",
        // Not blocked — editing a shared material is legitimate and common.
        // The panel's job is to make sure it is never a surprise.
      },
      { name: "duplicate", label: "Duplicate" },
      {
        name: "assign",
        label: "Assign to selection",
        ...assignAvailability(document, selectedObjects),
      },
      {
        name: "relink",
        label: "Relink",
        ...(document.materials.length > 1
          ? {}
          : { unavailable: "there is no other material to relink onto" }),
      },
      {
        name: "delete",
        label: "Delete",
        ...(users.length === 0
          ? {}
          : {
              unavailable: `${material.name} is used by ${users.length} object(s); relink them first`,
            }),
      },
    ],
    children: [
      {
        id: `material/${material.materialId}/usage`,
        role: "gridcell",
        label: "Used by",
        value: users.length === 0 ? "nothing" : users.join(", "),
      },
      ...(isLit(material.kind) ? [lightingRow(material)] : []),
      ...material.textures.map((texture) => textureRow(document, material, texture, state)),
    ],
  };
}

/// Why assigning to the current selection cannot run, when it cannot.
function assignAvailability(
  document: SceneDocument,
  selectedObjects: readonly string[],
): { unavailable?: string } {
  if (selectedObjects.length === 0) {
    return { unavailable: "select an object to assign this material to" };
  }
  const withoutSlots = selectedObjects.filter((id) => {
    const object = document.objects.find((candidate) => candidate.id === id);
    return object === undefined || materialElementsOf(object).length === 0;
  });
  if (withoutSlots.length > 0) {
    // Naming the object is the whole point: "some objects cannot take a
    // material" leaves the author to work out which.
    return {
      unavailable: `${withoutSlots.join(", ")} has no material slot to assign to`,
    };
  }
  return {};
}

function lightingRow(material: MaterialDefinition): UiNode {
  const lighting = material.lighting;
  return {
    id: `material/${material.materialId}/lighting`,
    role: "gridcell",
    label: "Surface",
    // A lit material with no lighting block is governed by the contract's
    // defaults. Saying so beats an empty cell that reads as "no lighting".
    value: lighting
      ? `metallic ${lighting.metallic}, roughness ${lighting.roughness}, emissive ${rgbaHex(
          lighting.emissive,
        )} ×${lighting.emissiveIntensity}`
      : "contract defaults — this material carries no lighting of its own",
  };
}

function textureRow(
  document: SceneDocument,
  material: MaterialDefinition,
  texture: MaterialTextureSlot,
  state: MaterialManagerState,
): UiNode {
  const asset = document.assets.find((item) => item.assetId === texture.assetId);
  const missing = asset === undefined;
  return {
    id: `material/${material.materialId}/texture/${texture.slot}`,
    role: "gridcell",
    label: `Texture ${texture.slot}`,
    selected:
      state.selectedMaterialId === material.materialId &&
      state.selectedTextureSlot === texture.slot,
    value: missing
      ? `${texture.assetId} — missing from the asset library`
      : `${asset.name} · ${texture.fit} · ${texture.wrap} · ${texture.filtering} · ${texture.colorSpace}`,
    actions: [
      { name: "select-texture", label: "Edit texture" },
      { name: "remove-texture", label: "Remove texture" },
    ],
  };
}
