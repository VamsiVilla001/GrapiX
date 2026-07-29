import assert from "node:assert/strict";
import test from "node:test";

import {
  canTransition,
  checkSceneCapability,
  checkStageCapability,
  createEngineMessage,
  decodeEngineMessage,
  encodeEngineMessage,
  ENGINE_MESSAGE_TYPES,
  ENGINE_PROTOCOL_VERSION,
  ENGINE_REQUEST_TYPES,
  ENGINE_STATES,
  EngineStateMachine,
  HeartbeatMonitor,
  isEngineOperational,
  canAcceptTake,
  MessageDeduplicator,
  MessageIdGenerator,
  messageGroup,
  messageRequiresAck,
  previewPixelEstimate,
  RateLimiter,
  retryDelayMs,
  selectEngineForStage,
  SequenceGenerator,
  SequenceTracker,
  shouldRetry,
  summarizeEngineStatus,
  validateEnvelope,
  DEFAULT_RETRY_POLICY
} from "../dist/index.js";

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

test("every message group is represented", () => {
  for (const type of [
    "connection.hello",
    "connection.authenticate",
    "connection.heartbeat",
    "connection.capabilities",
    "connection.disconnect",
    "scene.load",
    "scene.unload",
    "scene.fullSync",
    "scene.applyPatch",
    "scene.validate",
    "scene.prepare",
    "asset.register",
    "asset.upload",
    "asset.validate",
    "asset.preload",
    "asset.release",
    "playout.cue",
    "playout.takeOnline",
    "playout.takeOffline",
    "playout.continue",
    "playout.update",
    "playout.stop",
    "playout.clear",
    "playout.replace",
    "playout.transition",
    "preview.request",
    "preview.streamStart",
    "preview.streamStop",
    "preview.setViewport",
    "engine.getStatus",
    "engine.getDiagnostics",
    "engine.getCapabilities",
    "engine.setConfiguration",
    "engine.restartRenderer"
  ]) {
    assert.ok(ENGINE_REQUEST_TYPES.includes(type), `missing request type ${type}`);
  }
  assert.ok(ENGINE_MESSAGE_TYPES.length > ENGINE_REQUEST_TYPES.length);
});

test("a message round-trips through encode and decode unchanged", () => {
  const message = createEngineMessage(
    "playout.cue",
    { sceneId: "scene_1", sceneRevision: 4, channel: "preview" },
    {
      messageId: "m-1",
      sequence: 1,
      timestampMs: 1_700_000_000_000,
      requestId: "req-1",
      engineId: "engine_a",
      projectId: "project_x",
      sceneId: "scene_1",
      sceneRevision: 4
    }
  );

  assert.equal(message.protocolVersion, ENGINE_PROTOCOL_VERSION);
  assert.equal(message.direction, "client-to-engine");
  assert.equal(message.requiresAck, true);

  const decoded = decodeEngineMessage(encodeEngineMessage(message));
  assert.equal(decoded.ok, true);
  assert.deepEqual(decoded.message, message);
});

test("acknowledgement requirement is per message type", () => {
  // Mutating commands need acknowledging.
  assert.equal(messageRequiresAck("playout.takeOnline"), true);
  assert.equal(messageRequiresAck("scene.applyPatch"), true);
  assert.equal(messageRequiresAck("asset.upload"), true);

  // Queries do not: their reply is the acknowledgement.
  assert.equal(messageRequiresAck("engine.getStatus"), false);
  assert.equal(messageRequiresAck("connection.heartbeat"), false);
  assert.equal(messageRequiresAck("preview.request"), false);
});

test("malformed envelopes are rejected field by field", () => {
  assert.deepEqual(validateEnvelope(null).errors, ["message must be a JSON object"]);
  assert.deepEqual(validateEnvelope([]).errors, ["message must be a JSON object"]);

  const bad = validateEnvelope({
    protocolVersion: 2,
    messageId: "",
    type: "not.a.type",
    sequence: 0,
    timestampMs: -1,
    requiresAck: "yes",
    direction: "sideways",
    requestId: 5,
    engineId: undefined,
    sceneRevision: -3
  });

  assert.equal(bad.valid, false);
  const joined = bad.errors.join("\n");
  assert.ok(joined.includes("protocolVersion"));
  assert.ok(joined.includes("messageId"));
  assert.ok(joined.includes("unknown message type"));
  assert.ok(joined.includes("sequence"));
  assert.ok(joined.includes("timestampMs"));
  assert.ok(joined.includes("requiresAck"));
  assert.ok(joined.includes("direction"));
  assert.ok(joined.includes("payload is required"));
  assert.ok(joined.includes("requestId"));
  assert.ok(joined.includes("sceneRevision"));
});

