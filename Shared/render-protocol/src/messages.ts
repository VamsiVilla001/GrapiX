/**
 * Protocol v3 payloads.
 *
 * One payload interface per message type, plus a type-level map so
 * `createRequest("playout.cue", …)` only accepts a `CuePayload`. That map is the
 * whole reason the Editor and Playout can be held to "commands only, never
 * renderer internals" by the compiler rather than by review.
 */

import type { AeExactTime, SceneDocument } from "@grapix/shared-types";
import type { StageDocument } from "@grapix/stage-model";
import type { ScenePatch } from "@grapix/scene-model";

import type { EngineCapabilities } from "./capabilities.js";
import type { EngineDiagnostics, EngineStatus } from "./diagnostics.js";
import type { EngineErrorPayload, EngineRequestType } from "./envelope.js";
import type { EngineState } from "./engine-state.js";

/** Canonical scene address. Program accepts only `domain: "published"`. */
export interface SceneRef {
  projectId: string;
  domain: "authoring" | "published";
  sceneId: string;
  revision: number;
}

/** Channels an engine renders independently. */
export const ENGINE_CHANNELS = ["preview", "program", "auxiliary"] as const;
export type EngineChannel = (typeof ENGINE_CHANNELS)[number];

/** Quality profiles from requirement 22. */
export const ENGINE_QUALITY_PROFILES = [
  "EDITOR_PREVIEW",
  "REMOTE_PREVIEW",
  "LOW_POWER_PREVIEW",
  "PROGRAM_HD",
  "PROGRAM_UHD",
  "HUGE_STAGE_REGION",
  "HIGH_QUALITY_EXPORT",
  "LOW_LATENCY",
  "DIAGNOSTIC"
] as const;
export type EngineQualityProfile = (typeof ENGINE_QUALITY_PROFILES)[number];

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

export interface HelloPayload {
  clientId: string;
  clientName: string;
  /** "editor" or "playout"; the engine logs and permissions on this. */
  clientRole: "editor" | "playout" | "automation" | "diagnostic";
  clientVersion: string;
  supportedProtocolVersions: number[];
  projectId?: string;
}

export interface HelloReplyPayload {
  engineId: string;
  engineName: string;
  softwareVersion: string;
  protocolVersion: number;
  state: EngineState;
  /**
   * True when this engine grants operator authority only to a bearer credential.
   *
   * An engine-level fact, not an instruction to this connection: a local IPC session is
   * already a valid Editor session and needs no credential. Read it together with
   * `connectionRole`, which names the authority this connection actually received.
   */
  authenticationRequired: boolean;
  /**
   * The authority the engine granted this connection, derived from the credential and the
   * transport - never from the `clientRole` the client asked for.
   */
  connectionRole?: "editor" | "playout";
}

export interface AuthenticatePayload {
  /** Bearer token. Never a password, and never a filesystem path. */
  token: string;
  projectId?: string;
}

export interface HeartbeatPayload {
  /** Client clock, so the engine can report round-trip latency. */
  sentAtMs: number;
  /** Echoed back on the reply. */
  nonce?: string;
}

export interface CapabilitiesRequestPayload {
  /** Empty. Present so every message has a payload. */
  readonly _?: never;
}

export interface DisconnectPayload {
  reason: string;
  /** True when the client intends to reconnect, so the engine may hold state. */
  reconnecting: boolean;
}

// ---------------------------------------------------------------------------
// Stage
// ---------------------------------------------------------------------------

export interface StageLoadPayload {
  stage: StageDocument;
}

export interface StageUnloadPayload {
  stageId: string;
}

// ---------------------------------------------------------------------------
// Scene
// ---------------------------------------------------------------------------

export interface SceneLoadPayload {
  scene: SceneDocument;
  /** Stage to render it against. Absent means the implicit canvas-sized stage. */
  stageId?: string;
  /** Begin preparation immediately rather than waiting for `scene.prepare`. */
  prepare?: boolean;
}

export interface SceneUnloadPayload {
  sceneId: string;
  /** Unload even if the scene is on air. Refused unless explicitly forced. */
  force?: boolean;
}

export interface SceneFullSyncPayload {
  scene: SceneDocument;
  /** Why a full document was sent instead of a patch. Recorded for diagnostics. */
  reason: "requested" | "revision-gap" | "conflict" | "reconnect" | "initial";
}

export interface SceneApplyPatchPayload {
  patch: ScenePatch;
}

