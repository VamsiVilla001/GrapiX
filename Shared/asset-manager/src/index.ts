/**
 * `@grapix/asset-manager` — asset lifecycle, content addressing, and upload.
 *
 * The engine must be able to prepare and validate assets *independently*, because
 * it may be on another machine with no access to the Editor's filesystem. That
 * shapes everything here:
 *
 *   - assets are identified by content hash, so the same bytes are never
 *     transferred or stored twice;
 *   - every asset has an explicit state machine, so "ready" means the bytes are
 *     fetched, decoded, and on the GPU rather than merely referenced;
 *   - uploads are chunked and resumable, because a 400 MB video over a venue
 *     network will be interrupted;
 *   - scene preparation is a gate, and taking an unprepared scene online requires
 *     an explicit operator override.
 */

import type { AssetKind } from "@grapix/shared-types";

// ---------------------------------------------------------------------------
// Asset state
// ---------------------------------------------------------------------------

/**
 * Where the bytes are.
 *
 * Split from decode and GPU state deliberately: a 4K PNG can be fetched but not
 * decoded, or decoded but not uploaded, and those are different problems with
 * different fixes.
 */
export const ASSET_FETCH_STATES = ["absent", "fetching", "cached", "failed"] as const;
export type AssetFetchState = (typeof ASSET_FETCH_STATES)[number];

export const ASSET_DECODE_STATES = ["undecoded", "decoding", "decoded", "failed"] as const;
export type AssetDecodeState = (typeof ASSET_DECODE_STATES)[number];

export const ASSET_GPU_STATES = ["absent", "uploading", "uploaded", "evicted", "failed"] as const;
export type AssetGpuState = (typeof ASSET_GPU_STATES)[number];

export const ASSET_TRANSPORTS = ["engine-local", "http", "upload", "shared-cache"] as const;
export type AssetTransport = (typeof ASSET_TRANSPORTS)[number];

export interface AssetRecord {
  assetId: string;
  /** Source URI, resolved only inside configured roots for `engine-local`. */
  sourceUri: string;
  transport: AssetTransport;
  kind: AssetKind;
  mimeType: string;
  /** SHA-256, lower-case hex. The content-addressing key. */
  sha256: string;
  sizeBytes: number;
  /** Path inside the engine's cache once fetched. */
  cachedPath: string | null;
  fetchState: AssetFetchState;
  decodeState: AssetDecodeState;
  gpuState: AssetGpuState;
  /** Scenes and objects currently using it. Zero means evictable. */
  referenceCount: number;
  /** Monotonic tick of last use, for LRU. */
  lastUsedTick: number;
  decodedBytes: number;
  gpuBytes: number;
  error: string | null;
  /** Decoded dimensions, once known. */
  width?: number;
  height?: number;
}

/** Overall readiness, derived from the three state machines. */
export type AssetReadiness = "ready" | "preparing" | "absent" | "failed";

export function assetReadiness(record: AssetRecord): AssetReadiness {
  if (
    record.fetchState === "failed"
    || record.decodeState === "failed"
    || record.gpuState === "failed"
  ) {
    return "failed";
  }
  if (record.fetchState === "cached" && record.decodeState === "decoded") {
    // GPU residency is recoverable without re-fetching, so an evicted texture is
    // still "ready" from the scene's point of view.
    return record.gpuState === "uploaded" || record.gpuState === "evicted"
      ? "ready"
      : "preparing";
  }
  if (record.fetchState === "absent" && record.decodeState === "undecoded") {
    return "absent";
  }
  return "preparing";
}

// ---------------------------------------------------------------------------
// Content addressing
// ---------------------------------------------------------------------------

const SHA256_HEX = /^[0-9a-f]{64}$/;

export function isValidSha256(value: string): boolean {
  return SHA256_HEX.test(value);
}

/**
 * Cache path for a hash.
 *
 * Two-level fan-out so a cache with a hundred thousand assets does not put a
 * hundred thousand entries in one directory, which several filesystems handle
 * badly.
 */
export function contentCachePath(sha256: string, extension = ""): string {
  if (!isValidSha256(sha256)) {
    throw new Error(`invalid sha256: ${sha256}`);
  }
  const suffix = extension && !extension.startsWith(".") ? `.${extension}` : extension;
  return `${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}${suffix}`;
}