test("explicit null is accepted where undefined is not", () => {
  const base = {
    protocolVersion: ENGINE_PROTOCOL_VERSION,
    messageId: "m",
    type: "engine.getStatus",
    sequence: 1,
    timestampMs: 1,
    requiresAck: false,
    direction: "client-to-engine",
    payload: {},
    requestId: null,
    engineId: null,
    projectId: null,
    sceneId: null,
    sceneRevision: null
  };
  assert.equal(validateEnvelope(base).valid, true);

  const undefinedField = { ...base };
  delete undefinedField.engineId;
  // Absent reads as undefined, which is not a string and not null.
  assert.equal(validateEnvelope(undefinedField).valid, false);
});

test("version mismatch is distinguished from a generic envelope error", () => {
  const wrongVersion = decodeEngineMessage(
    JSON.stringify({
      protocolVersion: 2,
      messageId: "m",
      type: "engine.getStatus",
      sequence: 1,
      timestampMs: 1,
      requiresAck: false,
      direction: "client-to-engine",
      payload: {},
      requestId: null,
      engineId: null,
      projectId: null,
      sceneId: null,
      sceneRevision: null
    })
  );
  assert.equal(wrongVersion.ok, false);
  assert.equal(wrongVersion.code, "PROTOCOL_VERSION_MISMATCH");

  const garbage = decodeEngineMessage("{not json");
  assert.equal(garbage.ok, false);
  assert.equal(garbage.code, "INVALID_JSON");
});

test("oversized frames are refused before parsing", () => {
  const huge = JSON.stringify({ padding: "x".repeat(5_000) });
  const result = decodeEngineMessage(huge, { maxBytes: 1_000 });

  assert.equal(result.ok, false);
  assert.equal(result.code, "MESSAGE_TOO_LARGE");
  assert.ok(result.errors[0].includes("limit is 1000"));
});

test("creating a message with broken identity throws locally", () => {
  const valid = { messageId: "m", sequence: 1, timestampMs: 1 };
  assert.throws(() => createEngineMessage("bogus.type", {}, valid), /unknown engine message type/);
  assert.throws(
    () => createEngineMessage("engine.getStatus", {}, { ...valid, messageId: "  " }),
    /non-empty string/
  );
  assert.throws(
    () => createEngineMessage("engine.getStatus", {}, { ...valid, sequence: 0 }),
    /positive safe integer/
  );
  assert.throws(
    () => createEngineMessage("engine.getStatus", {}, { ...valid, timestampMs: -1 }),
    /non-negative safe integer/
  );
});

test("message groups classify correctly for rate limiting and audit", () => {
  assert.equal(messageGroup("playout.takeOnline"), "playout");
  assert.equal(messageGroup("scene.applyPatch"), "scene");
  assert.equal(messageGroup("asset.upload"), "asset");
  assert.equal(messageGroup("preview.request"), "preview");
  assert.equal(messageGroup("engine.getStatus"), "engine");
  assert.equal(messageGroup("stage.load"), "stage");
  assert.equal(messageGroup("reply.ack"), "reply");
  assert.equal(messageGroup("event.warning"), "event");
});

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

test("duplicate message ids are recognised", () => {
  const dedupe = new MessageDeduplicator({ capacity: 10, ttlMs: 1_000 });

  assert.equal(dedupe.check("m-1", 0), false);
  assert.equal(dedupe.check("m-1", 10), true);
  assert.equal(dedupe.check("m-2", 10), false);
  assert.equal(dedupe.size, 2);
});

