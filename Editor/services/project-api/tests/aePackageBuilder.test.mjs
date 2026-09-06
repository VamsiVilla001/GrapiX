import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * Publishing an After Effects package.
 *
 * These pin the promises a published package makes: it refuses rather than shipping a hole, a
 * version is immutable and never overwritten, a failed publish leaves nothing behind, footage
 * travels with the project and is deduped, and nothing a manifest says can write outside the
 * package directory.
 */

const { buildAePackage, validateAePublish, listAePackageVersions } =
  await import("../dist/ae/aePackageBuilder.js");
const { collectAeFootage } = await import("../dist/ae/aeFootageCollector.js");

async function workspace() {
  const root = await mkdtemp(path.join(tmpdir(), "grapix-ae-pkg-"));
  const source = path.join(root, "source");
  await mkdir(source, { recursive: true });
  return { root, source };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** A minimal but valid publish request, with the project bytes already on disk. */
async function makeRequest(space, overrides = {}) {
  const projectPath = path.join(space.source, "Scoreboard.aep");
  const projectBytes = Buffer.from("RIFX....Egg! fake project bytes");
  await writeFile(projectPath, projectBytes);

  const logo = path.join(space.source, "india.png");
  await writeFile(logo, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]));

  const container = {
    schemaVersion: 1,
    id: "scoreboard",
    name: "Scoreboard",
    projectUri: "Scoreboard.aep",
    projectDigest: sha256(projectBytes),
    profile: { aeVersion: "26.3", renderer: "Classic 3D", workingColorSpace: "sRGB", frameRate: "30000/1001" },
    compositions: [{ itemId: 1, name: "MAIN", width: 1920, height: 1080, clock: { numerator: 30000, denominator: 1001 } }],
    cachePolicy: { mode: "bounded", maxPreparedFrames: 8 },
    controls: [control()],
    dataBindings: [],
    status: "offline",
    createdAt: "2026-08-26T00:00:00.000Z",
    updatedAt: "2026-08-26T00:00:00.000Z",
    ...overrides.container
  };

  const manifest = {
    formatVersion: 1,
    producer: "aep-native",
    projectName: "Scoreboard",
    sourceFile: projectPath,
    frameRate: 29.97,
    compositions: [{
      id: "1", name: "MAIN", width: 1920, height: 1080, duration: 10, frameRate: 29.97,
      displayStartTime: 0, workAreaStart: 0, workAreaDuration: 10, backgroundColor: "#000000",
      // A layer that actually draws the footage: the package collects what the composition uses,
      // so an asset no layer references is correctly not part of this graphic.
      layers: [layer({ index: 1, name: "Logo", type: "image", sourceItemId: "2" })],
      markers: []
    }],
    assets: [{ id: "2", name: "india.png", kind: "footage", sourcePath: logo, mediaType: "image" }],
    fonts: [{ family: "Inter", style: "Bold", usedBy: ["Team_A_Name"] }],
    warnings: [],
    ...overrides.manifest
  };

  return {
    container,
    manifest,
    projectPath,
    graphicRoot: path.join(space.root, "Scoreboard"),
    ...overrides.request
  };
}

function layer(overrides = {}) {
  return {
    index: 1, name: "Layer", type: "solid", inPoint: 0, outPoint: 1, startTime: 0, stretch: 1,
    visible: true, locked: false, shy: false, solo: false, is3d: false, guide: false,
    collapseTransformations: false, continuouslyRasterize: false, motionBlur: false,
    frameBlending: false, blendingMode: "normal", anchorPoint: [], position: [], scale: [],
    rotation: [], opacity: 100, streams: [], masks: [], markers: [], effects: [],
    status: "native-editable",
    ...overrides
  };
}

function control(overrides = {}) {
  return {
    controlId: "11111111-1111-4111-8111-111111111111",
    displayName: "Team A Name",
    kind: "text",
    writable: true,
    updatePolicy: "immediate",
    target: { compositionItemId: 1, layerId: 3, sourceItemId: null, propertyPath: [{ matchName: "ADBE Text Document", ordinal: 0 }] },
    validation: { status: "valid", reason: null, validatedProjectDigest: null, structuralFingerprint: null, validatedAt: null },
    ...overrides
  };
}

