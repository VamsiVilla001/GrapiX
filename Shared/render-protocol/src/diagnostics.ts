/**
 * Engine status and diagnostics payloads.
 *
 * Requirement 22 lists what an operator must be able to see. This is that list,
 * typed, so a diagnostics panel cannot quietly omit a field the operator needs
 * when something is wrong at air time.
 */

import type { EngineState } from "./engine-state.js";
import type { EngineOutputStatus, ScenePreparationState } from "./messages.js";

export interface EngineSceneStatus {
  sceneId: string;
  name: string;
  revision: number;
  preparationState: ScenePreparationState;
  /** null when the scene is loaded but on no channel. */
  channel: "preview" | "program" | "auxiliary" | null
  objectCount: number;
  preparedTileCount: number;
  estimatedBytes: number;
  warnings: string[];
  takeReady: boolean;
  takeBlockers: string[];
  lastUsedMs: number;
}

export interface EngineTileStatus {
  tileId: string;
  column: number;
  row: number;
  dirty: boolean;
  renderState: string;
  gpuState: string;
  cacheState: string;
  lastRenderedFrame: number | null;
  activeObjectCount: number;
  requiredOverscan: number;
  estimatedBytes: number;
}

export interface EngineTileSummary {
  gridColumns: number;
  gridRows: number;
  totalTiles: number;
  trackedTiles: number;
  activeTiles: number;
  dirtyTiles: number;
  residentTiles: number;
  evictedTiles: number;
  pinnedTiles: number;
  cacheBytes: number;
  cacheBudgetBytes: number;
  tileWidth: number;
  tileHeight: number;
  overscan: number;
}

export interface EngineFrameStatus {
  /** Rational, so 59.94 is exactly 60000/1001. */
  frameRateNumerator: number;
  frameRateDenominator: number;
  currentFrame: number;
  framesRendered: number;
  framesDropped: number;
  framesLate: number;
  lastRenderMs: number;
  averageRenderMs: number;
  p99RenderMs: number;
  frameBudgetMs: number;
  budgetUtilization: number;
}

export interface EngineRenderStatus {
  backend: string;
  drawCalls: number;
  textureCount: number;
  bufferCount: number;
  pipelineCount: number;
  estimatedVramBytes: number;
  renderPasses: number;
}

export interface EngineAssetStatus {
  registeredAssets: number;
  readyAssets: number;
  loadingAssets: number;
  failedAssets: number;
  diskBytes: number;
  decodedCpuBytes: number;
  gpuBytes: number;
  cpuBudgetBytes: number;
  gpuBudgetBytes: number;
}

// Output status lives in `messages.ts` alongside the output configuration
// payloads, because it is the reply shape for `output.list` as well as a field in
// status. Two definitions drifted apart the moment the virtual output added
// `live` and `hardwareCertified`.
export type { EngineOutputStatus } from "./messages.js";

export interface EngineStageStatus {
  stageId: string | null;
  logicalWidth: number;
  logicalHeight: number;
  /** Bytes a stage-sized target would need. Reported, never allocated. */
  fullResolutionBytes: number;
  surfaceCount: number;
  viewportCount: number;
  /** Resolution of the viewport currently driving Program. */
  activeViewportWidth: number;
  activeViewportHeight: number;
  tilingEnabled: boolean;
}

export interface EngineNetworkStatus {
  connectedClients: number;
  /** Round-trip time measured from heartbeats. */
  lastLatencyMs: number;
  averageLatencyMs: number;
  messagesReceived: number;
  messagesSent: number;
  duplicatesDropped: number;
  sequenceGaps: number;
  resyncCount: number;
}

/** Compact status, safe to poll frequently. */
export interface EngineStatus {
  engineId: string;
  engineName: string;
  /** Bind address as the engine sees it, for operator confirmation. */
  address: string;
  softwareVersion: string;
  state: EngineState;
  uptimeMs: number;
  qualityProfile: string;
  headless: boolean;
  stage: EngineStageStatus;
  scenes: EngineSceneStatus[];
  previewSceneId: string | null;
  programSceneId: string | null;
  tiles: EngineTileSummary;
  frame: EngineFrameStatus;
  render: EngineRenderStatus;
  assets: EngineAssetStatus;
  outputs: EngineOutputStatus[];
  network: EngineNetworkStatus;
  warnings: string[];
  errors: string[];
}

/** Full diagnostics, including the potentially large per-tile table. */
export interface EngineDiagnostics extends EngineStatus {
  gpuAdapter: string;
  gpuBackend: string;
  gpuLimits: Record<string, number>;
  /** Present only when explicitly requested; can be thousands of rows. */
  tileDetail?: EngineTileStatus[];
  /** Recent state changes, newest last. */
  stateHistory: { from: EngineState; to: EngineState; reason: string; atMs: number }[];
  /** Recent log lines, if diagnostics logging is enabled. */
  recentLog?: string[];
  configPath: string | null;
  assetRoots: string[];
}

/**
 * One-line operator summary.
 *
 * Deliberately leads with the problem when there is one: an operator scanning a
 * row of engines needs to see "error" before they see a frame rate.
 */
export function summarizeEngineStatus(status: EngineStatus): string {
  const rate = (status.frame.frameRateNumerator / status.frame.frameRateDenominator).toFixed(2);
  const parts = [`${status.engineName} [${status.state}]`];

  if (status.errors.length > 0) {
    parts.push(`${status.errors.length} error(s)`);
  }
  if (status.warnings.length > 0) {
    parts.push(`${status.warnings.length} warning(s)`);
  }

  parts.push(`${status.stage.logicalWidth}x${status.stage.logicalHeight} logical`);
  parts.push(`${status.tiles.activeTiles}/${status.tiles.totalTiles} tiles`);
  parts.push(`${rate} fps`);

  if (status.frame.framesDropped > 0) {
    parts.push(`${status.frame.framesDropped} dropped`);
  }

  return parts.join(" · ");
}

/** Whether the operator should be prevented from taking this engine on air. */
export function hasBlockingCondition(status: EngineStatus): boolean {
  return (
    status.state === "error"
    || status.state === "offline"
    || status.errors.length > 0
    || status.outputs.some((output) => output.state === "error")
  );
}
