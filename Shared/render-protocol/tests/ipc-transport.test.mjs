import assert from "node:assert/strict";
import test from "node:test";

import {
  EngineConnection,
  IpcEngineTransport,
  IpcFrameReader,
  createEngineMessage,
  defaultIpcEndpoint,
  encodeIpcFrame
} from "../dist/index.js";

/**
 * The framing is a contract with the Rust engine's `ipc.rs`, so it is tested on its own
 * terms: a stream socket splits and coalesces writes freely, and every one of those cases
 * has to produce the same messages.
 */

test("a frame is a big-endian length followed by its body", () => {
  const framed = encodeIpcFrame('{"a":1}');
  assert.deepEqual([...framed.subarray(0, 4)], [0, 0, 0, 7]);
  assert.equal(new TextDecoder().decode(framed.subarray(4)), '{"a":1}');
});

test("a multi-byte character is counted in bytes, not characters", () => {
  // The length prefix is a byte count. Counting characters would desynchronise the
  // stream the first time a scene contained a non-ASCII glyph.
  const framed = encodeIpcFrame('{"t":"café"}');
  const declared = new DataView(framed.buffer).getUint32(0, false);
  assert.equal(declared, framed.length - 4);
  assert.equal(declared, 13, "é is two bytes in UTF-8");
});

test("a frame split across chunks is reassembled", () => {
  const reader = new IpcFrameReader();
  const framed = encodeIpcFrame('{"hello":"world"}');

  // Split inside the length prefix, then inside the body: both are things a real socket
  // does.
  assert.deepEqual(reader.push(framed.subarray(0, 2)), []);
  assert.deepEqual(reader.push(framed.subarray(2, 9)), []);
  assert.deepEqual(reader.push(framed.subarray(9)), ['{"hello":"world"}']);
  assert.equal(reader.pendingBytes, 0);
});

test("several frames in one chunk all come out, in order", () => {
  const reader = new IpcFrameReader();
  const first = encodeIpcFrame('{"n":1}');
  const second = encodeIpcFrame('{"n":2}');
  const third = encodeIpcFrame('{"n":3}');

  const combined = new Uint8Array(first.length + second.length + third.length);
  combined.set(first, 0);
  combined.set(second, first.length);
  combined.set(third, first.length + second.length);

  assert.deepEqual(reader.push(combined), ['{"n":1}', '{"n":2}', '{"n":3}']);
  assert.equal(reader.pendingBytes, 0);
});

test("the tail of one frame and the head of the next are handled", () => {
  const reader = new IpcFrameReader();
  const first = encodeIpcFrame('{"n":1}');
  const second = encodeIpcFrame('{"n":2}');

  const combined = new Uint8Array(first.length + second.length);
  combined.set(first, 0);
  combined.set(second, first.length);

  // Cut two bytes into the second frame's length prefix.
  const boundary = first.length + 2;
  assert.deepEqual(reader.push(combined.subarray(0, boundary)), ['{"n":1}']);
  assert.equal(reader.pendingBytes, 2);
  assert.deepEqual(reader.push(combined.subarray(boundary)), ['{"n":2}']);
});

test("a frame containing newlines survives, which is why lengths are used", () => {
  const reader = new IpcFrameReader();
  const message = JSON.stringify({ text: "line one\nline two\r\nline three" });
  assert.deepEqual(reader.push(encodeIpcFrame(message)), [message]);
});

test("an oversized declared length is refused before the body is buffered", () => {
  const reader = new IpcFrameReader(16);
  const framed = new Uint8Array(8);
  new DataView(framed.buffer).setUint32(0, 1_000_000, false);

  assert.throws(() => reader.push(framed), /declares 1000000 bytes/);
});

test("a zero-length frame is a frame, not an end of stream", () => {
  const reader = new IpcFrameReader();
  const framed = new Uint8Array(4);
  new DataView(framed.buffer).setUint32(0, 0, false);
  assert.deepEqual(reader.push(framed), [""]);
});

