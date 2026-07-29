/**
 * `@grapix/renderer-contracts` — the renderer interface names.
 *
 * Requirement 15 names sixteen interfaces. This package declares all of them so
 * the browser renderer and the native engine are held to the same shape, and so
 * "renderer adapter" means something specific rather than being a word in a
 * document.
 *
 * These are *contracts*, not implementations. `SceneDocument` never holds any of
 * these objects; an adapter converts scene data into them and owns them for the
 * lifetime of a render, which is the whole reason state separation is possible.
 *
 * The browser implements these with PixiJS and Three.js; the engine implements
 * them with wgpu. Neither implementation appears here.
 */

import type { SceneDocument, SceneObject } from "@grapix/shared-types";
import type {
  OutputAdapterDescriptor,
  OutputFrame,
  OutputFrameFormat
} from "@grapix/output-contracts";
import type {
  StageDocument,
  StagePoint,
  StageRect,
  StageViewport
} from "@grapix/stage-model";

// ---------------------------------------------------------------------------
// Backend
// ---------------------------------------------------------------------------

export type RendererBackendKind = "webgl" | "webgpu" | "canvas2d" | "wgpu-native";

/**
 * Renderer preference order, from requirement 10.
 *
 * WebGL first because it is what actually works everywhere today. WebGPU only
 * when explicitly enabled and tested — not "when available", because available
 * and correct are different things. Canvas2D is an emergency fallback and must be
 * reported as degraded, never used silently.
 */
export const BROWSER_BACKEND_PREFERENCE: readonly RendererBackendKind[] = Object.freeze([
  "webgl",
  "webgpu",
  "canvas2d"
]);

export interface RendererBackendLimits {
  maxTextureDimension2d: number;
  maxTextureArrayLayers: number;
  maxBufferSize: number;
  maxBindGroups: number;
  maxSamplersPerShaderStage: number;
}

export interface RendererBackendInfo {
  kind: RendererBackendKind;
  adapter: string;
  driver: string;
  limits: RendererBackendLimits;
  /** True when this backend is a fallback rather than the preferred one. */
  degraded: boolean;
  /** Set when degraded, so the operator learns why. */
  degradedReason?: string;
}

