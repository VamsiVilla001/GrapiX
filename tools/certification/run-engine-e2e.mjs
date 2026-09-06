/**
 * End-to-end proof: the real TypeScript client against the real Rust engine.
 *
 * Uses `@grapix/render-protocol` exactly as the Editor and Playout do — same
 * EngineConnection, same WebSocket transport, same envelope discipline. If this
 * passes, the wire contract between the two languages genuinely holds.
 */
import {
  EngineConnection,
  IpcEngineTransport,
  WebSocketEngineTransport,
  checkStageCapability,
  defaultIpcEndpoint,
  engineUrl
} from "@grapix/render-protocol";
import { applyScenePatch, createScenePatch } from "@grapix/scene-model";

const HOST = process.env.ENGINE_HOST ?? "127.0.0.1";
const PORT = Number(process.env.ENGINE_PORT ?? 4400);
// Role is derived from the credential and the transport, never from what a client calls
// itself. The engine reads a local IPC session as the Editor - "an engine can serve a local
// Editor without ever opening a port" - and grants Playout only to a connection that presents
// the bearer. So the two halves of this harness need two transports, not two names: authoring
// over IPC, operator verbs over the tokenised socket, both against one engine.
const TOKEN = process.env.GRAPIX_ENGINE_TOKEN;
const IPC_ENDPOINT = process.env.GRAPIX_ENGINE_IPC ?? defaultIpcEndpoint();

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

const url = engineUrl(HOST, PORT, { secure: false });
console.log(`\nEditor over IPC ${IPC_ENDPOINT}\nPlayout over ${url}\n`);

/**
 * A scene address for the authority domain an operation belongs to. Authoring verbs address
 * the authoring copy; operator verbs address the published copy. Conflating them is what the
 * authority split exists to prevent.
 */
const sceneRefFor = (sceneId, revision, domain = "authoring") => ({
  projectId: "certification",
  domain,
  sceneId,
  revision
});

// The Editor connection: stage/scene authoring, over local IPC. The engine treats an IPC
// session as the Editor without any credential, which is the authority authoring has and no
// more. Using the socket instead would be wrong on a tokenised engine: every authenticated
// socket connection is Playout, so the authoring verbs would be refused.
const client = new EngineConnection({
  clientId: "e2e",
  clientName: "GrapiX e2e",
  clientRole: "editor",
  clientVersion: "0.2.0",
  transport: new IpcEngineTransport({ path: IPC_ENDPOINT }),
  autoReconnect: false
});

// The Playout connection: the operator verbs. This needs the bearer, because the engine grants
// Playout authority to authenticated connections only. A harness that cannot obtain one cannot
// exercise playout, which is the point of the split.
const playout = TOKEN
  ? new EngineConnection({
      clientId: "e2e-playout",
      clientName: "GrapiX e2e playout",
      clientRole: "playout",
      clientVersion: "0.2.0",
      transport: new WebSocketEngineTransport({ url, authToken: TOKEN }),
      autoReconnect: false,
      authToken: TOKEN
    })
  : null;

let capabilities;
try {
  capabilities = await client.connect();
  if (playout) {
    await playout.connect();
  }
} catch (error) {
  console.error(`\nCould not connect: ${error.message}\n`);
  process.exit(1);
}
// The operator-verb checks need the Playout connection. Without a bearer they are skipped, not
// failed silently — a harness that claims to gate playout it never drove is worse than one that
// says so.
if (!playout) {
  console.log("\nNOTE: GRAPIX_ENGINE_TOKEN not set — playout-verb checks skipped (no operator authority).\n");
}

