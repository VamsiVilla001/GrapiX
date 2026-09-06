import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AeDataRevisionRefusal } from "../../../../Shared/ae-runtime-contract/dist/index.js";
import { AeControlService } from "../dist/aeControlService.js";
import { AeDataRevisionTracker } from "../dist/aeDataRevisionTracker.js";
import { AeRevisionService } from "../dist/aeRevisionService.js";

const SCORE = "91c2aa0d-4d8e-47df-8c5d-95acd5767ff2";
const NAME = "6f5b4d0e-1c2a-4f3b-9d8e-7a6b5c4d3e2f";

function control(controlId, layerId, displayName) {
  return {
    controlId,
    displayName,
    kind: "number",
    writable: true,
    updatePolicy: "immediate",
    target: { compositionItemId: 1, layerId, sourceItemId: null, propertyPath: [{ matchName: "ADBE Opacity", ordinal: 0 }] },
    constraints: { minimum: 0, maximum: 100 },
    validation: { status: "stale", reason: null, validatedProjectDigest: null, structuralFingerprint: null, validatedAt: null }
  };
}

function container(overrides = {}) {
  return {
    schemaVersion: 1,
    id: "lower-third",
    name: "Lower",
    projectUri: "show/lower.aep",
    projectDigest: "c".repeat(64),
    profile: { aeVersion: "26.3", renderer: "Advanced 3D", workingColorSpace: "sRGB", frameRate: "30000/1001" },
    compositions: [{ itemId: 1, name: "LOWER_THIRD", width: 1920, height: 1080, clock: { frameDuration: "1001", timeScale: "30000" } }],
    controls: [control(SCORE, 21, "Score opacity"), control(NAME, 20, "Name opacity")],
    dataBindings: [
      { controlId: SCORE, dataPath: "scoreboard.home.opacity" },
      { controlId: NAME, dataPath: "scoreboard.away.opacity" }
    ],
    cachePolicy: { mode: "none", maxPreparedFrames: 0 },
    status: "ready",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides
  };
}

function metadataFor(layerId, overrides = {}) {
  return {
    target: { compositionItemId: 1, layerId, sourceItemId: null, path: [{ matchName: "ADBE Opacity", ordinal: 0 }] },
    displayName: "Opacity",
    valueType: "number",
    writable: true,
    readOnlyReason: null,
    timeVarying: false,
    expressionEnabled: false,
    surface: "aegp-sdk",
    structuralFingerprint: "ADBE Opacity:0",
    ...overrides
  };
}

/** A fake adapter that answers metadata per layer and records every dispatched operation. */
function runtime(options = {}) {
  const calls = [];
  return {
    calls,
    async call(operation, payload) {
      calls.push({ operation, payload });
      if (operation === "READ_PROPERTY_METADATA") {
        const overrides = options.metadata?.[payload.layerId] ?? {};
        return { ok: true, result: [metadataFor(payload.layerId, overrides)] };
      }
      if (operation === "APPLY_DATA_REVISION") {
        options.onApply?.();
        if (options.applyGate) await options.applyGate;
        if (options.revisionError) return { ok: false, error: options.revisionError };
        return {
          ok: true,
          result: {
            revision: payload.revision,
            applied: payload.members.map((member) => ({ target: member.target, previousValue: 100, value: member.value })),
            rolledBack: false
          }
        };
      }
      return { ok: true, result: { value: payload.value } };
    }
  };
}

function auditSink(capacity = 16) {
  const reserved = [];
  return {
    reserved,
    reserve(count) {
      if (count > capacity) return null;
      let remaining = count;
      const reservation = {
        sink: "events",
        get remaining() { return remaining; },
        release() { remaining = 0; }
      };
      reserved.push({ count, reservation });
      return reservation;
    }
  };
}

async function fixture(options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "grapix-ae-revision-"));
  const fake = runtime(options);
  const tracker = new AeDataRevisionTracker(root);
  const service = new AeRevisionService(new AeControlService(fake), tracker, fake);
  return { root, fake, tracker, service, audit: auditSink(options.auditCapacity ?? 16) };
}

const cleanup = (state) => rm(state.root, { recursive: true, force: true });

function requestFor(revision, dataContext, key) {
  return {
    baseRevision: revision - 1,
    revision,
    idempotencyKey: key ?? `key-${revision}`,
    dataContext
  };
}

const bothOpacities = (home, away) => ({ scoreboard: { home: { opacity: home }, away: { opacity: away } } });

async function refused(promise, code) {
  let refusal;
  await assert.rejects(promise, (error) => {
    refusal = error;
    return error instanceof AeDataRevisionRefusal && error.code === code;
  });
  return refusal;
}