/** Device creation, capability reporting, and device-loss recovery. */
export interface RendererBackend {
  readonly info: RendererBackendInfo;
  isDeviceLost(): boolean;
  /** Rebuild the device. Every GPU resource must be treated as destroyed. */
  recoverDevice(): Promise<RendererBackendInfo>;
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Render graph
// ---------------------------------------------------------------------------

export type RenderPassKind =
  | "tile"
  | "composite"
  | "viewport"
  | "surface"
  | "transition"
  | "preview"
  | "output"
  | "diagnostic";

/**
 * One pass in the graph.
 *
 * `reads` and `writes` name resources rather than holding them, which is what
 * lets the graph be validated and reordered before anything is allocated.
 */
export interface RenderPass {
  readonly passId: string;
  readonly kind: RenderPassKind;
  readonly reads: readonly string[];
  readonly writes: readonly string[];
  /** Logical area this pass covers, in stage coordinates. */
  readonly logicalBounds: StageRect;
  /** Origin subtracted before narrowing geometry to f32 for the GPU. */
  readonly localOrigin: StagePoint;
  readonly renderScale: number;
}

export interface RenderNode {
  readonly nodeId: string;
  /** Scene object this node draws, if any. Groups and layers have none. */
  readonly objectId: string | null;
  readonly drawOrder: number;
  /** Stage-space bounds, before filter extent. */
  readonly bounds: StageRect;
  /** Logical units this node's filters reach beyond `bounds`. */
  readonly filterExtent: number;
  readonly opaque: boolean;
}

export interface RenderGraphValidation {
  valid: boolean;
  errors: string[];
  /** Passes in a safe execution order. */
  order: readonly string[];
}

/** A modular graph of passes, validated before execution. */
export interface RenderGraph {
  passes(): readonly RenderPass[];
  addPass(pass: RenderPass): void;
  removePass(passId: string): void;
  /** Reject cycles and missing resources before allocating anything. */
  validate(): RenderGraphValidation;
  clear(): void;
}

// ---------------------------------------------------------------------------
// Scene runtime
// ---------------------------------------------------------------------------

export const SCENE_RUNTIME_STATES = [
  "unloaded",
  "loading",
  "prepared",
  "prepared-with-warnings",
  "failed"
] as const;
export type SceneRuntimeState = (typeof SCENE_RUNTIME_STATES)[number];

export interface SceneRuntimeStatus {
  sceneId: string;
  revision: number;
  state: SceneRuntimeState;
  nodeCount: number;
  warnings: readonly string[];
  /** Reasons this scene must not go online. Empty means it may. */
  takeBlockers: readonly string[];
}

/**
 * Owns loaded scene state on the render side.
 *
 * Deliberately narrow: load, prepare, evaluate, release. It never edits a scene,
 * because editing is the Editor's job and mixing the two is how a renderer ends
 * up as a second source of truth.
 */
export interface SceneRuntime {
  load(scene: SceneDocument, stage: StageDocument | null): SceneRuntimeStatus;
  prepare(sceneId: string): Promise<SceneRuntimeStatus>;
  /** Nodes for a frame. Pure in `(revision, frame)`. */
  evaluate(sceneId: string, frame: number): readonly RenderNode[];
  release(sceneId: string): void;
  status(sceneId: string): SceneRuntimeStatus | undefined;
  loadedSceneIds(): readonly string[];
}

/** Converts scene objects into renderer-specific nodes. */
export interface SceneAdapter<TNative = unknown> {
  readonly backendKind: RendererBackendKind;
  /** Returns null for objects this backend does not render. */
  createNode(object: SceneObject, scene: SceneDocument): TNative | null;
  /** Update in place. Recreating every node per frame is the thing to avoid. */
  updateNode(native: TNative, object: SceneObject, scene: SceneDocument): void;
  destroyNode(native: TNative): void;
  /** Object types this adapter draws. Anything else is reported unsupported. */
  supportedObjectTypes(): readonly string[];
}

// ---------------------------------------------------------------------------
// Tiles, viewports, surfaces
// ---------------------------------------------------------------------------

export interface TileManagerContract {
  /** Tiles needing GPU work this frame, after culling. */
  selectTilesToRender(frame: number, required: readonly StageRect[]): readonly string[];
  markDirty(tileId: string): void;
  markRectDirty(bounds: StageRect): readonly string[];
  completeRender(tileId: string, frame: number): void;
  failRender(tileId: string, reason: string): void;
  /** Release least-recently-used tiles under memory pressure. */
  evict(): readonly string[];
  cacheBytes(): number;
}

export interface ViewportManagerContract {
  viewports(): readonly StageViewport[];
  resolveBounds(viewportId: string): StageRect | undefined;
  renderSize(viewportId: string): { width: number; height: number } | undefined;
  setActive(viewportId: string): boolean;
  activeViewportId(): string | null;
}

export interface SurfaceMapperContract {
  /** Stage point to a surface pixel, or undefined when there is no pixel there. */
  stageToSurfacePixel(surfaceId: string, point: StagePoint): StagePoint | undefined;
  /** Stage area a surface samples. */
  surfaceSourceRect(surfaceId: string): StageRect | undefined;
  /** Surfaces overlapping a stage rectangle, in draw order. */
  surfacesForRect(bounds: StageRect): readonly string[];
  /** True when a surface declares warp or blending the renderer cannot apply. */
  isCalibrationPending(surfaceId: string): boolean;
}

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

export interface FrameClockContract {
  readonly frameRateNumerator: number;
  readonly frameRateDenominator: number;
  currentFrame(): number;
  /** Absolute deadline of a frame, in nanoseconds. Never accumulated. */
  deadlineNanos(frame: number): number;
  isDue(nowNanos: number): boolean;
  /** Advance to the due frame, reporting frames skipped rather than catching up. */
  tick(nowNanos: number): { frame: number; droppedFrames: number; late: boolean };
  seek(frame: number): void;
}

// ---------------------------------------------------------------------------
// Assets, text, video
// ---------------------------------------------------------------------------

export const ASSET_RESIDENCY = ["absent", "fetching", "decoded", "uploaded", "failed"] as const;
export type AssetResidency = (typeof ASSET_RESIDENCY)[number];

export interface AssetProviderContract {
  residency(assetId: string): AssetResidency;
  /** Fetch and decode. Never called from the render thread. */
  prepare(assetId: string): Promise<AssetResidency>;
  /** Note a use, for reference counting and LRU. */
  acquire(assetId: string): void;
  release(assetId: string): void;
  bytesResident(): number;
}

export interface ShapedTextRun {
  /** Glyph indices in the resolved font. */
  glyphs: readonly number[];
  /** Advances in logical units, one per glyph. */
  advances: readonly number[];
  fontId: string;
  fontSizeLogical: number;
  direction: "ltr" | "rtl";
}

/**
 * Text shaping.
 *
 * Shaping produces runs, never per-character draws: splitting text into
 * characters breaks Arabic joining, Devanagari reordering, and every ligature.
 */
export interface TextRendererContract {
  shape(
    text: string,
    fontId: string,
    fontSizeLogical: number,
    options?: { direction?: "ltr" | "rtl" | "auto"; maxWidthLogical?: number }
  ): readonly ShapedTextRun[];
  measure(text: string, fontId: string, fontSizeLogical: number): { width: number; height: number };
  isFontReady(fontId: string): boolean;
}

export interface VideoProviderContract {
  open(assetId: string): Promise<boolean>;
  /** Frame for a scene frame, or null when not yet decoded. */
  frameAt(assetId: string, sceneFrame: number): { width: number; height: number } | null;
  close(assetId: string): void;
  /** Decoders in use, against the profile's limit. */
  activeDecoders(): number;
}

// ---------------------------------------------------------------------------
// Transitions, preview, output
// ---------------------------------------------------------------------------

export interface TransitionControllerContract {
  start(transitionId: string, durationFrames: number, interrupt?: boolean): boolean;
  advance(frames: number): { progress: number; complete: boolean };
  interrupt(): void;
  reverse(): void;
  /** Transitions actually implemented. Anything else must be refused. */
  supportedTransitions(): readonly string[];
}

export interface PreviewRequest {
  /** Logical area to preview. */
  bounds: StageRect;
  renderScale: number;
  encoding: "jpeg" | "png" | "raw-bgra";
  quality?: number;
  frame?: number;
  showTileDebug?: boolean;
}

export interface PreviewResult {
  width: number;
  height: number;
  encoding: "jpeg" | "png" | "raw-bgra";
  logicalBounds: StageRect;
  renderScale: number;
  data: Uint8Array;
  renderMs: number;
}

/**
 * Preview generation.
 *
 * `maxPixels` exists because a full-resolution preview of a 50,000 x 50,000 stage
 * is 10 GB. A request over the budget is refused, not silently downscaled — the
 * caller needs to know it asked for something impossible.
 */
export interface PreviewProviderContract {
  readonly maxPixels: number;
  canSatisfy(request: PreviewRequest): boolean;
  render(request: PreviewRequest): Promise<PreviewResult>;
}

export interface OutputAdapterContract {
  readonly descriptor: OutputAdapterDescriptor;
  configure(format: OutputFrameFormat): boolean;
  start(): void;
  stop(): void;
  /** False means the frame was dropped rather than sent. */
  send(frame: OutputFrame): boolean;
}

// ---------------------------------------------------------------------------
// Backend selection
// ---------------------------------------------------------------------------

export interface BackendSelection {
  kind: RendererBackendKind;
  degraded: boolean;
  reason: string;
}

/**
 * Choose a browser backend from what is available.
 *
 * WebGPU is only chosen when explicitly enabled, because "the API exists" is not
 * the same as "it has been tested with this content". Canvas2D is always reported
 * as degraded so it can never be mistaken for a working configuration.
 */
export function selectBrowserBackend(options: {
  webglAvailable: boolean;
  webgpuAvailable: boolean;
  webgpuEnabled: boolean;
  canvas2dAvailable: boolean;
}): BackendSelection | undefined {
  if (options.webgpuEnabled && options.webgpuAvailable) {
    return {
      kind: "webgpu",
      degraded: false,
      reason: "WebGPU explicitly enabled and available"
    };
  }

  if (options.webglAvailable) {
    return { kind: "webgl", degraded: false, reason: "WebGL is the tested default" };
  }

  if (options.webgpuAvailable) {
    return {
      kind: "webgpu",
      degraded: true,
      reason: "WebGL unavailable; falling back to untested WebGPU"
    };
  }

  if (options.canvas2dAvailable) {
    return {
      kind: "canvas2d",
      degraded: true,
      reason:
        "no GPU backend available; Canvas2D emergency fallback cannot render filters, blend modes, or 3D"
    };
  }

  return undefined;
}

/**
 * Validate a render graph: no cycles, no reads of unwritten resources.
 *
 * Topological sort by Kahn's algorithm. Returning the order rather than just a
 * boolean means the caller gets something usable out of the check.
 */
export function validateRenderGraph(passes: readonly RenderPass[]): RenderGraphValidation {
  const errors: string[] = [];
  const byId = new Map(passes.map((pass) => [pass.passId, pass]));

  if (byId.size !== passes.length) {
    errors.push("duplicate pass ids");
  }

  // A resource is produced by whichever pass writes it.
  const producers = new Map<string, string>();
  for (const pass of passes) {
    for (const resource of pass.writes) {
      const existing = producers.get(resource);
      if (existing && existing !== pass.passId) {
        errors.push(`resource "${resource}" is written by both ${existing} and ${pass.passId}`);
        continue;
      }
      producers.set(resource, pass.passId);
    }
  }

  const dependencies = new Map<string, Set<string>>();
  for (const pass of passes) {
    const deps = new Set<string>();
    for (const resource of pass.reads) {
      const producer = producers.get(resource);
      if (!producer) {
        errors.push(`pass ${pass.passId} reads "${resource}", which no pass writes`);
        continue;
      }
      if (producer !== pass.passId) deps.add(producer);
    }
    dependencies.set(pass.passId, deps);
  }

  const order: string[] = [];
  const remaining = new Map(dependencies);

  while (remaining.size > 0) {
    const ready = [...remaining.entries()]
      .filter(([, deps]) => [...deps].every((dep) => order.includes(dep)))
      .map(([passId]) => passId)
      .sort();

    if (ready.length === 0) {
      errors.push(`cycle among passes: ${[...remaining.keys()].sort().join(", ")}`);
      break;
    }

    for (const passId of ready) {
      order.push(passId);
      remaining.delete(passId);
    }
  }

  return { valid: errors.length === 0, errors, order };
}