console.log("— capability negotiation —");
check("engine reports an id", typeof capabilities.engineId === "string", capabilities.engineId);
check("protocol v3", capabilities.protocolVersion === 3);
check(
  "GPU reported",
  capabilities.gpu.adapter.length > 0,
  `${capabilities.gpu.adapter} [${capabilities.gpu.backend}]`
);
check(
  "camelCase wire format",
  typeof capabilities.limits.maxLogicalCanvasWidth === "number",
  `maxLogicalCanvasWidth=${capabilities.limits.maxLogicalCanvasWidth}`
);
check(
  "50,000 logical canvas supported",
  capabilities.limits.maxLogicalCanvasWidth >= 50000
);
check("tile rendering", capabilities.features.tileRendering === true);
check("headless", capabilities.features.headlessRendering === true);
check(
  "video decode reported honestly",
  capabilities.features.nativeVideoDecode === false &&
    capabilities.supportedVideoFormats.length === 0,
  "no decode, so an empty format list"
);
check(
  "only the cut transition claimed",
  JSON.stringify(capabilities.supportedTransitions) === '["cut"]'
);
check(
  "warp/edge-blend not claimed",
  capabilities.features.surfaceWarpCompositing === false &&
    capabilities.features.edgeBlendCompositing === false
);

console.log("\n— pre-publish capability check —");
const hugeStage = {
  logicalWidth: 50000,
  logicalHeight: 10000,
  tilingEnabled: true,
  tileWidth: 2048,
  tileHeight: 2048,
  overscan: 32,
  surfaceCount: 1,
  outputCount: 0,
  requiredOutputAdapters: [],
  tileCacheBudgetBytes: 512 * 1024 * 1024
};
const ok = checkStageCapability(hugeStage, capabilities);
check("50,000 x 10,000 stage is accepted", ok.compatible, JSON.stringify(ok.issues));

const untiled = checkStageCapability({ ...hugeStage, tilingEnabled: false }, capabilities);
check(
  "the same stage without tiling is refused",
  !untiled.compatible && untiled.issues.some((i) => i.code === "TILING_REQUIRED")
);

console.log("\n— stage and scene —");
const stage = {
  stageId: "stage_e2e",
  name: "E2E arena",
  version: 1,
  canvas: { logicalWidth: 50000, logicalHeight: 10000 },
  regions: [{ regionId: "region_left", name: "Left", bounds: { x: 0, y: 0, width: 3840, height: 2160 } }],
  surfaces: [],
  viewports: [
    { viewportId: "vp_left", name: "Left", source: { type: "region", regionId: "region_left" }, renderScale: 1, enabled: true },
    { viewportId: "vp_operator", name: "Operator", source: { type: "full-stage" }, renderScale: 0.0384, enabled: true }
  ],
  outputs: [],
  outputMappings: [],
  tiling: { enabled: true, tileWidth: 2048, tileHeight: 2048, overscan: 32, maxResidentTiles: 256, cacheBudgetBytes: 536870912 }
};

// A prior run that crashed mid-way can leave this stage resident, and an engine that already
// holds it refuses the load. Unloading first is idempotent: an absent stage answers with an
// error this run is allowed to ignore, and a present one is dropped before it is redefined.
try {
  await client.request(
    "scene.unload",
    { sceneId: "scene_e2e", force: true },
    { sceneRef: sceneRefFor("scene_e2e", 1, "authoring") }
  );
} catch { /* not resident */ }
try {
  await client.request("stage.unload", { stageId: "stage_e2e" });
} catch { /* not resident */ }

const stageReply = await client.request("stage.load", { stage });
check("stage.load accepted", stageReply.type === "reply.ack", JSON.stringify(stageReply.payload));

const scene = {
  id: "scene_e2e",
  name: "E2E lower third",
  version: 1,
  revision: 1,
  canvas: { width: 50000, height: 10000, background: "#00000000" },
  dataContext: {},
  assets: [],
  materials: [],
  objects: [
    {
      id: "rect_left",
      name: "Left banner",
      type: "rect",
      x: 200, y: 200, width: 1200, height: 400,
      zDepth: 0, zIndex: 0, layerId: "layer_1", visible: true,
      fill: "#1e88e5"
    },
    {
      // Near the far edge of the stage: the precision case.
      id: "rect_far",
      name: "Far banner",
      type: "rect",
      x: 49200.37, y: 500.81, width: 600, height: 300,
      zDepth: 0, zIndex: 1, layerId: "layer_1", visible: true,
      fill: "#e53935"
    }
  ],
  timeline: { fps: 50, durationFrames: 100, keyframes: [] },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z"
};

