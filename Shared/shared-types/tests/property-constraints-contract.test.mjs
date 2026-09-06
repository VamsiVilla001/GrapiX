import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { propertyConstraint } from "../dist/index.js";

/**
 * The TypeScript constraint table against the file the Rust renderer's test reads.
 *
 * One number, two languages, asserted from both ends. A table that merely *looked* like the renderer's
 * clamps would drift the first time one side moved, and the drift would be invisible: the scene would
 * quietly store a value the renderer refuses again.
 */

async function loadClamps() {
  const path = new URL("../contracts/renderer-clamps.json", import.meta.url);
  return JSON.parse(await readFile(path, "utf8"));
}

test("every clamp the native renderer owns matches the shared table", async () => {
  const clamps = await loadClamps();
  for (const [objectType, properties] of Object.entries(clamps)) {
    if (objectType.startsWith("$")) continue;
    for (const [property, expected] of Object.entries(properties)) {
      const constraint = propertyConstraint(objectType, property);
      assert.ok(constraint, `${objectType}.${property} is missing from the constraint table`);
      assert.equal(constraint.min, expected.min, `${objectType}.${property} min`);
      assert.equal(constraint.max, expected.max, `${objectType}.${property} max`);
      assert.equal(constraint.fallback, expected.fallback, `${objectType}.${property} fallback`);
    }
  }
});

test("the contract covers the light properties the renderer actually clamps", async () => {
  const clamps = await loadClamps();
  for (const property of ["coneAngleDeg", "penumbra", "intensity", "range", "decay"]) {
    assert.ok(clamps.light[property], `light.${property} should be declared`);
  }
});
