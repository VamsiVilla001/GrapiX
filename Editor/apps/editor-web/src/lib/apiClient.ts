import type {
  DesignImportOptions,
  DesignImportResult,
  FigmaDesignImportSource,
  FontDefinition,
  GrapixTriggerEvent,
  RundownDocument,
  SceneDocument,
  ScenePackagePreflight,
  SceneScriptPermission,
  SceneScriptReference,
  SceneTimeline
} from "@grapix/shared-types";

const apiBaseUrl = "http://127.0.0.1:4100";

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
  options: Partial<DesignImportOptions>
): Promise<DesignImportResult> {
  const query = new URLSearchParams({
    fileName: file.name,
    options: JSON.stringify(options)
  });
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

export async function saveRundownOnApi(rundown: RundownDocument): Promise<void> {
  await request("/api/rundowns", {
    method: "POST",
    body: JSON.stringify(rundown)
  });
}

export async function readRundownFromApi(rundownId: string): Promise<RundownDocument> {
  const response = await request<{ ok: true; rundown: RundownDocument }>(
    `/api/rundowns/${encodeURIComponent(rundownId)}`
  );
  return response.rundown;
}

export async function fireRundownEvent(
  rundownId: string,
  event: GrapixTriggerEvent,
  execute = false
): Promise<unknown> {
  return request(`/api/rundowns/${encodeURIComponent(rundownId)}/events`, {
    method: "POST",
    body: JSON.stringify({ event, execute })
  });
}

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
): Promise<{ scene: SceneDocument; rendererSync: { synced: boolean; reason?: string } }> {
  const response = await request<{
    ok: boolean;
    scene: SceneDocument;
    rendererSync: { synced: boolean; reason?: string };
  }>(`/api/scenes/${sceneId}/data-patches`, {
    method: "PATCH",
    body: JSON.stringify({ path, value, expectedRevision })
  });
  return {
    scene: response.scene,
    rendererSync: response.rendererSync
  };
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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init?.headers
    }
  });

  if (!response.ok) {
    throw new Error(`API request failed with ${response.status}`);
  }

  return (await response.json()) as T;
}