test("the dedupe window is bounded by capacity", () => {
  const dedupe = new MessageDeduplicator({ capacity: 3, ttlMs: 0 });

  for (let i = 1; i <= 5; i += 1) dedupe.check(`m-${i}`, i);

  assert.equal(dedupe.size, 3);
  // The oldest ids were forgotten, so memory cannot grow without bound.
  assert.equal(dedupe.has("m-1"), false);
  assert.equal(dedupe.has("m-5"), true);
});

test("the dedupe window expires by time", () => {
  const dedupe = new MessageDeduplicator({ capacity: 100, ttlMs: 1_000 });

  dedupe.check("m-1", 0);
  assert.equal(dedupe.check("m-1", 500), true);
  // Past the TTL the id is forgotten and the message would be reprocessed.
  assert.equal(dedupe.check("m-1", 2_000), false);
});

test("a repeatedly retransmitted id stays remembered", () => {
  const dedupe = new MessageDeduplicator({ capacity: 3, ttlMs: 0 });

  dedupe.check("hot", 0);
  dedupe.check("a", 1);
  dedupe.check("hot", 2); // refreshes its position
  dedupe.check("b", 3);
  dedupe.check("c", 4);

  assert.equal(dedupe.has("hot"), true);
  assert.equal(dedupe.has("a"), false);
});

// ---------------------------------------------------------------------------
// Sequencing
// ---------------------------------------------------------------------------

test("in-sequence messages are accepted immediately", () => {
  const tracker = new SequenceTracker();

  assert.deepEqual(tracker.offer(1, "a"), { verdict: "accept", released: ["a"] });
  assert.deepEqual(tracker.offer(2, "b"), { verdict: "accept", released: ["b"] });
  assert.equal(tracker.expected, 3);
});

test("out-of-order messages park and release in one pass", () => {
  const tracker = new SequenceTracker({ parkLimit: 8 });

  assert.equal(tracker.offer(3, "c").verdict, "future");
  assert.equal(tracker.offer(2, "b").verdict, "future");
  assert.equal(tracker.parkedCount, 2);

  // Message 1 arrives and unblocks 2 and 3 together.
  const result = tracker.offer(1, "a");
  assert.equal(result.verdict, "accept");
  assert.deepEqual(result.released, ["a", "b", "c"]);
  assert.equal(tracker.parkedCount, 0);
  assert.equal(tracker.expected, 4);
});

test("already-seen sequences are duplicates", () => {
  const tracker = new SequenceTracker();
  tracker.offer(1, "a");
  tracker.offer(2, "b");

  assert.equal(tracker.offer(1, "a").verdict, "duplicate");
  assert.equal(tracker.offer(2, "b").verdict, "duplicate");
});

test("too many parked messages is a gap, not an ever-growing buffer", () => {
  const tracker = new SequenceTracker({ parkLimit: 2 });

  tracker.offer(5, "e");
  tracker.offer(6, "f");
  const gap = tracker.offer(7, "g");

  assert.equal(gap.verdict, "gap");
  assert.equal(tracker.gaps, 1);
  // The parked set is dropped: guessing is never an option.
  assert.equal(tracker.parkedCount, 0);
});

test("invalid sequences are treated as gaps", () => {
  const tracker = new SequenceTracker();
  assert.equal(tracker.classify(0), "gap");
  assert.equal(tracker.classify(-1), "gap");
  assert.equal(tracker.classify(1.5), "gap");
});

test("reset restarts numbering after a reconnect", () => {
  const tracker = new SequenceTracker();
  tracker.offer(1, "a");
  tracker.offer(2, "b");
  tracker.reset();

  assert.equal(tracker.expected, 1);
  assert.equal(tracker.offer(1, "fresh").verdict, "accept");
});

test("the outbound generator is strictly increasing", () => {
  const generator = new SequenceGenerator();
  assert.equal(generator.next(), 1);
  assert.equal(generator.next(), 2);
  assert.equal(generator.current, 2);
  generator.reset();
  assert.equal(generator.next(), 1);
});

test("message ids are unique within a connection", () => {
  const ids = new MessageIdGenerator("editor");
  const generated = new Set([ids.next(), ids.next(), ids.next()]);
  assert.equal(generated.size, 3);
  assert.equal(ids.issued, 3);
});

// ---------------------------------------------------------------------------
// Retry and rate limiting
// ---------------------------------------------------------------------------

