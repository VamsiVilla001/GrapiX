import assert from "node:assert/strict";
import test from "node:test";
import { AeControlRefusal, AeControlService } from "../dist/aeControlService.js";

const control = {
  controlId: "91c2aa0d-4d8e-47df-8c5d-95acd5767ff2", displayName: "Score opacity", kind: "number", writable: true,
  updatePolicy: "immediate", target: { compositionItemId: 1, layerId: 21, sourceItemId: null, propertyPath: [{ matchName: "ADBE Opacity", ordinal: 0 }] },
  constraints: { minimum: 0, maximum: 100 }, validation: { status: "stale", reason: null, validatedProjectDigest: null, structuralFingerprint: null, validatedAt: null }
};
function container(controls = [structuredClone(control)]) { return { schemaVersion: 1, id: "lower-third", name: "Lower", projectUri: "show/lower.aep", projectDigest: "c".repeat(64), profile: { aeVersion: "26.3", renderer: "Mercury", workingColorSpace: "sRGB", frameRate: "30000/1001" }, compositions: [{ itemId: 1, name: "LOWER_THIRD", width: 1920, height: 1080, clock: { frameDuration: "1001", timeScale: "30000" } }], controls, cachePolicy: { mode: "none", maxPreparedFrames: 0 }, status: "ready", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }; }
const metadata = { target: { compositionItemId: 1, layerId: 21, sourceItemId: null, path: [{ matchName: "ADBE Opacity", ordinal: 0 }] }, displayName: "Opacity", valueType: "number", writable: true, readOnlyReason: null, timeVarying: false, expressionEnabled: false, surface: "aegp-sdk", structuralFingerprint: "ADBE Opacity:0" };
function runtime(meta = metadata) { const calls = []; return { calls, async call(operation, payload) { calls.push({ operation, payload }); if (operation === "READ_PROPERTY_METADATA") return { ok: true, result: [meta] }; return { ok: true, result: { value: payload.value } }; } }; }
async function refused(promise, code) { await assert.rejects(promise, (error) => error instanceof AeControlRefusal && error.code === code); }

test("undeclared and invalid values make no adapter set call", async () => {
  const fake = runtime(); const service = new AeControlService(fake); const value = container();
  await refused(service.write(value, { controlId: "00000000-0000-4000-8000-000000000000", value: 50, policy: "immediate" }), "CONTROL_UNDECLARED");
  assert.equal(fake.calls.length, 0);
  await refused(service.write(value, { controlId: control.controlId, value: 101, policy: "immediate" }), "CONTROL_VALIDATION_FAILED");
  assert.deepEqual(fake.calls.map((call) => call.operation), ["READ_PROPERTY_METADATA"]);
});

test("read-only metadata and stale identity refuse before SET_PROPERTY", async () => {
  const readOnly = runtime({ ...metadata, writable: false, readOnlyReason: "keyframed" });
  await refused(new AeControlService(readOnly).write(container(), { controlId: control.controlId, value: 50, policy: "immediate" }), "CONTROL_READ_ONLY");
  assert.deepEqual(readOnly.calls.map((call) => call.operation), ["READ_PROPERTY_METADATA"]);
  const stale = runtime({ ...metadata, target: { ...metadata.target, layerId: 22 } });
  await refused(new AeControlService(stale).write(container(), { controlId: control.controlId, value: 50, policy: "immediate" }), "CONTROL_TARGET_STALE");
  assert.deepEqual(stale.calls.map((call) => call.operation), ["READ_PROPERTY_METADATA"]);
});

test("validated declared control dispatches exact stable target", async () => {
  const fake = runtime(); const value = container();
  const result = await new AeControlService(fake).write(value, { controlId: control.controlId, value: 83, policy: "immediate", revision: 7 });
  assert.equal(result.ok, true);
  assert.deepEqual(fake.calls.map((call) => call.operation), ["READ_PROPERTY_METADATA", "SET_PROPERTY"]);
  assert.deepEqual(fake.calls[1].payload.path, [{ matchName: "ADBE Opacity", ordinal: 0 }]);
  assert.equal(value.controls[0].validation.status, "valid");
});
