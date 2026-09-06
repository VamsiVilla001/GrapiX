/**
 * Read a published AE package back, proving it is intact before Playout trusts it.
 *
 * The writer (`aePackageBuilder`) and this reader are the two ends of one promise: a package is
 * self-contained, immutable, and verifiable. The writer proves what it wrote with
 * `checksums.json`; this reader re-hashes every byte it is about to hand to Playout and refuses
 * the package the moment one digest disagrees, because a graphic that changed in transit is a
 * graphic that changes on air.
 *
 * This module lives in the shared contract package, not in Playout, so the Editor's own tooling
 * and any future inspector verify a package the same way Playout does — one definition of
 * "intact", not three.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AeRuntimeContainer } from "./container.js";
import {
  AE_PACKAGE_PATHS,
  AE_PACKAGE_SCHEMA_VERSION,
  type AePackageAnimations,
  type AePackageControls,
  type AePackageManifest
} from "./package.js";

/** Why a package failed to read. */
export type AePackageReadErrorCode =
  | "PACKAGE_NOT_FOUND"
  | "SCHEMA_UNSUPPORTED"
  | "CHECKSUM_MISMATCH"
  | "PACKAGE_INCOMPLETE";

export class AePackageReadError extends Error {
  constructor(readonly code: AePackageReadErrorCode, message: string) {
    super(message);
    this.name = "AePackageReadError";
  }
}

/** A verified package: the manifest and control surface, with every byte proven. */
export interface VerifiedAePackage {
  /** Absolute path of the version directory this was read from. */
  root: string;
  manifest: AePackageManifest;
  controls: AePackageControls;
  /** The broadcast actions and declared cue map, when the package carries them. */
  animations: AePackageAnimations;
  /** The package-relative `.aep` path resolved to an absolute path Playout can launch. */
  projectPath: string;
}

async function sha256(filePath: string): Promise<string> {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

async function readJson<T>(filePath: string, notFound: () => AePackageReadError): Promise<T> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    throw notFound();
  }
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new AePackageReadError(
      "PACKAGE_INCOMPLETE",
      `${path.basename(filePath)} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Read and verify one published version directory.
 *
 * `versionRoot` is the `vNNN` directory itself, not the graphic root — the caller decides which
 * version to trust, this function decides whether that version is intact. Verification is the
 * point: the manifest and controls are only parsed after every file `checksums.json` lists has
 * been re-hashed from disk and matched.
 */
export async function readAePackage(versionRoot: string): Promise<VerifiedAePackage> {
  const manifestPath = path.join(versionRoot, ...AE_PACKAGE_PATHS.manifest.split("/"));
  const manifest = await readJson<AePackageManifest>(manifestPath, () =>
    new AePackageReadError("PACKAGE_NOT_FOUND", `no package manifest at ${manifestPath}`)
  );

  if (manifest.schemaVersion !== AE_PACKAGE_SCHEMA_VERSION) {
    throw new AePackageReadError(
      "SCHEMA_UNSUPPORTED",
      `package schema ${String(manifest.schemaVersion)} is not the ${AE_PACKAGE_SCHEMA_VERSION} this build understands`
    );
  }

  // Prove integrity before parsing anything else. A package whose bytes moved is refused here,
  // not after Playout has launched After Effects against it.
  const checksumsPath = path.join(versionRoot, ...AE_PACKAGE_PATHS.checksums.split("/"));
  const checksums = await readJson<{ algorithm: string; files: Record<string, string> }>(checksumsPath, () =>
    new AePackageReadError("PACKAGE_INCOMPLETE", `package has no checksums.json at ${checksumsPath}`)
  );
  for (const [relative, expected] of Object.entries(checksums.files)) {
    const absolute = path.join(versionRoot, ...relative.split("/"));
    let actual: string;
    try {
      actual = await sha256(absolute);
    } catch {
      throw new AePackageReadError(
        "PACKAGE_INCOMPLETE",
        `checksums.json lists ${relative} but the file is not in the package`
      );
    }
    if (actual !== expected.toLowerCase()) {
      throw new AePackageReadError(
        "CHECKSUM_MISMATCH",
        `${relative} does not match its published checksum — the package changed after publish`
      );
    }
  }

  const controlsPath = path.join(versionRoot, ...AE_PACKAGE_PATHS.controls.split("/"));
  const controls = await readJson<AePackageControls>(controlsPath, () =>
    new AePackageReadError("PACKAGE_INCOMPLETE", `package has no controls.json at ${controlsPath}`)
  );

  const animationsPath = path.join(versionRoot, ...AE_PACKAGE_PATHS.animations.split("/"));
  // Animations are the one optional payload: a graphic with no `GRAPIX:` markers has none, and a
  // package predating this field never wrote the file. A *missing* file reads as an empty,
  // schema-current animation set; a *corrupt* one is still an incomplete package, because bytes
  // that cannot be parsed are not "no animation", they are unknown animation.
  let animations: AePackageAnimations;
  try {
    animations = JSON.parse(await readFile(animationsPath, "utf8")) as AePackageAnimations;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      animations = { schemaVersion: AE_PACKAGE_SCHEMA_VERSION, actions: [] };
    } else {
      throw new AePackageReadError(
        "PACKAGE_INCOMPLETE",
        `animations.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  const projectPath = path.join(versionRoot, ...manifest.aeProject.split("/"));
  return { root: versionRoot, manifest, controls, animations, projectPath };
}

/**
 * Reconstruct the runtime container a published package represents.
 *
 * Playout's control and revision services operate on `AeRuntimeContainer`, but a published
 * graphic arrives as a package, not a live container record. This rebuilds the container the
 * package is the immutable proof of — identity, profile, composition clock and the declared
 * control surface — so an operator can drive a published graphic through the exact services that
 * drive a live-declared one. Identity comes from the manifest (`itemId`, digests), never from a
 * name, so a designer renaming the comp does not split the graphic in two.
 */
export function containerFromAePackage(pkg: VerifiedAePackage, now = new Date()): AeRuntimeContainer {
  const { manifest } = pkg;
  return {
    schemaVersion: 1,
    id: manifest.id,
    name: manifest.name,
    // A published package resolves its own project; the source projectUri is meaningless on the
    // playout machine. The packaged `.aep` path is what the runtime launches.
    projectUri: pkg.projectPath,
    projectDigest: manifest.projectDigest,
    profile: manifest.profile,
    compositions: manifest.compositions,
    cachePolicy: manifest.cachePolicy,
    controls: pkg.controls.controls,
    dataBindings: pkg.controls.dataBindings,
    status: "offline",
    createdAt: manifest.publishedAt,
    updatedAt: now.toISOString()
  };
}
