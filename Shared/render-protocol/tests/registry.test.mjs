import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_LOCAL_ENGINE_PORTS,
  EngineRegistry,
  engineUrl,
  isWebSocketAvailable,
  localEngineCandidates,
  normalizeEngineProfile,
  WebSocketEngineTransport
} from "../dist/index.js";

function capabilities(overrides = {}) {
  const limits = {
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
    maxSurfaces: 64,
    ...overrides.limits
  };

  return {
    engineId: overrides.engineId ?? "engine_a",
    engineName: overrides.engineName ?? "Studio A",
    softwareVersion: "0.2.0",
    protocolVersion: 3,
    sceneDocumentVersions: [1],
    stageDocumentVersions: [1],
    os: { platform: "windows", release: "10", arch: "x86_64" },
    cpu: { model: "Test", logicalCores: 16 },
    gpu: {
      adapter: "Test GPU",
      backend: "vulkan",
      deviceType: "DiscreteGpu",
      driver: "test",
      vendorId: 0,
      deviceId: 0,
      memoryBytesEstimate: 8 * 1024 ** 3
    },
    limits,
    supportedTextureFormats: ["rgba8unorm"],
    supportedVideoFormats: [],
    supportedShaderFeatures: ["wgsl"],
    outputAdapters: [
      {
        adapterId: "null",
        name: "Null",
        available: true,
        supportsAlpha: true,
        supportsInterlaced: false,
        fixedResolutions: [],
        colorFormats: ["bgra8"]
      }
    ],
    features: {
      tileRendering: overrides.tileRendering ?? true,
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
    supportedQualityProfiles: ["PROGRAM_UHD"],
    renderedObjectTypes: ["rect", "text"],
    transports: ["websocket", "ipc"]
  };
}

const hugeStage = {
  logicalWidth: 50_000,
  logicalHeight: 10_000,
  tilingEnabled: true,
  tileWidth: 2_048,
  tileHeight: 2_048,
  overscan: 32,
  surfaceCount: 4,
  outputCount: 4,
  requiredOutputAdapters: ["null"],
  tileCacheBudgetBytes: 512 * 1024 * 1024
};

function profile(profileId, overrides = {}) {
  return normalizeEngineProfile({
    profileId,
    host: overrides.host ?? "127.0.0.1",
    port: overrides.port ?? 4300,
    ...overrides
  });
}

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

test("engine URLs default to wss for anything not loopback", () => {
  // An unencrypted renderer connection across a venue network carries a bearer
  // token in the clear, so the secure default is not optional.
  assert.equal(engineUrl("127.0.0.1", 4300), "ws://127.0.0.1:4300");
  assert.equal(engineUrl("localhost", 4300), "ws://localhost:4300");
  assert.equal(engineUrl("::1", 4300), "ws://[::1]:4300");
  assert.equal(engineUrl("10.0.0.5", 4300), "wss://10.0.0.5:4300");
  assert.equal(engineUrl("engine.example.com", 4300), "wss://engine.example.com:4300");

  // An operator may force plaintext on a trusted LAN.
  assert.equal(engineUrl("10.0.0.5", 4300, { secure: false }), "ws://10.0.0.5:4300");
});

test("IPv6 hosts are bracketed", () => {
  assert.equal(engineUrl("fe80::1", 4300), "wss://[fe80::1]:4300");
  // Already bracketed stays as-is.
  assert.equal(engineUrl("[fe80::1]", 4300), "wss://[fe80::1]:4300");
});

// ---------------------------------------------------------------------------
// Profiles and discovery
// ---------------------------------------------------------------------------

test("profiles normalise with a usable default label", () => {
  const bare = normalizeEngineProfile({ profileId: "p1", host: "10.0.0.5", port: 4300 });
  assert.equal(bare.label, "10.0.0.5:4300");
  assert.equal(bare.enabled, true);
  assert.equal(bare.preferred, false);
  assert.equal(bare.role, "unassigned");

  const named = normalizeEngineProfile({
    profileId: "p2",
    host: "10.0.0.6",
    port: 4301,
    label: "  GPU node  ",
    role: "primary",
    preferred: true
  });
  assert.equal(named.label, "GPU node");
  assert.equal(named.role, "primary");
  assert.equal(named.preferred, true);

  // An unknown role falls back rather than propagating.
  assert.equal(
    normalizeEngineProfile({ profileId: "p3", host: "h", port: 1, role: "captain" }).role,
    "unassigned"
  );
});

test("local discovery only ever considers loopback", () => {
  const candidates = localEngineCandidates();

  assert.equal(candidates.length, DEFAULT_LOCAL_ENGINE_PORTS.length);
  // Scanning a subnet from a graphics application would be a port scan.
  assert.ok(candidates.every((candidate) => candidate.host === "127.0.0.1"));
  assert.ok(candidates.every((candidate) => candidate.secure === false));
  assert.equal(candidates[0].port, DEFAULT_LOCAL_ENGINE_PORTS[0]);
  assert.equal(candidates[0].preferred, true);
});

test("the engine port range does not collide with the other GrapiX services", () => {
  // 4100 project-api, 4300 playout-control, 5173/5174 web. A default that collided would
  // make a local all-services run fail to start.
  //
  // 4200 stays in this set although nothing listens there any more: it belonged to the
  // protocol v2 daemon, whose binary was deleted on 2026-07-29. Keeping it reserved means an
  // engine default can never land on the port a second renderer used to own.
  const taken = new Set([4100, 4200, 4300, 5173, 5174]);
  for (const port of DEFAULT_LOCAL_ENGINE_PORTS) {
    assert.ok(!taken.has(port), `engine port ${port} collides with an existing service`);
  }
  assert.equal(DEFAULT_LOCAL_ENGINE_PORTS[0], 4400);
});

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

test("registering an engine yields an offline record with a resolved URL", () => {
  const registry = new EngineRegistry();
  const record = registry.register(profile("local", { port: 4300 }), "manual", 1_000);

  assert.equal(record.state, "offline");
  assert.equal(record.url, "ws://127.0.0.1:4300");
  assert.equal(record.engineId, null);
  assert.equal(record.capabilities, null);
  assert.equal(record.authenticated, false);
  assert.equal(registry.all().length, 1);
});

test("re-registering preserves observed runtime state", () => {
  const registry = new EngineRegistry();
  registry.register(profile("local"), "manual", 0);
  registry.observe("local", {
    state: "ready",
    capabilities: capabilities(),
    authenticated: true,
    lastLatencyMs: 4,
    atMs: 100
  });

  // An operator renaming a profile must not lose the live connection state.
  registry.register(profile("local", { label: "Renamed" }), "profile", 200);

  const record = registry.get("local");
  assert.equal(record.label, "Renamed");
  assert.equal(record.state, "ready");
  assert.equal(record.authenticated, true);
  assert.equal(record.engineId, "engine_a");
  assert.equal(record.lastLatencyMs, 4);
});

test("capabilities are authoritative for engine identity", () => {
  const registry = new EngineRegistry();
  registry.register(profile("p"), "manual", 0);

  // Hello reports one thing...
  registry.observe("p", { engineId: "provisional", reportedName: "Provisional" });
  assert.equal(registry.get("p").engineId, "provisional");

  // ...and capabilities override it, because they are the authoritative source.
  registry.observe("p", {
    capabilities: capabilities({ engineId: "engine_real", engineName: "Studio B" })
  });
  const record = registry.get("p");
  assert.equal(record.engineId, "engine_real");
  assert.equal(record.reportedName, "Studio B");
  assert.equal(record.softwareVersion, "0.2.0");
  assert.equal(record.protocolVersion, 3);

  assert.equal(registry.byEngineId("engine_real").profileId, "p");
  assert.equal(registry.byEngineId("nope"), undefined);
});

test("reaching an operational state clears the failure count", () => {
  const registry = new EngineRegistry();
  registry.register(profile("p"), "manual", 0);

  registry.recordFailure("p", "connection refused", 100);
  registry.recordFailure("p", "connection refused", 200);
  assert.equal(registry.get("p").failureCount, 2);
  assert.equal(registry.get("p").state, "error");

  registry.observe("p", { state: "ready", atMs: 300 });
  assert.equal(registry.get("p").failureCount, 0);
  assert.equal(registry.get("p").lastError, null);
});

test("an error state increments the failure count", () => {
  const registry = new EngineRegistry();
  registry.register(profile("p"), "manual", 0);

  registry.observe("p", { state: "error", lastError: "heartbeat timeout" });
  assert.equal(registry.get("p").failureCount, 1);
  assert.equal(registry.get("p").lastError, "heartbeat timeout");
});

test("a failure clears authentication, because a new connection must re-auth", () => {
  const registry = new EngineRegistry();
  registry.register(profile("p"), "manual", 0);
  registry.observe("p", { authenticated: true, state: "ready" });

  registry.recordFailure("p", "socket closed", 500);
  assert.equal(registry.get("p").authenticated, false);
});

test("load is clamped to 0..1", () => {
  const registry = new EngineRegistry();
  registry.register(profile("p"), "manual", 0);

  registry.observe("p", { load: 2.5 });
  assert.equal(registry.get("p").load, 1);
  registry.observe("p", { load: -1 });
  assert.equal(registry.get("p").load, 0);
});

test("observing an unknown profile is ignored rather than throwing", () => {
  const registry = new EngineRegistry();
  assert.equal(registry.observe("ghost", { state: "ready" }), undefined);
  assert.equal(registry.recordFailure("ghost", "x"), undefined);
});

test("the summary counts states for an operator overview", () => {
  const registry = new EngineRegistry();
  for (const [index, state] of ["on-air", "ready", "error", "offline"].entries()) {
    const id = `p${index}`;
    registry.register(profile(id, { port: 4300 + index }), "manual", 0);
    registry.observe(id, { state, authenticated: state !== "offline" });
  }

  const summary = registry.summary();
  assert.equal(summary.total, 4);
  assert.equal(summary.onAir, 1);
  assert.equal(summary.operational, 2); // on-air + ready
  assert.equal(summary.errored, 1);
  assert.equal(summary.offline, 1);
  assert.equal(summary.authenticated, 3);
  assert.equal(summary.takeReady, 2);
});

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

test("selection prefers the operator's preferred engine", () => {
  const registry = new EngineRegistry();

  registry.register(profile("plain", { port: 4300 }), "manual", 0);
  registry.observe("plain", { state: "ready", capabilities: capabilities({ engineId: "e1" }) });

  registry.register(profile("chosen", { port: 4301, preferred: true }), "manual", 0);
  registry.observe("chosen", { state: "ready", capabilities: capabilities({ engineId: "e2" }) });

  assert.equal(registry.selectForStage(hugeStage).record.profileId, "chosen");
});

test("selection prefers primary over backup, then lowest load", () => {
  const registry = new EngineRegistry();

  registry.register(profile("backup", { port: 4301, role: "backup" }), "manual", 0);
  registry.observe("backup", {
    state: "ready",
    capabilities: capabilities({ engineId: "b" }),
    load: 0
  });

  registry.register(profile("primary", { port: 4300, role: "primary" }), "manual", 0);
  registry.observe("primary", {
    state: "ready",
    capabilities: capabilities({ engineId: "p" }),
    load: 0.9
  });

  // Role beats load: a loaded primary is still the primary.
  assert.equal(registry.selectForStage(hugeStage).record.profileId, "primary");

  // Between two equal roles, load decides.
  registry.register(profile("aux-busy", { port: 4302, role: "auxiliary" }), "manual", 0);
  registry.observe("aux-busy", {
    state: "ready",
    capabilities: capabilities({ engineId: "a1" }),
    load: 0.8
  });
  registry.register(profile("aux-idle", { port: 4303, role: "auxiliary" }), "manual", 0);
  registry.observe("aux-idle", {
    state: "ready",
    capabilities: capabilities({ engineId: "a2" }),
    load: 0.1
  });

  registry.observe("primary", { state: "error" });
  assert.equal(registry.selectForStage(hugeStage).record.profileId, "aux-idle");
});

test("an incompatible engine is never selected", () => {
  const registry = new EngineRegistry();

  registry.register(profile("small", { port: 4300 }), "manual", 0);
  registry.observe("small", {
    state: "ready",
    capabilities: capabilities({
      engineId: "small",
      engineName: "Laptop",
      limits: { maxLogicalCanvasWidth: 8_192, maxLogicalCanvasHeight: 8_192 }
    })
  });

  assert.equal(registry.selectForStage(hugeStage), undefined);

  // And the operator is told exactly why, per engine.
  const reasons = registry.explainIncompatibility(hugeStage);
  assert.equal(reasons.length, 1);
  assert.ok(reasons[0].includes("Laptop") || reasons[0].includes("127.0.0.1"));
  assert.ok(reasons[0].includes("logical width"));
});

test("a disabled or non-operational engine is excluded with a stated reason", () => {
  const registry = new EngineRegistry();

  registry.register(profile("disabled", { port: 4300, enabled: false }), "manual", 0);
  registry.observe("disabled", { state: "ready", capabilities: capabilities() });

  registry.register(profile("broken", { port: 4301 }), "manual", 0);
  registry.observe("broken", { state: "error", lastError: "connection refused" });

  registry.register(profile("unknown", { port: 4302 }), "manual", 0);
  registry.observe("unknown", { state: "ready" }); // no capabilities yet

  assert.equal(registry.selectForStage(hugeStage), undefined);

  const reasons = registry.explainIncompatibility(hugeStage).join("\n");
  assert.ok(reasons.includes("disabled"));
  assert.ok(reasons.includes("connection refused"));
  assert.ok(reasons.includes("capabilities not yet negotiated"));
});

test("with no engines registered the explanation says so", () => {
  const registry = new EngineRegistry();
  assert.deepEqual(registry.explainIncompatibility(hugeStage), [
    "no engines are registered"
  ]);
});

// ---------------------------------------------------------------------------
// Mirroring and failover
// ---------------------------------------------------------------------------

test("mirror targets are the operational backups", () => {
  const registry = new EngineRegistry();

  registry.register(profile("primary", { port: 4300, role: "primary" }), "manual", 0);
  registry.observe("primary", { state: "on-air", capabilities: capabilities() });

  registry.register(profile("backup-up", { port: 4301, role: "backup" }), "manual", 0);
  registry.observe("backup-up", { state: "ready", capabilities: capabilities() });

  registry.register(profile("backup-down", { port: 4302, role: "backup" }), "manual", 0);
  registry.observe("backup-down", { state: "offline" });

  registry.register(profile("aux", { port: 4303, role: "auxiliary" }), "manual", 0);
  registry.observe("aux", { state: "ready", capabilities: capabilities() });

  // A backup must hold the same scenes or it cannot be failed over to.
  const targets = registry.mirrorTargets("primary");
  assert.deepEqual(targets.map((record) => record.profileId), ["backup-up"]);

  assert.deepEqual(registry.mirrorTargets("ghost"), []);
});

test("failover picks a capable backup, never the failed engine", () => {
  const registry = new EngineRegistry();

  registry.register(profile("primary", { port: 4300, role: "primary" }), "manual", 0);
  registry.observe("primary", { state: "error", capabilities: capabilities() });

  registry.register(profile("backup", { port: 4301, role: "backup" }), "manual", 0);
  registry.observe("backup", {
    state: "ready",
    capabilities: capabilities({ engineId: "b" }),
    load: 0.5
  });

  const target = registry.failoverFor("primary", hugeStage);
  assert.equal(target.profileId, "backup");
});

test("failover refuses a backup that cannot render the stage", () => {
  const registry = new EngineRegistry();

  registry.register(profile("primary", { port: 4300, role: "primary" }), "manual", 0);
  registry.observe("primary", { state: "error", capabilities: capabilities() });

  registry.register(profile("weak", { port: 4301, role: "backup" }), "manual", 0);
  registry.observe("weak", {
    state: "ready",
    // Cannot tile, so it cannot render a 50,000-wide stage at all.
    capabilities: capabilities({ engineId: "w", tileRendering: false })
  });

  // A backup that cannot render the stage is not a backup.
  assert.equal(registry.failoverFor("primary", hugeStage), undefined);
});

test("failover prefers a designated backup over an auxiliary", () => {
  const registry = new EngineRegistry();

  registry.register(profile("primary", { port: 4300, role: "primary" }), "manual", 0);
  registry.observe("primary", { state: "error", capabilities: capabilities() });

  registry.register(profile("aux", { port: 4301, role: "auxiliary" }), "manual", 0);
  registry.observe("aux", {
    state: "ready",
    capabilities: capabilities({ engineId: "a" }),
    load: 0
  });

  registry.register(profile("backup", { port: 4302, role: "backup" }), "manual", 0);
  registry.observe("backup", {
    state: "ready",
    capabilities: capabilities({ engineId: "b" }),
    load: 0.9
  });

  assert.equal(registry.failoverFor("primary", hugeStage).profileId, "backup");
});

test("removing a profile drops it from the registry", () => {
  const registry = new EngineRegistry();
  registry.register(profile("p"), "manual", 0);

  assert.equal(registry.remove("p"), true);
  assert.equal(registry.remove("p"), false);
  assert.equal(registry.all().length, 0);
});

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/** Minimal scriptable WebSocket, so the transport is tested without a server. */
function fakeSocketFactory(script = {}) {
  const sockets = [];
  const factory = (url, protocols) => {
    const socket = {
      url,
      protocols,
      readyState: 0,
      sent: [],
      onopen: null,
      onclose: null,
      onerror: null,
      onmessage: null,
      send(data) {
        this.sent.push(data);
      },
      close(code, reason) {
        this.readyState = 3;
        this.onclose?.({ code, reason });
      },
      /** Test helper: complete the handshake. */
      accept() {
        this.readyState = 1;
        this.onopen?.({});
      }
    };
    sockets.push(socket);
    if (script.autoOpen !== false) {
      // Open on the next tick, as a real socket would.
      queueMicrotask(() => socket.accept());
    }
    return socket;
  };
  return { factory, sockets };
}

test("the transport sends the token as a subprotocol, never in the URL", async () => {
  const { factory, sockets } = fakeSocketFactory();
  const transport = new WebSocketEngineTransport({
    url: "wss://10.0.0.5:4300",
    authToken: "secret-token",
    factory
  });

  await transport.open();

  // Query strings end up in proxy logs and browser history.
  assert.ok(!sockets[0].url.includes("secret-token"));
  assert.deepEqual(sockets[0].protocols, ["grapix-engine-v3", "bearer.secret-token"]);
  assert.equal(transport.kind, "websocket");
  assert.equal(transport.address, "wss://10.0.0.5:4300");
});

test("frames round-trip through the transport", async () => {
  const { factory, sockets } = fakeSocketFactory();
  const transport = new WebSocketEngineTransport({ url: "ws://127.0.0.1:4300", factory });

  const received = [];
  transport.onFrame((frame) => received.push(frame));
  await transport.open();

  transport.send('{"hello":true}');
  assert.deepEqual(sockets[0].sent, ['{"hello":true}']);

  sockets[0].onmessage({ data: '{"reply":true}' });
  assert.deepEqual(received, ['{"reply":true}']);
});

test("binary frames are ignored rather than guessed at", async () => {
  const { factory, sockets } = fakeSocketFactory();
  const transport = new WebSocketEngineTransport({ url: "ws://127.0.0.1:4300", factory });

  const received = [];
  transport.onFrame((frame) => received.push(frame));
  await transport.open();

  sockets[0].onmessage({ data: new Uint8Array([1, 2, 3]) });
  assert.deepEqual(received, []);
});

test("sending before the socket is open throws rather than dropping the frame", () => {
  const { factory } = fakeSocketFactory({ autoOpen: false });
  const transport = new WebSocketEngineTransport({ url: "ws://127.0.0.1:4300", factory });

  assert.throws(() => transport.send("{}"), /socket is not open/);
});

test("a close is reported with a usable reason", async () => {
  const { factory, sockets } = fakeSocketFactory();
  const transport = new WebSocketEngineTransport({ url: "ws://127.0.0.1:4300", factory });

  const closes = [];
  transport.onClose((reason) => closes.push(reason));
  await transport.open();

  sockets[0].onclose({ code: 1006, reason: "" });
  // No reason from the peer still produces something an operator can read.
  assert.equal(closes[0], "socket closed (code 1006)");

  sockets[0].onclose({ code: 1000, reason: "engine restarting" });
  assert.equal(closes[1], "engine restarting");
});

test("a connect timeout closes the half-open socket", async () => {
  const timers = [];
  const { factory, sockets } = fakeSocketFactory({ autoOpen: false });

  const transport = new WebSocketEngineTransport({
    url: "ws://127.0.0.1:4300",
    factory,
    connectTimeoutMs: 5_000,
    setTimer: (handler) => {
      timers.push(handler);
      return timers.length;
    },
    clearTimer: () => {}
  });

  const pending = transport.open();
  // Fire the timeout.
  timers[0]();

  await assert.rejects(pending, /timed out connecting/);
  // A half-open socket that is left alone may connect later and leak.
  assert.equal(sockets[0].readyState, 3);
});

test("a socket error during connect rejects the open", async () => {
  const { factory, sockets } = fakeSocketFactory({ autoOpen: false });
  const transport = new WebSocketEngineTransport({ url: "ws://127.0.0.1:4300", factory });

  const pending = transport.open();
  sockets[0].onerror({});

  await assert.rejects(pending, /could not connect/);
});

test("availability of a global WebSocket is reported honestly", () => {
  // Node 22 has one; this asserts the probe agrees with reality rather than a
  // hardcoded answer.
  assert.equal(isWebSocketAvailable(), typeof globalThis.WebSocket === "function");
});