test("retry delay grows exponentially and is capped", () => {
  const policy = { maxAttempts: 10, baseDelayMs: 100, maxDelayMs: 1_000, jitterRatio: 0 };

  assert.equal(retryDelayMs(policy, 1, () => 0.5), 100);
  assert.equal(retryDelayMs(policy, 2, () => 0.5), 200);
  assert.equal(retryDelayMs(policy, 3, () => 0.5), 400);
  assert.equal(retryDelayMs(policy, 4, () => 0.5), 800);
  // Capped, not 1600.
  assert.equal(retryDelayMs(policy, 5, () => 0.5), 1_000);
  assert.equal(retryDelayMs(policy, 20, () => 0.5), 1_000);
  assert.equal(retryDelayMs(policy, 0, () => 0.5), 0);
});

test("jitter only ever reduces the delay, so the cap is a true ceiling", () => {
  const full = { maxAttempts: 10, baseDelayMs: 1_000, maxDelayMs: 1_000, jitterRatio: 1 };
  assert.equal(retryDelayMs(full, 5, () => 0), 0);
  assert.equal(retryDelayMs(full, 5, () => 1), 1_000);

  const typical = { ...full, jitterRatio: 0.2 };
  assert.equal(retryDelayMs(typical, 5, () => 0), 800);
  assert.equal(retryDelayMs(typical, 5, () => 1), 1_000);

  // Whatever the random draw, the cap holds and the delay is non-negative.
  for (const draw of [0, 0.1, 0.37, 0.5, 0.99, 1]) {
    const delay = retryDelayMs(typical, 9, () => draw);
    assert.ok(delay >= 0, `negative delay for draw ${draw}`);
    assert.ok(delay <= typical.maxDelayMs, `delay ${delay} exceeded the cap for draw ${draw}`);
  }
});

test("attempt budgets are enforced", () => {
  assert.equal(shouldRetry(DEFAULT_RETRY_POLICY, 1), true);
  assert.equal(shouldRetry(DEFAULT_RETRY_POLICY, DEFAULT_RETRY_POLICY.maxAttempts), false);
});

test("the rate limiter allows bursts and then throttles", () => {
  const limiter = new RateLimiter({ capacity: 3, refillPerSecond: 1 }, 0);

  assert.equal(limiter.tryConsume(0), true);
  assert.equal(limiter.tryConsume(0), true);
  assert.equal(limiter.tryConsume(0), true);
  // Burst exhausted.
  assert.equal(limiter.tryConsume(0), false);
  assert.equal(limiter.retryAfterMs(0), 1_000);

  // One token back after a second.
  assert.equal(limiter.tryConsume(1_000), true);
  assert.equal(limiter.tryConsume(1_000), false);
});

test("the rate limiter refills only up to capacity", () => {
  const limiter = new RateLimiter({ capacity: 2, refillPerSecond: 10 }, 0);
  limiter.tryConsume(0);
  limiter.tryConsume(0);
  assert.equal(limiter.available, 0);

  limiter.tryConsume(60_000); // a minute of refill
  assert.ok(limiter.available <= 2);
});

// ---------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------

test("heartbeat measures latency and detects silence", () => {
  const monitor = new HeartbeatMonitor({ intervalMs: 1_000, timeoutMs: 3_000 }, 0);

  assert.equal(monitor.shouldSend(0), false);
  assert.equal(monitor.shouldSend(1_000), true);

  monitor.recordSent(1_000);
  const latency = monitor.recordReceived(1_040, 1_000);
  assert.equal(latency, 40);
  assert.equal(monitor.lastLatencyMs, 40);

  monitor.recordSent(2_000);
  monitor.recordReceived(2_060, 2_000);
  assert.equal(monitor.averageLatencyMs, 50);

  // Silence past the timeout.
  assert.equal(monitor.isTimedOut(3_000), false);
  assert.equal(monitor.isTimedOut(6_000), true);
  assert.equal(monitor.recordMissed(), 1);
});

// ---------------------------------------------------------------------------
// Engine state machine
// ---------------------------------------------------------------------------

test("all eleven engine states exist", () => {
  assert.deepEqual([...ENGINE_STATES], [
    "offline",
    "discovering",
    "connecting",
    "authenticating",
    "synchronising",
    "preparing",
    "ready",
    "on-air",
    "warning",
    "error",
    "recovering"
  ]);
});

