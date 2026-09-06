import assert from "node:assert/strict";
import test from "node:test";

import {
  createEngineMessage,
  encodeEngineMessage,
  EngineConnection,
  MemoryEngineTransport
} from "../dist/index.js";

/**
 * Deterministic test environment.
 *
 * Timers are queued and fired explicitly, so reconnect backoff and reply
 * timeouts are exercised without any real waiting.
 */
function createClock(startMs = 1_000) {
  let nowMs = startMs;
  let nextHandle = 1;
  const timers = new Map();

  return {
    now: () => nowMs,
    setTimer(handler, delayMs) {
      const handle = nextHandle++;
      timers.set(handle, { handler, dueAtMs: nowMs + delayMs });
      return handle;
    },
    clearTimer(handle) {
      timers.delete(handle);
    },
    /** Advance time and fire everything due. */
    advance(deltaMs) {
      nowMs += deltaMs;
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.dueAtMs <= nowMs)
        .sort((a, b) => a[1].dueAtMs - b[1].dueAtMs);
      for (const [handle, timer] of due) {
        timers.delete(handle);
        timer.handler();
      }
    },
    pendingTimers: () => timers.size,
    set(ms) {
      nowMs = ms;
    }
  };
}

/**
 * Minimal engine that answers whatever the client asks.
 *
 * Sequences its own messages, so the client's inbound ordering is exercised for
 * real rather than bypassed.
 */
function createFakeEngine(transport, options = {}) {
  const engineId = options.engineId ?? "engine_test";
  let sequence = 0;
  let messageId = 0;
  const received = [];

  const reply = (type, payload, requestId, overrides = {}) => {
    sequence += 1;
    messageId += 1;
    const message = createEngineMessage(type, payload, {
      messageId: `eng-${messageId}`,
      sequence,
      timestampMs: 1_000,
      direction: "engine-to-client",
      requestId,
      engineId,
      ...overrides
    });
    transport.deliver(encodeEngineMessage(message));
    return message;
  };

  return {
    received,
    reply,
    get sequence() {
      return sequence;
    },
    /** Answer every unanswered client request currently in the buffer. */
    drain() {
      for (const message of transport.sentMessages()) {
        if (received.includes(message.messageId)) continue;
        received.push(message.messageId);
        this.respondTo(message);
      }
    },
    respondTo(message) {
      switch (message.type) {
        case "connection.hello":
          reply(
            "reply.hello",
            {
              engineId,
              engineName: options.engineName ?? "Test Engine",
              softwareVersion: "0.2.0",
              protocolVersion: 3,
              state: "connecting",
              authenticationRequired: options.authenticationRequired ?? false,
              ...(options.connectionRole ? { connectionRole: options.connectionRole } : {})
            },
            message.requestId
          );
          return;
        case "connection.authenticate":
          reply("reply.ack", { requestType: "connection.authenticate" }, message.requestId);
          return;
        case "engine.getCapabilities":
          reply("reply.capabilities", options.capabilities ?? minimalCapabilities(engineId), message.requestId);
          return;
        default:
          reply("reply.ack", { requestType: message.type }, message.requestId);
      }
    },
    /** Re-send the previous message verbatim, as a flaky link would. */
    retransmitLast() {
      const frames = transport.sent;
      void frames;
      sequence += 1;
      // Reuse the previous messageId to simulate a genuine retransmit.
      const message = createEngineMessage(
        "event.warning",
        { code: "TEST", message: "duplicate" },
        {
          messageId: `eng-${messageId}`,
          sequence,
          timestampMs: 1_000,
          direction: "engine-to-client",
          requestId: null,
          engineId
        }
      );
      transport.deliver(encodeEngineMessage(message));
    }
  };
}

