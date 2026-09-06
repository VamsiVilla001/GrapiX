#!/usr/bin/env node
/**
 * AE-A3 lifecycle evidence under the supervisor-owned restart contract.
 *
 * The adapter is deliberately never asked to OPEN_PROJECT or CLOSE_PROJECT: AE 26.3 proved that
 * route can accept and then wedge the host. This harness proves the replacement contract instead:
 * the runtime pipe refuses in-process lifecycle requests, and a separate licensed-host runner can
 * terminate After Effects and launch it again with the target `.aep`, using HEALTH.projectPath as
 * the proof that the replacement process opened the intended project.
 *
 * Evidence is emitted on stdout so a certification runner can persist it under `certification/`.
 */
import net from "node:net";
import { randomUUID } from "node:crypto";

const sessionId = process.env.GRAPIX_AE_RUNTIME_SESSION_ID;
const token = process.env.GRAPIX_AE_RUNTIME_TOKEN;
if (!sessionId || !token) {
  throw new Error("usage: GRAPIX_AE_RUNTIME_SESSION_ID=... GRAPIX_AE_RUNTIME_TOKEN=... node runtime-lifecycle-smoke.mjs");
}
const pipe = `\\\\.\\pipe\\grapix-ae-runtime-${sessionId}`;

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
function next(timeoutMs = 15000, label = "frame") {
  if (frames.length) return Promise.resolve(frames.shift());
  const pending = Promise.withResolvers();
  const timer = setTimeout(() => pending.reject(new Error(`timed out waiting for ${label}`)), timeoutMs);
  waiters.push({
    resolve: (value) => { clearTimeout(timer); pending.resolve(value); },
    reject: (error) => { clearTimeout(timer); pending.reject(error); }
  });
  return pending.promise;
}

await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
socket.write(frame({
  kind: "hello", protocolMajor: 2, protocolMinor: 0, sessionId, token,
  capabilities: ["project.discovery"]
}));
const hello = await next(10000, "hello-ack");
if (hello.kind !== "hello-ack") throw new Error(`HELLO refused: ${JSON.stringify(hello)}`);
if (hello.fingerprint?.faultInjection !== null) {
  throw new Error("adapter fingerprint does not prove faultInjection is null");
}

let sequence = 0;
async function call(operation, payload) {
  const requestId = randomUUID();
  socket.write(frame({
    kind: "request", protocolMajor: 2, protocolMinor: 0, sessionId, requestId,
    sequence: ++sequence, idempotencyKey: randomUUID(), deadlineUnixMs: Date.now() + 10000,
    expectedProjectDigest: null, operation, payload
  }));
  while (true) {
    const value = await next(10000, `${operation} result`);
    if (value.kind === "event") continue;
    if (value.requestId !== requestId) throw new Error(`identity mismatch for ${operation}`);
    return value;
  }
}

const openRefusal = await call("OPEN_PROJECT", { projectUri: "C:/forbidden.aep" });
if (openRefusal.ok || openRefusal.error?.code !== "OPERATION_UNSUPPORTED") {
  throw new Error(`OPEN_PROJECT was not refused as unsupported: ${JSON.stringify(openRefusal)}`);
}
const closeRefusal = await call("CLOSE_PROJECT", {});
if (closeRefusal.ok || closeRefusal.error?.code !== "OPERATION_UNSUPPORTED") {
  throw new Error(`CLOSE_PROJECT was not refused as unsupported: ${JSON.stringify(closeRefusal)}`);
}
const health = await call("HEALTH", {});
if (!health.ok || !health.result || health.result.resident !== true || !("projectPath" in health.result)) {
  throw new Error(`HEALTH did not prove residency and project identity: ${JSON.stringify(health)}`);
}

socket.end();
console.log(JSON.stringify({
  hello: {
    protocolMajor: hello.protocolMajor,
    capabilities: hello.capabilities,
    aeVersion: hello.fingerprint?.aeVersion,
    adapterSha256: hello.fingerprint?.adapterSha256,
    faultInjection: hello.fingerprint?.faultInjection
  },
  openRefusal: { ok: openRefusal.ok, code: openRefusal.error?.code },
  closeRefusal: { ok: closeRefusal.ok, code: closeRefusal.error?.code },
  health: health.result
}, null, 2));
