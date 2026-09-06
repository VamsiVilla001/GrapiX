import assert from "node:assert/strict";
import test from "node:test";

import {
  approximateFps,
  compareFingerprints,
  createPlaybackForTimeline,
  deadlineNanos,
  formatTimecode,
  FRAME_RATE_PRESETS,
  frameAtNanos,
  frameDurationMs,
  frameDurationNanos,
  FrameClock,
  frameRatePreset,
  frameRatesEqual,
  framesForSeconds,
  frameToTimecode,
  isDropFrameRate,
  NANOS_PER_SECOND,
  rationalFromDecimal,
  evaluateFrame,
  sceneStateFingerprint,
  secondsForFrames,
  timelineFrameRate,
  TransitionController,
  verifyEvaluationStability,
  ScenePlayback
} from "../dist/index.js";

// ---------------------------------------------------------------------------
// Rational frame rates
// ---------------------------------------------------------------------------

test("every required frame rate is representable exactly", () => {
  assert.deepEqual(frameRatePreset("23.976"), { numerator: 24_000, denominator: 1_001 });
  assert.deepEqual(frameRatePreset("24"), { numerator: 24, denominator: 1 });
  assert.deepEqual(frameRatePreset("25"), { numerator: 25, denominator: 1 });
  assert.deepEqual(frameRatePreset("29.97"), { numerator: 30_000, denominator: 1_001 });
  assert.deepEqual(frameRatePreset("30"), { numerator: 30, denominator: 1 });
  assert.deepEqual(frameRatePreset("50"), { numerator: 50, denominator: 1 });
  assert.deepEqual(frameRatePreset("59.94"), { numerator: 60_000, denominator: 1_001 });
  assert.deepEqual(frameRatePreset("60"), { numerator: 60, denominator: 1 });
  assert.equal(Object.keys(FRAME_RATE_PRESETS).length, 8);
});

test("29.97 is not 29.97, and that is the whole point", () => {
  const rate = frameRatePreset("29.97");
  const exact = approximateFps(rate);

  assert.notEqual(exact, 29.97);
  assert.ok(Math.abs(exact - 29.97002997002997) < 1e-12);

  // One hour of frames is exactly 3603.6 seconds at 30000/1001.
  const oneHourFrames = 30 * 60 * 60;
  const exactSeconds = secondsForFrames(rate, oneHourFrames);
  assert.equal(exactSeconds, 3_603.6);

  // Treating the rate as the decimal 29.97 loses about 3.6 ms per hour, which is
  // 87 ms a day and over half a frame a week of continuous playout.
  const naiveSeconds = oneHourFrames / 29.97;
  const errorPerHour = Math.abs(exactSeconds - naiveSeconds);
  assert.ok(errorPerHour > 0.003, `expected > 3ms error per hour, got ${errorPerHour}s`);
  assert.ok(errorPerHour < 0.004);
  assert.ok(errorPerHour * 24 * 7 * approximateFps(rate) > 0.5, "should exceed half a frame a week");
});

test("decimal rates snap to the drop-frame family", () => {
  assert.deepEqual(rationalFromDecimal(29.97), { numerator: 30_000, denominator: 1_001 });
  assert.deepEqual(rationalFromDecimal(59.94), { numerator: 60_000, denominator: 1_001 });
  assert.deepEqual(rationalFromDecimal(23.976), { numerator: 24_000, denominator: 1_001 });
  assert.deepEqual(rationalFromDecimal(50), { numerator: 50, denominator: 1 });

  // A genuinely custom rate is preserved rather than snapped.
  assert.deepEqual(rationalFromDecimal(48), { numerator: 48, denominator: 1 });
  assert.deepEqual(rationalFromDecimal(12.5), { numerator: 12_500, denominator: 1_000 });

  // Nonsense falls back to a documented default.
  assert.deepEqual(rationalFromDecimal(0), { numerator: 25, denominator: 1 });
  assert.deepEqual(rationalFromDecimal(Number.NaN), { numerator: 25, denominator: 1 });
});