function minimalCapabilities(engineId = "engine_test") {
  return {
    engineId,
    engineName: "Test Engine",
    softwareVersion: "0.2.0",
    protocolVersion: 3,
    sceneDocumentVersions: [1],
    stageDocumentVersions: [1],
    os: { platform: "test", release: "0", arch: "x86_64" },
    cpu: { model: "Test", logicalCores: 8 },
    gpu: {
      adapter: "Test",
      backend: "vulkan",
      deviceType: "DiscreteGpu",
      driver: "test",
      vendorId: 0,
      deviceId: 0,
      memoryBytesEstimate: 0
    },
    limits: {
      maxTextureDimension2d: 16_384,
      maxTextureDimension3d: 2_048,
      maxTextureArrayLayers: 256,
      maxBufferSize: 2 ** 31,
      maxBindGroups: 8,
      maxLogicalCanvasWidth: 50_000,
      maxLogicalCanvasHeight: 50_000,
      maxTileSize: 4_096,
      maxActiveScenes: 8,
      maxWarmScenes: 3,
      maxPreviewPixels: 1920 * 1080,
      maxMessageBytes: 8 * 1024 * 1024,
      maxUploadBytes: 512 * 1024 * 1024,
      maxOutputs: 8,
      maxSurfaces: 64
    },
    supportedTextureFormats: ["rgba8unorm"],
    supportedVideoFormats: [],
    supportedShaderFeatures: ["wgsl"],
    outputAdapters: [],
    features: {
      tileRendering: true,
      headlessRendering: true,
      hardwareEncoding: false,
      nativeTextRender: true,
      packagedFontFiles: true,
      nativeVideoDecode: false,
      native3dRender: true,
      scenePatching: true,
      previewStreaming: true,
      sharedMemoryPreview: false,
      virtualCanvas: true,
      multiSurfaceMapping: true,
      surfaceWarpCompositing: false,
      edgeBlendCompositing: false,
      distributedRendering: false,
      deviceLossRecovery: true
    },
    supportedTransitions: ["cut"],
    supportedQualityProfiles: ["PROGRAM_HD"],
    renderedObjectTypes: ["rect", "text"],
    transports: ["websocket", "ipc"]
  };
}

function createClient(transport, clock, overrides = {}) {
  return new EngineConnection({
    clientId: "editor",
    clientName: "GrapiX Editor",
    clientRole: "editor",
    clientVersion: "0.2.0",
    transport,
    projectId: "project_1",
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    random: () => 0.5,
    autoReconnect: false,
    ...overrides
  });
}

/**
 * Drive a connect() to completion.
 *
 * The client awaits each reply in turn, so the engine has to be pumped between
 * microtask ticks rather than all at once.
 */
async function completeConnect(client, engine) {
  const promise = client.connect();
  for (let i = 0; i < 12; i += 1) {
    engine.drain();
    await Promise.resolve();
    await Promise.resolve();
  }
  return promise;
}

// ---------------------------------------------------------------------------

test("connect performs hello, capabilities, and lands in synchronising", async () => {
  const transport = new MemoryEngineTransport("ws://127.0.0.1:4300");
  const clock = createClock();
  const client = createClient(transport, clock);
  const engine = createFakeEngine(transport);

  const capabilities = await completeConnect(client, engine);

  assert.equal(capabilities.engineId, "engine_test");
  assert.equal(client.engineCapabilities.limits.maxLogicalCanvasWidth, 50_000);
  // Connected and capabilities known, but revisions not yet reconciled.
  assert.equal(client.state, "synchronising");
  assert.equal(client.isAuthenticated, true);

  const sent = transport.sentMessages();
  assert.deepEqual(
    sent.map((message) => message.type),
    ["connection.hello", "engine.getCapabilities"]
  );
  // Connection setup is unscoped; project scope stays in the handshake payload
  // until a canonical SceneRef accompanies a scene-bearing command.
  assert.equal(sent[0].payload.projectId, "project_1");
  assert.equal(sent[0].sceneRef, null);
  assert.equal(sent[0].sequence, 1);
  assert.equal(sent[1].sequence, 2);
});

test("an engine that requires authentication is authenticated before capabilities", async () => {
  const transport = new MemoryEngineTransport();
  const clock = createClock();
  const client = createClient(transport, clock, { authToken: "secret-token" });
  const engine = createFakeEngine(transport, { authenticationRequired: true });

  await completeConnect(client, engine);

  const types = transport.sentMessages().map((message) => message.type);
  assert.deepEqual(types, [
    "connection.hello",
    "connection.authenticate",
    "engine.getCapabilities"
  ]);

  const auth = transport.sentMessages()[1];
  assert.equal(auth.payload.token, "secret-token");
  // Authentication mutates engine state, so it is acknowledged.
  assert.equal(auth.requiresAck, true);
});

