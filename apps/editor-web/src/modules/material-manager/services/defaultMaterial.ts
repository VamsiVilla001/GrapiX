import {
  createMaterialDefinition,
  type Material
} from "@grapix/shared-types";

export const DEFAULT_STANDARD_MATERIAL_ID = "grapix.material.default";

/**
 * Every scene exposes one real, assignable Standard Material resource.
 * The WGSL shader remains an implementation detail in the Shaders folder.
 */
export function ensureDefaultStandardMaterial(materials: readonly Material[]): Material[] {
  const existing = materials.find((material) =>
    material.materialId === DEFAULT_STANDARD_MATERIAL_ID
    || (material.builtIn && material.shaderId === "grapix.material.pbr")
  );
  if (existing) return [...materials];

  const material = createMaterialDefinition("Standard Material");
  material.materialId = DEFAULT_STANDARD_MATERIAL_ID;
  material.builtIn = true;
  material.tags = ["standard", "physical", "built-in"];
  return [material, ...materials];
}
