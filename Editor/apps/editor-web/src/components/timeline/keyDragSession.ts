/**
 * A keyframe drag, coalesced to one commit per animation frame.
 *
 * A pointer at 1000 Hz against a display at 60 Hz delivers up to sixteen moves per painted frame.
 * Writing the store on each one costs sixteen scene clones and sixteen React renders to produce one
 * picture, and every one of them is discarded by the next. `getCoalescedEvents()` hands back the
 * samples the browser buffered; only the last can affect where the keys end up, so the session
 * records them and applies once when the frame is scheduled.
 *
 * ## What must not change
 *
 * The undo behaviour is the existing one, preserved exactly:
 *
 * - one `beginHistory` at pointer-down, labelled "Move keyframe" or "Move N keyframes";
 * - writes during the move;
 * - one `commitHistory` at pointer-up, which the store treats as a no-op if the scene never
 *   changed, so a click that never moved deposits no undo entry.
 *
 * A fifty-key drag is one transaction because it was one transaction before; coalescing changes how
 * often the writes happen inside it, not how many transactions there are.
 *
 * ## Why the delta comes from the origin
 *
 * Every position is `startFrame + delta`, where `startFrame` was captured at pointer-down and delta
 * is measured from the origin. Reading current frames back mid-drag and adding to them compounds
 * each move into the next, and the selection accelerates away from the cursor — the comment on the
 * existing `keyDragRef` records that this already happened once.
 *
 * DOM-free on purpose: the session takes numbers and returns the writes to make, so the whole
 * policy — threshold, coalescing, deduplication, clamping — is unit-testable without a pointer.
 */

/** One key's move, as the caller should apply it. */
export interface KeyDragWrite {
  id: string;
  frame: number;
}

export interface KeyDragSessionOptions {
  /** Pointer X at pointer-down, in client pixels. */
  originClientX: number;
  /** Frame under the pointer at pointer-down. */
  originFrame: number;
  /** Frame of every dragged key at pointer-down. Never re-read from the scene. */
  startFrames: ReadonlyMap<string, number>;
  /** Movement below this many pixels is a click, not a drag. */
  thresholdPx: number;
  /** Client X to frame. Supplied so the session needs no viewport of its own. */
  frameForClientX: (clientX: number) => number;
  /** Clamp a delta so no key leaves the timeline. Mirrors the existing `clampFrameDelta`. */
  clampDelta: (startFrames: number[], delta: number) => number;
}

export class KeyDragSession {
  private readonly options: KeyDragSessionOptions;
  private readonly startFrameList: number[];

  /** The most recent pointer X seen, from any number of coalesced samples. */
  private latestClientX: number;
  /** The delta already written. Re-writing the same delta would be a no-op render. */
  private appliedDelta = 0;
  /** True once the pointer has passed the threshold; never returns to false. */
  private moved = false;
  /** Set while a sample is waiting for the next frame. */
  private pending = false;

  constructor(options: KeyDragSessionOptions) {
    this.options = options;
    this.latestClientX = options.originClientX;
    this.startFrameList = [...options.startFrames.values()];
  }

  /**
   * Record pointer samples. Cheap, and called for every coalesced event.
   *
   * Only the last sample can affect the outcome — the intermediate ones describe positions the
   * pointer has already left — so this keeps one number rather than a queue.
   */
  sample(clientXs: readonly number[]): void {
    if (clientXs.length === 0) return;
    this.latestClientX = clientXs[clientXs.length - 1];
    this.pending = true;
  }

  /** Whether a sample is waiting, so the caller can skip scheduling a frame that has nothing to do. */
  get hasPendingSample(): boolean {
    return this.pending;
  }

  /** Whether the pointer ever passed the movement threshold. */
  get hasMoved(): boolean {
    return this.moved;
  }

  /**
   * Apply the latest sample. Called once per animation frame.
   *
   * Returns the writes to make, or an empty array when nothing changed — which is the common case
   * during a slow drag, and is what keeps a 1000 Hz pointer from producing 1000 renders.
   */
  flush(): KeyDragWrite[] {
    this.pending = false;

    if (!this.moved) {
      if (Math.abs(this.latestClientX - this.options.originClientX) < this.options.thresholdPx) {
        return [];
      }
      this.moved = true;
    }

    const rawDelta = this.options.frameForClientX(this.latestClientX) - this.options.originFrame;
    const delta = this.options.clampDelta(this.startFrameList, rawDelta);
    if (delta === this.appliedDelta) return [];
    this.appliedDelta = delta;

    const writes: KeyDragWrite[] = [];
    for (const [id, startFrame] of this.options.startFrames) {
      writes.push({ id, frame: startFrame + delta });
    }
    return writes;
  }
}

/**
 * The client X of every sample a pointer event carries.
 *
 * `getCoalescedEvents()` returns the moves the browser buffered since the last dispatch; without it
 * a high-rate pointer's intermediate positions are simply lost, which makes a fast drag land short.
 * Not every environment implements it — it is absent in older Safari and in test doubles — so the
 * event's own position is the fallback, which is exactly what the browser would have delivered
 * anyway.
 */
export function coalescedClientXs(event: {
  clientX: number;
  getCoalescedEvents?: () => readonly { clientX: number }[];
}): number[] {
  const coalesced = event.getCoalescedEvents?.();
  if (!coalesced || coalesced.length === 0) return [event.clientX];
  return coalesced.map((sample) => sample.clientX);
}

/** The history label the existing drag uses. Kept here so both call sites cannot drift. */
export function dragHistoryLabel(keyCount: number): string {
  return keyCount > 1 ? `Move ${keyCount} keyframes` : "Move keyframe";
}