test("an operator client granted only editor authority fails loudly", async () => {
  // `authenticationRequired` is an engine-level fact, so it cannot decide this on its own.
  // What makes a connection unusable is being granted less authority than the work needs: a
  // client that intends to drive Program and is handed an Editor session would otherwise
  // discover it one refused Take at a time.
  const transport = new MemoryEngineTransport();
  const clock = createClock();
  const client = createClient(transport, clock, { clientRole: "playout" }); // no authToken
  const engine = createFakeEngine(transport, {
    authenticationRequired: true,
    connectionRole: "editor"
  });

  const promise = client.connect();
  for (let i = 0; i < 6; i += 1) {
    engine.drain();
    await Promise.resolve();
    await Promise.resolve();
  }

  await assert.rejects(promise, /cannot drive operator verbs/);
  assert.equal(client.state, "error");
  assert.throws(
    () => transport.send("still-open"),
    /transport is not open/,
    "a failed negotiation must release the engine connection slot"
  );
});

test("a local editor connects to a token-secured engine without a token", async () => {
  // The Editor holds no operator credential and does not need one. Refusing here is what made
  // a token-secured engine impossible to author into - the deployment every Playout install
  // creates.
  const transport = new MemoryEngineTransport();
  const clock = createClock();
  const client = createClient(transport, clock); // editor, no authToken
  const engine = createFakeEngine(transport, {
    authenticationRequired: true,
    connectionRole: "editor"
  });

  const promise = client.connect();
  for (let i = 0; i < 6; i += 1) {
    engine.drain();
    await Promise.resolve();
    await Promise.resolve();
  }

  await promise;
  assert.equal(client.state, "synchronising");
  assert.equal(
    engine.received.length > 0 &&
      transport.sentMessages().some((message) => message.type === "connection.authenticate"),
    false,
    "an Editor session must not send a credential it does not have"
  );
});

test("an error reply rejects the request rather than resolving it", async () => {
  const transport = new MemoryEngineTransport();
  const clock = createClock();
  const client = createClient(transport, clock);
  const engine = createFakeEngine(transport);
  await completeConnect(client, engine);

  const pending = client.request("playout.takeOnline", {
    sceneId: "scene_1",
    sceneRevision: 3
  });
  const request = transport.lastSent();

  engine.reply(
    "reply.error",
    {
      code: "SCENE_NOT_PREPARED",
      message: "scene_1 is still loading",
      retryable: true
    },
    request.requestId
  );

  await assert.rejects(pending, /SCENE_NOT_PREPARED: scene_1 is still loading/);
  assert.equal(client.stats().pendingRequests, 0);
});

test("an error demanding a full sync moves the client to synchronising", async () => {
  const transport = new MemoryEngineTransport();
  const clock = createClock();
  const client = createClient(transport, clock);
  const engine = createFakeEngine(transport);
  await completeConnect(client, engine);
  client.markReady();
  assert.equal(client.state, "ready");

  const pending = client.request("scene.applyPatch", {
    patch: {
      sceneId: "scene_1",
      baseRevision: 2,
      revision: 3,
      timestampMs: 0,
      operations: [{ type: "object.visibility", objectId: "obj_a", visible: false }]
    }
  });
  const request = transport.lastSent();

  engine.reply(
    "reply.error",
    {
      code: "REVISION_MISMATCH",
      message: "engine holds revision 5",
      retryable: false,
      requiresFullSync: true
    },
    request.requestId
  );

  await assert.rejects(pending, /REVISION_MISMATCH/);
  assert.equal(client.state, "synchronising");
});

test("duplicate inbound messages are counted and dropped", async () => {
  const transport = new MemoryEngineTransport();
  const clock = createClock();
  const client = createClient(transport, clock);
  const engine = createFakeEngine(transport);
  await completeConnect(client, engine);

  const events = [];
  client.on((event) => {
    if (event.type === "engine-event") events.push(event.eventType);
  });

  const warning = engine.reply("event.warning", { code: "T", message: "first" }, null);
  assert.equal(events.length, 1);

  // The same messageId arriving again is a retransmit.
  transport.deliver(
    encodeEngineMessage({ ...warning, sequence: warning.sequence + 1 })
  );

  assert.equal(events.length, 1, "duplicate should not be dispatched twice");
  assert.equal(client.stats().duplicatesDropped, 1);
});

