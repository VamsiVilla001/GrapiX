import assert from "node:assert/strict";
import { test } from "node:test";
import { AdobeClient, AdobeToolError } from "../dist/index.js";

class FakeWebSocket {
  static instances = [];

  constructor() {
    this.listeners = new Map();
    this.sent = [];
    this.throwOnSend = false;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  emit(type, event = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  send(value) {
    if (this.throwOnSend) throw new Error("socket send failed");
    this.sent.push(value);
  }

  close() {
    this.emit("close", { reason: "closed" });
  }
}

async function connectedClient() {
  const client = new AdobeClient({ token: "test", webSocketImpl: FakeWebSocket });
  const connecting = client.connect();
  const socket = FakeWebSocket.instances.at(-1);
  socket.emit("open");
  socket.emit("message", {
    data: JSON.stringify({ type: "hello.ack", role: "client", gatewayVersion: "test", peerId: "peer" })
  });
  await connecting;
  return { client, socket };
}

test("an already-aborted call is rejected without sending a tool request", async () => {
  const { client, socket } = await connectedClient();
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    client.call("photoshop.getActiveDocument", {}, { signal: controller.signal }),
    (error) => error instanceof AdobeToolError && error.code === "cancelled"
  );
  assert.equal(socket.sent.length, 1, "only the hello frame was sent");
  client.disconnect();
});

test("a synchronous tool send failure rejects without leaving a live request", async () => {
  const { client, socket } = await connectedClient();
  socket.throwOnSend = true;

  await assert.rejects(client.call("photoshop.getActiveDocument"), /socket send failed/);
  socket.throwOnSend = false;
  const result = client.call("photoshop.getActiveDocument");
  socket.emit("message", {
    data: JSON.stringify({ type: "tool.result", requestId: "call-2", ok: true, result: { id: "document" } })
  });
  assert.deepEqual(await result, { id: "document" });
  client.disconnect();
});

test("consumer event handlers cannot disrupt a connected client", async () => {
  const { client, socket } = await connectedClient();
  client.on("state", () => {
    throw new Error("consumer failure");
  });
  socket.emit("close", { reason: "remote close" });
  assert.equal(client.state, "disconnected");
  client.disconnect();
});
