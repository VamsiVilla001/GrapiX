import assert from "node:assert/strict";
import test from "node:test";

import { describeError, DiagnosticsLog, PlayoutOperationError } from "../dist/diagnostics.js";
import { readAssetBytes } from "../dist/sceneAssets.js";

/**
 * The failure this whole surface exists for.
 *
 * `asset asset_b5350b45cd6cca4ff8f7 returned HTTP 404` was the entire report an operator got:
 * no asset name, no scene, no URL, no status text, and nothing to do about it. These assert on
 * the parts an operator needs rather than on the wording, so the message can be reworded but
 * cannot go back to being unactionable.
 */
test("a 404 on asset content names the asset, the scene, the URL and what to do", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () =>
    new Response('{"ok":false,"error":"Asset content not found"}', {
      status: 404,
      statusText: "Not Found"
    });

  const error = await readAssetBytes(
    {
      assetId: "asset_b5350b45cd6cca4ff8f7",
      name: "lower-third-bg.png",
      kind: "image",
      source: "http://127.0.0.1:4100/api/assets/asset_b5350b45cd6cca4ff8f7/content",
      mimeType: "image/png",
      sizeBytes: 40_112,
      checksum: "a".repeat(64),
      status: "READY",
      importedAt: "2026-08-04T09:00:00.000Z"
    },
    { sceneId: "scene_headline", sceneName: "Headline", sceneRevision: 3 }
  ).then(
    () => null,
    (thrown) => thrown
  );

  assert.ok(error instanceof PlayoutOperationError);
  assert.equal(error.code, "asset.content-unavailable");

  // The banner line alone must identify the asset and the scene, because the banner is all an
  // operator sees before they open the console.
  assert.match(error.summary, /lower-third-bg\.png/);
  assert.match(error.summary, /Headline/);
  assert.match(error.summary, /127\.0\.0\.1:4100/);

  const detail = error.detail();
  // The cause is the request and the answer, verbatim, including the service's own body.
  assert.match(detail.cause, /GET http:\/\/127\.0\.0\.1:4100\/api\/assets\/asset_b5350b45cd6cca4ff8f7\/content/);
  assert.match(detail.cause, /404 Not Found/);
  assert.match(detail.cause, /Asset content not found/);
  // A remedy naming an action, not a restatement of the failure.
  assert.match(detail.remedy, /Re-import the asset in the Editor/);
  assert.equal(detail.context.assetId, "asset_b5350b45cd6cca4ff8f7");
  assert.equal(detail.context.sceneId, "scene_headline");
  assert.equal(detail.context.httpStatus, 404);
  assert.equal(detail.context.mimeType, "image/png");
  assert.equal(detail.context.checksum, "a".repeat(64));
});

test("a status other than 404 is reported as a refusal, with the status text kept", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () => new Response("upstream failed", { status: 502, statusText: "Bad Gateway" });

  const error = await readAssetBytes(assetFixture(), { sceneId: "scene_x", sceneName: "X" }).then(
    () => null,
    (thrown) => thrown
  );

  assert.equal(error.code, "asset.fetch-refused");
  assert.match(error.summary, /HTTP 502 Bad Gateway/);
  assert.equal(error.detail().context.httpStatusText, "Bad Gateway");
});

test("an unreachable host is distinguished from a service that answered", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () => {
    throw new TypeError("fetch failed");
  };

  const error = await readAssetBytes(assetFixture(), { sceneId: "scene_x", sceneName: "X" }).then(
    () => null,
    (thrown) => thrown
  );

  // Different code and different remedy: "nothing is listening" and "it answered 404" call for
  // different actions, and collapsing them is what made the old message useless.
  assert.equal(error.code, "asset.host-unreachable");
  assert.match(error.detail().cause, /fetch failed/);
  assert.match(error.detail().remedy, /Start the service/);
});

test("a relative asset source is refused before any request is attempted", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let attempted = false;
  globalThis.fetch = async () => {
    attempted = true;
    return new Response("", { status: 200 });
  };

  const error = await readAssetBytes(
    { ...assetFixture(), source: "/api/assets/asset_1/content" },
    { sceneId: "scene_x", sceneName: "X" }
  ).then(
    () => null,
    (thrown) => thrown
  );

  assert.equal(attempted, false, "a path with no host cannot be fetched from a service");
  assert.equal(error.code, "asset.source-not-absolute");
  assert.match(error.summary, /not an address Playout can fetch/);
});

test("embedded bytes need no network at all", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () => {
    throw new Error("a data URL must never reach the network");
  };

  const bytes = await readAssetBytes(
    { ...assetFixture(), source: `data:image/png;base64,${Buffer.from("GX").toString("base64")}` },
    {}
  );

  assert.deepEqual([...bytes], [...Buffer.from("GX")]);
});

// ---------------------------------------------------------------------------
// The log the console reads
// ---------------------------------------------------------------------------

test("a record carries the summary as its message and a monotonic sequence", () => {
  const log = new DiagnosticsLog();

  const first = log.record({
    level: "error",
    source: "control/take",
    error: new PlayoutOperationError({
      code: "engine.take-refused",
      summary: "The engine refused the take",
      remedy: "Cue it first"
    })
  });
  const second = log.record({ level: "info", source: "engine", message: "Engine connected" });

  assert.equal(first.sequence, 1);
  assert.equal(second.sequence, 2);
  assert.equal(first.message, "The engine refused the take");
  assert.equal(first.detail.remedy, "Cue it first");
  assert.equal(log.latestSequence(), 2);
  assert.deepEqual(
    log.list().map((record) => record.sequence),
    [1, 2],
    "oldest first, so the console can order by sequence"
  );
});