test("out-of-order inbound messages are reordered before dispatch", async () => {
  const transport = new MemoryEngineTransport();
  const clock = createClock();
  const client = createClient(transport, clock);
  const engine = createFakeEngine(transport);
  await completeConnect(client, engine);

  const seen = [];
  client.on((event) => {
    if (event.type === "message" && event.message.type === "event.warning") {
      seen.push(event.message.payload.message);
    }
  });

  const base = engine.sequence;
  const make = (sequence, text, id) =>
    encodeEngineMessage(
      createEngineMessage(
        "event.warning",
        { code: "T", message: text },
        {
          messageId: id,
          sequence,
          timestampMs: 1_000,
          direction: "engine-to-client",
          requestId: null,
          engineId: "engine_test"
        }
      )
    );

  // Deliver third, then second, then first.
  transport.deliver(make(base + 3, "third", "x3"));
  transport.deliver(make(base + 2, "second", "x2"));
  assert.deepEqual(seen, [], "nothing should dispatch while the gap is open");

  transport.deliver(make(base + 1, "first", "x1"));
  assert.deepEqual(seen, ["first", "second", "third"]);
});

test("an inbound sequence gap triggers resynchronisation", async () => {
  const transport = new MemoryEngineTransport();
  const clock = createClock();
  const client = createClient(transport, clock);
  const engine = createFakeEngine(transport);
  await completeConnect(client, engine);
  client.markReady();

  const errors = [];
  client.on((event) => {
    if (event.type === "protocol-error") errors.push(event.code);
  });

  // Flood far-future sequences until the park limit is exceeded.
  const base = engine.sequence + 100;
  for (let i = 0; i < 40; i += 1) {
    transport.deliver(
      encodeEngineMessage(
        createEngineMessage(
          "event.warning",
          { code: "T", message: `future ${i}` },
          {
            messageId: `f-${i}`,
            sequence: base + i,
            timestampMs: 1_000,
            direction: "engine-to-client",
            requestId: null,
            engineId: "engine_test"
          }
        )
      )
    );
  }

  assert.ok(errors.includes("SEQUENCE_GAP"));
  assert.equal(client.state, "synchronising");
  assert.ok(client.stats().sequenceGaps > 0);
});

test("a resync-required event is surfaced with the engine's revisions", async () => {
  const transport = new MemoryEngineTransport();
  const clock = createClock();
  const client = createClient(transport, clock);
  const engine = createFakeEngine(transport);
  await completeConnect(client, engine);
  client.markReady();

  let resync;
  client.on((event) => {
    if (event.type === "resync-required") resync = event.payload;
  });

  engine.reply(
    "event.resyncRequired",
    {
      sceneIds: ["scene_1", "scene_2"],
      reason: "device-lost",
      engineRevisions: { scene_1: 7, scene_2: 2 }
    },
    null
  );

  assert.deepEqual(resync.sceneIds, ["scene_1", "scene_2"]);
  assert.equal(resync.engineRevisions.scene_1, 7);
  assert.equal(client.state, "synchronising");
});

test("a device-loss event moves the client to recovering", async () => {
  const transport = new MemoryEngineTransport();
  const clock = createClock();
  const client = createClient(transport, clock);
  const engine = createFakeEngine(transport);
  await completeConnect(client, engine);
  client.markReady();
  client.markOnAir();
  assert.equal(client.state, "on-air");

  engine.reply(
    "event.deviceLost",
    { reason: "GPU reset", recovering: true, affectedSceneIds: ["scene_1"] },
    null
  );

  assert.equal(client.state, "recovering");
});

test("the engine is authoritative about its own state", async () => {
  const transport = new MemoryEngineTransport();
  const clock = createClock();
  const client = createClient(transport, clock);
  const engine = createFakeEngine(transport);
  await completeConnect(client, engine);

  engine.reply(
    "event.engineState",
    { state: "on-air", previousState: "ready", reason: "program take from another client" },
    null
  );

  // Forced rather than guarded: synchronising -> on-air is not in the table, but
  // the engine is telling us what is true.
  assert.equal(client.state, "on-air");
});

