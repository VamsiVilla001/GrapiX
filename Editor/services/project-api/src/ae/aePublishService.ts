/**
 * Publish one runtime container as a package, from its id alone.
 *
 * The builder is deliberately pure — it takes a container, a manifest and two directories, so it
 * can be tested against temporary folders with no service running. This module is the part that
 * knows where things live: it resolves the container, reads the authoritative `.aep`, parses it
 * into the manifest the builder needs, and decides the graphic's package root.
 *
 * Keeping the two apart is what lets the publish rules be tested exhaustively without a filesystem
 * layout, and the layout be changed without retesting the rules.
 */
import { parseAepToManifest } from "@grapix/adobe-common-schema";
import { AePackageError, type AePackageAnimationAction, type AePublishValidation } from "@grapix/ae-runtime-contract";
import type { AeManifest } from "@grapix/shared-types";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { deriveAeAnimation } from "./aeAnimationDerivation.js";
import { projectDataRoot, readAeRuntimeContainer, resolveExistingAeProjectUri } from "../storage.js";
import {
  buildAePackage,
  listAePackageVersions,
  validateAePublish,
  type AePublishRequest,
  type BuiltAePackage
} from "./aePackageBuilder.js";

/**
 * Where a graphic's published versions live.
 *
 * Under the data root beside every other durable artefact (`data/packages/…`), not beside the
 * designer's `.aep`. Publishing must not write into an allowlisted project root: those roots are
 * read as authoritative input, and a publisher that writes into them turns the source of truth
 * into somewhere GrapiX also puts its output.
 */
export function aeGraphicRoot(graphicId: string): string {
  const safe = graphicId.replace(/[^a-zA-Z0-9_-]/g, "");
  if (!safe) throw new AePackageError("PACKAGE_WRITE_FAILED", `graphic id ${graphicId} has no usable characters`);
  return path.join(projectDataRoot(), "packages", "ae", safe);
}

export interface AePublishOptions {
  containerId: string;
  actions?: AePackageAnimationAction[];
  cueMapDigest?: string;
  thumbnail?: Buffer;
  collectedFootageDir?: string;
  signal?: AbortSignal;
}

/**
 * Assemble everything a publish needs from a container id.
 *
 * The manifest is parsed from the project bytes on every call rather than cached: a cached
 * structure is a structure that can disagree with the file being published, and the digest check
 * in validation would then be comparing the right bytes against the wrong description.
 */
export async function loadAePublishRequest(options: AePublishOptions): Promise<AePublishRequest> {
  const container = await readAeRuntimeContainer(options.containerId);
  if (!container) {
    throw new AePackageError("CONTAINER_NOT_FOUND", `runtime container ${options.containerId} was not found`);
  }

  const { projectPath } = await resolveExistingAeProjectUri(container.projectUri);
  const manifest = await parseProjectManifest(projectPath, container.name);

  // The animation is derived here, at the one place that holds the parsed project, the container's
  // declared clock and the markers together. Caller-supplied actions still win: an author who passed
  // them explicitly has already resolved the map themselves. A composition with no markers derives
  // to nothing, which the builder reports as the NO_ANIMATION_ACTIONS warning rather than a guess.
  let actions = options.actions;
  let cueMapDigest = options.cueMapDigest;
  let cueMap: AePublishRequest["cueMap"];
  if (actions === undefined) {
    const composition = manifest.compositions.find(
      (entry) => Number(entry.id) === container.compositions[0]?.itemId
    );
    const declared = container.compositions[0];
    if (composition && declared) {
      const derived = deriveAeAnimation(composition, container.profile.frameRate, declared.clock);
      actions = derived.actions;
      if (derived.cueMap) {
        cueMapDigest = derived.cueMap.cueMapDigest;
        cueMap = {
          compositionItemId: declared.itemId,
          markers: derived.cueMap.markers,
          rate: derived.cueMap.rate,
          clock: derived.cueMap.clock
        };
      }
    }
  }

  return {
    container,
    manifest,
    projectPath,
    graphicRoot: aeGraphicRoot(container.id),
    actions,
    cueMapDigest,
    cueMap,
    thumbnail: options.thumbnail,
    collectedFootageDir: options.collectedFootageDir,
    signal: options.signal
  };
}

/**
 * Read and parse the authoritative project.
 *
 * A project that cannot be read is not a parse failure, and saying so matters: "the file is not
 * there" and "the file is not a project" have different remedies, and validation refuses the first
 * by name.
 */
async function parseProjectManifest(projectPath: string, projectName: string): Promise<AeManifest> {
  let bytes: Buffer;
  try {
    bytes = await readFile(projectPath);
  } catch {
    // Left for validation to refuse as PROJECT_NOT_FOUND, with the path named.
    return emptyManifest(projectName, projectPath);
  }
  try {
    return parseAepToManifest(bytes, projectName, projectPath);
  } catch (error) {
    throw new AePackageError(
      "VALIDATION_FAILED",
      `the project at ${projectPath} could not be read as an After Effects project: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function emptyManifest(projectName: string, sourceFile: string): AeManifest {
  return {
    formatVersion: 1,
    producer: "aep-native",
    projectName,
    sourceFile,
    frameRate: 0,
    compositions: [],
    assets: [],
    fonts: [],
    warnings: []
  };
}

/** Validate without writing anything. */
export async function validateAeContainerPublish(options: AePublishOptions): Promise<AePublishValidation> {
  return validateAePublish(await loadAePublishRequest(options));
}

/** Validate, collect and write the next immutable version. */
export async function publishAeContainer(options: AePublishOptions): Promise<BuiltAePackage> {
  return buildAePackage(await loadAePublishRequest(options));
}

/** The versions already published for a graphic, ascending. */
export async function listAeGraphicVersions(graphicId: string): Promise<number[]> {
  return listAePackageVersions(aeGraphicRoot(graphicId));
}
