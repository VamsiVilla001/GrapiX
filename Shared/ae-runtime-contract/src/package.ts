/**
 * The published After Effects package — the contract between Editor and Playout.
 *
 * Playout must never depend on the designer's original project location. A published package is
 * therefore **self-contained and immutable**: the `.aep`, every footage file it resolves, the
 * declared controls, the animation map, and the dependency requirements, written once under a
 * version directory that is never rewritten.
 *
 * That immutability is not tidiness. A package can be on air, and a graphic whose bytes change
 * underneath a running After Effects is a graphic that changes on air — so publishing produces
 * `v002` beside `v001` and lets Playout choose, rather than overwriting anything.
 *
 * ## Layout
 *
 * ```text
 * <graphicId>/Published/v001/
 *   project/<name>.aep
 *   assets/
 *     images/ video/ audio/ image-sequences/ footage/ proxies/
 *   grapix/
 *     manifest.json  controls.json  animations.json  dependencies.json  checksums.json
 *   thumbnail.png
 * ```
 *
 * ## Why the control shape here is not the simple one
 *
 * A control could be `{comp, layer, property}` by display name, which reads well and breaks the
 * first time a designer renames `Team_Name` to `Home_Team_Name`. The package therefore carries
 * `AeDynamicControl` — stable `controlId`, and a target addressed by After Effects `matchName`
 * plus ordinal rather than by label. This is the same reasoning the plan states for stable ids; it
 * is applied to the persisted form rather than only to the runtime one, because the persisted form
 * is what survives a rename.
 */
import type { AeCachePolicy, AeDynamicControl, AeRuntimeComposition, AeRuntimeProfile } from "./container.js";
import type { AeControlBinding } from "./revision.js";
import type { AeCompositionClock } from "@grapix/shared-types";

export const AE_PACKAGE_SCHEMA_VERSION = 1 as const;

/** Where each file lives inside a version directory. Relative, POSIX, and never absolute. */
export const AE_PACKAGE_PATHS = {
  manifest: "grapix/manifest.json",
  controls: "grapix/controls.json",
  animations: "grapix/animations.json",
  dependencies: "grapix/dependencies.json",
  checksums: "grapix/checksums.json",
  projectDir: "project",
  assetsDir: "assets",
  thumbnail: "thumbnail.png"
} as const;

/**
 * How a packaged footage file is expected to resolve when After Effects opens the packaged project.
 *
 * Recorded rather than assumed, because the three strategies fail differently and an operator who
 * sees missing footage needs to know which one was promised:
 *
 * - `aep-relative` — the `.aep` was rewritten or authored to reference footage relative to itself,
 *   so After Effects resolves it with no help.
 * - `collected` — the project was produced by After Effects' own *Collect Files*, which copies and
 *   relinks as a unit.
 * - `runtime-relink` — the `.aep` still carries its original paths, and the runtime re-points each
 *   footage item to its packaged copy after opening, using `assets[].sourcePath` → `packagedPath`.
 *
 * A package that cannot honestly claim one of these is not publishable.
 */
export type AeFootageResolution = "aep-relative" | "collected" | "runtime-relink";

/**
 * One footage file as the package stores it.
 *
 * Both paths are kept on purpose. `sourcePath` is what the `.aep` references — the only key a
 * relink can match on — and `packagedPath` is where the bytes now live. Dropping either makes the
 * mapping unusable: the first alone cannot be found on a playout machine, the second alone cannot
 * be matched to the layer that wants it.
 */
export interface AePackagedAsset {
  /** Project-item id from the source manifest, when the producer supplied one. */
  itemId?: string;
  name: string;
  /** The path exactly as After Effects recorded it, before collection. */
  sourcePath: string;
  /** Package-relative POSIX path, under `assets/`. */
  packagedPath: string;
  mediaType?: "video" | "audio" | "image" | "image-sequence" | "font" | "photoshop" | "illustrator" | "other";
  sizeBytes: number;
  /** Lowercase SHA-256 of the stored bytes. */
  checksum: string;
  /** An image sequence is one asset; these are its frames, package-relative and in order. */
  sequenceFrames?: string[];
}

