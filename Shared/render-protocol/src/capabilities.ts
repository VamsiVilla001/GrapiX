/**
 * Engine capability negotiation.
 *
 * Requirement 9: the engine reports its real hardware limits at connection time,
 * and the Editor and Playout use them to warn the operator *before* publishing
 * unsupported content.
 *
 * The important distinction from protocol v2's `RendererCapabilities`, which was
 * feature booleans only: these are *numbers*. "Supports tiling" does not tell you
 * whether a 50,000-wide stage will load; `maxLogicalCanvasWidth` and
 * `maxTextureDimension2d` do.
 */

export interface EngineOsInfo {
  platform: string;
  release: string;
  arch: string;
  hostname?: string;
}

export interface EngineCpuInfo {
  model: string;
  logicalCores: number;
  physicalCores?: number;
}

export interface EngineGpuInfo {
  adapter: string;
  /** wgpu backend: vulkan, dx12, metal, gl, or browser-webgpu. */
  backend: string;
  deviceType: string;
  driver: string;
  driverInfo?: string;
  vendorId: number;
  deviceId: number;
  /**
   * Best-effort VRAM estimate in bytes.
   *
   * wgpu does not expose VRAM portably, so this is an estimate and callers must
   * treat it as advisory. Zero means "unknown", never "none".
   */
  memoryBytesEstimate: number;
}

export interface EngineLimits {
  maxTextureDimension2d: number;
  maxTextureDimension3d: number;
  maxTextureArrayLayers: number;
  maxBufferSize: number;
  maxBindGroups: number;
  /** Largest logical canvas this engine will accept. Not a texture limit. */
  maxLogicalCanvasWidth: number;
  maxLogicalCanvasHeight: number;
  /** Largest tile, before overscan, the engine will allocate. */
  maxTileSize: number;
  maxActiveScenes: number;
  maxWarmScenes: number;
  /** Pixel ceiling for one preview image. Guards against huge-stage previews. */
  maxPreviewPixels: number;
  maxMessageBytes: number;
  maxUploadBytes: number;
  maxOutputs: number;
  maxSurfaces: number;
}

export interface OutputAdapterCapability {
  adapterId: string;
  name: string;
  /** False for adapters compiled out or missing a vendor SDK. */
  available: boolean;
  /** Why it is unavailable, so the operator is not left guessing. */
  unavailableReason?: string;
  supportsAlpha: boolean;
  supportsInterlaced: boolean;
  /**
   * Empty means "any resolution the engine can render".
   *
   * Optional because an engine that has no fixed formats may omit it entirely.
   */
  fixedResolutions?: { width: number; height: number }[];
  colorFormats: string[];
  /**
   * Whether this adapter has been run against real hardware.
   *
   * Never derived from a compile-time feature flag: having the NDI SDK linked in
   * is not the same as having transmitted a frame to a device. The Editor surfaces
   * an available-but-uncertified adapter as a warning, because an operator must not
   * discover that distinction at air time.
   */
  hardwareCertified: boolean;
}

export interface EngineFeatureFlags {
  tileRendering: boolean;
  headlessRendering: boolean;
  hardwareEncoding: boolean;
  nativeTextRender: boolean;
  packagedFontFiles: boolean;
  nativeVideoDecode: boolean;
  native3dRender: boolean;
  scenePatching: boolean;
  previewStreaming: boolean;
  sharedMemoryPreview: boolean;
  virtualCanvas: boolean;
  multiSurfaceMapping: boolean;
  /** Warp and edge-blend maths. False in this phase; the data model exists. */
  surfaceWarpCompositing: boolean;
  edgeBlendCompositing: boolean;
  /** Distributed rendering across nodes. Designed for, not shipped. */
  distributedRendering: boolean;
  deviceLossRecovery: boolean;
}

export interface EngineCapabilities {
  engineId: string;
  engineName: string;
  softwareVersion: string;
  protocolVersion: number;
  /** SceneDocument schema versions this engine can consume. */
  sceneDocumentVersions: number[];
  stageDocumentVersions: number[];
  os: EngineOsInfo;
  cpu: EngineCpuInfo;
  gpu: EngineGpuInfo;
  limits: EngineLimits;
  supportedTextureFormats: string[];
  supportedVideoFormats: string[];
  supportedShaderFeatures: string[];
  outputAdapters: OutputAdapterCapability[];
  features: EngineFeatureFlags;
  /** Transitions actually implemented. Anything absent is refused, not faked. */
  supportedTransitions: string[];
  supportedQualityProfiles: string[];
  /** Object types the native renderer draws. Others are reported unsupported. */
  renderedObjectTypes: string[];
  transports: ("websocket" | "ipc" | "grpc")[];
}

