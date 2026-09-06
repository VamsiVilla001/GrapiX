import assert from "node:assert/strict";
import test from "node:test";

/**
 * The project service's asset routes sit behind the same login as every other project
 * route, so a fetch that carries no bearer is answered 401. The publish dialog's
 * "Could not package image …" was that refusal, and so was a preview texture that
 * resolved to nothing. These tests pin the two rules that fix it: a project-service
 * fetch carries the window's session token, and a blob URL minted for a header-less
 * consumer (Pixi, `<img>`, SVG) is keyed on the bytes' etag, never the address — a
 * replaced asset with the same id must not serve the stale picture.
 */

const TOKEN = "test-access-token";

let seenAuthorization: string | null = null;
let nextEtag = '"checksum-A"';

(globalThis as { fetch?: unknown }).fetch = (async (
  input: RequestInfo | URL,
  init?: RequestInit
) => {
  const url = String(input);
  if (url.endsWith("/api/auth/login")) {
    return {
      ok: true,
      json: async () => ({
        ok: true,
        user: { id: "u1", username: "author", role: "admin" },
        sessionId: "s1",
        accessToken: TOKEN,
        refreshToken: "refresh",
        expiresAt: Date.now() + 60_000
      })
    } as Response;
  }
  seenAuthorization = new Headers(init?.headers).get("authorization");
  const body = `bytes-for-${nextEtag}`;
  return {
    ok: true,
    status: 200,
    headers: new Headers({ etag: nextEtag, "content-type": "image/png" }),
    blob: async () => new Blob([body], { type: "image/png" }),
    arrayBuffer: async () => new TextEncoder().encode(body).buffer
  } as unknown as Response;
});

let blobCounter = 0;
const realCreateObjectURL = URL.createObjectURL.bind(URL);
URL.createObjectURL = (blob: Blob) => {
  void realCreateObjectURL;
  return `blob:mock-${blobCounter++}`;
};
URL.revokeObjectURL = () => undefined;

// The stub must be installed before the module under test captures `fetch`, so the import
// is dynamic by necessity — a test exercising a module-loading boundary, not a lazy one.
const { signIn } = await import("../src/lib/auth");
const { fetchProjectAsset, resolveProjectAssetObjectUrl, releaseProjectAssetObjectUrls } =
  await import("../src/lib/projectAssets");

test("a project-service fetch carries the session bearer", async () => {
  await signIn("author", "password");

  seenAuthorization = null;
  await fetchProjectAsset("asset_abc123");

  assert.equal(seenAuthorization, `Bearer ${TOKEN}`);
});

test("a remote source is not handed the token", async () => {
  seenAuthorization = null;
  await fetchProjectAsset("https://media.example.com/logo.png");

  assert.equal(seenAuthorization, null);
});

test("the blob URL cache keys on the etag, so new bytes are a new picture", async () => {
  releaseProjectAssetObjectUrls();

  nextEtag = '"checksum-A"';
  const first = await resolveProjectAssetObjectUrl("asset_same_id");
  const firstAgain = await resolveProjectAssetObjectUrl("asset_same_id");

  nextEtag = '"checksum-B"';
  const second = await resolveProjectAssetObjectUrl("asset_same_id");

  // Same bytes are one blob; different bytes behind the same id are not.
  assert.equal(first, firstAgain);
  assert.notEqual(first, second);
});