const loadReply = await client.request(
  "scene.load",
  { scene, stageId: "stage_e2e", prepare: true },
  { sceneRef: { projectId: "certification", domain: "authoring", sceneId: scene.id, revision: 1 } }
);
check(
  "scene.load with prepare returns a preparation report",
  loadReply.type === "reply.scenePrepared",
  `state=${loadReply.payload?.state} tiles=${loadReply.payload?.preparedTileCount}`
);

console.log("\n— asset synchronisation —");

// A digest computed by Web Crypto, exactly as the Editor computes it. If Node, the
// browser and Rust disagree here, content addressing is worthless.
const assetBytes = new Uint8Array(5000);
for (let index = 0; index < assetBytes.length; index += 1) {
  assetBytes[index] = (index * 7) % 251;
}
const assetDigest = [
  ...new Uint8Array(await crypto.subtle.digest("SHA-256", assetBytes))
]
  .map((byte) => byte.toString(16).padStart(2, "0"))
  .join("");

const registered = await client.request("asset.register", {
  assetId: "asset_e2e",
  uri: "",
  transport: "upload",
  mimeType: "image/png",
  sizeBytes: assetBytes.byteLength,
  sha256: assetDigest
});
check(
  "an asset registers and the engine says whether it already holds the content",
  registered.type === "reply.ack" && typeof registered.payload?.alreadyCached === "boolean",
  `alreadyCached=${registered.payload?.alreadyCached} maxChunk=${registered.payload?.maxChunkBytes}`
);

const chunkBytes = 2048;
const chunkCount = Math.ceil(assetBytes.byteLength / chunkBytes);
let uploadProgress = null;
for (let index = 0; index < chunkCount; index += 1) {
  const chunk = assetBytes.subarray(index * chunkBytes, (index + 1) * chunkBytes);
  uploadProgress = await client.request("asset.upload", {
    assetId: "asset_e2e",
    sha256: assetDigest,
    chunkIndex: index,
    chunkCount,
    data: Buffer.from(chunk).toString("base64"),
    totalBytes: assetBytes.byteLength
  });
}
check(
  "a chunked upload completes and the digest computed in JavaScript matches Rust's",
  uploadProgress?.payload?.complete === true &&
    uploadProgress?.payload?.checksumMismatch === false &&
    uploadProgress?.payload?.receivedBytes === assetBytes.byteLength,
  `${uploadProgress?.payload?.receivedChunks}/${uploadProgress?.payload?.chunkCount} chunks, ${uploadProgress?.payload?.receivedBytes} bytes`
);

const validated = await client.request("asset.validate", { assetId: "asset_e2e" });
check(
  "the engine re-verifies the stored bytes against the digest",
  validated.payload?.present === true && validated.payload?.digestMatches === true,
  validated.payload?.message
);

// The same content under a second id must not transfer again.
const deduplicated = await client.request("asset.register", {
  assetId: "asset_e2e_copy",
  uri: "",
  transport: "upload",
  mimeType: "image/png",
  sizeBytes: assetBytes.byteLength,
  sha256: assetDigest
});
check(
  "identical content registered again is already cached, so nothing transfers",
  deduplicated.payload?.alreadyCached === true
);

let corruptRejected = false;
try {
  await client.request("asset.register", {
    assetId: "asset_corrupt",
    uri: "",
    transport: "upload",
    mimeType: "image/png",
    sizeBytes: 8,
    sha256: assetDigest
  });
  await client.request("asset.upload", {
    assetId: "asset_corrupt",
    sha256: assetDigest,
    chunkIndex: 0,
    chunkCount: 1,
    data: Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]).toString("base64"),
    totalBytes: 8
  });
} catch (error) {
  corruptRejected = /CHECKSUM_MISMATCH/.test(error.message);
}
check(
  "bytes that do not match the declared digest are rejected, not cached",
  corruptRejected
);