/** Assets sharing a hash. Deduplication candidates. */
export function findDuplicates(
  records: readonly AssetRecord[]
): { sha256: string; assetIds: string[] }[] {
  const byHash = new Map<string, string[]>();
  for (const record of records) {
    const existing = byHash.get(record.sha256);
    if (existing) {
      existing.push(record.assetId);
      continue;
    }
    byHash.set(record.sha256, [record.assetId]);
  }

  return [...byHash.entries()]
    .filter(([, assetIds]) => assetIds.length > 1)
    .map(([sha256, assetIds]) => ({ sha256, assetIds: assetIds.sort() }))
    .sort((a, b) => a.sha256.localeCompare(b.sha256));
}

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------

export type PathRejectionReason =
  | "absolute-path"
  | "parent-traversal"
  | "outside-roots"
  | "empty"
  | "url-scheme"
  | "null-byte";

export interface PathCheck {
  allowed: boolean;
  reason?: PathRejectionReason;
  /** Root the path resolved inside, when allowed. */
  root?: string;
}

/**
 * Is a client-supplied asset path safe to resolve?
 *
 * Requirement 27, and the single most important check in this package: a remote
 * client must never be able to name an arbitrary filesystem path. Relative,
 * traversal-free, and inside a configured root — nothing else is accepted.
 *
 * This is a syntactic pre-check. The engine repeats it after canonicalisation,
 * because a symlink can defeat any amount of string analysis.
 */
export function checkAssetPath(candidate: string, roots: readonly string[]): PathCheck {
  if (!candidate || candidate.trim() === "") {
    return { allowed: false, reason: "empty" };
  }
  if (candidate.includes("\0")) {
    return { allowed: false, reason: "null-byte" };
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(candidate)) {
    // file:, http:, \\?\, and Windows drive letters all land here.
    return { allowed: false, reason: "url-scheme" };
  }
  if (candidate.startsWith("/") || candidate.startsWith("\\")) {
    return { allowed: false, reason: "absolute-path" };
  }

  const segments = candidate.split(/[\\/]+/);
  if (segments.some((segment) => segment === "..")) {
    return { allowed: false, reason: "parent-traversal" };
  }

  if (roots.length === 0) {
    return { allowed: false, reason: "outside-roots" };
  }

  // A relative, traversal-free path is inside whichever root it is joined to, so
  // the first configured root wins.
  return { allowed: true, root: roots[0] };
}

// ---------------------------------------------------------------------------
// Chunked upload
// ---------------------------------------------------------------------------

export interface UploadSession {
  assetId: string;
  sha256: string;
  totalBytes: number;
  chunkCount: number;
  /** Chunk indices received, so a resume knows what to skip. */
  receivedChunks: Set<number>;
  receivedBytes: number;
  startedAtMs: number;
  lastChunkAtMs: number;
  complete: boolean;
  /** Set when the assembled bytes did not match the declared hash. */
  checksumMismatch: boolean;
}

export type UploadChunkResult =
  | { accepted: true; session: UploadSession; duplicate: boolean }
  | { accepted: false; code: UploadRejectionCode; message: string };

export const UPLOAD_REJECTION_CODES = [
  "UNKNOWN_SESSION",
  "CHUNK_OUT_OF_RANGE",
  "CHUNK_TOO_LARGE",
  "TOTAL_TOO_LARGE",
  "SESSION_COMPLETE",
  "INVALID_HASH",
  "SIZE_MISMATCH"
] as const;
export type UploadRejectionCode = (typeof UPLOAD_REJECTION_CODES)[number];

export interface UploadManagerOptions {
  maxChunkBytes?: number;
  maxTotalBytes?: number;
  /** Abandon a session with no chunks for this long. */
  sessionTimeoutMs?: number;
}

/**
 * Chunked, resumable upload tracking.
 *
 * Resumability is not a nicety: a venue network will interrupt a large transfer,
 * and restarting a 400 MB video from zero every time is the difference between a
 * usable system and an unusable one.
 *
 * Out-of-order chunks are accepted because they will happen; duplicates are
 * accepted and reported so a retransmitted chunk is idempotent rather than
 * corrupting the byte count.
 */
export class UploadManager {
  private readonly sessions = new Map<string, UploadSession>();
  private readonly maxChunkBytes: number;
  private readonly maxTotalBytes: number;
  private readonly sessionTimeoutMs: number;

