import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * A real After Effects project, all the way through GrapiX to a published package.
 *
 * Everything above this file is unit-tested against synthetic fixtures. This one runs the actual
 * certification project — a 151 KB binary `.aep` authored in After Effects — through the whole
 * publish path: parse the binary, declare a runtime container against its real compositions,
 * validate, and write an immutable package.
 *
 * It exists because every part of that chain can pass its own tests and still not compose. The
 * parser could return a shape the container rejects; the container's digest could be computed over
 * different bytes than the publisher copies; the package could be written somewhere Playout does
 * not look. Only running one real project end to end proves otherwise.
 *
 * The environment is set before the first import on purpose: `storage.js` resolves its data root at
 * module load, so setting it afterwards would silently write into the repository's own `data/`.
 */
const dataRoot = await mkdtemp(path.join(tmpdir(), "grapix-ae-e2e-data-"));
const projectRoot = await mkdtemp(path.join(tmpdir(), "grapix-ae-e2e-projects-"));
process.env.GRAPIX_DATA_ROOT = dataRoot;
process.env.GRAPIX_AE_PROJECT_ROOTS = projectRoot;

const { parseAepToManifest } = await import("@grapix/adobe-common-schema");
const { createAeRuntimeContainer } = await import("../dist/storage.js");
const { publishAeContainer, validateAeContainerPublish, listAeGraphicVersions, aeGraphicRoot } =
  await import("../dist/ae/aePublishService.js");

const FIXTURE = fileURLToPath(
  new URL("../../../../tools/certification/ae-runtime-fixtures/v1/fixtures/lower-third.aep", import.meta.url)
);

test.after(async () => {
  await rm(dataRoot, { recursive: true, force: true });
  await rm(projectRoot, { recursive: true, force: true });
});

/** Copy the certification project into an allowlisted root and declare a container for it. */
async function stageLowerThird(containerId) {
  const projectPath = path.join(projectRoot, `${containerId}.aep`);
  await copyFile(FIXTURE, projectPath);
  const bytes = await readFile(projectPath);
  const digest = createHash("sha256").update(bytes).digest("hex");

  // The container's compositions come from the parsed project, not from hand-written numbers:
  // that is the seam this test exists to prove.
  const manifest = parseAepToManifest(bytes, "Lower Third", projectPath);
  const [comp] = manifest.compositions;
  const itemId = Number(comp.id) || 1;

  const container = await createAeRuntimeContainer({
    id: containerId,
    name: "Lower Third",
    projectUri: `${containerId}.aep`,
    projectDigest: digest,
    profile: {
      aeVersion: "26.3",
      renderer: "Classic 3D",
      workingColorSpace: "sRGB",
      // 29.97 is 30000/1001 exactly; the float the parser reports is never the clock.
      frameRate: "30000/1001"
    },
    compositions: [{
      itemId,
      name: comp.name,
      width: comp.width,
      height: comp.height,
      clock: { frameDuration: "1001", timeScale: "30000" }
    }],
    cachePolicy: { mode: "bounded", maxPreparedFrames: 8 },
    controls: [{
      controlId: "6f9619ff-8b86-4d11-b42d-00c04fc964ff",
      displayName: "Player Name",
      kind: "text",
      writable: true,
      updatePolicy: "immediate",
      target: {
        compositionItemId: itemId,
        layerId: 2,
        sourceItemId: null,
        propertyPath: [{ matchName: "ADBE Text Document", ordinal: 0 }]
      },
      validation: {
        status: "valid",
        reason: null,
        validatedProjectDigest: digest,
        structuralFingerprint: null,
        validatedAt: "2026-08-27T00:00:00.000Z"
      }
    }],
    dataBindings: []
  });

  return { container, manifest, comp, digest, projectPath };
}

test("the real certification project parses into the shape a container needs", async () => {
  const bytes = await readFile(FIXTURE);
  const manifest = parseAepToManifest(bytes, "Lower Third", FIXTURE);

  assert.equal(manifest.producer, "aep-native", "read from the binary, with no After Effects installed");
  assert.equal(manifest.compositions.length, 1);

  const [comp] = manifest.compositions;
  assert.equal(comp.name, "LOWER_THIRD");
  assert.equal(comp.width, 1920);
  assert.equal(comp.height, 1080);
  assert.equal(comp.layers.length, 5);

  // The layers a broadcast operator would actually drive.
  const names = comp.layers.map((layer) => layer.name);
  for (const expected of ["SCORE", "PLAYER_NAME", "PLAYER_IMAGE", "TEAM_COLOR", "BAR"]) {
    assert.ok(names.includes(expected), `${expected} must survive the parse`);
  }
  assert.equal(comp.layers.find((layer) => layer.name === "PLAYER_NAME").type, "text");

  // The font is a real dependency the playout machine will need.
  assert.deepEqual(manifest.fonts.map((font) => font.family), ["Bastler"]);
});

