/**
 * Broadcast frame clock.
 *
 * Two rules, and everything else follows from them:
 *
 * 1. **Frame rates are rational, never decimal.** 29.97 is 30000/1001 and 59.94
 *    is 60000/1001. Storing them as floats accumulates drift; at 59.94 the error
 *    from using 59.94 exactly is about 0.6 frames per hour, so a show that runs
 *    all day ends up visibly out.
 *
 * 2. **Deadlines are integer arithmetic on an absolute schedule.** Not
 *    `previous + interval`, which compounds every rounding error, and not
 *    `requestAnimationFrame`, which is paced by a compositor that knows nothing
 *    about the show.
 *
 * `deadlineNanos(n) = round(n * 1e9 * denominator / numerator)` is computed from
 * the frame number every time, so error never accumulates: frame one million is
 * as accurate as frame one.
 */

import type { RationalFrameRate } from "@grapix/shared-types";

export const NANOS_PER_SECOND = 1_000_000_000;

/** The standard broadcast rates, exactly. */
export const FRAME_RATE_PRESETS = Object.freeze({
  "23.976": Object.freeze({ numerator: 24_000, denominator: 1_001 }),
  "24": Object.freeze({ numerator: 24, denominator: 1 }),
  "25": Object.freeze({ numerator: 25, denominator: 1 }),
  "29.97": Object.freeze({ numerator: 30_000, denominator: 1_001 }),
  "30": Object.freeze({ numerator: 30, denominator: 1 }),
  "50": Object.freeze({ numerator: 50, denominator: 1 }),
  "59.94": Object.freeze({ numerator: 60_000, denominator: 1_001 }),
  "60": Object.freeze({ numerator: 60, denominator: 1 })
}) as Readonly<Record<string, RationalFrameRate>>;

export type FrameRatePresetName = keyof typeof FRAME_RATE_PRESETS;

export function frameRatePreset(name: string): RationalFrameRate | undefined {
  const preset = FRAME_RATE_PRESETS[name];
  return preset ? { ...preset } : undefined;
}

/**
 * Best rational representation of a decimal rate.
 *
 * Recognises the drop-frame family by proximity rather than exact equality,
 * because `SceneTimeline.fps` on a legacy document holds 29.97 and the exact
 * value is 29.97002997..., so an equality test would miss it.
 */
export function rationalFromDecimal(fps: number): RationalFrameRate {
  if (!Number.isFinite(fps) || fps <= 0) {
    return { numerator: 25, denominator: 1 };
  }

  for (const preset of Object.values(FRAME_RATE_PRESETS)) {
    const exact = preset.numerator / preset.denominator;
    if (Math.abs(exact - fps) < 0.01) {
      return { ...preset };
    }
  }

  // A user-defined rate. Two decimal places is enough for any real timebase and
  // keeps the numbers small enough for exact integer maths.
  if (Number.isInteger(fps)) {
    return { numerator: fps, denominator: 1 };
  }
  return { numerator: Math.round(fps * 1000), denominator: 1000 };
}

export function normalizeFrameRate(
  value: Partial<RationalFrameRate> | undefined,
  fallback: RationalFrameRate = { numerator: 25, denominator: 1 }
): RationalFrameRate {
  const numerator = value?.numerator;
  const denominator = value?.denominator;

  if (
    typeof numerator === "number"
    && Number.isFinite(numerator)
    && numerator > 0
    && typeof denominator === "number"
    && Number.isFinite(denominator)
    && denominator > 0
  ) {
    return { numerator: Math.round(numerator), denominator: Math.round(denominator) };
  }
  return { ...fallback };
}

/** Decimal rate. Display only — never use it for scheduling. */
export function approximateFps(rate: RationalFrameRate): number {
  return rate.numerator / rate.denominator;
}

/**
 * Absolute deadline of a frame, in nanoseconds from the clock's start.
 *
 * Computed from `frame` rather than accumulated, which is what makes the
 * schedule drift-free.
 */
export function deadlineNanos(rate: RationalFrameRate, frame: number): number {
  return Math.round((frame * NANOS_PER_SECOND * rate.denominator) / rate.numerator);
}

