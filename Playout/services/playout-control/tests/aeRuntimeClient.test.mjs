import assert from "node:assert/strict";
import { once } from "node:events";
import net from "node:net";
import { test } from "node:test";
import { AE_RUNTIME_MAX_FRAME_BYTES } from "@grapix/adobe-common-schema";
import { AeRuntimeClient } from "../dist/aeRuntimeClient.js";

function encode(value) {
  const payload = Buffer.from(JSON.stringify(value));
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(payload.length);
  return Buffer.concat([prefix, payload]);
}

async function fakePipe(handler) {
  const path = `\\\\.\\pipe\\grapix-ae-client-test-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const server = net.createServer(handler);
  server.listen(path);
  await once(server, "listening");
  return { path, server };
}

function frames(socket, listener) {
  let buffered = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    while (buffered.length >= 4) {
      const size = buffered.readUInt32BE(0);
      if (buffered.length < size + 4) return;
      listener(JSON.parse(buffered.subarray(4, 4 + size)));
      buffered = buffered.subarray(4 + size);
    }
  });
}

const ack = (hello) => ({
  kind: "hello-ack", protocolMajor: 2, protocolMinor: 0, sessionId: hello.sessionId,
  capabilities: hello.capabilities,
  fingerprint: { aeVersion: "26.3", adapterVersion: "1", adapterSha256: "a".repeat(64), pluginSetSha256: "b".repeat(64), suiteVersions: {} },
  hostPid: 42
});

function runtimeEvent(sessionId, sequence, event = "RUNTIME_READY") {
  return {
    kind: "event", protocolMajor: 2, protocolMinor: 0, sessionId, sequence,
    at: `2026-08-17T00:00:0${sequence}.000Z`,
    event,
    detail: { reason: `${event}-${sequence}` }
  };
}

test("client HELLO and typed request preserve envelope identity", async () => {
  const { path, server } = await fakePipe((socket) => frames(socket, (message) => {
    if (message.kind === "hello") socket.write(encode(ack(message)));
    else socket.write(encode({
      kind: "result", protocolMajor: 2, protocolMinor: 0, sessionId: message.sessionId,
      requestId: message.requestId, sequence: message.sequence, operation: message.operation,
      ok: true, surface: "aegp-sdk", projectDigest: null, time: null, result: { resident: true }
    }));
  }));
  const client = new AeRuntimeClient({ sessionId: "test-session", token: "x".repeat(64), pipePath: path });
  try {
    const hello = await client.connect();
    assert.equal(hello.hostPid, 42);
    const health = await client.call("HEALTH", {}, { deadlineMs: 500 });
    assert.equal(health.ok, true);
    assert.equal(health.result.resident, true);
  } finally {
    await client.close();
    server.close();
  }
});

test("events are demultiplexed in arrival order while a call waits for its result", async () => {
  const { path, server } = await fakePipe((socket) => frames(socket, (message) => {
    if (message.kind === "hello") socket.write(encode(ack(message)));
    else {
      socket.write(Buffer.concat([
        encode(runtimeEvent(message.sessionId, 1, "RUNTIME_READY")),
        encode(runtimeEvent(message.sessionId, 3, "RUNTIME_DEGRADED")),
        encode(runtimeEvent(message.sessionId, 2, "RUNTIME_READY")),
        encode({
          kind: "result", protocolMajor: 2, protocolMinor: 0, sessionId: message.sessionId,
          requestId: message.requestId, sequence: message.sequence, operation: message.operation,
          ok: true, surface: "aegp-sdk", projectDigest: null, time: null, result: { resident: true }
        })
      ]));
    }
  }));
  const client = new AeRuntimeClient({ sessionId: "event-order", token: "x".repeat(64), pipePath: path });
  const received = [];
  client.onEvent(() => { throw new Error("listener failure must be isolated"); });
  client.onEvent((event) => received.push(event.event));
  try {
    await client.connect();
    const result = await client.call("HEALTH", {}, { deadlineMs: 500 });
    assert.equal(result.ok, true);
    assert.deepEqual(received, ["RUNTIME_READY", "RUNTIME_DEGRADED", "RUNTIME_READY"]);
    assert.equal(client.eventStats.listenerFailures, 3);
    assert.equal(client.eventStats.sequenceGaps, 1);
    assert.equal(client.eventStats.sequenceRegressions, 1);
  } finally {
    await client.close();
    server.close();
  }
});

test("foreign events are counted and pre-subscription event buffering is bounded", async () => {
  const { path, server } = await fakePipe((socket) => frames(socket, (message) => {
    if (message.kind === "hello") socket.write(encode(ack(message)));
    else {
      socket.write(Buffer.concat([
        encode(runtimeEvent("foreign-session", 1)),
        encode(runtimeEvent(message.sessionId, 1, "RUNTIME_READY")),
        encode(runtimeEvent(message.sessionId, 2, "RUNTIME_DEGRADED")),
        encode(runtimeEvent(message.sessionId, 3, "RUNTIME_READY")),
        encode({
          kind: "result", protocolMajor: 2, protocolMinor: 0, sessionId: message.sessionId,
          requestId: message.requestId, sequence: message.sequence, operation: message.operation,
          ok: true, surface: "aegp-sdk", projectDigest: null, time: null, result: {}
        })
      ]));
    }
  }));
  const client = new AeRuntimeClient({
    sessionId: "event-buffer", token: "x".repeat(64), pipePath: path, eventBufferLimit: 2
  });
  try {
    await client.connect();
    await client.call("HEALTH", {}, { deadlineMs: 500 });
    assert.deepEqual(client.eventStats, {
      buffered: 2, bufferDropped: 1, foreignSessionDropped: 1, listenerFailures: 0,
      lastSequence: 3, sequenceGaps: 0, sequenceRegressions: 0
    });
    const received = [];
    client.onEvent((event) => received.push(event.event));
    assert.deepEqual(received, ["RUNTIME_DEGRADED", "RUNTIME_READY"]);
    assert.equal(client.eventStats.buffered, 0);
  } finally {
    await client.close();
    server.close();
  }
});

test("oversize prefix is refused before allocation", async () => {
  const { path, server } = await fakePipe((socket) => frames(socket, (message) => {
    if (message.kind !== "hello") return;
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(AE_RUNTIME_MAX_FRAME_BYTES + 1);
    socket.write(prefix);
  }));
  const client = new AeRuntimeClient({ sessionId: "oversize", token: "x".repeat(64), pipePath: path, connectTimeoutMs: 500 });
  try {
    await assert.rejects(client.connect(), (error) => error.code === "FRAME_TOO_LARGE");
  } finally {
    await client.close();
    server.close();
  }
});

test("incompatible HELLO and mismatched result identity are refused", async () => {
  let incompatible = true;
  const { path, server } = await fakePipe((socket) => frames(socket, (message) => {
    if (message.kind === "hello") {
      socket.write(encode(incompatible ? { ...ack(message), protocolMajor: 99 } : ack(message)));
      incompatible = false;
    } else {
      socket.write(encode({
        kind: "result", protocolMajor: 2, protocolMinor: 0, sessionId: message.sessionId,
        requestId: "wrong", sequence: message.sequence, operation: message.operation,
        ok: true, surface: "aegp-sdk", projectDigest: null, time: null, result: {}
      }));
    }
  }));
  const first = new AeRuntimeClient({ sessionId: "incompatible", token: "x".repeat(64), pipePath: path, connectTimeoutMs: 500 });
  await assert.rejects(first.connect(), (error) => error.code === "PROTOCOL_INCOMPATIBLE");
  await first.close();
  const second = new AeRuntimeClient({ sessionId: "incompatible", token: "x".repeat(64), pipePath: path, connectTimeoutMs: 500 });
  try {
    await second.connect();
    await assert.rejects(second.call("HEALTH", {}, { deadlineMs: 500 }), (error) => error.code === "MALFORMED_FRAME");
  } finally {
    await second.close();
    server.close();
  }
});
