/**
 * Editor-side render engine client.
 *
 * The Editor's authority is scene *content*. It may publish a scene, validate it,
 * ask for a preview, and read diagnostics. It may not put anything on air — that
 * is Playout's decision — and it never touches a renderer object.
 *
 * The command surface below enforces that by omission: there is no `takeOnline`
 * here. `EngineConnection` can send one, but the Editor's wrapper does not expose
 * it, so an accidental Take cannot be written in editor code.
 */

import {
  checkSceneCapability,
  checkStageCapability,
  EngineConnection,
  EngineRegistry,
  engineUrl,
  isEngineOperational,
  localEngineCandidates,
  normalizeEngineProfile,
  WebSocketEngineTransport,
  type CapabilityCheck,
  type CapabilityIssue,
  type EngineCapabilities,
  type EngineProfile,
  type EngineRecord,
  type EngineState,
  type PreviewReplyPayload,
  type SceneRequirements,
  type StageRequirements
} from "@grapix/render-protocol";
import { checkSceneSeparation, sanitizeSceneForEngine, type ScenePatch } from "@grapix/scene-model";
import type { SceneDocument } from "@grapix/shared-types";
import {
  implicitStageForScene,
  summarizeStage,
  type StageDocument
} from "@grapix/stage-model";

export const EDITOR_CLIENT_VERSION = "0.2.0";

export interface EditorEngineClientOptions {
  clientId?: string;
  projectId?: string;
  /** Injected in tests; defaults to a real WebSocket transport. */
  createTransport?: (profile: EngineProfile) => WebSocketEngineTransport;
}

export interface EngineConnectionSnapshot {
  profileId: string;
  label: string;
  url: string;
  state: EngineState;
  engineId: string | null;
  reportedName: string | null;
  softwareVersion: string | null;
  authenticated: boolean;
  lastLatencyMs: number;
  lastError: string | null;
  /** Operator-facing GPU summary, or null before capabilities arrive. */
  gpuSummary: string | null;
  /** Largest logical canvas this engine will accept. */
  maxLogicalCanvas: { width: number; height: number } | null;
  maxTextureDimension: number | null;
  tileRendering: boolean | null;
}

export interface PublishPreflight {
  /** False when publishing would be refused or is unsafe. */
  publishable: boolean;
  /** Blocking problems. */
  errors: CapabilityIssue[];
  /** Non-blocking problems the operator should see first. */
  warnings: CapabilityIssue[];
  /** Problems found in the document itself, before any engine was consulted. */
  documentIssues: string[];
}

/**
 * Editor's view of the connected engines.
 *
 * Wraps the shared `EngineRegistry` and `EngineConnection` rather than
 * reimplementing them, so the Editor and Playout cannot drift on what an engine's
 * state means.
 */
export class EditorEngineClient {
  private readonly registry = new EngineRegistry();
  private readonly connections = new Map<string, EngineConnection>();
  private readonly options: EditorEngineClientOptions;
  private readonly listeners = new Set<() => void>();

  constructor(options: EditorEngineClientOptions = {}) {
    this.options = options;
  }

  /** Subscribe to any change worth re-rendering a panel for. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Manual IP and port entry. */
  addEngine(host: string, port: number, overrides: Partial<EngineProfile> = {}): EngineRecord {
    const profileId = overrides.profileId ?? `manual-${host}-${port}`;
    const profile = normalizeEngineProfile({ ...overrides, profileId, host, port });
    const record = this.registry.register(profile, "manual", Date.now());
    this.emit();
    return record;
  }

  /** Register the saved engine profiles. */
  addProfiles(profiles: readonly EngineProfile[]): void {
    for (const profile of profiles) {
      this.registry.register(normalizeEngineProfile(profile), "profile", Date.now());
    }
    this.emit();
  }

  /**
   * Register the local-engine candidates.
   *
   * Loopback only. Registering them does not connect: an operator sees the
   * candidates and chooses.
   */
  discoverLocalEngines(): EngineRecord[] {
    const records = localEngineCandidates().map((profile) =>
      this.registry.register(profile, "local-scan", Date.now())
    );
    this.emit();
    return records;
  }

  removeEngine(profileId: string): void {
    this.disconnect(profileId, "removed by operator");
    this.registry.remove(profileId);
    this.emit();
  }

  engines(): EngineConnectionSnapshot[] {
    return this.registry.all().map((record) => toSnapshot(record));
  }

