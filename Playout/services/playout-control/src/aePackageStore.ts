import {
  containerFromAePackage,
  readAePackage,
  type AePackageManifest,
  type AeRuntimeContainer
} from "@grapix/ae-runtime-contract";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { AeContainerStore } from "./aeContainerStore.js";
import type { AeRecordedCueMap } from "./aeCueService.js";

/** The newest verified package Playout may expose for one graphic. */
export interface AePackageRecord {
  graphicId: string;
  name: string;
  latestVersion: number;
  versionRoot: string;
  ingestedAt: string;
  mainComposition: AePackageManifest["mainComposition"];
  thumbnail?: string;
}

/**
 * Keeps the verified package Playout selected for each graphic alongside its runtime container.
 *
 * The package version directory remains immutable at its publisher; this index only records which
 * verified version Playout accepted, so a late delivery cannot roll an operator back to old bytes.
 */
export class AePackageStore {
  private readonly root: string;
  private readonly ingests = Promise.resolve();
  private ingestQueue = this.ingests;

  constructor(dataRoot: string, private readonly containers = new AeContainerStore(dataRoot)) {
    this.root = path.join(dataRoot, "ae-packages");
  }

  async ingest(versionRoot: string): Promise<{ container: AeRuntimeContainer; manifest: AePackageManifest }> {
    const pkg = await readAePackage(versionRoot);
    return this.withIngestLock(async () => {
      const index = await this.readIndex();
      const existing = index[pkg.manifest.id];
      if (existing && pkg.manifest.version <= existing.latestVersion) {
        throw new Error(
          `package ${pkg.manifest.id} version ${pkg.manifest.version} was refused: version ${existing.latestVersion} is already ingested`
        );
      }

      const ingestedAt = new Date().toISOString();
      const container = containerFromAePackage(pkg, new Date(ingestedAt));
      const record: AePackageRecord = {
        graphicId: pkg.manifest.id,
        name: pkg.manifest.name,
        latestVersion: pkg.manifest.version,
        versionRoot: pkg.root,
        ingestedAt,
        mainComposition: pkg.manifest.mainComposition,
        ...(pkg.manifest.thumbnail === undefined ? {} : { thumbnail: pkg.manifest.thumbnail })
      };
      await this.persist(container, record, index);
      // The declared cue map becomes a playable record the moment the package lands: an operator
      // can drive IN/HOLD/OUT without the Editor being involved again. Absent markers mean no
      // record, never an empty one.
      if (pkg.animations.cueMap && pkg.animations.cueMapDigest) {
        await this.writeCueMap({
          containerId: container.id,
          compositionItemId: pkg.animations.cueMap.compositionItemId,
          projectDigest: pkg.manifest.projectDigest,
          cueMapDigest: pkg.animations.cueMapDigest,
          markers: pkg.animations.cueMap.markers,
          rate: pkg.animations.cueMap.rate,
          clock: pkg.animations.cueMap.clock
        });
      }
      return { container, manifest: pkg.manifest };
    });
  }

  /** The cue map recorded for a container, when its package declared one. */
  async readCueMap(containerId: string): Promise<AeRecordedCueMap | null> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(containerId)) return null;
    try {
      return JSON.parse(await readFile(this.cueMapPath(containerId), "utf8")) as AeRecordedCueMap;
    } catch {
      return null;
    }
  }

  private cueMapPath(containerId: string): string {
    return path.join(this.root, "cue-maps", `${containerId}.json`);
  }

  private async writeCueMap(record: AeRecordedCueMap): Promise<void> {
    const target = this.cueMapPath(record.containerId);
    await mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`);
    await rename(temporary, target);
  }

  async list(): Promise<AePackageRecord[]> {
    return Object.values(await this.readIndex()).sort((left, right) => right.ingestedAt.localeCompare(left.ingestedAt));
  }

  async read(graphicId: string): Promise<AePackageRecord | null> {
    return (await this.readIndex())[graphicId] ?? null;
  }

  private async withIngestLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.ingestQueue;
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.ingestQueue = current;
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async persist(
    container: AeRuntimeContainer,
    record: AePackageRecord,
    index: Record<string, AePackageRecord>
  ): Promise<void> {
    await this.containers.write(container);
    index[record.graphicId] = record;
    await this.writeIndex(index);
  }

  private async readIndex(): Promise<Record<string, AePackageRecord>> {
    try {
      const parsed: unknown = JSON.parse(await readFile(path.join(this.root, "index.json"), "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("AE package index is not a graphicId-to-record mapping");
      }
      return parsed as Record<string, AePackageRecord>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  }

  private async writeIndex(index: Record<string, AePackageRecord>): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const target = path.join(this.root, "index.json");
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(index, null, 2)}\n`);
    await rename(temporary, target);
  }
}
