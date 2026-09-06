/**
 * The asset library over the wire: what the Material Manager actually receives, and whether the
 * bytes behind a reference can be fetched.
 *
 * The unit tests cover the scanner and the header parser separately. This asserts the join — that a
 * real PNG dropped into `Assets/Images` arrives at the panel with its true geometry and its alpha
 * channel, and that the URL the panel builds for it serves those exact bytes. Every previous break
 * in this feature was at a seam, not inside a part.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { after, before, test } from "node:test";

import { authenticatedInject } from "./authHelpers.mjs";

const TEST_SIGNING_SECRET = "project-asset-routes-signing-secret-value";

const DATA_ROOT = await mkdtemp(path.join(tmpdir(), "grapix-asset-routes-"));
const PROJECT_ROOT = `${DATA_ROOT}-project`;
process.env.GRAPIX_DATA_ROOT = DATA_ROOT;
process.env.GRAPIX_PROJECT_ROOT = PROJECT_ROOT;

const { createApiServer } = await import("../dist/index.js");
const server = await createApiServer({ logger: false, signingSecret: TEST_SIGNING_SECRET });
const inject = await authenticatedInject(server);

/* ── A real PNG, so the geometry assertions are about a file a decoder would accept ───────── */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

function png({ width, height, colorType }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.alloc(64))),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

const KEY_PNG = png({ width: 1920, height: 1080, colorType: 6 });   // RGBA
const FLAT_PNG = png({ width: 320, height: 240, colorType: 2 });    // RGB

async function put(relativePath, bytes) {
  const absolute = path.join(PROJECT_ROOT, ...relativePath.split("/"));
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, bytes);
}

before(async () => {
  await put("Assets/Images/key.png", KEY_PNG);
  await put("Assets/Images/Show A/flat.png", FLAT_PNG);
  await put("Assets/Videos/sting.mp4", Buffer.from("not really a movie"));
  await put("Scenes/010.json", Buffer.from("{}"));
});

after(async () => {
  await server.close();
  await rm(DATA_ROOT, { recursive: true, force: true });
  await rm(PROJECT_ROOT, { recursive: true, force: true });
});

async function library() {
  const response = await inject({ method: "GET", url: "/api/project/assets" });
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
}

test("the library is the folder: every asset is listed, and nothing else is", async () => {
  const { ok, projectOpen, assets } = await library();
  assert.equal(ok, true);
  assert.equal(projectOpen, true);

  const paths = assets.map((asset) => asset.path);
  assert.ok(paths.includes("Assets/Images/key.png"));
  assert.ok(paths.includes("Assets/Images/Show A/flat.png"), "a subfolder is part of the library");
  assert.ok(paths.includes("Assets/Videos/sting.mp4"));
  assert.ok(!paths.some((entry) => entry.startsWith("Scenes/")), "a scene is not an asset");
});

/**
 * The two facts an author chooses between images on. The second one costs a show when it is wrong:
 * a key with no alpha reaches air as a black rectangle.
 */
test("an image arrives with its real geometry and its alpha channel", async () => {
  const byPath = new Map((await library()).assets.map((asset) => [asset.path, asset]));

  const key = byPath.get("Assets/Images/key.png");
  assert.equal(key.width, 1920);
  assert.equal(key.height, 1080);
  assert.equal(key.hasAlphaChannel, true, "an RGBA PNG carries alpha");
  assert.equal(key.kind, "image");
  assert.equal(key.mimeType, "image/png");

  const flat = byPath.get("Assets/Images/Show A/flat.png");
  assert.equal(flat.width, 320);
  assert.equal(flat.height, 240);
  assert.equal(flat.hasAlphaChannel, false, "an RGB PNG does not");
});

/**
 * Nothing is invented for a file whose header says nothing. The panel states these as fact, so an
 * absent answer has to stay absent rather than becoming a plausible zero.
 */
test("a file that is not a readable image carries no geometry at all", async () => {
  const video = (await library()).assets.find((asset) => asset.path === "Assets/Videos/sting.mp4");
  assert.equal(video.width, undefined);
  assert.equal(video.height, undefined);
  assert.equal(video.hasAlphaChannel, undefined);
});

test("the content route serves exactly the bytes on disk", async () => {
  const response = await inject({
    method: "GET",
    url: `/api/project/assets/content?path=${encodeURIComponent("Assets/Images/key.png")}`
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["content-type"], "image/png");
  assert.ok(response.headers.etag, "an etag is what lets a replaced file invalidate a cached texture");
  assert.deepEqual(response.rawPayload, KEY_PNG, "the bytes must be the file, unmodified");
});

/** Spaces in a folder name are ordinary in a show project, not an encoding problem. */
test("a path with spaces resolves", async () => {
  const response = await inject({
    method: "GET",
    url: `/api/project/assets/content?path=${encodeURIComponent("Assets/Images/Show A/flat.png")}`
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.rawPayload, FLAT_PNG);
});

/**
 * Every refusal is the same 404. Telling a caller which check failed lets them map the filesystem
 * one request at a time.
 */
test("a path that leaves the project is refused over the wire", async () => {
  for (const attempt of [
    "../secret.txt",
    "Assets/../../secret.txt",
    "..\\secret.txt",
    "C:\\Windows\\win.ini",
    "/etc/passwd",
    "Assets/Images",
    "Assets/Images/absent.png"
  ]) {
    const response = await inject({
      method: "GET",
      url: `/api/project/assets/content?path=${encodeURIComponent(attempt)}`
    });
    assert.equal(response.statusCode, 404, `${attempt} must be refused`);
  }
});

test("the content route requires a path", async () => {
  const response = await inject({ method: "GET", url: "/api/project/assets/content" });
  assert.equal(response.statusCode, 400);
});

/** The library sits behind the same login as every other project route. */
test("an unauthenticated request is refused", async () => {
  const response = await server.inject({ method: "GET", url: "/api/project/assets" });
  assert.equal(response.statusCode, 401);
});

/**
 * Replacing a file in place is the routine act path identity exists to support: the reference keeps
 * its identity, and everything downstream has to notice the new bytes. The etag is what carries
 * that to a cached texture.
 */
test("replacing a file in place keeps its path and changes its etag", async () => {
  const url = `/api/project/assets/content?path=${encodeURIComponent("Assets/Images/key.png")}`;
  const before = await inject({ method: "GET", url });

  const replacement = png({ width: 640, height: 360, colorType: 2 });
  await put("Assets/Images/key.png", replacement);

  const after = await inject({ method: "GET", url });
  assert.notEqual(after.headers.etag, before.headers.etag, "new bytes must mean a new etag");
  assert.deepEqual(after.rawPayload, replacement);

  const reference = (await library()).assets.find((asset) => asset.path === "Assets/Images/key.png");
  assert.equal(reference.width, 640, "the library must report the new geometry, not the cached one");
  assert.equal(reference.hasAlphaChannel, false);
});
