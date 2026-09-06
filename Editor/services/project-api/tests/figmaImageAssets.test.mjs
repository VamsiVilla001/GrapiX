import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const TEST_SIGNING_SECRET = "test-signing-secret-that-is-long-enough-for-auth";

/**
 * Figma stores nearly every photograph as an `IMAGE` paint on a rectangle — there is no image node
 * to find. Getting one on screen therefore takes four things, and this file holds each of them to
 * its promise:
 *
 * 1. Every `imageRef` in a fill or a stroke is collected and downloaded once.
 * 2. The bytes land in the project at `images/<scene>/<layer>.png`, and the scene refers to them by
 *    that path — not by an asset id, and never by the Figma URL, which expires within the hour.
 * 3. The service serves that path, and a saved scene still resolves after a reload. This is the
 *    step that decides whether the picture appears: the preview, a reopened project and Playout all
 *    resolve the same string, so a path nothing serves is a missing image everywhere.
 * 4. The rectangle becomes an image object, not a rectangle painted the fill's average colour.
 * 5. The paint properties Figma reports — scale mode, crop matrix, rotation, opacity, blend mode,
 *    filters — travel with it, and the scale mode decides the object fit.
 *
 * The import runs once against a scratch `GRAPIX_DATA_ROOT`, so these assertions are about files on
 * disk and real HTTP responses rather than a mock of them.
 */

/** Two 1x1 PNGs whose bytes differ, so a deduplication claim is falsifiable. */
const RED_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64"
);
const BLUE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNg+M/wHwAEAAH/9ZKPagAAAABJRU5ErkJggg==",
  "base64"
);

/**
 * A document exercising every image shape that matters: a plain photo rectangle, a second rectangle
 * reusing the same `imageRef`, a cropped fill with a transform and filters, an image *stroke*, and a
 * frame with an image fill that also clips.
 */
function imageDocument() {
  return {
    name: "Player Stats",
    document: {
      id: "0:0",
      name: "Player Stats",
      type: "DOCUMENT",
      children: [{
        id: "0:1",
        name: "Page 1",
        type: "CANVAS",
        children: [
          {
            id: "1:1",
            name: "player-photo",
            type: "RECTANGLE",
            absoluteBoundingBox: { x: 0, y: 0, width: 400, height: 300 },
            fills: [{
              type: "IMAGE",
              imageRef: "hero",
              scaleMode: "FILL",
              opacity: 0.8,
              blendMode: "MULTIPLY",
              rotation: 90,
              filters: { exposure: 0.25, contrast: -0.1, saturation: 0 }
            }]
          },
          {
            id: "1:2",
            name: "player-photo-again",
            type: "RECTANGLE",
            absoluteBoundingBox: { x: 400, y: 0, width: 100, height: 100 },
            fills: [{ type: "IMAGE", imageRef: "hero", scaleMode: "FIT" }]
          },
          {
            id: "1:3",
            name: "team-logo",
            type: "RECTANGLE",
            absoluteBoundingBox: { x: 0, y: 300, width: 120, height: 120 },
            cornerRadius: 60,
            fills: [{
              type: "IMAGE",
              imageRef: "logo",
              scaleMode: "CROP",
              imageTransform: [[0.5, 0, 0.25], [0, 0.5, 0.25]]
            }]
          },
          {
            id: "1:4",
            name: "outlined",
            type: "RECTANGLE",
            absoluteBoundingBox: { x: 200, y: 300, width: 80, height: 80 },
            fills: [{ type: "SOLID", color: { r: 0, g: 0, b: 0, a: 1 } }],
            strokes: [{ type: "IMAGE", imageRef: "logo", scaleMode: "TILE" }],
            strokeWeight: 6
          },
          {
            id: "1:5",
            name: "banner",
            type: "FRAME",
            absoluteBoundingBox: { x: 0, y: 500, width: 500, height: 200 },
            clipsContent: true,
            fills: [{ type: "IMAGE", imageRef: "hero", scaleMode: "FILL" }],
            children: [{
              id: "1:6",
              name: "banner-text",
              type: "TEXT",
              absoluteBoundingBox: { x: 10, y: 510, width: 480, height: 40 },
              characters: "LIVE",
              style: { fontFamily: "Inter", fontSize: 32 }
            }]
          }
        ]
      }]
    }
  };
}