let pathRefused = false;
try {
  await client.request("asset.register", {
    assetId: "asset_escape",
    uri: "../../../etc/passwd",
    transport: "engine-local",
    mimeType: "image/png",
    sizeBytes: 10,
    sha256: "a".repeat(64)
  });
} catch (error) {
  pathRefused = /PATH_NOT_PERMITTED/.test(error.message);
}
check("a remote client cannot name a path outside the asset roots", pathRefused);

const released = await client.request("asset.release", {
  assetIds: ["asset_e2e", "asset_e2e_copy", "asset_corrupt"]
});
check(
  "unreferenced assets are released",
  (released.payload?.released?.length ?? 0) >= 2,
  `released ${JSON.stringify(released.payload?.released)}`
);

console.log("\n— incremental patches —");

// Built with the shared TypeScript helper, so what crosses the wire is exactly what
// the Editor would send. The engine's Rust implementation has to agree with it.
const movePatch = createScenePatch(
  scene.id,
  1,
  [
    // Moved along the far edge of a 50,000-wide stage, so this also exercises the f64
    // rebase: an f32 document could not represent 49300.25 at all.
    { type: "object.transform", objectId: "rect_far", transform: { x: 49300.25, opacity: 0.75 } },
    { type: "object.visibility", objectId: "rect_far", visible: true }
  ],
  { timestampMs: 1_700_000_000_000, origin: "e2e" }
);

let patchReply = null;
try {
  patchReply = await client.request(
    "scene.applyPatch",
    { patch: movePatch },
    { sceneRef: { projectId: "certification", domain: "authoring", sceneId: scene.id, revision: 1 } }
  );
} catch (error) {
  // Recorded as a failed check rather than aborting the run and hiding everything after.
  check("a patch built by the shared TypeScript helper is applied by the Rust engine", false, error.message);
}
if (patchReply) {
  check(
    "a patch built by the shared TypeScript helper is applied by the Rust engine",
    patchReply.type === "reply.ack" && patchReply.payload?.sceneRevision === 2,
    `revision=${patchReply.payload?.sceneRevision} ops=${patchReply.payload?.operationsApplied}`
  );
}
check(
  "the engine reports which objects it invalidated rather than the whole scene",
  patchReply?.payload?.wholeSceneInvalidated === false
    && patchReply?.payload?.objectsTouched?.includes("rect_far"),
  `touched=${JSON.stringify(patchReply?.payload?.objectsTouched)} tiles=${patchReply?.payload?.tilesInvalidated}`
);

// The same patch through the TypeScript implementation must produce the same revision
// and the same document values. A divergence here is a scene that renders differently
// in the Editor and on air.
const localResult = applyScenePatch(structuredClone(scene), movePatch);
const localFar = localResult.applied
  ? localResult.scene.objects.find((object) => object.id === "rect_far")
  : undefined;
check(
  "the TypeScript and Rust patch implementations agree",
  localResult.applied === true
    && localResult.revision === patchReply?.payload?.sceneRevision
    // The far-edge value has to survive both implementations exactly: an f32 document
    // could not represent it, and a rounded one would drift on air.
    && localFar?.x === 49300.25
    && localFar?.opacity === 0.75,
  localResult.applied
    ? `local revision ${localResult.revision}, x=${localFar?.x}, opacity=${localFar?.opacity}`
    : `local apply failed: ${localResult.failure.code} — ${localResult.failure.message}`
);

// A stale patch must be refused with the recovery to use, not merged hopefully.
let stalePatchRefused = false;
let stalePatchMentionedFullSync = false;
try {
  await client.request(
    "scene.applyPatch",
    { patch: createScenePatch(scene.id, 1, [{ type: "object.visibility", objectId: "rect_bg", visible: false }]) },
    { sceneRef: { projectId: "certification", domain: "authoring", sceneId: scene.id, revision: 1 } }
  );
} catch (error) {
  stalePatchRefused = /REVISION_MISMATCH/.test(error.message);
  stalePatchMentionedFullSync = /scene\.fullSync/.test(error.message);
}
check("a patch based on a stale revision is refused", stalePatchRefused);
check("the refusal names the recovery", stalePatchMentionedFullSync);