export interface SceneValidatePayload {
  scene: SceneDocument;
  stageId?: string;
}

export interface ScenePreparePayload {
  sceneId: string;
  /** Prepare only what these viewports need, for a huge stage. */
  viewportIds?: string[];
}

/** Preparation states from requirement 14. */
export const SCENE_PREPARATION_STATES = [
  "not-loaded",
  "loading",
  "ready",
  "ready-with-warnings",
  "failed"
] as const;
export type ScenePreparationState = (typeof SCENE_PREPARATION_STATES)[number];

export interface SceneValidationReplyPayload {
  sceneId: string;
  valid: boolean;
  errors: string[];
  warnings: string[];
  /** Features the scene uses that this engine does not implement. */
  unsupportedFeatures: string[];
  /** Assets the engine cannot resolve. */
  missingAssetIds: string[];
}

export interface ScenePreparedReplyPayload {
  sceneId: string;
  revision: number;
  state: ScenePreparationState;
  warnings: string[];
  /** Reasons `playout.takeOnline` would be refused. */
  takeBlockers: string[];
  preparedTileCount: number;
  preparedAssetCount: number;
  preparationMs: number;
}

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

export const ASSET_TRANSPORTS = ["engine-local", "http", "upload", "shared-cache"] as const;
export type AssetTransport = (typeof ASSET_TRANSPORTS)[number];

export interface AssetRegisterPayload {
  assetId: string;
  /**
   * Where the engine should get the bytes.
   *
   * For `engine-local` this is resolved *inside the engine's configured asset
   * roots only*. A remote client can never name an arbitrary filesystem path.
   */
  uri: string;
  transport: AssetTransport;
  mimeType: string;
  sizeBytes: number;
  /** SHA-256, lower-case hex. Content addressing and deduplication key. */
  sha256: string;
}

export interface AssetUploadPayload {
  assetId: string;
  sha256: string;
  /** Zero-based chunk index. */
  chunkIndex: number;
  chunkCount: number;
  /** Base64 chunk. Size is bounded by the engine's upload limit. */
  data: string;
  /** Total byte length across all chunks. */
  totalBytes: number;
}

export interface AssetValidatePayload {
  assetId: string;
}

export interface AssetPreloadPayload {
  assetIds: string[];
  /** Decode and upload to the GPU now, not just fetch. */
  decode?: boolean;
}

export interface AssetReleasePayload {
  assetIds: string[];
  /** Release even with outstanding references. Refused unless forced. */
  force?: boolean;
}

export interface AssetProgressReplyPayload {
  assetId: string;
  receivedChunks: number;
  chunkCount: number;
  receivedBytes: number;
  totalBytes: number;
  complete: boolean;
  /** Set when the received bytes did not hash to the declared digest. */
  checksumMismatch?: boolean;
}

// ---------------------------------------------------------------------------
// Playout
// ---------------------------------------------------------------------------

export interface CuePayload {
  sceneId: string;
  sceneRevision: number;
  channel: EngineChannel;
  /** Frame to sit at while cued. Defaults to the scene's first frame. */
  startFrame?: number;
}

export interface TakeOnlinePayload {
  sceneId: string;
  sceneRevision: number;
  transitionId?: string;
  /**
   * Take a scene that is not fully prepared.
   *
   * Requirement 14: an unprepared scene must not go online unless the operator
   * explicitly overrides the warning. This flag is that override, and the engine
   * records it in the audit log.
   */
  overrideUnprepared?: boolean;
}

export interface TakeOfflinePayload {
  sceneId: string;
  transitionId?: string;
}

export interface ContinuePayload {
  sceneId: string;
  channel: EngineChannel;
  /** Advance to this named marker instead of the next continue point. */
  markerName?: string;
}

export interface UpdatePayload {
  sceneId: string;
  sceneRevision: number;
  /** Data-only update: values for bound fields, no geometry change. */
  data: Record<string, unknown>;
}

export interface StopPayload {
  sceneId: string;
  channel: EngineChannel;
}

export interface ClearPayload {
  channel: EngineChannel;
  transitionId?: string;
}

export interface ReplacePayload {
  channel: EngineChannel;
  outgoingSceneId: string;
  incomingSceneId: string;
  incomingSceneRevision: number;
  transitionId?: string;
}

