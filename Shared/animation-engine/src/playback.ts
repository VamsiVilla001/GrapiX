/**
 * Frame-based playback and transitions.
 *
 * Everything here advances by whole frames. There is no `setTimeout`, no
 * millisecond duration, and no wall-clock arithmetic in the state machine — a
 * transition is "25 frames long", and on a 25 fps timeline that is exactly one
 * second whether the machine is keeping up or not.
 *
 * That is what "frame accurate" has to mean in practice: the state at frame N is
 * a function of N, so an engine that renders frame 12 late still renders frame 12
 * correctly.
 */

import type { SceneTimeline, SceneTimelineMarker } from "@grapix/shared-types";

export type PlaybackDirection = "forward" | "reverse";

export const PLAYBACK_STATES = [
  /** Loaded, not cued. */
  "idle",
  /** Parked at the cue frame, ready to play. */
  "cued",
  "playing",
  /** Stopped at a pause point or by the operator. */
  "paused",
  /** Waiting at a continue point for an operator `Continue`. */
  "holding",
  /** Reached the end without looping. */
  "finished"
] as const;
export type PlaybackState = (typeof PLAYBACK_STATES)[number];

export type LoopMode = "none" | "loop" | "ping-pong";

export interface PlaybackOptions {
  durationFrames: number;
  startFrame?: number;
  direction?: PlaybackDirection;
  loop?: LoopMode;
  markers?: readonly SceneTimelineMarker[];
}

export interface PlaybackAdvance {
  frame: number;
  state: PlaybackState;
  /** Markers crossed by this advance, in the order they were passed. */
  crossedMarkers: SceneTimelineMarker[];
  /** Marker the playback is now waiting at, if any. */
  stoppedAtMarker?: SceneTimelineMarker;
  /** True when the playhead wrapped or bounced this step. */
  looped: boolean;
}

/**
 * Scene playback with continue and pause points.
 *
 * Continue points hold until an operator sends `Continue`; pause points stop and
 * require `play` again. The distinction matters on air: a continue point is part
 * of the design ("wait here for the presenter"), a pause point is an
 * intervention.
 */
export class ScenePlayback {
  private readonly durationFrames: number;
  private readonly startFrame: number;
  private readonly markers: SceneTimelineMarker[];
  private direction: PlaybackDirection;
  private loop: LoopMode;
  private currentFrame: number;
  private currentState: PlaybackState = "idle";
  /** Marker already honoured, so `Continue` does not immediately re-hold. */
  private releasedMarkerId: string | null = null;

  constructor(options: PlaybackOptions) {
    this.durationFrames = Math.max(0, Math.floor(options.durationFrames));
    this.startFrame = clampFrame(options.startFrame ?? 0, this.durationFrames);
    this.direction = options.direction ?? "forward";
    this.loop = options.loop ?? "none";
    this.markers = [...(options.markers ?? [])].sort((a, b) => a.frame - b.frame);
    this.currentFrame = this.startFrame;
  }

  get frame(): number {
    return this.currentFrame;
  }

  get state(): PlaybackState {
    return this.currentState;
  }

  get playbackDirection(): PlaybackDirection {
    return this.direction;
  }

  /** Park at a frame, ready to play. */
  cue(frame?: number): void {
    this.currentFrame = clampFrame(frame ?? this.startFrame, this.durationFrames);
    this.currentState = "cued";
    this.releasedMarkerId = null;
  }

  play(): void {
    if (this.currentState === "finished") {
      // Playing a finished scene restarts it rather than doing nothing.
      this.currentFrame = this.direction === "forward" ? 0 : this.durationFrames;
    }
    this.currentState = "playing";
  }

  pause(): void {
    if (this.currentState === "playing" || this.currentState === "holding") {
      this.currentState = "paused";
    }
  }

  /**
   * Release a hold, or jump to a named marker.
   *
   * The released marker is remembered so the very next advance does not stop at
   * the same point again.
   */
  continueFrom(markerName?: string): boolean {
    if (markerName !== undefined) {
      const marker = this.markers.find((candidate) => candidate.name === markerName);
      if (!marker) return false;
      this.currentFrame = clampFrame(marker.frame, this.durationFrames);
      this.releasedMarkerId = marker.markerId;
      this.currentState = "playing";
      return true;
    }

    if (this.currentState !== "holding" && this.currentState !== "paused") return false;

    const here = this.markerAtFrame(this.currentFrame);
    this.releasedMarkerId = here?.markerId ?? null;
    this.currentState = "playing";
    return true;
  }

  stop(): void {
    this.currentState = "idle";
    this.currentFrame = this.startFrame;
    this.releasedMarkerId = null;
  }

  setDirection(direction: PlaybackDirection): void {
    this.direction = direction;
  }

