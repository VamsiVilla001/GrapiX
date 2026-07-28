import type { RendererPatch, SceneDocument } from "@grapix/shared-types";

/**
 * JSON/WebSocket renderer protocol implemented by services/render-daemon.
 *
 * This is deliberately separate from SceneDocument.version: the scene schema
 * and the transport can evolve independently.
 */
export const RENDERER_PROTOCOL_VERSION = 2 as const;

export const RENDERER_CHANNELS = ["preview", "program"] as const;
export type RendererChannel = (typeof RENDERER_CHANNELS)[number];

export const RENDERER_SCENE_LIFECYCLES = [
  "UNLOADED",
  "METADATA_ONLY",
  "LOADING",
  "WARM",
  "PREVIEW",
  "PROGRAM",
  "EVICTABLE",
  "FAILED"
] as const;
export type RendererSceneLifecycle = (typeof RENDERER_SCENE_LIFECYCLES)[number];

export type RendererOutputState = "idle" | "configured" | "running";
export type RendererExpectedState = RendererOutputState | "any";
export type RendererQualityProfile =
  | "EDITOR_PREVIEW"
  | "PROGRAM_HD"
  | "PROGRAM_UHD"
  | "LOW_LATENCY"
  | "SAFE_MODE";

/** Negotiated capabilities used by the frontend RendererClient boundary. */
export interface RendererCapabilities {
  protocolVersion: typeof RENDERER_PROTOCOL_VERSION;
  sceneDocumentVersions: readonly number[];
  transport: "websocket" | "named-pipe" | "grpc";
  commands: readonly string[];
  maxWarmScenes: number;
  previewProgramChannels: boolean;
  scenePatching: boolean;
  renderedObjectTypes: readonly string[];
  outputBackends: readonly string[];
  supportedTransitions: readonly string[];
  nativeTextRender: boolean;
  packagedFontFiles: boolean;
  remoteFontCss: boolean;
  sceneAutomationExecution: boolean;
  sceneScriptExecution: boolean;
  mediaLifecycle: boolean;
  nativeVideoDecode: boolean;
  gltfImportValidation: boolean;
  native3dRender: boolean;
  /**
   * Whether authored scene cameras drive the Program view-projection.
   *
   * Describes only what is implemented: a static, unparented, unbound, visible
   * camera. Parented, animated and data-bound cameras are still refused with a
   * Take-blocking diagnostic, so this does NOT promise full camera parity.
   *
   * Optional because a daemon predating the feature omits the field.
   */
  nativeActiveCamera?: boolean;
}

export interface RendererOutputConfig {
  width: number;
  height: number;
  frameRateNumerator: number;
  frameRateDenominator: number;
  scanMode?: "p" | "i";
  alphaMode?: "premultiplied" | "straight";
  colorFormat?: "bgra8";
  colorSpace?: "srgb";
  ndiSourceName?: string;
  recordingName?: string;
  backend?: "ndi" | "recording" | "decklink" | "aja" | "null";
}

export interface RendererCommandEnvelope {
  protocolVersion: typeof RENDERER_PROTOCOL_VERSION;
  requestId: string;
  /** Strictly increasing for the lifetime of one controller connection. */
  sequence: number;
  /** Unix epoch milliseconds assigned by the controller. */
  timestampMs: number;
  /** Optimistic state precondition; "any" is explicit, never implicit. */
  expectedRendererState: RendererExpectedState;
  /** Null for commands that are not scoped to one scene. */
  sceneId: string | null;
  /** SceneDocument.updatedAt in protocol v2; null for non-scene commands. */
  sceneRevision: string | null;
  /** Null until a command explicitly addresses Preview or Program. */
  channel: RendererChannel | null;
}

export interface SceneLoadPayload {
  type: "scene.load";
  scene: SceneDocument;
}

export interface SceneUpdatePayload {
  type: "scene.update";
  scene: SceneDocument;
}

export interface SceneWarmPayload {
  type: "scene.warm";
  scene: SceneDocument;
}

