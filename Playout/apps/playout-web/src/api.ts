import type {
  PlayoutRundownDocument,
  PlayoutRuntimeStatus,
  PublishedSceneMetadata,
  SceneDocument
} from "@grapix/shared-types";

const apiRoot =
  import.meta.env.VITE_GRAPIX_PLAYOUT_API_URL ?? "http://127.0.0.1:4300";

/**
 * Health of the standalone render engine, as Playout sees it.
 *
 * Mirrors `EngineSupervisorStatus` in the control service. Kept as a local shape
 * rather than importing from the service, because playout-web must not depend on a
 * service package.
 */
export interface EngineHealthView {
  configured: boolean;
  url: string;
  connected: boolean;
  engineId: string | null;
  engineName: string | null;
  state: string;
  takeReady: boolean;
  lastError: string | null;
  gpu: string | null;
  maxLogicalCanvas: { width: number; height: number } | null;
  maxTextureDimension: number | null;
  tileRendering: boolean | null;
  pendingResyncSceneIds: string[];
}

/**
 * One configured output, as the engine reports it.
 *
 * `live` is the field that matters: it is the engine's own answer to "do frames
 * reaching this output go in front of an audience", and it is never inferred from the
 * adapter name in the UI.
 */
export interface EngineOutputView {
  outputId: string;
  adapterId: string;
  name: string;
  state: "idle" | "configured" | "running" | "error";
  live: boolean;
  available: boolean;
  unavailableReason?: string;
  hardwareCertified: boolean;
  width: number;
  height: number;
  frameRateNumerator: number;
  frameRateDenominator: number;
  colorSpace: string;
  framesAccepted: number;
  framesSent: number;
  framesDropped: number;
  lastError?: string;
}

export interface EngineOutputAdapterView {
  adapterId: string;
  name: string;
  live: boolean;
  available: boolean;
  unavailableReason?: string;
  hardwareCertified: boolean;
}

export interface EngineOutputsView {
  outputs: EngineOutputView[];
  availableAdapters: EngineOutputAdapterView[];
}

export interface OutputMutationResult {
  outputs: EngineOutputView[];
  warnings: string[];
}

export interface ConfigureOutputRequest {
  outputId: string;
  adapterId: string;
  width: number;
  height: number;
  frameRate: { numerator: number; denominator: number };
  colorSpace?: string;
  start?: boolean;
}

export const playoutApi = {
  listScenes: () =>
    request<PublishedSceneMetadata[]>("/api/playout/scenes"),
  publishScene: (scene: SceneDocument) =>
    request<PublishedSceneMetadata>("/api/playout/scenes", {
      method: "POST",
      body: JSON.stringify({ scene })
    }),
  listRundowns: () =>
    request<PlayoutRundownDocument[]>("/api/playout/rundowns"),
  createRundown: (name: string) =>
    request<PlayoutRundownDocument>("/api/playout/rundowns/new", {
      method: "POST",
      body: JSON.stringify({ name })
    }),
  saveRundown: (rundown: PlayoutRundownDocument) =>
    request<PlayoutRundownDocument>("/api/playout/rundowns", {
      method: "POST",
      body: JSON.stringify(rundown)
    }),
  status: () => request<PlayoutRuntimeStatus>("/api/playout/status"),
  engine: () => request<EngineHealthView>("/api/playout/engine"),
  connectEngine: () =>
    request<EngineHealthView>("/api/playout/engine/connect", { method: "POST" }),
  outputs: () => request<EngineOutputsView>("/api/playout/engine/outputs"),
  configureOutput: (body: ConfigureOutputRequest) =>
    request<OutputMutationResult>("/api/playout/engine/outputs", {
      method: "POST",
      body: JSON.stringify(body)
    }),
  outputAction: (outputId: string, action: "start" | "stop" | "remove") =>
    request<OutputMutationResult>(
      `/api/playout/engine/outputs/${encodeURIComponent(outputId)}/${action}`,
      { method: "POST" }
    ),
  cue: (rundownId: string, itemId: string) =>
    control("cue", rundownId, itemId),
  take: (rundownId: string, itemId: string) =>
    control("take", rundownId, itemId)
};

function control(
  action: "cue" | "take",
  rundownId: string,
  itemId: string
): Promise<PlayoutRuntimeStatus> {
  return request(`/api/playout/control/${action}`, {
    method: "POST",
    body: JSON.stringify({ rundownId, itemId })
  });
}

async function request<T>(route: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiRoot}${route}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init?.headers
    }
  });
  const result = (await response.json()) as unknown;
  if (!response.ok) {
    const message =
      typeof result === "object" &&
      result !== null &&
      "error" in result &&
      typeof result.error === "string"
        ? result.error
        : undefined;
    throw new Error(
      message ?? `Playout request failed (${response.status})`
    );
  }
  return result as T;
}
