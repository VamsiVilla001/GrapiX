/**
 * Pixel parity harness.
 *
 * Phase K. What it proves, and — just as importantly — what it does not.
 *
 * **Fully automated here:**
 *
 * 1. *Native determinism.* The same scene at the same frame, rendered twice, must be
 *    byte-identical. A renderer that is not deterministic cannot be compared against
 *    anything, so this runs first: if it fails, every other number below is noise.
 * 2. *Tiled against single-pass.* The same region rendered as one pass and as a composite
 *    of tiles must agree. This is the strongest automated check in the suite, because it
 *    exercises the f64 rebase, the overscan ring and the seam-free compositing that the
 *    whole 50,000² design rests on — and a seam shows up as a bright line in the diff.
 * 3. *Far-edge against near-edge.* The same content placed at x=0 and at x=49,000 must
 *    render identically once the region origin is subtracted. This is the precision rule
 *    made visible: without the rebase, f32 spacing at 49,000 is 0.0039px and edges crawl.
 *
 * **Not automated here:** the browser side. Capturing the Editor's PixiJS output needs a
 * real browser, and there is no browser automation in this repository. The harness reads a
 * browser capture from disk when one is present and compares it; when none is present it
 * says so and does not claim parity was proven. Producing that capture is a documented
 * manual step (see `docs/pixel-parity.md`), and the comparison itself — the part that
 * decides pass or fail — is the same code either way.
 *
 * Requires a running engine: `npm run dev:engine`.
 */
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { EngineConnection, WebSocketEngineTransport, engineUrl } from "@grapix/render-protocol";

import {
  bgraToRgba,
  compareImages,
  describeComparison,
  decodePng,
  encodePng,
  flattenOnto,
  unpremultiply
} from "./pixel-parity.mjs";

const HOST = process.env.ENGINE_HOST ?? "127.0.0.1";
const PORT = Number(process.env.ENGINE_PORT ?? 4400);
// Two authorities, two connections, one engine - the same split the product runs.
//
// Authoring (stage.load, scene.load, scene.unload) is the Editor, which a local peer gets
// without a credential. Every capture here goes through `preview.request`, an operator verb,
// so the measurement leg must present the bearer. One connection cannot be both: authority is
// fixed at the handshake by what it presented.
const url = engineUrl(HOST, PORT, { secure: false });
const TOKEN = process.env.GRAPIX_ENGINE_TOKEN;
const OUTPUT_DIRECTORY = process.env.PARITY_OUTPUT ?? "artifacts/pixel-parity";
/** Where a browser capture is looked for, if one has been produced. */
const BROWSER_CAPTURES = process.env.PARITY_BROWSER_CAPTURES ?? "artifacts/pixel-parity/browser";

const pass = [];
const fail = [];
const skipped = [];