test("a reply that never arrives times out instead of hanging", async () => {
  const transport = new MemoryEngineTransport();
  const clock = createClock();
  const client = createClient(transport, clock);
  const engine = createFakeEngine(transport);
  await completeConnect(client, engine);

  const pending = client.request("engine.getStatus", {}, { timeoutMs: 5_000 });
  clock.advance(5_001);

  await assert.rejects(pending, /did not reply to engine.getStatus within 5000ms/);
});

test("a retransmit reuses the messageId so the engine can dedupe it", async () => {
  const transport = new MemoryEngineTransport();
  const clock = createClock();
  const client = createClient(transport, clock);
  const engine = createFakeEngine(transport);
  await completeConnect(client, engine);

  const payload = { sceneId: "scene_1", channel: "preview" };
  const sent = client.send("playout.stop", payload);
  const before = transport.sentMessages().length;

  assert.equal(client.retryPending(sent.requestId, payload, "playout.stop"), true);

  const messages = transport.sentMessages();
  assert.equal(messages.length, before + 1);

  const retry = messages[messages.length - 1];
  // Same messageId and requestId, new sequence.
  assert.equal(retry.messageId, sent.messageId);
  assert.equal(retry.requestId, sent.requestId);
  assert.ok(retry.sequence > sent.sequence);
});

test("acknowledged commands stop being pending once acked", async () => {
  const transport = new MemoryEngineTransport();
  const clock = createClock();
  const client = createClient(transport, clock);
  const engine = createFakeEngine(transport);
  await completeConnect(client, engine);

  const sent = client.send("playout.clear", { channel: "program" });
  assert.equal(client.stats().pendingRequests, 1);

  engine.reply("reply.ack", { requestType: "playout.clear" }, sent.requestId);
  assert.equal(client.stats().pendingRequests, 0);

  // A retry after the ack has nothing to resend.
  assert.equal(client.retryPending(sent.requestId, {}, "playout.clear"), false);
});

test("every reply type settles its request, including ones added later", async () => {
  // Regression: the dispatcher matched reply types against an enumerated switch, and
  // `reply.outputs` was missing from it. The engine answered `output.list` instantly
  // and the caller still waited the full reply timeout before failing. Matching by
  // prefix means a reply type added on the engine side cannot strand a caller.
  const transport = new MemoryEngineTransport();
  const clock = createClock();
  const client = createClient(transport, clock);
  const engine = createFakeEngine(transport);
  await completeConnect(client, engine);

  const pending = client.request("output.list", {});
  const sent = transport.sentMessages().at(-1);
  engine.reply("reply.outputs", { outputs: [], availableAdapters: [] }, sent.requestId);

  const reply = await pending;
  assert.equal(reply.type, "reply.outputs");
  assert.deepEqual(reply.payload.outputs, []);

  // A type outside the contract cannot reach the dispatcher at all — the envelope
  // refuses to encode or decode one — so the prefix match only ever sees declared
  // reply types.
  assert.throws(
    () => createEngineMessage("reply.somethingNew", {}, { direction: "engine-to-client" }),
    /unknown engine message type/
  );
});

test("heartbeats are sent on the configured interval and measure latency", async () => {
  const transport = new MemoryEngineTransport();
  const clock = createClock();
  const client = createClient(transport, clock, {
    heartbeat: { intervalMs: 1_000, timeoutMs: 10_000 }
  });
  const engine = createFakeEngine(transport);
  await completeConnect(client, engine);

  const before = transport.sentMessages().length;

  clock.set(clock.now() + 1_500);
  client.tick();

  const messages = transport.sentMessages();
  assert.equal(messages.length, before + 1);
  const heartbeat = messages[messages.length - 1];
  assert.equal(heartbeat.type, "connection.heartbeat");
  // Heartbeats are not separately acked; the reply is the acknowledgement.
  assert.equal(heartbeat.requiresAck, false);
});