  setLoop(loop: LoopMode): void {
    this.loop = loop;
  }

  /** Scrub without changing playback state. */
  seek(frame: number): void {
    this.currentFrame = clampFrame(frame, this.durationFrames);
    this.releasedMarkerId = null;
  }

  /**
   * Advance by whole frames.
   *
   * Steps one frame at a time so a marker is never skipped when several frames
   * are advanced at once — dropping frames must not drop a continue point.
   */
  advance(frames = 1): PlaybackAdvance {
    const crossed: SceneTimelineMarker[] = [];
    let looped = false;
    let stoppedAtMarker: SceneTimelineMarker | undefined;

    if (this.currentState !== "playing") {
      return { frame: this.currentFrame, state: this.currentState, crossedMarkers: crossed, looped };
    }

    const steps = Math.max(0, Math.floor(frames));

    for (let step = 0; step < steps; step += 1) {
      const next = this.direction === "forward" ? this.currentFrame + 1 : this.currentFrame - 1;

      if (next > this.durationFrames || next < 0) {
        const wrapped = this.handleBoundary();
        looped = looped || wrapped;
        if (this.currentState !== "playing") break;
        continue;
      }

      this.currentFrame = next;

      const marker = this.markerAtFrame(next);
      if (!marker) continue;

      crossed.push(marker);

      if (marker.markerId === this.releasedMarkerId) continue;

      if (marker.kind === "continue-point") {
        this.currentState = "holding";
        stoppedAtMarker = marker;
        break;
      }
      if (marker.kind === "pause-point") {
        this.currentState = "paused";
        stoppedAtMarker = marker;
        break;
      }
      if (marker.kind === "loop-end" && this.loop === "loop") {
        const loopStart = this.markers.find((candidate) => candidate.kind === "loop-start");
        this.currentFrame = loopStart ? clampFrame(loopStart.frame, this.durationFrames) : 0;
        looped = true;
      }
    }

    // Any marker other than the one we stopped at stops shadowing future holds.
    if (stoppedAtMarker === undefined && crossed.length > 0) {
      this.releasedMarkerId = null;
    }

    return {
      frame: this.currentFrame,
      state: this.currentState,
      crossedMarkers: crossed,
      looped,
      ...(stoppedAtMarker ? { stoppedAtMarker } : {})
    };
  }

  markerAtFrame(frame: number): SceneTimelineMarker | undefined {
    return this.markers.find((marker) => marker.frame === frame);
  }

  markersOfKind(kind: SceneTimelineMarker["kind"]): SceneTimelineMarker[] {
    return this.markers.filter((marker) => marker.kind === kind);
  }

  private handleBoundary(): boolean {
    switch (this.loop) {
      case "loop":
        this.currentFrame = this.direction === "forward" ? 0 : this.durationFrames;
        return true;
      case "ping-pong":
        this.direction = this.direction === "forward" ? "reverse" : "forward";
        return true;
      case "none":
      default:
        this.currentFrame = this.direction === "forward" ? this.durationFrames : 0;
        this.currentState = "finished";
        return false;
    }
  }
}