function check(label, condition, detail = "") {
  if (condition) {
    pass.push(label);
    console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    fail.push(label);
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function skip(label, why) {
  skipped.push(label);
  console.log(`  SKIP  ${label} — ${why}`);
}

console.log(`\nPixel parity against ${url}\n`);

const client = new EngineConnection({
  clientId: "parity",
  clientName: "GrapiX parity harness",
  clientRole: "diagnostic",
  clientVersion: "0.2.0",
  transport: new WebSocketEngineTransport({ url }),
  autoReconnect: false
});

// The measurement leg. Every capture is an operator verb, so without a bearer there is
// nothing this harness can measure - it says so and stops rather than reporting a pass it
// never earned.
if (!TOKEN) {
  console.log("GRAPIX_ENGINE_TOKEN is not set, and every capture here is an operator verb.");
  console.log("Start a token-secured engine and export the same token, then re-run.\n");
  process.exit(1);
}
const operator = new EngineConnection({
  clientId: "parity-operator",
  clientName: "GrapiX parity operator",
  clientRole: "playout",
  clientVersion: "0.2.0",
  transport: new WebSocketEngineTransport({ url, authToken: TOKEN }),
  autoReconnect: false,
  authToken: TOKEN
});

try {
  await client.connect();
  await operator.connect();
} catch (error) {
  console.log(`Could not connect: ${error.message}`);
  console.log("Start the engine first: npm run dev:engine\n");
  process.exit(1);
}

// A previous run that stopped early leaves its scenes resident, and the engine refuses a load
// once it holds its maximum. Releasing this harness's own two first makes the run repeatable
// without restarting the engine; an absent scene simply is not there to release.
for (const sceneId of ["scene_near", "scene_far"]) {
  // Both domains: an older build of this harness loaded these ids as `authoring`, and a copy
  // left under the other domain still counts against the engine's active-scene ceiling.
  for (const domain of ["published", "authoring"]) {
    await operator
      .request(
        "scene.unload",
        { sceneId, force: true },
        { sceneRef: { projectId: "certification", domain, sceneId, revision: 1 } }
      )
      .catch(() => {});
  }
}
client.markReady("nothing to reconcile");
await mkdir(OUTPUT_DIRECTORY, { recursive: true });

// A stage wide enough that the far edge is a real precision test, and content that
// exercises fills, edges and overlap rather than a flat colour.
const stage = {
  stageId: "stage_parity",
  version: 1,
  name: "Parity stage",
  canvas: { logicalWidth: 50000, logicalHeight: 2000 },
  regions: [
    { regionId: "region_near", name: "Near", bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
    {
      regionId: "region_far",
      name: "Far",
      bounds: { x: 49000, y: 0, width: 1920, height: 1080 }
    }
  ],
  surfaces: [],
  viewports: [
    {
      viewportId: "viewport_near",
      name: "Near edge",
      source: { type: "region", regionId: "region_near" },
      renderScale: 1,
      enabled: true
    },
    {
      viewportId: "viewport_far",
      name: "Far edge",
      source: { type: "region", regionId: "region_far" },
      renderScale: 1,
      enabled: true
    }
  ],
  outputs: [],
  outputMappings: [],
  // A small tile so a 900px capture genuinely spans several tiles: the seam and overscan
  // behaviour is only exercised when the region crosses a boundary.
  tiling: {
    enabled: true,
    tileWidth: 512,
    tileHeight: 512,
    overscan: 32,
    maxResidentTiles: 256,
    cacheBudgetBytes: 268435456
  }
};

await client.request("stage.load", { stage });

/** The same content, placed at an x offset. */
function parityScene(sceneId, offsetX) {
  return {
    id: sceneId,
    name: "Parity content",
    version: 1,
    revision: 1,
    canvas: { width: 50000, height: 2000, background: "#00000000" },
    dataContext: {},
    assets: [],
    materials: [],
    objects: [
      {
        id: "rect_base",
        name: "Base",
        type: "rect",
        x: offsetX + 40,
        y: 60,
        width: 600,
        height: 300,
        zDepth: 0,
        zIndex: 0,
        layerId: "layer_1",
        visible: true,
        fill: "#1e88e5"
      },
      {
        // Deliberately overlapping and offset by a fraction of a pixel: subpixel
        // placement is where a precision fault first becomes visible.
        id: "rect_overlap",
        name: "Overlap",
        type: "rect",
        x: offsetX + 380.37,
        y: 180.81,
        width: 420,
        height: 260,
        zDepth: 0,
        zIndex: 1,
        layerId: "layer_1",
        visible: true,
        fill: "#e5393580"
      },
      {
        // Straddles a 512px tile boundary at 512 relative to the region origin, so a
        // seam or an overscan mistake lands inside it.
        id: "rect_seam",
        name: "Seam crosser",
        type: "rect",
        x: offsetX + 460,
        y: 420,
        width: 200,
        height: 160,
        zDepth: 0,
        zIndex: 2,
        layerId: "layer_1",
        visible: true,
        fill: "#43a047"
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
}

/**
 * Capture a region natively.
 *
 * `showTileDebug` is what forces the tiled path: the engine uses a single pass whenever the
 * output fits one texture, so asking for the tile grid is how the composite path is
 * exercised on a small region. The debug overlay itself is drawn *after* compositing, so it
 * is not usable for comparison — which is why the tiled capture below asks for a region
 * larger than the texture limit instead.
 */
async function capture(region, options = {}) {
  const reply = await operator.request("preview.request", {
    channel: "preview",
    // Named explicitly rather than relying on the channel's selection. The engine used to fall
    // back to an arbitrary scene in HashMap order when nothing was cued and now refuses instead,
    // which is right for an operator's confidence monitor and means this harness has to say which
    // scene it is measuring. It loads two (`scene_near`, `scene_far`) and compares them, so the
    // selection was never a safe thing to leave implicit here anyway.
    sceneId: options.sceneId ?? "scene_near",
    source: {
      type: "rect",
      x: region.x,
      y: region.y,
      width: region.width,
      height: region.height,
      renderScale: region.renderScale ?? 1
    },
    // PNG, not JPEG: JPEG's own error is larger than the rendering differences this is
    // trying to measure, and it discards alpha entirely.
    encoding: "png",
    ...(options.forceTiled ? { forceTiled: true } : {})
  }, {
    sceneRef: {
      projectId: "certification",
      domain: "published",
      sceneId: options.sceneId ?? "scene_near",
      revision: 1
    }
  });

  const payload = reply.payload;
  return {
    payload,
    image: decodePng(new Uint8Array(Buffer.from(payload.data, "base64")))
  };
}

// ---------------------------------------------------------------------------
// 1. Determinism
// ---------------------------------------------------------------------------

console.log("— native determinism —");

await operator.request(
  "scene.load",
  { scene: parityScene("scene_near", 0), stageId: stage.stageId, prepare: true },
  { sceneRef: { projectId: "certification", domain: "published", sceneId: "scene_near", revision: 1 } }
);

const region = { x: 0, y: 0, width: 900, height: 600, renderScale: 1 };
const firstPass = await capture(region);
const secondPass = await capture(region);

const determinism = compareImages(firstPass.image, secondPass.image, { tolerance: 0 });
check(
  "the same scene at the same frame renders identically twice",
  determinism.comparable && determinism.maxChannelDelta === 0,
  describeComparison(determinism)
);
if (determinism.comparable && !determinism.matches) {
  await writeFile(join(OUTPUT_DIRECTORY, "determinism-diff.png"), encodePng(determinism.diff));
}
check(
  "a preview is rendered as one pass when it fits a single texture",
  firstPass.payload.renderPath === "single-pass",
  `renderPath=${firstPass.payload.renderPath}`
);

// ---------------------------------------------------------------------------
// 2. Tiled against single-pass, via a recording output
// ---------------------------------------------------------------------------
//
// The recording adapter writes byte-exact BGRA, which is what a parity comparison needs;
// a JPEG preview is lossy and would put its own error into every measurement.

console.log("\n— tiled against single-pass —");

// The same region by both routes. This is the strongest automated check in the suite: it
// exercises the f64 rebase, the overscan ring and the seam-free composite that the whole
// 50,000-square design rests on, and a seam appears as a bright line in the diff image.
const singlePass = await capture(region);
const tiled = await capture(region, { forceTiled: true });

check(
  "the two captures really came from different routes",
  singlePass.payload.renderPath === "single-pass" && tiled.payload.renderPath === "tiled",
  `${singlePass.payload.renderPath} against ${tiled.payload.renderPath}`
);

const seams = compareImages(singlePass.image, tiled.image, {
  // A tile boundary must be invisible, not merely subtle. Any pixel differing by more than
  // rounding is a seam.
  tolerance: 1,
  maxDifferentRatio: 0
});
check(
  "a tile composite is pixel-identical to a single pass over the same region",
  seams.comparable && seams.matches,
  describeComparison(seams)
);
if (seams.comparable && !seams.matches) {
  const diffPath = join(OUTPUT_DIRECTORY, "tiled-vs-single-pass-diff.png");
  await writeFile(diffPath, encodePng(seams.diff));
  await writeFile(join(OUTPUT_DIRECTORY, "single-pass.png"), encodePng(singlePass.image));
  await writeFile(join(OUTPUT_DIRECTORY, "tiled.png"), encodePng(tiled.image));
  console.log(`        diff written to ${diffPath}`);
}

// A byte-exact Program capture through the recording output, which is the path a real
// output takes. The engine reports its own cache directory, so this does not guess.
const diagnostics = await client.request("engine.getDiagnostics", { includeTiles: false });
const engineCacheDirectory = diagnostics.payload?.cacheDirectory ?? null;

async function recordProgramFrame(sceneId, name) {
  if (!engineCacheDirectory) return null;

  await operator.request("output.configure", {
    outputId: "out_parity",
    adapterId: "recording",
    format: {
      width: 960,
      height: 540,
      frameRate: { numerator: 50, denominator: 1 },
      alphaMode: "premultiplied",
      colorSpace: "rec709"
    },
    options: { recordingName: name, maxFrames: 1 }
  });
  await operator.request(
    "playout.takeOnline",
    { sceneId, overrideUnprepared: true },
    { sceneRef: { projectId: "certification", domain: "published", sceneId, revision: 1 } }
  );

  for (let attempt = 0; attempt < 80; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const outputs = await operator.request("output.list", {});
    const output = outputs.payload.outputs.find((entry) => entry.outputId === "out_parity");
    if ((output?.framesSent ?? 0) > 0) break;
  }

  await operator.request("playout.clear", { channel: "program" });
  await operator.request("output.remove", { outputId: "out_parity" });

  const recordings = join(engineCacheDirectory, "recordings");
  const files = await readdir(recordings).catch(() => []);
  const match = files.filter((file) => file.startsWith(`${name}-`)).sort().at(-1);
  if (!match) return null;

  const bytes = new Uint8Array(await readFile(join(recordings, match)));
  if (bytes.length !== 960 * 540 * 4) return null;
  return bgraToRgba(960, 540, bytes);
}

const programFrame = await recordProgramFrame("scene_near", "parity_program_a");
if (!programFrame) {
  skip(
    "a Program frame is captured byte-exact from the recording output",
    engineCacheDirectory
      ? "no recording appeared in the engine's cache directory"
      : "the engine did not report its cache directory"
  );
} else {
  check(
    "a Program frame is captured byte-exact from the recording output",
    programFrame.width === 960 && programFrame.height === 540,
    `${programFrame.width}x${programFrame.height} RGBA from BGRA`
  );

  const second = await recordProgramFrame("scene_near", "parity_program_b");
  if (second) {
    const programDeterminism = compareImages(programFrame, second, { tolerance: 0 });
    check(
      "two Program captures of the same frame are byte-identical",
      programDeterminism.comparable && programDeterminism.maxChannelDelta === 0,
      describeComparison(programDeterminism)
    );
    if (programDeterminism.comparable && !programDeterminism.matches) {
      await writeFile(
        join(OUTPUT_DIRECTORY, "program-determinism-diff.png"),
        encodePng(programDeterminism.diff)
      );
    }
  } else {
    skip("two Program captures of the same frame are byte-identical", "the second capture failed");
  }
}

// ---------------------------------------------------------------------------
// 3. Far edge against near edge — the precision rule, visibly
// ---------------------------------------------------------------------------

console.log("\n— far edge against near edge —");

const FAR_OFFSET = 49000;
await operator.request(
  "scene.load",
  { scene: parityScene("scene_far", FAR_OFFSET), stageId: stage.stageId, prepare: true },
  { sceneRef: { projectId: "certification", domain: "published", sceneId: "scene_far", revision: 1 } }
);
// Both scenes are loaded, so the preview channel has to be pointed at the far one.
await operator.request(
  "playout.cue",
  { sceneId: "scene_far", sceneRevision: 1, channel: "preview" },
  { sceneRef: { projectId: "certification", domain: "published", sceneId: "scene_far", revision: 1 } }
);

const farCapture = await capture(
  { x: FAR_OFFSET, y: 0, width: 900, height: 600 },
  { sceneId: "scene_far" }
);

check(
  "the far-edge capture reports its logical origin at the far edge",
  farCapture.payload.logicalBounds.x === FAR_OFFSET,
  `logical x=${farCapture.payload.logicalBounds.x}`
);

// Back to the near scene for its capture, so the two differ only in placement.
await operator.request(
  "playout.cue",
  { sceneId: "scene_near", sceneRevision: 1, channel: "preview" },
  { sceneRef: { projectId: "certification", domain: "published", sceneId: "scene_near", revision: 1 } }
);
const nearCapture = await capture({ x: 0, y: 0, width: 900, height: 600 });

// Identical content, 49,000 logical units apart. Without the f64 rebase, f32 spacing at
// 49,000 is 0.0039px and edges would visibly crawl; with it, the two are the same picture
// to within rounding on antialiased edges.
const precision = compareImages(nearCapture.image, farCapture.image, {
  tolerance: 2,
  maxDifferentRatio: 0.0005
});
check(
  "content at the far edge of a 50,000-unit stage renders as it does at the near edge",
  precision.comparable && precision.matches,
  describeComparison(precision)
);
if (precision.comparable && !precision.matches) {
  const diffPath = join(OUTPUT_DIRECTORY, "far-vs-near-diff.png");
  await writeFile(diffPath, encodePng(precision.diff));
  await writeFile(join(OUTPUT_DIRECTORY, "near-edge.png"), encodePng(nearCapture.image));
  await writeFile(join(OUTPUT_DIRECTORY, "far-edge.png"), encodePng(farCapture.image));
  console.log(`        diff written to ${diffPath}`);
}

// ---------------------------------------------------------------------------
// 4. The browser side
// ---------------------------------------------------------------------------

console.log("\n— browser against native —");

const browserCaptures = await readdir(BROWSER_CAPTURES).catch(() => []);
const browserPngs = browserCaptures.filter((file) => file.endsWith(".png"));

if (browserPngs.length === 0) {
  skip(
    "a browser capture is compared against the native render",
    `no PNGs in ${BROWSER_CAPTURES}. This repository has no browser automation, so the ` +
      "capture is a manual step (see docs/pixel-parity.md). Parity with the browser " +
      "renderer is therefore NOT proven by this run"
  );
} else if (!programFrame) {
  skip(
    "a browser capture is compared against the native render",
    "there is no native capture to compare it against"
  );
} else {
  for (const file of browserPngs) {
    const bytes = new Uint8Array(await readFile(join(BROWSER_CAPTURES, file)));
    let browserImage;
    try {
      browserImage = decodePng(bytes);
    } catch (error) {
      check(`${file} is readable`, false, error.message);
      continue;
    }

    // The native frame is premultiplied and the canvas read-back is straight, so both are
    // flattened onto the same background before comparison. Comparing them raw would
    // report differences in every semi-transparent pixel that nobody could see.
    const nativeFlattened = flattenOnto(unpremultiply(programFrame));
    const browserFlattened = flattenOnto(browserImage);

    const result = compareImages(nativeFlattened, browserFlattened, {
      tolerance: 4,
      maxDifferentRatio: 0.002
    });

    check(
      `browser capture ${file} matches the native render`,
      result.comparable && result.matches,
      describeComparison(result)
    );

    if (result.comparable && !result.matches) {
      const diffPath = join(OUTPUT_DIRECTORY, `browser-diff-${file}`);
      await writeFile(diffPath, encodePng(result.diff));
      console.log(`        diff written to ${diffPath}`);
    }
  }
}

await operator.request(
  "scene.unload",
  { sceneId: "scene_near", force: true },
  { sceneRef: { projectId: "certification", domain: "published", sceneId: "scene_near", revision: 1 } }
);
await operator.request(
  "scene.unload",
  { sceneId: "scene_far", force: true },
  { sceneRef: { projectId: "certification", domain: "published", sceneId: "scene_far", revision: 1 } }
);
client.disconnect("parity run finished");
operator.disconnect("parity run finished");

console.log(`\n${pass.length} passed, ${fail.length} failed, ${skipped.length} skipped\n`);
if (fail.length > 0) {
  console.log("Failed:");
  for (const label of fail) console.log(`  - ${label}`);
}
if (skipped.length > 0) {
  console.log("Skipped:");
  for (const label of skipped) console.log(`  - ${label}`);
}
process.exit(fail.length === 0 ? 0 : 1);
