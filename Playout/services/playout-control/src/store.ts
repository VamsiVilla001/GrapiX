import type {
  PlayoutRundownDocument,
  PublishedSceneMetadata,
  PublishedSceneVersion,
  SceneDocument
} from "@grapix/shared-types";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
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
}

export class PlayoutStore {
  private mutationQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly root: string) {}

  async ensure(): Promise<void> {
    await Promise.all([
      mkdir(this.sceneRoot(), { recursive: true }),
      mkdir(this.rundownRoot(), { recursive: true })
    ]);
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

  async listRundowns(): Promise<PlayoutRundownDocument[]> {
    await this.ensure();
    const files = await readdir(this.rundownRoot());
    const rundowns = await Promise.all(
      files
        .filter((file) => file.endsWith(".json"))
        .map(async (file) =>
          JSON.parse(
            await readFile(path.join(this.rundownRoot(), file), "utf8")
          ) as PlayoutRundownDocument
        )
    );
    return rundowns.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async readRundown(rundownId: string): Promise<PlayoutRundownDocument | null> {
    assertStorageId(rundownId, "rundownId");
    try {
      return JSON.parse(
        await readFile(this.rundownPath(rundownId), "utf8")
      ) as PlayoutRundownDocument;
    } catch (error) {
      if (isMissingFile(error)) {
        return null;
      }
      throw error;
    }
  }

  async saveRundown(
    rundown: PlayoutRundownDocument
  ): Promise<PlayoutRundownDocument> {
    assertRundown(rundown);
    return this.serializeMutation(async () => {
      await this.ensure();
      const current = await this.readRundown(rundown.rundownId);
      const next: PlayoutRundownDocument = {
        ...structuredClone(rundown),
        revision: (current?.revision ?? 0) + 1,
        updatedAt: new Date().toISOString()
      };
      await atomicWriteJson(this.rundownPath(next.rundownId), next);
      return next;
    });
  }

  async createRundown(name = "Untitled Rundown"): Promise<PlayoutRundownDocument> {
    const now = new Date().toISOString();
    return this.saveRundown({
      rundownId: `rundown_${randomUUID()}`,
      name: name.trim() || "Untitled Rundown",
      version: 1,
      revision: 0,
      items: [],
      segments: [
        {
          segmentId: `segment_${randomUUID()}`,
          name: "Main",
          color: "#4077b8",
          notes: "",
          collapsed: false,
          locked: false
        }
      ],
      archived: false,
      createdAt: now,
      updatedAt: now
    });
  }

  private async readLibraryIndex(): Promise<LibraryIndex> {
    try {
      return JSON.parse(
        await readFile(this.libraryIndexPath(), "utf8")
      ) as LibraryIndex;
    } catch (error) {
      if (isMissingFile(error)) {
        return { version: 1, scenes: [] };
      }
      throw error;
    }
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

  private rundownRoot(): string {
    return path.join(this.root, "rundowns");
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

  private rundownPath(rundownId: string): string {
    assertStorageId(rundownId, "rundownId");
    return path.join(this.rundownRoot(), `${rundownId}.json`);
  }
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

function assertRundown(rundown: PlayoutRundownDocument): void {
  assertStorageId(rundown.rundownId, "rundownId");
  if (rundown.version !== 1 || !rundown.name.trim()) {
    throw new Error("invalid PlayoutRundownDocument");
  }
  const segmentIds = new Set(rundown.segments.map((segment) => segment.segmentId));
  if (segmentIds.size !== rundown.segments.length) {
    throw new Error("rundown contains duplicate segment IDs");
  }
  const itemIds = new Set<string>();
  for (const item of rundown.items) {
    assertStorageId(item.itemId, "itemId");
    if (itemIds.has(item.itemId)) {
      throw new Error("rundown contains duplicate item IDs");
    }
    if (!segmentIds.has(item.segmentId)) {
      throw new Error(`rundown item ${item.itemId} references a missing segment`);
    }
    itemIds.add(item.itemId);
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
