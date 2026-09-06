import type {
  DesignImportOptions,
  DesignImportResult,
  FigmaDesignImportSource,
  FigmaMotionImportMode,
  FontDefinition,
  GrapixTriggerEvent,
  SceneDocument,
  ScenePackagePreflight,
  SceneScriptPermission,
  SceneScriptReference,
  ProjectAssetReference,
  SceneTimeline
} from "@grapix/shared-types";
import type {
  AeDynamicControl,
  AePackageAnimationAction,
  AePublishValidation,
  AeRuntimeContainer,
  CreateAeRuntimeContainerRequest,
  UpdateAeRuntimeContainerRequest
} from "@grapix/ae-runtime-contract";
import { projectAssetContentPath } from "@grapix/shared-types";

/**
 * The project service.
 *
 * Exported because scene asset paths resolve against the service that owns them, and configurable
 * for the same reason Playout's is: a second copy of the editor pointed at a second project service
 * is how the two are compared, and a hardcoded port makes that impossible. The default is the port
 * the desktop shell launches.
 */
// `import.meta.env` exists under Vite and nowhere else, so the tests — which import this module
// through plain Node — read `undefined` rather than crashing on a missing object.
import { currentAccessToken, invalidateSession } from "./auth";

export const apiBaseUrl = import.meta.env?.VITE_GRAPIX_API_URL ?? "http://127.0.0.1:4100";

/** Severity, as the author reads it. Same shape as Playout's console. */
export type DiagnosticLevel = "error" | "warning" | "info";

/**
 * The structured half of a failure, as the project service records it.
 *
 * Same shape as Playout's `PlayoutDiagnosticDetail`: the author console and the operator
 * console are read by the same people during a show, so a failure means the same thing on
 * both sides of the publish.
 */
export interface EditorDiagnosticDetail {
  code: string;
  summary: string;
  cause?: string;
  remedy?: string;
  context?: Record<string, unknown>;
  causeChain?: string[];
  stack?: string;
}

export interface DiagnosticRecord {
  sequence: number;
  at: string;
  level: DiagnosticLevel;
  source: string;
  message: string;
  detail?: EditorDiagnosticDetail;
}

export interface DiagnosticsPage {
  records: DiagnosticRecord[];
  latestSequence: number;
  capacity: number;
}

export async function listDiagnosticsFromApi(since?: number): Promise<DiagnosticsPage> {
  const query = since !== undefined && since > 0 ? `?since=${since}` : "";
  const response = await request<{ ok: true } & DiagnosticsPage>(`/api/diagnostics${query}`);
  return { records: response.records, latestSequence: response.latestSequence, capacity: response.capacity };
}

export async function clearDiagnosticsOnApi(): Promise<{ cleared: number; latestSequence: number }> {
  const response = await request<{ ok: true; cleared: number; latestSequence: number }>("/api/diagnostics", {
    method: "DELETE"
  });
  return { cleared: response.cleared, latestSequence: response.latestSequence };
}

/** Live notifications for an open console. Callers still fetch the records; the event is the nudge. */
export function subscribeToDiagnostics(listener: (event: { sequence: number; level: DiagnosticLevel }) => void): () => void {
  const source = new EventSource(`${apiBaseUrl}/api/diagnostics/events`);
  source.addEventListener("diagnostics.logged", (event) => {
    try {
      listener(JSON.parse((event as MessageEvent).data) as { sequence: number; level: DiagnosticLevel });
    } catch {
      // A malformed event is a nudge lost, not a record lost: the next fetch reconciles.
    }
  });
  return () => source.close();
}

export interface ApiHealth {
  ok: boolean;
  service: string;
  time: string;
  showMode?: "edit" | "read-only";
  authenticationRequired?: boolean;
}

export interface ApiSceneSummary {
  id: string;
  name: string;
  updatedAt: string;
  objectCount: number;
  assetCount: number;
  materialCount: number;
  revision: number;
}

