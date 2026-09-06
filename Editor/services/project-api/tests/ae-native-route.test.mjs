import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { authenticatedInject } from "./authHelpers.mjs";

const TEST_SIGNING_SECRET = "test-signing-secret-that-is-long-enough-for-auth";

/**
 * The AEP Static Inspector route, and the promise it is now allowed to make.
 *
 * This file used to hold `POST /api/import/after-effects/project`: a path-based route that read a
 * binary `.aep` and produced GrapiX scenes, advertised as importing "compositions, layers,
 * transforms, keyframes, masks, text, effect names and footage paths". `CB0` retired it, because the
 * fidelity that wording implied did not exist — and the option that supposedly traded editability for
 * pixel accuracy (`preferEditability`) was accepted by the dialog, the API client, the route and the
 * converter's signature, and read by nothing.
 *
 * What survives is inspection: `POST /api/import/after-effects` reports on an uploaded file and
 * converts nothing. These tests hold it to exactly that, because the failure mode being guarded
 * against is not a crash — it is a route quietly regaining the power to claim a conversion. So the
 * assertions are: a `.aep` is *not* accepted, its report says inspection only, and **no scene and no
 * asset directory appear on disk as a side effect**. That last one is also `CB1`'s exit gate.
 */

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../Shared/adobe-common-schema/tests/fixtures/aep/Item-01.aep"
);

/**
 * One data root, one server and one admin bootstrap for the whole file.
 *
 * Two facts make anything finer-grained wrong. `GRAPIX_DATA_ROOT` is read when `dist/index.js` is first
 * imported and an ESM import is cached, so every server here resolves the root the *first* test set
 * regardless of what the environment says afterwards. And `authenticatedInject` bootstraps an admin,
 * which refuses outright once `users.json` exists in that root.
 *
 * Together those produced a genuinely intermittent failure: a per-test root only worked when test 1's
 * cleanup actually deleted `users.json`, which on Windows depends on whether the closing server had
 * released its handles yet. Sharing the root without sharing the bootstrap fails deterministically
 * instead. These tests assert refusals and the *absence* of side effects, so they want a stable server,
 * not isolation from each other.
 */
const DATA_ROOT = await mkdtemp(path.join(tmpdir(), "grapix-ae-inspect-"));
process.env.GRAPIX_DATA_ROOT = DATA_ROOT;
process.env.GRAPIX_PROJECT_ROOT = `${DATA_ROOT}-project`;

const { createApiServer } = await import("../dist/index.js");
const server = await createApiServer({ logger: false, signingSecret: TEST_SIGNING_SECRET });
const inject = await authenticatedInject(server);

after(async () => {
  await server.close();
  await rm(DATA_ROOT, { recursive: true, force: true });
});

async function withServer(run) {
  await run({ inject, root: DATA_ROOT });
}

/**
 * Every entry the data root gained, so a silent conversion cannot hide in a subdirectory.
 *
 * The service's own bookkeeping is excluded, because this asks whether *inspection converted
 * anything* — not whether the process wrote a byte. Two things kept appearing between the before
 * and after snapshots and neither is a conversion:
 *
 * - `<name>.tmp`, from an atomic write caught mid-rename. The first-administrator bootstrap runs
 *   one concurrently with this test, so whether it is visible depends only on how the two writes
 *   interleave.
 * - `logs/audit.jsonl`. Every request is audited, including this one; the append is asynchronous,
 *   so whether it lands before the second snapshot is a matter of timing.
 *
 * What the filter deliberately still catches is the thing the test is named for: a scene file, an
 * asset directory, or a package appearing because a `.aep` was inspected.
 */
async function entries(root) {
  try {
    return (await readdir(root, { recursive: true }))
      .filter((entry) => !entry.endsWith(".tmp") && !entry.replace(/\\/g, "/").startsWith("logs/"))
      .sort();
  } catch {
    return [];
  }
}

test("a real .aep is inspected from its bytes, refused for conversion, and has no side effects", async () => {
  await withServer(async ({ inject, root }) => {
    const before = await entries(root);
    const response = await inject({
      method: "POST",
      url: "/api/import/after-effects?fileName=Item-01.aep",
      payload: readFileSync(FIXTURE),
      headers: { "content-type": "application/octet-stream" }
    });

    // 422 rather than 200: the file is readable, and inspection still refuses to call it importable.
    assert.equal(response.statusCode, 422, response.body);
    const body = response.json();
    assert.equal(body.ok, false);
    assert.equal(body.report.sourceType, "aep");
    assert.equal(body.report.accepted, false);
    assert.equal(body.report.inspection.producer, "aep-native");
    assert.equal(body.report.inspection.compositions, 2);
    assert.ok(body.report.inspection.layers > 0);
    assert.ok(body.report.importedItems.some((item) => item.includes("Comp 01")));
    assert.ok(body.report.importedItems.some((item) => item.includes("Null 1")));
    assert.ok(body.report.missingFootage.some((item) => item.includes("Missing Footage")));
    assert.match(
      body.report.colorWarnings.join(" "),
      /static inspection only/i,
      "the report must state that it makes no conversion determination"
    );
    // The retired claim must not come back through the report's own fields.
    assert.deepEqual(body.report.convertedItems, [], "inspection converts nothing");

    assert.deepEqual(
      await entries(root),
      before,
      "inspecting a project must create no scene and no asset directory"
    );
  });
});

test("inspection names an approved path instead of implying the .aep itself is one", async () => {
  await withServer(async ({ inject }) => {
    const response = await inject({
      method: "POST",
      url: "/api/import/after-effects?fileName=Item-01.aep",
      payload: readFileSync(FIXTURE),
      headers: { "content-type": "application/octet-stream" }
    });

    const approved = response.json().approvedPaths;
    assert.ok(Array.isArray(approved) && approved.length > 0, "the refusal must name a way forward");
    assert.ok(
      !approved.some((entry) => /\.aep|after effects project/i.test(entry)),
      "an approved path may never be the .aep import this phase retired"
    );
  });
});

test("corrupt bytes named .aep are refused with a parser diagnostic, not a project inspection", async () => {
  await withServer(async ({ inject }) => {
    const response = await inject({
      method: "POST",
      url: "/api/import/after-effects?fileName=corrupt.aep",
      payload: Buffer.from("this is not a RIFX container"),
      headers: { "content-type": "application/octet-stream" }
    });

    assert.equal(response.statusCode, 422);
    const body = response.json();
    assert.equal(body.ok, false);
    assert.equal(body.report.inspection, undefined);
    assert.match(body.report.unsupportedItems.join(" "), /AEP parse diagnostic.*RIFX/i);
  });
});

test("inspection without a file name is refused before anything is read", async () => {
  await withServer(async ({ inject }) => {
    const response = await inject({
      method: "POST",
      url: "/api/import/after-effects",
      payload: Buffer.from("irrelevant"),
      headers: { "content-type": "application/octet-stream" }
    });

    assert.equal(response.statusCode, 400);
    assert.equal(response.json().ok, false);
  });
});