test("a caller's context is merged, and the failure's own values win", () => {
  const log = new DiagnosticsLog();

  const record = log.record({
    level: "error",
    source: "control/cue",
    context: { action: "cue", sceneId: "route-guess" },
    error: new PlayoutOperationError({
      code: "asset.content-unavailable",
      summary: "no bytes",
      context: { sceneId: "scene_real", assetId: "asset_1" }
    })
  });

  assert.equal(record.detail.context.action, "cue");
  // The route only guessed; the thrower knew.
  assert.equal(record.detail.context.sceneId, "scene_real");
  assert.equal(record.detail.context.assetId, "asset_1");
});

test("only records newer than a held sequence are returned", () => {
  const log = new DiagnosticsLog();
  for (let index = 0; index < 5; index += 1) {
    log.record({ level: "info", source: "engine", message: `event ${index}` });
  }

  assert.deepEqual(
    log.list({ since: 3 }).map((record) => record.message),
    ["event 3", "event 4"]
  );
  assert.deepEqual(log.list({ since: 5 }), [], "nothing new is empty, not a re-send");
  assert.equal(log.list({ limit: 2 }).length, 2);
  assert.equal(log.list({ limit: 2 })[1].message, "event 4", "a limit keeps the newest");
});

test("the log is bounded, so a reconnect loop cannot grow it without limit", () => {
  const log = new DiagnosticsLog();
  const total = DiagnosticsLog.CAPACITY + 25;
  for (let index = 0; index < total; index += 1) {
    log.record({ level: "warning", source: "engine", message: `attempt ${index}` });
  }

  const records = log.list();
  assert.equal(records.length, DiagnosticsLog.CAPACITY);
  assert.equal(records.at(-1).message, `attempt ${total - 1}`, "the newest is always kept");
  assert.equal(records[0].message, `attempt ${total - DiagnosticsLog.CAPACITY}`);
  assert.equal(log.latestSequence(), total);
});

test("clearing drops records but keeps counting, so a held sequence cannot be reused", () => {
  const log = new DiagnosticsLog();
  log.record({ level: "info", source: "engine", message: "one" });
  log.record({ level: "info", source: "engine", message: "two" });

  assert.equal(log.clear(), 2);
  assert.deepEqual(log.list(), []);

  const next = log.record({ level: "info", source: "engine", message: "three" });
  // A console holding `since: 2` must not be handed a fresh record 1 and skip it.
  assert.equal(next.sequence, 3);
});

test("a listener that throws cannot break the recording it was told about", () => {
  const log = new DiagnosticsLog();
  const seen = [];
  log.onRecord(() => {
    throw new Error("a subscriber blew up");
  });
  const detach = log.onRecord((record) => seen.push(record.sequence));

  const record = log.record({ level: "error", source: "control/take", message: "refused" });

  assert.equal(record.sequence, 1);
  assert.deepEqual(seen, [1], "a throwing listener does not stop the next one");
  assert.deepEqual(log.list().length, 1);

  detach();
  log.record({ level: "info", source: "engine", message: "after detach" });
  assert.deepEqual(seen, [1]);
});

// ---------------------------------------------------------------------------
// Describing what was thrown
// ---------------------------------------------------------------------------

test("an unexpected error keeps its stack, because the throw site is all there is", () => {
  const detail = describeError(new RangeError("index out of range"), "control.take-failed");

  assert.equal(detail.code, "control.take-failed");
  assert.equal(detail.summary, "index out of range");
  assert.match(detail.stack, /RangeError: index out of range/);
  assert.equal(detail.remedy, undefined, "no remedy is invented for an unexpected failure");
});

test("a cause chain is reported outermost first and cannot be walked forever", () => {
  const deep = new Error("ECONNREFUSED 127.0.0.1:4100");
  const middle = new Error("upload failed", { cause: deep });
  const outer = new PlayoutOperationError({
    code: "asset.upload-failed",
    summary: "the asset could not be sent",
    cause: middle
  });

  const detail = outer.detail();
  assert.equal(detail.cause, "upload failed");
  assert.deepEqual(detail.causeChain, ["upload failed", "ECONNREFUSED 127.0.0.1:4100"]);

  // A cycle is possible with hand-built errors and must not hang the reporting path.
  const left = new Error("left");
  const right = new Error("right", { cause: left });
  left.cause = right;
  assert.ok(describeError(new Error("outer", { cause: left })).causeChain.length <= 8);
});

test("something thrown that is not an error still produces a readable summary", () => {
  assert.equal(describeError("plain string failure").summary, "plain string failure");
  assert.match(describeError({ code: 7 }).summary, /non-error value was thrown: \{"code":7\}/);

  const circular = {};
  circular.self = circular;
  assert.match(describeError(circular).summary, /non-error value was thrown/);

  // An error with no message must still say something an operator can read.
  assert.equal(describeError(new Error("")).summary, "Error");
});

function assetFixture() {
  return {
    assetId: "asset_1",
    name: "bug.png",
    kind: "image",
    source: "http://127.0.0.1:4100/api/assets/asset_1/content",
    checksum: "b".repeat(64),
    status: "READY",
    importedAt: "2026-08-04T09:00:00.000Z"
  };
}