/** The Figma REST responses this import needs: `/nodes`, then `/images` per ref, then the bytes. */
function figmaFetch(requests) {
  return async (url) => {
    const target = String(url);
    requests.push(target);

    // `/v1/files/<key>/nodes` — the document itself.
    if (target.includes("/v1/files/") && target.includes("/nodes")) {
      return jsonResponse({ nodes: { "1:1": imageDocument() } });
    }
    // `/v1/files/<key>/images` — every `imageRef` on every layer, as short-lived S3 URLs.
    if (target.includes("/v1/files/") && target.endsWith("/images")) {
      return jsonResponse({
        err: null,
        meta: { images: { hero: "https://figma-cdn.test/hero.png", logo: "https://figma-cdn.test/logo.png" } }
      });
    }
    // `/v1/images/<key>?ids=…` — Figma rendering a node GrapiX cannot draw.
    if (target.includes("/v1/images/")) {
      return jsonResponse({ err: null, images: { "1:1": "https://figma-cdn.test/render.png" } });
    }
    if (target.endsWith("hero.png")) return bytesResponse(RED_PNG);
    if (target.endsWith("logo.png")) return bytesResponse(BLUE_PNG);
    if (target.endsWith("render.png")) return bytesResponse(RED_PNG);

    throw new Error(`unexpected request ${target}`);
  };
}

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

function bytesResponse(bytes) {
  return new Response(bytes, {
    status: 200,
    headers: { "content-type": "image/png", "content-length": String(bytes.byteLength) }
  });
}

/**
 * Import the document into a scratch project, once for the whole file.
 *
 * One import, many assertions: `storage.ts` resolves `GRAPIX_DATA_ROOT` when it is first loaded, so
 * a per-test project would need a fresh module graph per test and would silently write into the
 * previous test's directory. One import is also what a user does.
 */
let imported;

function importIntoScratchProject() {
  imported ??= (async () => {
    const root = await mkdtemp(path.join(tmpdir(), "grapix-image-import-"));
    process.env.GRAPIX_DATA_ROOT = root;
    process.env.GRAPIX_PROJECT_ROOT = `${root}-project`;

    const requests = [];
    const { DesignImportManager } = await import("../dist/importers/design/designImportManager.js");

    const result = await new DesignImportManager().importFigma(
      {
        url: "https://www.figma.com/design/abc123DEF456ghi789JK/Player-Stats?node-id=1-1",
        nodeIds: ["1:1"],
        transport: "rest",
        accessToken: "figd_test-token"
      },
      { assetMode: "embed" },
      { fetchImpl: figmaFetch(requests) }
    );

    return { root, requests, ...result };
  })();
  return imported;
}

test.after(async () => {
  const state = await imported;
  if (!state) return;
  delete process.env.GRAPIX_DATA_ROOT;
  delete process.env.GRAPIX_PROJECT_ROOT;
  await rm(state.root, { recursive: true, force: true });
});

/** Every file under a directory, as posix-relative paths. */
async function tree(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await tree(path.join(directory, entry.name), relative));
    else files.push(relative);
  }
  return files;
}

