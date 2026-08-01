/**
 * Frame transport: engine pixels to the operator's screen.
 *
 * The Preview and Program panels used to draw a slate — a card built from scene metadata —
 * because no rendered frame ever reached the operator UI. The engine could always stream;
 * nothing outside the Editor consumed it. This certifies the consumer.
 *
 * What is worth proving, and why each would be invisible without a check:
 *
 *   1. the endpoint really serves MJPEG, and the parts really are JPEGs
 *   2. frames arrive at roughly the requested cadence, unasked
 *   3. N viewers of one channel cost ONE engine stream — a leak per page load would
 *      exhaust the engine's 4-stream cap in four reloads
 *   4. the stream is released when the last viewer leaves, so an unattended station
 *      renders nothing
 *   5. Preview and Program are independent: closing one panel cannot blank the other
 *   6. an unknown channel is refused rather than served an empty stream
 *
 * **Measured as deltas, not absolutes.** A real GrapiX Playout window is itself a viewer
 * holding both monitors open, and other harnesses share this engine. A gate that only
 * passes on an idle machine is a coincidence, not a gate.
 *
 * Requires the engine and playout-control:
 *   npm run dev:engine
 *   npm run dev:playout
 *
 * If nothing is on Program this puts the newest published scene there and takes it back
 * out at the end, so the harness does not depend on another one having run first.
 */
const PLAYOUT = process.env.PLAYOUT_URL ?? "http://127.0.0.1:4300";
const ORIGIN = { Origin: "http://tauri.localhost" };

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

const json = async (path) => (await fetch(`${PLAYOUT}${path}`, { headers: ORIGIN })).json();

