// The one-line status bar (visibility decision of 26 Nov 2026, Figma B2v2): Library, the latest message, and the time the engine
// took to draw the last frame. The full activity history is one click away: the message opens it. Logic is not drawn until it is a
// feature (as Snap and Markers, Jev 24 Nov 2026).

/** The words for the engine's last frame time, or nothing when it has not drawn one. */
export function renderTimeWords(renderMs: number | undefined): string {
  if (renderMs === undefined || !Number.isFinite(renderMs) || renderMs < 0) return "";
  return `${Math.round(renderMs)} ms`;
}

/** The latest message as the bar shows it: the newest line, or what to click when there is none yet. */
export function latestWords(message: string | undefined): string {
  const line = message?.trim() ?? "";
  return line === "" ? "No activity yet" : line;
}