export const TRANSITION_DIRECTIONS = ["in", "out", "reverse"] as const;
export type TransitionDirection = (typeof TRANSITION_DIRECTIONS)[number];

export interface TransitionPayload {
  sceneId: string;
  channel: EngineChannel;
  transitionId: string;
  direction: TransitionDirection;
  /** Frame-accurate duration. Never a millisecond timeout. */
  durationFrames: number;
  /** Interrupt a transition already running instead of queueing. */
  interrupt?: boolean;
  /** Scope: a whole scene, one region, or one surface. */
  scope?:
    | { type: "scene" }
    | { type: "region"; regionId: string }
    | { type: "surface"; surfaceId: string };
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

export const PREVIEW_ENCODINGS = ["jpeg", "png", "raw-bgra", "webrtc", "shared-memory"] as const;
export type PreviewEncoding = (typeof PREVIEW_ENCODINGS)[number];

/**
 * What representation of a channel a preview shows.
 *
 * Broadcast does not carry transparency as an alpha channel — SDI has none — so a graphics
 * engine emits **fill** (the colour) and **key** (a greyscale matte) as two signals and the
 * downstream keyer recombines them. Operators verify a graphic by looking at the key as a
 * greyscale picture: white opaque, black transparent, grey for the feathered shadows and
 * anti-aliased edges a clipped key destroys.
 *
 * A render mode, therefore, not a codec concern: a key is greyscale, which JPEG carries
 * fine. An alpha-capable codec would deliver a design-tool checkerboard no operator uses.
 */
export const PREVIEW_VIEWS = ["fill", "key"] as const;
export type PreviewView = (typeof PREVIEW_VIEWS)[number];

/**
 * What part of the stage a preview covers.
 *
 * There is deliberately no "whole stage at full resolution" option. A
 * 50,000 x 50,000 frame is 10 GB, so the scaled variant carries a mandatory
 * pixel budget and the engine refuses anything past it.
 */
export type PreviewSource =
  | { type: "scaled-stage"; maxWidth: number; maxHeight: number }
  | { type: "viewport"; viewportId: string }
  | { type: "region"; regionId: string }
  | { type: "surface"; surfaceId: string }
  | { type: "rect"; x: number; y: number; width: number; height: number; renderScale: number }
  | { type: "tiles"; tileIds: string[]; renderScale: number };

export interface PreviewRequestPayload {
  channel: EngineChannel;
  source: PreviewSource;
  encoding: PreviewEncoding;
  /** Fill or key. Absent means fill; an unknown value is refused, never defaulted. */
  view?: PreviewView;
  /** 1-100 for lossy encodings. Ignored otherwise. */
  quality?: number;
  /** Frame to render. Absent means the channel's current frame. */
  frame?: number;
  /** Draw tile boundaries and ids. Diagnostic only, never on an output. */
  showTileDebug?: boolean;
  /**
   * Force the tile-composite path even when the region would fit one texture.
   *
   * Diagnostic, and deliberately separate from `showTileDebug`: that one draws the grid,
   * which makes the image useless for comparison. This produces the same picture by the
   * other route, which is how the compositor is proven seam-free.
   */
  forceTiled?: boolean;
}

export interface PreviewStreamStartPayload {
  streamId: string;
  channel: EngineChannel;
  source: PreviewSource;
  encoding: PreviewEncoding;
  /** Fill or key for every frame of the stream. Absent means fill. */
  view?: PreviewView;
  /** Target frames per second for the stream. The engine may deliver fewer. */
  targetFps: number;
  quality?: number;
}

export interface PreviewStreamStopPayload {
  streamId: string;
}

export interface PreviewSetViewportPayload {
  streamId: string;
  source: PreviewSource;
}

// ---------------------------------------------------------------------------
// Private Editor render view
// ---------------------------------------------------------------------------

export interface EditorViewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface EditorViewRequestPayload {
  sceneRef: SceneRef;
  viewId: string;
  /** Monotonic per view; a client discards a prior generation after resize/reconnect. */
  viewGeneration: number;
  bounds: EditorViewBounds;
  pixelWidth: number;
  pixelHeight: number;
  frame?: number;
  pick?: { x: number; y: number };
}

export interface EditorViewClosePayload {
  viewId: string;
  viewGeneration: number;
}

/** JSON metadata paired with one raw binary `bgra8-premultiplied` WebSocket message. */
export interface EditorViewFrameMetadata {
  viewId: string;
  viewGeneration: number;
  frameId: string;
  sceneRef: SceneRef;
  width: number;
  height: number;
  pixelFormat: "bgra8-premultiplied";
  alphaMode: "premultiplied";
  logicalBounds: EditorViewBounds;
  camera: EditorViewBounds;
  objectBounds: Array<{ objectId: string; x: number; y: number; width: number; height: number }>;
  pickedObjectId: string | null;
  frame: number;
}

export interface PreviewReplyPayload {
  channel: EngineChannel;
  streamId?: string;
  encoding: PreviewEncoding;
  /** Which representation this frame is. Absent on engines predating the key view. */
  view?: PreviewView;
  width: number;
  height: number;
  frame: number;
  sceneId: string | null;
  sceneRevision: number | null;
  /** Base64 for jpeg/png/raw; a handle or SDP reference for the others. */
  data: string;
  /** Logical rectangle the image covers, so a client can position it. */
  logicalBounds: { x: number; y: number; width: number; height: number };
  renderScale: number;
  renderMs: number;
  /**
   * Which route rendered this frame.
   *
   * Reported rather than inferred: a parity comparison that captured the same path twice
   * would prove nothing while looking like a pass.
   */
  renderPath?: "single-pass" | "tiled";
}

// ---------------------------------------------------------------------------
// Engine control
// ---------------------------------------------------------------------------

export interface GetStatusPayload {
  readonly _?: never;
}

export interface GetDiagnosticsPayload {
  /** Include the per-tile table, which can be large. */
  includeTiles?: boolean;
}

export interface SetConfigurationPayload {
  qualityProfile?: EngineQualityProfile;
  /** Tile cache byte budget. */
  tileCacheBudgetBytes?: number;
  gpuMemoryBudgetBytes?: number;
  logLevel?: "error" | "warn" | "info" | "debug" | "trace";
  diagnosticsEnabled?: boolean;
}

export interface RestartRendererPayload {
  reason: string;
  /** Restore Program state after restarting. */
  preserveProgram?: boolean;
}

export interface AckPayload {
  /** The request type being acknowledged. */
  requestType: EngineRequestType;
  warnings?: string[];
  /**
   * Echoed back from `connection.heartbeat` so the client can measure the round
   * trip. Only present on a heartbeat acknowledgement.
   */
  sentAtMs?: number;
  /** The engine's own clock at the time it replied. */
  engineTimeMs?: number;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface EngineStateEventPayload {
  state: EngineState;
  previousState: EngineState;
  reason: string;
}

export interface SceneLifecycleEventPayload {
  sceneId: string;
  revision: number;
  state: ScenePreparationState;
  channel: EngineChannel | null;
  warnings: string[];
}

export interface ChannelChangedEventPayload {
  channel: EngineChannel;
  sceneId: string | null;
  sceneRevision: number | null;
  onAir: boolean;
}

export interface OutputHealthEventPayload {
  outputId: string;
  adapterId: string;
  state: "idle" | "configured" | "running" | "error";
  framesSent: number;
  framesDropped: number;
  lastError?: string;
}

export interface TransitionProgressEventPayload {
  sceneId: string;
  channel: EngineChannel;
  transitionId: string;
  direction: TransitionDirection;
  frame: number;
  durationFrames: number;
  complete: boolean;
}

export interface WarningEventPayload {
  code: string;
  message: string;
  subject?: string;
}

export interface DeviceLostEventPayload {
  reason: string;
  /** True when the engine is attempting recovery by itself. */
  recovering: boolean;
  /** Scenes whose GPU resources were lost and must be re-prepared. */
  affectedSceneIds: string[];
}

export interface ResyncRequiredEventPayload {
  sceneIds: string[];
  reason: "revision-gap" | "sequence-gap" | "conflict" | "device-lost" | "restart";
  /** Engine's current revision per scene, so the client can diff. */
  engineRevisions: Record<string, number>;
}


// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

/**
 * Output adapters the engine offers.
 *
 * `virtual` is the one worth understanding: a headless render of the on-air graphic
 * at full Program resolution that never leaves the machine. It lets an operator
 * confirm a take produces the frame they expect, through the real render path, with
 * no possibility of reaching air.
 */
export const OUTPUT_ADAPTER_IDS = [
  "null",
  "virtual",
  "recording",
  "ndi",
  "decklink",
  "aja"
] as const;
export type OutputAdapterId = (typeof OUTPUT_ADAPTER_IDS)[number];

/** Adapters whose frames are visible to an audience. */
export const LIVE_OUTPUT_ADAPTER_IDS: readonly OutputAdapterId[] = Object.freeze([
  "ndi",
  "decklink",
  "aja"
]);

export function isLiveOutputAdapter(adapterId: string): boolean {
  return (LIVE_OUTPUT_ADAPTER_IDS as readonly string[]).includes(adapterId);
}

export const AE_FRAME_COLOR_FORMATS = ["bgra8", "rgba8", "argb8"] as const;
export type AeFrameColorFormat = (typeof AE_FRAME_COLOR_FORMATS)[number];

/** Metadata for one frame in the adapter-owned shared-memory ring. Never carries pixels. */
export interface AeFrameDescriptor {
  ringGeneration: number;
  slotIndex: number;
  frameId: number;
  dataRevision: number;
  compositionItemId: number;
  requestedTime: AeExactTime;
  evaluatedTime: AeExactTime;
  presentationDeadlineNanos: number;
  width: number;
  height: number;
  stride: number;
  colorFormat: AeFrameColorFormat;
  alphaMode: "premultiplied" | "straight" | "opaque";
  colorSpace: string;
  status: "ready" | "late" | "missed";
}

export interface EngineOutputFormat {
  width: number;
  height: number;
  frameRate: { numerator: number; denominator: number };
  /** Defaults to bgra8 when an older configuration omits it. */
  colorFormat?: AeFrameColorFormat;
  alphaMode?: "premultiplied" | "straight" | "opaque";
  /** Project colour space, so an adapter can tag its stream. */
  colorSpace?: string;
}

export interface OutputListPayload {
  readonly _?: never;
}

export interface OutputConfigurePayload {
  outputId: string;
  adapterId: OutputAdapterId | string;
  format: EngineOutputFormat;
  /** Adapter-specific settings, passed through untouched. */
  options?: Record<string, string | number | boolean>;
}

export interface OutputStartPayload {
  outputId: string;
}

export interface OutputStopPayload {
  outputId: string;
}

export interface OutputRemovePayload {
  outputId: string;
}

export interface EngineOutputStatus {
  outputId: string;
  adapterId: string;
  name: string;
  state: "idle" | "configured" | "running" | "error";
  /** Whether frames reaching this output are visible to an audience. */
  live: boolean;
  available: boolean;
  unavailableReason?: string;
  /** Never derived from a compile-time feature flag. */
  hardwareCertified: boolean;
  width: number;
  height: number;
  frameRateNumerator: number;
  frameRateDenominator: number;
  colorSpace: string;
  framesAccepted: number;
  framesSent: number;
  framesDropped: number;
  lastError?: string;
}

export interface OutputsReplyPayload {
  outputs: EngineOutputStatus[];
  /** Adapters this engine can instantiate, whether or not one exists yet. */
  availableAdapters: {
    adapterId: string;
    name: string;
    live: boolean;
    available: boolean;
    unavailableReason?: string;
    hardwareCertified: boolean;
  }[];
}

/** Playout attaches the runtime it launched; the session secret never enters persistent state. */
export interface AeContainerLoadPayload {
  sessionId: string;
  token: string;
  compositionItemId: number;
  clock: { frameDuration: string; timeScale: string };
  format: { width: number; height: number; colorSpace?: string; alphaMode?: string };
  dataRevision?: number;
  warmUpFrame?: number;
}

export interface AeContainerLoadedReplyPayload {
  sessionId: string;
  compositionItemId: number;
  ringGeneration: number;
  ringSlots: number;
  dataRevision: number;
  warmUpFrame: number;
  warmUpRequested: boolean;
  geometry: { width: number; height: number; stride: number };
  clock: { frameDuration: string; timeScale: string };
  programFrameRate: { numerator: number; denominator: number };
}

// ---------------------------------------------------------------------------
// Payload map
// ---------------------------------------------------------------------------

export interface EnginePayloadMap {
  "connection.hello": HelloPayload;
  "connection.authenticate": AuthenticatePayload;
  "connection.heartbeat": HeartbeatPayload;
  "connection.capabilities": CapabilitiesRequestPayload;
  "connection.disconnect": DisconnectPayload;