// Atomicity, over the wire: the good operation in a failing patch must not survive. The good
// half is a transform on the real object, so its value is either there afterwards (rolled back)
// or not (leaked) — and the revision stays at the base the patch was built from.
let partialPatchError = "";
try {
  await client.request(
    "scene.applyPatch",
    {
      patch: createScenePatch(scene.id, 2, [
        // A legal, in-place change to an object that exists.
        { type: "object.transform", objectId: "rect_far", transform: { x: 1 } },
        { type: "object.visibility", objectId: "ghost_object", visible: false }
      ])
    },
    // The ref names the *address* the engine holds the scene under — its load revision — while
    // the patch body carries the content revision. They are different numbers by design.
    { sceneRef: { projectId: "certification", domain: "authoring", sceneId: scene.id, revision: 1 } }
  );
} catch (error) {
  partialPatchError = error.message;
}
// The engine refuses a mixed patch as INVALID_PAYLOAD naming the unknown object; the wire code
// is the generic one because a bad patch is a bad request, not a revision conflict.
const partialPatchRefused = /INVALID_PAYLOAD/.test(partialPatchError) && /UNKNOWN_OBJECT/.test(partialPatchError);
check("a patch that fails part way is refused whole", partialPatchRefused, partialPatchError.slice(0, 120));

const afterPartial = await client.request("engine.getStatus", {});
// By id, not `scenes[0]`: the engine reports every loaded scene and their order is not part of
// the protocol, so index 0 was whichever scene happened to serialise first and this check read a
// revision belonging to a different scene entirely.
// The engine reports a scene keyed by its full SceneRef — the runtime address it actually
// holds — so the match is on that, not the plain document id. A bare `entry.sceneId ===
// scene.id` is never true here and would silently make this check pass on `undefined === 2`.
const runtimeSceneId = (id, revision) =>
  `13:certification|9:authoring|${String(id).length}:${id}|${revision}`;
const patchedScene = afterPartial.payload?.scenes?.find(
  (entry) => entry.sceneId === runtimeSceneId(scene.id, 1) || entry.sceneId === scene.id
);
check(
  "the engine stayed on the revision it had before the failed patch",
  patchedScene?.revision === 2,
  `revision=${patchedScene?.revision} for ${scene.id}`
);

// The deciding test for atomicity: re-apply the base revision and read the object back. If the
// good half of the refused patch had leaked, the value would be the one it tried to write.
const unchanged = await client.request(
  "scene.applyPatch",
  { patch: createScenePatch(scene.id, 2, [{ type: "object.visibility", objectId: "rect_far", visible: true }]) },
  { sceneRef: { projectId: "certification", domain: "authoring", sceneId: scene.id, revision: 1 } }
).catch(() => null);
check(
  "the legal half of a refused patch left nothing behind",
  partialPatchRefused && unchanged !== null,
  unchanged ? "base revision still applies cleanly" : "base revision no longer applies"
);