test("a multi-control snapshot is one accepted revision and one adapter call", async () => {
  const state = await fixture();
  try {
    const { application } = await state.service.apply(container(), requestFor(1, bothOpacities(83, 42)), state.audit);

    assert.equal(application.duplicate, false);
    assert.equal(application.state.acceptedRevision, 1);
    assert.deepEqual(application.state.acceptedControlIds, [SCORE, NAME]);

    const applies = state.fake.calls.filter((call) => call.operation === "APPLY_DATA_REVISION");
    assert.equal(applies.length, 1, "one revision is one dispatch, never one per control");
    assert.equal(applies[0].payload.members.length, 2);
    assert.deepEqual(applies[0].payload.members.map((member) => member.value), [83, 42]);
    assert.deepEqual(applies[0].payload.members[0].target.path, [{ matchName: "ADBE Opacity", ordinal: 0 }]);
    assert.equal(state.fake.calls.filter((call) => call.operation === "SET_PROPERTY").length, 0);

    // Capacity is claimed for every member plus the revision itself, before the dispatch.
    assert.deepEqual(state.audit.reserved.map((entry) => entry.count), [3]);
  } finally { await cleanup(state); }
});

test("an idempotent retry neither re-applies nor increments", async () => {
  const state = await fixture();
  try {
    const request = requestFor(1, bothOpacities(83, 42), "retry-me");
    await state.service.apply(container(), request, state.audit);
    const dispatchesAfterFirst = state.fake.calls.filter((call) => call.operation === "APPLY_DATA_REVISION").length;

    const { application } = await state.service.apply(container(), request, state.audit);
    assert.equal(application.duplicate, true);
    assert.equal(application.result, null, "a retry has no envelope because nothing was dispatched");
    assert.equal(application.state.acceptedRevision, 1, "the accepted revision does not move");
    assert.equal(
      state.fake.calls.filter((call) => call.operation === "APPLY_DATA_REVISION").length,
      dispatchesAfterFirst,
      "the retry reached no adapter call"
    );
    assert.deepEqual(state.audit.reserved.map((entry) => entry.count), [3], "a retry claims no audit capacity");
  } finally { await cleanup(state); }
});

test("one bad member rejects the whole batch before any adapter mutation", async () => {
  const outOfRange = await fixture();
  try {
    await refused(
      outOfRange.service.apply(container(), requestFor(1, bothOpacities(83, 101)), outOfRange.audit),
      "REVISION_MEMBER_INVALID"
    );
    assert.equal(outOfRange.fake.calls.filter((call) => call.operation === "APPLY_DATA_REVISION").length, 0);
    assert.equal((await outOfRange.tracker.read("lower-third")).acceptedRevision, 0);
    assert.deepEqual(outOfRange.audit.reserved, [], "a batch that never dispatches claims no capacity");
  } finally { await cleanup(outOfRange); }

  const readOnly = await fixture({ metadata: { 20: { writable: false, readOnlyReason: "keyframed" } } });
  try {
    await refused(
      readOnly.service.apply(container(), requestFor(1, bothOpacities(83, 42)), readOnly.audit),
      "REVISION_MEMBER_INVALID"
    );
    assert.equal(readOnly.fake.calls.filter((call) => call.operation === "APPLY_DATA_REVISION").length, 0);
  } finally { await cleanup(readOnly); }

  const undeclared = await fixture();
  try {
    const withUndeclared = container({
      dataBindings: [{ controlId: "00000000-0000-4000-8000-000000000000", dataPath: "scoreboard.home.opacity" }]
    });
    await refused(
      undeclared.service.apply(withUndeclared, requestFor(1, bothOpacities(83, 42)), undeclared.audit),
      "REVISION_MEMBER_INVALID"
    );
    assert.equal(undeclared.fake.calls.length, 0, "an undeclared control reaches no adapter call at all");
  } finally { await cleanup(undeclared); }

  const missing = await fixture();
  try {
    await refused(
      missing.service.apply(container(), requestFor(1, { scoreboard: { home: { opacity: 83 } } }), missing.audit),
      "REVISION_MEMBER_INVALID"
    );
    assert.equal(missing.fake.calls.filter((call) => call.operation === "APPLY_DATA_REVISION").length, 0);
  } finally { await cleanup(missing); }
});

