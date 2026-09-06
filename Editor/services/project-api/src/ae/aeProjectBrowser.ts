/**
 * Browse an After Effects project without opening After Effects.
 *
 * This is what the Editor's connector panel reads: the projects an author may publish, the
 * compositions inside one, and the layers inside a composition. It is the design-time half of the
 * AE integration, and it is deliberately built on the binary parser rather than the live adapter —
 * an author choosing which composition to publish should not need a licensed After Effects running,
 * and the adapter is gated behind a licensing decision the browser has no part in.
 *
 * ## Why the results are cached
 *
 * A real project is large: the reference project here is 68.9 MB and takes ~650 ms to parse. A
 * panel that re-parsed on every click — pick a project, filter 280 compositions, open one, open
 * another — would spend seconds of every interaction re-reading bytes that have not changed. The
 * cache is keyed on the project's identity *and* its mtime and size, so a designer who saves in
 * After Effects gets the new structure on the next read rather than a stale tree that no longer
 * matches their file.
 *
 * ## Why compositions and layers are separate reads
 *
 * Returning 280 compositions with every layer expanded is megabytes of JSON for a panel that shows
 * one composition at a time. The summary carries what a picker needs to rank and filter; layers are
 * fetched for the one composition an author actually opens.
 */
import { aeCompositionToScene, parseAepToManifest, type AeSceneImportWarning } from "@grapix/adobe-common-schema";
import { AePackageError } from "@grapix/ae-runtime-contract";
import type { AeComposition, AeLayer, AeManifest, SceneDocument } from "@grapix/shared-types";
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { configuredAeProjectRoots, resolveExistingAeProjectUri } from "../storage.js";
import { currentProject } from "../projectWorkspace.js";
import { collectCompositionFootage, type ResolvedFootage } from "./aeImportFootage.js";
import { resolveCompositionClosure } from "./aePackageBuilder.js";

export interface AeProjectSummary {
  /** Root-relative POSIX path, the same form `resolveAeProjectUri` accepts. */
  projectUri: string;
  name: string;
  sizeBytes: number;
  modifiedAt: string;
}

export interface AeCompositionSummary {
  id: string;
  name: string;
  width: number;
  height: number;
  /** Frames per second as the project records it; the exact clock is decided when a container is declared. */
  frameRate: number;
  durationSeconds: number;
  layerCount: number;
  /** Layers that carry text, so a picker can show which compositions have something to drive. */
  textLayerCount: number;
  /** Distinct footage items this composition draws, through its whole precomp tree. */
  assetCount: number;
  /** Footage in that closure which does not resolve on this machine. */
  missingAssetCount: number;
  /** True when nothing in the project uses this composition as a precomp — a render candidate, not a fragment. */
  isTopLevel: boolean;
  /** How many layers across every composition draw this one as a precomp; 0 for a top-level composition. */
  nestedUseCount: number;
  /** `GRAPIX:` markers on the composition — the broadcast cue points (IN, HOLD, OUT, ...). */
  cueMarkers: AeCueMarkerSummary[];
  /** Author-declared intent: the composition is named with the `GX_` prefix. */
  grapixMarked: boolean;
}

export interface AeProjectInspection {
  projectUri: string;
  projectName: string;
  /** Lowercase SHA-256 of the project bytes — the identity a container is declared against. */
  projectDigest: string;
  compositions: AeCompositionSummary[];
  fonts: { family: string; style?: string; usedBy: string[] }[];
  warnings: string[];
  assetCount: number;
  parsedInMs: number;
}

/** One keyframe on an animatable property, trimmed to what an author inspects. */
export interface AeKeyframeSummary {
  /** Seconds within the layer. */
  time: number;
  value: number | number[] | string | boolean;
  interpolation: "linear" | "bezier" | "hold";
}