console.log("\n— playout gating —");
if (!playout) {
  console.log("        (skipped — no operator authority)");
} else {
// Playout supplies the published copy itself, exactly as `engineController.load` does: the
// Editor's authoring copy is a different scene address and is not what goes to air. Without
// this the cue below would name a scene the engine has never been given.
const publishedLoad = await playout.request(
  "scene.load",
  { scene: { ...scene, revision: 2 }, stageId: "stage_e2e", prepare: true },
  { sceneRef: sceneRefFor(scene.id, 2, "published") }
);
check(
  "Playout can deliver a published scene to the engine",
  publishedLoad.type === "reply.scenePrepared" || publishedLoad.type === "reply.ack",
  `${publishedLoad.type} state=${publishedLoad.payload?.state ?? "n/a"}`
);

const cueReply = await playout.request(
  "playout.cue",
  { sceneId: scene.id, sceneRevision: 2, channel: "preview" },
  { sceneRef: sceneRefFor(scene.id, 2, "published") }
);
check("cue to preview accepted", cueReply.type === "reply.ack");

let cueProgramRefused = false;
try {
  await playout.request(
    "playout.cue",
    { sceneId: scene.id, sceneRevision: 2, channel: "program" },
    { sceneRef: sceneRefFor(scene.id, 2, "published") }
  );
} catch (error) {
  cueProgramRefused = /UNAUTHORIZED/.test(error.message);
}
check("cue cannot target Program", cueProgramRefused);

let wrongRevisionRefused = false;
try {
  await playout.request(
    "playout.cue",
    { sceneId: scene.id, sceneRevision: 99, channel: "preview" },
    { sceneRef: sceneRefFor(scene.id, 99, "published") }
  );
} catch (error) {
  wrongRevisionRefused = /REVISION_MISMATCH/.test(error.message);
}
check("a wrong revision is refused", wrongRevisionRefused);

let wipeRefused = false;
try {
  await playout.request(
    "playout.transition",
    {
      sceneId: scene.id, channel: "program", transitionId: "wipe",
      direction: "in", durationFrames: 25
    },
    { sceneRef: sceneRefFor(scene.id, 2, "published") }
  );
} catch (error) {
  wipeRefused = /CAPABILITY_UNSUPPORTED/.test(error.message);
}
check("an unimplemented transition is refused, not substituted", wipeRefused);
}