// ---------------------------------------------------------------------------
// The transport
// ---------------------------------------------------------------------------

/** A socket that records writes and lets a test push bytes back. */
function createFakeSocket() {
  const handlers = new Map();
  const written = [];
  let ended = false;
  let destroyed = false;

  return {
    socket: {
      write(data) {
        written.push(data);
        return true;
      },
      end() {
        ended = true;
      },
      destroy() {
        destroyed = true;
      },
      on(event, handler) {
        handlers.set(event, handler);
        return this;
      }
    },
    written,
    get ended() {
      return ended;
    },
    get destroyed() {
      return destroyed;
    },
    deliver(bytes) {
      handlers.get("data")?.(bytes);
    },
    fail(error) {
      handlers.get("error")?.(error);
    },
    hangUp() {
      handlers.get("close")?.();
    }
  };
}

test("frames sent are length-prefixed and frames received are decoded", async () => {
  const fake = createFakeSocket();
  const transport = new IpcEngineTransport({
    path: "\\\\.\\pipe\\test",
    factory: async () => fake.socket
  });

  const received = [];
  transport.onFrame((frame) => received.push(frame));
  await transport.open();

  transport.send('{"type":"connection.hello"}');
  assert.equal(fake.written.length, 1);
  assert.deepEqual([...fake.written[0].subarray(0, 4)], [0, 0, 0, 27]);

  fake.deliver(encodeIpcFrame('{"type":"reply.hello"}'));
  assert.deepEqual(received, ['{"type":"reply.hello"}']);

  assert.equal(transport.kind, "ipc");
  assert.equal(transport.address, "\\\\.\\pipe\\test");
});

test("sending before the transport is open is an error, not a silent drop", async () => {
  const transport = new IpcEngineTransport({
    path: "/tmp/test.sock",
    factory: async () => createFakeSocket().socket
  });

  // A dropped command would be invisible: the caller would wait for a reply forever.
  assert.throws(() => transport.send("{}"), /is not open/);
});

test("a framing violation reports and closes rather than guessing", async () => {
  const fake = createFakeSocket();
  const transport = new IpcEngineTransport({
    path: "/tmp/test.sock",
    maxFrameBytes: 32,
    factory: async () => fake.socket,
    setTimer: () => 0,
    clearTimer: () => {}
  });

  const errors = [];
  const closes = [];
  transport.onError((error) => errors.push(error.message));
  transport.onClose((reason) => closes.push(reason));
  await transport.open();

  const bogus = new Uint8Array(8);
  new DataView(bogus.buffer).setUint32(0, 999_999, false);
  fake.deliver(bogus);

  // Once a length is wrong there is no way to find the next boundary, so continuing would
  // mean interpreting arbitrary bytes as messages.
  assert.equal(errors.length, 1);
  assert.match(errors[0], /declares 999999 bytes/);
  assert.equal(closes.length, 1);
  assert.equal(fake.ended, true);
});

test("a socket hanging up is reported as a close", async () => {
  const fake = createFakeSocket();
  const transport = new IpcEngineTransport({
    path: "/tmp/test.sock",
    factory: async () => fake.socket
  });

  const closes = [];
  transport.onClose((reason) => closes.push(reason));
  await transport.open();
  fake.hangUp();

  assert.deepEqual(closes, ["ipc socket closed"]);
});

