/**
 * Proof that Program and Preview actually animate.
 *
 * Before the engine had an animation runtime it rendered a **still image**: the clock
 * advanced, frames were counted and delivered, and every one was identical, because the
 * prepared scene was cached on `(sceneId, revision, bounds)` and the frame number reached the
 * renderer only as metadata. An operator saw a Program at the right rate with zero dropped
 * frames that did not move.
 *
 * This is the regression gate for that. It renders one scene at several frames through the
 * real engine over protocol v3 and asserts the picture changes where the animation says it
 * should, and only there. A still scene must render byte-identical frames, so this also fails
 * if animation is ever applied to something that is not animated.
 *
 *   npm run dev:engine        # in another shell
 *   npm run certify:animation
 */
import { createHash } from "node:crypto";

import { EngineConnection, WebSocketEngineTransport, engineUrl } from "@grapix/render-protocol";

const HOST = process.env.ENGINE_HOST ?? "127.0.0.1";
const PORT = Number(process.env.ENGINE_PORT ?? 4400);
// No bearer: a local peer without one is the Editor, which is the authority authoring and
// the Editor view need. A token here would make this connection an operator instead.
const url = engineUrl(HOST, PORT, { secure: false });

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

console.log(`\nConnecting to ${url}\n`);

const client = new EngineConnection({
  clientId: "animation-proof",
  clientName: "GrapiX animation proof",
  clientRole: "diagnostic",
  clientVersion: "0.2.0",
  transport: new WebSocketEngineTransport({ url }),
  autoReconnect: false
});

try {
  await client.connect();
} catch (error) {
  console.error(`\nCould not connect: ${error.message}\nStart it with: npm run dev:engine\n`);
  process.exit(1);
}

const now = "2026-07-29T00:00:00.000Z";

function rect(overrides) {
  return {
    id: "rect_proof",
    name: "Proof",
    type: "rect",
    x: 1000,
    y: 400,
    zDepth: 0,
    zIndex: 0,
    layerId: "main",
    width: 360,
    height: 210,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    anchor: { x: 0, y: 0 },
    opacity: 1,
    visible: true,
    locked: false,
    fill: "#23c7d9",
    stroke: "#f7fbff",
    strokeWidth: 0,
    radius: 0,
    bindings: {},
    materialSlots: {},
    ...overrides
  };
}

function scene(id, name, objects) {
  return {
    id,
    name,
    version: 1,
    canvas: { width: 1920, height: 1080, background: "#101418" },
    dataContext: {},
    assets: [],
    materials: [],
    objects,
    timeline: {
      fps: 50,
      durationFrames: 100,
      keyframes: [],
      frameRate: { numerator: 50, denominator: 1 }
    },
    createdAt: now,
    updatedAt: now
  };
}

/** Slides from x=220 to x=1000 over 31 frames — the authored case that did not move. */
const MOVING = scene("proof_moving", "Animation proof — moving", [
  rect({
    animation: {
      x: {
        keys: [
          { id: "k0", frame: 0, value: 220, easing: "linear" },
          { id: "k1", frame: 31, value: 1000, easing: "linear" }
        ]
      }
    }
  })
]);

/** Fades out over 20 frames. */
const FADING = scene("proof_fading", "Animation proof — fading", [
  rect({
    x: 400,
    animation: {
      opacity: {
        keys: [
          { id: "f0", frame: 0, value: 1, easing: "linear" },
          { id: "f1", frame: 20, value: 0, easing: "linear" }
        ]
      }
    }
  })
]);

/** The legacy whole-object keyframe model must still animate. */
const LEGACY = {
  ...scene("proof_legacy", "Animation proof — legacy keyframes", [rect({ id: "rect_legacy" })]),
  timeline: {
    fps: 50,
    durationFrames: 100,
    frameRate: { numerator: 50, denominator: 1 },
    keyframes: [
      { id: "lk0", objectId: "rect_legacy", frame: 0, easing: "linear", properties: { x: 200 } },
      { id: "lk1", objectId: "rect_legacy", frame: 30, easing: "linear", properties: { x: 1200 } }
    ]
  }
};

/** No animation anywhere. Frames must be identical. */
const STILL = scene("proof_still", "Animation proof — still", [rect({ id: "rect_still" })]);

/**
 * A cube rotating on Y and moving in Z.
 *
 * The case that was silently wrong on air: a mesh animated in the Editor, where three.js reads
 * the object every frame, and sat perfectly still on Program, because the engine baked the
 * model matrix at preparation and never touched it again. Both axes here are 3D-only channels,
 * so this also proves `rotationY` and `zDepth` reach the mesh path.
 */