// ---------------------------------------------------------------------------
// Pre-publish validation
// ---------------------------------------------------------------------------

export type CapabilityIssueSeverity = "error" | "warning";

export interface CapabilityIssue {
  severity: CapabilityIssueSeverity;
  code: string;
  message: string;
  subject?: string;
}

export interface CapabilityCheck {
  compatible: boolean;
  issues: CapabilityIssue[];
}

export interface StageRequirements {
  logicalWidth: number;
  logicalHeight: number;
  tilingEnabled: boolean;
  tileWidth: number;
  tileHeight: number;
  overscan: number;
  surfaceCount: number;
  outputCount: number;
  requiredOutputAdapters: string[];
  tileCacheBudgetBytes: number;
}

/**
 * Check a stage against a connected engine.
 *
 * Errors mean the engine will refuse the stage; warnings mean it will accept it
 * but the operator should know something first. This runs in the Editor before
 * publishing so a 50,000-wide stage never surprises anyone at air time.
 */
export function checkStageCapability(
  requirements: StageRequirements,
  capabilities: EngineCapabilities
): CapabilityCheck {
  const issues: CapabilityIssue[] = [];
  const limits = capabilities.limits;

  if (requirements.logicalWidth > limits.maxLogicalCanvasWidth) {
    issues.push({
      severity: "error",
      code: "CANVAS_WIDTH_UNSUPPORTED",
      message: `engine "${capabilities.engineName}" supports a logical width of ${limits.maxLogicalCanvasWidth}; the stage needs ${requirements.logicalWidth}`
    });
  }
  if (requirements.logicalHeight > limits.maxLogicalCanvasHeight) {
    issues.push({
      severity: "error",
      code: "CANVAS_HEIGHT_UNSUPPORTED",
      message: `engine "${capabilities.engineName}" supports a logical height of ${limits.maxLogicalCanvasHeight}; the stage needs ${requirements.logicalHeight}`
    });
  }

  const needsTiling =
    requirements.logicalWidth > limits.maxTextureDimension2d
    || requirements.logicalHeight > limits.maxTextureDimension2d;

  if (needsTiling && !requirements.tilingEnabled) {
    issues.push({
      severity: "error",
      code: "TILING_REQUIRED",
      message: `the stage exceeds the engine's ${limits.maxTextureDimension2d}px texture limit, so tiling must be enabled`
    });
  }
  if (needsTiling && !capabilities.features.tileRendering) {
    issues.push({
      severity: "error",
      code: "TILING_UNSUPPORTED",
      message: `engine "${capabilities.engineName}" does not support tiled rendering but the stage requires it`
    });
  }

  if (requirements.tilingEnabled) {
    const footprint = Math.max(
      requirements.tileWidth + requirements.overscan * 2,
      requirements.tileHeight + requirements.overscan * 2
    );
    if (footprint > limits.maxTextureDimension2d) {
      issues.push({
        severity: "error",
        code: "TILE_TOO_LARGE",
        message: `tile plus overscan is ${footprint}px; the engine's texture limit is ${limits.maxTextureDimension2d}px`
      });
    }
    if (Math.max(requirements.tileWidth, requirements.tileHeight) > limits.maxTileSize) {
      issues.push({
        severity: "error",
        code: "TILE_SIZE_UNSUPPORTED",
        message: `the engine's maximum tile size is ${limits.maxTileSize}px`
      });
    }
  }

  if (requirements.surfaceCount > limits.maxSurfaces) {
    issues.push({
      severity: "error",
      code: "TOO_MANY_SURFACES",
      message: `the engine supports ${limits.maxSurfaces} surfaces; the stage declares ${requirements.surfaceCount}`
    });
  }
  if (requirements.outputCount > limits.maxOutputs) {
    issues.push({
      severity: "error",
      code: "TOO_MANY_OUTPUTS",
      message: `the engine supports ${limits.maxOutputs} outputs; the stage declares ${requirements.outputCount}`
    });
  }

  const available = new Map(
    capabilities.outputAdapters.map((adapter) => [adapter.adapterId, adapter])
  );
  for (const adapterId of requirements.requiredOutputAdapters) {
    const adapter = available.get(adapterId);
    if (!adapter) {
      issues.push({
        severity: "error",
        code: "OUTPUT_ADAPTER_UNKNOWN",
        message: `engine "${capabilities.engineName}" has no output adapter "${adapterId}"`,
        subject: adapterId
      });
      continue;
    }
    if (!adapter.available) {
      issues.push({
        severity: "error",
        code: "OUTPUT_ADAPTER_UNAVAILABLE",
        message: `output adapter "${adapter.name}" is present but unavailable${adapter.unavailableReason ? `: ${adapter.unavailableReason}` : ""}`,
        subject: adapterId
      });
    }
  }

  if (
    capabilities.gpu.memoryBytesEstimate > 0
    && requirements.tileCacheBudgetBytes > capabilities.gpu.memoryBytesEstimate
  ) {
    issues.push({
      severity: "warning",
      code: "TILE_CACHE_OVER_VRAM",
      message: `the tile cache budget exceeds the engine's estimated ${formatBytes(capabilities.gpu.memoryBytesEstimate)} of GPU memory`
    });
  }

  if (!capabilities.features.virtualCanvas && needsTiling) {
    issues.push({
      severity: "error",
      code: "VIRTUAL_CANVAS_UNSUPPORTED",
      message: `engine "${capabilities.engineName}" does not implement the virtual canvas`
    });
  }

  return { compatible: !issues.some((issue) => issue.severity === "error"), issues };
}