test("a connection completes its handshake over the ipc transport", async () => {
  // The point: `EngineConnection` is transport-agnostic. Nothing in the protocol layer
  // should care that this is a pipe rather than a socket.
  const fake = createFakeSocket();
  const transport = new IpcEngineTransport({
    path: "/tmp/test.sock",
    factory: async () => fake.socket
  });

  const client = new EngineConnection({
    clientId: "shell",
    clientName: "GrapiX Desktop",
    clientRole: "editor",
    clientVersion: "0.2.0",
    transport,
    autoReconnect: false
  });

  const connecting = client.connect();

  // Answer each request as it appears, framed exactly as the engine would.
  let engineSequence = 0;
  const decoder = new TextDecoder();
  for (let round = 0; round < 12; round += 1) {
    await Promise.resolve();
    await Promise.resolve();

    while (fake.written.length > 0) {
      const raw = fake.written.shift();
      const request = JSON.parse(decoder.decode(raw.subarray(4)));
      engineSequence += 1;

      const reply =
        request.type === "connection.hello"
          ? createEngineMessage(
              "reply.hello",
              {
                engineId: "engine_ipc",
                engineName: "Local engine",
                softwareVersion: "0.2.0",
                protocolVersion: request.protocolVersion,
                state: "connecting",
                authenticationRequired: false
              },
              {
                messageId: `eng-${engineSequence}`,
                sequence: engineSequence,
                direction: "engine-to-client",
                requestId: request.requestId,
                engineId: "engine_ipc",
                timestampMs: 1_700_000_000_000
              }
            )
          : request.type === "engine.getCapabilities"
            ? createEngineMessage("reply.capabilities", capabilities(), {
                messageId: `eng-${engineSequence}`,
                sequence: engineSequence,
                direction: "engine-to-client",
                requestId: request.requestId,
                engineId: "engine_ipc",
                timestampMs: 1_700_000_000_000
              })
            : createEngineMessage(
                "reply.ack",
                { requestType: request.type },
                {
                  messageId: `eng-${engineSequence}`,
                  sequence: engineSequence,
                  direction: "engine-to-client",
                  requestId: request.requestId,
                  engineId: "engine_ipc",
                  timestampMs: 1_700_000_000_000
                }
              );

      fake.deliver(encodeIpcFrame(JSON.stringify(reply)));
    }
  }

  const negotiated = await connecting;
  assert.equal(negotiated.engineId, "engine_ipc");
  assert.equal(client.state, "synchronising");
});

test("the default endpoint is named per platform", () => {
  // The two namespaces are unrelated: a Windows pipe is not a file, a Unix socket is.
  assert.equal(defaultIpcEndpoint("win32"), "\\\\.\\pipe\\grapix-render-engine");
  assert.equal(defaultIpcEndpoint("linux"), "/tmp/grapix-render-engine.sock");
  assert.equal(defaultIpcEndpoint("darwin"), "/tmp/grapix-render-engine.sock");
});

function capabilities() {
  return {
    engineId: "engine_ipc",
    engineName: "Local engine",
    softwareVersion: "0.2.0",
    protocolVersion: 3,
    sceneDocumentVersions: [1],
    stageDocumentVersions: [1],
    os: { platform: "test", release: "0", arch: "x86_64" },
    cpu: { model: "Test", logicalCores: 8 },
    gpu: {
      adapter: "Test",
      backend: "test",
      deviceType: "DiscreteGpu",
      driver: "test",
      driverInfo: "test",
      vendorId: 0,
      deviceId: 0,
      memoryBytesEstimate: 0
    },
    limits: {
      maxTextureDimension2d: 16384,
      maxTextureDimension3d: 2048,
      maxTextureArrayLayers: 256,
      maxBufferSize: 1 << 30,
      maxBindGroups: 8,
      maxLogicalCanvasWidth: 50000,
      maxLogicalCanvasHeight: 50000,
      maxTileSize: 4096,
      maxActiveScenes: 8,
      maxWarmScenes: 3,
      maxPreviewPixels: 2073600,
      maxMessageBytes: 8388608,
      maxUploadBytes: 268435456,
      maxOutputs: 4,
      maxSurfaces: 16
    },
    supportedTextureFormats: ["rgba8unorm"],
    supportedVideoFormats: [],
    supportedShaderFeatures: ["wgsl"],
    outputAdapters: [],
    features: {
      tileRendering: true,
      headlessRendering: true,
      virtualCanvas: true,
      multiSurfaceMapping: true,
      scenePatching: true,
      previewStreaming: true,
      sharedMemoryPreview: false,
      nativeTextRender: true,
      packagedFontFiles: true,
      nativeVideoDecode: false,
      native3dRender: true,
      hardwareEncoding: false,
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