  "stage.load": StageLoadPayload;
  "stage.unload": StageUnloadPayload;

  "scene.load": SceneLoadPayload;
  "scene.unload": SceneUnloadPayload;
  "scene.fullSync": SceneFullSyncPayload;
  "scene.applyPatch": SceneApplyPatchPayload;
  "scene.validate": SceneValidatePayload;
  "scene.prepare": ScenePreparePayload;

  "asset.register": AssetRegisterPayload;
  "asset.upload": AssetUploadPayload;
  "asset.validate": AssetValidatePayload;
  "asset.preload": AssetPreloadPayload;
  "asset.release": AssetReleasePayload;

  "playout.cue": CuePayload;
  "playout.takeOnline": TakeOnlinePayload;
  "playout.takeOffline": TakeOfflinePayload;
  "playout.continue": ContinuePayload;
  "playout.update": UpdatePayload;
  "playout.stop": StopPayload;
  "playout.clear": ClearPayload;
  "playout.replace": ReplacePayload;
  "playout.transition": TransitionPayload;

  "preview.request": PreviewRequestPayload;
  "preview.streamStart": PreviewStreamStartPayload;
  "preview.streamStop": PreviewStreamStopPayload;
  "preview.setViewport": PreviewSetViewportPayload;

  "editor.view.request": EditorViewRequestPayload;
  "editor.view.close": EditorViewClosePayload;

