import type {
  PlayoutTakeList,
  PublishedSceneMetadata,
  PublishedSceneVersion,
  SceneDocument
} from "@grapix/shared-types";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, unlink } from "node:fs/promises";
import path from "node:path";

export interface PublishSceneOptions {
  thumbnailDataUrl?: string;
  defaultTransition?: PublishedSceneMetadata["defaultTransition"];
  tags?: string[];
  category?: string;
  sourceEditorId?: string;
  sourceEndpoint?: string;
  requiredCapabilities?: string[];
  estimatedMemoryBytes?: number;
  /** Project colour space, supplied by the publisher; the scene does not carry it. */
  colorSpace?: string;
}

interface LibraryIndex {
  version: 1;
  scenes: PublishedSceneMetadata[];
  /**
   * Highest Take ID ever issued, so a removed one is never handed to another scene.
   *
   * Optional because indexes written before removal existed do not carry it; absent means
   * "derive from the scenes present", which is correct for a library nothing has been removed
   * from yet.
   */
  highestTakeId?: number;
}

/** What a successful removal took away, so the caller can report it precisely. */
export interface SceneRemoval {
  sceneId: string;
  /** The Take ID that is now unused. It is never reassigned to another scene. */
  takeId: number | null;
  versionsRemoved: number;
}

/**
 * A refusal to delete a broadcast asset, carrying a reason the HTTP layer can map to a status.
 *
 * Distinct from a generic error because "on air" and "still referenced" are normal operator
 * conditions, not faults, and they must not read as a server failure.
 */
export class SceneRemovalRefused extends Error {
  constructor(
    message: string,
    readonly reason: "NOT_FOUND" | "ON_AIR" | "REFERENCED"
  ) {
    super(message);
    this.name = "SceneRemovalRefused";
  }
}

