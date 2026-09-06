/**
 * Exact After Effects time, and the one mapping from it to a Program frame.
 *
 * ## Why this is not a number
 *
 * After Effects states a layer or marker time as a rational — `value/scale`, both integers — and a
 * Program frame rate is a rational too. Every interesting broadcast rate (`30000/1001`,
 * `60000/1001`) is a fraction that no binary float represents, so the moment either side becomes a
 * `number` the two clocks stop agreeing about which frame a cue is on. The fields are decimal
 * strings for the same reason: JSON round-trips them without a float ever existing.
 *
 * ## Why the arithmetic lives here
 *
 * It was already wrong in two places at once. `clock.ts::deadlineNanos` computed
 * `Math.round(frame * 1e9 * den / num)` in doubles while `render-engine/src/stage.rs` computed
 * `frame * 1e9 * den / num` in `u128` — so they used *different rounding* (round-half-up against
 * truncation) on an intermediate product that overflows `Number.MAX_SAFE_INTEGER` after about six
 * minutes at `60000/1001`. Measured, one third of all frames at `60000/1001` disagreed. Both sides
 * now truncate, and this module is the single reference the TypeScript half delegates to.
 *
 * `@grapix/shared-types` has no dependencies, which is why the type sits here rather than in
 * `animation-engine`: the cue map, the runtime protocol and the frame descriptor all need to name
 * the same time without any of them depending on each other.
 */

/**
 * A non-negative rational instant, as After Effects states it.
 *
 * `value` and `scale` are decimal integer strings; `scale` is never `"0"`. There is deliberately no
 * `seconds` field — a caller that wants one has to ask for it and accept the loss.
 */
export interface AeExactTime {
  value: string;
  scale: string;
}

/** A rational rate. Structurally the `RationalFrameRate` already used across the repo. */
export interface AeExactRate {
  numerator: number;
  denominator: number;
}

const DECIMAL_INTEGER = /^(?:0|[1-9][0-9]*)$/;

export function isAeExactTime(value: unknown): value is AeExactTime {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Partial<AeExactTime>;
  return (
    typeof candidate.value === "string" &&
    typeof candidate.scale === "string" &&
    DECIMAL_INTEGER.test(candidate.value) &&
    DECIMAL_INTEGER.test(candidate.scale) &&
    candidate.scale !== "0"
  );
}

/**
 * Parse to bigints, or return null.
 *
 * Null rather than a throw because every caller here is validating declared authoring data, where a
 * bad value is a refusal with a reason and not an exception.
 */
export function parseAeExactTime(time: AeExactTime): { value: bigint; scale: bigint } | null {
  if (!isAeExactTime(time)) return null;
  return { value: BigInt(time.value), scale: BigInt(time.scale) };
}

export function aeExactTime(value: bigint | number, scale: bigint | number): AeExactTime {
  return { value: BigInt(value).toString(), scale: BigInt(scale).toString() };
}

/** True when both describe the same instant, including across unequal scales (`1/2` == `2/4`). */
export function aeExactTimesEqual(left: AeExactTime, right: AeExactTime): boolean {
  const a = parseAeExactTime(left);
  const b = parseAeExactTime(right);
  if (!a || !b) return false;
  return a.value * b.scale === b.value * a.scale;
}

/** Ordering on the same terms as equality. Negative, zero or positive, like a comparator. */
export function compareAeExactTimes(left: AeExactTime, right: AeExactTime): number {
  const a = parseAeExactTime(left);
  const b = parseAeExactTime(right);
  if (!a || !b) return Number.NaN;
  const leftScaled = a.value * b.scale;
  const rightScaled = b.value * a.scale;
  return leftScaled === rightScaled ? 0 : leftScaled < rightScaled ? -1 : 1;
}

export type AeFrameMappingRefusal =
  | "INVALID_TIME"
  | "INVALID_RATE"
  /** The instant falls between two Program frames, so no frame can carry it. */
  | "NOT_ON_FRAME";

export interface AeFrameMapping {
  frame: number;
  /** Absolute deadline from the clock's start, in nanoseconds. Truncated integer arithmetic. */
  deadlineNanos: number;
}

/**
 * Map an exact AE time onto a Program frame, refusing anything that does not land on one.
 *
 * For time `n/d` and rate `p/q`, the frame is `F = n·p / (d·q)`, and it must divide exactly. A cue
 * half a frame early is not rounded to a neighbour: rounding is how an off-frame marker becomes a
 * frame the operator never declared.
 */
