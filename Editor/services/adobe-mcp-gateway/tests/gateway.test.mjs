import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";

import { AdobeGateway } from "../dist/gateway.js";
import { AdobeClient } from "@grapix/adobe-client";

const TOKEN = "test-token-abcdef";

async function startGateway() {
  const gateway = new AdobeGateway({ port: 0, host: "127.0.0.1", token: TOKEN, allowPublic: false });
  const port = await gateway.listen();
  return { gateway, port, url: `ws://127.0.0.1:${port}` };
}

/**
 * A stand-in for the UXP plugin or the ExtendScript bridge: it says hello as a bridge
 * and answers tool calls from a handler table.
 */
function connectBridge(url, app, handlers, options = {}) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.on("open", () => {
      socket.send(
        JSON.stringify({
          type: "hello",
          role: "bridge",
          token: options.token ?? TOKEN,
          app,
          appVersion: options.appVersion ?? "26.0.0",
          bridgeVersion: "0.1.0"
        })
      );
    });
    socket.on("message", async (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === "hello.ack") {
        resolve({ socket, peerId: message.peerId });
        return;
      }
      if (message.type !== "tool.call") return;

      const handler = handlers[message.tool];
      if (!handler) {
        socket.send(
          JSON.stringify({
            type: "tool.error",
            requestId: message.requestId,
            ok: false,
            code: "not_implemented",
            message: `${message.tool} is not implemented by this bridge`
          })
        );
        return;
      }
      try {
        const result = await handler(message.arguments ?? {}, (progress, text) => {
          socket.send(
            JSON.stringify({ type: "tool.progress", requestId: message.requestId, progress, message: text })
          );
        });
        socket.send(JSON.stringify({ type: "tool.result", requestId: message.requestId, ok: true, result }));
      } catch (error) {
        socket.send(
          JSON.stringify({
            type: "tool.error",
            requestId: message.requestId,
            ok: false,
            code: "bridge_threw",
            message: error.message
          })
        );
      }
    });
    socket.on("close", (code, reason) => reject(new Error(`bridge closed ${code}: ${reason}`)));
    socket.on("error", reject);
  });
}

function makeClient(url, overrides = {}) {
  return new AdobeClient({
    url,
    token: TOKEN,
    autoReconnect: false,
    callTimeoutMs: 5_000,
    webSocketImpl: WebSocket,
    ...overrides
  });
}

test("a client with a bad token is refused rather than silently idle", async () => {
  const { gateway, url } = await startGateway();
  try {
    const client = makeClient(url, { token: "wrong-token" });
    await assert.rejects(() => client.connect());
    assert.equal(client.state, "error");
  } finally {
    await gateway.close();
  }
});

test("a non-object WebSocket frame is rejected without crashing the gateway", async () => {
  const { gateway, url } = await startGateway();
  try {
    const socket = new WebSocket(url);
    const close = new Promise((resolve) => {
      socket.once("close", (code) => resolve(code));
    });
    await new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    socket.send("null");
    assert.equal(await close, 4002);
  } finally {
    await gateway.close();
  }
});

test("discovery reports an application as installed only once its bridge connects", async () => {
  const { gateway, url } = await startGateway();
  const client = makeClient(url);
  try {
    await client.connect();

    const before = await client.discover();
    assert.equal(before.applications.photoshop.connected, false);
    assert.equal(before.applications["after-effects"].connected, false);

    const bridge = await connectBridge(url, "photoshop", {}, { appVersion: "26.3.0" });

    const after = await client.discover();
    assert.equal(after.applications.photoshop.connected, true);
    assert.equal(after.applications.photoshop.version, "26.3.0");
    assert.equal(after.applications["after-effects"].connected, false);

    bridge.socket.removeAllListeners("close");
    bridge.socket.close();
  } finally {
    client.disconnect();
    await gateway.close();
  }
});