test("frame rate equality is by value, not by representation", () => {
  assert.equal(
    frameRatesEqual({ numerator: 30, denominator: 1 }, { numerator: 60, denominator: 2 }),
    true
  );
  assert.equal(
    frameRatesEqual({ numerator: 30, denominator: 1 }, { numerator: 30_000, denominator: 1_001 }),
    false
  );
});

test("drop-frame rates are identified by their denominator", () => {
  assert.equal(isDropFrameRate(frameRatePreset("29.97")), true);
  assert.equal(isDropFrameRate(frameRatePreset("59.94")), true);
  assert.equal(isDropFrameRate(frameRatePreset("30")), false);
  assert.equal(isDropFrameRate(frameRatePreset("25")), false);
});

// ---------------------------------------------------------------------------
// Deadlines
// ---------------------------------------------------------------------------

test("deadlines are computed from the frame number, so they cannot drift", () => {
  const rate = frameRatePreset("59.94");

  // 60000 frames at 60000/1001 fps is exactly 1001 seconds — the defining
  // property of the drop-frame family, and exact in integer nanoseconds.
  assert.equal(deadlineNanos(rate, 0), 0);
  assert.equal(deadlineNanos(rate, 60_000), 1_001 * NANOS_PER_SECOND);

  // One frame is 16683333.33... ns. It is not a whole number of nanoseconds,
  // which is exactly why accumulating the interval drifts and computing from the
  // frame number does not.
  const interval = frameDurationNanos(rate);
  assert.equal(interval, 16_683_333);

  // Ten million frames is about 46 hours of continuous playout. Accumulating the
  // rounded interval is 3.3 ms out by then; computing from the frame number is
  // exact at every frame.
  const frames = 10_000_000;
  const computed = deadlineNanos(rate, frames);
  const accumulated = interval * frames;
  const drift = Math.abs(computed - accumulated);

  assert.ok(drift > 3_000_000, `expected > 3ms accumulation drift, got ${drift}ns`);
  // And the exact value is recoverable at any frame, not just the first.
  assert.equal(computed, 166_833_333_333_333);
});

test("deadline delegation preserves Rust-compatible truncation at 59.94", () => {
  const rate = frameRatePreset("59.94");
  assert.equal(deadlineNanos(rate, 2), 33_366_666);
  assert.equal(deadlineNanos(rate, 215_784), 3_599_996_400_000);
});

test("frame and time conversions round-trip", () => {
  const rate = frameRatePreset("25");

  assert.equal(frameDurationNanos(rate), 40_000_000);
  assert.equal(frameDurationMs(rate), 40);
  assert.equal(framesForSeconds(rate, 2), 50);
  assert.equal(secondsForFrames(rate, 50), 2);
  assert.equal(frameAtNanos(rate, NANOS_PER_SECOND), 25);
  // Just before the boundary is still the previous frame.
  assert.equal(frameAtNanos(rate, NANOS_PER_SECOND - 1), 24);
});

// ---------------------------------------------------------------------------
// Timecode
// ---------------------------------------------------------------------------

test("non-drop timecode counts plainly", () => {
  const rate = frameRatePreset("25");

  assert.deepEqual(frameToTimecode(rate, 0), {
    hours: 0,
    minutes: 0,
    seconds: 0,
    frames: 0,
    dropFrame: false
  });
  assert.equal(formatTimecode(frameToTimecode(rate, 24)), "00:00:00:24");
  assert.equal(formatTimecode(frameToTimecode(rate, 25)), "00:00:01:00");
  assert.equal(formatTimecode(frameToTimecode(rate, 25 * 60)), "00:01:00:00");
  assert.equal(formatTimecode(frameToTimecode(rate, 25 * 3600)), "01:00:00:00");
});