test("image fills are downloaded into images/<scene>/ under the layer's name", async () => {
  const { root, report } = await importIntoScratchProject();
  const images = await tree(path.join(root, "images"));
  assert.ok(images.length > 0, `no images stored; project contains ${JSON.stringify(await tree(root))}`);

  // One folder per scene, named after the page the scene came from ("Player Stats" -> player-stats).
  const folders = new Set(images.map((file) => file.split("/")[0]));
  assert.equal(folders.size, 1, `expected one scene folder, got ${JSON.stringify([...folders])}`);
  const [folder] = folders;
  assert.match(folder, /^[a-z0-9][a-z0-9-]*$/, "the folder name is filesystem-safe");
  assert.ok(folder.includes("player") && folder.includes("stats"), `${folder} does not name the page`);

  // The file is named after the layer that paints it, so a designer recognises it on disk.
  assert.ok(
    images.some((file) => /\/player-photo\.png$/.test(file)),
    `the layer name is not the file name: ${JSON.stringify(images)}`
  );
  assert.ok(images.some((file) => /\/team-logo\.png$/.test(file)));
  for (const file of images) {
    assert.match(file, /^[A-Za-z0-9_\-.\/]+$/, `unsafe stored name ${file}`);
  }
  assert.ok(report.counts.assetsDownloaded >= 2, "the report counts what it fetched");
});

test("the scene refers to a stored image by its project path, never by a Figma URL", async () => {
  const { root, scenes } = await importIntoScratchProject();
  const scene = scenes[0];
  const imageAssets = scene.assets.filter((asset) => asset.kind === "image");
  assert.ok(imageAssets.length >= 2);

  for (const asset of imageAssets) {
    assert.ok(
      asset.source.startsWith("images/"),
      `${asset.name} points at ${asset.source} instead of a project path`
    );
    assert.ok(!/figma|amazonaws|http/i.test(asset.source), `${asset.name} kept a remote URL`);
    assert.ok(asset.checksum, `${asset.name} has no checksum, so the render engine would refuse it`);

    // The path resolves to bytes that are actually there.
    const bytes = await readFile(path.join(root, asset.source));
    assert.ok(bytes.byteLength > 0);
  }

  const photo = scene.objects.find((object) => object.name === "player-photo");
  assert.equal(photo.type, "image", "a rectangle with an image fill draws the image");
  assert.ok(photo.src.startsWith("images/"), `the object points at ${photo.src}`);
});

test("one imageRef used twice is fetched once and shared", async () => {
  const { root, requests, scenes } = await importIntoScratchProject();
  const heroFetches = requests.filter((url) => url.endsWith("hero.png"));
  assert.equal(heroFetches.length, 1, `hero.png was fetched ${heroFetches.length} times`);

  const scene = scenes[0];
  const first = scene.objects.find((object) => object.name === "player-photo");
  const second = scene.objects.find((object) => object.name === "player-photo-again");
  assert.equal(first.src, second.src, "both layers draw the same stored file");
});

test("the scale mode decides the object fit", async () => {
  const { root, scenes } = await importIntoScratchProject();
  const scene = scenes[0];
  const byName = new Map(scene.objects.map((object) => [object.name, object]));

  assert.equal(byName.get("player-photo").objectFit, "cover", "FILL crops the overflow");
  assert.equal(byName.get("player-photo-again").objectFit, "contain", "FIT shows the whole image");
  assert.equal(byName.get("team-logo").objectFit, "cover", "CROP is closest to cover");
});

test("paint properties travel with the object, verbatim", async () => {
  const { root, scenes } = await importIntoScratchProject();
  const scene = scenes[0];
  const photo = scene.objects.find((object) => object.name === "player-photo");
  const paint = photo.importedDesign?.imagePaint;
  assert.ok(paint, `no imagePaint on the object: ${JSON.stringify(Object.keys(photo.importedDesign ?? {}))}`);

  assert.equal(paint.scaleMode, "FILL");
  assert.equal(paint.opacity, 0.8);
  assert.equal(paint.blendMode, "MULTIPLY");
  assert.equal(paint.rotation, 90);
  assert.deepEqual(paint.filters, { exposure: 0.25, contrast: -0.1 }, "a zero filter is not a filter");

  const logo = scene.objects.find((object) => object.name === "team-logo");
  assert.deepEqual(
    logo.importedDesign.imagePaint.imageTransform,
    [[0.5, 0, 0.25], [0, 0.5, 0.25]],
    "the crop matrix is kept for the renderer that will use it"
  );
});