test("a read tool round-trips through the gateway to the bridge and back", async () => {
  const { gateway, url } = await startGateway();
  const client = makeClient(url);
  try {
    await client.connect();
    const bridge = await connectBridge(url, "photoshop", {
      "photoshop.getActiveDocument": () => ({
        documentId: "psd-7",
        name: "LowerThird.psd",
        width: 1920,
        height: 1080
      })
    });

    const document = await client.call("photoshop.getActiveDocument");
    assert.equal(document.name, "LowerThird.psd");
    assert.equal(document.width, 1920);

    bridge.socket.removeAllListeners("close");
    bridge.socket.close();
  } finally {
    client.disconnect();
    await gateway.close();
  }
});

test("progress reaches the caller without settling the call", async () => {
  const { gateway, url } = await startGateway();
  const client = makeClient(url);
  try {
    await client.connect();
    const bridge = await connectBridge(url, "photoshop", {
      "photoshop.exportLayers": async (_args, report) => {
        report(0.25, "exporting 1 of 4");
        report(0.5, "exporting 2 of 4");
        report(1, "done");
        return { exported: 4 };
      }
    });

    const seen = [];
    const result = await client.call(
      "photoshop.exportLayers",
      { layerIds: ["a", "b", "c", "d"] },
      { onProgress: (progress, message) => seen.push([progress, message]) }
    );

    assert.equal(result.exported, 4);
    assert.deepEqual(
      seen.map(([progress]) => progress),
      [0.25, 0.5, 1]
    );

    bridge.socket.removeAllListeners("close");
    bridge.socket.close();
  } finally {
    client.disconnect();
    await gateway.close();
  }
});

test("a mutating tool is refused until the operator approves the session", async () => {
  const { gateway, url } = await startGateway();
  const client = makeClient(url);
  try {
    await client.connect();
    let created = 0;
    const bridge = await connectBridge(url, "photoshop", {
      "photoshop.createLayer": () => {
        created += 1;
        return { layerId: "layer-1" };
      }
    });

    await assert.rejects(
      () => client.call("photoshop.createLayer", { name: "Headline" }),
      (error) => error.code === "approval_required"
    );
    assert.equal(created, 0, "an unapproved call must never reach the bridge");

    assert.equal(gateway.approveSession(client.peerId), true);
    const layer = await client.call("photoshop.createLayer", { name: "Headline" });
    assert.equal(layer.layerId, "layer-1");
    assert.equal(created, 1);

    bridge.socket.removeAllListeners("close");
    bridge.socket.close();
  } finally {
    client.disconnect();
    await gateway.close();
  }
});

test("calling a tool whose application is not connected names the missing bridge", async () => {
  const { gateway, url } = await startGateway();
  const client = makeClient(url);
  try {
    await client.connect();
    await assert.rejects(
      () => client.call("aftereffects.getProject"),
      (error) => error.code === "bridge_unavailable"
    );
  } finally {
    client.disconnect();
    await gateway.close();
  }
});

test("a bridge that dies mid-call fails the caller instead of hanging it", async () => {
  const { gateway, url } = await startGateway();
  const client = makeClient(url);
  try {
    await client.connect();
    const bridge = await connectBridge(url, "after-effects", {
      "aftereffects.renderPreview": () => new Promise(() => {})
    });

    const pending = client.call("aftereffects.renderPreview", { frame: 0 });
    // Let the call reach the bridge before killing it.
    await new Promise((resolve) => setTimeout(resolve, 50));
    bridge.socket.removeAllListeners("close");
    bridge.socket.terminate();

    await assert.rejects(pending, (error) => error.code === "bridge_disconnected");
  } finally {
    client.disconnect();
    await gateway.close();
  }
});

test("two clients calling the same tool get their own answers", async () => {
  const { gateway, url } = await startGateway();
  const first = makeClient(url);
  const second = makeClient(url);
  try {
    await first.connect();
    await second.connect();
    const bridge = await connectBridge(url, "photoshop", {
      "photoshop.getDocumentStructure": (args) => ({ echo: args.caller })
    });

    const [a, b] = await Promise.all([
      first.call("photoshop.getDocumentStructure", { caller: "first" }),
      second.call("photoshop.getDocumentStructure", { caller: "second" })
    ]);

    assert.equal(a.echo, "first");
    assert.equal(b.echo, "second");

    bridge.socket.removeAllListeners("close");
    bridge.socket.close();
  } finally {
    first.disconnect();
    second.disconnect();
    await gateway.close();
  }
});

