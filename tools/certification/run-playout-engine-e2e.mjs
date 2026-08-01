/**
 * Playout-through-HTTP end-to-end proof.
 *
 * Drives the real Playout control service over its HTTP API — publish a scene,
 * push it to the engine, prepare it, cue it, take it to Program, clear it. Every
 * step goes Playout → protocol v3 → Rust engine, so this exercises the whole chain
 * the way an operator UI does.
 *
 * Requires the engine and playout-control to be running:
 *   npm run dev:engine
 *   npm run dev:playout
 */
const PLAYOUT = process.env.PLAYOUT_URL ?? "http://127.0.0.1:4300";

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

async function call(method, path, body) {
  const response = await fetch(`${PLAYOUT}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  return { status: response.status, payload };
}

const SCENE_ID = "scene_playout_e2e";

function scene(revision) {
  return {
    id: SCENE_ID,
    name: "Playout e2e lower third",
    version: 1,
    revision,
    canvas: { width: 1920, height: 1080, background: "#00000000" },
    dataContext: { player: { name: "Alice" } },
    assets: [],
    materials: [],
    objects: [
      {
        id: "rect_bg",
        name: "Background",
        type: "rect",
        x: 120,
        y: 780,
        width: 900,
        height: 180,
        zDepth: 0,
        zIndex: 0,
        layerId: "layer_1",
        visible: true,
        fill: "#0b3d91"
      }
    ],
    timeline: { fps: 50, durationFrames: 100, keyframes: [] },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

console.log(`\nDriving Playout at ${PLAYOUT}\n`);

const health = await call("GET", "/api/playout/health");
if (health.status !== 200) {
  console.error("playout-control is not reachable; start it with: npm run dev:playout\n");
  process.exit(1);
}

console.log("— engine connection —");
let engine = (await call("GET", "/api/playout/engine")).payload;
if (!engine.connected) {
  engine = (await call("POST", "/api/playout/engine/connect")).payload ?? engine;
}
check("Playout holds the engine connection", engine.connected === true, engine.lastError ?? "");
check("engine identity negotiated", typeof engine.engineId === "string", engine.engineId);
check("GPU reported through Playout", Boolean(engine.gpu), engine.gpu ?? "");
check(
  "50,000 logical canvas reported",
  engine.maxLogicalCanvas?.width >= 50000,
  `${engine.maxLogicalCanvas?.width}x${engine.maxLogicalCanvas?.height}`
);
check("engine is take-ready", engine.takeReady === true, `state=${engine.state}`);

console.log("\n— publish —");
const published = await call("POST", "/api/playout/scenes", { scene: scene(1) });
check(
  "scene published to the Playout store",
  published.status === 201,
  JSON.stringify(published.payload).slice(0, 120)
);
const version = published.payload?.version;

console.log("\n— load and prepare on the engine —");
const loaded = await call("POST", "/api/playout/engine/scenes", {
  sceneId: SCENE_ID,
  version
});
check(
  "scene loaded and prepared on the engine",
  loaded.status === 200 && loaded.payload?.loaded === SCENE_ID,
  JSON.stringify(loaded.payload).slice(0, 160)
);

console.log("\n— operational commands —");
const revision = loaded.payload?.revision ?? 0;

const cued = await call("POST", "/api/playout/engine/command/cue", {
  sceneId: SCENE_ID,
  sceneRevision: revision,
  channel: "preview"
});
check("cue to Preview accepted", cued.status === 200, JSON.stringify(cued.payload).slice(0, 120));

console.log("\n\u2014 outputs \u2014");
const adapters = await call("GET", "/api/playout/engine/outputs");
check(
  "output adapters listed through Playout",
  adapters.status === 200 && Array.isArray(adapters.payload?.availableAdapters),
  (adapters.payload?.availableAdapters ?? []).map((a) => a.adapterId).join(", ")
);

const virtualAdapter = (adapters.payload?.availableAdapters ?? []).find(
  (adapter) => adapter.adapterId === "virtual"
);
check(
  "the virtual adapter is available and reports itself as not live",
  virtualAdapter?.available === true && virtualAdapter?.live === false,
  JSON.stringify(virtualAdapter ?? null)
);

const ndiAdapter = (adapters.payload?.availableAdapters ?? []).find(
  (adapter) => adapter.adapterId === "ndi"
);
check(
  "NDI is declared live and says why it is unavailable rather than pretending",
  ndiAdapter?.live === true &&
    (ndiAdapter?.available === false ? typeof ndiAdapter.unavailableReason === "string" : true),
  ndiAdapter?.unavailableReason ?? "available"
);

const refusedAdapter = await call("POST", "/api/playout/engine/outputs", {
  outputId: "out_sdi",
  adapterId: "decklink",
  width: 1920,
  height: 1080
});
check(
  "an adapter the deployment did not enable is refused",
  refusedAdapter.status === 409 && /not enabled/.test(JSON.stringify(refusedAdapter.payload)),
  JSON.stringify(refusedAdapter.payload).slice(0, 140)
);

const noSize = await call("POST", "/api/playout/engine/outputs", {
  outputId: "out_virtual",
  adapterId: "virtual"
});
check(
  "an output without dimensions is refused rather than silently defaulted",
  noSize.status === 400,
  JSON.stringify(noSize.payload).slice(0, 120)
);

const configuredOutput = await call("POST", "/api/playout/engine/outputs", {
  outputId: "out_virtual",
  adapterId: "virtual",
  width: 1920,
  height: 1080,
  frameRate: { numerator: 50, denominator: 1 },
  colorSpace: "rec709"
});
check(
  "a virtual output is configured",
  configuredOutput.status === 200 &&
    configuredOutput.payload?.outputs?.some((output) => output.outputId === "out_virtual"),
  JSON.stringify(configuredOutput.payload?.warnings ?? []).slice(0, 160)
);
check(
  "configuring an output does not start it",
  configuredOutput.payload?.outputs?.find((output) => output.outputId === "out_virtual")
    ?.state === "configured",
  JSON.stringify(configuredOutput.payload ?? null).slice(0, 200)
);

const taken = await call("POST", "/api/playout/engine/command/take", {
  sceneId: SCENE_ID,
  sceneRevision: revision
});
check(
  "take to Program accepted",
  taken.status === 200,
  `state=${taken.payload?.state} overridden=${taken.payload?.overridden}`
);
check("engine reports on-air", taken.payload?.state === "on-air", taken.payload?.state);

const runningOutputs = await call("GET", "/api/playout/engine/outputs");
const virtualOutput = (runningOutputs.payload?.outputs ?? []).find(
  (output) => output.outputId === "out_virtual"
);
check(
  "taking the scene online started the configured output",
  virtualOutput?.state === "running",
  JSON.stringify(virtualOutput ?? null).slice(0, 200)
);
check(
  "the virtual output reports that it is not live",
  virtualOutput?.live === false,
  `live=${virtualOutput?.live}`
);

// The Program clock renders on air at the configured rate, so frames must actually be
// arriving. This is the difference between "on air" as a state and as a fact.
await new Promise((resolve) => setTimeout(resolve, 900));
const afterFrames = await call("GET", "/api/playout/engine/outputs");
const framed = (afterFrames.payload?.outputs ?? []).find(
  (output) => output.outputId === "out_virtual"
);
check(
  "the Program clock is feeding the output real frames",
  (framed?.framesSent ?? 0) > 0,
  `sent=${framed?.framesSent} dropped=${framed?.framesDropped} error=${framed?.lastError ?? "none"}`
);

const engineStatusOnAir = await call("GET", "/api/playout/engine/status");
const frameStats = engineStatusOnAir.payload?.frame ?? {};
check(
  "engine status counts the rendered Program frames",
  (frameStats.framesRendered ?? 0) > 0,
  `rendered=${frameStats.framesRendered} dropped=${frameStats.framesDropped} avg=${frameStats.averageRenderMs}ms budget=${frameStats.frameBudgetMs}ms`
);
check(
  "a Program frame renders inside its frame budget",
  (frameStats.averageRenderMs ?? Infinity) <= (frameStats.frameBudgetMs ?? 20),
  `average ${frameStats.averageRenderMs}ms against a ${frameStats.frameBudgetMs}ms budget at ` +
    `${frameStats.frameRateNumerator}/${frameStats.frameRateDenominator}`
);

const updated = await call("POST", "/api/playout/engine/command/update", {
  sceneId: SCENE_ID,
  sceneRevision: revision,
  data: { "player.name": "Bianca" }
});
check("data update accepted", updated.status === 200);

const wiped = await call("POST", "/api/playout/engine/command/transition", {
  sceneId: SCENE_ID,
  transitionId: "wipe",
  durationFrames: 25
});
check(
  "an unimplemented transition is refused through Playout too",
  wiped.status === 503 && /CAPABILITY_UNSUPPORTED/.test(JSON.stringify(wiped.payload)),
  JSON.stringify(wiped.payload).slice(0, 140)
);

const cleared = await call("POST", "/api/playout/engine/command/clear", { channel: "program" });
check("clear Program accepted", cleared.status === 200, `state=${cleared.payload?.state}`);
check("engine returns to ready", cleared.payload?.state === "ready", cleared.payload?.state);

const afterClear = await call("GET", "/api/playout/engine/outputs");
const stoppedOutput = (afterClear.payload?.outputs ?? []).find(
  (output) => output.outputId === "out_virtual"
);
check(
  "clearing Program stopped the output instead of leaving it transmitting",
  stoppedOutput?.state === "configured",
  `state=${stoppedOutput?.state}`
);

const removedOutput = await call("POST", "/api/playout/engine/outputs/out_virtual/remove");
check(
  "a stopped output is removed",
  removedOutput.status === 200 &&
    !(removedOutput.payload?.outputs ?? []).some((output) => output.outputId === "out_virtual"),
  JSON.stringify(removedOutput.payload?.outputs ?? []).slice(0, 120)
);

console.log("\n— unknown command —");
const bogus = await call("POST", "/api/playout/engine/command/explode", { sceneId: SCENE_ID });
check(
  "an unknown command is refused and lists what is supported",
  bogus.status === 400 && Array.isArray(bogus.payload?.supported),
  (bogus.payload?.supported ?? []).join(", ")
);

console.log("\n— engine status and diagnostics via Playout —");
const status = await call("GET", "/api/playout/engine/status");
check(
  "engine status readable through Playout",
  status.status === 200 && status.payload?.engineId === engine.engineId,
  `scenes=${status.payload?.scenes?.length}`
);

const diagnostics = await call("GET", "/api/playout/engine/diagnostics?tiles=true");
check(
  "diagnostics readable through Playout",
  diagnostics.status === 200 && Array.isArray(diagnostics.payload?.tileDetail),
  `${diagnostics.payload?.tileDetail?.length} tile rows`
);

const unloaded = await call("POST", "/api/playout/engine/command/unload", {
  sceneId: SCENE_ID
});
check("scene unloaded", unloaded.status === 200);

// And out of the library, so the operator's Scene Manager keeps matching the Editor's scenes.
// Every run used to leave another "Playout e2e lower third" behind; seven of them had piled up.
const purged = await call("DELETE", `/api/playout/scenes/${SCENE_ID}`);
check(
  "the proof scene is removed from the library",
  purged.status === 200 || purged.status === 404,
  `${purged.status} ${JSON.stringify(purged.payload).slice(0, 120)}`
);

console.log(`\n${pass.length} passed, ${fail.length} failed\n`);
if (fail.length > 0) {
  console.log("Failed:");
  for (const label of fail) console.log(`  - ${label}`);
}
process.exit(fail.length === 0 ? 0 : 1);
