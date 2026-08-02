import assert from "node:assert/strict";
import test from "node:test";
import { MonitorHub } from "../dist/monitorHub.js";

/**
 * Stands in for `PlayoutEngineController`. Records stream verbs in order and lets a test
 * push frames the way the engine would, so the refcount and recovery rules are observable
 * without a GPU.
 */
class FakeEngine {
  constructor({ failStart = false } = {}) {
    this.verbs = [];
    /** Full request objects, so a test can assert what the engine was actually asked for. */
    this.requests = [];
    this.running = new Set();
    this.failStart = failStart;
    this.listeners = new Set();
    this.startGate = null;
  }

  onEngineEvent(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async startPreviewStream(_profileId, request) {
    this.verbs.push(`start:${request.streamId}`);
    this.requests.push(request);
    if (this.startGate) await this.startGate;
    if (this.failStart) throw new Error("no scene is on program");
    this.running.add(request.streamId);
    return {
      streamId: request.streamId,
      targetFps: request.targetFps,
      intervalMs: Math.round(1000 / request.targetFps),
      width: request.maxWidth,
      height: request.maxHeight
    };
  }

  async stopPreviewStream(_profileId, streamId) {
    this.verbs.push(`stop:${streamId}`);
    this.running.delete(streamId);
  }

  /** Deliver a frame exactly as the engine addresses it. */
  pushFrame(streamId, overrides = {}) {
    const payload = {
      streamId,
      channel: "program",
      encoding: "jpeg",
      width: 640,
      height: 360,
      frame: 7,
      sceneId: "001",
      renderMs: 3,
      // "hi" — the bytes do not matter, only that they are decoded once.
      data: Buffer.from("hi").toString("base64"),
      ...overrides
    };
    for (const listener of this.listeners) {
      listener({ type: "engine-event", eventType: "event.previewFrame", message: { payload } });
    }
  }

  emit(event) {
    for (const listener of this.listeners) listener(event);
  }
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

function hub(engine, options = {}) {
  const instance = new MonitorHub(engine, { profileId: "playout-engine", ...options });
  instance.start();
  return instance;
}

test("one engine stream serves every viewer of a channel", async () => {
  const engine = new FakeEngine();
  const monitors = hub(engine);

  const detachA = monitors.subscribe("program", "fill", () => {});
  const detachB = monitors.subscribe("program", "fill", () => {});
  const detachC = monitors.subscribe("program", "fill", () => {});
  await settle();

  assert.deepEqual(engine.verbs, ["start:playout_monitor_program_fill"]);
  assert.equal(engine.requests[0].targetFps, 30);
  assert.equal(monitors.status().find((c) => c.channel === "program" && c.view === "fill").viewers, 3);

  // Two of three leaving must not take the picture away from the third.
  detachA();
  detachB();
  await settle();
  assert.deepEqual(engine.verbs, ["start:playout_monitor_program_fill"]);
  assert.equal(engine.running.has("playout_monitor_program_fill"), true);

  detachC();
  await settle();
  assert.deepEqual(engine.verbs, ["start:playout_monitor_program_fill", "stop:playout_monitor_program_fill"]);
  assert.equal(engine.running.size, 0);
});

test("preview and program are independent streams", async () => {
  const engine = new FakeEngine();
  const monitors = hub(engine);

  const detachPreview = monitors.subscribe("preview", "fill", () => {});
  monitors.subscribe("program", "fill", () => {});
  await settle();

  assert.deepEqual(engine.verbs.sort(), [
    "start:playout_monitor_preview_fill",
    "start:playout_monitor_program_fill"
  ].sort());

  // Closing the Preview panel must not disturb Program.
  detachPreview();
  await settle();
  assert.equal(engine.running.has("playout_monitor_program_fill"), true);
  assert.equal(engine.running.has("playout_monitor_preview_fill"), false);
});

test("a frame is decoded once and shared by every subscriber", async () => {
  const engine = new FakeEngine();
  const monitors = hub(engine);

  const seen = [];
  monitors.subscribe("program", "fill", (frame) => seen.push(frame));
  monitors.subscribe("program", "fill", (frame) => seen.push(frame));
  await settle();

  engine.pushFrame("playout_monitor_program_fill");
  assert.equal(seen.length, 2);
  // Identity, not equality: decoding per subscriber would scale cost with viewers for
  // bytes that are the same.
  assert.equal(seen[0].bytes, seen[1].bytes);
  assert.equal(seen[0].bytes.toString(), "hi");
  assert.equal(seen[0].width, 640);
  assert.equal(seen[0].sceneId, "001");
});

test("a frame for an unknown stream is ignored", async () => {
  const engine = new FakeEngine();
  const monitors = hub(engine);

  const seen = [];
  monitors.subscribe("program", "fill", (frame) => seen.push(frame));
  await settle();

  engine.pushFrame("someone_elses_stream");
  assert.equal(seen.length, 0);
  engine.pushFrame("playout_monitor_program_fill");
  assert.equal(seen.length, 1);
});

test("a detached viewer stops receiving frames", async () => {
  const engine = new FakeEngine();
  const monitors = hub(engine);

  const seen = [];
  const detach = monitors.subscribe("program", "fill", (frame) => seen.push(frame));
  const stay = monitors.subscribe("program", "fill", () => {});
  await settle();

  engine.pushFrame("playout_monitor_program_fill");
  detach();
  engine.pushFrame("playout_monitor_program_fill");

  assert.equal(seen.length, 1);
  stay();
});

test("losing the engine restarts streams that still have viewers", async () => {
  const engine = new FakeEngine();
  const monitors = hub(engine);

  monitors.subscribe("program", "fill", () => {});
  await settle();
  engine.pushFrame("playout_monitor_program_fill");
  assert.equal(monitors.status().find((c) => c.channel === "program" && c.view === "fill").live, true);

  // The engine drops every stream owned by a disconnected client, so what the hub
  // believed was running is gone.
  engine.emit({ type: "closed", reason: "engine restarted" });
  await settle();

  assert.deepEqual(engine.verbs, [
    "start:playout_monitor_program_fill",
    "start:playout_monitor_program_fill"
  ]);
  const status = monitors.status().find((c) => c.channel === "program" && c.view === "fill");
  assert.equal(status.live, false, "a monitor must not claim to be live on a stale frame");
  // A successful restart leaves no error to report: the reason is only worth surfacing
  // while recovery is still failing.
  assert.equal(status.lastError, null);

  // And the restarted stream delivers again.
  engine.pushFrame("playout_monitor_program_fill");
  assert.equal(monitors.status().find((c) => c.channel === "program" && c.view === "fill").live, true);
});

test("a failing restart keeps reporting why", async () => {
  const engine = new FakeEngine();
  const monitors = hub(engine);

  monitors.subscribe("program", "fill", () => {});
  await settle();
  engine.pushFrame("playout_monitor_program_fill");

  // The engine is gone and stays gone, so the reason must survive for the operator.
  engine.failStart = true;
  engine.emit({ type: "closed", reason: "engine restarted" });
  await settle();
  await settle();

  const status = monitors.status().find((c) => c.channel === "program" && c.view === "fill");
  assert.equal(status.live, false);
  assert.equal(status.lastError, "no scene is on program");
});

test("losing the engine does not restart a channel nobody is watching", async () => {
  const engine = new FakeEngine();
  const monitors = hub(engine);

  const detach = monitors.subscribe("program", "fill", () => {});
  await settle();
  detach();
  await settle();
  engine.verbs.length = 0;

  engine.emit({ type: "state", state: "offline", previous: "ready", reason: "gone" });
  await settle();
  assert.deepEqual(engine.verbs, []);
});

test("a viewer that leaves while the stream is starting does not leave it running", async () => {
  const engine = new FakeEngine();
  let release;
  engine.startGate = new Promise((resolve) => {
    release = resolve;
  });
  const monitors = hub(engine);

  const detach = monitors.subscribe("program", "fill", () => {});
  detach();
  release();
  await settle();
  await settle();

  // Started because the request was already in flight, then released immediately.
  assert.deepEqual(engine.verbs, ["start:playout_monitor_program_fill", "stop:playout_monitor_program_fill"]);
  assert.equal(engine.running.size, 0);
});

test("a refused start is reported rather than thrown at the viewer", async () => {
  const engine = new FakeEngine({ failStart: true });
  const monitors = hub(engine);

  // Subscribing must not reject: an HTTP monitor request cannot fail because nothing
  // is cued yet.
  monitors.subscribe("program", "fill", () => {});
  await settle();
  await settle();

  const status = monitors.status().find((c) => c.channel === "program" && c.view === "fill");
  assert.equal(status.live, false);
  assert.equal(status.viewers, 1);
  assert.equal(status.lastError, "no scene is on program");
});

test("a channel goes stale when frames stop arriving", async () => {
  const engine = new FakeEngine();
  let clock = 1_000;
  const monitors = hub(engine, { staleAfterMs: 500, now: () => clock });

  monitors.subscribe("program", "fill", () => {});
  await settle();
  engine.pushFrame("playout_monitor_program_fill");
  assert.equal(monitors.status().find((c) => c.channel === "program" && c.view === "fill").live, true);

  // One skipped tick is not a fault; a silent stream is.
  clock += 400;
  assert.equal(monitors.status().find((c) => c.channel === "program" && c.view === "fill").live, true);
  clock += 200;
  assert.equal(monitors.status().find((c) => c.channel === "program" && c.view === "fill").live, false);
});

test("closing the hub releases every running stream", async () => {
  const engine = new FakeEngine();
  const monitors = hub(engine);

  monitors.subscribe("preview", "fill", () => {});
  monitors.subscribe("program", "fill", () => {});
  await settle();

  await monitors.close();
  assert.equal(engine.running.size, 0);
  assert.equal(engine.listeners.size, 0, "the event subscription must be detached");
});

test("status reports every channel and view before anything is watched", () => {
  const monitors = hub(new FakeEngine());
  const status = monitors.status();
  // Fill and key are separate surfaces: an operator can watch either on either channel,
  // and each carries its own viewer count and stream.
  assert.deepEqual(
    status.map((entry) => `${entry.channel}/${entry.view}`),
    ["preview/fill", "preview/key", "program/fill", "program/key"]
  );
  assert.equal(status.every((entry) => entry.live === false && entry.viewers === 0), true);
});

test("fill and key on one channel are independent streams", async () => {
  const engine = new FakeEngine();
  const monitors = hub(engine);

  const fillFrames = [];
  const keyFrames = [];
  const detachFill = monitors.subscribe("program", "fill", (frame) => fillFrames.push(frame));
  monitors.subscribe("program", "key", (frame) => keyFrames.push(frame));
  await settle();

  assert.deepEqual(engine.verbs.sort(), [
    "start:playout_monitor_program_fill",
    "start:playout_monitor_program_key"
  ]);

  // A key frame must not be delivered to the fill viewer: they are different pictures, and
  // showing a matte where an operator expects colour would misreport what is on air.
  engine.pushFrame("playout_monitor_program_key");
  assert.equal(keyFrames.length, 1);
  assert.equal(fillFrames.length, 0);

  // Closing the fill panel leaves the key running.
  detachFill();
  await settle();
  assert.equal(engine.running.has("playout_monitor_program_key"), true);
  assert.equal(engine.running.has("playout_monitor_program_fill"), false);
});

test("the requested view is what the engine is asked for", async () => {
  const engine = new FakeEngine();
  const monitors = hub(engine);

  monitors.subscribe("preview", "key", () => {});
  await settle();

  const request = engine.requests.at(-1);
  assert.equal(request.view, "key");
  assert.equal(request.channel, "preview");
});

test("windowed output gets an independent native-resolution stream", async () => {
  const engine = new FakeEngine();
  const monitors = hub(engine);
  const confidenceFrames = [];
  const outputFrames = [];

  monitors.subscribe("program", "fill", (frame) => confidenceFrames.push(frame));
  monitors.subscribe("program", "fill", (frame) => outputFrames.push(frame), "output");
  await settle();

  const confidence = engine.requests.find(
    (request) => request.streamId === "playout_monitor_program_fill"
  );
  const output = engine.requests.find(
    (request) => request.streamId === "playout_output_program_fill"
  );
  assert.deepEqual(
    {
      maxWidth: confidence.maxWidth,
      maxHeight: confidence.maxHeight,
      quality: confidence.quality
    },
    { maxWidth: 640, maxHeight: 360, quality: 70 }
  );
  assert.deepEqual(
    {
      maxWidth: output.maxWidth,
      maxHeight: output.maxHeight,
      quality: output.quality
    },
    { maxWidth: 50_000, maxHeight: 50_000, quality: 92 }
  );

  // The output stream is addressed separately, so its canvas-sized frame cannot enlarge
  // or replace the confidence panel's cheap stream.
  engine.pushFrame("playout_output_program_fill", { width: 1920, height: 1080 });
  assert.equal(outputFrames.length, 1);
  assert.equal(confidenceFrames.length, 0);
  const outputStatus = monitors.status().find((entry) => entry.tier === "output");
  assert.deepEqual(
    {
      channel: outputStatus.channel,
      view: outputStatus.view,
      tier: outputStatus.tier,
      live: outputStatus.live,
      viewers: outputStatus.viewers,
      targetFps: outputStatus.targetFps,
      framesReceived: outputStatus.framesReceived,
      width: outputStatus.width,
      height: outputStatus.height,
      sceneId: outputStatus.sceneId,
      lastError: outputStatus.lastError
    },
    {
      channel: "program",
      view: "fill",
      tier: "output",
      live: true,
      viewers: 1,
      targetFps: 30,
      framesReceived: 1,
      width: 1920,
      height: 1080,
      sceneId: "001",
      lastError: null
    }
  );
});

test("a viewer attached before anything is cued starts painting when a scene arrives", async () => {
  const engine = new FakeEngine({ failStart: true });
  const monitors = hub(engine, { retryMs: 10 });

  const seen = [];
  // The operator opens the panel while Program is empty. The engine refuses, because
  // there is nothing to render.
  monitors.subscribe("program", "fill", (frame) => seen.push(frame));
  await settle();
  await settle();
  assert.equal(monitors.status().find((c) => c.channel === "program" && c.view === "fill").lastError, "no scene is on program");

  // A scene is taken. The viewer's connection was never reopened, so the retry has to
  // come from the hub — otherwise the operator would stare at a slate over a live scene.
  engine.failStart = false;
  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.equal(engine.running.has("playout_monitor_program_fill"), true);
  engine.pushFrame("playout_monitor_program_fill");
  assert.equal(seen.length, 1, "the frame must reach the viewer that never reconnected");
  const status = monitors.status().find((c) => c.channel === "program" && c.view === "fill");
  assert.equal(status.live, true);
  assert.equal(status.lastError, null, "a recovered channel must not keep reporting the old refusal");
});

test("retries stop when the last viewer leaves", async () => {
  const engine = new FakeEngine({ failStart: true });
  const monitors = hub(engine, { retryMs: 10 });

  const detach = monitors.subscribe("program", "fill", () => {});
  await settle();
  await settle();
  detach();
  await settle();

  const attemptsAtDetach = engine.verbs.filter((verb) => verb.startsWith("start:")).length;
  await new Promise((resolve) => setTimeout(resolve, 80));
  const attemptsLater = engine.verbs.filter((verb) => verb.startsWith("start:")).length;

  assert.equal(attemptsLater, attemptsAtDetach, "an unwatched channel must stop asking");
});

test("many viewers of a refused channel share one retry", async () => {
  const engine = new FakeEngine({ failStart: true });
  const monitors = hub(engine, { retryMs: 25 });

  // Three panels open on an empty channel must not triple the refusal rate.
  monitors.subscribe("program", "fill", () => {});
  monitors.subscribe("program", "fill", () => {});
  monitors.subscribe("program", "fill", () => {});
  await settle();
  await settle();
  await new Promise((resolve) => setTimeout(resolve, 60));

  const attempts = engine.verbs.filter((verb) => verb.startsWith("start:")).length;
  assert.ok(attempts >= 2, `expected retries to happen, saw ${attempts}`);
  assert.ok(attempts <= 4, `expected one retry per interval, saw ${attempts}`);
});

test("a scene arriving on a channel starts a refused stream at once", async () => {
  const engine = new FakeEngine({ failStart: true });
  // A deliberately long retry: the point is that the channel event, not the timer, is what
  // starts the stream. Waiting for a 2s retry meant a 0.4s "in" animation was over before
  // the first frame arrived and the operator saw only the finished graphic.
  const monitors = hub(engine, { retryMs: 60_000 });

  const seen = [];
  monitors.subscribe("program", "fill", (frame) => seen.push(frame));
  await settle();
  await settle();
  assert.equal(engine.running.has("playout_monitor_program_fill"), false);

  // The engine announces a take. The stream must start now.
  engine.failStart = false;
  engine.emit({
    type: "engine-event",
    eventType: "event.channelChanged",
    message: { payload: { channel: "program", sceneId: "001", onAir: true } }
  });
  await settle();
  await settle();

  assert.equal(engine.running.has("playout_monitor_program_fill"), true);
  engine.pushFrame("playout_monitor_program_fill");
  assert.equal(seen.length, 1, "the viewer that was already attached must receive the frame");
});

test("a channel change starts every watched view of that channel", async () => {
  const engine = new FakeEngine({ failStart: true });
  const monitors = hub(engine, { retryMs: 60_000 });

  monitors.subscribe("program", "fill", () => {});
  monitors.subscribe("program", "key", () => {});
  await settle();
  await settle();

  engine.failStart = false;
  engine.emit({
    type: "engine-event",
    eventType: "event.channelChanged",
    message: { payload: { channel: "program", sceneId: "001", onAir: true } }
  });
  await settle();
  await settle();

  assert.equal(engine.running.has("playout_monitor_program_fill"), true);
  assert.equal(engine.running.has("playout_monitor_program_key"), true);
});

test("a channel change does not start a channel nobody is watching", async () => {
  const engine = new FakeEngine({ failStart: true });
  const monitors = hub(engine, { retryMs: 60_000 });

  monitors.subscribe("program", "fill", () => {});
  await settle();
  await settle();
  engine.failStart = false;
  engine.verbs.length = 0;

  // Preview has no viewer, so nothing should be started for it.
  engine.emit({
    type: "engine-event",
    eventType: "event.channelChanged",
    message: { payload: { channel: "preview", sceneId: "001", onAir: false } }
  });
  await settle();
  await settle();

  assert.deepEqual(engine.verbs, []);
});

test("a channel change for an already running stream is ignored", async () => {
  const engine = new FakeEngine();
  const monitors = hub(engine);

  monitors.subscribe("program", "fill", () => {});
  await settle();
  assert.deepEqual(engine.verbs, ["start:playout_monitor_program_fill"]);

  // A second take on a channel already being streamed must not restart it: that would drop
  // frames in the middle of the animation it is meant to show.
  engine.emit({
    type: "engine-event",
    eventType: "event.channelChanged",
    message: { payload: { channel: "program", sceneId: "002", onAir: true } }
  });
  await settle();
  await settle();

  assert.deepEqual(engine.verbs, ["start:playout_monitor_program_fill"]);
});
