import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AePackageStore } from "../dist/aePackageStore.js";

/**
 * The ingest store decides which published package an operator may put on air, and refuses to move
 * backwards. These tests write real package directories and prove a re-ingest advances the version
 * while a stale or equal delivery is refused — the guarantee that a late push cannot roll an
 * operator back to old bytes mid-show.
 */

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

async function writePackage(versionRoot, { id, version, name }) {
  const project = `bytes of ${id} v${version}`;
  const manifest = {
    schemaVersion: 1,
    id,
    name,
    version,
    publishedAt: new Date().toISOString(),
    aeProject: "project/p.aep",
    projectDigest: sha256(project),
    sourceProjectDigest: sha256(project),
    mainComposition: { itemId: 1, name, width: 1920, height: 1080 },
    profile: { aeVersion: "26.3", renderer: "Classic 3D", workingColorSpace: "sRGB", frameRate: "25/1" },
    compositions: [{ itemId: 1, name, width: 1920, height: 1080, clock: { frameDuration: "1", timeScale: "25" } }],
    cachePolicy: { mode: "bounded", maxPreparedFrames: 8 },
    footageResolution: "runtime-relink",
    assets: []
  };
  const controls = { schemaVersion: 1, controls: [], dataBindings: [] };
  await mkdir(path.join(versionRoot, "project"), { recursive: true });
  await mkdir(path.join(versionRoot, "grapix"), { recursive: true });
  await writeFile(path.join(versionRoot, "project", "p.aep"), project);
  await writeFile(path.join(versionRoot, "grapix", "manifest.json"), JSON.stringify(manifest));
  await writeFile(path.join(versionRoot, "grapix", "controls.json"), JSON.stringify(controls));
  await writeFile(path.join(versionRoot, "grapix", "checksums.json"), JSON.stringify({
    algorithm: "sha256",
    files: {
      "project/p.aep": sha256(project),
      "grapix/manifest.json": sha256(JSON.stringify(manifest)),
      "grapix/controls.json": sha256(JSON.stringify(controls))
    }
  }));
}

test("a package ingests into a container and a library record", async (t) => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "grapix-ae-ingest-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const versionRoot = path.join(dataRoot, "pkg", "v001");
  await writePackage(versionRoot, { id: "dyno-winner", version: 1, name: "GX_winner" });

  const store = new AePackageStore(dataRoot);
  const { container, manifest } = await store.ingest(versionRoot);
  assert.equal(container.id, "dyno-winner");
  assert.equal(manifest.version, 1);

  const listed = await store.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].graphicId, "dyno-winner");
  assert.equal(listed[0].latestVersion, 1);
  assert.equal(listed[0].versionRoot, versionRoot);

  // The container landed in the shared container store the control services read.
  const readBack = await store.read("dyno-winner");
  assert.equal(readBack.mainComposition.itemId, 1);
});

test("a newer version advances the record; an equal or older one is refused", async (t) => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "grapix-ae-versioning-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const store = new AePackageStore(dataRoot);

  const v1 = path.join(dataRoot, "pkg", "v001");
  const v2 = path.join(dataRoot, "pkg", "v002");
  await writePackage(v1, { id: "dyno-winner", version: 1, name: "GX_winner" });
  await writePackage(v2, { id: "dyno-winner", version: 2, name: "GX_winner" });

  await store.ingest(v1);
  await store.ingest(v2);
  assert.equal((await store.read("dyno-winner")).latestVersion, 2);
  assert.equal((await store.read("dyno-winner")).versionRoot, v2);

  // Re-delivering v1 (a stale push arriving late) must not roll the operator back.
  await assert.rejects(store.ingest(v1), /refused/);
  // Re-delivering the version already ingested is refused too — a duplicate, not an advance.
  await assert.rejects(store.ingest(v2), /refused/);
  assert.equal((await store.read("dyno-winner")).latestVersion, 2);
});

test("a tampered package is refused before any record is written", async (t) => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "grapix-ae-tamper-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const versionRoot = path.join(dataRoot, "pkg", "v001");
  await writePackage(versionRoot, { id: "dyno-winner", version: 1, name: "GX_winner" });
  // Corrupt the project after its checksum was recorded.
  await writeFile(path.join(versionRoot, "project", "p.aep"), "tampered bytes");

  const store = new AePackageStore(dataRoot);
  await assert.rejects(store.ingest(versionRoot));
  assert.deepEqual(await store.list(), []);
});
