/**
 * Incremental scene updates.
 *
 * Resending a whole SceneDocument for every property change is the thing this
 * module exists to prevent. A scene with a hundred objects and embedded asset
 * metadata is large; a "text changed" patch is a few dozen bytes.
 *
 * Every patch is revision-gated. `baseRevision` says what the sender believed
 * the engine held, and `revision` is the result. If the engine's current
 * revision does not match `baseRevision`, the patch is refused and the client
 * must full-sync — applying it anyway would silently diverge Preview from
 * Program, which is the worst possible failure for an on-air renderer.
 */

import type {
  AssetLibraryItem,
  Material,
  SceneDocument,
  SceneObject,
  SceneTimeline
} from "@grapix/shared-types";

export const SCENE_PATCH_OPERATIONS = [
  "object.created",
  "object.deleted",
  "object.transform",
  "object.text",
  "object.material",
  "object.animation",
  "object.visibility",
  "object.property",
  "layer.reorder",
  "asset.changed",
  "material.changed",
  "timeline.changed",
  "dataContext.changed",
  "surface.changed",
  "outputMapping.changed",
  "scene.published",
  "scene.recalled"
] as const;

export type ScenePatchOperationType = (typeof SCENE_PATCH_OPERATIONS)[number];

/** Transform fields a `object.transform` operation may carry. */
export interface TransformDelta {
  x?: number;
  y?: number;
  zDepth?: number;
  rotation?: number;
  rotationX?: number;
  rotationY?: number;
  rotationZ?: number;
  scaleX?: number;
  scaleY?: number;
  scaleZ?: number;
  opacity?: number;
}

export type ScenePatchOperation =
  | { type: "object.created"; object: SceneObject; /** Insert index; appended when absent. */ index?: number }
  | { type: "object.deleted"; objectId: string }
  | { type: "object.transform"; objectId: string; transform: TransformDelta }
  | { type: "object.text"; objectId: string; text: string }
  | { type: "object.material"; objectId: string; slot: string; materialId: string | null }
  /** Replaces the object's `animation` channel map (`PropertyChannelMap`). */
  | { type: "object.animation"; objectId: string; channels: Record<string, unknown> }
  | { type: "object.visibility"; objectId: string; visible: boolean }
  /** Generic single-property change. `path` is dot/bracket relative to the object. */
  | { type: "object.property"; objectId: string; path: string; value: unknown }
  | { type: "layer.reorder"; objectIds: string[] }
  | { type: "asset.changed"; asset: AssetLibraryItem }
  | { type: "material.changed"; material: Material }
  | { type: "timeline.changed"; timeline: SceneTimeline }
  | { type: "dataContext.changed"; path: string; value: unknown }
  /** Stage-side changes; the engine reloads its stage rather than the scene. */
  | { type: "surface.changed"; surfaceId: string; value: unknown }
  | { type: "outputMapping.changed"; mappingId: string; value: unknown }
  | { type: "scene.published"; revision: number }
  | { type: "scene.recalled"; revision: number };

export interface ScenePatch {
  sceneId: string;
  /** Revision the sender believed the receiver held. */
  baseRevision: number;
  /** Revision after applying this patch. Must be greater than `baseRevision`. */
  revision: number;
  timestampMs: number;
  operations: ScenePatchOperation[];
  /** Who produced it, for conflict attribution across multiple editors. */
  origin?: string;
}

export function createScenePatch(
  sceneId: string,
  baseRevision: number,
  operations: ScenePatchOperation[],
  options: { timestampMs?: number; origin?: string; revision?: number } = {}
): ScenePatch {
  const patch: ScenePatch = {
    sceneId,
    baseRevision,
    revision: options.revision ?? baseRevision + 1,
    timestampMs: options.timestampMs ?? 0,
    operations
  };
  if (options.origin) patch.origin = options.origin;
  return patch;
}

// ---------------------------------------------------------------------------
// Application
// ---------------------------------------------------------------------------

export type PatchFailureCode =
  | "SCENE_ID_MISMATCH"
  | "REVISION_MISMATCH"
  | "REVISION_NOT_ADVANCING"
  | "EMPTY_PATCH"
  | "UNKNOWN_OPERATION"
  | "OBJECT_NOT_FOUND"
  | "DUPLICATE_OBJECT"
  | "INVALID_OPERATION"
  | "REORDER_MISMATCH";

export interface PatchFailure {
  code: PatchFailureCode;
  message: string;
  operationIndex?: number;
}

export type PatchResult =
  | { applied: true; scene: SceneDocument; revision: number; warnings: string[] }
  | { applied: false; failure: PatchFailure; requiresFullSync: boolean };

/**
 * Apply a patch, or refuse it.
 *
 * Atomic: either every operation applies and a new document is returned, or the
 * original document is untouched. A half-applied patch would leave the engine at
 * a revision that matches no document anyone else holds.
 */