/** One animatable property's keyframes — the animation an author is choosing to keep or override. */
export interface AePropertyStreamSummary {
  /** AE stream name: anchorPoint, position, scale, rotation, opacity, ... */
  property: string;
  /** The AE match name a control targets, when this stream maps to one GrapiX can drive. */
  matchName?: string;
  keyframes: AeKeyframeSummary[];
  /** True when the stream is expression-driven; its keyframes are a sample, not the source. */
  expression?: boolean;
}

/** One `GRAPIX:` cue marker on a composition or layer — a broadcast action point. */
export interface AeCueMarkerSummary {
  /** The marker text, e.g. `GRAPIX:IN` or `GRAPIX:CONTINUE:replay`. */
  text: string;
  /** Seconds within the composition. */
  time: number;
}

/** One layer, trimmed to what a property picker needs. */
export interface AeLayerSummary {
  index: number;
  name: string;
  type: AeLayer["type"];
  enabled: boolean;
  /** The precomp or footage item this layer draws, when it has one. */
  sourceItemId?: string;
  /** Present for text layers: the current string, which is what an author exposes. */
  text?: string;
  /** Effects on the layer, so a third-party dependency is visible before publish. */
  effects: { name: string; matchName: string; enabled: boolean; thirdParty: boolean }[];
  /** Properties GrapiX can expose as a control today. */
  exposable: { label: string; kind: string; matchName: string }[];
  /** The animation this layer carries — present only for properties that actually move. */
  streams: AePropertyStreamSummary[];
  /** `GRAPIX:` markers on the layer, so cue points are visible beside the layers they time. */
  markers: AeCueMarkerSummary[];
}

const MAX_PROJECT_BYTES = 512 * 1024 * 1024;
const CACHE_LIMIT = 4;

/**
 * The prefix a designer puts on a composition's name to say "this one is for GrapiX".
 *
 * A name prefix rather than a marker because the cue-map parser rejects any `GRAPIX:` value it does
 * not know — a selection marker would have to change that contract, while a name needs nothing new.
 */
export const GRAPIX_COMPOSITION_PREFIX = "GX_";

/**
 * How often each composition appears as a precomp source, across every layer in the project.
 *
 * The strongest available signal for "this is a fragment, not a deliverable": a composition that
 * nothing nests is a render candidate. Counted rather than boolean so the picker can show the
 * difference between a comp used once and one woven through forty others.
 */
function nestedUseCounts(manifest: AeManifest): Map<string, number> {
  const counts = new Map<string, number>();
  for (const composition of manifest.compositions) {
    for (const layer of composition.layers) {
      if (layer.sourceItemId === undefined || layer.sourceItemId === null) continue;
      const id = String(layer.sourceItemId);
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  return counts;
}

interface CacheEntry {
  key: string;
  manifest: AeManifest;
  digest: string;
  parsedInMs: number;
}

/**
 * Parsed projects, most recent last.
 *
 * Bounded to a handful because each entry holds a whole parsed project — the reference one expands
 * to hundreds of compositions — and an unbounded cache in a long-running service is a slow leak
 * rather than an optimisation.
 */
const cache: CacheEntry[] = [];

/** Every `.aep` under the allowlisted roots. */
export async function listAeProjects(): Promise<AeProjectSummary[]> {
  const roots = configuredAeProjectRoots();
  if (roots.length === 0) {
    throw new AePackageError(
      "PACKAGE_ROOT_NOT_CONFIGURED",
      "no After Effects project has been chosen yet: add one by its .aep path, or set GRAPIX_AE_PROJECT_ROOTS for a facility-wide root"
    );
  }

  const found: AeProjectSummary[] = [];
  for (const root of roots) await collectProjects(root, root, found, 0);
  return found.sort((left, right) => left.name.localeCompare(right.name));
}

async function collectProjects(root: string, directory: string, into: AeProjectSummary[], depth: number): Promise<void> {
  // Bounded: a project root pointed at a whole drive would otherwise walk it. Six levels covers a
  // Collect Files tree without turning a mistyped root into a filesystem scan.
  if (depth > 6) return;
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      // After Effects' own auto-save folder holds copies that are not the authoritative project.
      if (entry.name === "Adobe After Effects Auto-Save" || entry.name.startsWith(".")) continue;
      await collectProjects(root, full, into, depth + 1);
      continue;
    }
    if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== ".aep") continue;
    const info = await stat(full);
    into.push({
      projectUri: path.relative(root, full).split(path.sep).join("/"),
      name: entry.name,
      sizeBytes: info.size,
      modifiedAt: info.mtime.toISOString()
    });
  }
}