test("an image stroke reaches the library and is reported, because GrapiX strokes are paint", async () => {
  const { root, scenes, report } = await importIntoScratchProject();
  const scene = scenes[0];
  const outlined = scene.objects.find((object) => object.name === "outlined");
  const strokeIds = outlined.importedDesign?.strokeImageAssetIds ?? [];
  assert.equal(strokeIds.length, 1, "the stroke's image is recorded on the object");

  const strokeAsset = scene.assets.find((asset) => asset.assetId === strokeIds[0]);
  assert.ok(strokeAsset, "and it is in the scene's asset library");
  assert.ok(strokeAsset.source.startsWith("images/"), "stored locally like any other image");

  assert.ok(
    report.issues.some((issue) => issue.sourceNodeName === "outlined" && issue.kind === "visual-difference"),
    "an author is told the stroke will not look like Figma's"
  );
});

test("the service serves the image at the path the scene remembers, before and after a save", async () => {
  const { scenes } = await importIntoScratchProject();
  const scene = scenes[0];
  const image = scene.objects.find((object) => object.name === "player-photo");

  // The same module graph the import used, so the server reads the same scratch project.
  const { createApiServer } = await import("../dist/index.js");
  const { authenticatedInject } = await import("./authHelpers.mjs");
  const { saveScene, readScene } = await import("../dist/storage.js");
  const server = await createApiServer({ logger: false, signingSecret: TEST_SIGNING_SECRET });
  const inject = await authenticatedInject(server);

  try {
    const served = await inject({ method: "GET", url: `/${image.src}` });
    assert.equal(served.statusCode, 200, `GET /${image.src} answered ${served.statusCode}`);
    assert.match(served.headers["content-type"], /^image\/png/);
    assert.ok(served.rawPayload.byteLength > 0);
    // A project image is content-addressed by its own path and never rewritten in place, so it is
    // safe to cache hard. A no-cache image is a re-download on every render.
    assert.match(String(served.headers["cache-control"]), /max-age=\d{4,}/);

    // A traversal attempt must not escape the project's image root.
    const escaped = await inject({ method: "GET", url: "/images/../scenes/../../secrets.txt" });
    assert.notEqual(escaped.statusCode, 200);

    // Saved and read back: the path survives, which is what makes a reopened scene still draw.
    await saveScene(scene);
    const reopened = await readScene(scene.id);
    const reopenedImage = reopened.objects.find((object) => object.name === "player-photo");
    assert.equal(reopenedImage.src, image.src, "the stored path is what the scene keeps");
    assert.equal(reopenedImage.objectFit, image.objectFit);

    const again = await inject({ method: "GET", url: `/${reopenedImage.src}` });
    assert.equal(again.statusCode, 200);
  } finally {
    await server.close();
  }
});

test("a clipping frame with an image fill both clips and draws its image", async () => {
  const { root, scenes } = await importIntoScratchProject();
  const scene = scenes[0];
  const byId = new Map(scene.objects.map((object) => [object.id, object]));
  const banner = scene.objects.find((object) => object.name === "banner");
  const children = (banner.childIds ?? []).map((id) => byId.get(id));

  assert.deepEqual(children.map((child) => child.name), ["banner clip shape", "banner contents"]);

  // The clip shape is what carries the frame's paint, so the image belongs to it.
  const clipShape = children[0];
  assert.ok(
    clipShape.src?.startsWith("images/") || clipShape.importedDesign?.imagePaint,
    `the frame's image fill was dropped: ${JSON.stringify({ type: clipShape.type, src: clipShape.src })}`
  );

  const text = scene.objects.find((object) => object.name === "banner-text");
  assert.ok(text, "and the child still exists inside the composition");
});
