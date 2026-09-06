#!/usr/bin/env node
/**
 * AE-A3 breadth evidence: the four BO0a declared controls, `SET_TIME` and `LIST_EFFECTS`, live.
 *
 * Every value is read back through `READ_PROPERTY` rather than trusted from the write's reply, and the
 * fixture is restored before the session ends. This exercises the adapter directly; the production
 * `AeControlService` path is what `certify:ae-runtime-fixtures` drives.
 */
import net from "node:net";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";

const sessionId = process.env.GRAPIX_AE_RUNTIME_SESSION_ID;
const token = process.env.GRAPIX_AE_RUNTIME_TOKEN;
const pipe = `\\\\.\\pipe\\grapix-ae-runtime-${sessionId}`;
const digest = "c".repeat(64);
const evidencePath = process.env.GRAPIX_AE_EVIDENCE_PATH;
const readOnlyControl = process.env.GRAPIX_AE_EXPECT_READ_ONLY_CONTROL;
const expressionReadOnlyControl = process.env.GRAPIX_AE_EXPECT_EXPRESSION_CONTROL;

function frame(value) {
  const data = Buffer.from(JSON.stringify(value));
  const head = Buffer.allocUnsafe(4);
  head.writeUInt32BE(data.length);
  return Buffer.concat([head, data]);
}

const socket = net.connect(pipe);
let buffered = Buffer.alloc(0);
const frames = [];
const waiters = [];
socket.on("data", (chunk) => {
  buffered = Buffer.concat([buffered, chunk]);
  while (buffered.length >= 4 && buffered.length >= 4 + buffered.readUInt32BE(0)) {
    const size = buffered.readUInt32BE(0);
    const value = JSON.parse(buffered.subarray(4, 4 + size));
    buffered = buffered.subarray(4 + size);
    const waiter = waiters.shift();
    waiter ? waiter.resolve(value) : frames.push(value);
  }
});
function next() {
  if (frames.length) return Promise.resolve(frames.shift());
  const pending = Promise.withResolvers();
  waiters.push(pending);
  return pending.promise;
}

await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
socket.write(frame({
  kind: "hello", protocolMajor: 2, protocolMinor: 0, sessionId, token,
  capabilities: ["project.discovery", "property.read", "property.write", "time.rational", "data.revision"]
}));
await next();

let sequence = 0;
async function call(operation, payload) {
  const requestId = randomUUID();
  socket.write(frame({
    kind: "request", protocolMajor: 2, protocolMinor: 0, sessionId, requestId,
    sequence: ++sequence, idempotencyKey: randomUUID(), deadlineUnixMs: Date.now() + 20000,
    expectedProjectDigest: digest, operation, payload
  }));
  const value = await next();
  if (value.requestId !== requestId) throw new Error("identity mismatch");
  return value;
}

const composition = (await call("LIST_COMPOSITIONS", {})).result[0];
const itemId = composition.itemId;
const layers = (await call("LIST_LAYERS", { compositionItemId: itemId })).result;
const layerFor = (name) => layers.find((entry) => entry.displayName === name)?.layerId ?? null;

const targets = {
  SCORE: { layerId: layerFor("SCORE"), path: [{ matchName: "ADBE Text Properties", ordinal: 0 }, { matchName: "ADBE Text Document", ordinal: 0 }] },
  PLAYER_NAME: { layerId: layerFor("PLAYER_NAME"), path: [{ matchName: "ADBE Text Properties", ordinal: 0 }, { matchName: "ADBE Text Document", ordinal: 0 }] },
  TEAM_COLOR: { layerId: layerFor("TEAM_COLOR"), path: [{ matchName: "ADBE Effect Parade", ordinal: 0 }, { matchName: "ADBE Fill", ordinal: 0 }, { matchName: "ADBE Fill-0002", ordinal: 0 }] },
  PLAYER_IMAGE: { layerId: layerFor("PLAYER_IMAGE"), path: [{ matchName: "ADBE Opacity", ordinal: 0 }] }
};
const target = (name) => ({ compositionItemId: itemId, layerId: targets[name].layerId, sourceItemId: null, path: targets[name].path });