test("the log ring records connections and stays bounded", async () => {
  const { gateway, url } = await startGateway();
  try {
    const bridge = await connectBridge(url, "photoshop", {});
    const entries = gateway.logs.recent();
    assert.ok(entries.some((entry) => entry.source === "photoshop" && entry.message.includes("bridge connected")));

    for (let i = 0; i < 1200; i += 1) gateway.logs.push("debug", "test", `entry ${i}`);
    assert.equal(gateway.logs.size, 500);

    bridge.socket.removeAllListeners("close");
    bridge.socket.close();
  } finally {
    await gateway.close();
  }
});

test("the operator can approve and then withdraw document mutation for a session", async () => {
  const { gateway, url } = await startGateway();
  const client = makeClient(url);
  try {
    await client.connect();
    const bridge = await connectBridge(url, "photoshop", {
      "photoshop.createLayer": () => ({ layerId: "layer-9" })
    });

    assert.equal(await client.setApproval(true), true);
    const layer = await client.call("photoshop.createLayer", { name: "Strap" });
    assert.equal(layer.layerId, "layer-9");

    assert.equal(await client.setApproval(false), false);
    await assert.rejects(
      () => client.call("photoshop.createLayer", { name: "Strap 2" }),
      (error) => error.code === "approval_required"
    );

    bridge.socket.removeAllListeners("close");
    bridge.socket.close();
  } finally {
    client.disconnect();
    await gateway.close();
  }
});

test("restarting a bridge drops its socket, and says so when there is none", async () => {
  const { gateway, url } = await startGateway();
  const client = makeClient(url);
  try {
    await client.connect();

    assert.equal(await client.restartBridge("photoshop"), false, "no bridge means nothing was dropped");

    const bridge = await connectBridge(url, "photoshop", {});
    const closed = new Promise((resolve) => {
      bridge.socket.removeAllListeners("close");
      bridge.socket.once("close", (code) => resolve(code));
    });

    assert.equal(await client.restartBridge("photoshop"), true);
    assert.equal(await closed, 4100);

    const after = await client.discover();
    assert.equal(after.applications.photoshop.connected, false);
  } finally {
    client.disconnect();
    await gateway.close();
  }
});

test("the panel can read the gateway log over the same authenticated socket", async () => {
  const { gateway, url } = await startGateway();
  const client = makeClient(url);
  try {
    await client.connect();
    const bridge = await connectBridge(url, "after-effects", {}, { appVersion: "25.1" });

    const entries = await client.readLogs(50);
    assert.ok(entries.length > 0);
    assert.ok(entries.some((entry) => entry.source === "after-effects" && entry.message.includes("25.1")));
    assert.ok(entries.every((entry) => typeof entry.timestamp === "number"));

    bridge.socket.removeAllListeners("close");
    bridge.socket.close();
  } finally {
    client.disconnect();
    await gateway.close();
  }
});

test("a second bridge for one application replaces the first rather than racing it", async () => {
  const { gateway, url } = await startGateway();
  const client = makeClient(url);
  try {
    await client.connect();
    const first = await connectBridge(url, "photoshop", {}, { appVersion: "26.0.0" });
    first.socket.removeAllListeners("close");

    const second = await connectBridge(url, "photoshop", {}, { appVersion: "26.9.9" });
    const status = await client.discover();
    assert.equal(status.applications.photoshop.version, "26.9.9");
    assert.equal(gateway.clientCount, 1);

    second.socket.removeAllListeners("close");
    second.socket.close();
    first.socket.close();
  } finally {
    client.disconnect();
    await gateway.close();
  }
});
