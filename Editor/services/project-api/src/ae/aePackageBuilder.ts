/**
 * Build a published After Effects package.
 *
 * The package is what makes Playout independent of the designer's machine: the `.aep`, its footage,
 * the declared controls, the animation actions and the dependency requirements, written once under
 * an immutable version directory.
 *
 * ## Two properties this file exists to guarantee
 *
 * **A published version is never rewritten.** A package can be on air, and a graphic whose bytes
 * change underneath a running After Effects is a graphic that changes on air. Publishing therefore
 * allocates the next version and refuses an existing one, rather than overwriting.
 *
 * **A version directory is never half-written.** The package is assembled in a sibling temporary
 * directory and moved into place with one rename, so a Playout scanning for versions sees either
 * nothing or a complete package. Building in place would let a crash mid-copy leave a `v003` that
 * lists in the library and fails at take.
 *
 * ## Footage resolution
 *
 * Collection copies the bytes; it does not rewrite the `.aep`, which still references the paths the
 * designer used. The package therefore declares `footageResolution: "runtime-relink"` and carries a
 * `sourcePath → packagedPath` map, which the runtime uses to re-point each footage item after
 * opening the project. Rewriting the binary would need a RIFX *writer* — GrapiX has a parser only —
 * and a malformed `.aep` is a graphic After Effects will not open at all.
 */
import {
  AE_PACKAGE_PATHS,
  AE_PACKAGE_SCHEMA_VERSION,
  AePackageError,
  aeVersionDirectory,
  buildAePublishValidation,
  parseAeVersionDirectory,
  type AePackageAnimationAction,
  type AePackageAnimations,
  type AePackageChecksums,
  type AePackageControls,
  type AePackageDependencies,
  type AePackageManifest,
  type AePublishFinding,
  type AePublishRefusalCode,
  type AePublishValidation,
  type AePublishWarningCode,
  type AeRuntimeContainer
} from "@grapix/ae-runtime-contract";
import type { AeManifest } from "@grapix/shared-types";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { collectAeFootage, resolveFootagePath, safePackagePath, type AeCollectionResult } from "./aeFootageCollector.js";

export interface AePublishRequest {
  container: AeRuntimeContainer;
  /** The inspected project. Supplies footage, fonts and effects; never re-read from here. */
  manifest: AeManifest;
  /** Absolute path of the authoritative `.aep`. */
  projectPath: string;
  /** Absolute directory the graphic's `Published/` tree lives under. */
  graphicRoot: string;
  /**
   * Broadcast actions for `animations.json`.
   *
   * Supplied rather than derived: the cue map is resolved by `@grapix/animation-engine` against the
   * exact composition clock, and a second implementation here would be a second answer to what
   * `IN` means. Absent produces an empty action list and a warning, not a guess.
   */
  actions?: AePackageAnimationAction[];
  cueMapDigest?: string;
  /**
   * The complete declared cue map, when the composition carried markers.
   *
   * Carried into `animations.json` so Playout can resolve a declared cue to an exact `SET_TIME`,
   * not merely know which regions exist. Written verbatim — the map was already proven against the
   * composition clock by whoever derived it.
   */
  cueMap?: AePackageAnimations["cueMap"];
  /** PNG bytes for `thumbnail.png`, when the caller rendered one. */
  thumbnail?: Buffer;
  collectedFootageDir?: string;
  signal?: AbortSignal;
}

export interface BuiltAePackage {
  version: number;
  /** Absolute path of the version directory. */
  directory: string;
  manifest: AePackageManifest;
  validation: AePublishValidation;
  collection: AeCollectionResult;
  fileCount: number;
  totalBytes: number;
}

/** Adobe's own effects carry an `ADBE ` match name; anything else came from a third party. */
function isThirdPartyEffect(matchName: string): boolean {
  return !matchName.startsWith("ADBE ");
}

/**
 * The compositions and assets one graphic actually draws.
 *
 * A published package is one *graphic*, not a project library. A production project routinely holds
 * hundreds of compositions — this one carries 280 — and the footage the other 279 reference has no
 * bearing on whether the one being published can go to air. Validating or collecting the whole
 * project therefore refuses a perfectly good graphic because an unrelated comp on the next page
 * points at a designer's old Downloads folder.
 *
 * The closure walks `sourceItemId` from the declared compositions: an id that names another
 * composition is a precomp and is followed, anything else is footage and is kept. Cycles cannot
 * loop it — a composition is visited once — which matters because After Effects will happily hold
 * a project whose precomp graph a naive walk would not terminate on.
 */