export class PlayoutStore {
  private mutationQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly root: string) {}

  async ensure(): Promise<void> {
    await Promise.all([
      mkdir(this.sceneRoot(), { recursive: true }),
      mkdir(this.takeListRoot(), { recursive: true })
    ]);
  }

  /**
   * The next Scene Manager Take ID. Monotonic: a number is never reused.
   *
   * Take IDs start at 101, the way an XPression operator expects: three digits, and a gap
   * below so a show can reserve low numbers.
   *
   * This used to fill gaps left by deleted scenes, on the reasoning that operators memorise
   * these numbers so they should stay short. That reasoning was written when nothing could
   * delete a scene, and it points the other way once something can: an operator who memorised
   * "take 102" and finds a *different* graphic on it has been handed a trap, and they find out
   * on air. Climbing costs a fourth digit after several hundred removals; reuse costs the wrong
   * graphic once.
   *
   * The high-water mark is persisted rather than derived from the live scenes, because
   * deriving it is exactly what made a removed number reappear.
   */
  private nextTakeId(index: LibraryIndex): number {
    const used = index.scenes
      .map((entry) => entry.takeId)
      .filter((value): value is number => Number.isSafeInteger(value));
    const highest = Math.max(100, index.highestTakeId ?? 100, ...used);
    return highest + 1;
  }

  async publishScene(
    scene: SceneDocument,
    options: PublishSceneOptions = {}
  ): Promise<PublishedSceneMetadata> {
    assertScene(scene);
    return this.serializeMutation(async () => {
      await this.ensure();
      const index = await this.readLibraryIndex();
      const previousVersions = index.scenes.filter((entry) => entry.sceneId === scene.id);
      const version =
        previousVersions.reduce((maximum, entry) => Math.max(maximum, entry.version), 0) + 1;
      // Stable across republishes: an operator who rehearsed "take 104" must still get this
      // scene after a designer publishes v7 mid-show.
      const takeId =
        previousVersions.find((entry) => Number.isSafeInteger(entry.takeId))?.takeId
        ?? this.nextTakeId(index);
      const now = new Date().toISOString();
      const packageChecksum = createHash("sha256")
        .update(JSON.stringify(scene))
        .digest("hex");
      const metadata: PublishedSceneMetadata = {
        sceneId: scene.id,
        name: scene.name,
        version,
        sceneRevision: scene.updatedAt,
        thumbnailDataUrl: options.thumbnailDataUrl,
        durationFrames: scene.timeline.durationFrames,
        // Prefer the exact rational rate. `fps` is an approximation for legacy
        // documents - 29.97 is 30000/1001, and rounding it drifts a frame every
        // thousand, which over a long show is a visible sync error.
        frameRateNumerator: scene.timeline.frameRate?.numerator ?? scene.timeline.fps,
        frameRateDenominator: scene.timeline.frameRate?.denominator ?? 1,
        canvasWidth: scene.canvas.width,
        canvasHeight: scene.canvas.height,
        colorSpace: options.colorSpace,
        defaultTransition: options.defaultTransition ?? "cut",
        takeId,
        tags: [...new Set(options.tags ?? [])],
        category: options.category,
        sourceEditorId: options.sourceEditorId,
        sourceEndpoint: options.sourceEndpoint,
        packageChecksum,
        publishedAt: now,
        updatedAt: scene.updatedAt,
        validationStatus: "ready",
        assetReadiness: "ready",
        requiredCapabilities: [...new Set(options.requiredCapabilities ?? [])],
        estimatedMemoryBytes: options.estimatedMemoryBytes
      };
      const published: PublishedSceneVersion = { ...metadata, scene };

      await atomicWriteJson(this.sceneVersionPath(scene.id, version), published);
      index.scenes.push(metadata);
      // Raise the high-water mark so this number is never issued again, even after the scene
      // it belongs to is removed.
      index.highestTakeId = Math.max(index.highestTakeId ?? 100, takeId);
      index.scenes.sort(
        (left, right) =>
          left.sceneId.localeCompare(right.sceneId) || right.version - left.version
      );
      await atomicWriteJson(this.libraryIndexPath(), index);
      return metadata;
    });
  }

  async listScenes(): Promise<PublishedSceneMetadata[]> {
    await this.ensure();
    return (await this.readLibraryIndex()).scenes;
  }

  async readScene(sceneId: string, version?: number): Promise<PublishedSceneVersion | null> {
    assertStorageId(sceneId, "sceneId");
    const index = await this.readLibraryIndex();
    const candidates = index.scenes.filter((entry) => entry.sceneId === sceneId);
    const selectedVersion =
      version ??
      candidates.reduce((maximum, entry) => Math.max(maximum, entry.version), 0);
    if (selectedVersion <= 0) {
      return null;
    }

    try {
      return JSON.parse(
        await readFile(this.sceneVersionPath(sceneId, selectedVersion), "utf8")
      ) as PublishedSceneVersion;
    } catch (error) {
      if (isMissingFile(error)) {
        return null;
      }
      throw error;
    }
  }

  /** Find a published scene by its Scene Manager Take ID. */
  async readSceneByTakeId(takeId: number): Promise<PublishedSceneVersion | null> {
    const index = await this.readLibraryIndex();
    const matches = index.scenes.filter((entry) => entry.takeId === takeId);
    if (matches.length === 0) {
      return null;
    }
    const latest = matches.reduce((best, entry) => (entry.version > best.version ? entry : best));
    return this.readScene(latest.sceneId, latest.version);
  }

  /**
   * Remove every published version of a scene.
   *
   * Deleting a broadcast asset is not a tidy-up, it is a way to make a Take ID stop working
   * mid-show, so this refuses rather than asks. The caller supplies what is currently on air
   * because the store does not track channels; the runtime does.
   *
   * Take IDs of other scenes are never touched. They are assigned on first publish and
   * operators memorise them, so renumbering to close a gap would be worse than the gap.
   */
  async removeScene(
    sceneId: string,
    guards: { onAirSceneIds?: readonly string[]; force?: boolean } = {}
  ): Promise<SceneRemoval> {
    assertStorageId(sceneId, "sceneId");

    return this.serializeMutation(async () => {
      const index = await this.readLibraryIndex();
      const versions = index.scenes.filter((entry) => entry.sceneId === sceneId);
      if (versions.length === 0) {
        throw new SceneRemovalRefused(`no published scene ${sceneId}`, "NOT_FOUND");
      }

      if (guards.onAirSceneIds?.includes(sceneId)) {
        throw new SceneRemovalRefused(
          `scene ${sceneId} is on air; take it off Program and Preview first`,
          "ON_AIR"
        );
      }

      // A take list entry is an operator's recall path. Removing the scene under it would turn
      // a Take In into a missing-asset error at exactly the wrong moment.
      const referencing: string[] = [];
      for (const takeList of await this.listTakeLists()) {
        if (takeList.archived) continue;
        if (takeList.entries.some((entry) => entry.sceneId === sceneId)) {
          referencing.push(takeList.takeListId);
        }
      }
      if (referencing.length > 0) {
        if (guards.force) {
          for (const takeListId of referencing) {
            const takeList = await this.readTakeList(takeListId);
            if (takeList) {
              const cleanEntries = takeList.entries.filter((entry) => entry.sceneId !== sceneId);
              const next: PlayoutTakeList = {
                ...structuredClone(takeList),
                entries: cleanEntries,
                cursorEntryId:
                  takeList.cursorEntryId && cleanEntries.some((e) => e.entryId === takeList.cursorEntryId)
                    ? takeList.cursorEntryId
                    : cleanEntries[0]?.entryId ?? null,
                updatedAt: new Date().toISOString()
              };
              await atomicWriteJson(this.takeListPath(takeListId), next);
            }
          }
        } else {
          throw new SceneRemovalRefused(
            `scene ${sceneId} is referenced by take list(s) ${referencing.join(", ")}; remove those entries first or pass force`,
            "REFERENCED"
          );
        }
      }

      const takeId = versions[0]?.takeId ?? null;
      // The whole per-scene directory, not each version file: leaving an empty directory behind
      // makes the store look like it still holds the scene to anything reading the filesystem.
      await rm(path.dirname(this.sceneVersionPath(sceneId, 1)), {
        recursive: true,
        force: true
      });
      index.scenes = index.scenes.filter((entry) => entry.sceneId !== sceneId);
      await atomicWriteJson(this.libraryIndexPath(), index);

      return { sceneId, takeId, versionsRemoved: versions.length };
    });
  }

  /**
   * Fetch scenes from the Editor project service (port 4100) and publish/update them into Playout.
   */
  async syncFromEditor(
    editorUrl = process.env.GRAPIX_EDITOR_API_URL || "http://127.0.0.1:4100"
  ): Promise<{
    syncedCount: number;
    updatedCount: number;
    totalScenes: number;
    scenes: PublishedSceneMetadata[];
  }> {
    await this.ensure();
    const endpoint = editorUrl.replace(/\/+$/, "");
    let listResponse: Response;
    try {
      listResponse = await fetch(`${endpoint}/api/scenes`, { signal: AbortSignal.timeout(5000) });
    } catch (cause) {
      throw new Error(`Editor project service is not reachable at ${endpoint}: ${errorMessage(cause)}`);
    }
    if (!listResponse.ok) {
      throw new Error(`Editor project service returned ${listResponse.status} from ${endpoint}/api/scenes`);
    }

    const payload = (await listResponse.json()) as {
      scenes?: Array<{ id: string; name: string; updatedAt?: string }>;
    };
    const editorScenes = payload.scenes ?? [];
    const published = await this.listScenes();
    const publishedMap = new Map<string, PublishedSceneMetadata>();
    for (const p of published) {
      const existing = publishedMap.get(p.sceneId);
      if (!existing || p.version > existing.version) {
        publishedMap.set(p.sceneId, p);
      }
    }

    let syncedCount = 0;
    let updatedCount = 0;

    for (const editorSceneSummary of editorScenes) {
      const existing = publishedMap.get(editorSceneSummary.id);
      const isNew = !existing;
      const isUpdated =
        existing &&
        editorSceneSummary.updatedAt &&
        new Date(editorSceneSummary.updatedAt).getTime() > new Date(existing.updatedAt).getTime();

      if (isNew || isUpdated) {
        try {
          const docResponse = await fetch(
            `${endpoint}/api/scenes/${encodeURIComponent(editorSceneSummary.id)}`,
            { signal: AbortSignal.timeout(10000) }
          );
          if (!docResponse.ok) continue;
          const docPayload = (await docResponse.json()) as { scene?: SceneDocument };
          if (docPayload.scene) {
            await this.publishScene(docPayload.scene, {
              sourceEditorId: editorSceneSummary.id,
              sourceEndpoint: endpoint
            });
            if (isNew) syncedCount++;
            else updatedCount++;
          }
        } catch {
          // Individual scene fetch failure shouldn't abort the rest of the sync
        }
      }
    }

    const updatedLibrary = await this.listScenes();
    return { syncedCount, updatedCount, totalScenes: updatedLibrary.length, scenes: updatedLibrary };
  }

  async listTakeLists(): Promise<PlayoutTakeList[]> {
    await this.ensure();
    const files = await readdir(this.takeListRoot());
    const lists = await Promise.all(
      files
        .filter((file) => file.endsWith(".json"))
        .map(async (file) =>
          JSON.parse(
            await readFile(path.join(this.takeListRoot(), file), "utf8")
          ) as PlayoutTakeList
        )
    );
    return lists.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async readTakeList(takeListId: string): Promise<PlayoutTakeList | null> {
    assertStorageId(takeListId, "takeListId");
    try {
      return JSON.parse(
        await readFile(this.takeListPath(takeListId), "utf8")
      ) as PlayoutTakeList;
    } catch (error) {
      if (isMissingFile(error)) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Autosave a take list.
   *
   * No revision counter: a take list is operator working state, not a published artifact.
   * The immutable, versioned things are the published scenes it points at.
   */
  async saveTakeList(takeList: PlayoutTakeList): Promise<PlayoutTakeList> {
    assertTakeList(takeList);
    return this.serializeMutation(async () => {
      await this.ensure();
      const next: PlayoutTakeList = {
        ...structuredClone(takeList),
        updatedAt: new Date().toISOString()
      };
      await atomicWriteJson(this.takeListPath(next.takeListId), next);
      return next;
    });
  }

  async createTakeList(name = "Untitled Take List"): Promise<PlayoutTakeList> {
    const now = new Date().toISOString();
    return this.saveTakeList({
      takeListId: `takelist_${randomUUID()}`,
      name: name.trim() || "Untitled Take List",
      version: 1,
      cursorEntryId: null,
      entries: [],
      archived: false,
      createdAt: now,
      updatedAt: now
    });
  }

  /**
   * Read the library index, assigning a Take ID to anything published before the field
   * existed.
   *
   * `PublishedSceneMetadata.takeId` is not optional, so a version missing one violates the
   * contract and surfaces in the Scene Manager as "take undefined". Backfilled per scene id —
   * every version of a scene shares its Take ID — and in place, so the repair happens once
   * rather than on every read.
   */
  private async readLibraryIndex(): Promise<LibraryIndex> {
    let index: LibraryIndex;
    try {
      index = JSON.parse(await readFile(this.libraryIndexPath(), "utf8")) as LibraryIndex;
    } catch (error) {
      if (isMissingFile(error)) {
        return { version: 1, scenes: [] };
      }
      throw error;
    }

    const missing = index.scenes.filter((entry) => !Number.isSafeInteger(entry.takeId));
    if (missing.length === 0) {
      return index;
    }

    const assigned = new Map<string, number>();
    for (const entry of index.scenes) {
      if (Number.isSafeInteger(entry.takeId)) {
        assigned.set(entry.sceneId, entry.takeId);
      }
    }
    for (const entry of missing) {
      const takeId = assigned.get(entry.sceneId) ?? this.nextTakeId(index);
      assigned.set(entry.sceneId, takeId);
      entry.takeId = takeId;
    }

    await atomicWriteJson(this.libraryIndexPath(), index);
    return index;
  }

  private serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation, operation);
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private sceneRoot(): string {
    return path.join(this.root, "library", "scenes");
  }

  private takeListRoot(): string {
    return path.join(this.root, "take-lists");
  }

  private libraryIndexPath(): string {
    return path.join(this.root, "library", "index.json");
  }

  private sceneVersionPath(sceneId: string, version: number): string {
    assertStorageId(sceneId, "sceneId");
    if (!Number.isSafeInteger(version) || version <= 0) {
      throw new Error("scene version must be a positive integer");
    }
    return path.join(this.sceneRoot(), sceneId, `v${version}.json`);
  }

  private takeListPath(takeListId: string): string {
    assertStorageId(takeListId, "takeListId");
    return path.join(this.takeListRoot(), `${takeListId}.json`);
  }
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertScene(scene: SceneDocument): void {
  assertStorageId(scene.id, "scene.id");
  if (scene.version !== 1 || !scene.name.trim() || !scene.updatedAt) {
    throw new Error("invalid SceneDocument for Playout publication");
  }
  if (
    !Number.isFinite(scene.timeline.fps) ||
    scene.timeline.fps <= 0 ||
    !Number.isSafeInteger(scene.timeline.durationFrames) ||
    scene.timeline.durationFrames < 0
  ) {
    throw new Error("scene timeline is invalid");
  }
}

function assertTakeList(takeList: PlayoutTakeList): void {
  assertStorageId(takeList.takeListId, "takeListId");
  if (takeList.version !== 1 || !takeList.name.trim()) {
    throw new Error("invalid PlayoutTakeList");
  }

  const entryIds = new Set<string>();
  for (const entry of takeList.entries) {
    assertStorageId(entry.entryId, "entryId");
    assertStorageId(entry.sceneId, "entry.sceneId");
    if (entryIds.has(entry.entryId)) {
      throw new Error("take list contains duplicate entry IDs");
    }
    if (!Number.isSafeInteger(entry.sceneVersion) || entry.sceneVersion <= 0) {
      throw new Error(`take list entry ${entry.entryId} has an invalid scene version`);
    }
    entryIds.add(entry.entryId);
  }

  // A cursor pointing at an entry that does not exist would leave Take In with nothing to
  // operate on while the UI showed a highlighted row.
  if (takeList.cursorEntryId !== null && !entryIds.has(takeList.cursorEntryId)) {
    throw new Error("take list cursor references a missing entry");
  }
}

function assertStorageId(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new Error(`${label} contains unsafe characters`);
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

async function atomicWriteJson(targetPath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(targetPath), { recursive: true });
  const temporaryPath = path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, "wx");
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, targetPath);
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
  }
}
