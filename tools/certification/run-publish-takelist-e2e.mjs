/**
 * Publish → Scene Manager → Take List → air.
 *
 * The path a designer and an operator actually walk:
 *
 *   1. the Editor publishes a scene to Playout, with a thumbnail
 *   2. it appears in the scene manager with the metadata an operator needs
 *   3. it is placed in a Take List (what the UI does by button; here by the same API)
 *   4. taking that entry online drives the standalone engine, and so does a bare Take ID
 *   5. the engine's outputs start, and the virtual output receives real frames
 *
 * Step 4 is the one worth stating plainly: a Take must reach the
 * engine that owns the outputs.
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

console.log("\n— the Scene Manager assigns a Take ID —");
check(
  "the published scene has a numeric Take ID for direct recall",
  Number.isSafeInteger(entry?.takeId),
  `take ${entry?.takeId}`
);

console.log("\n— into a take list —");
const takeList = await call("POST", "/api/playout/take-lists/new", {
  name: "Publish proof take list"
});
check("a take list is created", takeList.status === 201, takeList.payload?.takeListId);

const entryId = `entry_${Date.now()}`;
const withEntry = {
  ...takeList.payload,
  cursorEntryId: entryId,
  entries: [
    {
      entryId,
      sceneId: SCENE_ID,
      sceneVersion: version,
      versionPolicy: "pinned",
      name: entry?.name ?? "Publish proof",
      layer: "Overlay",
      transitionIn: { type: "cut", durationFrames: 0, delayFrames: 0 },
      transitionOut: { type: "cut", durationFrames: 0, delayFrames: 0 },
      instanceData: {},
      notes: "",
      color: "#3d75ae",
      completed: false
    }
  ]
};

const saved = await call("POST", "/api/playout/take-lists", withEntry);
check(
  "the scene is placed in the take list, pinned to its version",
  saved.status === 200 && saved.payload?.entries?.[0]?.sceneVersion === version,
  `v${saved.payload?.entries?.[0]?.sceneVersion} policy=${saved.payload?.entries?.[0]?.versionPolicy}`
);
check(
  "the cursor points at the take that will go on air next",
  saved.payload?.cursorEntryId === entryId,
  saved.payload?.cursorEntryId
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

console.log("\n— cue and take from the take list —");
const cued = await call("POST", "/api/playout/control/cue", {
  takeListId: takeList.payload.takeListId,
  entryId
});
check(
  "cue from the take list is accepted",
  cued.status === 200,
  `state=${cued.payload?.takeStates?.[entryId]}`
);
const cuedEngine = await call("GET", "/api/playout/engine/status");
check(
  "the cue reached the engine, which holds the scene on Preview",
  cuedEngine.payload?.previewSceneId === SCENE_ID,
  `previewSceneId=${cuedEngine.payload?.previewSceneId} program=${cuedEngine.payload?.programSceneId}`
);
check(
  "the take reports itself in Preview",
  cued.payload?.previewRef === entryId,
  `preview=${cued.payload?.previewRef}`
);

const taken = await call("POST", "/api/playout/control/take", {
  takeListId: takeList.payload.takeListId,
  entryId
});
check("take from the take list is accepted", taken.status === 200, JSON.stringify(taken.payload?.lastError));
check(
  "the take is on Program",
  taken.payload?.programRef === entryId && taken.payload?.takeStates?.[entryId] === "ONLINE",
  `program=${taken.payload?.programRef} state=${taken.payload?.takeStates?.[entryId]}`
);

// Give the Program clock time past the first frame, which pays for pipeline setup.
await new Promise((resolve) => setTimeout(resolve, 1500));

const outputs = await call("GET", "/api/playout/engine/outputs");
const running = (outputs.payload?.outputs ?? []).find(
  (candidate) => candidate.outputId === "out_rundown"
);
check(
  "taking the entry online started the output",
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
  "the engine reports the take list's scene on Program",
  engineStatus.payload?.programSceneId === SCENE_ID,
  `programSceneId=${engineStatus.payload?.programSceneId}`
);

console.log("\n— Take Out, then direct recall by Take ID —");
const out = await call("POST", "/api/playout/control/take-out", {});
check("Take Out clears Program", out.status === 200 && out.payload?.programRef === null);

// The Scene Manager path: no take list, just the number an operator types.
const recalled = await call("POST", "/api/playout/control/take", { takeId: entry.takeId });
check(
  "a Take ID recall puts the scene on air with no take list involved",
  recalled.status === 200 && recalled.payload?.programRef === `scene:take-${entry.takeId}`,
  `programRef=${recalled.payload?.programRef}`
);
const recalledEngine = await call("GET", "/api/playout/engine/status");
check(
  "the engine agrees the recalled scene is on Program",
  recalledEngine.payload?.programSceneId === SCENE_ID,
  `programSceneId=${recalledEngine.payload?.programSceneId}`
);

const ambiguous = await call("POST", "/api/playout/control/take", {
  takeId: entry.takeId,
  takeListId: takeList.payload.takeListId,
  entryId
});
check(
  "a command naming both a Take ID and an entry is refused rather than guessed",
  ambiguous.status === 400,
  ambiguous.payload?.error
);

console.log("\n— clean up —");
await call("POST", "/api/playout/control/take-out", {});
await call("POST", "/api/playout/engine/outputs/out_rundown/remove");
await call("POST", "/api/playout/engine/command/unload", { sceneId: SCENE_ID, force: true });
const archived = await call("POST", "/api/playout/take-lists", {
  ...saved.payload,
  archived: true
});
check("the proof take list is archived rather than left in the list", archived.status === 200);

// And take the published scene back out of the library.
//
// Without this every run left another test scene in the operator's Scene Manager. The library
// filled with e2e leftovers until it no longer resembled the Editor's, which is exactly the
// list an operator scans under time pressure. Archiving the take list first is what releases
// the store's guard against removing a scene something still references.
const purged = await call("DELETE", `/api/playout/scenes/${SCENE_ID}`);
check(
  "the proof scene is removed from the library rather than left for an operator to find",
  purged.status === 200,
  `${purged.status} ${JSON.stringify(purged.payload).slice(0, 120)}`
);

console.log(`\n${pass.length} passed, ${fail.length} failed\n`);
if (fail.length > 0) {
  console.log("Failed:");
  for (const label of fail) console.log(`  - ${label}`);
}
process.exit(fail.length === 0 ? 0 : 1);
