#!/usr/bin/env node
import net from "node:net";
import { randomUUID } from "node:crypto";

const sessionId = process.env.GRAPIX_AE_RUNTIME_SESSION_ID;
const token = process.env.GRAPIX_AE_RUNTIME_TOKEN;
if (!sessionId || !token) throw new Error("GRAPIX_AE_RUNTIME_SESSION_ID and GRAPIX_AE_RUNTIME_TOKEN are required");
const pipe = `\\\\.\\pipe\\grapix-ae-runtime-${sessionId}`;

function frame(value) {
  const payload = Buffer.from(JSON.stringify(value));
  const prefix = Buffer.allocUnsafe(4);
  prefix.writeUInt32BE(payload.length);
  return Buffer.concat([prefix, payload]);
}

async function run() {
  const socket = net.connect(pipe);
  let buffered = Buffer.alloc(0);
  const frames = [];
  const waiters = [];
  const deliver = () => {
    while (buffered.length >= 4) {
      const length = buffered.readUInt32BE(0);
      if (buffered.length < length + 4) return;
      frames.push(JSON.parse(buffered.subarray(4, 4 + length)));
      buffered = buffered.subarray(4 + length);
    }
    while (frames.length > 0 && waiters.length > 0) waiters.shift().resolve(frames.shift());
  };
  socket.on("data", (chunk) => { buffered = Buffer.concat([buffered, chunk]); deliver(); });
  socket.on("error", (error) => {
    while (waiters.length > 0) waiters.shift().reject(error);
  });
  const waitFrame = () => frames.length > 0
    ? Promise.resolve(frames.shift())
    : new Promise((resolve, reject) => waiters.push({ resolve, reject }));
  await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  socket.write(frame({
    kind: "hello", protocolMajor: 2, protocolMinor: 0, sessionId, token,
    capabilities: ["project.discovery", "property.read", "property.write", "time.rational", "render.readiness"]
  }));
  const hello = await waitFrame();
  if (hello.kind !== "hello-ack") throw new Error(`HELLO refused: ${JSON.stringify(hello)}`);
  const requestId = randomUUID();
  socket.write(frame({
    kind: "request", protocolMajor: 2, protocolMinor: 0, sessionId,
    requestId, sequence: 1, idempotencyKey: randomUUID(), deadlineUnixMs: Date.now() + 10_000,
    expectedProjectDigest: null, operation: "HEALTH", payload: {}
  }));
  const health = await waitFrame();
  socket.end();
  if (!health.ok || health.requestId !== requestId) throw new Error(`HEALTH refused: ${JSON.stringify(health)}`);
  console.log(JSON.stringify({ hello, health }));
}

await run();
