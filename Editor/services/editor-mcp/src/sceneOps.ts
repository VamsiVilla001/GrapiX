/**
 * Scene reading, safe whole-document writes, and object construction.
 *
 * Two things here are not conveniences:
 *
 * **Optimistic concurrency.** `POST /api/scenes` replaces the whole document
 * and carries no expected-revision field, so a read-modify-write races any
 * other writer — the Editor UI on the same scene, or a second agent. Every
 * mutating tool that rewrites a document therefore reads the revision first and
 * refuses when it moved, rather than silently discarding the other edit.
 *
 * **Colour styles.** An object carries its colour twice: the `fill`/`stroke`
 * strings and the richer `fillStyle`/`strokeStyle` values — and the renderers
 * read the rich one first. A factory that sets only the string paints whatever
 * the base object's style was, which is exactly why the pen tool drew nothing
 * for as long as it existed (`memory.md` rule 88). `withColorStyles` below is
 * this package's equivalent of the editor's own helper, built from the shared
 * `solidColorValue` contract so the two cannot drift.
 */

import {
  createObjectId,
  createSceneId,
  solidColorValue,
  type SceneDocument,
  type SceneObject,
  type SceneObjectType
} from "@grapix/shared-types";
import { ProjectApiError, type ProjectApiClient } from "./projectApiClient.js";

export interface SceneSummary {
  id: string;
  name: string;
  updatedAt: string;
  objectCount: number;
  assetCount: number;
  materialCount: number;
  revision: number;
}

export async function listScenes(client: ProjectApiClient): Promise<SceneSummary[]> {
  const response = await client.request<{ scenes: SceneSummary[] }>("/api/scenes");
  return response.scenes ?? [];
}

export async function readScene(
  client: ProjectApiClient,
  sceneId: string
): Promise<SceneDocument> {
  const response = await client.request<{ ok: boolean; scene: SceneDocument }>(
    `/api/scenes/${encodeURIComponent(sceneId)}`
  );
  return response.scene;
}

export async function saveScene(
  client: ProjectApiClient,
  scene: SceneDocument
): Promise<SceneSummary> {
  const response = await client.request<{ ok: boolean; scene: SceneSummary }>("/api/scenes", {
    method: "POST",
    json: scene
  });
  return response.scene;
}

export class RevisionConflictError extends Error {
  constructor(readonly expected: number, readonly actual: number) {
    super(
      `The scene moved from revision ${expected} to ${actual} between reading and writing. ` +
        "Another writer (the Editor UI, or another agent) changed it. Re-read the scene, " +
        "reapply the change, and pass the new revision as expected_revision."
    );
    this.name = "RevisionConflictError";
  }
}

/**
 * Read-modify-write with an expected-revision guard.
 *
 * `expectedRevision` is optional because a first-time caller has no revision to
 * quote. Independently of it, the document is re-read immediately before the
 * save and the write is abandoned if the revision moved. That narrows the race
 * to the gap between the check and the POST; it does not close it, because the
 * project API's whole-document route takes no expected revision. It is the
 * strongest guarantee available from outside that service, and it is far better
 * than the silent last-writer-wins a plain read-modify-write would give.
 */
export async function mutateScene(
  client: ProjectApiClient,
  sceneId: string,
  expectedRevision: number | undefined,
  mutate: (scene: SceneDocument) => SceneDocument
): Promise<{ scene: SceneDocument; summary: SceneSummary }> {
  const current = await readScene(client, sceneId);
  const currentRevision = current.revision ?? 0;

  if (expectedRevision !== undefined && expectedRevision !== currentRevision) {
    throw new RevisionConflictError(expectedRevision, currentRevision);
  }

  const next: SceneDocument = {
    ...mutate(structuredClone(current)),
    id: current.id,
    version: 1,
    updatedAt: new Date().toISOString()
  };

  const verify = await readScene(client, sceneId);
  if ((verify.revision ?? 0) !== currentRevision) {
    throw new RevisionConflictError(currentRevision, verify.revision ?? 0);
  }

  const summary = await saveScene(client, next);
  return { scene: { ...next, revision: summary.revision }, summary };
}

export function requireObject(scene: SceneDocument, objectId: string): SceneObject {
  const object = scene.objects.find((candidate) => candidate.id === objectId);
  if (object) return object;

  throw new ProjectApiError(
    `Scene "${scene.id}" has no object "${objectId}". Objects present: ` +
      (scene.objects.length
        ? scene.objects.map((candidate) => `${candidate.id} (${candidate.type})`).join(", ")
        : "none"),
    404,
    "OBJECT_NOT_FOUND",
    undefined
  );
}