export interface ApiPackageSummary {
  sceneId: string;
  fileName: string;
  path: string;
  sizeBytes: number;
  createdAt: string;
}

export interface ApiImportedAsset {
  assetId: string;
  fileName: string;
  relativePath: string;
  mimeType: string;
  sizeBytes: number;
  checksum: string;
  importedAt: string;
  duplicate: boolean;
  contentUrl: string;
}

export interface ApiImportedFont {
  asset: ApiImportedAsset & { kind: "font" };
  font: FontDefinition;
}

export async function importFontFileToApi(
  file: File,
  options: {
    family?: string;
    displayName?: string;
    weight?: number;
    style?: "normal" | "italic" | "oblique";
    license?: string;
  }
): Promise<ApiImportedFont> {
  const query = new URLSearchParams({
    fileName: file.name,
  });
  if (options.family) query.set("family", options.family);
  if (options.weight) query.set("weight", String(options.weight));
  if (options.style) query.set("style", options.style);
  if (options.displayName) query.set("displayName", options.displayName);
  if (options.license) query.set("license", options.license);
  const response = await request<{ ok: true; asset: ApiImportedFont["asset"]; font: FontDefinition }>(
    `/api/fonts/import?${query}`,
    {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: file
    }
  );
  return {
    asset: {
      ...response.asset,
      contentUrl: `${apiBaseUrl}${response.asset.contentUrl}`
    },
    font: response.font
  };
}

export async function linkFontOnApi(options: {
  source: "css-url" | "adobe-fonts";
  family: string;
  url?: string;
  projectId?: string;
  weight?: number;
  style?: "normal" | "italic" | "oblique";
  fallbackFamilies?: string[];
  license?: string;
}): Promise<FontDefinition> {
  const response = await request<{ ok: true; font: FontDefinition }>("/api/fonts/link", {
    method: "POST",
    body: JSON.stringify(options)
  });
  return response.font;
}

export interface ApiResolvedFonts {
  fonts: FontDefinition[];
  assets: Array<ApiImportedAsset & { kind: "font" }>;
  warnings: string[];
}

export async function resolveRemoteFontsOnApi(options: {
  source: "css-url" | "adobe-fonts" | "direct-url";
  url?: string;
  projectId?: string;
  family?: string;
  displayName?: string;
  license?: string;
}): Promise<ApiResolvedFonts> {
  const response = await request<{ ok: true } & ApiResolvedFonts>("/api/fonts/resolve", {
    method: "POST",
    body: JSON.stringify(options)
  });
  return {
    ...response,
    assets: response.assets.map((asset) => ({
      ...asset,
      contentUrl: `${apiBaseUrl}${asset.contentUrl}`
    }))
  };
}

export async function importSceneScriptToApi(
  file: File,
  permissions: SceneScriptPermission[]
): Promise<{ asset: ApiImportedAsset & { kind: "script" }; script: SceneScriptReference }> {
  const query = new URLSearchParams({
    fileName: file.name,
    permissions: permissions.join(",")
  });
  const response = await request<{
    ok: true;
    asset: ApiImportedAsset & { kind: "script" };
    script: SceneScriptReference;
  }>(`/api/import/scene-script?${query}`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: file
  });
  return {
    asset: {
      ...response.asset,
      contentUrl: `${apiBaseUrl}${response.asset.contentUrl}`
    },
    script: response.script
  };
}

export async function importAssetFileToApi(file: File, replaceAssetId?: string): Promise<ApiImportedAsset> {
  const query = new URLSearchParams({
    fileName: file.name,
    mimeType: file.type || "application/octet-stream"
  });
  if (replaceAssetId) query.set("replaceAssetId", replaceAssetId);

  const response = await request<{ ok: true; asset: ApiImportedAsset }>(`/api/assets/import?${query}`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: file
  });
  return {
    ...response.asset,
    contentUrl: `${apiBaseUrl}${response.asset.contentUrl}`
  };
}

