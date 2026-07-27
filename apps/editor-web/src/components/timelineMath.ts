export function frameToPercent(frame: number, durationFrames: number): number {
  if (!Number.isFinite(frame) || !Number.isFinite(durationFrames) || durationFrames <= 0) {
    return 0;
  }

  return Math.min(100, Math.max(0, (frame / durationFrames) * 100));
}

export function frameToMarkerPosition(frame: number, durationFrames: number): string {
  const percent = frameToPercent(frame, durationFrames);

  // A rotated 10px diamond needs a slightly larger gutter than its
  // unrotated half-width, otherwise its corner slips under the sticky list.
  if (percent <= 0) return "8px";
  if (percent >= 100) return "calc(100% - 8px)";
  return `${percent}%`;
}

export function frameFromClientX(
  clientX: number,
  left: number,
  width: number,
  durationFrames: number
): number {
  if (![clientX, left, width, durationFrames].every(Number.isFinite) || durationFrames <= 0) {
    return 0;
  }

  const percent = (clientX - left) / Math.max(1, width);
  return Math.round(Math.min(1, Math.max(0, percent)) * durationFrames);
}
