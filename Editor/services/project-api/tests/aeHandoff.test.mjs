import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The hand-off between "the Editor published it" and "Playout can drive it".
 *
 * A publish writes an immutable package; Playout reads that package back, verifies every byte, and
 * reconstructs the runtime container its control services act on. This test runs both ends against
 * one real `.aep`: it publishes through the real builder, then reads the result through the shared
 * package reader — the same `readAePackage`/`containerFromAePackage` Playout's ingest store calls —
 * and proves the container that comes back carries the identity, control surface and broadcast
 * clock the publish put in.
 *
 * It lives on the Editor side because that is where the publish runs, and it stays inside the
 * domain boundary: Playout's ingest store is a thin persistence layer over these same shared
 * functions, unit-tested on its own side. What this test proves is the contract they share — that
 * a package the builder writes is a package the reader accepts and the container builder trusts.
 *
 * `GRAPIX_DATA_ROOT` is set before the first import because `storage.js` resolves it at load.
 */
const dataRoot = await mkdtemp(path.join(tmpdir(), "grapix-ae-handoff-data-"));
const projectRoot = await mkdtemp(path.join(tmpdir(), "grapix-ae-handoff-projects-"));
process.env.GRAPIX_DATA_ROOT = dataRoot;
process.env.GRAPIX_AE_PROJECT_ROOTS = projectRoot;

const { parseAepToManifest } = await import("@grapix/adobe-common-schema");
const { readAePackage, containerFromAePackage } = await import("@grapix/ae-runtime-contract");
const { createAeRuntimeContainer } = await import("../dist/storage.js");
const { publishAeContainer } = await import("../dist/ae/aePublishService.js");

const FIXTURE = fileURLToPath(
  new URL("../../../../tools/certification/ae-runtime-fixtures/v1/fixtures/lower-third.aep", import.meta.url)
);

test.after(async () => {
  await rm(dataRoot, { recursive: true, force: true });
  await rm(projectRoot, { recursive: true, force: true });
});

test("a published package verifies and reconstructs into the container Playout will drive", async () => {
  // Publish exactly as the route does: declare a container against the real project, then publish.
  const projectPath = path.join(projectRoot, "lower-third.aep");
  await copyFile(FIXTURE, projectPath);
  const digest = createHash("sha256").update(await readFile(projectPath)).digest("hex");
  const parsed = parseAepToManifest(await readFile(projectPath), "Lower Third", projectPath);
  const [comp] = parsed.compositions;
  const itemId = Number(comp.id) || 1;

  await createAeRuntimeContainer({
    id: "lower-third",
    name: "Lower Third",
    projectUri: "lower-third.aep",
    projectDigest: digest,
    profile: { aeVersion: "26.3", renderer: "Classic 3D", workingColorSpace: "sRGB", frameRate: "30000/1001" },
    compositions: [{
      itemId, name: comp.name, width: comp.width, height: comp.height,
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
        compositionItemId: itemId, layerId: 2, sourceItemId: null,
        propertyPath: [{ matchName: "ADBE Text Document", ordinal: 0 }]
      },
      validation: {
        status: "valid", reason: null, validatedProjectDigest: digest,
        structuralFingerprint: null, validatedAt: "2026-08-27T00:00:00.000Z"
      }
    }],
    dataBindings: []
  });

  const built = await publishAeContainer({ containerId: "lower-third" });
  assert.equal(built.version, 1);

  // --- The Playout end of the handshake: verify the bytes, rebuild the container. ---
  const pkg = await readAePackage(built.directory);
  const container = containerFromAePackage(pkg);

  // Identity survives the round trip.
  assert.equal(pkg.manifest.id, "lower-third");
  assert.equal(container.id, "lower-third");
  assert.equal(pkg.manifest.mainComposition.itemId, itemId);

  // The operator surface is the one the author declared, addressed by item id, not name.
  assert.equal(container.controls.length, 1);
  assert.equal(container.controls[0].displayName, "Player Name");
  assert.equal(container.controls[0].target.compositionItemId, itemId);

  // The broadcast clock crosses unchanged — 29.97 stays 30000/1001, never a float.
  assert.equal(container.profile.frameRate, "30000/1001");

  // The project Playout will launch is the packaged copy, proven by its digest.
  assert.equal(container.projectDigest, pkg.manifest.projectDigest);
  assert.equal(container.projectUri, path.join(built.directory, pkg.manifest.aeProject));
  assert.ok(pkg.projectPath.startsWith(built.directory));

  // The composition the engine attaches carries the exact clock the engine requires.
  const main = container.compositions.find((entry) => entry.itemId === pkg.manifest.mainComposition.itemId);
  assert.ok(main, "the main composition must be in the reconstructed container");
  assert.deepEqual(main.clock, { frameDuration: "1001", timeScale: "30000" });
});