/** `grapix/manifest.json` — what this published graphic is. */
export interface AePackageManifest {
  schemaVersion: typeof AE_PACKAGE_SCHEMA_VERSION;
  /** Stable graphic identity across versions. */
  id: string;
  name: string;
  /** Monotonic, starting at 1. Directory `v001` holds version 1. */
  version: number;
  publishedAt: string;
  /** Package-relative path of the `.aep`. */
  aeProject: string;
  /** Lowercase SHA-256 of the packaged `.aep` bytes. */
  projectDigest: string;
  /**
   * The digest of the project as it stood when the container was authored.
   *
   * Kept beside `projectDigest` so a package produced from a re-saved project is identifiable:
   * the two differ exactly when publishing modified the project (a relink or a collect), which is
   * information a parity investigation needs and cannot recover afterwards.
   */
  sourceProjectDigest: string;
  /** The composition Playout opens. Identified by item id; the name is diagnostic only. */
  mainComposition: { itemId: number; name: string; width: number; height: number };
  profile: AeRuntimeProfile;
  compositions: AeRuntimeComposition[];
  cachePolicy: AeCachePolicy;
  footageResolution: AeFootageResolution;
  assets: AePackagedAsset[];
  thumbnail?: string;
}

/** `grapix/controls.json` — the operator surface, and the only reachable AE properties. */
export interface AePackageControls {
  schemaVersion: typeof AE_PACKAGE_SCHEMA_VERSION;
  controls: AeDynamicControl[];
  dataBindings: AeControlBinding[];
}

/**
 * One broadcast action, expressed as a frame region.
 *
 * Playout issues CUE/TAKE/CONTINUE/OUT and never reasons about keyframes; this is the whole of what
 * it needs to know about timing. Frames are Program frames on the manifest's declared rate.
 */
export interface AePackageAnimationAction {
  /** `IN`, `LOOP`, `OUT`, or an author-defined name. */
  role: string;
  startFrame: number;
  endFrame: number;
  /** True for a region Playout holds on until told to continue. */
  holds?: boolean;
}

/** `grapix/animations.json` — the actions, and the cue markers they were derived from. */
export interface AePackageAnimations {
  schemaVersion: typeof AE_PACKAGE_SCHEMA_VERSION;
  actions: AePackageAnimationAction[];
  /**
   * The resolved `GRAPIX:` cue map digest, when the actions came from composition markers.
   *
   * Playout does not re-derive the map; it compares this digest to what the runtime reports, so a
   * project whose markers moved after publish is detected rather than silently played to the old
   * timings.
   */
  cueMapDigest?: string;
  /**
   * The complete declared cue map, when the composition carried `GRAPIX:` markers.
   *
   * The actions tell Playout *what regions exist*; this tells it *how to seek to them*. The markers,
   * rate and clock are what `AeCueService` needs to resolve a declared cue to an exact `SET_TIME`,
   * so a published graphic is playable, not merely described. Absent means the composition declared
   * no markers — playback then has no cues to target.
   */
  cueMap?: {
    compositionItemId: number;
    markers: { text: string; time: { value: string; scale: string } }[];
    rate: { numerator: number; denominator: number };
    clock: AeCompositionClock;
  };
}

/** `grapix/dependencies.json` — what the playout machine must have before this can go on air. */
export interface AePackageDependencies {
  schemaVersion: typeof AE_PACKAGE_SCHEMA_VERSION;
  afterEffects: { minimumVersion: string; renderer?: string };
  fonts: { family: string; style?: string; usedBy: string[] }[];
  /**
   * Third-party effects the project uses.
   *
   * GrapiX does not need to know how a plugin renders — only that it is present. `required` is true
   * when a layer draws through it, because a missing required plugin is a graphic that cannot go on
   * air rather than one that looks slightly wrong.
   */
  plugins: { name: string; matchName?: string; required: boolean }[];
}

