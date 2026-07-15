import type { SceneDocument, ScenePackagePreflight, SceneTimeline } from "@grapix/shared-types";

const apiBaseUrl = "http://127.0.0.1:4100";

export interface ApiHealth {
  ok: boolean;
  service: string;
  time: string;
}

export interface ApiSceneSummary {
  id: string;
  name: string;
  updatedAt: string;
  objectCount: number;
  assetCount: number;
  materialCount: number;
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