/** Nominal duration of one frame, in nanoseconds. */
export function frameDurationNanos(rate: RationalFrameRate): number {
  return Math.round((NANOS_PER_SECOND * rate.denominator) / rate.numerator);
}

export function frameDurationMs(rate: RationalFrameRate): number {
  return (1000 * rate.denominator) / rate.numerator;
}

/** Frame containing an elapsed nanosecond offset. */
export function frameAtNanos(rate: RationalFrameRate, nanos: number): number {
  return Math.floor((nanos * rate.numerator) / (NANOS_PER_SECOND * rate.denominator));
}

/** Frames in a duration, rounded to the nearest whole frame. */
export function framesForSeconds(rate: RationalFrameRate, seconds: number): number {
  return Math.round((seconds * rate.numerator) / rate.denominator);
}

export function secondsForFrames(rate: RationalFrameRate, frames: number): number {
  return (frames * rate.denominator) / rate.numerator;
}

export function frameRatesEqual(a: RationalFrameRate, b: RationalFrameRate): boolean {
  // Cross-multiply so 30/1 and 60/2 compare equal.
  return a.numerator * b.denominator === b.numerator * a.denominator;
}

/** True for the 1000/1001 family, which needs drop-frame timecode. */
export function isDropFrameRate(rate: RationalFrameRate): boolean {
  return rate.denominator === 1_001;
}

export interface Timecode {
  hours: number;
  minutes: number;
  seconds: number;
  frames: number;
  dropFrame: boolean;
}

/**
 * Frame number to timecode.
 *
 * Drop-frame timecode skips frame numbers 0 and 1 of every minute except every
 * tenth minute, so that 29.97 fps wall-clock time and timecode stay aligned. It
 * drops *labels*, never frames — the video is continuous.
 */
export function frameToTimecode(rate: RationalFrameRate, frame: number): Timecode {
  const nominal = Math.round(approximateFps(rate));
  const dropFrame = isDropFrameRate(rate) && (nominal === 30 || nominal === 60);

  if (!dropFrame) {
    const frames = frame % nominal;
    const totalSeconds = Math.floor(frame / nominal);
    return {
      hours: Math.floor(totalSeconds / 3600),
      minutes: Math.floor((totalSeconds % 3600) / 60),
      seconds: totalSeconds % 60,
      frames,
      dropFrame: false
    };
  }

  // Standard SMPTE drop-frame arithmetic.
  const dropPerMinute = nominal === 60 ? 4 : 2;
  const framesPerMinute = nominal * 60 - dropPerMinute;
  const framesPerTenMinutes = nominal * 600 - dropPerMinute * 9;

  const tenMinuteBlocks = Math.floor(frame / framesPerTenMinutes);
  const remainder = frame % framesPerTenMinutes;

  // Every ten-minute block skips nine minutes' worth of labels; the first minute
  // of each block skips none, which is why the remainder is offset by one drop.
  let adjusted = frame + dropPerMinute * 9 * tenMinuteBlocks;
  if (remainder >= dropPerMinute) {
    adjusted += dropPerMinute * Math.floor((remainder - dropPerMinute) / framesPerMinute);
  }

  const frames = adjusted % nominal;
  const totalSeconds = Math.floor(adjusted / nominal);

  return {
    hours: Math.floor(totalSeconds / 3600) % 24,
    minutes: Math.floor((totalSeconds % 3600) / 60),
    seconds: totalSeconds % 60,
    frames,
    dropFrame: true
  };
}

export function formatTimecode(timecode: Timecode): string {
  const pad = (value: number, width = 2): string => String(value).padStart(width, "0");
  const separator = timecode.dropFrame ? ";" : ":";
  return `${pad(timecode.hours)}:${pad(timecode.minutes)}:${pad(timecode.seconds)}${separator}${pad(timecode.frames)}`;
}

// ---------------------------------------------------------------------------
// The clock
// ---------------------------------------------------------------------------