export function applyScenePatch(scene: SceneDocument, patch: ScenePatch): PatchResult {
  if (patch.sceneId !== scene.id) {
    return {
      applied: false,
      failure: {
        code: "SCENE_ID_MISMATCH",
        message: `patch targets scene ${patch.sceneId} but the document is ${scene.id}`
      },
      requiresFullSync: false
    };
  }

  const currentRevision = sceneRevision(scene);
  if (patch.baseRevision !== currentRevision) {
    return {
      applied: false,
      failure: {
        code: "REVISION_MISMATCH",
        message: `patch expects revision ${patch.baseRevision} but the document is at ${currentRevision}`
      },
      // The only safe recovery: stop patching and resend the whole scene.
      requiresFullSync: true
    };
  }

  if (patch.revision <= patch.baseRevision) {
    return {
      applied: false,
      failure: {
        code: "REVISION_NOT_ADVANCING",
        message: `patch revision ${patch.revision} does not advance past ${patch.baseRevision}`
      },
      requiresFullSync: false
    };
  }

  if (patch.operations.length === 0) {
    return {
      applied: false,
      failure: { code: "EMPTY_PATCH", message: "patch contains no operations" },
      requiresFullSync: false
    };
  }

  // Work on a shallow-cloned draft so a mid-patch failure cannot mutate the input.
  const draft: SceneDocument = {
    ...scene,
    objects: scene.objects.map((object) => ({ ...object })),
    assets: scene.assets.slice(),
    materials: scene.materials.slice(),
    dataContext: { ...scene.dataContext }
  };

  const warnings: string[] = [];

  for (const [operationIndex, operation] of patch.operations.entries()) {
    const failure = applyOperation(draft, operation, warnings);
    if (failure) {
      return {
        applied: false,
        failure: { ...failure, operationIndex },
        requiresFullSync: failure.code === "OBJECT_NOT_FOUND"
      };
    }
  }

  draft.revision = patch.revision;
  draft.updatedAt = new Date(patch.timestampMs || 0).toISOString();

  return { applied: true, scene: draft, revision: patch.revision, warnings };
}

function applyOperation(
  draft: SceneDocument,
  operation: ScenePatchOperation,
  warnings: string[]
): PatchFailure | undefined {
  switch (operation.type) {
    case "object.created": {
      if (draft.objects.some((object) => object.id === operation.object.id)) {
        return {
          code: "DUPLICATE_OBJECT",
          message: `object ${operation.object.id} already exists`
        };
      }
      const clone = { ...operation.object };
      if (typeof operation.index === "number" && operation.index >= 0) {
        draft.objects.splice(Math.min(operation.index, draft.objects.length), 0, clone);
      } else {
        draft.objects.push(clone);
      }
      return undefined;
    }

    case "object.deleted": {
      const index = draft.objects.findIndex((object) => object.id === operation.objectId);
      if (index < 0) {
        return { code: "OBJECT_NOT_FOUND", message: `object ${operation.objectId} not found` };
      }
      draft.objects.splice(index, 1);
      return undefined;
    }

    case "object.transform": {
      const object = findObject(draft, operation.objectId);
      if (!object) {
        return { code: "OBJECT_NOT_FOUND", message: `object ${operation.objectId} not found` };
      }
      for (const [key, value] of Object.entries(operation.transform)) {
        if (typeof value === "number" && Number.isFinite(value)) {
          (object as unknown as Record<string, unknown>)[key] = value;
        }
      }
      return undefined;
    }

    case "object.text": {
      const object = findObject(draft, operation.objectId);
      if (!object) {
        return { code: "OBJECT_NOT_FOUND", message: `object ${operation.objectId} not found` };
      }
      if (object.type !== "text") {
        warnings.push(`object ${operation.objectId} is a ${object.type}, not text`);
        return undefined;
      }
      (object as unknown as Record<string, unknown>).text = operation.text;
      return undefined;
    }

    case "object.material": {
      const object = findObject(draft, operation.objectId);
      if (!object) {
        return { code: "OBJECT_NOT_FOUND", message: `object ${operation.objectId} not found` };
      }
      const record = object as unknown as Record<string, unknown>;
      const slots = { ...((record.materialSlots as Record<string, unknown>) ?? {}) };
      if (operation.materialId === null) {
        delete slots[operation.slot];
      } else {
        slots[operation.slot] = operation.materialId;
      }
      record.materialSlots = slots;
      return undefined;
    }

    case "object.animation": {
      const object = findObject(draft, operation.objectId);
      if (!object) {
        return { code: "OBJECT_NOT_FOUND", message: `object ${operation.objectId} not found` };
      }
      // `animation` is the schema field; `channels` is the wire name.
      (object as unknown as Record<string, unknown>).animation = { ...operation.channels };
      return undefined;
    }

    case "object.visibility": {
      const object = findObject(draft, operation.objectId);
      if (!object) {
        return { code: "OBJECT_NOT_FOUND", message: `object ${operation.objectId} not found` };
      }
      (object as unknown as Record<string, unknown>).visible = operation.visible;
      return undefined;
    }

    case "object.property": {
      const object = findObject(draft, operation.objectId);
      if (!object) {
        return { code: "OBJECT_NOT_FOUND", message: `object ${operation.objectId} not found` };
      }
      const assigned = assignPath(
        object as unknown as Record<string, unknown>,
        operation.path,
        operation.value
      );
      if (!assigned) {
        return {
          code: "INVALID_OPERATION",
          message: `cannot assign path "${operation.path}" on object ${operation.objectId}`
        };
      }
      return undefined;
    }

    case "layer.reorder": {
      // A reorder must be a permutation of the existing ids. Anything else means
      // the sender's view of the scene has diverged.
      if (operation.objectIds.length !== draft.objects.length) {
        return {
          code: "REORDER_MISMATCH",
          message: `reorder lists ${operation.objectIds.length} objects but the scene has ${draft.objects.length}`
        };
      }
      const byId = new Map(draft.objects.map((object) => [object.id, object]));
      const reordered: SceneObject[] = [];
      for (const objectId of operation.objectIds) {
        const object = byId.get(objectId);
        if (!object) {
          return { code: "REORDER_MISMATCH", message: `reorder references unknown object ${objectId}` };
        }
        byId.delete(objectId);
        reordered.push(object);
      }
      if (byId.size > 0) {
        return { code: "REORDER_MISMATCH", message: "reorder is not a permutation of the scene" };
      }
      draft.objects = reordered;
      return undefined;
    }

    case "asset.changed": {
      const index = draft.assets.findIndex(
        (asset) => asset.assetId === operation.asset.assetId
      );
      if (index >= 0) {
        draft.assets[index] = operation.asset;
      } else {
        draft.assets.push(operation.asset);
      }
      return undefined;
    }

    case "material.changed": {
      const index = draft.materials.findIndex(
        (material) => material.materialId === operation.material.materialId
      );
      if (index >= 0) {
        draft.materials[index] = operation.material;
      } else {
        draft.materials.push(operation.material);
      }
      return undefined;
    }

    case "timeline.changed": {
      draft.timeline = { ...operation.timeline };
      return undefined;
    }

    case "dataContext.changed": {
      const assigned = assignPath(draft.dataContext, operation.path, operation.value);
      if (!assigned) {
        return {
          code: "INVALID_OPERATION",
          message: `cannot assign data path "${operation.path}"`
        };
      }
      return undefined;
    }

    case "surface.changed":
    case "outputMapping.changed":
      // Stage-scoped. Recorded so the revision advances and the engine knows to
      // reload its stage document; the scene itself is unaffected.
      warnings.push(`${operation.type} requires a stage reload, not a scene change`);
      return undefined;

    case "scene.published":
    case "scene.recalled":
      // Lifecycle markers. They carry no content change.
      return undefined;

    default: {
      const exhaustive: never = operation;
      return {
        code: "UNKNOWN_OPERATION",
        message: `unsupported operation ${JSON.stringify(exhaustive)}`
      };
    }
  }
}