test("drop-frame timecode uses a semicolon and skips labels, not frames", () => {
  const rate = frameRatePreset("29.97");

  const start = frameToTimecode(rate, 0);
  assert.equal(start.dropFrame, true);
  assert.equal(formatTimecode(start), "00:00:00;00");

  // Minute 0 has a full 1800 frames, so frame 1799 is its last.
  assert.equal(formatTimecode(frameToTimecode(rate, 1_799)), "00:00:59;29");

  // Frame 1800 begins minute 1, where labels ;00 and ;01 are skipped — so the
  // first frame of the minute is labelled ;02. No frame is dropped, only a label.
  const atMinute = frameToTimecode(rate, 1_800);
  assert.equal(atMinute.minutes, 1);
  assert.equal(atMinute.seconds, 0);
  assert.equal(atMinute.frames, 2);
  assert.equal(formatTimecode(atMinute), "00:01:00;02");

  // Every tenth minute drops nothing, so minute 10 starts at ;00 again.
  const atTenMinutes = frameToTimecode(rate, 17_982);
  assert.equal(formatTimecode(atTenMinutes), "00:10:00;00");
});

// ---------------------------------------------------------------------------
// FrameClock
// ---------------------------------------------------------------------------

test("the clock advances one frame per interval", () => {
  const clock = new FrameClock({ rate: frameRatePreset("50") });
  const interval = frameDurationNanos(frameRatePreset("50")); // 20ms

  assert.equal(clock.frame, 0);
  assert.equal(clock.isDue(0), false);
  assert.equal(clock.isDue(interval), true);
  assert.equal(clock.timeUntilNextFrameNanos(0), interval);

  const first = clock.tick(interval);
  assert.equal(first.frame, 1);
  assert.equal(first.droppedFrames, 0);
  assert.equal(first.late, false);

  const second = clock.tick(interval * 2);
  assert.equal(second.frame, 2);
  assert.equal(second.droppedFrames, 0);
});

test("falling behind drops frames instead of playing in slow motion", () => {
  const rate = frameRatePreset("50");
  const clock = new FrameClock({ rate });
  const interval = frameDurationNanos(rate);

  // The renderer stalls for ten frame periods.
  const tick = clock.tick(interval * 10);

  assert.equal(tick.frame, 10, "should jump to the frame that is actually due");
  assert.equal(tick.droppedFrames, 9);
  assert.equal(clock.stats.dropped, 9);
  // The show stays in real time; nine frames were simply not shown.
});

test("late frames are counted and reported", () => {
  const rate = frameRatePreset("50");
  const clock = new FrameClock({ rate });
  const interval = frameDurationNanos(rate);

  const tick = clock.tick(interval + 5_000_000); // 5ms late
  assert.equal(tick.frame, 1);
  assert.equal(tick.late, true);
  assert.equal(tick.latenessNanos, 5_000_000);
  assert.equal(clock.stats.late, 1);
});

test("seek jumps without counting drops", () => {
  const clock = new FrameClock({ rate: frameRatePreset("25") });
  clock.seek(500);

  assert.equal(clock.frame, 500);
  assert.equal(clock.stats.dropped, 0);
  assert.equal(formatTimecode(clock.timecode()), "00:00:20:00");
});

test("a clock can start at a non-zero frame and time", () => {
  const rate = frameRatePreset("25");
  const clock = new FrameClock({ rate, startFrame: 100, startNanos: 5_000_000_000 });

  assert.equal(clock.frame, 100);
  assert.equal(clock.deadlineFor(100), 5_000_000_000);
  assert.equal(clock.deadlineFor(101), 5_040_000_000);
  assert.equal(clock.frameAt(5_040_000_000), 101);
});

// ---------------------------------------------------------------------------
// Playback and markers
// ---------------------------------------------------------------------------

function markers() {
  return [
    { markerId: "m_hold", name: "Await presenter", kind: "continue-point", frame: 25 },
    { markerId: "m_pause", name: "Check data", kind: "pause-point", frame: 60 },
    { markerId: "m_note", name: "Logo lands", kind: "marker", frame: 10 }
  ];
}

