#!/usr/bin/env node
/**
 * AE-CD2 live evidence: one atomic revision across two real layers.
 *
 * Proves, against a running After Effects, that a revision is all-or-nothing: two members change
 * together in one call, and a batch containing one bad member changes neither. The values are read
 * back through `READ_PROPERTY` rather than trusted from the reply, and the fixture is restored.
 */
import net from "node:net";
import { randomUUID } from "node:crypto";

const sessionId = process.env.GRAPIX_AE_RUNTIME_SESSION_ID;
const token = process.env.GRAPIX_AE_RUNTIME_TOKEN;
const pipe = `\\\\.\\pipe\\grapix-ae-runtime-${sessionId}`;
const digest = "c".repeat(64);

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
  capabilities: ["project.discovery", "property.read", "property.write", "data.revision"]
}));
const hello = await next();

let sequence = 0;
async function call(operation, payload) {
  const requestId = randomUUID();
  socket.write(frame({
    kind: "request", protocolMajor: 2, protocolMinor: 0, sessionId, requestId,
    sequence: ++sequence, idempotencyKey: randomUUID(), deadlineUnixMs: Date.now() + 15000,
    expectedProjectDigest: digest, operation, payload
  }));
  const value = await next();
  if (value.requestId !== requestId) throw new Error("identity mismatch");
  return value;
}

const compositions = await call("LIST_COMPOSITIONS", {});
const composition = compositions.result[0];
const layers = await call("LIST_LAYERS", { compositionItemId: composition.itemId });

const first = Number(process.env.FIRST_LAYER_ID ?? 21);
const second = Number(process.env.SECOND_LAYER_ID ?? 20);
const target = (layerId) => ({ compositionItemId: composition.itemId, layerId, matchName: "ADBE Opacity" });
const member = (layerId, value) => ({
  target: { compositionItemId: composition.itemId, layerId, sourceItemId: null, path: [{ matchName: "ADBE Opacity", ordinal: 0 }] },
  value
});

const before = {
  first: (await call("READ_PROPERTY", target(first))).result,
  second: (await call("READ_PROPERTY", target(second))).result
};

// One revision, two members. Values chosen so neither can be confused with the prior value.
const applied = await call("APPLY_DATA_REVISION", {
  revision: 1,
  members: [member(first, 71), member(second, 62)]
});
const afterApplied = {
  first: (await call("READ_PROPERTY", target(first))).result,
  second: (await call("READ_PROPERTY", target(second))).result
};

// A batch whose second member is out of range must change neither layer.
const refused = await call("APPLY_DATA_REVISION", {
  revision: 2,
  members: [member(first, 34), member(second, 101)]
});
const afterRefused = {
  first: (await call("READ_PROPERTY", target(first))).result,
  second: (await call("READ_PROPERTY", target(second))).result
};

// A batch naming a layer that does not exist must also change nothing.
const refusedTarget = await call("APPLY_DATA_REVISION", {
  revision: 2,
  members: [member(first, 29), member(999999, 50)]
});
const afterRefusedTarget = {
  first: (await call("READ_PROPERTY", target(first))).result,
  second: (await call("READ_PROPERTY", target(second))).result
};

const restored = await call("APPLY_DATA_REVISION", {
  revision: 2,
  members: [member(first, before.first.value), member(second, before.second.value)]
});
const afterRestore = {
  first: (await call("READ_PROPERTY", target(first))).result,
  second: (await call("READ_PROPERTY", target(second))).result
};

socket.end();
console.log(JSON.stringify({
  hello: { protocolMajor: hello.protocolMajor, capabilities: hello.capabilities, aeVersion: hello.fingerprint?.aeVersion },
  composition: { itemId: composition.itemId, displayName: composition.displayName },
  layers: layers.result.map((entry) => ({ layerId: entry.layerId, displayName: entry.displayName })),
  before, applied, afterApplied,
  refused, afterRefused,
  refusedTarget, afterRefusedTarget,
  restored, afterRestore
}, null, 2));