  engine(profileId: string): EngineConnectionSnapshot | undefined {
    const record = this.registry.get(profileId);
    return record ? toSnapshot(record) : undefined;
  }

  capabilities(profileId: string): EngineCapabilities | null {
    return this.registry.get(profileId)?.capabilities ?? null;
  }

  /**
   * Connect to an engine and negotiate capabilities.
   *
   * Failures are recorded on the record rather than thrown away, so the panel can
   * show why an engine is unreachable.
   */
  async connect(profileId: string, authToken?: string): Promise<EngineCapabilities> {
    const record = this.registry.get(profileId);
    if (!record) {
      throw new Error(`no engine profile ${profileId}`);
    }

    this.disconnect(profileId, "reconnecting");

    const profile = normalizeEngineProfile({
      profileId,
      host: record.host,
      port: record.port,
      label: record.label,
      role: record.role,
      ...(authToken ? { authToken } : {})
    });

    const transport =
      this.options.createTransport?.(profile)
      ?? new WebSocketEngineTransport({
        url: engineUrl(profile.host, profile.port, { secure: profile.secure }),
        ...(profile.authToken ? { authToken: profile.authToken } : {})
      });

    const connection = new EngineConnection({
      clientId: this.options.clientId ?? "grapix-editor",
      clientName: "GrapiX Editor",
      clientRole: "editor",
      clientVersion: EDITOR_CLIENT_VERSION,
      transport,
      ...(this.options.projectId ? { projectId: this.options.projectId } : {}),
      ...(profile.authToken ? { authToken: profile.authToken } : {}),
      autoReconnect: true
    });

    connection.on((event) => {
      switch (event.type) {
        case "state":
          this.registry.observe(profileId, { state: event.state, atMs: Date.now() });
          break;
        case "capabilities":
          this.registry.observe(profileId, {
            capabilities: event.capabilities,
            authenticated: true,
            atMs: Date.now()
          });
          break;
        case "latency":
          this.registry.observe(profileId, { lastLatencyMs: event.latencyMs });
          break;
        case "closed":
          this.registry.observe(profileId, {
            state: "offline",
            authenticated: false,
            lastError: event.reason,
            atMs: Date.now()
          });
          break;
        case "protocol-error":
          this.registry.observe(profileId, {
            lastError: `${event.code}: ${event.errors.join("; ")}`
          });
          break;
        default:
          break;
      }
      this.emit();
    });

    this.connections.set(profileId, connection);

    try {
      const capabilities = await connection.connect();
      this.registry.observe(profileId, {
        capabilities,
        authenticated: true,
        state: connection.state,
        atMs: Date.now()
      });
      this.emit();
      return capabilities;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.registry.recordFailure(profileId, message, Date.now());
      this.connections.delete(profileId);
      this.emit();
      throw error;
    }
  }

  disconnect(profileId: string, reason = "editor disconnected"): void {
    const connection = this.connections.get(profileId);
    if (!connection) return;
    connection.disconnect(reason);
    this.connections.delete(profileId);
    this.registry.observe(profileId, {
      state: "offline",
      authenticated: false,
      atMs: Date.now()
    });
    this.emit();
  }

  disconnectAll(reason = "editor closing"): void {
    for (const profileId of [...this.connections.keys()]) {
      this.disconnect(profileId, reason);
    }
  }

  /** Drive heartbeats and timeout detection. Call from an interval. */
  tick(): void {
    for (const connection of this.connections.values()) {
      connection.tick();
    }
  }

  // -------------------------------------------------------------------------
  // Pre-publish validation
  // -------------------------------------------------------------------------