export interface SceneRequirements {
  sceneDocumentVersion: number;
  objectTypes: string[];
  transitionKinds: string[];
  usesVideo: boolean;
  usesNativeText: boolean;
  uses3d: boolean;
  assetCount: number;
}

/** Check a scene against a connected engine, same error/warning contract. */
export function checkSceneCapability(
  requirements: SceneRequirements,
  capabilities: EngineCapabilities
): CapabilityCheck {
  const issues: CapabilityIssue[] = [];

  if (!capabilities.sceneDocumentVersions.includes(requirements.sceneDocumentVersion)) {
    issues.push({
      severity: "error",
      code: "SCENE_VERSION_UNSUPPORTED",
      message: `engine accepts SceneDocument versions [${capabilities.sceneDocumentVersions.join(", ")}]; the scene is version ${requirements.sceneDocumentVersion}`
    });
  }

  const rendered = new Set(capabilities.renderedObjectTypes);
  for (const objectType of requirements.objectTypes) {
    if (!rendered.has(objectType)) {
      issues.push({
        severity: "warning",
        code: "OBJECT_TYPE_UNSUPPORTED",
        message: `engine "${capabilities.engineName}" does not render "${objectType}" objects; they will be omitted`,
        subject: objectType
      });
    }
  }

  const transitions = new Set(capabilities.supportedTransitions);
  for (const kind of requirements.transitionKinds) {
    if (!transitions.has(kind)) {
      // Explicitly not silently substituted with a cut.
      issues.push({
        severity: "error",
        code: "TRANSITION_UNSUPPORTED",
        message: `engine "${capabilities.engineName}" does not implement the "${kind}" transition and will refuse it rather than substituting a cut`,
        subject: kind
      });
    }
  }

  if (requirements.usesVideo && !capabilities.features.nativeVideoDecode) {
    issues.push({
      severity: "warning",
      code: "VIDEO_DECODE_UNSUPPORTED",
      message: `engine "${capabilities.engineName}" has no native video decode; video objects will not play`
    });
  }
  if (requirements.usesNativeText && !capabilities.features.nativeTextRender) {
    issues.push({
      severity: "error",
      code: "TEXT_RENDER_UNSUPPORTED",
      message: `engine "${capabilities.engineName}" cannot render text natively`
    });
  }
  if (requirements.uses3d && !capabilities.features.native3dRender) {
    issues.push({
      severity: "error",
      code: "3D_UNSUPPORTED",
      message: `engine "${capabilities.engineName}" cannot render 3D content`
    });
  }

  return { compatible: !issues.some((issue) => issue.severity === "error"), issues };
}

/**
 * Best engine for a stage, among those connected.
 *
 * Prefers compatibility, then the fewest warnings, then the largest texture
 * limit as a rough capability proxy. Returns undefined when nothing fits, which
 * the caller must surface rather than silently picking the least-bad engine.
 */
export function selectEngineForStage(
  requirements: StageRequirements,
  engines: readonly EngineCapabilities[]
): { engine: EngineCapabilities; check: CapabilityCheck } | undefined {
  const scored = engines
    .map((engine) => ({ engine, check: checkStageCapability(requirements, engine) }))
    .filter((entry) => entry.check.compatible)
    .sort((a, b) => {
      const warnings = a.check.issues.length - b.check.issues.length;
      if (warnings !== 0) return warnings;
      return b.engine.limits.maxTextureDimension2d - a.engine.limits.maxTextureDimension2d;
    });

  return scored[0];
}

function formatBytes(value: number): string {
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GiB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MiB`;
  return `${value} B`;
}
