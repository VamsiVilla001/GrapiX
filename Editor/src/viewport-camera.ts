// Panning and zooming the viewport (plan row 11.105).
//
// The view is a camera over the picture: a zoom, where 1 is "fit to the pane", and a pan in screen pixels. It is applied
// as one CSS transform on the viewport surface (the backdrop, the canvas, the engine picture and the selection overlay
// together), so every tool, which maps the pointer through the overlay's own box, stays true at any zoom and pan. It is
// view state of the Editor only: nothing here reaches the scene, a project or an undo step.
//
//   screen offset from the pane's middle of a point `s` (offset from the surface's middle) = zoom · s + pan
//
// Pure, so the arithmetic that has to keep a point under the pointer where it is, and keep the picture from being lost
// off the pane, is held by tests.

export interface Camera {
  /** The picture's size as a multiple of the size it fits the pane at. 1 is Fit. */
  readonly zoom: number;
  /** Where the surface's middle is from the pane's middle, in screen pixels. */
  readonly panX: number;
  readonly panY: number;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** Fit to the pane. */
export const FIT: Camera = { zoom: 1, panX: 0, panY: 0 };
/** The least and most the picture can be shown at, as a multiple of Fit. */
export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 32;
/** One click of Zoom in or Zoom out. */
export const ZOOM_STEP = 1.25;
/** How many pixels of the picture must stay inside the pane, so it cannot be pushed out of reach. */
export const KEEP_IN_VIEW = 48;

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/** The camera with the picture pushed back so that at least `KEEP_IN_VIEW` pixels of it stay inside the pane.
 *  `pane` is the pane's size and `picture` the picture's size at Fit. */
export function clampPan(camera: Camera, pane: Size, picture: Size): Camera {
  const zoom = clampZoom(camera.zoom);
  const limit = (paneSize: number, pictureSize: number): number => Math.max(0, (paneSize + pictureSize * zoom) / 2 - KEEP_IN_VIEW);
  const x = limit(pane.width, picture.width);
  const y = limit(pane.height, picture.height);
  return {
    zoom,
    panX: Math.min(x, Math.max(-x, Number.isFinite(camera.panX) ? camera.panX : 0)),
    panY: Math.min(y, Math.max(-y, Number.isFinite(camera.panY) ? camera.panY : 0)),
  };
}

/** The camera after zooming by `factor` with the point at `at` (from the pane's middle, in screen pixels) staying where
 *  it is on the screen. */
export function zoomAt(camera: Camera, factor: number, at: Point, pane: Size, picture: Size): Camera {
  const zoom = clampZoom(camera.zoom * factor);
  if (zoom === camera.zoom) return camera;
  const ratio = zoom / camera.zoom;
  return clampPan(
    { zoom, panX: at.x - ratio * (at.x - camera.panX), panY: at.y - ratio * (at.y - camera.panY) },
    pane,
    picture,
  );
}

/** The camera moved by a drag of the hand. */
export function panBy(camera: Camera, dx: number, dy: number, pane: Size, picture: Size): Camera {
  return clampPan({ ...camera, panX: camera.panX + dx, panY: camera.panY + dy }, pane, picture);
}

/** The factor for a turn of the wheel: smooth for a trackpad's small deltas, the same step for the same turn. */
export function wheelFactor(deltaY: number): number {
  if (!Number.isFinite(deltaY) || deltaY === 0) return 1;
  // Pixels, lines and pages arrive as different units; the page normalises them before it asks.
  return Math.exp(-Math.max(-600, Math.min(600, deltaY)) * 0.0015);
}

/** The camera showing the picture at `percent` of its own size (100 is one canvas pixel to one screen pixel), zoomed about
 *  the pane's middle. `fitScale` is the screen pixels per canvas pixel at Fit. */
export function atPercent(camera: Camera, percent: number, fitScale: number, pane: Size, picture: Size): Camera {
  if (!(fitScale > 0)) return camera;
  return zoomAt(camera, percent / 100 / (fitScale * camera.zoom), { x: 0, y: 0 }, pane, picture);
}

/** The readout: the picture's size on screen as a percent of its own size. */
export function zoomLabel(camera: Camera, fitScale: number): string {
  if (!(fitScale > 0)) return "";
  const percent = fitScale * camera.zoom * 100;
  return `${percent >= 10 ? Math.round(percent) : Math.round(percent * 10) / 10}%`;
}

/** The CSS transform for a camera. */
export function cameraTransform(camera: Camera): string {
  return camera.zoom === 1 && camera.panX === 0 && camera.panY === 0
    ? ""
    : `translate(${round(camera.panX)}px, ${round(camera.panY)}px) scale(${round(camera.zoom)})`;
}

const round = (value: number): number => Math.round(value * 1000) / 1000;

/** Whether a camera is the Fit camera. */
export function isFit(camera: Camera): boolean {
  return camera.zoom === 1 && camera.panX === 0 && camera.panY === 0;
}