test("a heartbeat on a dead socket never throws", async () => {
  // Regression: `tick` runs from a setInterval in the process that owns Program.
  // When the socket had closed, `send` threw, the exception escaped the interval
  // callback, and the whole playout-control process died — taking Program with it.
  const transport = new MemoryEngineTransport();
  const clock = createClock();
  const client = createClient(transport, clock, {
    heartbeat: { intervalMs: 1_000, timeoutMs: 60_000 },
    autoReconnect: false
  });
  const engine = createFakeEngine(transport);
  await completeConnect(client, engine);

  const states = [];
  client.on((event) => {
    if (event.type === "state") states.push(event.state);
  });

  // The socket goes away without a close event, so the client still believes it is
  // connected — exactly the race the crash came from.
  transport.simulateSocketLoss();

  clock.set(clock.now() + 2_000);
  assert.doesNotThrow(() => client.tick(), "a heartbeat must never throw");

  // And the failure is reported as a state change rather than swallowed.
  assert.ok(states.includes("error"), `expected an error state, saw ${states.join(", ")}`);
});

test("an answered heartbeat keeps the connection alive indefinitely", async () => {
  // Regression: nothing ever recorded that a reply had arrived, so `lastReceivedMs`
  // stayed at construction time and every connection died `timeoutMs` after it opened
  // — then reconnected, then died again. Playout looked like it had an unstable
  // engine; the engine was answering every heartbeat.
  const transport = new MemoryEngineTransport();
  const clock = createClock();
  const client = createClient(transport, clock, {
    heartbeat: { intervalMs: 1_000, timeoutMs: 3_000 }
  });
  const engine = createFakeEngine(transport);
  await completeConnect(client, engine);
  client.markReady();

  // Well past the timeout, but the engine answers each heartbeat.
  for (let round = 0; round < 12; round += 1) {
    clock.set(clock.now() + 1_100);
    client.tick();
    engine.drain();
    assert.equal(
      client.state,
      "ready",
      `dropped to ${client.state} after ${round + 1} answered heartbeat(s)`
    );
  }
});

test("a heartbeat reply is what measures latency", async () => {
  const transport = new MemoryEngineTransport();
  const clock = createClock();
  const client = createClient(transport, clock, {
    heartbeat: { intervalMs: 1_000, timeoutMs: 10_000 }
  });
  const engine = createFakeEngine(transport);
  await completeConnect(client, engine);

  const latencies = [];
  client.on((event) => {
    if (event.type === "latency") latencies.push(event.latencyMs);
  });

  clock.set(clock.now() + 1_100);
  client.tick();
  // The engine echoes the clock the client sent, and 40ms pass in between.
  const heartbeat = transport.sentMessages().at(-1);
  clock.set(clock.now() + 40);
  engine.reply(
    "reply.ack",
    { requestType: "connection.heartbeat", sentAtMs: heartbeat.payload.sentAtMs },
    heartbeat.requestId
  );

  assert.deepEqual(latencies, [40]);
  assert.equal(client.stats().lastLatencyMs, 40);
});

test("any inbound message counts as liveness, not only a heartbeat", async () => {
  // An engine that is streaming previews is obviously alive. Requiring a heartbeat
  // specifically would drop a busy connection.
  const transport = new MemoryEngineTransport();
  const clock = createClock();
  const client = createClient(transport, clock, {
    heartbeat: { intervalMs: 10_000, timeoutMs: 3_000 }
  });
  const engine = createFakeEngine(transport);
  await completeConnect(client, engine);
  client.markReady();

  for (let round = 0; round < 6; round += 1) {
    clock.set(clock.now() + 2_000);
    // No heartbeat is due, but the engine sends an unsolicited event.
    engine.reply("event.warning", { message: "still here" }, null);
    client.tick();
    assert.equal(client.state, "ready", `dropped to ${client.state} on round ${round + 1}`);
  }
});

test("heartbeat silence past the timeout moves the client to error", async () => {
  const transport = new MemoryEngineTransport();
  const clock = createClock();
  const client = createClient(transport, clock, {
    heartbeat: { intervalMs: 1_000, timeoutMs: 3_000 }
  });
  const engine = createFakeEngine(transport);
  await completeConnect(client, engine);
  client.markReady();

  clock.set(clock.now() + 10_000);
  client.tick();

  assert.equal(client.state, "error");
});