test("the connection lifecycle path is permitted end to end", () => {
  const machine = new EngineStateMachine("offline");
  const path = [
    "discovering",
    "connecting",
    "authenticating",
    "synchronising",
    "preparing",
    "ready",
    "on-air"
  ];

  for (const next of path) {
    const change = machine.transition(next, `-> ${next}`, 0);
    assert.equal(change.rejected, false, `refused ${change.from} -> ${next}`);
  }
  assert.equal(machine.state, "on-air");
  assert.equal(machine.operational, true);
});

test("illegal transitions are refused without changing state", () => {
  const machine = new EngineStateMachine("offline");

  // You cannot be on air straight from offline.
  const change = machine.transition("on-air", "impossible", 0);
  assert.equal(change.rejected, true);
  assert.equal(machine.state, "offline");
  assert.equal(canTransition("offline", "on-air"), false);
});

test("error is reachable from anywhere and recovers through connecting", () => {
  for (const state of ENGINE_STATES) {
    if (state === "error") continue;
    if (state === "recovering") continue;
    assert.equal(canTransition(state, "error"), true, `${state} -> error should be allowed`);
  }
  assert.equal(canTransition("error", "recovering"), true);
  assert.equal(canTransition("recovering", "connecting"), true);
});

test("a hard transport close forces state regardless of the table", () => {
  const machine = new EngineStateMachine("on-air");
  const forced = machine.force("offline", "socket closed", 100);

  assert.equal(forced.rejected, false);
  assert.equal(machine.state, "offline");
});

test("operational and take gates agree with the state semantics", () => {
  assert.equal(isEngineOperational("ready"), true);
  assert.equal(isEngineOperational("on-air"), true);
  assert.equal(isEngineOperational("warning"), true);
  assert.equal(isEngineOperational("preparing"), false);
  assert.equal(isEngineOperational("error"), false);

  assert.equal(canAcceptTake("ready"), true);
  assert.equal(canAcceptTake("warning"), true);
  assert.equal(canAcceptTake("preparing"), false);
  assert.equal(canAcceptTake("offline"), false);
});

test("state history is bounded", () => {
  const machine = new EngineStateMachine("offline", 4);
  for (let i = 0; i < 20; i += 1) {
    machine.force(i % 2 === 0 ? "ready" : "warning", `flip ${i}`, i);
  }
  assert.equal(machine.recentHistory(100).length, 4);
});

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

function capableEngine(overrides = {}) {
  return {
    engineId: "engine_a",
    engineName: "Studio A",
    softwareVersion: "0.2.0",
    protocolVersion: 3,
    sceneDocumentVersions: [1],
    stageDocumentVersions: [1],
    os: { platform: "windows", release: "10.0.19045", arch: "x86_64" },
    cpu: { model: "Test CPU", logicalCores: 16 },
    gpu: {
      adapter: "Test GPU",
      backend: "vulkan",
      deviceType: "DiscreteGpu",
      driver: "test",
      vendorId: 0,
      deviceId: 0,
      memoryBytesEstimate: 8 * 1024 ** 3
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
    supportedTextureFormats: ["rgba8unorm", "bgra8unorm"],
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
      },
      {
        adapterId: "ndi",
        name: "NDI",
        available: false,
        unavailableReason: "NDI SDK 6.x not installed",
        supportsAlpha: true,
        supportsInterlaced: false,
        fixedResolutions: [],
        colorFormats: ["bgra8"]
      }
    ],
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
    supportedQualityProfiles: ["PROGRAM_HD", "PROGRAM_UHD"],
    renderedObjectTypes: ["rect", "text", "image", "mesh", "ellipse"],
    transports: ["websocket", "ipc"],
    ...overrides
  };
}