test("playback holds at a continue point until released", () => {
  const playback = new ScenePlayback({ durationFrames: 100, markers: markers() });

  playback.cue();
  assert.equal(playback.state, "cued");
  assert.equal(playback.frame, 0);

  playback.play();
  const advance = playback.advance(50);

  // Stopped exactly on the continue point, not past it.
  assert.equal(advance.frame, 25);
  assert.equal(advance.state, "holding");
  assert.equal(advance.stoppedAtMarker.name, "Await presenter");
  // The plain marker at frame 10 was crossed and reported without stopping.
  assert.ok(advance.crossedMarkers.some((marker) => marker.markerId === "m_note"));

  // Continue releases it and does not immediately re-hold on the same marker.
  assert.equal(playback.continueFrom(), true);
  assert.equal(playback.state, "playing");

  const next = playback.advance(10);
  assert.equal(next.frame, 35);
  assert.equal(next.state, "playing");
});

test("playback stops at a pause point and needs play again", () => {
  const playback = new ScenePlayback({ durationFrames: 100, markers: markers() });
  playback.cue(50);
  playback.play();

  const advance = playback.advance(20);
  assert.equal(advance.frame, 60);
  assert.equal(advance.state, "paused");

  // Advancing while paused does nothing.
  assert.equal(playback.advance(5).frame, 60);

  playback.play();
  assert.equal(playback.advance(5).frame, 65);
});

test("advancing many frames at once never skips a marker", () => {
  const playback = new ScenePlayback({ durationFrames: 1_000, markers: markers() });
  playback.cue();
  playback.play();

  // A 100-frame jump must still stop at frame 25.
  const advance = playback.advance(100);
  assert.equal(advance.frame, 25);
  assert.equal(advance.state, "holding");
});

test("continue can jump to a named marker", () => {
  const playback = new ScenePlayback({ durationFrames: 100, markers: markers() });
  playback.cue();
  playback.play();

  assert.equal(playback.continueFrom("Check data"), true);
  assert.equal(playback.frame, 60);
  assert.equal(playback.state, "playing");

  assert.equal(playback.continueFrom("No such marker"), false);
});

test("playback finishes at the end when not looping", () => {
  const playback = new ScenePlayback({ durationFrames: 10 });
  playback.cue();
  playback.play();

  const advance = playback.advance(20);
  assert.equal(advance.frame, 10);
  assert.equal(advance.state, "finished");

  // Playing a finished scene restarts it.
  playback.play();
  assert.equal(playback.state, "playing");
  assert.equal(playback.advance(1).frame, 1);
});

test("non-finite playback values cannot create an unbounded frame loop", () => {
  const playback = new ScenePlayback({ durationFrames: 10 });
  playback.cue();
  playback.play();
  assert.equal(playback.advance(Infinity).frame, 0);

  const transition = new TransitionController();
  transition.start({ transitionId: "invalid", phase: "in", durationFrames: Infinity });
  assert.equal(transition.status.phase, "complete");
});

test("a frame clock rejects non-finite starting positions", () => {
  const clock = new FrameClock({
    rate: frameRatePreset("25"),
    startFrame: Infinity,
    startNanos: NaN
  });
  assert.equal(clock.frame, 0);
  assert.equal(clock.deadlineFor(0), 0);
  clock.seek(NaN);
  assert.equal(clock.frame, 0);
});

test("loop wraps and ping-pong reverses", () => {
  const looping = new ScenePlayback({ durationFrames: 5, loop: "loop" });
  looping.cue();
  looping.play();
  const wrapped = looping.advance(7);
  assert.equal(wrapped.looped, true);
  assert.equal(looping.state, "playing");

  const bouncing = new ScenePlayback({ durationFrames: 5, loop: "ping-pong" });
  bouncing.cue();
  bouncing.play();
  bouncing.advance(6);
  assert.equal(bouncing.playbackDirection, "reverse");
});

test("reverse playback runs backwards to zero", () => {
  const playback = new ScenePlayback({ durationFrames: 10, direction: "reverse" });
  playback.cue(10);
  playback.play();

  assert.equal(playback.advance(4).frame, 6);
  const advance = playback.advance(20);
  assert.equal(advance.frame, 0);
  assert.equal(advance.state, "finished");
});