/**
 * Writes a colour to both representations. Never set `fill` or `stroke` alone —
 * the renderers read `fillStyle`/`strokeStyle` first and would paint the old
 * value.
 */
export function withColorStyles<T extends { fill?: string; stroke?: string }>(
  object: T,
  colors: { fill?: string; stroke?: string }
): T & { fillStyle?: ReturnType<typeof solidColorValue>; strokeStyle?: ReturnType<typeof solidColorValue> } {
  const next = { ...object } as T & {
    fillStyle?: ReturnType<typeof solidColorValue>;
    strokeStyle?: ReturnType<typeof solidColorValue>;
  };

  if (colors.fill !== undefined) {
    next.fill = colors.fill;
    next.fillStyle = solidColorValue(colors.fill);
  }
  if (colors.stroke !== undefined) {
    next.stroke = colors.stroke;
    next.strokeStyle = solidColorValue(colors.stroke);
  }

  return next;
}

export interface NewObjectOptions {
  type: SceneObjectType;
  name?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  zDepth?: number;
  rotation?: number;
  opacity?: number;
  visible?: boolean;
  locked?: boolean;
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  layerId?: string;
  /** Type-specific fields: `text`, `fontSize`, `src`, `radius`, `primitive`, ... */
  properties?: Record<string, unknown>;
}

/**
 * Per-type required fields, taken from the object interfaces in
 * `@grapix/shared-types`. Every field a renderer reads without an optional
 * marker is present here, so a created object never depends on a consumer
 * tolerating a missing one.
 */
function typeDefaults(type: SceneObjectType): Record<string, unknown> {
  switch (type) {
    case "text":
      return {
        text: "Text",
        fontSize: 48,
        fontFamily: "Inter",
        fontWeight: "400",
        align: "left"
      };
    case "rect":
      return { radius: 0 };
    case "ellipse":
      return {};
    case "image":
      return { src: "", objectFit: "contain" };
    case "line":
      return { points: [] };
    case "shape":
      return {
        path: { closed: true, vertices: [], inTangents: [], outTangents: [] },
        fillEnabled: true,
        strokeEnabled: false,
        fillRule: "nonzero"
      };
    case "paint":
      return { strokes: [], paintBlendMode: "normal" };
    case "mesh":
      return { meshKind: "cube", depth: 100 };
    case "light":
      return { lightKind: "directional", intensity: 1, color: "#ffffff" };
    case "camera":
      return { cameraKind: "perspective", fov: 50, zoom: 1 };
    case "layer":
      return { layerKind: "object", childIds: [] };
    case "marker":
      return { markerKind: "event", eventName: "event" };
    case "group":
      return { childIds: [] };
    default:
      return {};
  }
}

export function createSceneObject(
  scene: SceneDocument,
  options: NewObjectOptions
): SceneObject {
  const highestZ = scene.objects.reduce(
    (highest, object) => Math.max(highest, object.zIndex ?? 0),
    0
  );

  const base = {
    id: createObjectId(options.type),
    name: options.name ?? `${options.type[0].toUpperCase()}${options.type.slice(1)}`,
    type: options.type,
    x: options.x ?? 0,
    y: options.y ?? 0,
    zDepth: options.zDepth ?? 0,
    zIndex: highestZ + 1,
    layerId: options.layerId ?? "main",
    width: options.width ?? 200,
    height: options.height ?? 100,
    rotation: options.rotation ?? 0,
    opacity: options.opacity ?? 1,
    visible: options.visible ?? true,
    locked: options.locked ?? false,
    fill: "#ffffff",
    stroke: "#000000",
    strokeWidth: options.strokeWidth ?? 0,
    bindings: {},
    materialSlots: {},
    ...typeDefaults(options.type),
    ...(options.properties ?? {})
  };

  return withColorStyles(base, {
    fill: options.fill ?? String(base.fill),
    stroke: options.stroke ?? String(base.stroke)
  }) as unknown as SceneObject;
}

export interface NewSceneOptions {
  name: string;
  width?: number;
  height?: number;
  background?: string;
  fps?: number;
  durationFrames?: number;
}

export function createSceneDocument(options: NewSceneOptions): SceneDocument {
  const timestamp = new Date().toISOString();
  const fps = options.fps ?? 50;

  return {
    id: createSceneId(),
    name: options.name,
    version: 1,
    canvas: {
      width: options.width ?? 1920,
      height: options.height ?? 1080,
      background: options.background ?? "#00000000"
    },
    dataContext: {},
    assets: [],
    materials: [],
    objects: [],
    timeline: {
      fps,
      durationFrames: options.durationFrames ?? fps * 2,
      keyframes: [],
      frameRate: { numerator: fps, denominator: 1 }
    },
    createdAt: timestamp,
    updatedAt: timestamp
  };
}
