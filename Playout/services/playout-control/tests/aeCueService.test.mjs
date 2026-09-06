import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { resolveAeCueMap } from "@grapix/animation-engine";
import { AeCueService, AeCueServiceRefusal } from "../dist/aeCueService.js";

const fixture = JSON.parse(await readFile(new URL("../../../../Shared/animation-engine/fixtures/ae-cue-vectors.json", import.meta.url), "utf8"));
const compositionClock = { frameDuration: "1001", timeScale: "60000" };
const resolvedCueMap = resolveAeCueMap(fixture.cueMap.markers, fixture.cueMap.rate, compositionClock);
assert.ok(resolvedCueMap.ok, resolvedCueMap.ok ? "" : resolvedCueMap.message);
const digest = resolvedCueMap.digest;

function container(clock = compositionClock) {
  return {
    schemaVersion: 1, id: "lower-third", name: "Lower", projectUri: "show/lower.aep", projectDigest: "c".repeat(64),
    profile: { aeVersion: "26.3", renderer: "Mercury", workingColorSpace: "sRGB", frameRate: "60000/1001" },
    compositions: [{ itemId: 41, name: "LOWER_THIRD", width: 1920, height: 1080, clock: { ...clock } }],
    controls: [], dataBindings: [], cachePolicy: { mode: "none", maxPreparedFrames: 0 }, status: "ready",
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z"
  };
}

function recorded(value = container()) {
  return {
    containerId: value.id,
    compositionItemId: 41,
    projectDigest: value.projectDigest,
    cueMapDigest: digest,
    markers: fixture.cueMap.markers.map(({ text, time }) => ({ text, time })),
    rate: fixture.cueMap.rate,
    clock: { ...value.compositions[0].clock }
  };
}

function runtime() {
  const calls = [];
  return { calls, async call(operation, payload, options) { calls.push({ operation, payload, options }); return { ok: true, result: null }; } };
}

test("declared cue resolves to one digest-pinned composition-scale SET_TIME payload", async () => {
  const value = container(); const fake = runtime();
  const result = await new AeCueService(fake).setTime(value, recorded(value), { cueMapDigest: digest, role: "CONTINUE", id: "1" });
  assert.equal(result.ok, true);
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].operation, "SET_TIME");
  assert.deepEqual(fake.calls[0].payload, {
    containerId: "lower-third", compositionItemId: 41, projectDigest: "c".repeat(64), cueMapDigest: digest,
    time: { value: "3003", scale: "60000" },
    declaredTime: { value: "3003", scale: "60000" },
    clock: compositionClock,
    frame: 3, rate: { numerator: 60000, denominator: 1001 }, deadlineNanos: 50050000
  });
  assert.equal(fake.calls[0].options.expectedProjectDigest, "c".repeat(64));
  assert.equal(typeof fake.calls[0].options.idempotencyKey, "string");
});

test("digest mismatch and undeclared cue never call the adapter", async () => {
  const value = container(); const fake = runtime(); const service = new AeCueService(fake);
  await assert.rejects(
    service.setTime(value, recorded(value), { cueMapDigest: "d".repeat(64), role: "CUE" }),
    (error) => error instanceof AeCueServiceRefusal && error.code === "CUE_MAP_DIGEST_MISMATCH"
  );
  await assert.rejects(
    service.setTime(value, recorded(value), { cueMapDigest: digest, role: "CONTINUE", id: "absent" }),
    (error) => error instanceof AeCueServiceRefusal && error.code === "CUE_UNDECLARED"
  );
  assert.equal(fake.calls.length, 0);
});

test("rate a composition scale cannot carry is refused before SET_TIME", async () => {
  const value = container({ frameDuration: "800", timeScale: "23976" });
  const fake = runtime();
  await assert.rejects(
    new AeCueService(fake).setTime(value, recorded(value), { cueMapDigest: digest, role: "CONTINUE", id: "1" }),
    (error) => error instanceof AeCueServiceRefusal
      && error.code === "RATE_NOT_IN_COMPOSITION_SCALE"
      && error.message.includes("60000/1001")
      && error.message.includes("frameDuration=800, timeScale=23976")
  );
  assert.equal(fake.calls.length, 0);
});

test("recorded composition clock must match the container composition", async () => {
  const value = container();
  const fake = runtime();
  const stale = recorded(value);
  stale.clock = { frameDuration: "800", timeScale: "23976" };
  await assert.rejects(
    new AeCueService(fake).setTime(value, stale, { cueMapDigest: digest, role: "CONTINUE", id: "1" }),
    (error) => error instanceof AeCueServiceRefusal && error.code === "COMPOSITION_CLOCK_MISMATCH"
  );
  assert.equal(fake.calls.length, 0);
});