test("a valid graphic publishes as v001 with the whole package layout", async (t) => {
  const space = await workspace();
  t.after(() => rm(space.root, { recursive: true, force: true }));

  const built = await buildAePackage(await makeRequest(space));

  assert.equal(built.version, 1);
  assert.equal(path.basename(built.directory), "v001");

  const read = async (relative) => JSON.parse(await readFile(path.join(built.directory, relative), "utf8"));
  const manifest = await read("grapix/manifest.json");
  const controls = await read("grapix/controls.json");
  const animations = await read("grapix/animations.json");
  const dependencies = await read("grapix/dependencies.json");
  const checksums = await read("grapix/checksums.json");

  assert.equal(manifest.id, "scoreboard");
  assert.equal(manifest.version, 1);
  assert.equal(manifest.mainComposition.name, "MAIN");
  // Nothing rewrote the .aep, so the package must say how footage is expected to resolve.
  assert.equal(manifest.footageResolution, "runtime-relink");
  assert.equal(controls.controls.length, 1);
  assert.deepEqual(animations.actions, []);
  assert.equal(dependencies.afterEffects.minimumVersion, "26.3");
  assert.deepEqual(dependencies.fonts[0].family, "Inter");
  assert.equal(checksums.algorithm, "sha256");

  // The project travelled, and its digest is recorded as what actually shipped.
  const projectBytes = await readFile(path.join(built.directory, manifest.aeProject));
  assert.equal(sha256(projectBytes), manifest.projectDigest);
  assert.equal(checksums.files[manifest.aeProject], manifest.projectDigest);
});

test("footage travels with the project and keeps a relink key", async (t) => {
  const space = await workspace();
  t.after(() => rm(space.root, { recursive: true, force: true }));

  const built = await buildAePackage(await makeRequest(space));
  const [asset] = built.manifest.assets;

  assert.equal(asset.packagedPath, "assets/images/india.png");
  // Both paths are kept: the source path is the only key a runtime relink can match a layer on.
  assert.ok(path.isAbsolute(asset.sourcePath));
  const copied = await readFile(path.join(built.directory, asset.packagedPath));
  assert.equal(sha256(copied), asset.checksum);
});

test("a second publish becomes v002 and leaves v001 untouched", async (t) => {
  const space = await workspace();
  t.after(() => rm(space.root, { recursive: true, force: true }));

  const first = await buildAePackage(await makeRequest(space));
  const firstManifestBefore = await readFile(path.join(first.directory, "grapix/manifest.json"), "utf8");

  const second = await buildAePackage(await makeRequest(space));
  assert.equal(second.version, 2);
  assert.equal(path.basename(second.directory), "v002");

  // A published version can be on air; publishing again must not touch its bytes.
  const firstManifestAfter = await readFile(path.join(first.directory, "grapix/manifest.json"), "utf8");
  assert.equal(firstManifestAfter, firstManifestBefore);
  assert.deepEqual(await listAePackageVersions(first.directory.replace(/[\\/]Published[\\/]v001$/, "")), [1, 2]);
});

test("missing footage refuses the publish and names the file", async (t) => {
  const space = await workspace();
  t.after(() => rm(space.root, { recursive: true, force: true }));

  const request = await makeRequest(space);
  request.manifest.assets = [
    { id: "3", name: "intro.mov", kind: "footage", sourcePath: path.join(space.source, "intro.mov"), mediaType: "video", missing: true }
  ];
  request.manifest.compositions[0].layers = [layer({ index: 1, name: "Intro", type: "video", sourceItemId: "3" })];

  const validation = await validateAePublish(request);
  assert.equal(validation.ok, false);
  const refusal = validation.refusals.find((entry) => entry.code === "MISSING_FOOTAGE");
  assert.ok(refusal, "missing footage must refuse");
  // "3 files missing" is not something an author can act on; the filename is.
  assert.match(refusal.message, /intro\.mov/);

  await assert.rejects(() => buildAePackage(request), (error) => error.code === "VALIDATION_FAILED");
});

test("a project edited since the container was created refuses", async (t) => {
  const space = await workspace();
  t.after(() => rm(space.root, { recursive: true, force: true }));

  const request = await makeRequest(space);
  await writeFile(request.projectPath, Buffer.from("RIFX....Egg! different bytes"));

  const validation = await validateAePublish(request);
  assert.equal(validation.ok, false);
  assert.ok(validation.refusals.some((entry) => entry.code === "PROJECT_DIGEST_MISMATCH"));
});

test("a control that no longer resolves refuses; a stale one only warns", async (t) => {
  const space = await workspace();
  t.after(() => rm(space.root, { recursive: true, force: true }));

  const broken = await makeRequest(space, {
    container: { controls: [control({ validation: { status: "rebind-required", reason: "layer deleted", validatedProjectDigest: null, structuralFingerprint: null, validatedAt: null } })] }
  });
  const brokenResult = await validateAePublish(broken);
  assert.equal(brokenResult.ok, false);
  assert.ok(brokenResult.refusals.some((entry) => entry.code === "CONTROL_TARGET_STALE"));

  const stale = await makeRequest(space, {
    container: { controls: [control({ validation: { status: "stale", reason: null, validatedProjectDigest: null, structuralFingerprint: null, validatedAt: null } })] }
  });
  const staleResult = await validateAePublish(stale);
  assert.equal(staleResult.ok, true, "a stale control is a warning, not a refusal");
});