test("an unexpected close schedules a reconnect with backoff", async () => {
  const transport = new MemoryEngineTransport();
  const clock = createClock();
  const client = createClient(transport, clock, {
    autoReconnect: true,
    reconnectPolicy: { maxAttempts: 5, baseDelayMs: 1_000, maxDelayMs: 8_000, jitterRatio: 0 }
  });
  const engine = createFakeEngine(transport);
  await completeConnect(client, engine);
  client.markReady();

  const closed = [];
  client.on((event) => {
    if (event.type === "closed") closed.push(event.reason);
  });

  transport.drop("connection reset");

  assert.deepEqual(closed, ["connection reset"]);
  assert.equal(client.state, "recovering");
  assert.equal(clock.pendingTimers(), 1);
  assert.equal(client.stats().reconnectAttempts, 1);
});

test("a deliberate disconnect does not reconnect", async () => {
  const transport = new MemoryEngineTransport();
  const clock = createClock();
  const client = createClient(transport, clock, { autoReconnect: true });
  const engine = createFakeEngine(transport);
  await completeConnect(client, engine);

  client.disconnect("operator closed the editor");

  assert.equal(client.state, "offline");
  assert.equal(client.isAuthenticated, false);
  assert.equal(clock.pendingTimers(), 0);

  const types = transport.sentMessages().map((message) => message.type);
  assert.ok(types.includes("connection.disconnect"));
});

test("in-flight requests reject when the connection closes", async () => {
  const transport = new MemoryEngineTransport();
  const clock = createClock();
  const client = createClient(transport, clock);
  const engine = createFakeEngine(transport);
  await completeConnect(client, engine);

  const pending = client.request("engine.getStatus", {});
  transport.drop("engine crashed");

  await assert.rejects(pending, /connection closed: engine crashed/);
});

test("a malformed inbound frame is reported and does not throw", async () => {
  const transport = new MemoryEngineTransport();
  const clock = createClock();
  const client = createClient(transport, clock);
  const engine = createFakeEngine(transport);
  await completeConnect(client, engine);

  const errors = [];
  client.on((event) => {
    if (event.type === "protocol-error") errors.push(event.code);
  });

  transport.deliver("{not json");
  transport.deliver(JSON.stringify({ protocolVersion: 1, messageId: "x" }));

  assert.deepEqual(errors, ["INVALID_JSON", "PROTOCOL_VERSION_MISMATCH"]);
  // Still usable.
  assert.equal(client.state, "synchronising");
});

test("an oversized inbound frame is refused at the configured limit", () => {
  // No handshake here on purpose: a 256-byte limit would also reject the
  // capabilities reply, and the size check runs before any protocol state.
  const transport = new MemoryEngineTransport();
  const clock = createClock();
  const client = createClient(transport, clock, { maxMessageBytes: 256 });

  const errors = [];
  client.on((event) => {
    if (event.type === "protocol-error") errors.push(event.code);
  });

  transport.deliver(JSON.stringify({ padding: "x".repeat(1_000) }));
  assert.deepEqual(errors, ["MESSAGE_TOO_LARGE"]);
  // Nothing was counted as received, because it was never decoded.
  assert.equal(client.stats().messagesReceived, 0);
});

test("a listener that throws does not break the connection", async () => {
  const transport = new MemoryEngineTransport();
  const clock = createClock();
  const client = createClient(transport, clock);
  const engine = createFakeEngine(transport);
  await completeConnect(client, engine);

  client.on(() => {
    throw new Error("badly behaved panel");
  });

  const seen = [];
  client.on((event) => seen.push(event.type));

  engine.reply("event.warning", { code: "T", message: "still delivered" }, null);
  assert.ok(seen.includes("message"));
});

test("playout only ever sends commands, never renderer state", async () => {
  const transport = new MemoryEngineTransport();
  const clock = createClock();
  const client = createClient(transport, clock, {
    clientId: "playout",
    clientRole: "playout"
  });
  const engine = createFakeEngine(transport);
  await completeConnect(client, engine);
  client.markReady();

  client.send("playout.cue", { sceneId: "s1", sceneRevision: 1, channel: "preview" });
  client.send("playout.takeOnline", { sceneId: "s1", sceneRevision: 1 });
  client.send("playout.continue", { sceneId: "s1", channel: "program" });
  client.send("playout.transition", {
    sceneId: "s1",
    channel: "program",
    transitionId: "t_out",
    direction: "out",
    durationFrames: 25
  });
  client.send("playout.clear", { channel: "program" });

  const playoutMessages = transport
    .sentMessages()
    .filter((message) => message.type.startsWith("playout."));

  assert.deepEqual(
    playoutMessages.map((message) => message.type),
    [
      "playout.cue",
      "playout.takeOnline",
      "playout.continue",
      "playout.transition",
      "playout.clear"
    ]
  );
  // Every operational command is acknowledged, and the transition is expressed in
  // frames rather than milliseconds.
  assert.ok(playoutMessages.every((message) => message.requiresAck));
  assert.equal(playoutMessages[3].payload.durationFrames, 25);
});

