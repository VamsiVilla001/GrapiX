/**
 * Publish → scene manager → rundown → air.
 *
 * The path a designer and an operator actually walk:
 *
 *   1. the Editor publishes a scene to Playout, with a thumbnail
 *   2. it appears in the scene manager with the metadata an operator needs
 *   3. it is placed in a rundown (what the UI does by drag; here by the same API)
 *   4. taking that rundown item online drives the standalone engine
 *   5. the engine's outputs start, and the virtual output receives real frames
 *
 * Step 4 is the one worth stating plainly: a Take from the rundown must reach the
 * engine that owns the outputs, not only the legacy render daemon.
 *
 * Requires the engine and playout-control:
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

const SCENE_ID = "scene_publish_rundown";

// A 2x2 PNG. Stands in for what the Editor captures from its viewport.
const THUMBNAIL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFUlEQVR4nGP4z8DAwMDAwMDAwMAAAA4AAwHwYm0AAAAAAElFTkSuQmCC";

function scene() {
  return {
    id: SCENE_ID,
    name: "Publish and rundown proof",
    version: 1,
    revision: 4,
    canvas: { width: 1920, height: 1080, background: "#00000000" },
    dataContext: { headline: "GrapiX" },
    assets: [],
    materials: [],
    objects: [
      {
        id: "rect_bg",
        name: "Band",
        type: "rect",
        x: 100,
        y: 800,
        width: 1000,
        height: 160,
        zDepth: 0,
        zIndex: 0,
        layerId: "layer_1",
        visible: true,
        fill: "#123f7a"
      }
    ],
    timeline: {
      fps: 50,
      durationFrames: 150,
      keyframes: [],
      frameRate: { numerator: 50, denominator: 1 }
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-02-01T00:00:00.000Z"
  };
}

console.log(`\nDriving Playout at ${PLAYOUT}\n`);

const health = await call("GET", "/api/playout/health");
if (health.status !== 200) {
  console.log("playout-control is not running; start it with: npm run dev:playout\n");
  process.exit(1);
}

console.log("— publish from the Editor —");
const published = await call("POST", "/api/playout/scenes", {
  scene: scene(),
  options: {
    thumbnailDataUrl: THUMBNAIL,
    colorSpace: "rec709",
    defaultTransition: "cut",
    tags: ["lower-third", "sport"],
    category: "Lower thirds",
    sourceEditorId: "grapix-editor"
  }
});
check(
  "the Editor's publish is accepted",
  published.status === 201,
  JSON.stringify(published.payload).slice(0, 120)
);

const version = published.payload?.version;
check(
  "publishing creates a new version rather than overwriting",
  typeof version === "number" && version >= 1,
  `version ${version}`
);

console.log("\n— the scene manager —");
const library = await call("GET", "/api/playout/scenes");
const entry = (library.payload ?? []).find(
  (candidate) => candidate.sceneId === SCENE_ID && candidate.version === version
);
check("the published scene appears in the library", entry !== undefined);
check(
  "it carries a thumbnail for the operator to recognise it by",
  entry?.thumbnailDataUrl === THUMBNAIL,
  entry?.thumbnailDataUrl ? `${entry.thumbnailDataUrl.slice(0, 32)}…` : "none"
);
check(
  "it carries the project resolution, so an output can be configured from it",
  entry?.canvasWidth === 1920 && entry?.canvasHeight === 1080,
  `${entry?.canvasWidth}x${entry?.canvasHeight}`
);
check(
  "it carries the project colour space",
  entry?.colorSpace === "rec709",
  String(entry?.colorSpace)
);
check(
  "it carries the exact rational frame rate, not a rounded one",
  entry?.frameRateNumerator === 50 && entry?.frameRateDenominator === 1,
  `${entry?.frameRateNumerator}/${entry?.frameRateDenominator}`
);
check(
  "the tags and category the designer set survive",
  entry?.tags?.includes("lower-third") && entry?.category === "Lower thirds",
  `${JSON.stringify(entry?.tags)} / ${entry?.category}`
);

console.log("\n— into a rundown —");
const rundown = await call("POST", "/api/playout/rundowns/new", {
  name: "Publish proof rundown"
});
check("a rundown is created", rundown.status === 201, rundown.payload?.rundownId);

const segmentId = rundown.payload?.segments?.[0]?.segmentId;
const itemId = `item_${Date.now()}`;
const withItem = {
  ...rundown.payload,
  activeItemId: itemId,
  items: [
    {
      itemId,
      sceneId: SCENE_ID,
      sceneVersion: version,
      versionPolicy: "pinned",
      name: entry?.name ?? "Publish proof",
      pageNumber: "101",
      segmentId,
      layer: "Overlay",
      channel: "A",
      output: "Program",
      transitionIn: { type: "cut", durationFrames: 0, delayFrames: 0 },
      transitionOut: { type: "cut", durationFrames: 0, delayFrames: 0 },
      instanceData: {},
      notes: "",
      color: "#3d75ae",
      cuePolicy: "manual",
      automationEnabled: false,
      completed: false
    }
  ]
};

const saved = await call("POST", "/api/playout/rundowns", withItem);
check(
  "the scene is placed in the rundown, pinned to its version",
  saved.status === 200 && saved.payload?.items?.[0]?.sceneVersion === version,
  `v${saved.payload?.items?.[0]?.sceneVersion} policy=${saved.payload?.items?.[0]?.versionPolicy}`
);

console.log("\n— a virtual output, so the take has somewhere to go —");
const output = await call("POST", "/api/playout/engine/outputs", {
  outputId: "out_rundown",
  adapterId: "virtual",
  width: entry?.canvasWidth ?? 1920,
  height: entry?.canvasHeight ?? 1080,
  frameRate: {
    numerator: entry?.frameRateNumerator ?? 50,
    denominator: entry?.frameRateDenominator ?? 1
  },
  colorSpace: entry?.colorSpace ?? "rec709"
});
check(
  "an output is configured from the published scene's own format",
  output.status === 200,
  JSON.stringify(output.payload?.warnings ?? output.payload).slice(0, 140)
);

console.log("\n— cue and take from the rundown —");
const cued = await call("POST", "/api/playout/control/cue", {
  rundownId: rundown.payload.rundownId,
  itemId
});
check("cue from the rundown is accepted", cued.status === 200, `state=${cued.payload?.itemStates?.[itemId]}`);
check(
  "the cue was carried by the standalone engine",
  cued.payload?.activeRenderer === "engine",
  `activeRenderer=${cued.payload?.activeRenderer}`
);
check(
  "the item reports itself in Preview",
  cued.payload?.previewItemId === itemId,
  `preview=${cued.payload?.previewItemId}`
);

const taken = await call("POST", "/api/playout/control/take", {
  rundownId: rundown.payload.rundownId,
  itemId
});
check("take from the rundown is accepted", taken.status === 200, JSON.stringify(taken.payload?.lastError));
check(
  "the take was carried by the standalone engine, which owns the outputs",
  taken.payload?.activeRenderer === "engine",
  `activeRenderer=${taken.payload?.activeRenderer}`
);
check(
  "the item is on Program",
  taken.payload?.programItemId === itemId && taken.payload?.itemStates?.[itemId] === "ONLINE",
  `program=${taken.payload?.programItemId} state=${taken.payload?.itemStates?.[itemId]}`
);

// Give the Program clock time past the first frame, which pays for pipeline setup.
await new Promise((resolve) => setTimeout(resolve, 1500));

const outputs = await call("GET", "/api/playout/engine/outputs");
const running = (outputs.payload?.outputs ?? []).find(
  (candidate) => candidate.outputId === "out_rundown"
);
check(
  "taking the rundown item online started the output",
  running?.state === "running",
  `state=${running?.state}`
);
check(
  "the virtual output is receiving frames and is not live",
  (running?.framesSent ?? 0) > 0 && running?.live === false,
  `sent=${running?.framesSent} live=${running?.live}`
);

const engineStatus = await call("GET", "/api/playout/engine/status");
check(
  "the engine reports the rundown's scene on Program",
  engineStatus.payload?.programSceneId === SCENE_ID,
  `programSceneId=${engineStatus.payload?.programSceneId}`
);

console.log("\n— clean up —");
await call("POST", "/api/playout/engine/command/clear", { channel: "program" });
await call("POST", "/api/playout/engine/outputs/out_rundown/remove");
await call("POST", "/api/playout/engine/command/unload", { sceneId: SCENE_ID, force: true });
const archived = await call("POST", "/api/playout/rundowns", {
  ...saved.payload,
  archived: true
});
check("the proof rundown is archived rather than left in the list", archived.status === 200);

console.log(`\n${pass.length} passed, ${fail.length} failed\n`);
if (fail.length > 0) {
  console.log("Failed:");
  for (const label of fail) console.log(`  - ${label}`);
}
process.exit(fail.length === 0 ? 0 : 1);