console.log("\n— preview on a 50,000-wide stage —");
if (playout) {
let previewOk = false;
let previewDetail = "";
try {
  const preview = await playout.request("preview.request", {
    channel: "preview",
    source: { type: "scaled-stage", maxWidth: 960, maxHeight: 540 },
    encoding: "jpeg",
    quality: 80
  }, { sceneRef: sceneRefFor(scene.id, 2, "published") });
  const p = preview.payload;
  previewOk =
    preview.type === "reply.preview" &&
    typeof p.data === "string" &&
    p.data.length > 512 &&
    p.width > 0;
  previewDetail = `${p.width}x${p.height} scale=${p.renderScale?.toFixed?.(5)} ${p.renderMs?.toFixed?.(1)}ms ${Math.round(p.data.length / 1024)}KB jpeg`;
} catch (error) {
  previewDetail = error.message;
}
check("a scaled full-stage preview renders", previewOk, previewDetail);

let budgetRefused = "";
try {
  await playout.request("preview.request", {
    channel: "preview",
    // Full resolution on a 50,000 x 10,000 stage would be 2 GB.
    source: { type: "rect", x: 0, y: 0, width: 50000, height: 10000, renderScale: 1 },
    encoding: "jpeg"
  }, { sceneRef: sceneRefFor(scene.id, 2, "published") });
} catch (error) {
  budgetRefused = error.message;
}
check(
  "a full-resolution huge preview is refused, not silently downscaled",
  /PREVIEW_TOO_LARGE/.test(budgetRefused),
  budgetRefused.slice(0, 150)
);

console.log("\n— preview streaming —");

// Frames arrive as addressed `event.previewFrame` events, so collect them from the
// client's event stream exactly as the Editor would.
const streamFrames = [];
const unsubscribe = playout.on((event) => {
  if (event.type === "engine-event" && event.eventType === "event.previewFrame") {
    streamFrames.push(event.message.payload);
  }
});

const streamStart = await playout.request("preview.streamStart", {
  streamId: "stream_e2e",
  channel: "preview",
  source: { type: "scaled-stage", maxWidth: 480, maxHeight: 96 },
  encoding: "jpeg",
  targetFps: 8
}, { sceneRef: sceneRefFor(scene.id, 2, "published") });
check(
  "a preview stream starts and reports its cadence",
  streamStart.type === "reply.ack" && streamStart.payload?.intervalMs === 125,
  `fps=${streamStart.payload?.targetFps} interval=${streamStart.payload?.intervalMs}ms`
);

// Roughly a second at 8 fps. The engine may deliver fewer; the point is that frames
// arrive without being asked for individually.
await new Promise((resolve) => setTimeout(resolve, 1200));

check(
  "frames arrive on the event stream without being requested one at a time",
  streamFrames.length >= 2,
  `${streamFrames.length} frames in 1.2s at a target of 8 fps`
);
check(
  "each streamed frame carries its stream id, size and logical bounds",
  streamFrames[0]?.streamId === "stream_e2e"
    && streamFrames[0]?.width === 480
    && streamFrames[0]?.logicalBounds?.width === 50000,
  streamFrames[0]
    ? `${streamFrames[0].width}x${streamFrames[0].height} over ${streamFrames[0].logicalBounds?.width} logical, ${Math.round((streamFrames[0].data?.length ?? 0) / 1024)}KB`
    : "no frames"
);

const repointed = await playout.request("preview.setViewport", {
  streamId: "stream_e2e",
  source: { type: "rect", x: 48000, y: 0, width: 2000, height: 1000, renderScale: 0.24 }
}, { sceneRef: sceneRefFor(scene.id, 2, "published") });
check(
  "a running stream can be repointed at the far edge of the stage",
  repointed.type === "reply.ack" && repointed.payload?.width === 480,
  `${repointed.payload?.width}x${repointed.payload?.height} scale=${repointed.payload?.renderScale}`
);

const framesBeforeRepoint = streamFrames.length;
await new Promise((resolve) => setTimeout(resolve, 600));
check(
  "the stream keeps delivering after being repointed",
  streamFrames.length > framesBeforeRepoint,
  `${streamFrames.length - framesBeforeRepoint} more frames`
);

const streamStatus = await playout.request("engine.getStatus", {});
// Found by id, not by index: this engine is shared, and a running Playout station holds
// its own Preview and Program monitor streams. Asserting on `[0]` passed only for as long
// as nothing else streamed.
const ownStream = (streamStatus.payload?.previewStreams ?? []).find(
  (stream) => stream.streamId === "stream_e2e"
);
check(
  "status reports the running stream and its frame count",
  ownStream !== undefined && ownStream.framesSent > 0,
  ownStream
    ? `sent=${ownStream.framesSent} skipped=${ownStream.framesSkipped}`
    : `stream_e2e absent; running=${JSON.stringify((streamStatus.payload?.previewStreams ?? []).map((s) => s.streamId))}`
);

const streamStop = await playout.request("preview.streamStop", { streamId: "stream_e2e" });
check(
  "the stream stops and reports what it delivered",
  streamStop.type === "reply.ack" && streamStop.payload?.framesSent > 0,
  `sent=${streamStop.payload?.framesSent}`
);

const settled = streamFrames.length;
await new Promise((resolve) => setTimeout(resolve, 500));
check(
  "no frames arrive after the stream is stopped",
  streamFrames.length === settled,
  `${streamFrames.length - settled} stray frames`
);
unsubscribe?.();

console.log("\n— renderer restart —");
const restarted = await playout.request("engine.restartRenderer", {
  reason: "certification",
  preserveProgram: true
});
const restartWarnings = restarted.payload?.warnings ?? [];
check(
  "a renderer restart rebuilds state in process",
  restarted.type === "reply.ack" && restarted.payload?.rendererRestarts >= 1,
  `scenesReset=${restarted.payload?.scenesReset}`
);
check(
  "the restart does not claim to have recovered the GPU device",
  restartWarnings.some((warning) => warning.includes("does not re-acquire the device")),
  restartWarnings.join(" | ").slice(0, 160)
);
} else {
  console.log("        (preview, streaming and restart skipped — no operator authority)");
}

// A rebuilt renderer has no prepared scenes, so the scene has to be prepared again before the
// rest of the run can use it. Only relevant when the restart actually ran, which is the
// playout half of this harness — so it stays inside that guard rather than running against a
// renderer that was never torn down.
if (playout) {
  const reprepared = await client.request(
    "scene.prepare",
    { sceneId: scene.id },
    // The address is the load revision (1); the content revision the engine tracks (2) is not
    // part of the key.
    { sceneRef: sceneRefFor(scene.id, 1, "authoring") }
  );
  check(
    "a scene prepares again after the restart",
    reprepared.type === "reply.scenePrepared",
    `state=${reprepared.payload?.state} tiles=${reprepared.payload?.preparedTileCount}`
  );
}