test("stop returns to the start frame and clears holds", () => {
  const playback = new ScenePlayback({ durationFrames: 100, markers: markers() });
  playback.cue();
  playback.play();
  playback.advance(50);
  assert.equal(playback.state, "holding");

  playback.stop();
  assert.equal(playback.state, "idle");
  assert.equal(playback.frame, 0);
});

test("playback is built from a timeline's own markers and duration", () => {
  const timeline = {
    fps: 25,
    durationFrames: 75,
    keyframes: [],
    markers: markers()
  };

  const playback = createPlaybackForTimeline(timeline);
  playback.cue();
  playback.play();
  assert.equal(playback.advance(100).frame, 25);

  assert.deepEqual(timelineFrameRate(timeline), { numerator: 25, denominator: 1 });
});

test("a legacy timeline's approximate fps resolves to the exact rate", () => {
  assert.deepEqual(timelineFrameRate({ fps: 29.97, durationFrames: 10, keyframes: [] }), {
    numerator: 30_000,
    denominator: 1_001
  });
  assert.deepEqual(timelineFrameRate({ fps: 59.94, durationFrames: 10, keyframes: [] }), {
    numerator: 60_000,
    denominator: 1_001
  });
  // An explicit rate always wins over the legacy field.
  assert.deepEqual(
    timelineFrameRate({
      fps: 25,
      durationFrames: 10,
      keyframes: [],
      frameRate: { numerator: 24_000, denominator: 1_001 }
    }),
    { numerator: 24_000, denominator: 1_001 }
  );
});

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

test("a transition progresses by frames, not by elapsed time", () => {
  const controller = new TransitionController();

  assert.equal(
    controller.start({ transitionId: "t_in", phase: "in", durationFrames: 25 }),
    true
  );
  assert.equal(controller.status.progress, 0);

  controller.advance(10);
  assert.equal(controller.status.frame, 10);
  assert.equal(controller.status.progress, 0.4);

  controller.advance(15);
  assert.equal(controller.status.phase, "complete");
  assert.equal(controller.status.progress, 1);
  assert.equal(controller.isRunning, false);
});

test("a zero-frame transition is a cut and completes immediately", () => {
  const controller = new TransitionController();
  controller.start({ transitionId: "t_cut", phase: "in", durationFrames: 0 });

  assert.equal(controller.status.phase, "complete");
  assert.equal(controller.status.progress, 1);
});

test("starting over a running transition requires an explicit interrupt", () => {
  const controller = new TransitionController();
  controller.start({ transitionId: "t_a", phase: "in", durationFrames: 50 });
  controller.advance(10);

  // Refused: a Take arriving mid-dissolve must be deliberate.
  assert.equal(
    controller.start({ transitionId: "t_b", phase: "out", durationFrames: 25 }),
    false
  );
  assert.equal(controller.status.transitionId, "t_a");

  assert.equal(
    controller.start({ transitionId: "t_b", phase: "out", durationFrames: 25 }, true),
    true
  );
  assert.equal(controller.status.transitionId, "t_b");
  assert.equal(controller.status.interrupted, true);
});

test("reversing mid-transition keeps the visual state continuous", () => {
  const controller = new TransitionController();
  controller.start({ transitionId: "t", phase: "in", durationFrames: 100 });
  controller.advance(30);
  assert.equal(controller.status.progress, 0.3);

  controller.reverseNow();
  // The frame counter is mirrored, so progress stays at 0.3 rather than jumping.
  assert.equal(controller.status.reverse, true);
  assert.equal(controller.status.frame, 70);
  assert.equal(Math.abs(controller.status.progress - 0.3) < 1e-12, true);
});

test("a transition can be scoped to a region or a surface", () => {
  const controller = new TransitionController();
  controller.start({
    transitionId: "t_region",
    phase: "out",
    durationFrames: 12,
    scope: { type: "region", regionId: "region_left" }
  });

  assert.deepEqual(controller.status.scope, { type: "region", regionId: "region_left" });

  controller.reset();
  assert.deepEqual(controller.status.scope, { type: "scene" });
  assert.equal(controller.status.phase, "idle");
});