export interface ScenePatchPayload {
  type: "scene.patch";
  patch: RendererPatch;
  /** Revision assigned by the project service after the atomic patch write. */
  nextSceneRevision: string;
}

export interface SceneReleasePayload {
  type: "scene.release";
}

export interface SetPreviewPayload {
  type: "channel.preview.set";
}

export interface TakePayload {
  type: "channel.take";
  transition: "cut";
}

export interface OutputConfigurePayload extends RendererOutputConfig {
  type: "output.configure";
}

export interface OutputStartPayload {
  type: "output.start";
}

export interface OutputStopPayload {
  type: "output.stop";
}

export interface RendererStatusPayload {
  type: "status";
}

export interface RendererCapabilitiesPayload {
  type: "capabilities.get";
}

export interface RendererHeartbeatPayload {
  type: "heartbeat";
}

export interface SetResourceProfilePayload {
  type: "resource.profile.set";
  profile: RendererQualityProfile;
}

/** Commands accepted by renderer protocol v2 before the envelope is applied. */
export type RendererCommandPayload =
  | SceneLoadPayload
  | SceneUpdatePayload
  | SceneWarmPayload
  | ScenePatchPayload
  | SceneReleasePayload
  | SetPreviewPayload
  | TakePayload
  | OutputConfigurePayload
  | OutputStartPayload
  | OutputStopPayload
  | RendererStatusPayload
  | RendererCapabilitiesPayload
  | RendererHeartbeatPayload
  | SetResourceProfilePayload;

export type RendererCommand = RendererCommandPayload & RendererCommandEnvelope;
export type RendererCommandType = RendererCommandPayload["type"];

/**
 * Apply the versioned request envelope in one place so clients cannot drift
 * on protocolVersion or forget correlation IDs.
 */
export interface CreateRendererCommandOptions {
  requestId: string;
  sequence: number;
  timestampMs?: number;
  expectedRendererState?: RendererExpectedState;
  sceneId?: string | null;
  sceneRevision?: string | null;
  channel?: RendererChannel | null;
}

export function createRendererCommand<T extends RendererCommandPayload>(
  payload: T,
  options: CreateRendererCommandOptions
): T & RendererCommandEnvelope {
  if (!options.requestId.trim()) {
    throw new Error("renderer requestId must not be empty");
  }
  if (!Number.isSafeInteger(options.sequence) || options.sequence <= 0) {
    throw new Error("renderer sequence must be a positive safe integer");
  }

  const timestampMs = options.timestampMs ?? Date.now();
  if (!Number.isSafeInteger(timestampMs) || timestampMs <= 0) {
    throw new Error("renderer timestampMs must be a positive safe integer");
  }

  const scene = "scene" in payload ? payload.scene : undefined;

  return {
    ...payload,
    protocolVersion: RENDERER_PROTOCOL_VERSION,
    requestId: options.requestId,
    sequence: options.sequence,
    timestampMs,
    expectedRendererState: options.expectedRendererState ?? "any",
    sceneId: options.sceneId ?? scene?.id ?? null,
    sceneRevision: options.sceneRevision ?? scene?.updatedAt ?? null,
    channel: options.channel ?? null
  };
}

export const RENDERER_ERROR_CODES = [
  "INVALID_JSON",
  "PROTOCOL_VERSION_MISMATCH",
  "INVALID_ENVELOPE",
  "STALE_SEQUENCE",
  "REVISION_MISMATCH",
  "EXPECTED_STATE_MISMATCH",
  "UNSUPPORTED_MESSAGE",
  "INVALID_PAYLOAD",
  "INVALID_SCENE",
  "INVALID_OUTPUT_CONFIG",
  "OUTPUT_STATE_ERROR",
  "RENDERER_ERROR"
] as const;
export type RendererErrorCode = (typeof RENDERER_ERROR_CODES)[number];

export interface RendererAck {
  type: "ack";
  protocolVersion: typeof RENDERER_PROTOCOL_VERSION;
  requestType: RendererCommandType;
  requestId: string;
  sequence: number;
  warnings?: string[];
}

