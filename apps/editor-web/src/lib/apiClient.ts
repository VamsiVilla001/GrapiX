import type { DesignIR, DesignIRSummary, ImportWarning } from "@grapix/design-ir";
import type {
  ProfilePublic,
  ProfileWorkspaceLayout,
  SceneDocument,
  ScenePackagePreflight,
  SceneTimeline
} from "@grapix/shared-types";

/**
 * The local GrapiX service. Overridable so a second instance can run alongside one that
 * already holds the default port: `VITE_GRAPIX_API_URL=http://127.0.0.1:4180 npm run dev:web`.
 */
const apiBaseUrl = import.meta.env.VITE_GRAPIX_API_URL ?? "http://127.0.0.1:4100";

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
      // Only declare a JSON body when there is one: Fastify rejects an empty body sent
      // with content-type application/json, which 400s every bodyless POST.
      ...(init?.body === undefined ? {} : { "content-type": "application/json" }),
      ...init?.headers
    }
  });

  if (!response.ok) {
    const message = await readErrorMessage(response);

    throw new Error(message ?? `API request failed with ${response.status}`);
  }

  return (await response.json()) as T;
}

/** Surfaces the service's own error text so the UI can say what actually went wrong. */
async function readErrorMessage(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { error?: string };

    return body.error ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Profiles
//
// Credential values never travel to the browser. Writing a token sends it once;
// reading a profile returns only a hint (present + last four characters).
// ---------------------------------------------------------------------------

export async function listProfilesFromApi(): Promise<ProfilePublic[]> {
  const response = await request<{ ok: boolean; profiles: ProfilePublic[] }>("/api/profiles");

  return response.profiles;
}

export async function createProfileOnApi(input: {
  name: string;
  description?: string;
  figmaToken?: string;
}): Promise<ProfilePublic> {
  const response = await request<{ ok: boolean; profile: ProfilePublic }>("/api/profiles", {
    method: "POST",
    body: JSON.stringify(input)
  });

  return response.profile;
}

export async function updateProfileOnApi(
  profileId: string,
  patch: {
    name?: string;
    description?: string;
    workspaceLayout?: ProfileWorkspaceLayout | null;
    settings?: Record<string, unknown>;
    figmaToken?: string;
  }
): Promise<ProfilePublic> {
  const response = await request<{ ok: boolean; profile: ProfilePublic }>(
    `/api/profiles/${profileId}`,
    {
      method: "PATCH",
      body: JSON.stringify(patch)
    }
  );

  return response.profile;
}

export async function launchProfileOnApi(profileId: string): Promise<ProfilePublic> {
  const response = await request<{ ok: boolean; profile: ProfilePublic }>(
    `/api/profiles/${profileId}/launch`,
    { method: "POST" }
  );

  return response.profile;
}

export async function deleteProfileOnApi(profileId: string): Promise<void> {
  await request<{ ok: boolean }>(`/api/profiles/${profileId}`, { method: "DELETE" });
}

// ---------------------------------------------------------------------------
// Designs and imports
// ---------------------------------------------------------------------------

export interface ApiImportResult {
  design: DesignIRSummary;
  warnings: ImportWarning[];
}

export async function listDesignsFromApi(): Promise<DesignIRSummary[]> {
  const response = await request<{ ok: boolean; designs: DesignIRSummary[] }>("/api/designs");

  return response.designs;
}

export async function readDesignFromApi(designId: string): Promise<DesignIR> {
  const response = await request<{ ok: boolean; design: DesignIR }>(`/api/designs/${designId}`);

  return response.design;
}

export async function deleteDesignOnApi(designId: string): Promise<void> {
  await request<{ ok: boolean }>(`/api/designs/${designId}`, { method: "DELETE" });
}

export async function importFigmaOnApi(input: {
  profileId: string;
  target: string;
  nodeIds?: string[];
}): Promise<ApiImportResult> {
  return requestWithError<ApiImportResult>("/api/imports/figma", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export async function importDesignFileOnApi(file: File): Promise<ApiImportResult> {
  return requestWithError<ApiImportResult>("/api/imports/file", {
    method: "POST",
    body: JSON.stringify({
      fileName: file.name,
      dataBase64: await fileToBase64(file)
    })
  });
}

/** Like request(), but surfaces the server's own error message instead of a status code. */
async function requestWithError<T>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init.headers }
  });
  const data = (await response.json()) as T & { ok?: boolean; error?: string };

  if (!response.ok || data.ok === false) {
    throw new Error(data.error ?? `API request failed with ${response.status}`);
  }

  return data;
}

async function fileToBase64(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";

  // Chunked to stay well clear of the argument-count limit on large PSDs.
  const chunkSize = 0x8000;

  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }

  return btoa(binary);
}