test("interrupting a transition completes it and records the fact", () => {
  const controller = new TransitionController();
  controller.start({ transitionId: "t", phase: "in", durationFrames: 50 });
  controller.advance(20);

  const status = controller.interrupt();
  assert.equal(status.phase, "complete");
  assert.equal(status.interrupted, true);
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

function animatedScene() {
  return {
    id: "scene_det",
    name: "Determinism",
    version: 1,
    revision: 3,
    canvas: { width: 1920, height: 1080, background: "#000000" },
    dataContext: {},
    assets: [],
    materials: [],
    objects: [
      {
        id: "obj_a",
        name: "Slide",
        type: "rect",
        x: 0,
        y: 100,
        zDepth: 0,
        zIndex: 0,
        layerId: "layer_1",
        visible: true,
        width: 400,
        height: 200,
        opacity: 1,
        animation: {
          x: {
            keys: [
              { id: "k0", frame: 0, value: 0, easing: "linear" },
              { id: "k1", frame: 50, value: 1000, easing: "linear" }
            ]
          }
        }
      },
      {
        id: "obj_b",
        name: "Static",
        type: "text",
        x: 50,
        y: 50,
        zDepth: 0,
        zIndex: 1,
        layerId: "layer_1",
        visible: true,
        text: "Hello"
      }
    ],
    timeline: { fps: 50, durationFrames: 100, keyframes: [] },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

test("the same scene and frame always produce the same fingerprint", () => {
  const scene = animatedScene();

  const a = sceneStateFingerprint(scene, 25);
  const b = sceneStateFingerprint(scene, 25);

  assert.equal(a.hash, b.hash);
  assert.equal(compareFingerprints(a, b).identical, true);
  assert.equal(a.frame, 25);
  assert.equal(a.revision, 3);
  assert.equal(a.objectCount, 2);
});

test("different frames produce different fingerprints for animated content", () => {
  const scene = animatedScene();

  const atStart = sceneStateFingerprint(scene, 0);
  const atMiddle = sceneStateFingerprint(scene, 25);

  assert.notEqual(atStart.hash, atMiddle.hash);

  const parity = compareFingerprints(atStart, atMiddle);
  assert.equal(parity.identical, false);
  // The difference is named precisely: obj_a's x moved.
  const difference = parity.differences.find(
    (candidate) => candidate.objectId === "obj_a" && candidate.property === "x"
  );
  assert.equal(difference.a, 0);
  assert.equal(difference.b, 500);
});

test("fingerprints ignore object iteration order", () => {
  const scene = animatedScene();
  const reordered = { ...scene, objects: [scene.objects[1], scene.objects[0]] };

  assert.equal(
    sceneStateFingerprint(scene, 10).hash,
    sceneStateFingerprint(reordered, 10).hash
  );
});

test("evaluation is stable across repeated calls", () => {
  const result = verifyEvaluationStability(animatedScene(), [0, 10, 25, 50, 99], 5);
  assert.equal(result.stable, true);
  assert.deepEqual(result.unstableFrames, []);
});

test("non-finite frames normalize to the deterministic zero frame", () => {
  const scene = animatedScene();
  assert.deepEqual(evaluateFrame(scene, Infinity), evaluateFrame(scene, 0));
  assert.deepEqual(evaluateFrame(scene, NaN), evaluateFrame(scene, 0));
});

test("fingerprint comparison reports objects present on only one side", () => {
  const scene = animatedScene();
  const withExtra = {
    ...scene,
    objects: [
      ...scene.objects,
      {
        id: "obj_c",
        name: "Extra",
        type: "ellipse",
        x: 0,
        y: 0,
        zDepth: 0,
        zIndex: 2,
        layerId: "layer_1",
        visible: true
      }
    ]
  };

  const parity = compareFingerprints(
    sceneStateFingerprint(scene, 0),
    sceneStateFingerprint(withExtra, 0)
  );

  assert.equal(parity.identical, false);
  assert.deepEqual(parity.onlyInB, ["obj_c"]);
  assert.deepEqual(parity.onlyInA, []);
});