function findObject(scene: SceneDocument, objectId: string): SceneObject | undefined {
  return scene.objects.find((object) => object.id === objectId);
}

/** Current revision. Legacy documents without one are revision 0. */
export function sceneRevision(scene: SceneDocument): number {
  return typeof scene.revision === "number" && Number.isFinite(scene.revision)
    ? scene.revision
    : 0;
}

/**
 * Assign a dotted/bracketed path, creating intermediate objects as needed.
 *
 * Refuses prototype-polluting keys. This runs on data from a remote client, so
 * `__proto__` must never become a traversal step.
 */
function assignPath(target: Record<string, unknown>, path: string, value: unknown): boolean {
  const segments = parsePath(path);
  if (segments.length === 0) return false;

  let cursor: Record<string, unknown> = target;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i];
    if (isUnsafeKey(segment)) return false;

    const next = cursor[segment];
    if (next === null || typeof next !== "object") {
      const created: Record<string, unknown> = {};
      cursor[segment] = created;
      cursor = created;
      continue;
    }
    cursor = next as Record<string, unknown>;
  }

  const last = segments[segments.length - 1];
  if (isUnsafeKey(last)) return false;
  cursor[last] = value;
  return true;
}

function parsePath(path: string): string[] {
  if (!path) return [];
  return path
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter((segment) => segment.length > 0);
}

function isUnsafeKey(key: string): boolean {
  return key === "__proto__" || key === "constructor" || key === "prototype";
}

/** Rough byte cost of a patch, for deciding when a full sync is cheaper. */
export function patchByteEstimate(patch: ScenePatch): number {
  return JSON.stringify(patch).length;
}

/**
 * Whether patching is still worthwhile.
 *
 * Past a threshold a full sync is both smaller and safer. Defaults to a quarter
 * of the document size.
 */
export function shouldPreferFullSync(
  patch: ScenePatch,
  sceneByteEstimate: number,
  ratio = 0.25
): boolean {
  return patchByteEstimate(patch) > sceneByteEstimate * ratio;
}