  /**
   * Check a scene and its stage against an engine before publishing.
   *
   * The point of requirement 9: the operator learns that a stage will not fit
   * *before* it is taken on air, not when the engine refuses it.
   */
  preflight(
    profileId: string,
    scene: SceneDocument,
    stage?: StageDocument
  ): PublishPreflight {
    const errors: CapabilityIssue[] = [];
    const warnings: CapabilityIssue[] = [];

    // The document itself first: no engine is needed to know a scene is holding a
    // DOM node.
    const separation = checkSceneSeparation(scene);
    const documentIssues = separation.issues
      .filter((issue) => issue.severity === "error")
      .map((issue) => `${issue.path}: ${issue.message}`);

    const record = this.registry.get(profileId);
    if (!record) {
      errors.push({
        severity: "error",
        code: "ENGINE_UNKNOWN",
        message: `no engine profile ${profileId}`
      });
      return { publishable: false, errors, warnings, documentIssues };
    }

    if (!isEngineOperational(record.state)) {
      errors.push({
        severity: "error",
        code: "ENGINE_NOT_READY",
        message: `engine "${record.label}" is ${record.state}${record.lastError ? ` — ${record.lastError}` : ""}`
      });
    }

    const capabilities = record.capabilities;
    if (!capabilities) {
      errors.push({
        severity: "error",
        code: "CAPABILITIES_UNKNOWN",
        message: `engine "${record.label}" has not reported its capabilities yet`
      });
      return {
        publishable: false,
        errors,
        warnings,
        documentIssues
      };
    }

    const resolvedStage = stage ?? implicitStageForScene(scene);
    const stageCheck = checkStageCapability(
      stageRequirements(resolvedStage),
      capabilities
    );
    const sceneCheck = checkSceneCapability(sceneRequirements(scene), capabilities);

    collect(stageCheck, errors, warnings);
    collect(sceneCheck, errors, warnings);

    return {
      publishable:
        errors.length === 0 && documentIssues.length === 0 && isEngineOperational(record.state),
      errors,
      warnings,
      documentIssues
    };
  }

  /**
   * Publish a scene to an engine for preview.
   *
   * Deliberately loads and prepares only. Nothing here can put a scene on air:
   * that verb is not part of the Editor's surface.
   */
  async publishForPreview(
    profileId: string,
    scene: SceneDocument,
    stage?: StageDocument
  ): Promise<void> {
    const connection = this.requireConnection(profileId);

    // Strip editor chrome at the boundary where an authoring document becomes a
    // render document.
    const { scene: sanitized } = sanitizeSceneForEngine(scene);

    if (stage) {
      await connection.request("stage.load", { stage });
    }

    await connection.request(
      "scene.load",
      {
        scene: sanitized,
        ...(stage ? { stageId: stage.stageId } : {}),
        prepare: true
      },
      { sceneId: sanitized.id, sceneRevision: sanitized.revision ?? 0 }
    );
  }

  /**
   * Make an asset available on the engine.
   *
   * Registers it by digest first: when the engine already holds that exact content —
   * because another scene uses the same logo, or this scene was published before — the
   * reply says so and nothing is transferred. Only genuinely new bytes are chunked up.
   *
   * The digest is computed here rather than trusted from metadata, because it is what the
   * engine verifies against. A wrong digest fails the transfer, which is the correct
   * outcome but a confusing one to debug if the two sides computed it differently.
   */
  async syncAsset(
    profileId: string,
    asset: { assetId: string; mimeType: string; bytes: Uint8Array },
    onProgress?: (sent: number, total: number) => void
  ): Promise<{ transferred: boolean; sha256: string }> {
    const connection = this.requireConnection(profileId);
    const sha256 = await sha256Hex(asset.bytes);

    const registered = await connection.request("asset.register", {
      assetId: asset.assetId,
      uri: "",
      transport: "upload",
      mimeType: asset.mimeType,
      sizeBytes: asset.bytes.byteLength,
      sha256
    });

    const payload = registered.payload as {
      alreadyCached?: boolean;
      maxChunkBytes?: number;
    };
    if (payload.alreadyCached) {
      onProgress?.(asset.bytes.byteLength, asset.bytes.byteLength);
      return { transferred: false, sha256 };
    }

    // The engine tells us its own limit; using it rather than a constant means a
    // deployment can tune the chunk size without the Editor changing.
    const chunkBytes = Math.max(1, payload.maxChunkBytes ?? 1024 * 1024);
    const chunkCount = Math.max(1, Math.ceil(asset.bytes.byteLength / chunkBytes));

    for (let index = 0; index < chunkCount; index += 1) {
      const start = index * chunkBytes;
      const chunk = asset.bytes.subarray(start, Math.min(start + chunkBytes, asset.bytes.byteLength));

      await connection.request("asset.upload", {
        assetId: asset.assetId,
        sha256,
        chunkIndex: index,
        chunkCount,
        data: base64FromBytes(chunk),
        totalBytes: asset.bytes.byteLength
      });

      onProgress?.(Math.min(start + chunk.byteLength, asset.bytes.byteLength), asset.bytes.byteLength);
    }

    return { transferred: true, sha256 };
  }

