import type { AeCompositionClock } from "@grapix/shared-types";
import type { AeControlBinding } from "./revision.js";

/** Durable metadata for one authoritative After Effects project. */
export const AE_DYNAMIC_CONTROL_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const AE_RUNTIME_CONTAINER_SCHEMA_VERSION = 1 as const;

export type AeRuntimeContainerStatus =
  | "offline"
  | "starting"
  | "ready"
  | "degraded"
  | "faulted";

export interface AeRuntimeProfile {
  /** After Effects major.minor required by the project, for example `26.3`. */
  aeVersion: string;
  /** Named renderer required by dependency preflight. */
  renderer: string;
  /** Explicit project working colour space; never inferred by GrapiX. */
  workingColorSpace: string;
  /** Rational frame rate, for example `30000/1001`. */
  frameRate: string;
}

export interface AeRuntimeComposition {
  /** Stable After Effects project item id. */
  itemId: number;
  /** Diagnostic display name; identity never falls back to this field. */
  name: string;
  width: number;
  height: number;
  /**
   * Exact composition clock from `AEGP_GetCompFrameDuration`; NEVER use
   * `AEGP_GetCompFramerate`, whose `A_FpLong` float cannot distinguish
   * `2997/100` from `30000/1001`.
   */
  clock: AeCompositionClock;
}

export interface AeCachePolicy {
  mode: "none" | "bounded";
  /** Maximum prepared frames retained by a bounded cache. */
  maxPreparedFrames: number;
}
export type AeDynamicControlKind = "text" | "number" | "boolean" | "color" | "point2d" | "point3d" | "image" | "video" | "enum";
export type AeDynamicControlUpdatePolicy = "immediate" | "next-frame" | "on-take" | "on-cue";

export interface AeDynamicControlTarget {
  compositionItemId: number;
  layerId: number;
  sourceItemId: number | null;
  propertyPath: Array<{ matchName: string; ordinal: number }>;
}

export interface AeDynamicControl {
  /** Persistent identity; never regenerated during rename, reorder, or restart. */
  controlId: string;
  displayName: string;
  kind: AeDynamicControlKind;
  writable: boolean;
  updatePolicy: AeDynamicControlUpdatePolicy;
  target: AeDynamicControlTarget;
  constraints?: {
    minimum?: number;
    maximum?: number;
    enumValues?: string[];
    acceptedAssetHandles?: string[];
  };
  validation: {
    status: "valid" | "stale" | "rebind-required" | "disabled";
    reason: string | null;
    validatedProjectDigest: string | null;
    structuralFingerprint: string | null;
    validatedAt: string | null;
  };
}


export interface AeRuntimeContainer {
  schemaVersion: typeof AE_RUNTIME_CONTAINER_SCHEMA_VERSION;
  id: string;
  name: string;
  /** POSIX-style path relative to an allowlisted AE project root. */
  projectUri: string;
  /** Lowercase SHA-256 of the authoritative `.aep` bytes. */
  projectDigest: string;
  profile: AeRuntimeProfile;
  compositions: AeRuntimeComposition[];
  cachePolicy: AeCachePolicy;
  /** Explicitly declared operator controls. Undeclared AE properties remain unreachable. */
  controls: AeDynamicControl[];
  /** Binds declared controls to data paths. A binding without a declared control is refused. */
  dataBindings: AeControlBinding[];
  /**
   * The declared broadcast cue map for the selected composition, when it has one.
   *
   * Persisted at authoring time so publish can derive the animation actions, and so the package
   * can carry the whole map — markers, rate, clock and digest — for Playout to play. Absent means
   * the composition declared no `GRAPIX:` markers; it is never inferred.
   */
  cueMap?: {
    compositionItemId: number;
    markers: { text: string; time: { value: string; scale: string } }[];
    rate: { numerator: number; denominator: number };
    clock: AeCompositionClock;
    cueMapDigest: string;
  };
  status: AeRuntimeContainerStatus;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAeRuntimeContainerRequest {
  id: string;
  name: string;
  projectUri: string;
  projectDigest: string;
  profile: AeRuntimeProfile;
  compositions: AeRuntimeComposition[];
  controls?: AeDynamicControl[];
  dataBindings?: AeControlBinding[];
  cachePolicy: AeCachePolicy;
}

export interface UpdateAeRuntimeContainerRequest {
  name?: string;
  profile?: AeRuntimeProfile;
  compositions?: AeRuntimeComposition[];
  controls?: AeDynamicControl[];
  dataBindings?: AeControlBinding[];
  cachePolicy?: AeCachePolicy;
  status?: AeRuntimeContainerStatus;
}

export type AeRuntimeContainerErrorCode =
  | "AE_PROJECT_ROOT_NOT_CONFIGURED"
  | "INVALID_CONTAINER_ID"
  | "INVALID_PROJECT_URI"
  | "PROJECT_NOT_FOUND"
  | "PROJECT_DIGEST_MISMATCH"
  | "CONTAINER_ALREADY_EXISTS"
  | "CONTAINER_NOT_FOUND"
  | "INVALID_CONTAINER";

export class AeRuntimeContainerError extends Error {
  constructor(
    readonly code: AeRuntimeContainerErrorCode,
    message: string
  ) {
    super(message);
    this.name = "AeRuntimeContainerError";
  }
}
