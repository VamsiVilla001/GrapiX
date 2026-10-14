// The current-time readout (11.63).
//
// The timeline and the viewport footer show the playhead the way After Effects
// does: a large `H:MM:SS:FF` timecode with the frame count and rate beneath it.
// Both are formatted here from the integer frame and the scene's rational rate,
// so the readout can never drift from the frame the preview is showing
// (invariant 12: the frame is canonical, seconds are a display conversion).
//
// **Non-drop-frame only.** A second of timecode is the rate rounded to whole
// frames, which is how non-drop-frame timecode counts 29.97 (thirty labels per
// timecode second, so the label runs slow against the wall clock by 0.1%).
// Drop-frame labelling is not implemented; a fractional rate says "NDF" rather
// than presenting the label as exact wall-clock time.

import type { RationalRate } from "@grapix/contracts";

/// Whole frames per timecode second. A rate that is not a positive rational is
/// reported as `undefined` rather than guessed: a readout built on a guessed
/// rate would show a time the scene does not have.
export function framesPerTimecodeSecond(rate: RationalRate): number | undefined {
  if (!(rate.num > 0) || !(rate.den > 0)) return undefined;
  return Math.max(1, Math.round(rate.num / rate.den));
}

/// Whether the rate is a whole number of frames per second.
export function isIntegerRate(rate: RationalRate): boolean {
  return rate.num > 0 && rate.den > 0 && rate.num % rate.den === 0;
}

const pad = (value: number, width: number): string => String(value).padStart(width, "0");

function wholeFrame(frame: number): number {
  return Math.max(0, Math.trunc(Number.isFinite(frame) ? frame : 0));
}

/// `H:MM:SS:FF` for a frame. Negative or fractional frames are truncated to
/// the frame they fall in, the same rule the playhead uses.
export function formatTimecode(frame: number, rate: RationalRate): string {
  const perSecond = framesPerTimecodeSecond(rate);
  if (perSecond === undefined) return "-:--:--:--";
  const whole = wholeFrame(frame);
  const frames = whole % perSecond;
  const totalSeconds = Math.floor(whole / perSecond);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  return `${hours}:${pad(minutes, 2)}:${pad(seconds, 2)}:${pad(frames, 2)}`;
}

/// "50 fps", "29.97 fps NDF". The decimal is display only; the rational is
/// what every calculation uses.
export function formatRate(rate: RationalRate): string {
  if (!(rate.num > 0) || !(rate.den > 0)) return "no frame rate";
  if (isIntegerRate(rate)) return `${rate.num / rate.den} fps`;
  return `${(rate.num / rate.den).toFixed(2)} fps NDF`;
}

/// The line under the timecode: the zero-padded frame and the rate, as
/// "00090 (29.97 fps NDF)".
export function formatFrameLine(frame: number, rate: RationalRate): string {
  return `${pad(wholeFrame(frame), 5)} (${formatRate(rate)})`;
}