const discovered = {};
const effects = {};
for (const name of Object.keys(targets)) {
  discovered[name] = (await call("LIST_PROPERTIES", { compositionItemId: itemId, layerId: targets[name].layerId })).result
    ?.map((entry) => ({
      canonical: entry.target.path.map((s) => s.matchName).join("/"),
      valueType: entry.valueType,
      writable: entry.writable,
      readOnlyReason: entry.readOnlyReason,
      timeVarying: entry.timeVarying,
      expressionEnabled: entry.expressionEnabled,
      surface: entry.surface,
      structuralFingerprint: entry.structuralFingerprint
    }));
  const listed = await call("LIST_EFFECTS", { compositionItemId: itemId, layerId: targets[name].layerId });
  effects[name] = listed.ok ? listed.result : { error: listed.error?.code };
}

const before = {};
for (const name of Object.keys(targets)) {
  before[name] = (await call("READ_PROPERTY", target(name))).result;
}
let readOnlyProbe = null;
if (readOnlyControl) {
  if (!(readOnlyControl in targets)) throw new Error(`unknown read-only control ${readOnlyControl}`);
  const readOnlyTarget = target(readOnlyControl);
  const metadata = await call("READ_PROPERTY_METADATA", readOnlyTarget);
  const valueBefore = await call("READ_PROPERTY", readOnlyTarget);
  const attempted = await call("SET_PROPERTY", { ...readOnlyTarget, value: 50 });
  const valueAfter = await call("READ_PROPERTY", readOnlyTarget);
  if (attempted.ok || attempted.error?.code !== "PROPERTY_READ_ONLY") {
    throw new Error(`unsafe control did not refuse PROPERTY_READ_ONLY: ${JSON.stringify(attempted)}`);
  }
  if (JSON.stringify(valueBefore.result) !== JSON.stringify(valueAfter.result)) {
    throw new Error("unsafe control changed despite refusal");
  }
  readOnlyProbe = {
    control: readOnlyControl,
    metadata: metadata.result,
    attemptedWrite: { ok: attempted.ok, code: attempted.error?.code },
    valueBefore: valueBefore.result,
    valueAfter: valueAfter.result
  };
}
let expressionReadOnlyProbe = null;
if (expressionReadOnlyControl) {
  if (!(expressionReadOnlyControl in targets)) {
    throw new Error(`unknown expression control ${expressionReadOnlyControl}`);
  }
  const expressionTarget = {
    ...target(expressionReadOnlyControl),
    path: [{ matchName: "ADBE Rotate Z", ordinal: 0 }]
  };
  const metadata = await call("READ_PROPERTY_METADATA", expressionTarget);
  const valueBefore = await call("READ_PROPERTY", expressionTarget);
  const attempted = await call("SET_PROPERTY", { ...expressionTarget, value: 50 });
  const valueAfter = await call("READ_PROPERTY", expressionTarget);
  const property = metadata.result?.find((entry) =>
    entry.target.path.map((segment) => segment.matchName).join("/") === "ADBE Rotate Z");
  if (property?.readOnlyReason !== "expression-enabled") {
    throw new Error(`expression metadata did not report expression-enabled: ${JSON.stringify(metadata)}`);
  }
  if (attempted.ok || attempted.error?.code !== "PROPERTY_READ_ONLY") {
    throw new Error(`expression control did not refuse PROPERTY_READ_ONLY: ${JSON.stringify(attempted)}`);
  }
  if (JSON.stringify(valueBefore.result) !== JSON.stringify(valueAfter.result)) {
    throw new Error("expression control changed despite refusal");
  }
  expressionReadOnlyProbe = {
    control: expressionReadOnlyControl,
    metadata: property,
    attemptedWrite: { ok: attempted.ok, code: attempted.error?.code },
    valueBefore: valueBefore.result,
    valueAfter: valueAfter.result
  };
}
const footageReplacementRefusal = await call("REPLACE_FOOTAGE", {
  compositionItemId: itemId,
  layerId: targets.PLAYER_IMAGE.layerId,
  assetId: "fixture-player-image"
});
if (footageReplacementRefusal.ok ||
    footageReplacementRefusal.error?.code !== "OPERATION_UNSUPPORTED") {
  throw new Error(`footage replacement did not refuse as unsupported: ${JSON.stringify(footageReplacementRefusal)}`);
}

