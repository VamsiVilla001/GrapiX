/**
 * The project asset contract: identity, classification, and the route both sides build.
 *
 * These are shared because the Editor and the project service both depend on them agreeing. A
 * drift here does not fail loudly — it produces a library that offers a file the renderer then
 * refuses, or an asset that authors correctly and fails at publish.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  PROJECT_ASSET_FOLDERS,
  PROJECT_FOLDERS,
  isAssignableProjectAsset,
  projectAssetContentPath,
  projectAssetId,
  projectAssetKind,
  projectAssetMimeType
} from "../dist/index.js";

test("an asset id is a function of its path, so assigning the same file twice is one entry", () => {
  assert.equal(
    projectAssetId("Assets/Images/logo.png"),
    projectAssetId("Assets/Images/logo.png"),
    "the same path must always produce the same id"
  );
  assert.notEqual(
    projectAssetId("Assets/Images/logo.png"),
    projectAssetId("Assets/Images/logo2.png")
  );
  assert.notEqual(
    projectAssetId("Assets/Images/a/b.png"),
    projectAssetId("Assets/Images/b/a.png"),
    "position within the path must matter, or two files trade identities"
  );
});

/** A Windows path and a POSIX path name the same file, and must not become two assets. */
test("separators are normalised before an id is derived", () => {
  assert.equal(
    projectAssetId("Assets\\Images\\logo.png"),
    projectAssetId("Assets/Images/logo.png")
  );
});

/**
 * The packager builds a file name out of this id and refuses anything outside `[A-Za-z0-9_-]`.
 * A path with a space or a non-Latin name would otherwise author fine and fail at publish.
 */
test("an id is safe to use as a package file name, whatever the path contains", () => {
  for (const assetPath of [
    "Assets/Images/Show A/lower third.png",
    "Assets/Images/Ünïcøde náme.png",
    "AEP Footage/plate (final) #2.mov",
    "Assets/Images/100%_bg.png",
    "Assets/Images/../oddly/but/still/a/string.png"
  ]) {
    assert.match(
      projectAssetId(assetPath),
      /^[A-Za-z0-9_-]{1,128}$/,
      `${assetPath} must produce a package-safe id`
    );
  }
});

test("kind and media type come from the extension, case-insensitively", () => {
  assert.equal(projectAssetKind("logo.PNG"), "image");
  assert.equal(projectAssetKind("clip.mov"), "video");
  assert.equal(projectAssetKind("mark.svg"), "svg");
  assert.equal(projectAssetKind("Inter.woff2"), "font");
  assert.equal(projectAssetKind("head.glb"), "model");
  assert.equal(projectAssetKind("surface.wgsl"), "wgsl");

  assert.equal(projectAssetMimeType("logo.PNG"), "image/png");
  assert.equal(projectAssetMimeType("clip.mov"), "video/quicktime");
});

/**
 * An unrecognised file is shown, not hidden. Hiding it would make the library disagree with the
 * file manager, which is the one thing reading the directory exists to prevent.
 */
test("an unknown extension is 'unknown' rather than a refusal", () => {
  assert.equal(projectAssetKind("notes.xyz"), "unknown");
  assert.equal(projectAssetKind("LICENSE"), "unknown", "a name with no extension is not a crash");
  assert.equal(projectAssetMimeType("notes.xyz"), "application/octet-stream");
  assert.equal(projectAssetKind(".gitignore"), "unknown", "a leading dot is not an extension");
});

test("only surface-bearing kinds are assignable to an object's face", () => {
  const reference = (kind) => ({
    path: "Assets/x", name: "x", kind, mimeType: "", sizeBytes: 0, modifiedAt: "", folder: "images"
  });

  assert.equal(isAssignableProjectAsset(reference("image")), true);
  assert.equal(isAssignableProjectAsset(reference("svg")), true);
  assert.equal(
    isAssignableProjectAsset(reference("video")),
    false,
    "video is not bindable until assignAssetToFaces accepts it; the predicate must not promise first"
  );
  assert.equal(isAssignableProjectAsset(reference("font")), false);
  assert.equal(isAssignableProjectAsset(reference("model")), false, "a model is added, not bound");
  assert.equal(isAssignableProjectAsset(reference("unknown")), false);
});

/**
 * The path goes in the query as one value. Encoding the separators is what stops
 * `Assets/Images/Show A/bg.png` being read as URL structure.
 */
test("a content path carries the asset path as a single encoded value", () => {
  const built = projectAssetContentPath("Assets/Images/Show A/bg.png");
  assert.ok(built.startsWith("/api/project/assets/content?path="));

  const value = new URLSearchParams(built.slice(built.indexOf("?") + 1)).get("path");
  assert.equal(value, "Assets/Images/Show A/bg.png", "the path must survive the round trip intact");
});

test("every scanned folder is a real project folder", () => {
  for (const folder of PROJECT_ASSET_FOLDERS) {
    assert.ok(PROJECT_FOLDERS[folder], `${folder} must name a folder the project creates`);
  }
  assert.ok(!PROJECT_ASSET_FOLDERS.includes("scenes"), "Scenes/ is not an asset folder");
  assert.ok(!PROJECT_ASSET_FOLDERS.includes("backups"), "Backups/ is not an asset folder");
  assert.ok(!PROJECT_ASSET_FOLDERS.includes("autosaves"), "Autosaves/ is not an asset folder");
  assert.ok(!PROJECT_ASSET_FOLDERS.includes("packages"), "Packages/ is not an asset folder");
});