function clampFrame(frame: number, durationFrames: number): number {
  if (!Number.isFinite(frame)) return 0;
  return Math.min(durationFrames, Math.max(0, Math.floor(frame)));
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

export const TRANSITION_PHASES = ["idle", "in", "loop", "out", "complete"] as const;
export type TransitionPhase = (typeof TRANSITION_PHASES)[number];

export type TransitionScope =
  | { type: "scene" }
  | { type: "region"; regionId: string }
  | { type: "surface"; surfaceId: string };

export interface TransitionRequest {
  transitionId: string;
  phase: Exclude<TransitionPhase, "idle" | "complete">;
  durationFrames: number;
  scope?: TransitionScope;
  /** Play the transition backwards. */
  reverse?: boolean;
}

export interface TransitionStatus {
  transitionId: string | null;
  phase: TransitionPhase;
  frame: number;
  durationFrames: number;
  /** 0..1, and exactly 1 on the final frame. */
  progress: number;
  reverse: boolean;
  scope: TransitionScope;
  interrupted: boolean;
}

/**
 * Frame-accurate transition state.
 *
 * `progress` is derived from the frame counter, so a late frame still gets the
 * correct progress value rather than a value based on how long the renderer
 * actually took.
 *
 * A zero-frame transition is a cut: it completes on the frame it starts.
 */
export class TransitionController {
  private transitionId: string | null = null;
  private phase: TransitionPhase = "idle";
  private frame = 0;
  private durationFrames = 0;
  private reverse = false;
  private scope: TransitionScope = { type: "scene" };
  private interrupted = false;

  get status(): TransitionStatus {
    return {
      transitionId: this.transitionId,
      phase: this.phase,
      frame: this.frame,
      durationFrames: this.durationFrames,
      progress: this.progress(),
      reverse: this.reverse,
      scope: this.scope,
      interrupted: this.interrupted
    };
  }

  get isRunning(): boolean {
    return this.phase === "in" || this.phase === "out" || this.phase === "loop";
  }

  /**
   * Begin a transition.
   *
   * Refuses to start over a running transition unless `interrupt` is set: a
   * `Take` arriving mid-dissolve must be an explicit decision, not an accident.
   */
  start(request: TransitionRequest, interrupt = false): boolean {
    if (this.isRunning && !interrupt) return false;

    this.interrupted = this.isRunning && interrupt;
    this.transitionId = request.transitionId;
    this.phase = request.phase;
    this.durationFrames = Math.max(0, Math.floor(request.durationFrames));
    this.frame = 0;
    this.reverse = request.reverse === true;
    this.scope = request.scope ?? { type: "scene" };

    if (this.durationFrames === 0) {
      // A cut: complete on the frame it starts.
      this.phase = "complete";
    }

    return true;
  }

  /** Advance by whole frames and report the resulting state. */
  advance(frames = 1): TransitionStatus {
    if (!this.isRunning) return this.status;

    this.frame = Math.min(this.durationFrames, this.frame + Math.max(0, Math.floor(frames)));
    if (this.frame >= this.durationFrames) {
      this.phase = "complete";
    }
    return this.status;
  }

  /** Stop where it is. The caller decides what the output should show. */
  interrupt(): TransitionStatus {
    if (this.isRunning) {
      this.interrupted = true;
      this.phase = "complete";
    }
    return this.status;
  }

  /**
   * Play the remainder backwards from the current position.
   *
   * Used when an operator changes their mind mid-transition: the frame counter is
   * mirrored so the visual state is continuous rather than jumping.
   */
  reverseNow(): TransitionStatus {
    if (!this.isRunning) return this.status;
    this.reverse = !this.reverse;
    this.frame = this.durationFrames - this.frame;
    return this.status;
  }

  reset(): void {
    this.transitionId = null;
    this.phase = "idle";
    this.frame = 0;
    this.durationFrames = 0;
    this.reverse = false;
    this.scope = { type: "scene" };
    this.interrupted = false;
  }

  private progress(): number {
    if (this.phase === "complete") return this.reverse ? 0 : 1;
    if (this.phase === "idle" || this.durationFrames === 0) return 0;
    const linear = this.frame / this.durationFrames;
    return this.reverse ? 1 - linear : linear;
  }
}

// ---------------------------------------------------------------------------
// Timeline helpers
// ---------------------------------------------------------------------------

/** Exact frame rate of a timeline, deriving it from `fps` on legacy documents. */
export function timelineFrameRate(timeline: SceneTimeline): {
  numerator: number;
  denominator: number;
} {
  if (
    timeline.frameRate
    && timeline.frameRate.numerator > 0
    && timeline.frameRate.denominator > 0
  ) {
    return { ...timeline.frameRate };
  }
  // Legacy path: `fps` holds an approximation such as 29.97.
  const fps = timeline.fps;
  if (Math.abs(fps - 30_000 / 1_001) < 0.01) return { numerator: 30_000, denominator: 1_001 };
  if (Math.abs(fps - 60_000 / 1_001) < 0.01) return { numerator: 60_000, denominator: 1_001 };
  if (Math.abs(fps - 24_000 / 1_001) < 0.01) return { numerator: 24_000, denominator: 1_001 };
  if (Number.isInteger(fps) && fps > 0) return { numerator: fps, denominator: 1 };
  return { numerator: 25, denominator: 1 };
}

export function timelineMarkers(timeline: SceneTimeline): SceneTimelineMarker[] {
  return [...(timeline.markers ?? [])].sort((a, b) => a.frame - b.frame);
}

export function continuePoints(timeline: SceneTimeline): SceneTimelineMarker[] {
  return timelineMarkers(timeline).filter((marker) => marker.kind === "continue-point");
}

export function pausePoints(timeline: SceneTimeline): SceneTimelineMarker[] {
  return timelineMarkers(timeline).filter((marker) => marker.kind === "pause-point");
}

export function findMarker(
  timeline: SceneTimeline,
  name: string
): SceneTimelineMarker | undefined {
  return timelineMarkers(timeline).find((marker) => marker.name === name);
}

/** Create a playback for a timeline, honouring its markers. */
export function createPlaybackForTimeline(
  timeline: SceneTimeline,
  options: Omit<PlaybackOptions, "durationFrames" | "markers"> = {}
): ScenePlayback {
  return new ScenePlayback({
    ...options,
    durationFrames: timeline.durationFrames,
    markers: timelineMarkers(timeline)
  });
}