const hugeStageRequirements = {
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

test("a capable engine accepts a 50000-wide stage", () => {
  const check = checkStageCapability(hugeStageRequirements, capableEngine());
  assert.equal(check.compatible, true, JSON.stringify(check.issues));
  assert.deepEqual(check.issues, []);
});

test("a huge stage with tiling off is refused with a specific reason", () => {
  const check = checkStageCapability(
    { ...hugeStageRequirements, tilingEnabled: false },
    capableEngine()
  );

  assert.equal(check.compatible, false);
  assert.ok(check.issues.some((issue) => issue.code === "TILING_REQUIRED"));
});

test("an engine without tiling support is refused", () => {
  const engine = capableEngine();
  engine.features.tileRendering = false;

  const check = checkStageCapability(hugeStageRequirements, engine);
  assert.equal(check.compatible, false);
  assert.ok(check.issues.some((issue) => issue.code === "TILING_UNSUPPORTED"));
});

test("a tile larger than the engine texture limit is refused", () => {
  const engine = capableEngine();
  engine.limits.maxTextureDimension2d = 2_048;

  const check = checkStageCapability(hugeStageRequirements, engine);
  assert.equal(check.compatible, false);
  // 2048 + 2*32 overscan is 2112, past a 2048 limit.
  assert.ok(check.issues.some((issue) => issue.code === "TILE_TOO_LARGE"));
});

test("an unavailable output adapter names why it cannot be used", () => {
  const check = checkStageCapability(
    { ...hugeStageRequirements, requiredOutputAdapters: ["ndi", "decklink"] },
    capableEngine()
  );

  assert.equal(check.compatible, false);
  const unavailable = check.issues.find((issue) => issue.code === "OUTPUT_ADAPTER_UNAVAILABLE");
  assert.ok(unavailable.message.includes("NDI SDK 6.x not installed"));
  assert.ok(check.issues.some((issue) => issue.code === "OUTPUT_ADAPTER_UNKNOWN"));
});

test("a tile cache larger than VRAM is a warning, not a refusal", () => {
  const check = checkStageCapability(
    { ...hugeStageRequirements, tileCacheBudgetBytes: 32 * 1024 ** 3 },
    capableEngine()
  );

  assert.equal(check.compatible, true);
  assert.ok(check.issues.some((issue) => issue.code === "TILE_CACHE_OVER_VRAM"));
});

test("an unimplemented transition is refused rather than substituted with a cut", () => {
  const check = checkSceneCapability(
    {
      sceneDocumentVersion: 1,
      objectTypes: ["text", "rect"],
      transitionKinds: ["cut", "wipe"],
      usesVideo: false,
      usesNativeText: true,
      uses3d: false,
      assetCount: 2
    },
    capableEngine()
  );

  assert.equal(check.compatible, false);
  const issue = check.issues.find((candidate) => candidate.code === "TRANSITION_UNSUPPORTED");
  assert.equal(issue.subject, "wipe");
  assert.ok(issue.message.includes("rather than substituting a cut"));
});

test("unsupported object types warn and are reported as omitted", () => {
  const check = checkSceneCapability(
    {
      sceneDocumentVersion: 1,
      objectTypes: ["text", "paint", "shape"],
      transitionKinds: ["cut"],
      usesVideo: true,
      usesNativeText: true,
      uses3d: false,
      assetCount: 0
    },
    capableEngine()
  );

  // Warnings only: the scene still loads, minus those objects.
  assert.equal(check.compatible, true);
  const codes = check.issues.map((issue) => issue.code);
  assert.ok(codes.includes("OBJECT_TYPE_UNSUPPORTED"));
  assert.ok(codes.includes("VIDEO_DECODE_UNSUPPORTED"));
});

test("an unsupported scene document version is an error", () => {
  const engine = capableEngine({ sceneDocumentVersions: [2] });
  const check = checkSceneCapability(
    {
      sceneDocumentVersion: 1,
      objectTypes: [],
      transitionKinds: [],
      usesVideo: false,
      usesNativeText: false,
      uses3d: false,
      assetCount: 0
    },
    engine
  );

  assert.equal(check.compatible, false);
  assert.ok(check.issues.some((issue) => issue.code === "SCENE_VERSION_UNSUPPORTED"));
});

test("engine selection picks a compatible engine and reports when none fits", () => {
  const small = capableEngine({ engineId: "small", engineName: "Laptop" });
  small.limits.maxLogicalCanvasWidth = 8_192;
  small.limits.maxLogicalCanvasHeight = 8_192;

  const big = capableEngine({ engineId: "big", engineName: "GPU Node" });

  const chosen = selectEngineForStage(hugeStageRequirements, [small, big]);
  assert.equal(chosen.engine.engineId, "big");

  assert.equal(selectEngineForStage(hugeStageRequirements, [small]), undefined);
});

// ---------------------------------------------------------------------------
// Preview budgets
// ---------------------------------------------------------------------------

test("a scaled-stage preview of a huge stage stays inside its budget", () => {
  const stage = { logicalWidth: 50_000, logicalHeight: 50_000 };

  const pixels = previewPixelEstimate(
    { type: "scaled-stage", maxWidth: 1_920, maxHeight: 1_080 },
    stage
  );

  // Not 2.5 gigapixels: the scale is derived from the budget.
  assert.ok(pixels <= 1_920 * 1_080, `expected <= 2073600, got ${pixels}`);
  assert.ok(pixels > 0);
});

test("an explicit rect preview is estimated from its render scale", () => {
  const pixels = previewPixelEstimate(
    { type: "rect", x: 0, y: 0, width: 10_000, height: 10_000, renderScale: 0.1 },
    { logicalWidth: 50_000, logicalHeight: 50_000 }
  );
  assert.equal(pixels, 1_000 * 1_000);
});

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

test("the status summary leads with problems", () => {
  const status = {
    engineId: "engine_a",
    engineName: "Studio A",
    address: "ws://10.0.0.5:4300",
    softwareVersion: "0.2.0",
    state: "warning",
    uptimeMs: 60_000,
    qualityProfile: "PROGRAM_UHD",
    headless: true,
    stage: {
      stageId: "stage_arena",
      logicalWidth: 50_000,
      logicalHeight: 10_000,
      fullResolutionBytes: 2_000_000_000,
      surfaceCount: 4,
      viewportCount: 2,
      activeViewportWidth: 3_840,
      activeViewportHeight: 2_160,
      tilingEnabled: true
    },
    scenes: [],
    previewSceneId: null,
    programSceneId: "scene_1",
    tiles: {
      gridColumns: 25,
      gridRows: 5,
      totalTiles: 125,
      trackedTiles: 12,
      activeTiles: 8,
      dirtyTiles: 2,
      residentTiles: 12,
      evictedTiles: 0,
      pinnedTiles: 4,
      cacheBytes: 200 * 1024 * 1024,
      cacheBudgetBytes: 512 * 1024 * 1024,
      tileWidth: 2_048,
      tileHeight: 2_048,
      overscan: 32
    },
    frame: {
      frameRateNumerator: 60_000,
      frameRateDenominator: 1_001,
      currentFrame: 1_234,
      framesRendered: 1_234,
      framesDropped: 3,
      framesLate: 1,
      lastRenderMs: 7.2,
      averageRenderMs: 6.8,
      p99RenderMs: 12.1,
      frameBudgetMs: 16.68,
      budgetUtilization: 0.41
    },
    render: {
      backend: "vulkan",
      drawCalls: 42,
      textureCount: 18,
      bufferCount: 30,
      pipelineCount: 6,
      estimatedVramBytes: 400 * 1024 * 1024,
      renderPasses: 9
    },
    assets: {
      registeredAssets: 10,
      readyAssets: 9,
      loadingAssets: 1,
      failedAssets: 0,
      diskBytes: 0,
      decodedCpuBytes: 0,
      gpuBytes: 0,
      cpuBudgetBytes: 0,
      gpuBudgetBytes: 0
    },
    outputs: [],
    network: {
      connectedClients: 2,
      lastLatencyMs: 3,
      averageLatencyMs: 4,
      messagesReceived: 500,
      messagesSent: 480,
      duplicatesDropped: 1,
      sequenceGaps: 0,
      resyncCount: 0
    },
    warnings: ["surface projector-1 is uncalibrated"],
    errors: []
  };

  const summary = summarizeEngineStatus(status);
  assert.ok(summary.startsWith("Studio A [warning]"));
  assert.ok(summary.includes("1 warning(s)"));
  assert.ok(summary.includes("50000x10000 logical"));
  assert.ok(summary.includes("8/125 tiles"));
  assert.ok(summary.includes("59.94 fps"));
  assert.ok(summary.includes("3 dropped"));
});