export function aeExactTimeToProgramFrame(
  time: AeExactTime,
  rate: AeExactRate
): AeFrameMapping | AeFrameMappingRefusal {
  const parsed = parseAeExactTime(time);
  if (!parsed) return "INVALID_TIME";
  if (!isAeExactRate(rate)) return "INVALID_RATE";

  const numerator = parsed.value * BigInt(rate.numerator);
  const denominator = parsed.scale * BigInt(rate.denominator);
  if (numerator % denominator !== 0n) return "NOT_ON_FRAME";

  const frame = numerator / denominator;
  return { frame: Number(frame), deadlineNanos: exactDeadlineNanos(rate, frame) };
}

export function isAeExactRate(rate: AeExactRate | undefined): rate is AeExactRate {
  return (
    rate !== undefined &&
    Number.isSafeInteger(rate.numerator) &&
    Number.isSafeInteger(rate.denominator) &&
    rate.numerator > 0 &&
    rate.denominator > 0
  );
}

export const NANOS_PER_SECOND_EXACT = 1_000_000_000n;

/**
 * Absolute deadline of a frame, in nanoseconds, by truncating integer division.
 *
 * The intermediate product is a bigint because `frame · 10^9 · denominator` passes
 * `Number.MAX_SAFE_INTEGER` after roughly six minutes at `60000/1001`. **Truncation, not rounding**,
 * because `render-engine/src/stage.rs::FrameRate::deadline_nanos` truncates and the two must agree
 * frame for frame. The returned nanosecond count is exact as a `number` for any run under about a
 * hundred days.
 */
export function exactDeadlineNanos(rate: AeExactRate, frame: bigint | number): number {
  if (!isAeExactRate(rate)) return 0;
  const frames = BigInt(frame);
  if (frames < 0n) return 0;
  return Number((frames * NANOS_PER_SECOND_EXACT * BigInt(rate.denominator)) / BigInt(rate.numerator));
}

/** Nominal duration of one frame in nanoseconds, truncated the same way. */
export function exactFrameDurationNanos(rate: AeExactRate): number {
  if (!isAeExactRate(rate)) return 0;
  return Number((NANOS_PER_SECOND_EXACT * BigInt(rate.denominator)) / BigInt(rate.numerator));
}

/** The exact AE time of a Program frame, so a resolved cue can be sent back as a rational. */
export function programFrameToAeExactTime(frame: bigint | number, rate: AeExactRate): AeExactTime {
  return aeExactTime(BigInt(frame) * BigInt(rate.denominator), rate.numerator);
}

/**
 * ## The composition's own clock
 *
 * Everything above maps an instant onto a *Program* frame. That is only half of the problem, and the
 * missing half was discovered the first time `SET_TIME` actually executed: After Effects does not
 * hold time in the rate GrapiX declared, it holds it in the **item's own scale**. Asking the
 * `LOWER_THIRD` fixture for `1001/30000` returned `800/23976`, because that composition's scale is
 * `23976` and its frame duration is `800` — exactly `29.97`, not `30000/1001`. Cross-multiplied the
 * two instants differ (`1001·23976 = 23999976` against `800·30000 = 24000000`), so the declared cue
 * was never representable and AE quantised it to a neighbouring frame.
 *
 * A declared rate and a composition's time scale are therefore two clocks until proven equal, and
 * proving it is what this section does. The proof is cheap and it collapses the whole problem:
 *
 * - a composition's exact rate is `timeScale / frameDuration` (`23976/800` = `2997/100`);
 * - if that rate equals the declared Program rate, then Program frame `F` is at exactly
 *   `F · frameDuration` in the composition's scale — an integer for every `F`, so no individual cue
 *   can fall between two composition frames;
 * - if it does not, no cue is representable and the mismatch is structural, so it is refused once at
 *   load rather than discovered per cue at air time.
 *
 * The frame duration comes from `AEGP_GetCompFrameDuration` as an exact rational. It is never taken
 * from `AEGP_GetCompFramerate`, which is an `A_FpLong`: a float rate cannot distinguish `2997/100`
 * from `30000/1001` in a way anything here is allowed to trust.
 */

/**
 * A composition's own clock, exactly as After Effects holds it.
 *
 * Both fields are decimal integer strings and neither is `"0"`. This is deliberately not an
 * `AeExactRate`: it is the composition's *frame duration in its own scale*, which carries strictly
 * more information than the reduced rate — the scale is the unit every `SET_TIME` must be stated in.
 */
export interface AeCompositionClock {
  /** Duration of one composition frame, in `timeScale` units. `800` for the pinned fixture. */
  frameDuration: string;
  /** The composition's own time scale. `23976` for the pinned fixture. */
  timeScale: string;
}

export function isAeCompositionClock(value: unknown): value is AeCompositionClock {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Partial<AeCompositionClock>;
  return (
    typeof candidate.frameDuration === "string" &&
    typeof candidate.timeScale === "string" &&
    DECIMAL_INTEGER.test(candidate.frameDuration) &&
    DECIMAL_INTEGER.test(candidate.timeScale) &&
    candidate.frameDuration !== "0" &&
    candidate.timeScale !== "0"
  );
}