export interface RendererErrorReply {
  type: "error";
  protocolVersion: typeof RENDERER_PROTOCOL_VERSION;
  code: RendererErrorCode | string;
  message: string;
  requestId?: string;
  sequence?: number;
}

/**
 * How badly a scene diagnostic affects the rendered frame.
 *
 * Ordered from harmless to untrustworthy. `omitted` and `invalid` block Take;
 * `info` and `degraded` do not. Mirrors `DiagnosticSeverity` in
 * `services/render-daemon/src/scene/diagnostics.rs`.
 */
export const RENDERER_DIAGNOSTIC_SEVERITIES = [
  /** Rendered exactly as authored. */
  "info",
  /** Rendered with reduced fidelity; nothing authored is missing. */
  "degraded",
  /** Specific authored content is absent from the frame. */
  "omitted",
  /** The frame as a whole does not represent the scene. */
  "invalid"
] as const;
export type RendererDiagnosticSeverity =
  (typeof RENDERER_DIAGNOSTIC_SEVERITIES)[number];

/** Severities at or above which a scene is unsafe to Take. */
export const RENDERER_TAKE_BLOCKING_SEVERITIES: readonly RendererDiagnosticSeverity[] =
  ["omitted", "invalid"];

export function blocksTake(severity: RendererDiagnosticSeverity): boolean {
  return RENDERER_TAKE_BLOCKING_SEVERITIES.includes(severity);
}

/**
 * One machine-readable statement about how the native renderer handled a
 * scene. Match on `code`, never on `message` — the message is operator-facing
 * prose and is free to be reworded.
 */
export interface RendererSceneDiagnostic {
  /** Stable dotted identifier, e.g. `camera.active.unsupported`. */
  code: string;
  severity: RendererDiagnosticSeverity;
  message: string;
  objectId?: string;
  objectType?: string;
}

export interface RendererSceneStatus {
  id: string;
  name: string;
  revision: string;
  objectCount: number;
  rectCount: number;
  meshCount: number;
  /**
   * Typed report from the native renderer. Authoritative; `warnings` and
   * `takeBlockers` are derived string views retained for compatibility.
   *
   * Optional because a daemon predating typed diagnostics omits the field.
   */
  diagnostics?: RendererSceneDiagnostic[];
  warnings: string[];
  takeReady: boolean;
  takeBlockers: string[];
  lifecycle?: RendererSceneLifecycle;
}

export interface RendererLifecycleSceneStatus extends RendererSceneStatus {
  lifecycle: RendererSceneLifecycle;
  estimatedBytes: number;
  lastUsed: number;
}

export interface RendererGpuStatus {
  adapter: string;
  backend: string;
  deviceType: string;
  driver: string;
  driverInfo: string;
  vendorId: number;
  deviceId: number;
  maxTextureDimension2d: number;
  maxBufferSize: number;
  maxBindGroups: number;
}

export interface RendererValidatedOutputConfig {
  width: number;
  height: number;
  frameRate: {
    numerator: number;
    denominator: number;
  };
  scanMode: "p";
  alphaMode: "premultiplied";
  colorFormat: "bgra8";
  colorSpace: "srgb";
  ndiSourceName: string;
  recordingName: string;
  backend: "ndi" | "recording" | "decklink" | "aja" | "null";
}

export interface RendererOutputStatus {
  state: RendererOutputState;
  config?: RendererValidatedOutputConfig;
  framesRendered: number;
  framesSent: number;
  framesDropped: number;
  lastRenderMs: number;
  timingSampleCount: number;
  averageRenderMs: number;
  p99RenderMs: number;
  frameBudgetMs: number;
  averageBudgetUtilization: number;
  p99BudgetUtilization: number;
  lastError?: string;
}