/** Parse a project, reusing the last parse when the file has not changed. */
async function loadManifest(projectUri: string): Promise<CacheEntry & { projectPath: string }> {
  const { projectPath } = await resolveExistingAeProjectUri(projectUri);
  const info = await stat(projectPath);
  if (info.size > MAX_PROJECT_BYTES) {
    throw new AePackageError("VALIDATION_FAILED", `project ${projectUri} is larger than the ${MAX_PROJECT_BYTES} byte limit`);
  }

  // Identity plus mtime and size: a designer who saves in After Effects must not keep seeing the
  // structure the panel read before the save.
  const key = `${projectPath}|${info.mtimeMs}|${info.size}`;
  const hit = cache.find((entry) => entry.key === key);
  if (hit) return { ...hit, projectPath };

  const bytes = await readFile(projectPath);
  const startedAt = performance.now();
  let manifest: AeManifest;
  try {
    manifest = parseAepToManifest(bytes, path.basename(projectPath, ".aep"), projectPath);
  } catch (error) {
    throw new AePackageError(
      "VALIDATION_FAILED",
      `${projectUri} could not be read as an After Effects project: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const entry: CacheEntry = {
    key,
    manifest,
    digest: createHash("sha256").update(bytes).digest("hex"),
    parsedInMs: Math.round(performance.now() - startedAt)
  };

  cache.push(entry);
  while (cache.length > CACHE_LIMIT) cache.shift();
  return { ...entry, projectPath };
}

/** The project's compositions, summarised for a picker. */
export async function inspectAeProject(projectUri: string): Promise<AeProjectInspection> {
  const { manifest, digest, parsedInMs } = await loadManifest(projectUri);
  const compositionIds = new Set(manifest.compositions.map((composition) => String(composition.id)));
  const nestedUse = nestedUseCounts(manifest);

  const compositions = manifest.compositions.map((composition) => {
    const id = String(composition.id);
    const closure = resolveCompositionClosure(manifest, [id]);
    const usedAsPrecomp = nestedUse.get(id) ?? 0;
    return {
      id,
      name: composition.name,
      width: composition.width,
      height: composition.height,
      frameRate: composition.frameRate,
      durationSeconds: composition.duration,
      layerCount: composition.layers.length,
      textLayerCount: composition.layers.filter((layer) => layer.type === "text").length,
      assetCount: closure.assetIds.size,
      // Counted here rather than left for publish validation, so the picker can show which
      // compositions are publishable before an author invests in declaring controls for one.
      missingAssetCount: countMissingAssets(manifest, closure.assetIds, compositionIds),
      isTopLevel: usedAsPrecomp === 0,
      nestedUseCount: usedAsPrecomp,
      cueMarkers: cueMarkersOf(composition.markers),
      grapixMarked: composition.name.startsWith(GRAPIX_COMPOSITION_PREFIX)
    } satisfies AeCompositionSummary;
  });

  return {
    projectUri,
    projectName: manifest.projectName,
    projectDigest: digest,
    compositions,
    fonts: manifest.fonts,
    warnings: manifest.warnings,
    assetCount: manifest.assets.length,
    parsedInMs
  };
}

/**
 * Footage in a closure that the project itself reports as missing.
 *
 * Deliberately *not* a filesystem check: this runs for all 280 compositions on every inspection,
 * and statting every asset of every composition would make opening the picker cost thousands of
 * syscalls. Publish validation does the real resolution for the one composition being published.
 */
function countMissingAssets(
  manifest: AeManifest,
  assetIds: ReadonlySet<string>,
  compositionIds: ReadonlySet<string>
): number {
  let missing = 0;
  for (const asset of manifest.assets) {
    if (!assetIds.has(String(asset.id))) continue;
    if (compositionIds.has(String(asset.id))) continue;
    if (asset.kind === "footage" && asset.missing) missing += 1;
  }
  return missing;
}

/** One composition's layers, with the properties that can become controls. */
export async function readAeComposition(
  projectUri: string,
  compositionId: string
): Promise<{ composition: AeCompositionSummary; layers: AeLayerSummary[] }> {
  const { manifest } = await loadManifest(projectUri);
  const composition = manifest.compositions.find((entry) => String(entry.id) === String(compositionId));
  if (!composition) {
    throw new AePackageError("VALIDATION_FAILED", `composition ${compositionId} is not in ${projectUri}`);
  }

  const closure = resolveCompositionClosure(manifest, [String(composition.id)]);
  const compositionIds = new Set(manifest.compositions.map((entry) => String(entry.id)));
  const usedAsPrecomp = nestedUseCounts(manifest).get(String(composition.id)) ?? 0;

  return {
    composition: {
      id: String(composition.id),
      name: composition.name,
      width: composition.width,
      height: composition.height,
      frameRate: composition.frameRate,
      durationSeconds: composition.duration,
      layerCount: composition.layers.length,
      textLayerCount: composition.layers.filter((layer) => layer.type === "text").length,
      assetCount: closure.assetIds.size,
      missingAssetCount: countMissingAssets(manifest, closure.assetIds, compositionIds),
      isTopLevel: usedAsPrecomp === 0,
      nestedUseCount: usedAsPrecomp,
      cueMarkers: cueMarkersOf(composition.markers),
      grapixMarked: composition.name.startsWith(GRAPIX_COMPOSITION_PREFIX)
    },
    layers: composition.layers.map((layer) => summariseLayer(layer))
  };
}

/**
 * Materialize one composition as a new, editable GrapiX scene.
 *
 * This is the design-time import: the author picks a composition and it becomes a native scene —
 * layers become objects in the Object Manager, keyframed transform properties become timeline
 * channels. The returned scene is not persisted; the route that calls this saves it through the
 * ordinary scene path so it gets a revision, a backup and an asset-reference reindex like any
 * other authored scene. Kept separate from the runtime container publish, which is the other way
 * a composition leaves the Editor and which never touches the Object Manager.
 */
export async function importAeCompositionAsScene(
  projectUri: string,
  compositionId: string,
  options?: {
    importId?: string;
    sceneId?: string;
    sceneName?: string;
  }
): Promise<{
  scene: SceneDocument;
  warnings: AeSceneImportWarning[];
  convertedLayers: number;
  importId: string;
  pathByAssetId: Map<string, ResolvedFootage>;
}> {
  const { manifest } = await loadManifest(projectUri);
  const composition = manifest.compositions.find((entry) => String(entry.id) === String(compositionId));
  if (!composition) {
    throw new AePackageError("VALIDATION_FAILED", `composition ${compositionId} is not in ${projectUri}`);
  }

  const importId = options?.importId ?? `import_${composition.id}_${Date.now().toString(36)}`;
  /*
   * An import needs a project, because the footage has to land somewhere.
   *
   * This used to skip collection when no project was open and swallow any failure, which produced
   * the worst possible outcome: a scene that imported "successfully" with 326 objects, every image
   * carrying an empty `src`, and a viewport full of missing-texture placeholders. Refusing here is
   * what lets the Editor ask for a project location and then import for real.
   */
  const project = await currentProject();
  if (!project.root) {
    throw new AePackageError(
      "NO_PROJECT_OPEN",
      "save this as a project first: an import copies its footage into the project's Assets/AEP folder, and there is no project open yet"
    );
  }
  const collection = await collectCompositionFootage(manifest, compositionId, importId);
  const pathByAssetId = collection.pathByAssetId;

  const converted = aeCompositionToScene(composition, {
    importId,
    sceneId: options?.sceneId,
    sceneName: options?.sceneName,
    pathByAssetId,
    manifest
  });

  return { ...converted, importId, pathByAssetId };
}

/**
 * The AE stream name a property arrives under → the match name a control targets.
 *
 * The parser reports a friendly stream name (`position`); a control targets an AE match name
 * (`ADBE Position`). A stream with no entry here is one GrapiX cannot drive — it is still shown to
 * the author (its animation is real), just without a control target. Fixed and known, so a record
 * rather than a map.
 */
const MATCH_NAME_BY_STREAM: Record<string, string> = {
  anchorPoint: "ADBE Anchor Point",
  position: "ADBE Position",
  scale: "ADBE Scale",
  rotation: "ADBE Rotate Z",
  opacity: "ADBE Opacity",
  rotateX: "ADBE Rotate X",
  rotateY: "ADBE Rotate Y"
};

/** The `GRAPIX:` markers on a marker list, in time order — the broadcast cue points. */
function cueMarkersOf(markers: AeComposition["markers"]): AeCueMarkerSummary[] {
  return markers
    .filter((marker) => marker.comment?.startsWith("GRAPIX:"))
    .map((marker) => ({ text: marker.comment as string, time: marker.time }))
    .sort((left, right) => left.time - right.time);
}

function summariseLayer(layer: AeComposition["layers"][number]): AeLayerSummary {
  return {
    index: layer.index,
    name: layer.name,
    type: layer.type,
    enabled: layer.visible,
    sourceItemId: layer.sourceItemId,
    text: layer.text?.content,
    effects: (layer.effects ?? []).map((effect) => ({
      name: effect.name,
      matchName: effect.matchName,
      enabled: effect.enabled,
      thirdParty: Boolean(effect.matchName) && !effect.matchName.startsWith("ADBE ")
    })),
    exposable: exposableProperties(layer),
    // Only streams that carry keyframes are surfaced: a static property has no stream at all, so
    // every entry here is real motion an author is choosing to keep or override.
    streams: (layer.streams ?? []).map((stream) => ({
      property: stream.property,
      ...(MATCH_NAME_BY_STREAM[stream.property] ? { matchName: MATCH_NAME_BY_STREAM[stream.property] } : {}),
      keyframes: stream.keyframes.map((key) => ({
        time: key.time,
        value: key.value,
        interpolation: key.interpolation
      })),
      ...(stream.expression !== undefined ? { expression: true } : {})
    })),
    markers: cueMarkersOf(layer.markers)
  };
}

/**
 * The properties GrapiX can drive today, per layer type.
 *
 * Deliberately short. Every entry here becomes an `AeDynamicControl` whose target the runtime has
 * to resolve by match name, so offering a property the adapter cannot write would produce a control
 * that validates at authoring time and refuses on air. Text and the transform channels are what the
 * protocol's `SET_PROPERTY` is proven against; the list grows when the adapter's coverage does.
 */
function exposableProperties(layer: AeComposition["layers"][number]): AeLayerSummary["exposable"] {
  const exposable: AeLayerSummary["exposable"] = [];
  if (layer.type === "text") {
    exposable.push({ label: "Source Text", kind: "text", matchName: "ADBE Text Document" });
  }
  exposable.push(
    { label: "Position", kind: "point2d", matchName: "ADBE Position" },
    { label: "Scale", kind: "point2d", matchName: "ADBE Scale" },
    { label: "Rotation", kind: "number", matchName: "ADBE Rotate Z" },
    { label: "Opacity", kind: "number", matchName: "ADBE Opacity" }
  );
  return exposable;
}