// One atomic revision carrying text, text and colour together.
const revision = await call("APPLY_DATA_REVISION", {
  revision: 1,
  members: [
    { target: target("SCORE"), value: "137" },
    { target: target("PLAYER_NAME"), value: "GRAPIX LIVE" },
    { target: target("TEAM_COLOR"), value: "#1E90FF" }
  ]
});
const afterRevision = {};
for (const name of Object.keys(targets)) {
  afterRevision[name] = (await call("READ_PROPERTY", target(name))).result;
}

// A batch whose colour member is malformed must leave all three untouched.
const refusedBatch = await call("APPLY_DATA_REVISION", {
  revision: 2,
  members: [
    { target: target("SCORE"), value: "777" },
    { target: target("TEAM_COLOR"), value: "not-a-colour" }
  ]
});
const afterRefused = {};
for (const name of Object.keys(targets)) {
  afterRefused[name] = (await call("READ_PROPERTY", target(name))).result;
}

// The instant PL1 resolves at 30000/1001. The composition's own scale is 23976, which cannot represent
// it, so this must be refused rather than quantised onto a neighbouring instant.
const setTimeQuantised = await call("SET_TIME", {
  containerId: "bo0a-lower-third-v1",
  compositionItemId: itemId,
  projectDigest: digest,
  cueMapDigest: "0".repeat(64),
  time: { value: "1001", scale: "30000" },
  frame: 1,
  rate: { numerator: 30000, denominator: 1001 },
  deadlineNanos: 33366666
});
// The same frame stated in the composition's own scale is exactly representable, so it must succeed.
const setTimeOnFrame = await call("SET_TIME", {
  containerId: "bo0a-lower-third-v1",
  compositionItemId: itemId,
  projectDigest: digest,
  cueMapDigest: "0".repeat(64),
  time: { value: "800", scale: "23976" },
  frame: 1,
  rate: { numerator: 23976, denominator: 800 },
  deadlineNanos: 33366666
});
const setTimeZero = await call("SET_TIME", {
  containerId: "bo0a-lower-third-v1",
  compositionItemId: itemId,
  projectDigest: digest,
  cueMapDigest: "0".repeat(64),
  time: { value: "0", scale: "30000" },
  frame: 0,
  rate: { numerator: 30000, denominator: 1001 },
  deadlineNanos: 0
});
const setTimeRefused = await call("SET_TIME", {
  containerId: "bo0a-lower-third-v1",
  compositionItemId: itemId,
  projectDigest: digest,
  cueMapDigest: "0".repeat(64),
  time: { value: "-5", scale: "30000" },
  frame: 0,
  rate: { numerator: 30000, denominator: 1001 },
  deadlineNanos: 0
});

const restored = await call("APPLY_DATA_REVISION", {
  revision: 2,
  members: [
    { target: target("SCORE"), value: String(before.SCORE.value) },
    { target: target("PLAYER_NAME"), value: String(before.PLAYER_NAME.value) },
    { target: target("TEAM_COLOR"), value: String(before.TEAM_COLOR.value) }
  ]
});
const afterRestore = {};
for (const name of Object.keys(targets)) {
  afterRestore[name] = (await call("READ_PROPERTY", target(name))).result;
}

socket.end();
const evidence = JSON.stringify({
  composition: { itemId, displayName: composition.displayName },
  layerIds: Object.fromEntries(Object.entries(targets).map(([k, v]) => [k, v.layerId])),
  discovered, effects, before, readOnlyProbe, expressionReadOnlyProbe,
  footageReplacementRefusal: {
    ok: footageReplacementRefusal.ok,
    code: footageReplacementRefusal.error?.code
  },
  setTime: {
    quantised: { ok: setTimeQuantised.ok, code: setTimeQuantised.error?.code, detail: setTimeQuantised.result },
    onFrame: { ok: setTimeOnFrame.ok, result: setTimeOnFrame.result, code: setTimeOnFrame.error?.code },
    zero: { ok: setTimeZero.ok, result: setTimeZero.result },
    negative: { ok: setTimeRefused.ok, code: setTimeRefused.error?.code }
  },
  revision: { ok: revision.ok, error: revision.error?.code, applied: revision.result?.applied },
  afterRevision,
  refusedBatch: { ok: refusedBatch.ok, code: refusedBatch.error?.code },
  afterRefused,
  restored: { ok: restored.ok },
  afterRestore
}, null, 2);
if (evidencePath) writeFileSync(evidencePath, `${evidence}\n`);
console.log(evidence);
