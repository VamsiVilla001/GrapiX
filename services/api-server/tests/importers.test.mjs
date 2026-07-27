import assert from "node:assert/strict";
import test from "node:test";
import { inspectAeImport } from "../dist/importers/aeImporter.js";
import { validateImportedAsset } from "../dist/importers/assetValidation.js";
import { inspectModelImport } from "../dist/importers/modelImporter.js";

test("rejects direct AEP runtime and explains the controlled paths", () => {
  const report = inspectAeImport("show.aep");
  assert.equal(report.accepted, false);
  assert.equal(report.sourceType, "aep");
  assert.match(report.unsupportedItems.join(" "), /cannot execute|forbidden/i);
});

test("classifies supported, baked, and unsupported Lottie layers", () => {
  const report = inspectAeImport("lower-third.json", {
    v: "5.12.0",
    layers: [
      { ty: 4, nm: "Shape", shapes: [{ ty: "sh" }] },
      { ty: 5, nm: "Name" },
      { ty: 1, nm: "Solid with effect", ef: [{}] },
      { ty: 4, nm: "Expression", x: "time*2" }
    ]
  });
  assert.equal(report.sourceType, "lottie");
  assert.equal(report.estimatedRuntimeCost.vectorPaths, 1);
  assert.ok(report.convertedItems.some((item) => item.includes("Shape")));
  assert.ok(report.bakedItems.length);
  assert.ok(report.unsupportedItems.length);
});

test("inspects embedded glTF and enforces profile limits", () => {
  const gltf = Buffer.from(JSON.stringify({
    asset: { version: "2.0" },
    accessors: [{ count: 300_003 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 0, TANGENT: 0 } }] }],
    materials: [{ name: "Studio Body" }, {}],
    buffers: [{ uri: "data:application/octet-stream;base64,AA==", byteLength: 1024 }]
  }));
  const hd = inspectModelImport(gltf, "model.gltf", "PROGRAM_HD");
  const safe = inspectModelImport(gltf, "model.gltf", "SAFE_MODE");
  assert.equal(hd.accepted, true);
  assert.equal(hd.metrics.triangles, 100_001);
  assert.deepEqual(hd.materialNames, ["Studio Body", "Material 2"]);
  assert.equal(safe.accepted, false);
  assert.match(safe.errors.join(" "), /triangles/);
});

test("asset validation rejects path traversal and executable content", () => {
  assert.ok(validateImportedAsset(Buffer.from("MZ"), "../payload.exe").length >= 2);
  assert.deepEqual(
    validateImportedAsset(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]),
      "logo.png"
    ),
    []
  );
});