test("gap, conflict and non-monotonic revisions refuse with their own codes", async () => {
  const state = await fixture();
  try {
    await state.service.apply(container(), requestFor(1, bothOpacities(83, 42)), state.audit);

    await refused(state.service.apply(container(), requestFor(5, bothOpacities(1, 2)), state.audit), "REVISION_GAP");
    await refused(state.service.apply(container(), requestFor(1, bothOpacities(1, 2), "different"), state.audit), "REVISION_CONFLICT");
    await refused(
      state.service.apply(container(), { baseRevision: 0, revision: 4, idempotencyKey: "skips", dataContext: bothOpacities(1, 2) }, state.audit),
      "REVISION_NOT_MONOTONIC"
    );
    await refused(
      state.service.apply(container(), { baseRevision: -1, revision: 0, idempotencyKey: "negative", dataContext: bothOpacities(1, 2) }, state.audit),
      "REVISION_NOT_MONOTONIC"
    );

    assert.equal((await state.tracker.read("lower-third")).acceptedRevision, 1);
    assert.equal(state.fake.calls.filter((call) => call.operation === "APPLY_DATA_REVISION").length, 1);
  } finally { await cleanup(state); }
});

test("concurrent applies for one container serialize and the stale contender conflicts before dispatch", async () => {
  let releaseFirst;
  let signalFirstApply;
  const applyGate = new Promise((resolve) => { releaseFirst = resolve; });
  const applyStarted = new Promise((resolve) => { signalFirstApply = resolve; });
  const state = await fixture({ applyGate, onApply: signalFirstApply });
  try {
    const first = state.service.apply(container(), requestFor(1, bothOpacities(83, 42), "first"), state.audit);
    await applyStarted;
    const second = state.service.apply(container(), requestFor(1, bothOpacities(1, 2), "second"), state.audit);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      state.fake.calls.filter((call) => call.operation === "APPLY_DATA_REVISION").length,
      1,
      "the later apply waits for the first accepted revision instead of reaching AE concurrently"
    );

    releaseFirst();
    await first;
    await refused(second, "REVISION_CONFLICT");
    assert.equal(state.fake.calls.filter((call) => call.operation === "APPLY_DATA_REVISION").length, 1);
    assert.equal((await state.tracker.read("lower-third")).acceptedRevision, 1);
  } finally { await cleanup(state); }
});

test("a rolled-back adapter revision leaves the accepted revision untouched", async () => {
  const state = await fixture({
    revisionError: { code: "REVISION_ROLLED_BACK", message: "restored every applied member", retryable: false }
  });
  try {
    const error = await refused(
      state.service.apply(container(), requestFor(1, bothOpacities(83, 42)), state.audit),
      "REVISION_ROLLED_BACK"
    );
    assert.equal(error.message, "restored every applied member");
    assert.equal((await state.tracker.read("lower-third")).acceptedRevision, 0);
    // The capacity claimed for the failed attempt is handed back rather than leaked.
    assert.equal(state.audit.reserved[0].reservation.remaining, 0);
  } finally { await cleanup(state); }
});

test("a failed rollback names the mixed state and leaves the revision unaccepted", async () => {
  const state = await fixture({
    revisionError: { code: "REVISION_ROLLBACK_FAILED", message: "restore of member 0 failed", retryable: false }
  });
  try {
    const error = await refused(
      state.service.apply(container(), requestFor(1, bothOpacities(83, 42)), state.audit),
      "REVISION_ROLLBACK_FAILED"
    );
    assert.match(error.message, /mixed state/i);
    assert.match(error.message, /No retry is safe until a human has inspected the project/i);
    assert.equal((await state.tracker.read("lower-third")).acceptedRevision, 0);
    assert.equal(state.audit.reserved[0].reservation.remaining, 0);
  } finally { await cleanup(state); }
});

test("a revision is refused when the audit sink cannot promise its records", async () => {
  const state = await fixture({ auditCapacity: 2 });
  try {
    await refused(
      state.service.apply(container(), requestFor(1, bothOpacities(83, 42)), state.audit),
      "REVISION_AUDIT_UNAVAILABLE"
    );
    assert.equal(state.fake.calls.filter((call) => call.operation === "APPLY_DATA_REVISION").length, 0);
    assert.equal((await state.tracker.read("lower-third")).acceptedRevision, 0);
  } finally { await cleanup(state); }
});

test("the accepted revision survives a new tracker on the same data root", async () => {
  const state = await fixture();
  try {
    await state.service.apply(container(), requestFor(1, bothOpacities(83, 42)), state.audit);
    const reopened = await new AeDataRevisionTracker(state.root).read("lower-third");
    assert.equal(reopened.acceptedRevision, 1);
    assert.equal(reopened.acceptedIdempotencyKey, "key-1");
    assert.deepEqual(reopened.acceptedControlIds, [SCORE, NAME]);
  } finally { await cleanup(state); }
});

test("a container with no bindings has nothing to revise", async () => {
  const state = await fixture();
  try {
    await refused(
      state.service.apply(container({ dataBindings: [] }), requestFor(1, bothOpacities(83, 42)), state.audit),
      "REVISION_NO_MEMBERS"
    );
    assert.equal(state.fake.calls.length, 0);
  } finally { await cleanup(state); }
});
