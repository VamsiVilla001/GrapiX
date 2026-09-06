import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const TEST_SIGNING_SECRET = "test-signing-secret-that-is-long-enough-for-auth";

/**
 * The author console's service half.
 *
 * The console exists because a refused request used to reach the editor as one string with
 * no cause, no remedy and no way to look at it again. These assertions pin the contract the
 * drawer reads: a bounded tail with monotonic sequences, a clear that does not renumber, and
 * a log that captures a thrown route failure before the 500 is sent.
 */
test("the diagnostics log serves its tail, paginates by sequence, and survives clear", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "grapix-diagnostics-test-"));
  process.env.GRAPIX_DATA_ROOT = root;
  const { createApiServer } = await import("../dist/index.js");
  const { injectSignInAsAdmin } = await import("./authHelpers.mjs");
  const app = await createApiServer({ logger: false, signingSecret: TEST_SIGNING_SECRET });
  context.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  // The auth gate protects these routes, so every request below carries the session token.
  const { headers } = await injectSignInAsAdmin(app);

  // Empty at start, and `latestSequence` distinguishes "empty" from "nothing new".
  const empty = await app.inject({ method: "GET", url: "/api/diagnostics", headers });
  assert.equal(empty.statusCode, 200);
  assert.deepEqual(empty.json().records, []);
  assert.equal(empty.json().latestSequence, 0);

  // Force a route failure: `saveScene` writes a backup beside the scene and rejects a scene
  // with no id. A route that *throws* — rather than one that replies 4xx itself — is what
  // the error handler records, and the unhandled 500 is the failure the console exists for.
  const thrown = await app.inject({
    method: "POST",
    url: "/api/scenes",
    headers,
    payload: { name: "no id on this document", objects: [] }
  });
  assert.equal(thrown.statusCode, 500);

  const tail = await app.inject({ method: "GET", url: "/api/diagnostics", headers });
  const page = tail.json();
  assert.ok(page.records.length >= 1, "a recorded failure must appear in the tail");
  const first = page.records[page.records.length - 1];
  assert.equal(typeof first.sequence, "number");
  assert.equal(first.level, "error");
  assert.ok(first.source.length > 0);
  assert.ok(first.message.length > 0);

  // `?since=` returns only what the caller does not already hold.
  const since = await app.inject({ method: "GET", url: `/api/diagnostics?since=${first.sequence}`, headers });
  assert.deepEqual(since.json().records, []);
  assert.equal(since.json().latestSequence, page.latestSequence);

  // Clear empties the buffer but the sequence keeps counting, so a console holding
  // `since: N` is never handed a fresh record it mistakes for an old one.
  const cleared = await app.inject({ method: "DELETE", url: "/api/diagnostics", headers });
  assert.equal(cleared.statusCode, 200);
  assert.ok(cleared.json().cleared >= 1);
  assert.equal(cleared.json().latestSequence, page.latestSequence);

  const afterClear = await app.inject({ method: "GET", url: "/api/diagnostics", headers });
  assert.deepEqual(afterClear.json().records, []);
  assert.equal(afterClear.json().latestSequence, page.latestSequence);
});