  constructor(options: UploadManagerOptions = {}) {
    this.maxChunkBytes = options.maxChunkBytes ?? 4 * 1024 * 1024;
    this.maxTotalBytes = options.maxTotalBytes ?? 2 * 1024 * 1024 * 1024;
    this.sessionTimeoutMs = options.sessionTimeoutMs ?? 5 * 60_000;
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  begin(
    assetId: string,
    sha256: string,
    totalBytes: number,
    chunkCount: number,
    nowMs: number
  ): UploadChunkResult {
    if (!isValidSha256(sha256)) {
      return { accepted: false, code: "INVALID_HASH", message: `invalid sha256: ${sha256}` };
    }
    if (totalBytes > this.maxTotalBytes) {
      return {
        accepted: false,
        code: "TOTAL_TOO_LARGE",
        message: `upload is ${totalBytes} bytes; limit is ${this.maxTotalBytes}`
      };
    }

    // Resuming an existing session keeps whatever was already received.
    const existing = this.sessions.get(assetId);
    if (existing && existing.sha256 === sha256 && existing.totalBytes === totalBytes) {
      return { accepted: true, session: existing, duplicate: true };
    }

    const session: UploadSession = {
      assetId,
      sha256,
      totalBytes,
      chunkCount: Math.max(1, chunkCount),
      receivedChunks: new Set(),
      receivedBytes: 0,
      startedAtMs: nowMs,
      lastChunkAtMs: nowMs,
      complete: false,
      checksumMismatch: false
    };
    this.sessions.set(assetId, session);
    return { accepted: true, session, duplicate: false };
  }

  /** Accept one chunk. A repeated index is idempotent, not an error. */
  acceptChunk(
    assetId: string,
    chunkIndex: number,
    chunkBytes: number,
    nowMs: number
  ): UploadChunkResult {
    const session = this.sessions.get(assetId);
    if (!session) {
      return {
        accepted: false,
        code: "UNKNOWN_SESSION",
        message: `no upload session for ${assetId}`
      };
    }
    if (session.complete) {
      return {
        accepted: false,
        code: "SESSION_COMPLETE",
        message: `upload for ${assetId} is already complete`
      };
    }
    if (chunkIndex < 0 || chunkIndex >= session.chunkCount) {
      return {
        accepted: false,
        code: "CHUNK_OUT_OF_RANGE",
        message: `chunk ${chunkIndex} is outside 0..${session.chunkCount - 1}`
      };
    }
    if (chunkBytes > this.maxChunkBytes) {
      return {
        accepted: false,
        code: "CHUNK_TOO_LARGE",
        message: `chunk is ${chunkBytes} bytes; limit is ${this.maxChunkBytes}`
      };
    }

    session.lastChunkAtMs = nowMs;

    if (session.receivedChunks.has(chunkIndex)) {
      // A retransmit. Already counted, so do not count it twice.
      return { accepted: true, session, duplicate: true };
    }

    if (session.receivedBytes + chunkBytes > session.totalBytes) {
      return {
        accepted: false,
        code: "SIZE_MISMATCH",
        message: `chunk ${chunkIndex} would exceed the declared ${session.totalBytes} bytes`
      };
    }

    session.receivedChunks.add(chunkIndex);
    session.receivedBytes += chunkBytes;
    session.complete = session.receivedChunks.size === session.chunkCount;

    return { accepted: true, session, duplicate: false };
  }

  /** Chunk indices still needed. What a resuming client asks for. */
  missingChunks(assetId: string): number[] {
    const session = this.sessions.get(assetId);
    if (!session) return [];

    const missing: number[] = [];
    for (let index = 0; index < session.chunkCount; index += 1) {
      if (!session.receivedChunks.has(index)) missing.push(index);
    }
    return missing;
  }

  /**
   * Confirm the assembled bytes hash to what was declared.
   *
   * A mismatch fails the upload rather than caching the bytes. Serving corrupt
   * content from a cache is worse than not having it.
   */
  finalize(assetId: string, actualSha256: string): UploadChunkResult {
    const session = this.sessions.get(assetId);
    if (!session) {
      return {
        accepted: false,
        code: "UNKNOWN_SESSION",
        message: `no upload session for ${assetId}`
      };
    }
    if (!session.complete) {
      return {
        accepted: false,
        code: "SIZE_MISMATCH",
        message: `upload for ${assetId} is missing chunks ${this.missingChunks(assetId).join(", ")}`
      };
    }
    if (actualSha256 !== session.sha256) {
      session.checksumMismatch = true;
      return {
        accepted: false,
        code: "INVALID_HASH",
        message: `declared ${session.sha256} but received bytes hash to ${actualSha256}`
      };
    }

    return { accepted: true, session, duplicate: false };
  }

  get(assetId: string): UploadSession | undefined {
    return this.sessions.get(assetId);
  }

  abandon(assetId: string): void {
    this.sessions.delete(assetId);
  }

  /** Drop sessions that have gone quiet, so an aborted upload is not a leak. */
  expire(nowMs: number): string[] {
    const expired: string[] = [];
    for (const [assetId, session] of this.sessions) {
      if (session.complete) continue;
      if (nowMs - session.lastChunkAtMs > this.sessionTimeoutMs) {
        this.sessions.delete(assetId);
        expired.push(assetId);
      }
    }
    return expired.sort();
  }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export interface AssetRegistryOptions {
  cpuBudgetBytes?: number;
  gpuBudgetBytes?: number;
  diskBudgetBytes?: number;
}

export interface AssetRegistryStats {
  total: number;
  ready: number;
  preparing: number;
  failed: number;
  absent: number;
  referenced: number;
  decodedBytes: number;
  gpuBytes: number;
  diskBytes: number;
  cpuBudgetBytes: number;
  gpuBudgetBytes: number;
  overCpuBudget: boolean;
  overGpuBudget: boolean;
  uniqueContentHashes: number;
}

/**
 * Reference-counted asset registry with LRU eviction.
 *
 * Content-addressed: registering two assets with the same hash shares the cached
 * bytes rather than fetching twice.
 */
export class AssetRegistry {
  private readonly records = new Map<string, AssetRecord>();
  private readonly cpuBudgetBytes: number;
  private readonly gpuBudgetBytes: number;
  private readonly diskBudgetBytes: number;
  private tick = 0;

  constructor(options: AssetRegistryOptions = {}) {
    this.cpuBudgetBytes = options.cpuBudgetBytes ?? 1024 * 1024 * 1024;
    this.gpuBudgetBytes = options.gpuBudgetBytes ?? 1024 * 1024 * 1024;
    this.diskBudgetBytes = options.diskBudgetBytes ?? 8 * 1024 * 1024 * 1024;
  }

  register(descriptor: {
    assetId: string;
    sourceUri: string;
    transport: AssetTransport;
    kind: AssetKind;
    mimeType: string;
    sha256: string;
    sizeBytes: number;
  }): AssetRecord {
    const existing = this.records.get(descriptor.assetId);
    if (existing && existing.sha256 === descriptor.sha256) {
      // Same content: keep whatever preparation has already happened.
      return existing;
    }

    this.tick += 1;

    // Content addressing: if another asset already has these bytes, inherit its
    // cache path instead of fetching again.
    const sibling = [...this.records.values()].find(
      (record) => record.sha256 === descriptor.sha256 && record.fetchState === "cached"
    );

    const record: AssetRecord = {
      assetId: descriptor.assetId,
      sourceUri: descriptor.sourceUri,
      transport: descriptor.transport,
      kind: descriptor.kind,
      mimeType: descriptor.mimeType,
      sha256: descriptor.sha256,
      sizeBytes: descriptor.sizeBytes,
      cachedPath: sibling?.cachedPath ?? null,
      fetchState: sibling ? "cached" : "absent",
      decodeState: "undecoded",
      gpuState: "absent",
      referenceCount: 0,
      lastUsedTick: this.tick,
      decodedBytes: 0,
      gpuBytes: 0,
      error: null
    };

    this.records.set(descriptor.assetId, record);
    return record;
  }

  get(assetId: string): AssetRecord | undefined {
    return this.records.get(assetId);
  }

  all(): AssetRecord[] {
    return [...this.records.values()].sort((a, b) => a.assetId.localeCompare(b.assetId));
  }

  markFetching(assetId: string): void {
    const record = this.records.get(assetId);
    if (record) record.fetchState = "fetching";
  }

  markCached(assetId: string, cachedPath: string): void {
    const record = this.records.get(assetId);
    if (!record) return;
    record.fetchState = "cached";
    record.cachedPath = cachedPath;
    record.error = null;
  }

  markDecoded(assetId: string, decodedBytes: number, width?: number, height?: number): void {
    const record = this.records.get(assetId);
    if (!record) return;
    record.decodeState = "decoded";
    record.decodedBytes = decodedBytes;
    if (width !== undefined) record.width = width;
    if (height !== undefined) record.height = height;
  }

  markUploaded(assetId: string, gpuBytes: number): void {
    const record = this.records.get(assetId);
    if (!record) return;
    record.gpuState = "uploaded";
    record.gpuBytes = gpuBytes;
  }

  markFailed(assetId: string, stage: "fetch" | "decode" | "gpu", error: string): void {
    const record = this.records.get(assetId);
    if (!record) return;
    record.error = error;
    if (stage === "fetch") record.fetchState = "failed";
    if (stage === "decode") record.decodeState = "failed";
    if (stage === "gpu") record.gpuState = "failed";
  }

  acquire(assetId: string): number {
    const record = this.records.get(assetId);
    if (!record) return 0;
    this.tick += 1;
    record.referenceCount += 1;
    record.lastUsedTick = this.tick;
    return record.referenceCount;
  }

  release(assetId: string): number {
    const record = this.records.get(assetId);
    if (!record) return 0;
    record.referenceCount = Math.max(0, record.referenceCount - 1);
    return record.referenceCount;
  }

  /**
   * Evict GPU residency for unreferenced assets until under budget.
   *
   * GPU only: the decoded bytes stay, so re-uploading is cheap. Referenced assets
   * are never evicted, because something on screen needs them.
   */
  evictGpu(): string[] {
    const evicted: string[] = [];
    const candidates = this.all()
      .filter((record) => record.gpuState === "uploaded" && record.referenceCount === 0)
      .sort((a, b) => a.lastUsedTick - b.lastUsedTick);

    for (const record of candidates) {
      if (this.gpuBytes() <= this.gpuBudgetBytes) break;
      record.gpuState = "evicted";
      record.gpuBytes = 0;
      evicted.push(record.assetId);
    }
    return evicted;
  }

  /** Drop decoded CPU copies for unreferenced assets under memory pressure. */
  evictDecoded(): string[] {
    const evicted: string[] = [];
    const candidates = this.all()
      .filter((record) => record.decodeState === "decoded" && record.referenceCount === 0)
      .sort((a, b) => a.lastUsedTick - b.lastUsedTick);

    for (const record of candidates) {
      if (this.decodedBytes() <= this.cpuBudgetBytes) break;
      record.decodeState = "undecoded";
      record.decodedBytes = 0;
      // The GPU copy is gone with it.
      if (record.gpuState === "uploaded") {
        record.gpuState = "evicted";
        record.gpuBytes = 0;
      }
      evicted.push(record.assetId);
    }
    return evicted;
  }

  decodedBytes(): number {
    return this.all().reduce((total, record) => total + record.decodedBytes, 0);
  }

  gpuBytes(): number {
    return this.all().reduce((total, record) => total + record.gpuBytes, 0);
  }

  diskBytes(): number {
    // Content-addressed, so bytes are counted once per unique hash.
    const counted = new Set<string>();
    let total = 0;
    for (const record of this.records.values()) {
      if (record.fetchState !== "cached" || counted.has(record.sha256)) continue;
      counted.add(record.sha256);
      total += record.sizeBytes;
    }
    return total;
  }

  stats(): AssetRegistryStats {
    let ready = 0;
    let preparing = 0;
    let failed = 0;
    let absent = 0;
    let referenced = 0;
    const hashes = new Set<string>();

    for (const record of this.records.values()) {
      hashes.add(record.sha256);
      if (record.referenceCount > 0) referenced += 1;
      switch (assetReadiness(record)) {
        case "ready":
          ready += 1;
          break;
        case "preparing":
          preparing += 1;
          break;
        case "failed":
          failed += 1;
          break;
        default:
          absent += 1;
      }
    }

    const decodedBytes = this.decodedBytes();
    const gpuBytes = this.gpuBytes();

    return {
      total: this.records.size,
      ready,
      preparing,
      failed,
      absent,
      referenced,
      decodedBytes,
      gpuBytes,
      diskBytes: this.diskBytes(),
      cpuBudgetBytes: this.cpuBudgetBytes,
      gpuBudgetBytes: this.gpuBudgetBytes,
      overCpuBudget: decodedBytes > this.cpuBudgetBytes,
      overGpuBudget: gpuBytes > this.gpuBudgetBytes,
      uniqueContentHashes: hashes.size
    };
  }

  /** Disk budget, reported so callers can prune the content cache. */
  get diskBudget(): number {
    return this.diskBudgetBytes;
  }
}

// ---------------------------------------------------------------------------
// Scene preparation
// ---------------------------------------------------------------------------

/** Requirement 14's preparation states, verbatim. */
export const SCENE_PREPARATION_STATES = [
  "not-loaded",
  "loading",
  "ready",
  "ready-with-warnings",
  "failed"
] as const;
export type ScenePreparationState = (typeof SCENE_PREPARATION_STATES)[number];

export interface ScenePreparationReport {
  sceneId: string;
  state: ScenePreparationState;
  totalAssets: number
  readyAssets: number;
  failedAssetIds: string[];
  missingAssetIds: string[];
  warnings: string[];
  /** Reasons a Take must be refused. Empty means it may proceed. */
  takeBlockers: string[];
}

/**
 * Assess whether a scene's assets are ready.
 *
 * The distinction between `ready` and `ready-with-warnings` matters: warnings are
 * things an operator may knowingly accept (an uncalibrated projector), while a
 * failed asset is a take blocker.
 */
export function assessScenePreparation(
  sceneId: string,
  assetIds: readonly string[],
  registry: AssetRegistry
): ScenePreparationReport {
  const failedAssetIds: string[] = [];
  const missingAssetIds: string[] = [];
  const warnings: string[] = [];
  let readyAssets = 0;
  let preparing = 0;

  for (const assetId of assetIds) {
    const record = registry.get(assetId);
    if (!record) {
      missingAssetIds.push(assetId);
      continue;
    }

    switch (assetReadiness(record)) {
      case "ready":
        readyAssets += 1;
        break;
      case "failed":
        failedAssetIds.push(assetId);
        break;
      case "preparing":
        preparing += 1;
        break;
      default:
        missingAssetIds.push(assetId);
    }
  }

  const takeBlockers: string[] = [];
  if (missingAssetIds.length > 0) {
    takeBlockers.push(
      `${missingAssetIds.length} asset(s) are not registered with the engine: ${missingAssetIds.slice(0, 5).join(", ")}`
    );
  }
  if (failedAssetIds.length > 0) {
    takeBlockers.push(
      `${failedAssetIds.length} asset(s) failed to prepare: ${failedAssetIds.slice(0, 5).join(", ")}`
    );
  }
  if (preparing > 0) {
    takeBlockers.push(`${preparing} asset(s) are still preparing`);
  }

  let state: ScenePreparationState;
  if (assetIds.length === 0) {
    state = "ready";
  } else if (failedAssetIds.length > 0 || missingAssetIds.length > 0) {
    state = "failed";
  } else if (preparing > 0) {
    state = "loading";
  } else if (warnings.length > 0) {
    state = "ready-with-warnings";
  } else {
    state = "ready";
  }

  return {
    sceneId,
    state,
    totalAssets: assetIds.length,
    readyAssets,
    failedAssetIds: failedAssetIds.sort(),
    missingAssetIds: missingAssetIds.sort(),
    warnings,
    takeBlockers
  };
}

/**
 * May this scene be taken online?
 *
 * Requirement 14: an unprepared scene must not go online unless the operator
 * manually overrides the warning. The override is explicit and is meant to be
 * recorded in the audit log by the caller.
 */
export function canTakeOnline(
  report: ScenePreparationReport,
  overrideUnprepared = false
): { allowed: boolean; reason?: string; overridden: boolean } {
  if (report.takeBlockers.length === 0) {
    return { allowed: true, overridden: false };
  }
  if (overrideUnprepared) {
    return {
      allowed: true,
      overridden: true,
      reason: `operator overrode ${report.takeBlockers.length} take blocker(s): ${report.takeBlockers.join("; ")}`
    };
  }
  return { allowed: false, overridden: false, reason: report.takeBlockers.join("; ") };
}