/** `grapix/checksums.json` — every packaged file, so a transferred package can be proven intact. */
export interface AePackageChecksums {
  algorithm: "sha256";
  /** Package-relative POSIX path → lowercase hex digest. */
  files: Record<string, string>;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Publish validation
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Why a publish was refused or warned about.
 *
 * Split into refusals and warnings rather than one severity field, because the question an author
 * has is binary — *can this go on air* — and a list that mixes "no main composition" with "uses a
 * third-party plugin" answers it only after being read in full.
 */
export type AePublishRefusalCode =
  | "NO_MAIN_COMPOSITION"
  | "PROJECT_NOT_FOUND"
  | "PROJECT_DIGEST_MISMATCH"
  | "PROJECT_UNSAVED"
  | "MISSING_FOOTAGE"
  | "MISSING_FONT"
  | "CONTROL_INVALID"
  | "CONTROL_TARGET_STALE"
  | "NO_CONTROLS_DECLARED"
  | "FRAME_RATE_UNSUPPORTED"
  | "VERSION_ALREADY_EXISTS";

export type AePublishWarningCode =
  | "THIRD_PARTY_PLUGIN"
  | "EXPRESSION_EXTERNAL_FILE"
  | "PROXY_IN_USE"
  | "NO_ANIMATION_ACTIONS"
  | "NO_THUMBNAIL"
  | "FOOTAGE_RESOLVED_BY_SEARCH";

export interface AePublishFinding<TCode extends string> {
  code: TCode;
  /** What is wrong, naming the thing — a layer, a file, a control — not just the category. */
  message: string;
  /** What to do about it. */
  remedy?: string;
  subject?: string;
}

/**
 * The answer to "is this ready for playout".
 *
 * `ok` is exactly `refusals.length === 0`; warnings never block. A caller that wants the plan's
 * READY / NOT READY banner reads `ok` and nothing else.
 */
export interface AePublishValidation {
  ok: boolean;
  refusals: AePublishFinding<AePublishRefusalCode>[];
  warnings: AePublishFinding<AePublishWarningCode>[];
  /** Counted so a summary line does not have to walk the arrays. */
  counts: { refusals: number; warnings: number };
}

export type AePackageErrorCode =
  | "PACKAGE_ROOT_NOT_CONFIGURED"
  /** No GrapiX project is open, so an import has nowhere to collect its footage into. */
  | "NO_PROJECT_OPEN"
  | "CONTAINER_NOT_FOUND"
  | "VALIDATION_FAILED"
  | "VERSION_ALREADY_EXISTS"
  | "ASSET_COLLECTION_FAILED"
  | "PACKAGE_WRITE_FAILED";

export class AePackageError extends Error {
  constructor(
    readonly code: AePackageErrorCode,
    message: string,
    /** The validation that refused, when the code is `VALIDATION_FAILED`. */
    readonly validation: AePublishValidation | null = null
  ) {
    super(message);
    this.name = "AePackageError";
  }
}

/** `1` → `v001`. Zero-padded to three so a directory listing sorts correctly to v999. */
export function aeVersionDirectory(version: number): string {
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new AePackageError("PACKAGE_WRITE_FAILED", `package version must be a positive integer, received ${version}`);
  }
  return `v${String(version).padStart(3, "0")}`;
}

/** `v001` → `1`; anything else → null, so a stray directory cannot be read as a version. */
export function parseAeVersionDirectory(name: string): number | null {
  const match = /^v(\d{3,})$/.exec(name);
  if (!match) return null;
  const version = Number(match[1]);
  return Number.isSafeInteger(version) && version >= 1 ? version : null;
}

/** Collect findings into the validation shape, so every producer reports it identically. */
export function buildAePublishValidation(
  refusals: AePublishFinding<AePublishRefusalCode>[],
  warnings: AePublishFinding<AePublishWarningCode>[]
): AePublishValidation {
  return {
    ok: refusals.length === 0,
    refusals,
    warnings,
    counts: { refusals: refusals.length, warnings: warnings.length }
  };
}
