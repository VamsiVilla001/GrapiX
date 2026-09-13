// Phase bands over the timeline (build plan 11.25).
//
// Rust owns what a phase *is* and every rule about it — `gx_contracts::phases`
// validates spans, refuses overlap and answers `phase_at_frame`. This module
// owns only how a phase is drawn and which band a click landed in, which is
// the part that needs pixels and therefore cannot live in Rust (invariant 27:
// one implementation of the rule, and this is not the rule).
//
// Bands paint on the **static** layer, beside the ruler and gridlines. They
// are frame geometry that changes only when an author edits a phase, so a
// scrub must never repaint them — the property `planRepaint` exists to keep.

import type { PhaseKind, TimelinePhase } from "@grapix/contracts";

import { frameToX, type TimelineViewport } from "./viewport";

/// Height of the phase strip in CSS pixels, measured from the top of the
/// timeline. The ruler sits above it; rows scroll beneath.
export const PHASE_BAND_HEIGHT = 14;

/// A phase positioned for drawing.
export interface PhaseBand {
  readonly phase: TimelinePhase;
  /// The phase's address, as Rust computes it: kind, plus name for `continue`.
  readonly address: string;
  readonly label: string;
  readonly x: number;
  readonly width: number;
}

/// How a phase is addressed. Mirrors `TimelinePhase::address` in Rust, which
/// is the one place the format is decided; this is the display side of the
/// same string and is pinned by a test.
export function phaseAddress(phase: TimelinePhase): string {
  return phase.name === undefined || phase.name === null
    ? phase.kind
    : `${phase.kind}:${phase.name}`;
}

/// Each phase's colour. Deliberately not a gradient or a per-phase palette
/// setting: an operator reads these five in a glance, and a configurable
/// colour is one more thing that can differ between two authors' screens.
const PHASE_COLOUR: Record<PhaseKind, string> = {
  in: "#2f6f4f",
  hold: "#3b5566",
  out: "#7a3f3f",
  continue: "#5a4a7a",
  update: "#6a5a2f",
};

export function phaseColour(kind: PhaseKind): string {
  return PHASE_COLOUR[kind];
}

/// Position every phase that is at least partly visible.
///
/// Bands are clipped to the viewport rather than dropped when they start
/// off-screen: a take-out that begins before the visible range still occupies
/// the frames on screen, and showing nothing there would misreport the scene.
export function phaseBands(
  phases: readonly TimelinePhase[],
  viewport: TimelineViewport,
): PhaseBand[] {
  const bands: PhaseBand[] = [];
  for (const phase of phases) {
    const start = Number(phase.startFrame);
    const end = Number(phase.endFrame);
    const left = frameToX(viewport, start);
    const right = frameToX(viewport, end);
    if (right <= 0 || left >= viewport.width) continue;

    const x = Math.max(0, left);
    const width = Math.min(viewport.width, right) - x;
    if (width <= 0) continue;
    const address = phaseAddress(phase);
    bands.push({
      phase,
      address,
      label: address,
      x,
      width,
    });
  }
  return bands;
}

/// The band under a point in the timeline stage, or `undefined`.
///
/// Returns `undefined` below the strip rather than the nearest band: a click
/// on a key row is not a click on a phase, and treating it as one would make
/// selecting a key silently retarget a phase edit.
export function phaseAtPoint(
  bands: readonly PhaseBand[],
  x: number,
  y: number,
): PhaseBand | undefined {
  if (y < 0 || y > PHASE_BAND_HEIGHT) return undefined;
  return bands.find((band) => x >= band.x && x < band.x + band.width);
}

/// The sentence the author reads for one phase.
export function phaseSummary(phase: TimelinePhase, frameRate: { num: number; den: number }): string {
  const start = Number(phase.startFrame);
  const end = Number(phase.endFrame);
  const frames = end - start;
  // Reported in frames first, because frames are what the author edits; the
  // millisecond figure is derived from the exact rational rate, never a
  // rounded fps (invariant 12).
  const ms = Math.round((frames * 1000 * frameRate.den) / frameRate.num);
  return `${phaseAddress(phase)}: frames ${start}–${end} (${frames} frames, ${ms} ms)`;
}