export interface FrameClockOptions {
  rate: RationalFrameRate;
  /** Frame the clock starts at. */
  startFrame?: number;
  /** Nanosecond timestamp the clock started at. */
  startNanos?: number;
}

export interface FrameTick {
  frame: number;
  /** Absolute deadline this frame should have been presented at. */
  deadlineNanos: number;
  /** Nanoseconds late. Negative means early. */
  latenessNanos: number;
  /** Frames skipped because the renderer could not keep up. */
  droppedFrames: number;
  /** True when the frame missed its deadline. */
  late: boolean;
}

/**
 * Deterministic frame scheduler.
 *
 * Deliberately not a timer: it computes which frame is due at a given instant.
 * That means the same wall-clock trace produces the same frame sequence, which
 * is what lets the browser preview and the native engine be compared at all.
 */
export class FrameClock {
  readonly rate: RationalFrameRate;
  private readonly startNanos: number;
  private readonly startFrame: number;
  private currentFrame: number;
  private framesRendered = 0;
  private framesDropped = 0;
  private framesLate = 0;

  constructor(options: FrameClockOptions) {
    this.rate = normalizeFrameRate(options.rate);
    this.startFrame =
      typeof options.startFrame === "number" && Number.isFinite(options.startFrame)
        ? Math.max(0, Math.floor(options.startFrame))
        : 0;
    this.startNanos =
      typeof options.startNanos === "number" && Number.isFinite(options.startNanos)
        ? options.startNanos
        : 0;
    this.currentFrame = this.startFrame;
  }

  get frame(): number {
    return this.currentFrame;
  }

  get stats(): { rendered: number; dropped: number; late: number } {
    return {
      rendered: this.framesRendered,
      dropped: this.framesDropped,
      late: this.framesLate
    };
  }

  /** Absolute deadline of a frame, on this clock's timeline. */
  deadlineFor(frame: number): number {
    return this.startNanos + deadlineNanos(this.rate, frame - this.startFrame);
  }

  /** Whether the next frame is due at `nowNanos`. */
  isDue(nowNanos: number): boolean {
    return nowNanos >= this.deadlineFor(this.currentFrame + 1);
  }

  /** Nanoseconds until the next frame is due. Zero when already due. */
  timeUntilNextFrameNanos(nowNanos: number): number {
    return Math.max(0, this.deadlineFor(this.currentFrame + 1) - nowNanos);
  }

  /**
   * Advance to the frame due at `nowNanos`.
   *
   * When the renderer has fallen behind, this jumps to the correct frame and
   * reports the skipped ones as dropped rather than trying to catch up frame by
   * frame. Catching up would fall further behind and, worse, would play the show
   * in slow motion.
   */
  tick(nowNanos: number): FrameTick {
    const targetFrame = this.frameAt(nowNanos);
    const nextFrame = Math.max(this.currentFrame + 1, targetFrame);
    const dropped = Math.max(0, nextFrame - this.currentFrame - 1);

    this.currentFrame = nextFrame;
    this.framesRendered += 1;
    this.framesDropped += dropped;

    const deadline = this.deadlineFor(nextFrame);
    const lateness = nowNanos - deadline;
    const late = lateness > 0;
    if (late) this.framesLate += 1;

    return {
      frame: nextFrame,
      deadlineNanos: deadline,
      latenessNanos: lateness,
      droppedFrames: dropped,
      late
    };
  }

  /** Frame that should be showing at an instant. */
  frameAt(nowNanos: number): number {
    const elapsed = Math.max(0, nowNanos - this.startNanos);
    return this.startFrame + frameAtNanos(this.rate, elapsed);
  }

  /** Jump to a frame, e.g. on a Cue or a scrub. Does not count as a drop. */
  seek(frame: number): void {
    this.currentFrame = Number.isFinite(frame) ? Math.max(0, Math.floor(frame)) : 0;
  }

  reset(): void {
    this.currentFrame = this.startFrame;
    this.framesRendered = 0;
    this.framesDropped = 0;
    this.framesLate = 0;
  }

  timecode(): Timecode {
    return frameToTimecode(this.rate, this.currentFrame);
  }
}