export async function importDesignFileToApi(
  file: File,
  options: Partial<DesignImportOptions>,
  /**
   * Motion mode only, never a manifest: this request's body is the design's bytes.
   *
   * An exported Figma document carries its own prototype data, so `design-and-prototype-motion`
   * is fully served here. A bridge manifest goes through `importFigmaDesignToApi`, whose body is
   * JSON and has room for it.
   */
  motion: { motionMode?: FigmaMotionImportMode } = {}
): Promise<DesignImportResult> {
  const query = new URLSearchParams({
    fileName: file.name,
    options: JSON.stringify(options)
  });
  if (motion.motionMode && motion.motionMode !== "design-only") query.set("motionMode", motion.motionMode);
  const response = await request<{ ok: true; result: DesignImportResult }>(
    `/api/import/design-file?${query}`,
    {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: file
    }
  );
  return response.result;
}

export async function importFigmaDesignToApi(
  source: FigmaDesignImportSource,
  options: Partial<DesignImportOptions>
): Promise<DesignImportResult> {
  const response = await request<{ ok: true; result: DesignImportResult }>("/api/import/figma", {
    method: "POST",
    body: JSON.stringify({ source, options })
  });
  return response.result;
}

export async function importModelFileToApi(file: File): Promise<{
  asset: ApiImportedAsset;
  materialNames: string[];
}> {
  const query = new URLSearchParams({
    fileName: file.name,
    profile: "EDITOR_PREVIEW"
  });
  const response = await request<{
    ok: true;
    asset: ApiImportedAsset & { kind: "model" };
    report: { materialNames: string[] };
  }>(
    `/api/import/model?${query}`,
    {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: file
    }
  );
  return {
    asset: {
      ...response.asset,
      contentUrl: `${apiBaseUrl}${response.asset.contentUrl}`
    },
    materialNames: response.report.materialNames
  };
}

