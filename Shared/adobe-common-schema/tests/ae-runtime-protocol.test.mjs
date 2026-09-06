import assert from "node:assert/strict";
import test from "node:test";
import {
  AE_RUNTIME_CAPABILITIES,
  AE_RUNTIME_MAX_FRAME_BYTES,
  AE_RUNTIME_PROTOCOL_MAJOR,
  AeRuntimeProtocolError,
  assertAeRuntimeRequest,
  decodeAeRuntimeFrame,
  encodeAeRuntimeFrame,
  negotiateAeRuntimeHello
} from "../dist/index.js";

const fingerprint = {
  aeVersion: "26.3",
  adapterVersion: "1.0.0",
  adapterSha256: "a".repeat(64),
  pluginSetSha256: "b".repeat(64),
  suiteVersions: { AEGP_StreamSuite: 6 }
};

const hello = {
  kind: "hello",
  protocolMajor: AE_RUNTIME_PROTOCOL_MAJOR,
  protocolMinor: 0,
  sessionId: "session-1",
  token: "launch-secret",
  capabilities: [...AE_RUNTIME_CAPABILITIES]
};

test("codec round-trips every handshake field", () => {
  const decoded = decodeAeRuntimeFrame(encodeAeRuntimeFrame(hello));
  assert.deepEqual(decoded, hello);
  const ack = negotiateAeRuntimeHello(decoded, {
    sessionId: "session-1",
    token: "launch-secret",
    capabilities: AE_RUNTIME_CAPABILITIES,
    fingerprint,
    hostPid: 4820
  });
  assert.equal(ack.protocolMajor, AE_RUNTIME_PROTOCOL_MAJOR);
  assert.equal(ack.hostPid, 4820);
  assert.deepEqual(ack.fingerprint, fingerprint);
});

test("declared oversize is refused before payload parsing", () => {
  const frame = new Uint8Array(4);
  new DataView(frame.buffer).setUint32(0, AE_RUNTIME_MAX_FRAME_BYTES + 1, false);
  assert.throws(() => decodeAeRuntimeFrame(frame), (error) => error instanceof AeRuntimeProtocolError && error.code === "FRAME_TOO_LARGE");
});

test("wrong token, incompatible major and missing capability refuse negotiation", () => {
  const options = { sessionId: "session-1", token: "launch-secret", capabilities: AE_RUNTIME_CAPABILITIES, fingerprint, hostPid: 1 };
  assert.throws(() => negotiateAeRuntimeHello({ ...hello, token: "wrong" }, options), (error) => error.code === "AUTH_FAILED");
  assert.throws(() => negotiateAeRuntimeHello({ ...hello, protocolMajor: 99 }, options), (error) => error.code === "PROTOCOL_INCOMPATIBLE");
  assert.throws(
    () => negotiateAeRuntimeHello(hello, { ...options, capabilities: ["project.discovery"] }),
    (error) => error.code === "CAPABILITY_MISSING"
  );
});

test("request validation covers identity, digest and deadline", () => {
  const request = {
    kind: "request",
    protocolMajor: AE_RUNTIME_PROTOCOL_MAJOR,
    protocolMinor: 0,
    sessionId: "session-1",
    requestId: "request-1",
    sequence: 1,
    idempotencyKey: "same-effect-1",
    deadlineUnixMs: 20_000,
    expectedProjectDigest: "c".repeat(64),
    operation: "HEALTH",
    payload: {}
  };
  assert.doesNotThrow(() => assertAeRuntimeRequest(request, 10_000));
  assert.throws(() => assertAeRuntimeRequest({ ...request, deadlineUnixMs: 9_999 }, 10_000), (error) => error.code === "DEADLINE_EXPIRED");
  assert.throws(() => assertAeRuntimeRequest({ ...request, expectedProjectDigest: "C".repeat(64) }, 10_000), (error) => error.code === "INVALID_PAYLOAD");
});