test("a real project publishes to v001, and the package is complete", async () => {
  const { container, comp, digest } = await stageLowerThird("lower-third");

  const validation = await validateAeContainerPublish({ containerId: container.id });
  assert.equal(validation.ok, true, `publish must validate: ${JSON.stringify(validation.refusals)}`);

  const built = await publishAeContainer({
    containerId: container.id,
    actions: [
      { role: "IN", startFrame: 0, endFrame: 20 },
      { role: "LOOP", startFrame: 20, endFrame: 200, holds: true },
      { role: "OUT", startFrame: 200, endFrame: 220 }
    ]
  });

  assert.equal(built.version, 1);
  assert.equal(path.basename(built.directory), "v001");
  // The package lands under the data root, never inside the designer's project root.
  assert.ok(built.directory.startsWith(aeGraphicRoot("lower-third")));
  assert.ok(!built.directory.startsWith(projectRoot));

  const read = async (relative) => JSON.parse(await readFile(path.join(built.directory, relative), "utf8"));
  const manifest = await read("grapix/manifest.json");
  const controls = await read("grapix/controls.json");
  const animations = await read("grapix/animations.json");
  const dependencies = await read("grapix/dependencies.json");
  const checksums = await read("grapix/checksums.json");

  assert.equal(manifest.mainComposition.name, comp.name);
  assert.equal(manifest.mainComposition.width, 1920);
  assert.equal(manifest.profile.frameRate, "30000/1001");
  assert.equal(manifest.footageResolution, "runtime-relink");
  // The digest recorded is of the bytes that shipped, and they are the bytes the container declared.
  assert.equal(manifest.sourceProjectDigest, digest);

  // The .aep really travelled, byte for byte.
  const packaged = await readFile(path.join(built.directory, manifest.aeProject));
  assert.equal(createHash("sha256").update(packaged).digest("hex"), manifest.projectDigest);
  assert.equal(packaged.length, (await readFile(FIXTURE)).length);

  // The operator surface and the broadcast actions Playout will drive.
  assert.equal(controls.controls[0].displayName, "Player Name");
  assert.deepEqual(animations.actions.map((action) => action.role), ["IN", "LOOP", "OUT"]);

  // The real font dependency reaches Playout's preflight.
  assert.deepEqual(dependencies.fonts.map((font) => font.family), ["Bastler"]);
  assert.equal(dependencies.afterEffects.minimumVersion, "26.3");

  // Every shipped file is checksummed, so a transferred package can be proven intact.
  assert.ok(checksums.files[manifest.aeProject]);
  assert.ok(Object.keys(checksums.files).length >= 5);
});

test("publishing again makes v002 and leaves v001 byte-identical", async () => {
  const { container } = await stageLowerThird("lower-third-versions");

  const first = await publishAeContainer({ containerId: container.id });
  const before = await readFile(path.join(first.directory, "grapix/manifest.json"), "utf8");

  const second = await publishAeContainer({ containerId: container.id });
  assert.equal(second.version, 2);

  // A published version can be on air; a later publish must not touch its bytes.
  const after = await readFile(path.join(first.directory, "grapix/manifest.json"), "utf8");
  assert.equal(after, before);
  assert.deepEqual(await listAeGraphicVersions("lower-third-versions"), [1, 2]);

  // No staging directory survives a successful publish.
  const published = await readdir(path.join(aeGraphicRoot("lower-third-versions"), "Published"));
  assert.deepEqual(published.sort(), ["v001", "v002"]);
});

test("editing the project after the container was declared refuses the publish", async () => {
  const { container, projectPath } = await stageLowerThird("lower-third-drift");

  // The designer keeps working: the bytes now differ from the ones the controls were validated
  // against, so publishing them would ship controls nothing ever checked.
  const bytes = await readFile(projectPath);
  await writeFile(projectPath, Buffer.concat([bytes, Buffer.from("edited")]));

  // Two guards stand between an edited project and a package, and the container store's fires
  // first: it refuses to hand back a container whose authoritative project no longer matches its
  // recorded digest, so the publisher never sees the drifted bytes at all. The builder keeps its
  // own PROJECT_DIGEST_MISMATCH refusal for callers that assemble a request by hand.
  await assert.rejects(
    () => validateAeContainerPublish({ containerId: container.id }),
    (error) => /digest changed/i.test(String(error.message))
  );
  await assert.rejects(
    () => publishAeContainer({ containerId: container.id }),
    (error) => /digest changed/i.test(String(error.message))
  );

  // And nothing was published as a side effect of trying.
  assert.deepEqual(await listAeGraphicVersions("lower-third-drift"), []);
});
