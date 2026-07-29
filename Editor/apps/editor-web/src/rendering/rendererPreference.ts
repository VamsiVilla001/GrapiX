/**
 * Browser renderer preference policy.
 *
 * Requirement 10 fixes the order and this module makes it explicit and testable
 * rather than a literal buried in a Pixi `init` call:
 *
 *   1. WebGL — the tested default.
 *   2. WebGPU — only when explicitly enabled *and* available. "The API exists" is
 *      not the same as "it has been tested with this content".
 *   3. Canvas — emergency fallback only, always reported as degraded.
 *
 * The Canvas rule matters most. Pixi's Canvas backend cannot do filters, most
 * blend modes, or anything 3D, so falling back to it silently would produce a
 * viewport that looks plausible and is wrong. It is therefore always marked
 * degraded with a message naming what is lost.
 */

export type EditorBackendKind = "webgl" | "webgpu" | "canvas";

/** What Pixi's `preference` option accepts. */
export type PixiPreference = "webgl" | "webgpu";

export interface BackendAvailability {
  webgl: boolean;
  webgpu: boolean;
  canvas: boolean;
}

export interface BackendSelection {
  kind: EditorBackendKind;
  /** What to hand to `Application.init({ preference })`. */
  pixiPreference: PixiPreference;
  /** True when this is not the preferred backend. */
  degraded: boolean;
  reason: string;
  /** Capabilities lost relative to WebGL. Empty when not degraded. */
  lostCapabilities: string[];
}

/**
 * Features unavailable on the Canvas fallback.
 *
 * Enumerated rather than summarised so the status bar can say precisely what the
 * operator is not seeing.
 */
export const CANVAS_LOST_CAPABILITIES: readonly string[] = Object.freeze([
  "filters (blur, glow, drop shadow)",
  "blend modes beyond normal",
  "masks with feather",
  "3D meshes, cameras, and lights",
  "shader-based materials"
]);

/**
 * Probe the current environment.
 *
 * Creating a throwaway canvas is the only reliable WebGL test — a `window.WebGL2RenderingContext`
 * check passes on machines where context creation then fails, which is exactly the
 * case the fallback exists for.
 */
export function detectBackendAvailability(): BackendAvailability {
  return {
    webgl: detectWebGl(),
    webgpu: typeof navigator !== "undefined" && "gpu" in navigator,
    canvas: detectCanvas2d()
  };
}

function detectWebGl(): boolean {
  if (typeof document === "undefined") return false;
  try {
    const probe = document.createElement("canvas");
    const context =
      probe.getContext("webgl2") ?? probe.getContext("webgl");
    if (!context) return false;
    // Release the context immediately; a probe must not hold a GPU context open.
    const lose = (context as WebGLRenderingContext).getExtension("WEBGL_lose_context");
    lose?.loseContext();
    return true;
  } catch {
    return false;
  }
}

function detectCanvas2d(): boolean {
  if (typeof document === "undefined") return false;
  try {
    return document.createElement("canvas").getContext("2d") !== null;
  } catch {
    return false;
  }
}

export interface BackendPreferenceOptions {
  /**
   * Opt in to WebGPU.
   *
   * Defaults to false. WebGPU becomes the default only once the browser path has
   * been tested against the same scene corpus as WebGL.
   */
  enableWebGpu?: boolean;
  /** Override the probe, for tests and for a forced-fallback diagnostic mode. */
  availability?: BackendAvailability;
}

/**
 * Select a backend.
 *
 * Returns `undefined` when nothing can render at all, which the caller must
 * surface as an error rather than proceeding with a blank viewport.
 */
export function selectEditorBackend(
  options: BackendPreferenceOptions = {}
): BackendSelection | undefined {
  const availability = options.availability ?? detectBackendAvailability();
  const enableWebGpu = options.enableWebGpu === true;

  if (enableWebGpu && availability.webgpu) {
    return {
      kind: "webgpu",
      pixiPreference: "webgpu",
      degraded: false,
      reason: "WebGPU explicitly enabled and available",
      lostCapabilities: []
    };
  }

  if (availability.webgl) {
    return {
      kind: "webgl",
      pixiPreference: "webgl",
      degraded: false,
      reason: "WebGL is the tested default renderer",
      lostCapabilities: []
    };
  }

  if (availability.webgpu) {
    return {
      kind: "webgpu",
      pixiPreference: "webgpu",
      degraded: true,
      reason:
        "WebGL is unavailable; falling back to WebGPU, which has not been tested against the full scene corpus",
      lostCapabilities: []
    };
  }

  if (availability.canvas) {
    return {
      kind: "canvas",
      // Pixi has no "canvas" preference; it falls back internally when neither
      // GPU backend can be created.
      pixiPreference: "webgl",
      degraded: true,
      reason:
        "no GPU backend is available; the Canvas emergency fallback cannot render filters, blend modes, or 3D",
      lostCapabilities: [...CANVAS_LOST_CAPABILITIES]
    };
  }

  return undefined;
}

/**
 * One-line operator message for a selection.
 *
 * Empty for a healthy default, so the status bar only speaks when something is
 * actually wrong.
 */
export function describeBackendSelection(selection: BackendSelection): string {
  if (!selection.degraded) return "";

  const lost =
    selection.lostCapabilities.length > 0
      ? ` Unavailable: ${selection.lostCapabilities.join(", ")}.`
      : "";
  return `Editor preview is running on a degraded backend (${selection.kind}). ${selection.reason}.${lost} The standalone render engine remains authoritative for Program output.`;
}

/**
 * Is this backend trustworthy for judging what Program will look like?
 *
 * Even the healthy WebGL path is only an approximation — the engine is
 * authoritative — but a degraded backend is not even approximately right, and the
 * operator needs to know which situation they are in.
 */
export function isBackendRepresentative(selection: BackendSelection): boolean {
  return !selection.degraded;
}