export async function assetExistsOnApi(assetId: string): Promise<boolean> {
  try {
    const response = await fetch(`${apiBaseUrl}/api/assets/${encodeURIComponent(assetId)}/content`, {
      method: "HEAD"
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function getApiHealth(): Promise<ApiHealth> {
  return request<ApiHealth>("/health");
}

export async function saveSceneToApi(scene: SceneDocument): Promise<ApiSceneSummary> {
  const response = await request<{ ok: boolean; scene: ApiSceneSummary }>("/api/scenes", {
    method: "POST",
    body: JSON.stringify(scene)
  });

  return response.scene;
}

export async function listScenesFromApi(): Promise<ApiSceneSummary[]> {
  const response = await request<{ scenes: ApiSceneSummary[] }>("/api/scenes");

  return response.scenes;
}

/** One slot in a scene's autosave ring, as reported by the project service. */
export interface ApiAutosaveEntry {
  version: number;
  fileName: string;
  sceneName: string;
  revision: number;
  savedAt: string;
  sizeBytes: number;
}

/**
 * Take an autosave snapshot of the in-memory scene.
 *
 * Sends the document rather than a scene id because the point is to capture work that has
 * *not* been saved. The service writes it beside the scene, never over it.
 */
export async function autosaveSceneOnApi(
  scene: SceneDocument,
  maxVersions: number
): Promise<ApiAutosaveEntry> {
  const response = await request<{ ok: boolean; autosave: ApiAutosaveEntry }>(
    `/api/scenes/${encodeURIComponent(scene.id)}/autosave`,
    { method: "POST", body: JSON.stringify({ scene, maxVersions }) }
  );

  return response.autosave;
}

/**
 * A scene's snapshots, with the revision the service currently holds for that scene.
 *
 * `sceneRevision` comes from the service rather than the open document because only the
 * service increments it: the client posts a scene and never reads the new revision back, so
 * anything comparing snapshots against `scene.revision` compares against the value the
 * document was loaded with — or against 0 for a scene that was never opened from disk.
 */
export async function listSceneAutosavesFromApi(
  sceneId: string
): Promise<{ autosaves: ApiAutosaveEntry[]; sceneRevision: number }> {
  const response = await request<{ autosaves: ApiAutosaveEntry[]; sceneRevision?: number }>(
    `/api/scenes/${encodeURIComponent(sceneId)}/autosaves`
  );

  return { autosaves: response.autosaves, sceneRevision: response.sceneRevision ?? 0 };
}

/** Read a snapshot without restoring it, so the caller can compare before committing. */
export async function readSceneAutosaveFromApi(
  sceneId: string,
  version: number
): Promise<SceneDocument> {
  const response = await request<{ ok: boolean; scene: SceneDocument }>(
    `/api/scenes/${encodeURIComponent(sceneId)}/autosaves/${version}`
  );

  return response.scene;
}

/**
 * Reads one stored scene document back.
 *
 * The Editor had no caller for this route for as long as the route existed, which
 * made the application write-only with respect to the project service: it saved
 * scenes and could never load one. Anything authored outside a running window — by
 * the MCP server, another agent, or a previous session — was invisible, not because
 * of a cache but because no code path existed. `File > Open Scene…` is that path.
 */
export async function readSceneFromApi(sceneId: string): Promise<SceneDocument> {
  const response = await request<{ ok: boolean; scene: SceneDocument }>(
    `/api/scenes/${encodeURIComponent(sceneId)}`
  );

  return response.scene;
}

/**
 * Scene automation, evaluated and returned as a plan.
 *
 * The rundown equivalents this used to sit beside went with the Sequencer: a running order of
 * cues across scenes is an operator's document, and authoring one here made the Editor look
 * like it could put graphics to air. A scene's own triggers are authoring — they belong to the
 * document being designed — and the Editor still only evaluates them.
 */
export async function fireSceneEvent(
  sceneId: string,
  event: GrapixTriggerEvent,
  execute = false
): Promise<unknown> {
  return request(`/api/scenes/${encodeURIComponent(sceneId)}/events`, {
    method: "POST",
    body: JSON.stringify({ event, execute })
  });
}

export async function preflightSceneOnApi(scene: SceneDocument): Promise<ScenePackagePreflight> {
  const response = await request<{ ok: boolean; preflight: ScenePackagePreflight }>("/api/preflight", {
    method: "POST",
    body: JSON.stringify(scene)
  });

  return response.preflight;
}

export async function publishSceneOnApi(scene: SceneDocument): Promise<{
  preflight: ScenePackagePreflight;
  package?: ApiPackageSummary;
}> {
  const response = await fetch(`${apiBaseUrl}/api/packages`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(scene)
  });
  const data = (await response.json()) as {
    ok: boolean;
    preflight: ScenePackagePreflight;
    package?: ApiPackageSummary;
    error?: string;
  };

  if (!response.ok && !data.preflight) {
    throw new Error(data.error ?? `API request failed with ${response.status}`);
  }

  return {
    preflight: data.preflight,
    package: data.package
  };
}

export async function publishSavedSceneOnApi(sceneId: string): Promise<{
  preflight: ScenePackagePreflight;
  package?: ApiPackageSummary;
}> {
  const response = await fetch(`${apiBaseUrl}/api/scenes/${sceneId}/packages`, {
    method: "POST"
  });
  const data = (await response.json()) as {
    ok: boolean;
    preflight: ScenePackagePreflight;
    package?: ApiPackageSummary;
    error?: string;
  };

  if (!response.ok && !data.preflight) {
    throw new Error(data.error ?? `API request failed with ${response.status}`);
  }

  return {
    preflight: data.preflight,
    package: data.package
  };
}

export async function patchObjectOnApi(
  sceneId: string,
  objectId: string,
  patch: Record<string, unknown>
): Promise<SceneDocument> {
  const response = await request<{ ok: boolean; scene: SceneDocument }>(
    `/api/scenes/${sceneId}/objects/${objectId}`,
    {
      method: "PATCH",
      body: JSON.stringify(patch)
    }
  );

  return response.scene;
}

export async function patchMaterialOnApi(
  sceneId: string,
  materialId: string,
  patch: Record<string, unknown>
): Promise<SceneDocument> {
  const response = await request<{ ok: boolean; scene: SceneDocument }>(
    `/api/scenes/${sceneId}/materials/${materialId}`,
    {
      method: "PATCH",
      body: JSON.stringify(patch)
    }
  );

  return response.scene;
}

export async function patchDataContextOnApi(
  sceneId: string,
  dataContext: Record<string, unknown>
): Promise<SceneDocument> {
  const response = await request<{ ok: boolean; scene: SceneDocument }>(
    `/api/scenes/${sceneId}/data-context`,
    {
      method: "PATCH",
      body: JSON.stringify(dataContext)
    }
  );

  return response.scene;
}

export async function patchDataValueOnApi(
  sceneId: string,
  path: string,
  value: unknown,
  expectedRevision?: string
): Promise<SceneDocument> {
  const response = await request<{ ok: boolean; scene: SceneDocument }>(
    `/api/scenes/${sceneId}/data-patches`,
    {
      method: "PATCH",
      body: JSON.stringify({ path, value, expectedRevision })
    }
  );
  return response.scene;
}

export async function patchTimelineOnApi(sceneId: string, timeline: SceneTimeline): Promise<SceneDocument> {
  const response = await request<{ ok: boolean; scene: SceneDocument }>(
    `/api/scenes/${sceneId}/timeline`,
    {
      method: "PATCH",
      body: JSON.stringify(timeline)
    }
  );

  return response.scene;
}

export async function listAeRuntimeContainersFromApi(): Promise<AeRuntimeContainer[]> {
  const response = await request<{ ok: true; containers: AeRuntimeContainer[] }>("/api/ae-runtime/containers");
  return response.containers;
}

export async function updateAeRuntimeContainerOnApi(
  containerId: string,
  update: UpdateAeRuntimeContainerRequest
): Promise<AeRuntimeContainer> {
  const response = await request<{ ok: true; container: AeRuntimeContainer }>(
    `/api/ae-runtime/containers/${encodeURIComponent(containerId)}`,
    { method: "PATCH", body: JSON.stringify(update) }
  );
  return response.container;
}

/* ── The design-time connector: browse, validate and publish an After Effects project ── */

export interface AeProjectSummary {
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
  frameRate: number;
  durationSeconds: number;
  layerCount: number;
  textLayerCount: number;
  assetCount: number;
  missingAssetCount: number;
  isTopLevel: boolean;
  nestedUseCount: number;
  cueMarkers: AeCueMarkerSummary[];
  grapixMarked: boolean;
}

export interface AeKeyframeSummary {
  time: number;
  value: number | number[] | string | boolean;
  interpolation: "linear" | "bezier" | "hold";
}

export interface AePropertyStreamSummary {
  property: string;
  matchName?: string;
  keyframes: AeKeyframeSummary[];
  expression?: boolean;
}

export interface AeCueMarkerSummary {
  text: string;
  time: number;
}

export interface AeProjectInspection {
  projectUri: string;
  projectName: string;
  projectDigest: string;
  compositions: AeCompositionSummary[];
  fonts: { family: string; style?: string; usedBy: string[] }[];
  warnings: string[];
  assetCount: number;
  parsedInMs: number;
}

export interface AeLayerSummary {
  index: number;
  name: string;
  type: string;
  enabled: boolean;
  sourceItemId?: string;
  text?: string;
  effects: { name: string; matchName: string; enabled: boolean; thirdParty: boolean }[];
  exposable: { label: string; kind: string; matchName: string }[];
  streams: AePropertyStreamSummary[];
  markers: AeCueMarkerSummary[];
}

/** Choose a project by path. Registering it is what makes it readable to the connector. */
export async function registerAeProjectOnApi(projectPath: string): Promise<{ root: string; projectUri: string }> {
  return request<{ ok: true; root: string; projectUri: string }>("/api/ae/projects/register", {
    method: "POST",
    body: JSON.stringify({ path: projectPath })
  });
}

export async function forgetAeProjectRootOnApi(root: string): Promise<void> {
  await request<{ ok: true }>("/api/ae/projects/forget", {
    method: "POST",
    body: JSON.stringify({ root })
  });
}

export async function listAeProjectsFromApi(): Promise<AeProjectSummary[]> {
  const response = await request<{ ok: true; projects: AeProjectSummary[] }>("/api/ae/projects");
  return response.projects;
}

export async function inspectAeProjectOnApi(projectUri: string): Promise<AeProjectInspection> {
  const response = await request<{ ok: true; project: AeProjectInspection }>("/api/ae/projects/inspect", {
    method: "POST",
    body: JSON.stringify({ projectUri })
  });
  return response.project;
}

export async function readAeCompositionFromApi(
  projectUri: string,
  compositionId: string
): Promise<{ composition: AeCompositionSummary; layers: AeLayerSummary[] }> {
  return request<{ ok: true; composition: AeCompositionSummary; layers: AeLayerSummary[] }>(
    "/api/ae/projects/composition",
    { method: "POST", body: JSON.stringify({ projectUri, compositionId }) }
  );
}

export interface AeSceneImportResult {
  sceneId: string;
  scene: SceneDocument;
  importId?: string;
  convertedLayers: number;
  warnings: { code: string; message: string; layerName?: string }[];
}

/** Import one composition as a new, editable scene (layers → objects, keyframes → timeline). */
export async function importAeCompositionAsSceneOnApi(
  projectUri: string,
  compositionId: string,
  sceneName?: string
): Promise<AeSceneImportResult> {
  const response = await request<{ ok: true } & AeSceneImportResult>("/api/ae/projects/import-scene", {
    method: "POST",
    body: JSON.stringify({ projectUri, compositionId, sceneName })
  });
  return {
    sceneId: response.sceneId,
    scene: response.scene,
    importId: response.importId,
    convertedLayers: response.convertedLayers,
    warnings: response.warnings
  };
}

/** Import one composition as a group subtree into an existing scene. */
export async function importAeCompositionIntoSceneOnApi(
  projectUri: string,
  compositionId: string,
  targetSceneId: string
): Promise<AeSceneImportResult & { importId: string }> {
  const response = await request<{ ok: true; importId: string } & AeSceneImportResult>("/api/ae/projects/import-into-scene", {
    method: "POST",
    body: JSON.stringify({ projectUri, compositionId, targetSceneId })
  });
  return {
    sceneId: response.sceneId,
    scene: response.scene,
    importId: response.importId,
    convertedLayers: response.convertedLayers,
    warnings: response.warnings
  };
}

/** Remove an imported composition group subtree from a scene and release its collected assets. */
export async function removeAeImportOnApi(
  sceneId: string,
  importId: string
): Promise<{ sceneId: string; scene: SceneDocument; importId: string; deletedObjectCount: number }> {
  const response = await request<{ ok: true; sceneId: string; scene: SceneDocument; importId: string; deletedObjectCount: number }>(
    "/api/ae/projects/remove-import",
    {
      method: "POST",
      body: JSON.stringify({ sceneId, importId })
    }
  );
  return {
    sceneId: response.sceneId,
    scene: response.scene,
    importId: response.importId,
    deletedObjectCount: response.deletedObjectCount
  };
}

/* ── Project Workspace API ─────────────────────────────────────────────────────────── */

export interface ApiProjectLocation {
  root: string | null;
  manifest: { projectId: string; name: string; createdAt: string } | null;
}

export async function getProjectOnApi(): Promise<ApiProjectLocation> {
  const response = await request<{ ok: true; project: ApiProjectLocation }>("/api/project");
  return response.project;
}

export async function openProjectOnApi(root: string, name?: string): Promise<ApiProjectLocation> {
  const response = await request<{ ok: true; project: ApiProjectLocation }>("/api/project/open", {
    method: "POST",
    body: JSON.stringify({ root, name })
  });
  return response.project;
}

export async function closeProjectOnApi(): Promise<void> {
  await request<{ ok: true }>("/api/project/close", { method: "POST" });
}

/**
 * Everything in the open project's asset folders.
 *
 * `projectOpen` is carried through rather than collapsed into the empty list, because the panel
 * says something different in each case: a project with no assets is told to import some, and a
 * session with no project is told to save it somewhere first. Both are empty libraries; only one
 * is a problem the operator can act on.
 */
export interface ApiProjectAssetLibrary {
  projectOpen: boolean;
  assets: ProjectAssetReference[];
}

export async function listProjectAssetsOnApi(): Promise<ApiProjectAssetLibrary> {
  const response = await request<{ ok: true; projectOpen: boolean; assets: ProjectAssetReference[] }>(
    "/api/project/assets"
  );
  return { projectOpen: response.projectOpen, assets: response.assets };
}

/**
 * The absolute URL that serves one project asset's bytes.
 *
 * The route itself comes from the shared contract, so the service and the Editor cannot drift on
 * the encoding; this only puts the project service in front of it.
 */
export function projectAssetContentUrl(assetPath: string): string {
  return `${apiBaseUrl}${projectAssetContentPath(assetPath)}`;
}

export async function createAeRuntimeContainerOnApi(
  body: CreateAeRuntimeContainerRequest
): Promise<AeRuntimeContainer> {
  const response = await request<{ ok: true; container: AeRuntimeContainer }>("/api/ae-runtime/containers", {
    method: "POST",
    body: JSON.stringify(body)
  });
  return response.container;
}

export async function validateAePublishOnApi(containerId: string): Promise<AePublishValidation> {
  const response = await request<{ ok: true; validation: AePublishValidation }>("/api/ae/publish/validate", {
    method: "POST",
    body: JSON.stringify({ containerId })
  });
  return response.validation;
}

export interface AePublishOutcome {
  version: number;
  manifest: { assets: unknown[]; aeProject: string };
  validation: AePublishValidation;
  fileCount: number;
  totalBytes: number;
}

export async function publishAeContainerOnApi(
  containerId: string,
  options: { actions?: AePackageAnimationAction[] } = {}
): Promise<AePublishOutcome> {
  return request<{ ok: true } & AePublishOutcome>("/api/ae/publish", {
    method: "POST",
    body: JSON.stringify({ containerId, actions: options.actions })
  });
}

export async function listAePackageVersionsFromApi(graphicId: string): Promise<number[]> {
  const response = await request<{ ok: true; versions: number[] }>(
    `/api/ae/packages/${encodeURIComponent(graphicId)}/versions`
  );
  return response.versions;
}

export async function declareAeRuntimeControlOnApi(
  container: AeRuntimeContainer,
  control: AeDynamicControl
): Promise<AeRuntimeContainer> {
  return updateAeRuntimeContainerOnApi(container.id, { controls: [...container.controls, control] });
}

/**
 * The request never reached the service.
 *
 * A transport failure has no payload to read, so the rule that the service's own error text
 * must reach the operator has nothing to work with: the browser supplies "Failed to fetch",
 * which names neither what was unreachable nor where. That string is what the save indicator
 * ends up displaying, so it is translated once here rather than at each call site.
 */
export class ApiUnreachableError extends Error {
  constructor(cause: unknown) {
    super(`Project service unreachable on ${apiBaseUrl.replace(/^https?:\/\//, "")}`);
    this.name = "ApiUnreachableError";
    this.cause = cause;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // The access token the window minted at sign-in. Read per request, not captured at module
  // load, so a refresh mid-session is picked up by the very next call.
  const token = currentAccessToken();
  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...init?.headers
      }
    });
  } catch (cause) {
    const error = cause instanceof ApiUnreachableError ? cause : new ApiUnreachableError(cause);
    recordApiDiagnostic({
      level: "error",
      path,
      error,
      detail: {
        code: "api.unreachable",
        summary: error.message,
        cause: cause instanceof Error ? cause.message : undefined,
        remedy:
          "Check that the project service is running (the API chip in the status bar shows its state). If this is the desktop build, restart the Editor; if it is the web build, run `npm run dev:api`.",
        context: { url: `${apiBaseUrl}${path}`, method: init?.method ?? "GET" }
      }
    });
    throw error;
  }

  const payload = await response.json().catch(() => null) as { error?: string; code?: string } | null;

  if (!response.ok) {
    if (response.status === 401) invalidateSession();
    // The service explains refusals in `error` - a missing Figma scope, a rejected
    // token, an unsupported file. Reporting only the status code makes the operator
    // guess at something the server already told us.
    const error = new Error(payload?.error ?? `API request failed with ${response.status}`);
    recordApiDiagnostic({
      level: response.status >= 500 ? "error" : "warning",
      path,
      error,
      detail: {
        code: payload?.code ?? `http.${response.status}`,
        summary: error.message,
        remedy: remedyForHttpStatus(response.status),
        context: { url: `${apiBaseUrl}${path}`, method: init?.method ?? "GET", status: response.status }
      }
    });
    throw error;
  }

  return payload as T;
}