export interface RendererResourceLimits {
  maxOutputWidth: number;
  maxOutputHeight: number;
  maxFrameRate: number;
  maxWarmScenes: number;
  maxPreparedSceneBytes: number;
  maxPreparedCacheBytes: number;
  maxDecodedCpuCacheBytes: number;
  maxGpuAssetCacheBytes: number;
  maxTextureDimension: number;
  maxVideoDecoders: number;
  maxRenderTargets: number;
  maxTriangles: number;
  maxMeshes: number;
  maxMaterials: number;
  maxLights: number;
  maxAnimationBones: number;
  maxTransparentObjects: number;
  previewScale: number;
  antialiasing: boolean;
  mipmaps: boolean;
  shadowQuality: string;
  effectQuality: string;
  diagnosticsLevel: string;
  thumbnailRendering: boolean;
  backgroundProxyWork: boolean;
}

export interface RendererResourceStatus {
  profile: RendererQualityProfile;
  limits: RendererResourceLimits;
  cachePressure: number;
  overBudget: boolean;
}

export interface RendererAssetCacheStatus {
  uniqueAssets: number;
  aliases: number;
  referencedAssets: number;
  pinnedAssets: number;
  diskBytes: number;
  decodedCpuBytes: number;
  gpuBytes: number;
  cpuBudgetBytes: number;
  gpuBudgetBytes: number;
}

export interface RendererStatusReply {
  type: "status";
  protocolVersion: typeof RENDERER_PROTOCOL_VERSION;
  requestId: string;
  sequence: number;
  connectedClients: number;
  scene: RendererSceneStatus | null;
  scenes: RendererLifecycleSceneStatus[];
  programSceneId: string | null;
  previewSceneId: string | null;
  warmSceneCount: number;
  maxWarmScenes: number;
  estimatedCacheBytes: number;
  assetCache: RendererAssetCacheStatus;
  resources: RendererResourceStatus;
  gpu: RendererGpuStatus;
  output: RendererOutputStatus;
}

export interface RendererCapabilitiesReply {
  type: "capabilities";
  protocolVersion: typeof RENDERER_PROTOCOL_VERSION;
  requestId: string;
  sequence: number;
  capabilities: RendererCapabilities;
}

export type RendererSuccessReply =
  | RendererAck
  | RendererStatusReply
  | RendererCapabilitiesReply;
export type RendererReply = RendererSuccessReply | RendererErrorReply;

export type RendererEventType =
  | "renderer.state"
  | "scene.lifecycle"
  | "channel.changed"
  | "output.health"
  | "renderer.warning";

/** Server-initiated event envelope reserved by protocol v2. */
export interface RendererEvent<TPayload = unknown> {
  type: "event";
  protocolVersion: typeof RENDERER_PROTOCOL_VERSION;
  eventType: RendererEventType;
  eventSequence: number;
  timestampMs: number;
  payload: TPayload;
}

export function isRendererReply(value: unknown): value is RendererReply {
  if (!isRecord(value) || value.protocolVersion !== RENDERER_PROTOCOL_VERSION) {
    return false;
  }

  if (value.type === "ack") {
    return hasReplyEnvelope(value) && typeof value.requestType === "string";
  }

  if (value.type === "error") {
    return typeof value.code === "string" && typeof value.message === "string";
  }

  if (value.type === "capabilities") {
    return hasReplyEnvelope(value) && isRecord(value.capabilities);
  }

  return value.type === "status"
    && hasReplyEnvelope(value)
    && typeof value.connectedClients === "number"
    && isRecord(value.gpu)
    && isRecord(value.output);
}

export function isRendererEvent(value: unknown): value is RendererEvent {
  return isRecord(value)
    && value.type === "event"
    && value.protocolVersion === RENDERER_PROTOCOL_VERSION
    && typeof value.eventType === "string"
    && Number.isSafeInteger(value.eventSequence)
    && Number(value.eventSequence) > 0
    && Number.isSafeInteger(value.timestampMs);
}

function hasReplyEnvelope(value: Record<string, unknown>): boolean {
  return typeof value.requestId === "string"
    && Number.isSafeInteger(value.sequence)
    && Number(value.sequence) > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