export function resolveCompositionClosure(
  manifest: AeManifest,
  rootCompositionIds: readonly string[]
): { assetIds: Set<string>; compositionIds: Set<string> } {
  const compositionsById = new Map(manifest.compositions.map((composition) => [String(composition.id), composition]));
  const assetIds = new Set<string>();
  const compositionIds = new Set<string>();
  const pending = [...rootCompositionIds];

  while (pending.length > 0) {
    const id = pending.pop();
    if (id === undefined || compositionIds.has(id)) continue;
    const composition = compositionsById.get(id);
    if (!composition) continue;
    compositionIds.add(id);

    for (const layer of composition.layers) {
      if (layer.sourceItemId === undefined || layer.sourceItemId === null) continue;
      const sourceId = String(layer.sourceItemId);
      if (compositionsById.has(sourceId)) pending.push(sourceId);
      else assetIds.add(sourceId);
    }
  }

  return { assetIds, compositionIds };
}

/**
 * Decide whether this graphic may be published.
 *
 * Pure apart from the two filesystem facts it has to establish — that the project exists and that
 * its bytes still match the container. Everything else is read from the container and the manifest,
 * so a caller can validate without writing anything.
 */
export async function validateAePublish(request: AePublishRequest): Promise<AePublishValidation> {
  const refusals: AePublishFinding<AePublishRefusalCode>[] = [];
  const warnings: AePublishFinding<AePublishWarningCode>[] = [];
  const { container, manifest } = request;

  if (container.compositions.length === 0) {
    refusals.push({
      code: "NO_MAIN_COMPOSITION",
      message: "The container declares no composition, so Playout would have nothing to open.",
      remedy: "Declare at least one composition on the container."
    });
  }

  let projectBytes: Buffer | null = null;
  try {
    projectBytes = await readFile(request.projectPath);
  } catch {
    refusals.push({
      code: "PROJECT_NOT_FOUND",
      message: `The project file was not found at ${request.projectPath}.`,
      remedy: "Check the project has not been moved or renamed since the container was created.",
      subject: request.projectPath
    });
  }

  if (projectBytes) {
    const digest = createHash("sha256").update(projectBytes).digest("hex");
    if (digest !== container.projectDigest.toLowerCase()) {
      // The container's controls were validated against specific project bytes. Publishing
      // different bytes would ship controls whose targets were never checked against what shipped.
      refusals.push({
        code: "PROJECT_DIGEST_MISMATCH",
        message: `The project has changed since the container was created (${digest.slice(0, 12)}… ≠ ${container.projectDigest.slice(0, 12)}…).`,
        remedy: "Re-inspect the project and update the container, then publish again."
      });
    }
  }

  /*
   * Footage is resolved against the filesystem here, not merely read off the manifest.
   *
   * The native parser reports what the project *says*; it does not stat the disk, so a project
   * authored on another machine parses with `missing: false` on every asset and would pass a
   * manifest-only check. That is exactly the case this refusal exists for — a real project moved
   * from a Mac carries `/Volumes/...` paths that resolve nowhere here. Finding out during the copy
   * would abort a publish half-written; finding out now produces the plan's NOT READY report.
   *
   * Named individually and capped: "89 files missing" is not something an author can act on, and
   * eighty-nine refusal lines is not a report either.
   */
  const declaredIds = container.compositions.map((composition) => String(composition.itemId));
  const missingDeclared = declaredIds.filter(
    (id) => !manifest.compositions.some((composition) => String(composition.id) === id)
  );
  if (missingDeclared.length > 0) {
    // Without this the closure would come back empty and the package would ship with no footage
    // at all, which looks like a clean publish right up until the graphic is taken to air.
    refusals.push({
      code: "NO_MAIN_COMPOSITION",
      message: `The container declares composition ${missingDeclared.join(", ")}, which this project does not contain.`,
      remedy: "Re-inspect the project and update the container's compositions."
    });
  }
  const closure = resolveCompositionClosure(manifest, declaredIds);

  const sourceDir = path.dirname(manifest.sourceFile);
  const unresolved: string[] = [];
  for (const asset of manifest.assets) {
    if (asset.kind !== "footage") continue;
    // Only what this graphic draws. Footage another composition references is not this package's
    // problem, and refusing on it would make a publishable graphic unpublishable.
    if (!closure.assetIds.has(String(asset.id))) continue;
    const references = asset.sequenceFrames?.length ? asset.sequenceFrames : [asset.sourcePath];
    for (const reference of references) {
      // A footage item with no path is a solid or a placeholder: there is no file to find.
      if (!reference) continue;
      const found = await resolveFootagePath(reference, sourceDir, request.collectedFootageDir);
      if (!found) unresolved.push(reference);
      else if (found.viaSearch) {
        warnings.push({
          code: "FOOTAGE_RESOLVED_BY_SEARCH",
          message: `"${asset.name}" was matched by filename inside the Collect Files folder rather than by its recorded path.`,
          subject: reference
        });
      }
    }
  }

  const NAMED_LIMIT = 10;
  for (const reference of unresolved.slice(0, NAMED_LIMIT)) {
    refusals.push({
      code: "MISSING_FOOTAGE",
      message: `Footage "${path.basename(reference)}" was not found at ${reference}.`,
      remedy: "Relink it in After Effects, or publish with a Collect Files folder.",
      subject: reference
    });
  }
  if (unresolved.length > NAMED_LIMIT) {
    refusals.push({
      code: "MISSING_FOOTAGE",
      message: `${unresolved.length - NAMED_LIMIT} further footage files were not found.`,
      remedy: "Run File > Dependencies > Collect Files in After Effects and publish against that folder."
    });
  }

  for (const control of container.controls) {
    if (control.validation.status === "rebind-required") {
      refusals.push({
        code: "CONTROL_TARGET_STALE",
        message: `Control "${control.displayName}" no longer resolves to a property in this project.`,
        remedy: "Relink the control to a property, or remove it.",
        subject: control.controlId
      });
    } else if (control.validation.status === "stale") {
      warnings.push({
        code: "FOOTAGE_RESOLVED_BY_SEARCH",
        message: `Control "${control.displayName}" was last validated against an older project revision.`,
        subject: control.controlId
      });
    }
  }

  if (container.controls.length === 0) {
    // Not a refusal: a graphic with no operator controls is a legitimate static bug or bumper.
    warnings.push({
      code: "NO_ANIMATION_ACTIONS",
      message: "No controls are declared, so Playout will have no operator surface for this graphic."
    });
  }

  if (!parseRationalFrameRate(container.profile.frameRate)) {
    refusals.push({
      code: "FRAME_RATE_UNSUPPORTED",
      message: `The profile frame rate "${container.profile.frameRate}" is not a rational like 30000/1001.`,
      remedy: "Set an exact rational frame rate on the container profile."
    });
  }

  // Third-party effects: reported, never blocked here. Whether the plugin exists is a fact about
  // the playout machine, which is why it travels in dependencies.json for Playout to check.
  const thirdParty = new Map<string, string>();
  for (const composition of manifest.compositions) {
    // Scoped like the dependency list it previews, or validation would warn about a plugin the
    // package does not actually ship a use of.
    if (!closure.compositionIds.has(String(composition.id))) continue;
    for (const layer of composition.layers) {
      for (const effect of layer.effects ?? []) {
        if (effect.matchName && isThirdPartyEffect(effect.matchName)) {
          thirdParty.set(effect.matchName, effect.name);
        }
      }
    }
  }
  for (const [matchName, name] of thirdParty) {
    warnings.push({
      code: "THIRD_PARTY_PLUGIN",
      message: `The project uses the third-party effect "${name}". Playout will refuse to take it online without that plugin installed.`,
      subject: matchName
    });
  }

  if (!request.actions?.length) {
    warnings.push({
      code: "NO_ANIMATION_ACTIONS",
      message: "No animation actions were supplied, so Playout will have no IN/OUT regions to drive."
    });
  }
  if (!request.thumbnail) {
    warnings.push({ code: "NO_THUMBNAIL", message: "No thumbnail was supplied for the package." });
  }

  return buildAePublishValidation(refusals, warnings);
}

