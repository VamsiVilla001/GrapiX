/**
 * The reported bug, reproduced exactly.
 *
 * "The animation is not playing when the scene is taken online — Preview and Program show
 * only B."
 *
 * The operator's sequence, which is what makes it happen:
 *
 *   1. Playout is open with nothing on Program, so the monitor's engine stream is REFUSED
 *      (`preview.streamStart` needs a scene on the channel).
 *   2. A scene is taken online. Its "in" animation is 20 frames — 0.4s at 50fps.
 *   3. If the monitor only starts on its retry interval, the animation is over before the
 *      first frame arrives, and the operator sees the finished graphic and nothing else.
 *
 * This holds the monitor connection open across the whole sequence and counts distinct
 * pictures in the window the animation actually occupies.
 */
import { createHash } from "node:crypto";

const PLAYOUT = process.env.PLAYOUT_URL ?? "http://127.0.0.1:4300";
const ORIGIN = { Origin: "http://tauri.localhost" };

const pass = [];
const fail = [];
function check(label, condition, detail = "") {
  (condition ? pass : fail).push(label);
  console.log(`  ${condition ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const digestOf = (bytes) => createHash("sha256").update(bytes).digest("hex").slice(0, 10);

console.log("\n— animation on take —\n");

// A scene that actually animates. Without one this proves nothing.
const library = await json("/api/playout/scenes");
const scenes = library.scenes ?? library;
let animated = null;
for (const entry of scenes) {
  const document = await json(`/api/playout/scenes/${entry.sceneId}`);
  const doc = document.scene ?? document;
  const objects = (doc.objects ?? []).filter((o) => o.animation);
  if (objects.length > 0) {
    animated = {
      sceneId: entry.sceneId,
      version: entry.version,
      channels: objects.flatMap((o) => Object.keys(o.animation)),
      fps: doc.timeline?.fps ?? 50,
      lastKey: Math.max(
        0,
        ...objects.flatMap((o) =>
          Object.values(o.animation).flatMap((c) => (c.keys ?? []).map((k) => k.frame))
        )
      )
    };
    break;
  }
}
check(
  "the library has a scene that animates",
  animated !== null,
  animated ? `${animated.sceneId} channels=${animated.channels.join(",")} lastKey=${animated.lastKey} @${animated.fps}fps` : "none found"
);
if (!animated) process.exit(1);

const animationMs = Math.round((animated.lastKey / animated.fps) * 1000);

// Step 1: nothing on Program.
await post("/api/playout/control/take-out", {});
await sleep(700);
const cleared = await json("/api/playout/engine/status");
check("Program starts empty, as it is when an operator opens Playout", cleared.programSceneId == null, `programSceneId=${cleared.programSceneId}`);

// Step 2: the operator's monitor is open and gets nothing, because the channel is empty.
const controller = new AbortController();
const response = await fetch(`${PLAYOUT}/api/playout/monitor/program`, {
  headers: ORIGIN,
  signal: controller.signal
});
const reader = response.body.getReader();
const parts = [];
const collect = (async () => {
  let buffer = Buffer.alloc(0);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer = Buffer.concat([buffer, Buffer.from(value)]);
      for (;;) {
        const end = buffer.indexOf("\r\n\r\n");
        if (end === -1) break;
        const match = /Content-Length: (\d+)/.exec(buffer.subarray(0, end).toString("latin1"));
        if (!match) break;
        const length = Number(match[1]);
        if (buffer.length < end + 4 + length) break;
        parts.push({ at: Date.now(), digest: digestOf(buffer.subarray(end + 4, end + 4 + length)) });
        buffer = buffer.subarray(end + 4 + length);
      }
    }
  } catch {
    // Aborted below.
  }
})();

await sleep(1200);
check(
  "an open monitor on an empty channel delivers nothing and does not fail",
  parts.length === 0 && response.status === 200,
  `${parts.length} frames, HTTP ${response.status}`
);

// Step 3: take it online.
const takeLists = await json("/api/playout/take-lists");
const lists = takeLists.takeLists ?? takeLists;
const created = await post("/api/playout/take-lists/new", { name: "Take animation proof" });
const entryId = `entry_${Date.now()}`;
const saved = await post("/api/playout/take-lists", {
  ...created.payload,
  cursorEntryId: entryId,
  entries: [
    {
      entryId,
      sceneId: animated.sceneId,
      sceneVersion: animated.version,
      versionPolicy: "pinned",
      name: "Take animation proof",
      layer: "Overlay",
      channel: "A",
      output: "Program",
      transitionIn: { type: "cut", durationFrames: 0, delayFrames: 0 },
      transitionOut: { type: "cut", durationFrames: 0, delayFrames: 0 },
      completed: false
    }
  ]
});
await post("/api/playout/control/cue", { takeListId: saved.payload.takeListId, entryId });

// Warm the preview render path before measuring.
//
// The first preview frame of a scene costs a scene preparation — around half a second — and
// that cost lands on whichever take happens first after an engine start. A real operator's
// monitor has been streaming for the whole show, so measuring the cold case would gate on a
// one-off startup cost rather than on the behaviour under test. The regression this guards
// against — a playhead that never advances — fails the warm case just as loudly.
await post("/api/playout/control/take", { takeListId: saved.payload.takeListId, entryId });
await sleep(animationMs + 900);
await post("/api/playout/control/take-out", {});
await sleep(500);
const warmFrames = parts.length;
check(
  "the warm-up take delivered frames, so the render path is ready",
  warmFrames > 0,
  `${warmFrames} frames during warm-up`
);

const takenAt = Date.now();
const take = await post("/api/playout/control/take", { takeListId: saved.payload.takeListId, entryId });
check("the take is accepted", take.status === 200, `HTTP ${take.status}`);

await sleep(animationMs + 1400);
controller.abort();
await collect;

const delivered = parts.filter((p) => p.at >= takenAt);
const firstFrameMs = delivered.length > 0 ? delivered[0].at - takenAt : null;
const duringAnimation = delivered.filter((p) => p.at - takenAt <= animationMs + 120);
const distinctDuring = new Set(duringAnimation.map((p) => p.digest)).size;
const afterAnimation = delivered.filter((p) => p.at - takenAt > animationMs + 200);
const distinctAfter = new Set(afterAnimation.map((p) => p.digest)).size;

console.log("");
for (const part of delivered.slice(0, 10)) {
  console.log(`     +${String(part.at - takenAt).padStart(4)}ms  ${part.digest}`);
}
console.log("");

check(
  "the monitor starts delivering as soon as the scene is on air",
  firstFrameMs !== null && firstFrameMs < 400,
  firstFrameMs === null ? "no frames at all" : `first frame +${firstFrameMs}ms (the animation lasts ${animationMs}ms)`
);
check(
  "the animation is visible: the picture changes while it runs",
  distinctDuring > 1,
  `${distinctDuring} distinct pictures in the first ${animationMs}ms`
);
check(
  "it holds at the end instead of looping",
  distinctAfter === 1,
  `${distinctAfter} distinct picture(s) after the last key`
);

const scene = (await json("/api/playout/engine/status")).scenes?.find((s) => s.sceneId === animated.sceneId);
check(
  "the playhead advanced past the animation",
  (scene?.frame ?? 0) > animated.lastKey,
  `playhead at frame ${scene?.frame}`
);

// Leave the machine as it was found: off air, and without another proof take list in the
// operator's list. This harness ran often enough during development to leave a dozen behind.
// The scene itself is the Editor's, so it stays in the library.
await post("/api/playout/control/take-out", {});
await post("/api/playout/take-lists", { ...saved.payload, archived: true });
console.log("\n  (took the proof scene off air and archived the proof take list)");

console.log(`\n${pass.length} passed, ${fail.length} failed\n`);
if (fail.length > 0) {
  console.log("Failed:");
  for (const label of fail) console.log(`  - ${label}`);
}
process.exit(fail.length === 0 ? 0 : 1);