/**
 * The remedy an HTTP status implies when the service did not name one.
 *
 * Deliberately a lookup of the statuses this service actually returns, not a table of every
 * status: a guess for a status that never occurs would be advice no failure ever tested.
 */
function remedyForHttpStatus(status: number): string | undefined {
  const REMEDY_BY_STATUS: Record<number, string> = {
    400: "Check the values being sent — the service rejected the request as malformed. The context on this record names the URL.",
    401: "This session is no longer valid. Sign in again; the project service may have restarted.",
    403: "This window's origin is not in the service's allowed origins. Set GRAPIX_API_ALLOWED_ORIGINS or use the desktop shell.",
    404: "The thing this request named is not stored — the scene, asset or autosave may have been deleted. Re-open it or re-import it.",
    409: "The scene changed underneath this edit (a revision conflict). Re-read the scene and apply the change again.",
    415: "The file type is not accepted for this import. The service lists the accepted formats in its error text.",
    422: "The content failed validation — the preflight, font inspection or import report on this record names what was wrong.",
    423: "Read-only show mode is active: project and asset edits are locked until show control releases them.",
    429: "Too many live-data patches: at most 120 per scene per second are accepted. Retry with the latest values."
  };
  return REMEDY_BY_STATUS[status];
}

/** The apiClient half of recording, late-bound so the console store can live in its own module. */
type ApiDiagnosticReporter = (entry: {
  level: DiagnosticLevel;
  path: string;
  error: Error;
  detail: EditorDiagnosticDetail;
}) => void;

let apiDiagnosticReporter: ApiDiagnosticReporter = (entry) => {
  // Default until the console store installs itself: recording must not depend on import
  // order, so the reporter is set from diagnostics.ts at module scope.
  defaultApiDiagnosticReporter(entry);
};

export function installApiDiagnosticReporter(reporter: ApiDiagnosticReporter): void {
  apiDiagnosticReporter = reporter;
}

function recordApiDiagnostic(entry: Parameters<ApiDiagnosticReporter>[0]): void {
  try {
    apiDiagnosticReporter(entry);
  } catch {
    // Reporting a failure must never become the failure being reported.
  }
}

function defaultApiDiagnosticReporter(_entry: Parameters<ApiDiagnosticReporter>[0]): void {
  // No console store yet (unit tests, early bootstrap). The record is dropped rather than
  // thrown: the request still fails with its own error either way.
}