  /** Which of these assets the engine can render right now. */
  async assetReadiness(
    profileId: string,
    assetIds: string[]
  ): Promise<{ ready: string[]; missing: string[] }> {
    const connection = this.requireConnection(profileId);
    const reply = await connection.request("asset.preload", { assetIds });
    const payload = reply.payload as { ready?: string[]; missing?: string[] };
    return { ready: payload.ready ?? [], missing: payload.missing ?? [] };
  }

  /**
   * Ask the engine to re-verify an asset's bytes.
   *
   * Worth doing when a render looks wrong: a content-addressed cache promises the name
   * matches the bytes, and this is how that promise is checked rather than assumed.
   */
  async validateAsset(
    profileId: string,
    assetId: string
  ): Promise<{ present: boolean; digestMatches: boolean; message: string }> {
    const connection = this.requireConnection(profileId);
    const reply = await connection.request("asset.validate", { assetId });
    const payload = reply.payload as {
      present?: boolean;
      digestMatches?: boolean;
      message?: string;
    };
    return {
      present: payload.present === true,
      digestMatches: payload.digestMatches === true,
      message: payload.message ?? ""
    };
  }

  /**
   * Send an incremental patch instead of the whole document.
   *
   * A 400-object scene with embedded assets is megabytes; resending it because a
   * rectangle moved makes the engine re-prepare every text layout and every mesh. A
   * patch is revision-gated on the engine side, so this returns what the engine
   * actually holds afterwards, and the caller must use that as the next
   * `baseRevision`.
   *
   * On a `REVISION_MISMATCH` the recovery is `fullSync`, never a retry: the two sides
   * disagree about what is held, and guessing produces an engine rendering a document
   * nobody else has.
   */
  async applyPatch(
    profileId: string,
    patch: ScenePatch
  ): Promise<{ revision: number; objectsTouched: string[]; wholeSceneInvalidated: boolean }> {
    const connection = this.requireConnection(profileId);

    const reply = await connection.request(
      "scene.applyPatch",
      { patch: { ...patch, timestampMs: patch.timestampMs || Date.now() } },
      { sceneId: patch.sceneId, sceneRevision: patch.baseRevision }
    );

    const payload = reply.payload as {
      sceneRevision?: number;
      objectsTouched?: string[];
      wholeSceneInvalidated?: boolean;
    };

    return {
      revision: payload.sceneRevision ?? patch.revision,
      objectsTouched: payload.objectsTouched ?? [],
      wholeSceneInvalidated: payload.wholeSceneInvalidated === true
    };
  }

  /**
   * Resend a scene in full.
   *
   * The only recovery from a revision mismatch or a sequence gap. Kept separate from
   * `publishForPreview` so the reason is recorded in the engine's audit trail.
   */
  async fullSync(
    profileId: string,
    scene: SceneDocument,
    reason: "requested" | "revision-gap" | "conflict" | "reconnect" | "initial" = "conflict"
  ): Promise<void> {
    const connection = this.requireConnection(profileId);
    const { scene: sanitized } = sanitizeSceneForEngine(scene);

    await connection.request(
      "scene.fullSync",
      { scene: sanitized, reason },
      { sceneId: sanitized.id, sceneRevision: sanitized.revision ?? 0 }
    );
  }

  /**
   * Whether this engine will accept patches.
   *
   * Checked rather than assumed: an older engine refuses them, and the caller should
   * fall back to `fullSync` rather than discovering it one edit at a time.
   */
  supportsPatching(profileId: string): boolean {
    return (
      this.registry.get(profileId)?.capabilities?.features.scenePatching === true
    );
  }

  /**
   * Ask for a preview image.
   *
   * The source must always be bounded. There is no "whole stage at full
   * resolution" option, because on a 50,000² stage that is a 10 GB frame.
   */
  async requestPreview(
    profileId: string,
    options: {
      maxWidth?: number;
      maxHeight?: number;
      viewportId?: string;
      showTileDebug?: boolean;
    } = {}
  ): Promise<PreviewReplyPayload> {
    const connection = this.requireConnection(profileId);

    const source = options.viewportId
      ? ({ type: "viewport", viewportId: options.viewportId } as const)
      : ({
          type: "scaled-stage",
          maxWidth: options.maxWidth ?? 1920,
          maxHeight: options.maxHeight ?? 1080
        } as const);

    const reply = await connection.request("preview.request", {
      channel: "preview",
      source,
      encoding: "jpeg",
      quality: 80,
      ...(options.showTileDebug ? { showTileDebug: true } : {})
    });

    return reply.payload as PreviewReplyPayload;
  }