  "engine.getStatus": GetStatusPayload;
  "engine.getDiagnostics": GetDiagnosticsPayload;
  "engine.getCapabilities": CapabilitiesRequestPayload;
  "engine.setConfiguration": SetConfigurationPayload;
  "engine.restartRenderer": RestartRendererPayload;

  "output.list": OutputListPayload;
  "output.configure": OutputConfigurePayload;
  "output.start": OutputStartPayload;
  "output.stop": OutputStopPayload;
  "output.remove": OutputRemovePayload;

  "ae.container.load": AeContainerLoadPayload;

  "reply.ack": AckPayload;
  "reply.error": EngineErrorPayload;
  "reply.hello": HelloReplyPayload;
  "reply.capabilities": EngineCapabilities;
  "reply.status": EngineStatus;
  "reply.diagnostics": EngineDiagnostics;
  "reply.sceneValidation": SceneValidationReplyPayload;
  "reply.scenePrepared": ScenePreparedReplyPayload;
  "reply.assetProgress": AssetProgressReplyPayload;
  "reply.preview": PreviewReplyPayload;
  "reply.editorView": EditorViewFrameMetadata;
  "reply.outputs": OutputsReplyPayload;
  "ae.container.loaded": AeContainerLoadedReplyPayload;

  "event.engineState": EngineStateEventPayload;
  "event.sceneLifecycle": SceneLifecycleEventPayload;
  "event.channelChanged": ChannelChangedEventPayload;
  "event.outputHealth": OutputHealthEventPayload;
  "event.previewFrame": PreviewReplyPayload;
  "event.transitionProgress": TransitionProgressEventPayload;
  "event.warning": WarningEventPayload;
  "event.error": EngineErrorPayload;
  "event.deviceLost": DeviceLostEventPayload;
  "event.resyncRequired": ResyncRequiredEventPayload;
}

export type EnginePayload<T extends keyof EnginePayloadMap> = EnginePayloadMap[T];

/**
 * Decoded pixel count a preview source would produce.
 *
 * The engine calls this before rendering and refuses anything over its
 * `maxPreviewPixels` limit. That check is the difference between "the operator
 * asked for a big preview" and "the engine tried to allocate 10 GB".
 */
export function previewPixelEstimate(
  source: PreviewSource,
  stage: { logicalWidth: number; logicalHeight: number }
): number {
  switch (source.type) {
    case "scaled-stage": {
      const scale = Math.min(
        1,
        source.maxWidth / Math.max(1, stage.logicalWidth),
        source.maxHeight / Math.max(1, stage.logicalHeight)
      );
      return Math.ceil(stage.logicalWidth * scale) * Math.ceil(stage.logicalHeight * scale);
    }
    case "rect":
      return (
        Math.ceil(source.width * source.renderScale) * Math.ceil(source.height * source.renderScale)
      );
    case "tiles":
      // Caller supplies the tile size via renderScale; conservatively assume the
      // engine's default tile until it resolves the real grid.
      return source.tileIds.length * Math.ceil(1024 * source.renderScale) ** 2;
    default:
      // Viewport, region, and surface sizes are only known to the engine, which
      // performs the real check once it resolves them.
      return 0;
  }
}
