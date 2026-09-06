import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { inspectAeImport } from "../dist/importers/aeImporter.js";
import { validateImportedAsset } from "../dist/importers/assetValidation.js";
import { inspectModelImport } from "../dist/importers/modelImporter.js";
import { inspectSceneScript } from "../dist/importers/sceneScriptImporter.js";

const AEP_FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../Shared/adobe-common-schema/tests/fixtures/aep/Item-01.aep"
);

test("an .aep reports the uploaded project's readable structure without claiming conversion", () => {
  const report = inspectAeImport("Item-01.aep", readFileSync(AEP_FIXTURE));
  assert.equal(report.accepted, false);
  assert.equal(report.sourceType, "aep");
  assert.equal(report.inspection?.producer, "aep-native");
  assert.equal(report.inspection?.compositions, 2);
  assert.ok(report.inspection?.layers > 0);
  assert.ok(report.importedItems.some((item) => item.includes("Comp 01")));
  assert.ok(report.importedItems.some((item) => item.includes("Null 1")));
  assert.ok(report.missingFootage.some((item) => item.includes("Missing Footage")));
  assert.match(report.colorWarnings.join(" "), /static inspection only/i);
  assert.deepEqual(report.convertedItems, [], "inspection may never report a conversion");
});

test("a corrupt .aep reports the parser diagnostic rather than project contents", () => {
  const report = inspectAeImport("corrupt.aep", Buffer.from("not a RIFX project"));
  assert.equal(report.accepted, false);
  assert.equal(report.inspection, undefined);
  assert.match(report.unsupportedItems.join(" "), /AEP parse diagnostic.*RIFX/i);
});


test("a truncated .aep exposes its partial read as evidence and a warning", () => {
  const truncated = Buffer.alloc(32);
  truncated.write("RIFX", 0);
  truncated.writeUInt32BE(24, 4);
  truncated.write("Egg!", 8);
  truncated.write("LIST", 12);
  truncated.writeUInt32BE(12, 16);
  truncated.write("Fold", 20);
  truncated.write("junk", 24);
  truncated.writeUInt32BE(0xffff, 28);

  const report = inspectAeImport("truncated.aep", truncated);
  assert.match(report.inspection?.evidence ?? "", /partial read/i);
  assert.match(report.colorWarnings.join(" "), /ended early/i);
});
test("an .aepx is inspected through the direct XML parser", () => {
  const report = inspectAeImport("show.aepx", Buffer.from(`
    <Project><ItemList><Item><type>Composition</type><name>Title</name><id>comp-1</id>
    <width>1920</width><height>1080</height><frameRate>25</frameRate><duration>1</duration>
    <LayerList><Layer><name>Lower third</name><objectType>0</objectType></Layer></LayerList>
    </Item></ItemList></Project>
  `));
  assert.equal(report.accepted, false);
  assert.equal(report.inspection?.producer, "aepx-direct");
  assert.equal(report.inspection?.compositions, 1);
  assert.ok(report.importedItems.some((item) => item.includes("Title")));
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

test("scene-script inspection walks syntax instead of matching comments or strings", () => {
  const report = inspectSceneScript(
    Buffer.from("// eval('comment only')\nexport default defineSceneScript({ label: 'require(fetch)' });"),
    "safe.mjs"
  );
  assert.equal(report.accepted, true);
  assert.deepEqual(report.errors, []);
});

test("scene-script inspection rejects computed and unicode-escaped host access", () => {
  const computed = inspectSceneScript(
    Buffer.from("export default defineSceneScript(globalThis['pro' + 'cess'].env);"),
    "computed.mjs"
  );
  assert.equal(computed.accepted, false);
  assert.ok(computed.errors.includes("host globals are not allowed"));

  const unicode = inspectSceneScript(
    Buffer.from("export default defineSceneScript(\\u0065val('unsafe'));"),
    "unicode.mjs"
  );
  assert.equal(unicode.accepted, false);
  assert.ok(unicode.errors.includes("dynamic code generation is not allowed"));
});
