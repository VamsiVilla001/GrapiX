import assert from "node:assert/strict";
import test from "node:test";
import { createMaterialDefinition } from "@grapix/shared-types";
import {
  DEFAULT_STANDARD_MATERIAL_ID,
  ensureDefaultStandardMaterial
} from "../src/modules/material-manager/services/defaultMaterial";

test("every scene receives one real assignable Standard Material", () => {
  const materials = ensureDefaultStandardMaterial([]);
  assert.equal(materials.length, 1);
  assert.equal(materials[0].materialId, DEFAULT_STANDARD_MATERIAL_ID);
  assert.equal(materials[0].name, "Standard Material");
  assert.equal(materials[0].type, "pbr");
  assert.equal(materials[0].builtIn, true);
  assert.equal(materials[0].shaderId, "grapix.material.pbr");
});

test("default material insertion is idempotent and preserves project materials", () => {
  const projectMaterial = createMaterialDefinition("Project Material");
  const once = ensureDefaultStandardMaterial([projectMaterial]);
  const twice = ensureDefaultStandardMaterial(once);
  assert.equal(twice.filter((material) => material.materialId === DEFAULT_STANDARD_MATERIAL_ID).length, 1);
  assert.ok(twice.some((material) => material.materialId === projectMaterial.materialId));
});