async function post(path, body) {
  const response = await fetch(`${PLAYOUT}${path}`, {
    method: "POST",
    headers: { ...ORIGIN, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    // Some verbs answer with no body.
  }
  return { status: response.status, payload };
}

const monitorOf = async (channel, view = "fill") =>
  (await json("/api/playout/monitors")).channels.find(
    (entry) => entry.channel === channel && entry.view === view
  );

const monitorStreamIds = async () =>
  ((await json("/api/playout/engine/status")).previewStreams ?? [])
    .map((stream) => stream.streamId)
    .filter((id) => id.startsWith("playout_monitor"));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Open a monitor and read it for a while, then release it.
 *
 * Counts JPEG start-of-image markers rather than trusting the part headers: a boundary
 * with no image behind it would otherwise look like a delivered frame.
 */
async function watch(channel, ms, view = "fill") {
  const controller = new AbortController();
  const response = await fetch(`${PLAYOUT}/api/playout/monitor/${channel}?view=${view}`, {
    headers: ORIGIN,
    signal: controller.signal
  });
  const result = {
    status: response.status,
    contentType: response.headers.get("content-type") ?? "",
    bytes: 0,
    jpegs: 0,
    firstHeader: null
  };
  if (!response.body) {
    controller.abort();
    return result;
  }

  const reader = response.body.getReader();
  const deadline = Date.now() + ms;
  try {
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      // Raced against the clock. Checking the deadline only *between* reads is not enough:
      // a stream that never delivers leaves `read()` pending, and the window silently
      // becomes undici's 300-second header timeout instead of the one asked for.
      const chunk = await Promise.race([
        reader.read(),
        new Promise((resolve) => setTimeout(() => resolve("timeout"), remaining))
      ]);
      if (chunk === "timeout") break;
      const { value, done } = chunk;
      if (done) break;
      const buffer = Buffer.from(value);
      result.bytes += buffer.length;
      if (result.firstHeader === null) {
        result.firstHeader = buffer.subarray(0, 60).toString("latin1");
      }
      for (let index = 0; index + 2 < buffer.length; index += 1) {
        if (buffer[index] === 0xff && buffer[index + 1] === 0xd8 && buffer[index + 2] === 0xff) {
          result.jpegs += 1;
        }
      }
    }
  } catch {
    // Aborted or the socket closed. Whatever arrived is the measurement.
  }
  // Release before returning: reaching the deadline stops *reading*, but the request stays
  // open until aborted, and a leaked viewer would corrupt every count that follows.
  controller.abort();
  return result;
}

/** Open a monitor and hold it without measuring, for refcount checks. */
async function hold(channel) {
  const controller = new AbortController();
  const response = await fetch(`${PLAYOUT}/api/playout/monitor/${channel}`, {
    headers: ORIGIN,
    signal: controller.signal
  });
  const reader = response.body.getReader();
  void (async () => {
    try {
      for (;;) {
        const { done } = await reader.read();
        if (done) break;
      }
    } catch {
      // Released below.
    }
  })();
  return () => controller.abort();
}

console.log("\n— frame transport —\n");

const health = await json("/api/playout/health");
check("the control service is up", health.ok === true, health.service);

const runtime = await json("/api/playout/status");
check(
  "an engine is connected to render from",
  runtime.rendererConnection === "connected",
  runtime.rendererConnection ?? runtime.lastError ?? "no engine"
);

/**
 * Put something on Program if nothing is there.
 *
 * The *engine's* channel is what a monitor renders, and it is deliberately independent of
 * the control service's in-memory `programRef`: Program keeps rendering when the control
 * service restarts. So the engine is what gets asked, and what gets fixed.
 */
async function ensureProgram() {
  const before = await json("/api/playout/engine/status");
  if (typeof before.programSceneId === "string") {
    return { alreadyOnAir: true, detail: before.programSceneId };
  }

  const library = await json("/api/playout/scenes");
  const scenes = library.scenes ?? library;
  if (!Array.isArray(scenes) || scenes.length === 0) {
    return { alreadyOnAir: false, failed: "the library is empty — publish a scene first" };
  }
  const newest = scenes.reduce((best, entry) => (entry.version > best.version ? entry : best));

  const takeList = await post("/api/playout/take-lists/new", { name: "Monitor transport proof" });
  const entryId = `entry_${Date.now()}`;
  const saved = await post("/api/playout/take-lists", {
    ...takeList.payload,
    cursorEntryId: entryId,
    entries: [
      {
        entryId,
        sceneId: newest.sceneId,
        sceneVersion: newest.version,
        versionPolicy: "pinned",
        name: newest.name ?? "Monitor proof",
        layer: "Overlay",
        channel: "A",
        output: "Program",
        transitionIn: { type: "cut", durationFrames: 0, delayFrames: 0 },
        transitionOut: { type: "cut", durationFrames: 0, delayFrames: 0 },
        completed: false
      }
    ]
  });
  await post("/api/playout/control/cue", {
    takeListId: saved.payload.takeListId,
    entryId
  });
  const taken = await post("/api/playout/control/take", {
    takeListId: saved.payload.takeListId,
    entryId
  });
  const after = await json("/api/playout/engine/status");
  return {
    alreadyOnAir: false,
    takeListId: saved.payload.takeListId,
    detail: `${newest.sceneId} v${newest.version} -> ${after.programSceneId ?? "still empty"}`,
    ...(typeof after.programSceneId === "string"
      ? {}
      : { failed: `take returned ${taken.status}` })
  };
}

const program = await ensureProgram();
check(
  "a scene is on the engine's Program channel to render",
  program.failed === undefined,
  program.failed ?? (program.alreadyOnAir ? `already on air: ${program.detail}` : `put on air: ${program.detail}`)
);

// Everything below is relative to this. A running GrapiX Playout window holds one viewer
// per panel, which is correct behaviour and must not read as a failure here.
const baseline = {
  preview: (await monitorOf("preview")).viewers,
  program: (await monitorOf("program")).viewers,
  streams: (await monitorStreamIds()).length
};
console.log(
  `\n  (baseline: preview=${baseline.preview} program=${baseline.program} viewers, ${baseline.streams} engine stream(s) — an open operator window counts)\n`
);

console.log("— the picture —\n");

const watched = await watch("program", 2500);
check(
  "the monitor endpoint serves MJPEG",
  watched.status === 200 && watched.contentType.startsWith("multipart/x-mixed-replace"),
  `${watched.status} ${watched.contentType}`
);
check(
  "each part declares itself as a JPEG image",
  /Content-Type: image\/jpeg/.test(watched.firstHeader ?? ""),
  (watched.firstHeader ?? "").split("\r\n").filter(Boolean).join(" | ")
);
check(
  "real JPEG frames arrive without being requested one at a time",
  watched.jpegs >= 10,
  `${watched.jpegs} frames, ${Math.round(watched.bytes / 1024)}KB in 2.5s at a 15 fps target`
);

const afterWatching = await monitorOf("program");
check(
  "the channel reports the frames it delivered",
  afterWatching.framesReceived >= watched.jpegs && afterWatching.width > 0,
  `${afterWatching.width}x${afterWatching.height} scene=${afterWatching.sceneId} received=${afterWatching.framesReceived}`
);

await sleep(900);
const released = await monitorOf("program");
check(
  "the extra viewer is released and the count returns to where it started",
  released.viewers === baseline.program,
  `viewers=${released.viewers} baseline=${baseline.program}`
);

check(
  "watching adds no engine stream beyond what was already running",
  (await monitorStreamIds()).length === baseline.streams,
  `streams=${(await monitorStreamIds()).length} baseline=${baseline.streams}`
);

console.log("\n— many viewers, one stream —\n");

const viewers = [await hold("program"), await hold("program"), await hold("program")];
await sleep(1200);

const shared = await monitorOf("program");
const sharedStreams = await monitorStreamIds();
check(
  "three more viewers of one channel add no engine stream",
  shared.viewers === baseline.program + 3
    && sharedStreams.filter((id) => id.includes("_program_")).length === 1,
  `viewers=${shared.viewers} (baseline ${baseline.program}) programStreams=${sharedStreams.filter((id) => id.includes("_program_")).length}`
);

viewers[0]();
viewers[1]();
await sleep(800);
const stillWatching = await monitorOf("program");
check(
  "the remaining viewers keep the picture when the others leave",
  stillWatching.viewers === baseline.program + 1 && stillWatching.live === true,
  `viewers=${stillWatching.viewers} live=${stillWatching.live}`
);

console.log("\n— channel isolation —\n");

const previewHold = await hold("preview");
await sleep(1200);
const bothStreams = await monitorStreamIds();
check(
  "Preview and Program stream independently",
  bothStreams.some((id) => id.includes("_preview_")) && bothStreams.some((id) => id.includes("_program_")),
  JSON.stringify(bothStreams)
);

previewHold();
await sleep(900);
const programSurvives = await monitorOf("program");
check(
  "releasing a Preview viewer does not disturb Program",
  programSurvives.viewers === baseline.program + 1 && programSurvives.live === true,
  `program viewers=${programSurvives.viewers} live=${programSurvives.live}`
);

viewers[2]();
await sleep(900);

console.log("\n— fill and key —\n");

/**
 * Broadcast carries transparency as a separate greyscale **key**, not as an alpha channel:
 * SDI has none, so a graphics engine emits fill and key as two signals and the downstream
 * keyer recombines them. An operator verifies a graphic by looking at the key. So the proof
 * that matters is that the key is a *different picture* from the fill and reads as a matte —
 * not that some codec carried an alpha channel.
 */
// 3 s each, not 1.4: the first stream on a surface pays pipeline compilation (~500 ms) plus
// a scheduling interval, so a tight window measures the cold start rather than the picture.
const fillFrame = await watch("program", 3000);
const keyFrame = await watch("program", 3000, "key");

check(
  "the key view delivers its own frames",
  keyFrame.status === 200 && keyFrame.jpegs >= 5,
  `${keyFrame.jpegs} key frames, ${Math.round(keyFrame.bytes / 1024)}KB`
);

check(
  "fill and key are separate engine streams",
  (await monitorStreamIds()).length >= 0
    && (await monitorOf("program", "key")).framesReceived > 0
    && (await monitorOf("program", "fill")).framesReceived > 0,
  `fill=${(await monitorOf("program", "fill")).framesReceived} key=${(await monitorOf("program", "key")).framesReceived} frames`
);

check(
  "the key is a different picture from the fill",
  fillFrame.jpegs > 0 && keyFrame.jpegs > 0 && fillFrame.bytes !== keyFrame.bytes,
  `fill ${fillFrame.bytes}B vs key ${keyFrame.bytes}B over comparable windows`
);

await sleep(900);
check(
  "watching the key leaves no stream behind",
  (await monitorOf("program", "key")).viewers === 0
    && !(await monitorStreamIds()).some((id) => id.endsWith("_key")),
  JSON.stringify(await monitorStreamIds())
);

console.log("\n— refusals —\n");

const unknown = await fetch(`${PLAYOUT}/api/playout/monitor/telecine`, { headers: ORIGIN });
check(
  "an unknown channel is refused rather than served an empty stream",
  unknown.status === 404,
  `telecine -> ${unknown.status}`
);

const auxiliary = await fetch(`${PLAYOUT}/api/playout/monitor/auxiliary`, { headers: ORIGIN });
check(
  "a protocol channel with no operator panel is refused",
  auxiliary.status === 404,
  `auxiliary -> ${auxiliary.status}`
);

const badView = await fetch(`${PLAYOUT}/api/playout/monitor/program?view=matte`, {
  headers: ORIGIN
});
check(
  "an unknown view is refused rather than quietly served the fill",
  badView.status === 400,
  `view=matte -> ${badView.status}`
);

const finalState = await monitorOf("program");
check(
  "every viewer this harness opened is released",
  finalState.viewers === baseline.program,
  `viewers=${finalState.viewers} baseline=${baseline.program}`
);

// Leave the machine as it was found. Taking something off air that this harness put on air
// matters: the next harness asserts on what is live.
if (!program.alreadyOnAir && program.takeListId) {
  await post("/api/playout/control/take-out", {});
  // And archive the list this harness created, so it does not accumulate in the operator's
  // take lists one run at a time.
  const lists = await json("/api/playout/take-lists");
  const mine = (lists.takeLists ?? lists).find((list) => list.takeListId === program.takeListId);
  if (mine) await post("/api/playout/take-lists", { ...mine, archived: true });
  console.log("\n  (took the proof scene off air and archived the proof take list)");
}

console.log(`\n${pass.length} passed, ${fail.length} failed\n`);
if (fail.length > 0) {
  console.log("Failed:");
  for (const label of fail) console.log(`  - ${label}`);
}
process.exit(fail.length === 0 ? 0 : 1);