/** `30000/1001` or `50` → a positive rational; anything else → null. */
function parseRationalFrameRate(value: string): { numerator: number; denominator: number } | null {
  const match = /^(\d+)(?:\/(\d+))?$/.exec(value.trim());
  if (!match) return null;
  const numerator = Number(match[1]);
  const denominator = match[2] === undefined ? 1 : Number(match[2]);
  if (!Number.isSafeInteger(numerator) || numerator <= 0) return null;
  if (!Number.isSafeInteger(denominator) || denominator <= 0) return null;
  return { numerator, denominator };
}

/** The versions already published for a graphic, ascending. */
export async function listAePackageVersions(graphicRoot: string): Promise<number[]> {
  const publishedRoot = path.join(graphicRoot, "Published");
  let entries;
  try {
    entries = await readdir(publishedRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => parseAeVersionDirectory(entry.name))
    .filter((version): version is number => version !== null)
    .sort((left, right) => left - right);
}

/**
 * Validate, collect and write one immutable published version.
 *
 * Refuses rather than publishes when validation fails: a package that ships known-missing footage
 * is a graphic that fails at take, and the failure is cheaper here.
 */
export async function buildAePackage(request: AePublishRequest): Promise<BuiltAePackage> {
  const validation = await validateAePublish(request);
  if (!validation.ok) {
    throw new AePackageError(
      "VALIDATION_FAILED",
      `publish refused: ${validation.refusals.map((refusal) => refusal.message).join(" ")}`,
      validation
    );
  }

  const existing = await listAePackageVersions(request.graphicRoot);
  const version = (existing.at(-1) ?? 0) + 1;
  const publishedRoot = path.join(request.graphicRoot, "Published");
  const finalDirectory = path.join(publishedRoot, aeVersionDirectory(version));

  if (await pathExists(finalDirectory)) {
    throw new AePackageError("VERSION_ALREADY_EXISTS", `package version ${version} already exists`);
  }

  // Assembled beside the destination so the move is a rename within one filesystem, then promoted
  // in a single step. A reader either sees no version or a whole one.
  const stagingDirectory = path.join(publishedRoot, `.staging-${aeVersionDirectory(version)}`);
  await rm(stagingDirectory, { recursive: true, force: true });
  await mkdir(stagingDirectory, { recursive: true });

  try {
    const built = await writePackageContents(request, stagingDirectory, version, validation);
    await rename(stagingDirectory, finalDirectory);
    return { ...built, directory: finalDirectory };
  } catch (error) {
    // A failed publish leaves nothing behind: the staging directory is the only thing written, and
    // it is removed here rather than left to be mistaken for a partial version.
    await rm(stagingDirectory, { recursive: true, force: true });
    if (error instanceof AePackageError) throw error;
    throw new AePackageError(
      "PACKAGE_WRITE_FAILED",
      `package could not be written: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

async function writePackageContents(
  request: AePublishRequest,
  directory: string,
  version: number,
  validation: AePublishValidation
): Promise<Omit<BuiltAePackage, "directory">> {
  const { container, manifest } = request;
  const projectFileName = sanitizeFileName(path.basename(request.projectPath));
  const projectPackagedPath = path.posix.join(AE_PACKAGE_PATHS.projectDir, projectFileName);

  await mkdir(path.join(directory, AE_PACKAGE_PATHS.projectDir), { recursive: true });
  await copyFile(request.projectPath, safePackagePath(directory, projectPackagedPath));

  const projectBytes = await readFile(request.projectPath);
  const projectDigest = createHash("sha256").update(projectBytes).digest("hex");

  // The same closure the validation used, so what is checked and what is copied cannot diverge.
  const closure = resolveCompositionClosure(
    manifest,
    container.compositions.map((composition) => String(composition.itemId))
  );
  const scoped: AeManifest = {
    ...manifest,
    assets: manifest.assets.filter((asset) => closure.assetIds.has(String(asset.id)))
  };

  const collection = await collectAeFootage(scoped, directory, {
    collectedFootageDir: request.collectedFootageDir,
    signal: request.signal
  });

  if (collection.missing.length > 0) {
    // Validation passed on what the inspector knew; the filesystem then disagreed. Refusing here
    // keeps the guarantee that a published package resolves, rather than shipping a hole.
    throw new AePackageError(
      "ASSET_COLLECTION_FAILED",
      `footage could not be collected: ${collection.missing.join(", ")}`
    );
  }

  const main = container.compositions[0];
  const packageManifest: AePackageManifest = {
    schemaVersion: AE_PACKAGE_SCHEMA_VERSION,
    id: container.id,
    name: container.name,
    version,
    publishedAt: new Date().toISOString(),
    aeProject: projectPackagedPath,
    projectDigest,
    sourceProjectDigest: container.projectDigest.toLowerCase(),
    mainComposition: { itemId: main.itemId, name: main.name, width: main.width, height: main.height },
    profile: container.profile,
    compositions: container.compositions,
    cachePolicy: container.cachePolicy,
    // Nothing rewrote the project, so the runtime must re-point footage after opening it.
    footageResolution: "runtime-relink",
    assets: collection.assets,
    thumbnail: request.thumbnail ? AE_PACKAGE_PATHS.thumbnail : undefined
  };

  const controls: AePackageControls = {
    schemaVersion: AE_PACKAGE_SCHEMA_VERSION,
    controls: container.controls,
    dataBindings: container.dataBindings
  };

  const animations: AePackageAnimations = {
    schemaVersion: AE_PACKAGE_SCHEMA_VERSION,
    actions: request.actions ?? [],
    cueMapDigest: request.cueMapDigest,
    ...(request.cueMap ? { cueMap: request.cueMap } : {})
  };

  const dependencies: AePackageDependencies = {
    schemaVersion: AE_PACKAGE_SCHEMA_VERSION,
    afterEffects: { minimumVersion: container.profile.aeVersion, renderer: container.profile.renderer },
    fonts: manifest.fonts.map((font) => ({ family: font.family, style: font.style, usedBy: font.usedBy })),
    plugins: collectThirdPartyPlugins(manifest, closure.compositionIds)
  };

  const written = new Map<string, Buffer>([
    [AE_PACKAGE_PATHS.manifest, jsonBuffer(packageManifest)],
    [AE_PACKAGE_PATHS.controls, jsonBuffer(controls)],
    [AE_PACKAGE_PATHS.animations, jsonBuffer(animations)],
    [AE_PACKAGE_PATHS.dependencies, jsonBuffer(dependencies)]
  ]);
  if (request.thumbnail) written.set(AE_PACKAGE_PATHS.thumbnail, request.thumbnail);

  await mkdir(path.join(directory, "grapix"), { recursive: true });
  for (const [relativePath, bytes] of written) {
    await writeFile(safePackagePath(directory, relativePath), bytes);
  }

  // Checksums cover every file including the project and the collected footage, so a package moved
  // to a playout machine can be proven intact rather than assumed.
  const checksums: AePackageChecksums = { algorithm: "sha256", files: {} };
  checksums.files[projectPackagedPath] = projectDigest;
  for (const asset of collection.assets) {
    if (asset.sequenceFrames?.length) continue;
    checksums.files[asset.packagedPath] = asset.checksum;
  }
  for (const [relativePath, bytes] of written) {
    checksums.files[relativePath] = createHash("sha256").update(bytes).digest("hex");
  }
  await writeFile(safePackagePath(directory, AE_PACKAGE_PATHS.checksums), jsonBuffer(checksums));

  return {
    version,
    manifest: packageManifest,
    validation,
    collection,
    fileCount: Object.keys(checksums.files).length + 1,
    totalBytes: collection.totalBytes + projectBytes.byteLength
  };
}

/** Every distinct third-party effect the project draws through. */
function collectThirdPartyPlugins(
  manifest: AeManifest,
  compositionIds: ReadonlySet<string>
): AePackageDependencies["plugins"] {
  const plugins = new Map<string, { name: string; matchName: string; required: boolean }>();
  for (const composition of manifest.compositions) {
    // A plugin used only by a composition this package does not ship is not a dependency of it.
    if (!compositionIds.has(String(composition.id))) continue;
    for (const layer of composition.layers) {
      for (const effect of layer.effects ?? []) {
        if (!effect.matchName || !isThirdPartyEffect(effect.matchName)) continue;
        const existing = plugins.get(effect.matchName);
        // Required when any layer draws through it: a disabled instance alone does not make the
        // plugin necessary, but one enabled instance does.
        const required = (existing?.required ?? false) || effect.enabled;
        plugins.set(effect.matchName, { name: effect.name, matchName: effect.matchName, required });
      }
    }
  }
  return [...plugins.values()];
}

function jsonBuffer(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

function sanitizeFileName(value: string): string {
  const cleaned = value.replace(/[\\/]/g, "_").replace(/\.{2,}/g, ".").replace(/^\.+/, "").trim();
  return cleaned || "project.aep";
}