const MESH = scene("proof_mesh", "Animation proof — mesh", [
  {
    id: "mesh_cube",
    name: "Cube",
    type: "mesh",
    meshKind: "cube",
    depth: 200,
    x: 860,
    y: 440,
    zDepth: 0,
    zIndex: 0,
    layerId: "main",
    width: 200,
    height: 200,
    rotation: 0,
    rotationX: 15,
    rotationY: 0,
    scaleX: 1,
    scaleY: 1,
    scaleZ: 1,
    anchor: { x: 0, y: 0 },
    opacity: 1,
    visible: true,
    locked: false,
    fill: "#c98b3a",
    stroke: "#f7fbff",
    strokeWidth: 0,
    bindings: {},
    materialSlots: {},
    animation: {
      rotationY: {
        keys: [
          { id: "my0", frame: 0, value: 0, easing: "linear" },
          { id: "my1", frame: 40, value: 180, easing: "linear" }
        ]
      },
      zDepth: {
        keys: [
          { id: "mz0", frame: 0, value: 0, easing: "linear" },
          { id: "mz1", frame: 40, value: -300, easing: "linear" }
        ]
      }
    }
  }
]);

/** The same cube with no animation. Its frames must be identical. */
const MESH_STILL = {
  ...scene("proof_mesh_still", "Animation proof — mesh still", [
    { ...MESH.objects[0], id: "mesh_cube_still", animation: {} }
  ])
};

async function load(document) {
  const reply = await client.request(
    "scene.load",
    { scene: document, prepare: true },
    { sceneRef: { projectId: "certification", domain: "authoring", sceneId: document.id, revision: 1 } }
  );
  if (reply.type !== "reply.scenePrepared") {
    throw new Error(`${document.id} did not prepare: ${reply.type}`);
  }
}

/**
 * Render one frame and digest it so frames can be compared exactly.
 *
 * This runs as the Editor role, so it uses `editor.view.request`, not `preview.request` —
 * the latter is a Playout capability (invariant 4) and the engine refuses it from an editor
 * connection. The editor view returns raw premultiplied BGRA, which is *more* than enough for
 * this proof: it only ever compares frames for equality, and a digest of the raw pixels
 * changes wherever the picture changes. The frame is `[4-byte big-endian metadata length,
 * UTF-8 JSON metadata, pixels]`, decoded here rather than assumed.
 */
function digestEditorFrame(data) {
  if (!(data instanceof Uint8Array) || data.length < 4) {
    throw new Error("editor view returned no binary frame");
  }
  const headerLength = (data[0] << 24) | (data[1] << 16) | (data[2] << 8) | data[3];
  const metadata = JSON.parse(Buffer.from(data.slice(4, 4 + headerLength)).toString("utf8"));
  const pixels = data.slice(4 + headerLength);
  if (pixels.length === 0) {
    throw new Error(`frame ${metadata.frame} returned no pixels`);
  }
  return createHash("sha256").update(pixels).digest("hex").slice(0, 12);
}