test("a third-party effect warns but never blocks, and reaches dependencies.json", async (t) => {
  const space = await workspace();
  t.after(() => rm(space.root, { recursive: true, force: true }));

  const request = await makeRequest(space);
  request.manifest.compositions[0].layers = [layer({
    index: 1, name: "Glow", sourceItemId: "2",
    effects: [
      { name: "Example Glow", matchName: "XYZ Example Glow", enabled: true, parameters: {}, status: "baked" },
      { name: "Gaussian Blur", matchName: "ADBE Gaussian Blur 2", enabled: true, parameters: {}, status: "native-editable" }
    ]
  })];

  const validation = await validateAePublish(request);
  // A missing plugin is a fact about the playout machine, so it is recorded for Playout to check
  // rather than blocking a publish on the authoring machine.
  assert.equal(validation.ok, true);
  assert.ok(validation.warnings.some((entry) => entry.code === "THIRD_PARTY_PLUGIN"));

  const built = await buildAePackage(request);
  const dependencies = JSON.parse(await readFile(path.join(built.directory, "grapix/dependencies.json"), "utf8"));
  assert.equal(dependencies.plugins.length, 1, "Adobe's own effects are not dependencies");
  assert.equal(dependencies.plugins[0].matchName, "XYZ Example Glow");
  assert.equal(dependencies.plugins[0].required, true);
});

test("a non-rational frame rate refuses", async (t) => {
  const space = await workspace();
  t.after(() => rm(space.root, { recursive: true, force: true }));

  for (const frameRate of ["29.97", "", "30000/0", "abc"]) {
    const request = await makeRequest(space, {
      container: { profile: { aeVersion: "26.3", renderer: "Classic 3D", workingColorSpace: "sRGB", frameRate } }
    });
    const validation = await validateAePublish(request);
    assert.ok(
      validation.refusals.some((entry) => entry.code === "FRAME_RATE_UNSUPPORTED"),
      `${frameRate || "(empty)"} must refuse`
    );
  }

  // A whole-number rate is a rational with denominator 1 and must be accepted.
  const fifty = await makeRequest(space, {
    container: { profile: { aeVersion: "26.3", renderer: "Classic 3D", workingColorSpace: "sRGB", frameRate: "50" } }
  });
  const ok = await validateAePublish(fifty);
  assert.ok(!ok.refusals.some((entry) => entry.code === "FRAME_RATE_UNSUPPORTED"));
});

test("footage missing from disk is refused before anything is written", async (t) => {
  const space = await workspace();
  t.after(() => rm(space.root, { recursive: true, force: true }));

  const request = await makeRequest(space);
  // The manifest still lists it, and the parser never said it was missing — only the filesystem
  // disagrees. This is the real case: a project authored on another machine parses clean.
  await rm(path.join(space.source, "india.png"));

  const validation = await validateAePublish(request);
  assert.equal(validation.ok, false);
  const refusal = validation.refusals.find((entry) => entry.code === "MISSING_FOOTAGE");
  assert.ok(refusal, "a file that is not on disk must refuse");
  assert.match(refusal.message, /india\.png/);

  await assert.rejects(() => buildAePackage(request), (error) => error.code === "VALIDATION_FAILED");
  assert.deepEqual(await listAePackageVersions(request.graphicRoot), []);
});

test("a publish that fails while writing leaves no version directory behind", async (t) => {
  const space = await workspace();
  t.after(() => rm(space.root, { recursive: true, force: true }));

  // Validation passes — the footage is on disk — and the failure happens during collection, which
  // is the only way to reach the staging rollback. An aborted signal is a deterministic stand-in
  // for the real cases (a disk filling, a file locked mid-copy) that cannot be staged reliably.
  const request = await makeRequest(space);
  request.signal = AbortSignal.abort();

  assert.equal((await validateAePublish(request)).ok, true);
  await assert.rejects(() => buildAePackage(request), (error) => error.code === "PACKAGE_WRITE_FAILED");

  // A half-written v001 would list in the library and fail at take, and the staging directory it
  // was assembled in must not survive either.
  assert.deepEqual(await listAePackageVersions(request.graphicRoot), []);
  const entries = await readdir(path.join(request.graphicRoot, "Published")).catch(() => []);
  assert.deepEqual(entries, []);
});