  /**
   * Start a preview stream and receive frames as they arrive.
   *
   * Frames come as `event.previewFrame` events addressed to this client, so nothing is
   * polled and no other connection pays for them. The returned function stops the
   * stream and unsubscribes; call it when the viewport is unmounted, or the engine keeps
   * rendering frames nobody is looking at.
   *
   * The engine clamps the rate to its own ceiling and says so in the reply warnings,
   * which are passed to `onWarnings` rather than swallowed: an animation timed against
   * the requested rate would otherwise look wrong for no visible reason.
   */
  async startPreviewStream(
    profileId: string,
    options: {
      streamId: string;
      targetFps?: number;
      maxWidth?: number;
      maxHeight?: number;
      viewportId?: string;
      quality?: number;
      showTileDebug?: boolean;
      onFrame: (frame: PreviewReplyPayload) => void;
      onWarnings?: (warnings: string[]) => void;
    }
  ): Promise<() => Promise<void>> {
    const connection = this.requireConnection(profileId);

    const unsubscribe = connection.on((event) => {
      if (event.type !== "engine-event" || event.eventType !== "event.previewFrame") {
        return;
      }
      const payload = event.message.payload as PreviewReplyPayload;
      // Several viewports can stream at once, so a frame for another stream is not ours.
      if (payload.streamId === options.streamId) {
        options.onFrame(payload);
      }
    });

    try {
      const reply = await connection.request("preview.streamStart", {
        streamId: options.streamId,
        channel: "preview",
        source: options.viewportId
          ? { type: "viewport", viewportId: options.viewportId }
          : {
              type: "scaled-stage",
              maxWidth: options.maxWidth ?? 960,
              maxHeight: options.maxHeight ?? 540
            },
        encoding: "jpeg",
        targetFps: options.targetFps ?? 15,
        ...(options.quality !== undefined ? { quality: options.quality } : {}),
        ...(options.showTileDebug ? { showTileDebug: true } : {})
      });

      const warnings = (reply.payload as { warnings?: string[] }).warnings ?? [];
      if (warnings.length > 0) options.onWarnings?.(warnings);
    } catch (error) {
      // Never leave a listener behind for a stream that failed to start.
      unsubscribe();
      throw error;
    }

    let stopped = false;
    return async () => {
      if (stopped) return;
      stopped = true;
      unsubscribe();
      try {
        await connection.request("preview.streamStop", { streamId: options.streamId });
      } catch {
        // The engine may already have dropped it — a disconnect stops every stream for
        // that client. Not worth surfacing on teardown.
      }
    };
  }

  /**
   * Repoint a running stream.
   *
   * Used while panning or zooming the viewport: this keeps the cadence and the stream
   * id, where a stop-and-start would drop frames and reset both.
   */
  async setPreviewStreamViewport(
    profileId: string,
    streamId: string,
    source:
      | { type: "scaled-stage"; maxWidth: number; maxHeight: number }
      | { type: "rect"; x: number; y: number; width: number; height: number; renderScale: number }
      | { type: "viewport"; viewportId: string }
  ): Promise<{ width: number; height: number; renderScale: number }> {
    const connection = this.requireConnection(profileId);
    const reply = await connection.request("preview.setViewport", { streamId, source });
    const payload = reply.payload as { width: number; height: number; renderScale: number };
    return payload;
  }

  /**
   * Ask the engine to rebuild its renderer without restarting the process.
   *
   * For a corrupted pipeline cache or an unexplained render fault. It is **not** a
   * device-loss recovery — the engine says so in its warnings, and those are returned
   * here rather than dropped, because an operator acting on a device loss needs to know
   * the process still has to be restarted.
   */
  async restartRenderer(
    profileId: string,
    reason: string,
    preserveProgram = true
  ): Promise<{ scenesReset: number; warnings: string[] }> {
    const connection = this.requireConnection(profileId);
    const reply = await connection.request("engine.restartRenderer", {
      reason,
      preserveProgram
    });
    const payload = reply.payload as { scenesReset?: number; warnings?: string[] };
    return {
      scenesReset: payload.scenesReset ?? 0,
      warnings: payload.warnings ?? []
    };
  }

  /** Whether this engine will serve preview streams. */
  supportsPreviewStreaming(profileId: string): boolean {
    return (
      this.registry.get(profileId)?.capabilities?.features.previewStreaming === true
    );
  }

