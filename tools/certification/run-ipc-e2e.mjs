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
// A tiled stage, so the diagnostic table below is genuinely large. On the implicit 1920x1080
// stage the whole scene is one tile and the reply fits in a single read - which would let a
// broken length prefix pass the reassembly check.
const ipcStage = {
  stageId: "stage_ipc_e2e",
  name: "IPC arena",
  version: 1,
  canvas: { logicalWidth: 20000, logicalHeight: 4000 },
  regions: [],
  surfaces: [],
  viewports: [
    { viewportId: "vp_all", name: "All", source: { type: "full-stage" }, renderScale: 0.05, enabled: true }
  ],
  outputs: [],
  outputMappings: [],
  tiling: { enabled: true, tileWidth: 2048, tileHeight: 2048, overscan: 32, maxResidentTiles: 256, cacheBudgetBytes: 536870912 }
};
await client.request("stage.load", { stage: ipcStage });

const loaded = await client.request(
  "scene.load",
  { scene, stageId: ipcStage.stageId, prepare: true },
  { sceneRef: { projectId: "certification", domain: "authoring", sceneId: scene.id, revision: 1 } }
);
check(
  "a scene loads and prepares over IPC",
  loaded.type === "reply.scenePrepared",
  `state=${loaded.payload?.state} tiles=${loaded.payload?.preparedTileCount}`
);

// A large message over a stream socket is the case framing exists for: a reply far bigger than
// one read has to be reassembled from the length prefix, not from luck.
//
// The payload is the per-tile diagnostic table rather than a preview image. Preview is an
// operator verb, and IPC is the Editor's transport - the engine grants an IPC session Editor
// authority and nothing more, so asking for a preview here would prove only that the engine
// refuses it. The tile table is Editor-visible, and large for the same reason.
const bulky = await client.request("engine.getDiagnostics", { includeTiles: true });
const bulkyBytes = JSON.stringify(bulky.payload ?? {}).length;
check(
  "a multi-kilobyte reply is reassembled correctly",
  bulky.type === "reply.diagnostics" && bulkyBytes > 4096,
  `${bulky.payload?.tileDetail?.length ?? 0} tile rows, ${Math.round(bulkyBytes / 1024)}KB of JSON`
);

// Events arrive unbidden, which proves delivery works on this transport too, not just
// request/reply. Scene lifecycle is the Editor-authority event: preparing a scene emits it,
// and it reaches the pipe without anyone having asked for a reply.
const lifecycle = [];
client.on((event) => {
  if (event.type === "engine-event" && event.eventType === "event.sceneLifecycle") {
    lifecycle.push(event.message.payload);
  }
});

await client.request(
  "scene.prepare",
  { sceneId: scene.id },
  { sceneRef: { projectId: "certification", domain: "authoring", sceneId: scene.id, revision: 1 } }
);
await new Promise((resolve) => setTimeout(resolve, 300));
check(
  "unrequested events arrive over IPC",
  lifecycle.length >= 1,
  `${lifecycle.length} scene-lifecycle events`
);

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
  { sceneRef: { projectId: "certification", domain: "authoring", sceneId: scene.id, revision: 1 } }
);
check(
  "a patch applies over IPC exactly as over WebSocket",
  patched.type === "reply.ack" && patched.payload?.sceneRevision === 2,
  `revision=${patched.payload?.sceneRevision}`
);

const status = await client.request("engine.getStatus", {});
// The engine reports a scene under its runtime SceneRef key, whose segments are
// `length:value` - a plain-id comparison is never true and would assert nothing.
const holdsScene = (payload) =>
  (payload?.scenes ?? []).some((entry) => entry.sceneId?.includes(`:${scene.id}|`));
check(
  "status is readable over IPC",
  holdsScene(status.payload),
  `clients=${status.payload?.network?.connectedClients}, scenes=${status.payload?.scenes?.length ?? 0}`
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
    holdsScene(retained.payload),
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