test("identical bytes are stored once", async (t) => {
  const space = await workspace();
  t.after(() => rm(space.root, { recursive: true, force: true }));

  const copy = path.join(space.source, "india-copy.png");
  await writeFile(copy, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]));

  const request = await makeRequest(space);
  request.manifest.assets.push({ id: "4", name: "india-copy.png", kind: "footage", sourcePath: copy, mediaType: "image" });
  request.manifest.compositions[0].layers.push(layer({ index: 2, name: "Logo copy", type: "image", sourceItemId: "4" }));

  const built = await buildAePackage(request);
  const stored = await readdir(path.join(built.directory, "assets", "images"));
  // A logo referenced by forty layers is one file in the package.
  assert.deepEqual(stored, ["india.png"]);
  assert.equal(built.manifest.assets.length, 2, "both references are still described");
});

test("a manifest path cannot write outside the package", async (t) => {
  const space = await workspace();
  t.after(() => rm(space.root, { recursive: true, force: true }));

  const escape = path.join(space.source, "escape.png");
  await writeFile(escape, Buffer.from("x"));
  const packageRoot = path.join(space.root, "pkg");
  await mkdir(packageRoot, { recursive: true });

  const result = await collectAeFootage(
    {
      formatVersion: 1, producer: "aep-native", projectName: "P", sourceFile: path.join(space.source, "P.aep"),
      frameRate: 25, compositions: [], fonts: [], warnings: [],
      assets: [{ id: "1", name: "../../../evil.png", kind: "footage", sourcePath: escape, mediaType: "image" }]
    },
    packageRoot
  );

  // The traversal is stripped by the filename sanitiser rather than trusted.
  assert.equal(result.assets.length, 1);
  assert.ok(result.assets[0].packagedPath.startsWith("assets/images/"));
  assert.ok(!result.assets[0].packagedPath.includes(".."));
});

test("footage another composition uses is neither refused nor packaged", async (t) => {
  const space = await workspace();
  t.after(() => rm(space.root, { recursive: true, force: true }));

  const request = await makeRequest(space);
  // A second composition, not the one being published, pointing at a file that does not exist —
  // the real shape of a production project, where one .aep holds hundreds of unrelated comps.
  request.manifest.compositions.push({
    id: "99", name: "UNRELATED", width: 1920, height: 1080, duration: 5, frameRate: 29.97,
    displayStartTime: 0, workAreaStart: 0, workAreaDuration: 5, backgroundColor: "#000000",
    layers: [layer({ index: 1, name: "Old", type: "image", sourceItemId: "98" })], markers: []
  });
  request.manifest.assets.push({
    id: "98", name: "gone.png", kind: "footage", mediaType: "image",
    sourcePath: "/Volumes/SomeoneElse/gone.png"
  });

  // Publishing MAIN must not be blocked by UNRELATED's broken link.
  const validation = await validateAePublish(request);
  assert.equal(validation.ok, true, `unrelated footage must not refuse: ${JSON.stringify(validation.refusals)}`);

  const built = await buildAePackage(request);
  const packaged = built.manifest.assets.map((asset) => asset.name);
  assert.deepEqual(packaged, ["india.png"], "only what MAIN draws is shipped");
});

test("a precomp's footage is followed, and a cycle terminates", async (t) => {
  const space = await workspace();
  t.after(() => rm(space.root, { recursive: true, force: true }));

  const nested = path.join(space.source, "nested.png");
  await writeFile(nested, Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 9, 9, 9]));

  const request = await makeRequest(space);
  // MAIN -> PRE -> nested.png, and PRE points back at MAIN. After Effects will hold such a project;
  // a naive walk would not terminate on it.
  request.manifest.compositions[0].layers.push(layer({ index: 2, name: "Pre", type: "precomp", sourceItemId: "50" }));
  request.manifest.compositions.push({
    id: "50", name: "PRE", width: 960, height: 540, duration: 5, frameRate: 29.97,
    displayStartTime: 0, workAreaStart: 0, workAreaDuration: 5, backgroundColor: "#000000",
    layers: [
      layer({ index: 1, name: "Nested", type: "image", sourceItemId: "51" }),
      layer({ index: 2, name: "Back to main", type: "precomp", sourceItemId: "1" })
    ],
    markers: []
  });
  request.manifest.assets.push({ id: "51", name: "nested.png", kind: "footage", sourcePath: nested, mediaType: "image" });

  const built = await buildAePackage(request);
  assert.deepEqual(built.manifest.assets.map((asset) => asset.name).sort(), ["india.png", "nested.png"]);
});