test("taking an unprepared scene online requires an explicit override flag", async () => {
  const transport = new MemoryEngineTransport();
  const clock = createClock();
  const client = createClient(transport, clock);
  const engine = createFakeEngine(transport);
  await completeConnect(client, engine);

  client.send("playout.takeOnline", { sceneId: "s1", sceneRevision: 1 });
  assert.equal(transport.lastSent().payload.overrideUnprepared, undefined);

  client.send("playout.takeOnline", {
    sceneId: "s1",
    sceneRevision: 1,
    overrideUnprepared: true
  });
  assert.equal(transport.lastSent().payload.overrideUnprepared, true);
});

test("a frame past the engine's advertised message limit is refused before it is sent", async () => {
  const transport = new MemoryEngineTransport();
  const clock = createClock();
  const client = createClient(transport, clock);
  const engine = createFakeEngine(transport);

  const capabilities = await completeConnect(client, engine);
  const limit = capabilities.limits.maxMessageBytes;
  assert.ok(limit > 0, "the engine advertises a message limit");

  const before = transport.sentMessages().length;

  // A scene carrying inline asset bytes: the shape that reached an operator as a dead connection.
  const scene = {
    id: "scene_big",
    revision: 1,
    assets: [{ assetId: "asset_1", source: `data:image/png;base64,${"A".repeat(limit)}` }]
  };

  assert.throws(
    () => client.send("scene.load", { scene, prepare: false }),
    (error) => {
      // The two numbers that explain it, and where the bytes should have gone.
      assert.match(error.message, /scene\.load is \d+ bytes/);
      assert.ok(error.message.includes(String(limit)), `limit missing from: ${error.message}`);
      assert.match(error.message, /asset\.upload/);
      return true;
    }
  );

  assert.equal(
    transport.sentMessages().length,
    before,
    "and nothing went to the engine, so the connection is still usable"
  );

  // Proof it is not simply refusing everything: a small frame still goes.
  client.send("scene.unload", { sceneId: "scene_big" });
  assert.equal(transport.sentMessages().length, before + 1);
});

test("a frame within the limit is sent even when it is close to it", async () => {
  const transport = new MemoryEngineTransport();
  const clock = createClock();
  const client = createClient(transport, clock);
  const engine = createFakeEngine(transport);

  const capabilities = await completeConnect(client, engine);
  const before = transport.sentMessages().length;

  // Half the limit of payload: comfortably under once the envelope is added.
  client.send("scene.load", {
    scene: { id: "scene_ok", revision: 1, assets: [{ assetId: "a", source: "x".repeat(Math.floor(capabilities.limits.maxMessageBytes / 2)) }] },
    prepare: false
  });

  assert.equal(transport.sentMessages().length, before + 1);
});

test("a refused frame leaves no gap in the outbound sequence", async () => {
  const transport = new MemoryEngineTransport();
  const clock = createClock();
  const client = createClient(transport, clock);
  const engine = createFakeEngine(transport);

  const capabilities = await completeConnect(client, engine);
  const lastSequence = transport.sentMessages().at(-1).sequence;

  assert.throws(() => client.send("scene.load", {
    scene: {
      id: "scene_big",
      revision: 1,
      assets: [{ assetId: "a", source: `data:image/png;base64,${"A".repeat(capabilities.limits.maxMessageBytes)}` }]
    },
    prepare: false
  }));

  // The receiver parks a message that arrives with a gap ahead of it, waiting for one that will
  // never come — so the next real frame has to be the very next number, or it is never answered.
  client.send("scene.unload", { sceneId: "scene_big" });
  assert.equal(transport.sentMessages().at(-1).sequence, lastSequence + 1);
});
