import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AE_PACKAGE_PATHS,
  AePackageReadError,
  containerFromAePackage,
  readAePackage
} from "../dist/index.js";

/**
 * The package reader is the only thing standing between Playout and a package that changed after
 * publish. These tests build a real package directory on disk — manifest, controls, checksums and
 * the bytes they cover — then prove the reader refuses every way that package can be wrong, and
 * reconstructs the runtime container only when every byte matches.
 */

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

/** Write a minimal but complete package; `tamper` lets a test break one thing after the fact. */
async function writePackage(root, { manifestOverrides = {}, corruptProject = false } = {}) {
  const project = "PNG not really — but the bytes are what get hashed";
  const manifest = {
    schemaVersion: 1,
    id: "dyno-winner",
    name: "DYno — winner",
    version: 1,
    publishedAt: "2026-08-27T00:00:00.000Z",
    aeProject: "project/DYno.aep",
    projectDigest: sha256(project),
    sourceProjectDigest: sha256(project),
    mainComposition: { itemId: 7, name: "GX_winner", width: 1920, height: 1080 },
    profile: { aeVersion: "26.3", renderer: "Classic 3D", workingColorSpace: "sRGB", frameRate: "25/1" },
    compositions: [
      { itemId: 7, name: "GX_winner", width: 1920, height: 1080, clock: { frameDuration: "1", timeScale: "25" } }
    ],
    cachePolicy: { mode: "bounded", maxPreparedFrames: 8 },
    footageResolution: "runtime-relink",
    assets: [],
    ...manifestOverrides
  };
  const controls = { schemaVersion: 1, controls: [], dataBindings: [] };

  await mkdir(path.join(root, "project"), { recursive: true });
  await mkdir(path.join(root, "grapix"), { recursive: true });
  await writeFile(path.join(root, "project", "DYno.aep"), project);
  await writeFile(path.join(root, AE_PACKAGE_PATHS.manifest), JSON.stringify(manifest));
  await writeFile(path.join(root, AE_PACKAGE_PATHS.controls), JSON.stringify(controls));

  const files = {
    "project/DYno.aep": sha256(project),
    [AE_PACKAGE_PATHS.manifest]: sha256(JSON.stringify(manifest)),
    [AE_PACKAGE_PATHS.controls]: sha256(JSON.stringify(controls))
  };
  // The checksums file is written after the bytes it covers, so it must hash what is actually on
  // disk. A test that wants a mismatch corrupts the project *after* this.
  await writeFile(path.join(root, AE_PACKAGE_PATHS.checksums), JSON.stringify({ algorithm: "sha256", files }));

  if (corruptProject) await writeFile(path.join(root, "project", "DYno.aep"), project + " — edited");
  return { manifest, controls };
}

async function withPackage(run) {
  const root = await mkdtemp(path.join(tmpdir(), "grapix-ae-pkg-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("an intact package reads back its manifest, controls and project path", async () => {
  await withPackage(async (root) => {
    const { manifest } = await writePackage(root);
    const pkg = await readAePackage(root);
    assert.equal(pkg.manifest.id, "dyno-winner");
    assert.equal(pkg.manifest.mainComposition.itemId, 7);
    assert.equal(pkg.projectPath, path.join(root, "project", "DYno.aep"));
    assert.ok(Array.isArray(pkg.controls.controls));
    assert.equal(pkg.manifest.version, manifest.version);
  });
});

test("a single changed byte in the project is refused as a checksum mismatch", async () => {
  await withPackage(async (root) => {
    await writePackage(root, { corruptProject: true });
    await assert.rejects(readAePackage(root), (error) => {
      assert.ok(error instanceof AePackageReadError);
      assert.equal(error.code, "CHECKSUM_MISMATCH");
      return true;
    });
  });
});

test("a missing manifest is not found, not a parse error", async () => {
  await withPackage(async (root) => {
    await assert.rejects(readAePackage(root), (error) => {
      assert.equal(error.code, "PACKAGE_NOT_FOUND");
      return true;
    });
  });
});

test("a checksum that names a file the package does not hold is incomplete", async () => {
  await withPackage(async (root) => {
    await writePackage(root);
    // Point one checksum at a file that was never written.
    const checksumsPath = path.join(root, AE_PACKAGE_PATHS.checksums);
    const checksums = JSON.parse(await import("node:fs/promises").then((fs) => fs.readFile(checksumsPath, "utf8")));
    checksums.files["assets/images/ghost.png"] = sha256("ghost");
    await writeFile(checksumsPath, JSON.stringify(checksums));
    await assert.rejects(readAePackage(root), (error) => {
      assert.equal(error.code, "PACKAGE_INCOMPLETE");
      return true;
    });
  });
});

test("an unsupported schema version is refused before any byte is trusted", async () => {
  await withPackage(async (root) => {
    await writePackage(root, { manifestOverrides: { schemaVersion: 99 } });
    // The manifest changed, so its own checksum no longer matches; rewrite checksums to match the
    // new manifest so the refusal is the schema, not the hash.
    const manifestPath = path.join(root, AE_PACKAGE_PATHS.manifest);
    const manifestRaw = await import("node:fs/promises").then((fs) => fs.readFile(manifestPath, "utf8"));
    const checksumsPath = path.join(root, AE_PACKAGE_PATHS.checksums);
    const checksums = JSON.parse(await import("node:fs/promises").then((fs) => fs.readFile(checksumsPath, "utf8")));
    checksums.files[AE_PACKAGE_PATHS.manifest] = sha256(manifestRaw);
    await writeFile(checksumsPath, JSON.stringify(checksums));
    await assert.rejects(readAePackage(root), (error) => {
      assert.equal(error.code, "SCHEMA_UNSUPPORTED");
      return true;
    });
  });
});

test("the reconstructed container is addressed by identity, not by name", async () => {
  await withPackage(async (root) => {
    await writePackage(root);
    const pkg = await readAePackage(root);
    const container = containerFromAePackage(pkg, new Date("2026-08-27T01:00:00.000Z"));
    assert.equal(container.id, "dyno-winner");
    assert.equal(container.projectDigest, pkg.manifest.projectDigest);
    // The container must point at the packaged project, not the designer's original path.
    assert.equal(container.projectUri, pkg.projectPath);
    assert.equal(container.status, "offline");
    assert.equal(container.updatedAt, "2026-08-27T01:00:00.000Z");
    assert.equal(container.createdAt, pkg.manifest.publishedAt);
    assert.equal(container.compositions[0].itemId, 7);
  });
});