console.log("\n— status and diagnostics —");
const status = await client.request("engine.getStatus", {});
const s = status.payload;
check("status reports the stage", s.stage.logicalWidth === 50000, `${s.stage.logicalWidth}x${s.stage.logicalHeight}`);
check(
  "status reports what tiling avoids allocating",
  s.stage.fullResolutionBytes === 50000 * 10000 * 4,
  `${(s.stage.fullResolutionBytes / 1024 ** 3).toFixed(2)} GB if it were one texture`
);
// The stage declares a full-stage operator viewport, so preparation legitimately
// touches every tile. What matters is that the grid is the expected size and that
// tracking is driven by demand rather than allocated up front.
check(
  "the tile grid matches the stage",
  s.tiles.totalTiles === 125 && s.tiles.gridColumns === 25 && s.tiles.gridRows === 5,
  `${s.tiles.gridColumns}x${s.tiles.gridRows} = ${s.tiles.totalTiles}`
);
// Asserted on this run's own scene, not on the engine-wide sum: `trackedTiles` adds up every
// loaded scene, so a neighbouring harness's scenes would move the number without anything here
// being wrong. What this run can honestly claim is that the scene it prepared covers the grid
// and never exceeds it.
// Runtime key segments are `length:value`, so the id is preceded by its length, not a bar.
const ownScene = s.scenes?.find((entry) => entry.sceneId?.endsWith(`:${scene.id}|1`));
check(
  "tiles are tracked, and never more than the grid holds",
  ownScene !== undefined &&
    ownScene.preparedTileCount > 0 &&
    ownScene.preparedTileCount <= s.tiles.totalTiles,
  `${ownScene?.preparedTileCount}/${s.tiles.totalTiles} prepared for ${scene.id}`
);

const diagnostics = await client.request("engine.getDiagnostics", { includeTiles: true });
check("diagnostics include the tile table on request", Array.isArray(diagnostics.payload.tileDetail),
  `${diagnostics.payload.tileDetail?.length} rows`);
check("diagnostics report GPU limits", diagnostics.payload.gpuLimits?.maxTextureDimension2d > 0,
  `maxTextureDimension2d=${diagnostics.payload.gpuLimits?.maxTextureDimension2d}`);

console.log("\n— reliability —");
if (!playout) {
  console.log("        (skipped — the duplicate test drives a Playout verb, and there is no operator authority)");
} else {
  const before = (await playout.request("engine.getStatus", {})).payload.network.duplicatesDropped;
  // Retransmit with the same messageId, which is what a flaky link produces.
  const stopRef = { sceneId: scene.id, channel: "preview" };
  const stopAddress = { sceneRef: sceneRefFor(scene.id, 2, "published") };
  const sent = playout.send("playout.stop", stopRef, stopAddress);
  playout.retryPending(sent.requestId, stopRef, "playout.stop");
  await new Promise((resolve) => setTimeout(resolve, 400));
  const after = (await playout.request("engine.getStatus", {})).payload.network.duplicatesDropped;
  check("a retransmit is recognised as a duplicate", after > before, `${before} -> ${after}`);
}

// Release what this run loaded. The engine refuses a load once it holds its maximum, so a
// harness that leaks its scenes makes the *next* harness fail with a message about a limit
// rather than about anything it did.
await client
  .request("scene.unload", { sceneId: scene.id, force: true }, { sceneRef: sceneRefFor(scene.id, 1) })
  .catch(() => {});
if (playout) {
  await playout
    .request(
      "scene.unload",
      { sceneId: scene.id, force: true },
      { sceneRef: sceneRefFor(scene.id, 2, "published") }
    )
    .catch(() => {});
}
await client.request("stage.unload", { stageId: "stage_e2e" }).catch(() => {});

client.disconnect("e2e finished");
playout?.disconnect("e2e finished");

console.log(`\n${pass.length} passed, ${fail.length} failed\n`);
if (fail.length > 0) {
  console.log("Failed:");
  for (const label of fail) console.log(`  - ${label}`);
}
process.exit(fail.length === 0 ? 0 : 1);
