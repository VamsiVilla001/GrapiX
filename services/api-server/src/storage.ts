import type { SceneDocument } from "@grapix/shared-types";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const dataRoot = path.join(workspaceRoot, "data");
const sceneRoot = path.join(dataRoot, "scenes");
const packageRoot = path.join(dataRoot, "packages");

export interface StoredSceneSummary {
  id: string;
  name: string;
  updatedAt: string;
  objectCount: number;
  assetCount: number;
  materialCount: number;
}

export interface StoredPackageSummary {
  sceneId: string;
  fileName: string;
  path: string;
  sizeBytes: number;
  createdAt: string;
}

export async function ensureStorage(): Promise<void> {
  await mkdir(sceneRoot, { recursive: true });
  await mkdir(packageRoot, { recursive: true });
}

export async function saveScene(scene: SceneDocument): Promise<StoredSceneSummary> {
  await ensureStorage();
  await writeFile(scenePath(scene.id), `${JSON.stringify(scene, null, 2)}\n`, "utf8");
  return summarizeScene(scene);
}

export async function updateScene(
  sceneId: string,
  updater: (scene: SceneDocument) => SceneDocument
): Promise<SceneDocument | null> {
  const scene = await readScene(sceneId);

  if (!scene) {
    return null;
  }

  const updated = updater(scene);
  await saveScene(updated);
  return updated;
}

export async function listScenes(): Promise<StoredSceneSummary[]> {
  await ensureStorage();
  const files = await readdir(sceneRoot);
  const summaries = await Promise.all(
    files
      .filter((file) => file.endsWith(".json"))
      .map(async (file) => summarizeScene(JSON.parse(await readFile(path.join(sceneRoot, file), "utf8")) as SceneDocument))
  );

  return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function readScene(sceneId: string): Promise<SceneDocument | null> {
  try {
    return JSON.parse(await readFile(scenePath(sceneId), "utf8")) as SceneDocument;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

export async function savePackage(
  sceneId: string,
  fileName: string,
  buffer: Buffer
): Promise<StoredPackageSummary> {
  await ensureStorage();
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]+/g, "-");
  const packagePath = path.join(packageRoot, `${sceneId}-${safeName}`);
  await writeFile(packagePath, buffer);
  const stats = await stat(packagePath);

  return {
    sceneId,
    fileName: path.basename(packagePath),
    path: packagePath,
    sizeBytes: stats.size,
    createdAt: new Date(stats.mtimeMs).toISOString()
  };
}

function scenePath(sceneId: string): string {
  return path.join(sceneRoot, `${sceneId.replace(/[^a-zA-Z0-9_-]+/g, "-")}.json`);
}

function summarizeScene(scene: SceneDocument): StoredSceneSummary {
  return {
    id: scene.id,
    name: scene.name,
    updatedAt: scene.updatedAt,
    objectCount: scene.objects.length,
    assetCount: scene.assets.length,
    materialCount: scene.materials.length
  };
}