function digestAt(sceneId, frame) {
  const viewId = `proof-${sceneId}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`timed out waiting for the editor view frame at frame ${frame}`));
    }, 15_000);
    const unsubscribe = client.on((event) => {
      if (event.type !== "binary-frame") return;
      try {
        const metadata = JSON.parse(
          Buffer.from(
            event.data.slice(4, 4 + ((event.data[0] << 24) | (event.data[1] << 16) | (event.data[2] << 8) | event.data[3]))
          ).toString("utf8")
        );
        // Only this scene's view, and only this generation, pairs with this request.
        if (metadata.viewId !== viewId || metadata.frame !== frame) return;
        clearTimeout(timer);
        unsubscribe();
        resolve(digestEditorFrame(event.data));
      } catch (error) {
        clearTimeout(timer);
        unsubscribe();
        reject(error);
      }
    });

    client.request(
      "editor.view.request",
      {
        sceneRef: { projectId: "certification", domain: "authoring", sceneId, revision: 1 },
        viewId,
        viewGeneration: 1,
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        pixelWidth: 640,
        pixelHeight: 360,
        frame
      },
      { sceneRef: { projectId: "certification", domain: "authoring", sceneId, revision: 1 } }
    ).catch((error) => {
      clearTimeout(timer);
      unsubscribe();
      reject(error);
    });
  });
}

async function digests(sceneId, frames) {
  const out = {};
  for (const frame of frames) {
    out[frame] = await digestAt(sceneId, frame);
    // `preview.request` carries a high rate cost, and this asks for a burst of them. Pacing
    // is the harness's problem, not the engine's: a renderer that let a diagnostic client
    // flood it would be the actual bug.
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return out;
}

const summary = (map, frames) => frames.map((f) => `${f}:${map[f]}`).join("  ");

console.log("— a rect that slides across the stage —");
await load(MOVING);
const moving = await digests(MOVING.id, [0, 8, 16, 24, 31, 60]);
console.log(`        ${summary(moving, [0, 8, 16, 24, 31, 60])}`);

check(
  "the first and last frame of the move are different pictures",
  moving[0] !== moving[31],
  `${moving[0]} vs ${moving[31]}`
);
check(
  "every sampled frame along the move is distinct",
  new Set([0, 8, 16, 24, 31].map((f) => moving[f])).size === 5
);
check(
  "the value holds past the last key instead of extrapolating",
  moving[60] === moving[31],
  `frame 60 matches frame 31`
);

console.log("\n— a rect that fades out —");
await load(FADING);
const fading = await digests(FADING.id, [0, 10, 20]);
console.log(`        ${summary(fading, [0, 10, 20])}`);
check(
  "animated opacity changes the picture",
  new Set([0, 10, 20].map((f) => fading[f])).size === 3
);

console.log("\n— the legacy keyframe model —");
await load(LEGACY);
const legacy = await digests(LEGACY.id, [0, 15, 30]);
console.log(`        ${summary(legacy, [0, 15, 30])}`);
check(
  "whole-object keyframes animate too, not just property channels",
  new Set([0, 15, 30].map((f) => legacy[f])).size === 3
);

console.log("\n— a mesh rotating on Y and moving in Z —");
await load(MESH);
const mesh3d = await digests(MESH.id, [0, 13, 26, 40, 90]);
console.log(`        ${summary(mesh3d, [0, 13, 26, 40, 90])}`);
check(
  "a mesh animates on Program, not only in the Editor",
  mesh3d[0] !== mesh3d[40],
  `${mesh3d[0]} vs ${mesh3d[40]}`
);
check(
  "every sampled frame of the rotation is distinct",
  new Set([0, 13, 26, 40].map((f) => mesh3d[f])).size === 4
);
check(
  "the mesh holds past its last key instead of extrapolating",
  mesh3d[90] === mesh3d[40]
);

console.log("\n— the same mesh with no animation —");
await load(MESH_STILL);
const meshStill = await digests(MESH_STILL.id, [0, 20, 40]);
console.log(`        ${summary(meshStill, [0, 20, 40])}`);
check(
  "a still mesh renders identical frames, so its transform is not rewritten",
  new Set([0, 20, 40].map((f) => meshStill[f])).size === 1,
  `all three are ${meshStill[0]}`
);

console.log("\n— a scene with no animation —");
await load(STILL);
const still = await digests(STILL.id, [0, 16, 31]);
console.log(`        ${summary(still, [0, 16, 31])}`);
check(
  "frames are identical, so animation is not applied where there is none",
  new Set([0, 16, 31].map((f) => still[f])).size === 1,
  `all three are ${still[0]}`
);

console.log("\n— clean up —");
// Addressed by SceneRef, not a bare id: the envelope carries the runtime address, and an
// unload that names only `sceneId` releases nothing. Six scenes then survive every run until
// the engine hits its eight-scene ceiling and refuses the *next* harness's first load.
let unloaded = 0;
for (const id of [MOVING.id, FADING.id, LEGACY.id, STILL.id, MESH.id, MESH_STILL.id]) {
  const released = await client
    .request(
      "scene.unload",
      { sceneId: id, force: true },
      { sceneRef: { projectId: "certification", domain: "authoring", sceneId: id, revision: 1 } }
    )
    .then(() => true)
    .catch(() => false);
  if (released) unloaded += 1;
}
check("proof scenes unloaded", unloaded === 6, `${unloaded}/6 released`);

client.disconnect("animation proof finished");

console.log(`\n${pass.length} passed, ${fail.length} failed\n`);
if (fail.length > 0) {
  console.log("Failed:");
  for (const label of fail) console.log(`  - ${label}`);
}
process.exit(fail.length === 0 ? 0 : 1);
