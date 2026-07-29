/**
 * Local IPC end-to-end proof.
 *
 * Starts its own engine with an IPC endpoint and no useful TCP port, then drives it with
 * the real `EngineConnection` over the real `IpcEngineTransport`. If this passes, the
 * embedded deployment mode genuinely works: a host can run an engine that is not
 * reachable from the network at all.
 *
 * Self-contained — it does not need `npm run dev:engine` — so it can run in CI on a
 * machine with a GPU.
 */
import { spawn } from "node:child_process";
import { once } from "node:events";

import {
  EngineConnection,
  IpcEngineTransport,
  defaultIpcEndpoint
} from "@grapix/render-protocol";

const pass = [];
const fail = [];

function check(label, condition, detail = "") {
  if (condition) {
    pass.push(label);
    console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    fail.push(label);
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const endpoint =
  process.env.GRAPIX_ENGINE_IPC ?? `${defaultIpcEndpoint()}-e2e-${process.pid}`;
// A port of its own so this never disturbs a running dev engine on 4400.
const port = Number(process.env.ENGINE_PORT ?? 4402);

const binary =
  process.platform === "win32"
    ? "services/render-engine/target/debug/grapix-render-engine.exe"
    : "services/render-engine/target/debug/grapix-render-engine";

console.log(`\nStarting an engine on IPC ${endpoint}\n`);

const engine = spawn(
  binary,
  ["--config", "services/render-engine/engine.toml", "--ipc", endpoint, "--port", String(port)],
  { stdio: ["ignore", "pipe", "pipe"] }
);

let engineLog = "";
engine.stdout.on("data", (chunk) => {
  engineLog += chunk.toString();
});
engine.stderr.on("data", (chunk) => {
  engineLog += chunk.toString();
});
engine.on("error", (error) => {
  console.log(`\nCould not start the engine binary: ${error.message}`);
  console.log("Build it first: cargo build --manifest-path services/render-engine/Cargo.toml\n");
  process.exit(1);
});

const shutdown = () => {
  if (!engine.killed) engine.kill();
};
process.on("exit", shutdown);

// Wait for the IPC listener rather than sleeping a fixed time. GPU initialisation
// dominates startup and varies by machine.
let listening = false;
for (let attempt = 0; attempt < 300; attempt += 1) {
  if (engine.exitCode !== null) {
    console.log(`\nThe engine exited with code ${engine.exitCode}:\n${engineLog}\n`);
    process.exit(1);
  }
  if (/engine listening on local IPC/.test(engineLog)) {
    listening = true;
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
}
check("the engine reports that it is listening on local IPC", listening);
if (!listening) {
  console.log(engineLog.slice(-1500));
  process.exit(1);
}

const transport = new IpcEngineTransport({ path: endpoint });
const client = new EngineConnection({
  clientId: "ipc-e2e",
  clientName: "GrapiX IPC e2e",
  clientRole: "diagnostic",
  clientVersion: "0.2.0",
  transport,
  autoReconnect: false
});

let capabilities;
try {
  capabilities = await client.connect();
} catch (error) {
  check("a client connects over IPC", false, error.message);
  console.log(engineLog.slice(-1500));
  process.exit(1);
}

check(
  "a client connects and negotiates capabilities over IPC",
  typeof capabilities.engineId === "string" && capabilities.protocolVersion === 3,
  `${capabilities.engineName} (${capabilities.engineId})`
);
check(
  "the engine declares the ipc transport it is actually serving",
  capabilities.transports.includes("ipc"),
  capabilities.transports.join(", ")
);
check(
  "the GPU is reported over IPC as it is over WebSocket",
  capabilities.gpu.adapter.length > 0,
  `${capabilities.gpu.adapter} (${capabilities.gpu.backend})`
);

client.markReady("nothing to reconcile");

const scene = {
  id: "scene_ipc_e2e",
  name: "IPC scene",
  version: 1,
  revision: 1,
  canvas: { width: 1920, height: 1080, background: "#00000000" },
  dataContext: {},
  assets: [],
  materials: [],
  objects: [
    {
      id: "rect_1",
      name: "Band",
      type: "rect",
      x: 120,
      y: 800,
      width: 900,
      height: 160,
      zDepth: 0,
      zIndex: 0,
      layerId: "layer_1",
      visible: true,
      fill: "#0b3d91"
    }
  ],
  timeline: {
    fps: 50,
    durationFrames: 100,
    keyframes: [],
    frameRate: { numerator: 50, denominator: 1 }
  },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z"
};

const loaded = await client.request(
  "scene.load",
  { scene, prepare: true },
  { sceneId: scene.id, sceneRevision: 1 }
);
check(
  "a scene loads and prepares over IPC",
  loaded.type === "reply.scenePrepared",
  `state=${loaded.payload?.state} tiles=${loaded.payload?.preparedTileCount}`
);

// A large message over a stream socket is the case framing exists for: the reply carries
// a base64 JPEG, which will not fit in one read.
const preview = await client.request("preview.request", {
  channel: "preview",
  source: { type: "scaled-stage", maxWidth: 960, maxHeight: 540 },
  encoding: "jpeg",
  quality: 80
});
check(
  "a multi-kilobyte preview reply is reassembled correctly",
  preview.type === "reply.preview" && (preview.payload?.data?.length ?? 0) > 4096,
  `${preview.payload?.width}x${preview.payload?.height}, ${Math.round((preview.payload?.data?.length ?? 0) / 1024)}KB base64`
);

// Streamed frames arrive as addressed events, which proves event delivery works on this
// transport too, not just request/reply.
const frames = [];
client.on((event) => {
  if (event.type === "engine-event" && event.eventType === "event.previewFrame") {
    frames.push(event.message.payload);
  }
});

await client.request("preview.streamStart", {
  streamId: "ipc_stream",
  channel: "preview",
  source: { type: "scaled-stage", maxWidth: 320, maxHeight: 180 },
  encoding: "jpeg",
  targetFps: 8
});
await new Promise((resolve) => setTimeout(resolve, 1200));
check(
  "streamed frames arrive over IPC",
  frames.length >= 2,
  `${frames.length} frames in 1.2s at a target of 8 fps`
);
await client.request("preview.streamStop", { streamId: "ipc_stream" });

const patched = await client.request(
  "scene.applyPatch",
  {
    patch: {
      sceneId: scene.id,
      baseRevision: 1,
      revision: 2,
      timestampMs: 0,
      operations: [
        { type: "object.transform", objectId: "rect_1", transform: { x: 240.75 } }
      ]
    }
  },
  { sceneId: scene.id, sceneRevision: 1 }
);
check(
  "a patch applies over IPC exactly as over WebSocket",
  patched.type === "reply.ack" && patched.payload?.sceneRevision === 2,
  `revision=${patched.payload?.sceneRevision}`
);

const status = await client.request("engine.getStatus", {});
check(
  "status is readable over IPC",
  status.payload?.scenes?.[0]?.sceneId === scene.id,
  `clients=${status.payload?.network?.connectedClients}`
);

// The engine keeps serving after a client leaves: Program state lives in the engine.
client.disconnect("e2e finished");
await new Promise((resolve) => setTimeout(resolve, 300));

const second = new EngineConnection({
  clientId: "ipc-e2e-2",
  clientName: "GrapiX IPC e2e (second)",
  clientRole: "diagnostic",
  clientVersion: "0.2.0",
  transport: new IpcEngineTransport({ path: endpoint }),
  autoReconnect: false
});
let secondConnected = false;
try {
  await second.connect();
  secondConnected = true;
} catch (error) {
  check("a second client can connect after the first disconnects", false, error.message);
}
if (secondConnected) {
  // On Windows each named-pipe instance serves one client, so getting this wrong makes
  // the endpoint work exactly once.
  check("a second client can connect after the first disconnects", true);

  const retained = await second.request("engine.getStatus", {});
  check(
    "the scene the first client loaded is still there",
    retained.payload?.scenes?.[0]?.sceneId === scene.id,
    `revision=${retained.payload?.scenes?.[0]?.revision}`
  );
  second.disconnect("e2e finished");
}

engine.kill();
await once(engine, "exit").catch(() => {});

console.log(`\n${pass.length} passed, ${fail.length} failed\n`);
if (fail.length > 0) {
  console.log("Failed:");
  for (const label of fail) console.log(`  - ${label}`);
  console.log(`\nEngine log tail:\n${engineLog.slice(-1200)}`);
}
process.exit(fail.length === 0 ? 0 : 1);