  /** Fetch diagnostics for the engine panel. */
  async diagnostics(profileId: string, includeTiles = false): Promise<unknown> {
    const connection = this.requireConnection(profileId);
    const reply = await connection.request("engine.getDiagnostics", {
      includeTiles
    });
    return reply.payload;
  }

  private requireConnection(profileId: string): EngineConnection {
    const connection = this.connections.get(profileId);
    if (!connection) {
      throw new Error(`engine ${profileId} is not connected`);
    }
    return connection;
  }

  private emit(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // A misbehaving panel must not break engine bookkeeping.
      }
    }
  }
}

function collect(
  check: CapabilityCheck,
  errors: CapabilityIssue[],
  warnings: CapabilityIssue[]
): void {
  for (const issue of check.issues) {
    if (issue.severity === "error") {
      errors.push(issue);
    } else {
      warnings.push(issue);
    }
  }
}

/** Derive the stage requirements a capability check needs. */
export function stageRequirements(stage: StageDocument): StageRequirements {
  const summary = summarizeStage(stage);
  const adapters = new Set<string>();
  for (const output of stage.outputs) {
    if (output.enabled) adapters.add(output.adapterId);
  }

  return {
    logicalWidth: summary.logicalWidth,
    logicalHeight: summary.logicalHeight,
    tilingEnabled: stage.tiling.enabled,
    tileWidth: stage.tiling.tileWidth,
    tileHeight: stage.tiling.tileHeight,
    overscan: stage.tiling.overscan,
    surfaceCount: stage.surfaces.length,
    outputCount: summary.outputCount,
    requiredOutputAdapters: [...adapters],
    tileCacheBudgetBytes: stage.tiling.cacheBudgetBytes
  };
}

/** Derive the scene requirements a capability check needs. */
export function sceneRequirements(scene: SceneDocument): SceneRequirements {
  const objectTypes = new Set<string>();
  let uses3d = false;
  let usesVideo = false;
  let usesNativeText = false;

  for (const object of scene.objects) {
    objectTypes.add(object.type);
    if (object.type === "mesh" || object.type === "light" || object.type === "camera") {
      uses3d = true;
    }
    if (object.type === "text") {
      usesNativeText = true;
    }
  }

  for (const asset of scene.assets) {
    if (asset.kind === "video") usesVideo = true;
  }

  const transitionKinds = new Set<string>();
  for (const marker of scene.timeline.markers ?? []) {
    // Markers do not name transitions, but their presence means the scene expects
    // continue-point behaviour, which the engine must support.
    if (marker.kind === "continue-point") transitionKinds.add("cut");
  }

  return {
    sceneDocumentVersion: scene.version,
    objectTypes: [...objectTypes],
    transitionKinds: [...transitionKinds],
    usesVideo,
    usesNativeText,
    uses3d,
    assetCount: scene.assets.length
  };
}

function toSnapshot(record: EngineRecord): EngineConnectionSnapshot {
  const capabilities = record.capabilities;

  return {
    profileId: record.profileId,
    label: record.label,
    url: record.url,
    state: record.state,
    engineId: record.engineId,
    reportedName: record.reportedName,
    softwareVersion: record.softwareVersion,
    authenticated: record.authenticated,
    lastLatencyMs: record.lastLatencyMs,
    lastError: record.lastError,
    gpuSummary: capabilities
      ? `${capabilities.gpu.adapter} (${capabilities.gpu.backend}, ${capabilities.gpu.deviceType})`
      : null,
    maxLogicalCanvas: capabilities
      ? {
          width: capabilities.limits.maxLogicalCanvasWidth,
          height: capabilities.limits.maxLogicalCanvasHeight
        }
      : null,
    maxTextureDimension: capabilities?.limits.maxTextureDimension2d ?? null,
    tileRendering: capabilities?.features.tileRendering ?? null
  };
}

/**
 * SHA-256 as lower-case hex.
 *
 * Uses Web Crypto, which is present in the browser and in Node 22, so the Editor and any
 * Node host compute the same digest as the engine. Content addressing is only worth
 * anything if all three agree.
 */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Base64 without blowing the call stack.
 *
 * `String.fromCharCode(...bytes)` throws on a large asset — a 4 MB chunk is 4 million
 * arguments — so this walks it in blocks.
 */
function base64FromBytes(bytes: Uint8Array): string {
  const BLOCK = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += BLOCK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + BLOCK));
  }
  return btoa(binary);
}
