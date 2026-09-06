/**
 * The asset folders read as a library, and the path check that guards them.
 *
 * One project root and one storage import for the whole file. `dist/projectAssets.js` imports
 * `projectWorkspace.js`, which remembers which project is open in module state — so a per-test
 * project would be silently ignored after the first test resolved one (see memory rule 315). Tests
 * here write different files into the same project instead, and clean up after themselves.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const DATA_ROOT = await mkdtemp(path.join(tmpdir(), "grapix-assets-data-"));
const PROJECT_ROOT = await mkdtemp(path.join(tmpdir(), "grapix-assets-project-"));

process.env.GRAPIX_DATA_ROOT = DATA_ROOT;
process.env.GRAPIX_PROJECT_ROOT = PROJECT_ROOT;

const { listProjectAssets, resolveProjectAssetPath } = await import("../dist/projectAssets.js");

/** Write a file into the project, creating the folders it needs. */
async function put(relativePath, contents = "x") {
  const absolute = path.join(PROJECT_ROOT, ...relativePath.split("/"));
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, contents);
  return absolute;
}

before(async () => {
  await put("Assets/Images/logo-2.png");
  await put("Assets/Images/logo-10.png");
  await put("Assets/Images/Show A/Lower Thirds/bg.jpg");
  await put("Assets/Videos/sting.mp4");
  await put("Assets/Fonts/Inter.woff2");
  await put("AEP Footage/plate.mov");

  // None of these are library entries.
  await put("Assets/Images/.hidden.png");
  await put("Assets/Images/half-written.png.tmp");
  await put("AEP Footage/collected.json", "{}");
  await put("Scenes/010.json", "{}");
});

after(async () => {
  delete process.env.GRAPIX_DATA_ROOT;
  delete process.env.GRAPIX_PROJECT_ROOT;
  await rm(DATA_ROOT, { recursive: true, force: true });
  await rm(PROJECT_ROOT, { recursive: true, force: true });
});

test("every asset folder is read, including nested directories", async () => {
  const assets = await listProjectAssets();
  const paths = assets.map((asset) => asset.path);

  assert.ok(paths.includes("Assets/Images/logo-2.png"));
  assert.ok(
    paths.includes("Assets/Images/Show A/Lower Thirds/bg.jpg"),
    "designers organise into subfolders; a flat scan would lose the whole tree"
  );
  assert.ok(paths.includes("Assets/Videos/sting.mp4"));
  assert.ok(paths.includes("Assets/Fonts/Inter.woff2"));
  assert.ok(paths.includes("AEP Footage/plate.mov"));
});

test("a reference carries the kind and media type the renderer will need", async () => {
  const assets = await listProjectAssets();
  const byPath = new Map(assets.map((asset) => [asset.path, asset]));

  assert.equal(byPath.get("Assets/Images/logo-2.png").kind, "image");
  assert.equal(byPath.get("Assets/Images/logo-2.png").mimeType, "image/png");
  assert.equal(byPath.get("Assets/Images/logo-2.png").folder, "images");
  assert.equal(byPath.get("Assets/Videos/sting.mp4").kind, "video");
  assert.equal(byPath.get("AEP Footage/plate.mov").folder, "aepFootage");
  assert.ok(byPath.get("Assets/Images/logo-2.png").sizeBytes > 0);
  assert.match(byPath.get("Assets/Images/logo-2.png").modifiedAt, /^\d{4}-\d{2}-\d{2}T/);
});

/** A path is POSIX in the reference whatever the host separator is, or it stops being portable. */
test("reference paths are project-relative and POSIX-separated", async () => {
  const assets = await listProjectAssets();
  for (const asset of assets) {
    assert.ok(!asset.path.includes("\\"), `${asset.path} must not carry a Windows separator`);
    assert.ok(!path.isAbsolute(asset.path), `${asset.path} must be relative to the project`);
  }
});

test("scene files and bookkeeping are not offered as assets", async () => {
  const paths = (await listProjectAssets()).map((asset) => asset.path);

  assert.ok(!paths.some((entry) => entry.startsWith("Scenes/")), "Scenes/ is not an asset folder");
  assert.ok(!paths.includes("AEP Footage/collected.json"), "the collection index is not footage");
  assert.ok(!paths.some((entry) => entry.endsWith(".tmp")), "a half-written file is not an asset");
  assert.ok(!paths.some((entry) => entry.includes("/.")), "dotfiles are not assets");
});

/** `logo-2` before `logo-10`: the order the person naming them that way meant. */
test("assets sort by folder, then numerically within a folder", async () => {
  const images = (await listProjectAssets())
    .filter((asset) => asset.folder === "images")
    .map((asset) => asset.path);

  assert.ok(
    images.indexOf("Assets/Images/logo-2.png") < images.indexOf("Assets/Images/logo-10.png"),
    "logo-2 must precede logo-10"
  );
});

test("a path inside the project resolves to the file it names", async () => {
  const resolved = await resolveProjectAssetPath("Assets/Images/logo-2.png");
  assert.ok(resolved, "a real asset must resolve");
  assert.equal(path.basename(resolved), "logo-2.png");

  const nested = await resolveProjectAssetPath("Assets/Images/Show A/Lower Thirds/bg.jpg");
  assert.ok(nested, "spaces in a folder name are ordinary, not a refusal");
});

/**
 * Every refusal answers `null`, and the caller turns that into one 404.
 *
 * Traversal, absolute paths and backslash forms are all the same request wearing different
 * clothes: "read a file the project does not own". A syntax check that only looked for `../`
 * would pass `..\\` on the host where it matters most.
 */
test("a path that leaves the project is refused, in every form", async () => {
  for (const attempt of [
    "../secret.txt",
    "Assets/../../secret.txt",
    "Assets/Images/../../../secret.txt",
    "..\\secret.txt",
    "Assets\\..\\..\\secret.txt",
    "/etc/passwd",
    "C:\\Windows\\win.ini",
    "\\\\server\\share\\file.png",
    "",
    "./Assets/Images/logo-2.png"
  ]) {
    assert.equal(
      await resolveProjectAssetPath(attempt),
      null,
      `${JSON.stringify(attempt)} must not resolve`
    );
  }
});

test("a directory and a missing file both refuse rather than resolving", async () => {
  assert.equal(await resolveProjectAssetPath("Assets/Images"), null, "a directory is not content");
  assert.equal(await resolveProjectAssetPath("Assets/Images/absent.png"), null);
});

test("a path carrying a NUL byte is refused before it reaches the filesystem", async () => {
  assert.equal(await resolveProjectAssetPath("Assets/Images/logo-2.png\u0000.txt"), null);
});
