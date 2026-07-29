import assert from "node:assert/strict";
import test from "node:test";

import {
  assessScenePreparation,
  AssetRegistry,
  assetReadiness,
  canTakeOnline,
  checkAssetPath,
  contentCachePath,
  findDuplicates,
  isValidSha256,
  UploadManager
} from "../dist/index.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function descriptor(assetId, sha256 = HASH_A, overrides = {}) {
  return {
    assetId,
    sourceUri: `assets/${assetId}.png`,
    transport: "engine-local",
    kind: "image",
    mimeType: "image/png",
    sha256,
    sizeBytes: 1024,
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// Content addressing
// ---------------------------------------------------------------------------

test("content hashes are validated and fan out into cache directories", () => {
  assert.equal(isValidSha256(HASH_A), true);
  assert.equal(isValidSha256("A".repeat(64)), false, "uppercase is rejected");
  assert.equal(isValidSha256("abc"), false);

  assert.equal(contentCachePath(HASH_A, "png"), `aa/aa/${HASH_A}.png`);
  assert.equal(contentCachePath(HASH_A), `aa/aa/${HASH_A}`);
  // The dot is optional in the caller's extension.
  assert.equal(contentCachePath(HASH_A, ".png"), `aa/aa/${HASH_A}.png`);
  assert.throws(() => contentCachePath("nope"), /invalid sha256/);
});

test("assets with identical content are found as duplicates", () => {
  const records = [
    { assetId: "logo-a", sha256: HASH_A },
    { assetId: "logo-b", sha256: HASH_A },
    { assetId: "other", sha256: HASH_B }
  ];

  assert.deepEqual(findDuplicates(records), [
    { sha256: HASH_A, assetIds: ["logo-a", "logo-b"] }
  ]);
});

test("identical content is fetched once and shared", () => {
  const registry = new AssetRegistry();

  registry.register(descriptor("first", HASH_A));
  registry.markCached("first", contentCachePath(HASH_A, "png"));

  // A different asset id with the same bytes inherits the cached path.
  const second = registry.register(descriptor("second", HASH_A));
  assert.equal(second.fetchState, "cached");
  assert.equal(second.cachedPath, contentCachePath(HASH_A, "png"));

  // Disk accounting counts the bytes once, not twice.
  assert.equal(registry.diskBytes(), 1024);
  assert.equal(registry.stats().uniqueContentHashes, 1);
});

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------

test("a relative traversal-free path inside a root is allowed", () => {
  const check = checkAssetPath("images/logo.png", ["/var/grapix/assets"]);
  assert.equal(check.allowed, true);
  assert.equal(check.root, "/var/grapix/assets");
});

test("a remote client can never name an arbitrary filesystem path", () => {
  const roots = ["/var/grapix/assets"];

  const cases = [
    ["/etc/passwd", "absolute-path"],
    ["\\Windows\\System32\\config", "absolute-path"],
    ["../../etc/passwd", "parent-traversal"],
    ["images/../../secret", "parent-traversal"],
    ["images\\..\\..\\secret", "parent-traversal"],
    ["file:///etc/passwd", "url-scheme"],
    ["http://evil/payload", "url-scheme"],
    ["C:/Windows/System32", "url-scheme"],
    ["", "empty"],
    ["   ", "empty"],
    ["images/logo\0.png", "null-byte"]
  ];

  for (const [candidate, reason] of cases) {
    const check = checkAssetPath(candidate, roots);
    assert.equal(check.allowed, false, `expected "${candidate}" to be rejected`);
    assert.equal(check.reason, reason, `wrong reason for "${candidate}"`);
  }
});

test("with no configured roots, nothing is allowed", () => {
  const check = checkAssetPath("images/logo.png", []);
  assert.equal(check.allowed, false);
  assert.equal(check.reason, "outside-roots");
});

// ---------------------------------------------------------------------------
// Asset state
// ---------------------------------------------------------------------------

test("readiness is derived from all three state machines", () => {
  const registry = new AssetRegistry();
  const record = registry.register(descriptor("img"));

  assert.equal(assetReadiness(record), "absent");

  registry.markFetching("img");
  assert.equal(assetReadiness(registry.get("img")), "preparing");

  registry.markCached("img", "aa/aa/x.png");
  assert.equal(assetReadiness(registry.get("img")), "preparing");

  registry.markDecoded("img", 4096, 64, 64);
  // Decoded but not uploaded is still preparing.
  assert.equal(assetReadiness(registry.get("img")), "preparing");

  registry.markUploaded("img", 4096);
  assert.equal(assetReadiness(registry.get("img")), "ready");
  assert.equal(registry.get("img").width, 64);
});

test("an evicted GPU texture is still ready, because it can be re-uploaded", () => {
  const registry = new AssetRegistry({ gpuBudgetBytes: 1 });
  registry.register(descriptor("img"));
  registry.markCached("img", "p");
  registry.markDecoded("img", 4096);
  registry.markUploaded("img", 4096);

  registry.evictGpu();
  const record = registry.get("img");
  assert.equal(record.gpuState, "evicted");
  // The decoded bytes are still there, so the scene is not broken.
  assert.equal(assetReadiness(record), "ready");
});

test("a failure at any stage marks the asset failed", () => {
  const registry = new AssetRegistry();
  registry.register(descriptor("bad"));
  registry.markFailed("bad", "decode", "unsupported PNG colour type");

  const record = registry.get("bad");
  assert.equal(assetReadiness(record), "failed");
  assert.equal(record.error, "unsupported PNG colour type");
});

test("referenced assets are never evicted", () => {
  const registry = new AssetRegistry({ gpuBudgetBytes: 1 });

  for (const id of ["a", "b"]) {
    registry.register(descriptor(id, id === "a" ? HASH_A : HASH_B));
    registry.markCached(id, `p-${id}`);
    registry.markDecoded(id, 4096);
    registry.markUploaded(id, 4096);
  }

  registry.acquire("a");
  const evicted = registry.evictGpu();

  assert.deepEqual(evicted, ["b"]);
  assert.equal(registry.get("a").gpuState, "uploaded");
});

test("eviction is least-recently-used", () => {
  const registry = new AssetRegistry({ gpuBudgetBytes: 4096 });

  for (const id of ["old", "middle", "new"]) {
    registry.register(descriptor(id, HASH_A.slice(0, 63) + (id === "old" ? "1" : id === "middle" ? "2" : "3")));
    registry.markCached(id, `p-${id}`);
    registry.markDecoded(id, 4096);
    registry.markUploaded(id, 4096);
  }

  // Touch them in order so "old" is genuinely the oldest.
  registry.acquire("old");
  registry.release("old");
  registry.acquire("middle");
  registry.release("middle");
  registry.acquire("new");
  registry.release("new");

  const evicted = registry.evictGpu();
  assert.equal(evicted[0], "old");
});

test("evicting decoded bytes also drops the GPU copy", () => {
  const registry = new AssetRegistry({ cpuBudgetBytes: 1 });
  registry.register(descriptor("img"));
  registry.markCached("img", "p");
  registry.markDecoded("img", 8192);
  registry.markUploaded("img", 8192);

  registry.evictDecoded();
  const record = registry.get("img");
  assert.equal(record.decodeState, "undecoded");
  assert.equal(record.gpuState, "evicted");
  assert.equal(record.decodedBytes, 0);
});

test("reference counting never goes negative", () => {
  const registry = new AssetRegistry();
  registry.register(descriptor("img"));

  assert.equal(registry.acquire("img"), 1);
  assert.equal(registry.acquire("img"), 2);
  assert.equal(registry.release("img"), 1);
  assert.equal(registry.release("img"), 0);
  assert.equal(registry.release("img"), 0);
});

test("stats report budgets and pressure", () => {
  const registry = new AssetRegistry({ cpuBudgetBytes: 1000, gpuBudgetBytes: 1000 });
  registry.register(descriptor("img"));
  registry.markCached("img", "p");
  registry.markDecoded("img", 5000);
  registry.markUploaded("img", 5000);

  const stats = registry.stats();
  assert.equal(stats.total, 1);
  assert.equal(stats.ready, 1);
  assert.equal(stats.overCpuBudget, true);
  assert.equal(stats.overGpuBudget, true);
});

// ---------------------------------------------------------------------------
// Chunked upload
// ---------------------------------------------------------------------------

test("a chunked upload completes and verifies its hash", () => {
  const uploads = new UploadManager({ maxChunkBytes: 1024 });

  const begun = uploads.begin("video", HASH_A, 3072, 3, 0);
  assert.equal(begun.accepted, true);

  for (const index of [0, 1, 2]) {
    const result = uploads.acceptChunk("video", index, 1024, index * 100);
    assert.equal(result.accepted, true);
    assert.equal(result.duplicate, false);
  }

  const session = uploads.get("video");
  assert.equal(session.complete, true);
  assert.equal(session.receivedBytes, 3072);

  assert.equal(uploads.finalize("video", HASH_A).accepted, true);
});

test("out-of-order chunks are accepted, because they will happen", () => {
  const uploads = new UploadManager({ maxChunkBytes: 1024 });
  uploads.begin("video", HASH_A, 3072, 3, 0);

  uploads.acceptChunk("video", 2, 1024, 0);
  uploads.acceptChunk("video", 0, 1024, 1);
  assert.deepEqual(uploads.missingChunks("video"), [1]);

  uploads.acceptChunk("video", 1, 1024, 2);
  assert.equal(uploads.get("video").complete, true);
});

test("a retransmitted chunk is idempotent, not double-counted", () => {
  const uploads = new UploadManager({ maxChunkBytes: 1024 });
  uploads.begin("video", HASH_A, 2048, 2, 0);

  uploads.acceptChunk("video", 0, 1024, 0);
  const repeat = uploads.acceptChunk("video", 0, 1024, 1);

  assert.equal(repeat.accepted, true);
  assert.equal(repeat.duplicate, true);
  assert.equal(uploads.get("video").receivedBytes, 1024);
});

test("an interrupted upload resumes rather than restarting", () => {
  const uploads = new UploadManager({ maxChunkBytes: 1024 });
  uploads.begin("video", HASH_A, 4096, 4, 0);
  uploads.acceptChunk("video", 0, 1024, 0);
  uploads.acceptChunk("video", 1, 1024, 1);

  // The client reconnects and begins again with the same parameters.
  const resumed = uploads.begin("video", HASH_A, 4096, 4, 5_000);
  assert.equal(resumed.accepted, true);
  assert.equal(resumed.duplicate, true);
  assert.equal(resumed.session.receivedBytes, 2048, "progress must be preserved");
  assert.deepEqual(uploads.missingChunks("video"), [2, 3]);
});

test("uploads are bounded by chunk and total size", () => {
  const uploads = new UploadManager({ maxChunkBytes: 512, maxTotalBytes: 4096 });

  const tooBig = uploads.begin("huge", HASH_A, 100_000, 200, 0);
  assert.equal(tooBig.accepted, false);
  assert.equal(tooBig.code, "TOTAL_TOO_LARGE");

  uploads.begin("ok", HASH_A, 1024, 2, 0);
  const fatChunk = uploads.acceptChunk("ok", 0, 4096, 0);
  assert.equal(fatChunk.accepted, false);
  assert.equal(fatChunk.code, "CHUNK_TOO_LARGE");
});

test("chunks outside the declared range are refused", () => {
  const uploads = new UploadManager();
  uploads.begin("v", HASH_A, 1024, 2, 0);

  assert.equal(uploads.acceptChunk("v", 5, 10, 0).code, "CHUNK_OUT_OF_RANGE");
  assert.equal(uploads.acceptChunk("v", -1, 10, 0).code, "CHUNK_OUT_OF_RANGE");
  assert.equal(uploads.acceptChunk("unknown", 0, 10, 0).code, "UNKNOWN_SESSION");
});

test("chunks that would exceed the declared total are refused", () => {
  const uploads = new UploadManager({ maxChunkBytes: 4096 });
  uploads.begin("v", HASH_A, 1000, 2, 0);

  uploads.acceptChunk("v", 0, 600, 0);
  const overflow = uploads.acceptChunk("v", 1, 600, 1);
  assert.equal(overflow.accepted, false);
  assert.equal(overflow.code, "SIZE_MISMATCH");
});

test("a checksum mismatch fails the upload rather than caching bad bytes", () => {
  const uploads = new UploadManager({ maxChunkBytes: 1024 });
  uploads.begin("v", HASH_A, 1024, 1, 0);
  uploads.acceptChunk("v", 0, 1024, 0);

  const result = uploads.finalize("v", HASH_B);
  assert.equal(result.accepted, false);
  assert.equal(result.code, "INVALID_HASH");
  assert.equal(uploads.get("v").checksumMismatch, true);
});

test("finalising an incomplete upload names the missing chunks", () => {
  const uploads = new UploadManager({ maxChunkBytes: 1024 });
  uploads.begin("v", HASH_A, 3072, 3, 0);
  uploads.acceptChunk("v", 0, 1024, 0);

  const result = uploads.finalize("v", HASH_A);
  assert.equal(result.accepted, false);
  assert.ok(result.message.includes("1, 2"));
});

test("abandoned sessions expire so they are not a leak", () => {
  const uploads = new UploadManager({ sessionTimeoutMs: 1_000, maxChunkBytes: 1024 });
  uploads.begin("stale", HASH_A, 2048, 2, 0);
  uploads.acceptChunk("stale", 0, 1024, 0);

  uploads.begin("fresh", HASH_B, 2048, 2, 5_000);

  const expired = uploads.expire(5_000);
  assert.deepEqual(expired, ["stale"]);
  assert.equal(uploads.sessionCount, 1);
});

test("an invalid hash is refused at session start", () => {
  const uploads = new UploadManager();
  const result = uploads.begin("v", "not-a-hash", 100, 1, 0);
  assert.equal(result.accepted, false);
  assert.equal(result.code, "INVALID_HASH");
});

// ---------------------------------------------------------------------------
// Scene preparation gate
// ---------------------------------------------------------------------------

function preparedRegistry(ids) {
  const registry = new AssetRegistry();
  for (const [index, id] of ids.entries()) {
    registry.register(descriptor(id, HASH_A.slice(0, 63) + String(index)));
    registry.markCached(id, `p-${id}`);
    registry.markDecoded(id, 1024);
    registry.markUploaded(id, 1024);
  }
  return registry;
}

test("a scene with every asset ready may be taken online", () => {
  const registry = preparedRegistry(["a", "b"]);
  const report = assessScenePreparation("scene_1", ["a", "b"], registry);

  assert.equal(report.state, "ready");
  assert.equal(report.readyAssets, 2);
  assert.deepEqual(report.takeBlockers, []);
  assert.deepEqual(canTakeOnline(report), { allowed: true, overridden: false });
});

test("a scene with no assets is trivially ready", () => {
  const report = assessScenePreparation("empty", [], new AssetRegistry());
  assert.equal(report.state, "ready");
  assert.equal(canTakeOnline(report).allowed, true);
});

test("an unregistered asset blocks a take", () => {
  const registry = preparedRegistry(["a"]);
  const report = assessScenePreparation("scene_1", ["a", "ghost"], registry);

  assert.equal(report.state, "failed");
  assert.deepEqual(report.missingAssetIds, ["ghost"]);
  assert.equal(canTakeOnline(report).allowed, false);
});

test("a still-loading asset blocks a take", () => {
  const registry = preparedRegistry(["a"]);
  registry.register(descriptor("slow", HASH_B));
  registry.markFetching("slow");

  const report = assessScenePreparation("scene_1", ["a", "slow"], registry);
  assert.equal(report.state, "loading");
  assert.ok(report.takeBlockers.some((blocker) => blocker.includes("still preparing")));
  assert.equal(canTakeOnline(report).allowed, false);
});

test("an operator can override an unprepared take, and it is recorded", () => {
  const registry = preparedRegistry([]);
  const report = assessScenePreparation("scene_1", ["ghost"], registry);
  assert.equal(canTakeOnline(report).allowed, false);

  const overridden = canTakeOnline(report, true);
  assert.equal(overridden.allowed, true);
  assert.equal(overridden.overridden, true);
  // The reason exists so the caller can write it to the audit log.
  assert.ok(overridden.reason.includes("operator overrode"));
  assert.ok(overridden.reason.includes("ghost"));
});

test("a failed asset blocks a take and is named", () => {
  const registry = preparedRegistry(["a"]);
  registry.register(descriptor("broken", HASH_B));
  registry.markFailed("broken", "fetch", "404");

  const report = assessScenePreparation("scene_1", ["a", "broken"], registry);
  assert.deepEqual(report.failedAssetIds, ["broken"]);
  assert.ok(report.takeBlockers.some((blocker) => blocker.includes("broken")));
});
