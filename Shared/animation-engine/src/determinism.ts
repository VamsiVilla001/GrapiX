/**
 * Determinism: the contract that lets browser preview and native Program agree.
 *
 * The rule is that animation state is a pure function of `(sceneRevision, frame)`.
 * If that holds, two renderers given the same scene and frame produce the same
 * geometry, and any difference in the picture is a *rendering* difference rather
 * than a *state* difference. Without it, comparing renderers is meaningless
 * because you can never tell which kind of difference you are looking at.
 *
 * `sceneStateFingerprint` makes the rule checkable. It hashes the evaluated
 * geometry — not the pixels — so a test can assert that the editor and the engine
 * evaluated the same frame identically, independently of shading, sampling, or
 * colour management.
 */

import {
  evaluateSceneAtFrame,
  type SceneDocument,
  type SceneObject
} from "@grapix/shared-types";

/**
 * Evaluate a scene at a frame.
 *
 * A thin, deliberate wrapper over the existing shared-types evaluator: reusing it
 * is the point. If the engine had its own evaluator the two would drift, and
 * drift here is invisible until it is on air.
 */
export function evaluateFrame(scene: SceneDocument, frame: number): SceneDocument {
  return evaluateSceneAtFrame(scene, Number.isFinite(frame) ? Math.max(0, Math.floor(frame)) : 0);
}

/** Properties that must match between renderers for state to be identical. */
const FINGERPRINTED_PROPERTIES = [
  "x",
  "y",
  "zDepth",
  "zIndex",
  "rotation",
  "rotationX",
  "rotationY",
  "rotationZ",
  "scaleX",
  "scaleY",
  "scaleZ",
  "anchorX",
  "anchorY",
  "opacity",
  "width",
  "height",
  "visible",
  "text",
  "layerId"
] as const;

/**
 * Quantisation applied before hashing.
 *
 * Six decimal places. Fine enough that a real state divergence is caught, coarse
 * enough that the last bit of a double does not make two correct evaluations
 * disagree — the browser and Rust both use f64 but may fold operations in a
 * different order.
 */
const QUANTISATION = 1e6;

function quantise(value: number): number {
  return Math.round(value * QUANTISATION) / QUANTISATION;
}

export interface ObjectFingerprint {
  objectId: string;
  type: string;
  values: Record<string, string | number | boolean>;
}

export interface SceneFingerprint {
  sceneId: string;
  revision: number;
  frame: number;
  objectCount: number;
  objects: ObjectFingerprint[];
  /** Stable 32-bit hash of the whole fingerprint. */
  hash: string;
}

/**
 * Fingerprint the evaluated state of a scene at a frame.
 *
 * Objects are sorted by id so two renderers that iterate in different orders
 * still produce the same fingerprint — iteration order is an implementation
 * detail, not part of the state.
 */
export function sceneStateFingerprint(scene: SceneDocument, frame: number): SceneFingerprint {
  const evaluated = evaluateFrame(scene, frame);

  const objects: ObjectFingerprint[] = evaluated.objects
    .map((object) => fingerprintObject(object))
    .sort((a, b) => a.objectId.localeCompare(b.objectId));

  const revision = typeof evaluated.revision === "number" ? evaluated.revision : 0;
  const canonical = JSON.stringify({
    sceneId: evaluated.id,
    revision,
    frame,
    objects
  });

  return {
    sceneId: evaluated.id,
    revision,
    frame,
    objectCount: objects.length,
    objects,
    hash: hash32(canonical)
  };
}

function fingerprintObject(object: SceneObject): ObjectFingerprint {
  const record = object as unknown as Record<string, unknown>;
  const values: Record<string, string | number | boolean> = {};

  for (const property of FINGERPRINTED_PROPERTIES) {
    const value = record[property];
    if (typeof value === "number" && Number.isFinite(value)) {
      values[property] = quantise(value);
    } else if (typeof value === "boolean" || typeof value === "string") {
      values[property] = value;
    }
  }

  return { objectId: object.id, type: object.type, values };
}

export interface FingerprintDifference {
  objectId: string;
  property: string;
  a: string | number | boolean | undefined;
  b: string | number | boolean | undefined;
}

export interface ParityResult {
  identical: boolean;
  differences: FingerprintDifference[];
  onlyInA: string[];
  onlyInB: string[];
}

/**
 * Compare two fingerprints and name every divergence.
 *
 * Used by the preview/Program consistency tests. A failure names the object and
 * property, which is the difference between a useful test and one that just says
 * "renderers disagree".
 */
export function compareFingerprints(a: SceneFingerprint, b: SceneFingerprint): ParityResult {
  const differences: FingerprintDifference[] = [];
  const mapA = new Map(a.objects.map((object) => [object.objectId, object]));
  const mapB = new Map(b.objects.map((object) => [object.objectId, object]));

  const onlyInA: string[] = [];
  const onlyInB: string[] = [];

  for (const [objectId, objectA] of mapA) {
    const objectB = mapB.get(objectId);
    if (!objectB) {
      onlyInA.push(objectId);
      continue;
    }

    if (objectA.type !== objectB.type) {
      differences.push({ objectId, property: "type", a: objectA.type, b: objectB.type });
    }

    const properties = new Set([
      ...Object.keys(objectA.values),
      ...Object.keys(objectB.values)
    ]);
    for (const property of properties) {
      const valueA = objectA.values[property];
      const valueB = objectB.values[property];
      if (valueA !== valueB) {
        differences.push({ objectId, property, a: valueA, b: valueB });
      }
    }
  }

  for (const objectId of mapB.keys()) {
    if (!mapA.has(objectId)) onlyInB.push(objectId);
  }

  return {
    identical:
      differences.length === 0 && onlyInA.length === 0 && onlyInB.length === 0 && a.hash === b.hash,
    differences,
    onlyInA: onlyInA.sort(),
    onlyInB: onlyInB.sort()
  };
}

/**
 * Assert a scene evaluates identically every time.
 *
 * Catches accidental non-determinism inside the evaluator: a `Date.now()`, a
 * `Math.random()`, or state leaking between calls. Repeated evaluation of the
 * same frame must produce byte-identical fingerprints.
 */
export function verifyEvaluationStability(
  scene: SceneDocument,
  frames: readonly number[],
  repetitions = 3
): { stable: boolean; unstableFrames: number[] } {
  const unstableFrames: number[] = [];

  for (const frame of frames) {
    const first = sceneStateFingerprint(scene, frame).hash;
    for (let attempt = 1; attempt < repetitions; attempt += 1) {
      if (sceneStateFingerprint(scene, frame).hash !== first) {
        unstableFrames.push(frame);
        break;
      }
    }
  }

  return { stable: unstableFrames.length === 0, unstableFrames };
}

/**
 * FNV-1a, 32-bit.
 *
 * Not cryptographic and does not need to be: this detects accidental divergence
 * between two renderers, not tampering. It is chosen because it is trivial to
 * reimplement identically in Rust, which the engine does.
 */
export function hash32(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i) & 0xff;
    // 16777619, expressed as shifts to stay inside 32-bit integer maths.
    hash = Math.imul(hash, 0x01000193) >>> 0;

    const high = value.charCodeAt(i) >>> 8;
    if (high !== 0) {
      hash ^= high;
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