export function aeCompositionClock(
  frameDuration: bigint | number,
  timeScale: bigint | number
): AeCompositionClock {
  return { frameDuration: BigInt(frameDuration).toString(), timeScale: BigInt(timeScale).toString() };
}

function gcd(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) {
    const next = a % b;
    a = b;
    b = next;
  }
  return a;
}

/**
 * The composition's exact rate, reduced: `timeScale / frameDuration`.
 *
 * Null when the clock is malformed, or when the reduced terms leave the safe-integer range that
 * `AeExactRate` is made of — a rate GrapiX cannot state exactly is not a rate it may approximate.
 */
export function aeCompositionClockRate(clock: AeCompositionClock): AeExactRate | null {
  if (!isAeCompositionClock(clock)) return null;
  const scale = BigInt(clock.timeScale);
  const duration = BigInt(clock.frameDuration);
  const divisor = gcd(scale, duration);
  const numerator = scale / divisor;
  const denominator = duration / divisor;
  if (numerator > BigInt(Number.MAX_SAFE_INTEGER) || denominator > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return { numerator: Number(numerator), denominator: Number(denominator) };
}

/** True when two rates are the same rational, whether or not they are stated in the same terms. */
export function aeExactRatesEqual(left: AeExactRate, right: AeExactRate): boolean {
  if (!isAeExactRate(left) || !isAeExactRate(right)) return false;
  return (
    BigInt(left.numerator) * BigInt(right.denominator) === BigInt(right.numerator) * BigInt(left.denominator)
  );
}

export type AeCompositionClockRefusal =
  | "INVALID_CLOCK"
  | "INVALID_RATE"
  /** The composition's scale cannot carry the declared rate, so no cue on it is representable. */
  | "RATE_NOT_IN_COMPOSITION_SCALE";

/**
 * Prove that a declared Program rate and a composition's own clock are the same clock.
 *
 * This is the check whose absence let a cue be parked on a frame nobody declared. It is structural:
 * a failure here condemns every cue in the composition, not one of them, which is why callers run it
 * once at load instead of per cue.
 */
export function reconcileAeCompositionClock(
  clock: AeCompositionClock,
  rate: AeExactRate
): { compositionRate: AeExactRate } | AeCompositionClockRefusal {
  if (!isAeCompositionClock(clock)) return "INVALID_CLOCK";
  if (!isAeExactRate(rate)) return "INVALID_RATE";
  const compositionRate = aeCompositionClockRate(clock);
  if (!compositionRate) return "INVALID_CLOCK";
  if (!aeExactRatesEqual(compositionRate, rate)) return "RATE_NOT_IN_COMPOSITION_SCALE";
  return { compositionRate };
}

/**
 * The exact composition-scale instant of a Program frame.
 *
 * Only meaningful once `reconcileAeCompositionClock` has passed for the same clock and rate; the
 * frame index is then `F · frameDuration` in the composition's scale, which is what AE accepts and
 * echoes back unchanged. Negative frames are refused rather than wrapped.
 */
export function programFrameToAeCompositionTime(
  frame: bigint | number,
  clock: AeCompositionClock
): AeExactTime | AeCompositionClockRefusal {
  if (!isAeCompositionClock(clock)) return "INVALID_CLOCK";
  const frames = BigInt(frame);
  if (frames < 0n) return "INVALID_CLOCK";
  return aeExactTime(frames * BigInt(clock.frameDuration), BigInt(clock.timeScale));
}

/**
 * Restate an exact AE time in the composition's own scale, or refuse.
 *
 * An authored marker may be written in any scale — the pinned fixture's markers were authored in
 * `30000`ths — and what AE has to be told is the same instant in *its* scale. A time that falls
 * between two composition frames has no such statement and is refused, never rounded.
 */
export function aeTimeInCompositionScale(
  time: AeExactTime,
  clock: AeCompositionClock
): { time: AeExactTime; compositionFrame: number } | AeCompositionClockRefusal | "NOT_ON_FRAME" | "INVALID_TIME" {
  const parsed = parseAeExactTime(time);
  if (!parsed) return "INVALID_TIME";
  if (!isAeCompositionClock(clock)) return "INVALID_CLOCK";
  const scale = BigInt(clock.timeScale);
  const duration = BigInt(clock.frameDuration);

  // The instant is `value/scaleOfTime` seconds; in composition frames that is
  // `value · timeScale / (scaleOfTime · frameDuration)`, which must divide exactly.
  const numerator = parsed.value * scale;
  const denominator = parsed.scale * duration;
  if (numerator % denominator !== 0n) return "NOT_ON_FRAME";
  const compositionFrame = numerator / denominator;
  return {
    time: aeExactTime(compositionFrame * duration, scale),
    compositionFrame: Number(compositionFrame)
  };
}
