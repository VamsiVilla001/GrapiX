// Device pixel ratio and scale-factor changes (build plan 11.3; ADR-0002 B.2).
//
// **The rule that prevents most bugs: the scene document is in scene
// coordinates. DPI affects display only, never the document.** A 1920×1080
// scene is 1920×1080 whatever monitor it is on. Nothing here touches a
// document; it only decides how many device pixels a canvas gets.
//
// Windows allows any fractional scale from 100% to 300%; macOS is 1× or 2×.
// So the interesting cases — 125% and 150%, where rounding errors appear and
// which are the most common real settings — are Windows cases.
//
// **Two failures this module exists to prevent.**
//
// 1. *A canvas sized in CSS pixels.* Its backing store then has fewer device
//    pixels than the screen shows, the compositor upscales, and every line the
//    timeline draws is soft. It looks like a styling problem and is not.
// 2. *A ratio cached at startup.* B.2 requires recomputing on
//    `ScaleFactorChanged`. A browser has no such event, so the ratio is
//    observed with a `matchMedia` query that must be **re-armed** after every
//    change: the query is pinned to one specific ratio and stops matching once
//    the ratio moves off it. Arming it once means the first monitor move is
//    seen and no later one is.

/// The subset of `window` this needs. Structural so the re-arming logic —
/// the part that is easy to get wrong — is testable without a browser.
export interface RatioSource {
  readonly devicePixelRatio: number;
  matchMedia(query: string): MediaQueryLike;
}

export interface MediaQueryLike {
  addEventListener(type: "change", listener: () => void): void;
  removeEventListener(type: "change", listener: () => void): void;
}

/// The backing-store size for a canvas at a given ratio.
///
/// Rounded, not truncated: at 150% a 905 px wide element is 1357.5 device
/// pixels, and flooring loses a column that the compositor then has to invent.
export function backingStore(
  cssWidth: number,
  cssHeight: number,
  devicePixelRatio: number,
): { readonly width: number; readonly height: number } {
  const ratio = devicePixelRatio > 0 ? devicePixelRatio : 1;
  return {
    width: Math.max(0, Math.round(cssWidth * ratio)),
    height: Math.max(0, Math.round(cssHeight * ratio)),
  };
}

/// Size one canvas for the current ratio, keeping its CSS size fixed.
///
/// The element stays the size the layout gave it; only the backing store
/// changes. Returns whether anything changed, because assigning `width`
/// clears a canvas even when the value is identical — repainting every layer
/// on every frame is exactly the cost the three-layer split exists to remove.
export function sizeCanvasForRatio(
  canvas: { width: number; height: number; style: { width: string; height: string } },
  cssWidth: number,
  cssHeight: number,
  devicePixelRatio: number,
): boolean {
  const target = backingStore(cssWidth, cssHeight, devicePixelRatio);
  if (canvas.width === target.width && canvas.height === target.height) return false;
  canvas.width = target.width;
  canvas.height = target.height;
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;
  return true;
}

/// Watch the device pixel ratio, re-arming after every change.
///
/// `matchMedia("(resolution: 1.25dppx)")` matches one exact ratio, so it stops
/// matching the moment the ratio moves. Each change therefore disposes its
/// query and arms a new one against the new ratio. Without that, a window
/// moved between three monitors reports the first move and goes quiet.
///
/// Returns a dispose function; call it when the watcher is no longer wanted.
export function watchDevicePixelRatio(
  source: RatioSource,
  onChange: (ratio: number) => void,
): () => void {
  let query: MediaQueryLike | undefined;
  let listener: (() => void) | undefined;
  let disposed = false;

  const arm = (ratio: number): void => {
    if (disposed) return;
    query = source.matchMedia(`(resolution: ${ratio}dppx)`);
    listener = () => {
      // Drop this query before reporting: the caller may paint synchronously,
      // and painting against a query that no longer matches is how a stale
      // ratio gets read back.
      if (query && listener) query.removeEventListener("change", listener);
      const next = source.devicePixelRatio;
      arm(next);
      onChange(next);
    };
    query.addEventListener("change", listener);
  };

  arm(source.devicePixelRatio);

  return () => {
    disposed = true;
    if (query && listener) query.removeEventListener("change", listener);
    query = undefined;
    listener = undefined;
  };
}
