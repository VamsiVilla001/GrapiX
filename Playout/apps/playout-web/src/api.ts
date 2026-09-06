import type {
  PlayoutRuntimeStatus,
  PlayoutTakeList,
  PublishedSceneMetadata,
  SceneDocument
} from "@grapix/shared-types";
import { currentAccessToken } from "./auth";

export const apiRoot =
  import.meta.env.VITE_GRAPIX_PLAYOUT_API_URL ?? "http://127.0.0.1:4300";

/**
 * MJPEG endpoint for a channel monitor.
 *
 * Given straight to an `<img>` rather than fetched: the browser decodes the stream
 * natively and off the main thread, so a monitor open for a whole show costs no
 * per-frame JavaScript.
 *
 * `view` picks fill or key. `tier` keeps the embedded confidence monitors cheap while the
 * windowed virtual output asks the engine for the project's native canvas resolution.
 * Both are ordinary JPEGs.
 */
export function monitorStreamUrl(
  channel: "preview" | "program",
  view: "fill" | "key" = "fill",
  tier: "confidence" | "output" = "confidence"
): string {
  return `${apiRoot}/api/playout/monitor/${channel}?view=${view}&tier=${tier}`;
}

/**
 * Distinguish an explicit operator take-out from an empty runtime after service restart.
 *
 * Program's MJPEG connection deliberately survives both states. Only the former should cover
 * its retained last frame; after a restart the engine may still be live and remains authoritative.
 */
export function isProgramExplicitlyCleared(status: PlayoutRuntimeStatus): boolean {
  return (
    status.programRef === null &&
    Object.values(status.takeStates).some((takeState) => takeState === "OFFLINE")
  );
}

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
 * A published After Effects graphic Playout can launch and attach to the render engine.
 */
export interface AePackageView {
  graphicId: string;
  name: string;
  latestVersion: number;
  versionRoot: string;
  ingestedAt: string;
  mainComposition: {
    itemId: string;
    name: string;
    width: number;
    height: number;
  };
  thumbnail?: string;
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
  sourceName?: string;
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
  options?: Record<string, string | number | boolean>;
  start?: boolean;
}

// ---------------------------------------------------------------------------
// Diagnostics — mirrors `diagnostics.ts` in the control service
// ---------------------------------------------------------------------------

export type DiagnosticLevel = "error" | "warning" | "info";

/**
 * The structured half of a failure.
 *
 * The banner shows `summary`; the console shows all of it. Everything but `summary` is
 * optional because it is only present when it is genuinely known — a console that invented a
 * remedy would be worse than one that admits it has none.
 */
export interface PlayoutDiagnosticDetail {
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
  detail?: PlayoutDiagnosticDetail;
}

export interface DiagnosticsPage {
  records: DiagnosticRecord[];
  latestSequence: number;
  capacity: number;
}

/**
 * A refused request, with everything the service said about it.
 *
 * `message` stays the human summary so existing `error.message` paths keep working, and
 * `detail` carries the cause, the remedy and the identifiers the console renders.
 */
export class PlayoutRequestError extends Error {
  constructor(
    message: string,
    readonly route: string,
    readonly httpStatus: number,
    readonly detail?: PlayoutDiagnosticDetail,
    /**
     * Sequence of the record the control service already wrote for this failure.
     *
     * Present whenever the service answered. The console then opens on that record rather
     * than the UI keeping a second copy of the same failure under a different origin.
     */
    readonly diagnosticSequence?: number
  ) {
    super(message);
    this.name = "PlayoutRequestError";
  }
}

export const playoutApi = {
  listScenes: () =>
    request<PublishedSceneMetadata[]>("/api/playout/scenes"),
  publishScene: (scene: SceneDocument) =>
    request<PublishedSceneMetadata>("/api/playout/scenes", {
      method: "POST",
      body: JSON.stringify({ scene })
    }),
  removeScene: (sceneId: string, force = true) =>
    request<{ sceneId: string; takeId: number | null; versionsRemoved: number }>(
      `/api/playout/scenes/${encodeURIComponent(sceneId)}${force ? "?force=true" : ""}`,
      { method: "DELETE" }
    ),
  listAePackages: () =>
    request<{ ok: true; packages: AePackageView[] }>("/api/playout/ae-packages").then(
      ({ packages }) => packages
    ),
  loadAePackage: (graphicId: string) =>
    request<{ ok: true }>(`/api/playout/ae-packages/${encodeURIComponent(graphicId)}/load`, {
      method: "POST"
    }),
  syncFromEditor: () =>
    request<{
      syncedCount: number;
      updatedCount: number;
      totalScenes: number;
      scenes: PublishedSceneMetadata[];
    }>("/api/playout/scenes/sync-editor", { method: "POST" }),
  listTakeLists: () => request<PlayoutTakeList[]>("/api/playout/take-lists"),
  createTakeList: (name: string) =>
    request<PlayoutTakeList>("/api/playout/take-lists/new", {
      method: "POST",
      body: JSON.stringify({ name })
    }),
  saveTakeList: (takeList: PlayoutTakeList) =>
    request<PlayoutTakeList>("/api/playout/take-lists", {
      method: "POST",
      body: JSON.stringify(takeList)
    }),

  /** Cue a Scene Manager Take ID straight to Preview. */
  cueSceneByTakeId: (takeId: number) =>
    request<PlayoutRuntimeStatus>("/api/playout/control/cue", {
      method: "POST",
      body: JSON.stringify({ takeId })
    }),
  /** Take a Scene Manager Take ID straight to Program — the direct recall XPression is built around. */
  takeSceneByTakeId: (takeId: number) =>
    request<PlayoutRuntimeStatus>("/api/playout/control/take", {
      method: "POST",
      body: JSON.stringify({ takeId })
    }),
  cueEntry: (takeListId: string, entryId: string) =>
    request<PlayoutRuntimeStatus>("/api/playout/control/cue", {
      method: "POST",
      body: JSON.stringify({ takeListId, entryId })
    }),
  takeEntry: (takeListId: string, entryId: string) =>
    request<PlayoutRuntimeStatus>("/api/playout/control/take", {
      method: "POST",
      body: JSON.stringify({ takeListId, entryId })
    }),
  takeOut: () =>
    request<PlayoutRuntimeStatus>("/api/playout/control/take-out", { method: "POST" }),
  continueTakeList: (takeListId: string) =>
    request<{ takeList: PlayoutTakeList; status: PlayoutRuntimeStatus }>(
      "/api/playout/control/continue",
      { method: "POST", body: JSON.stringify({ takeListId }) }
    ),
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
    control("take", rundownId, itemId),

  /** The service-side console tail. `since` is the highest sequence already held. */
  diagnostics: (since = 0) =>
    request<DiagnosticsPage>(`/api/playout/diagnostics${since > 0 ? `?since=${since}` : ""}`),
  clearDiagnostics: () =>
    request<{ cleared: number; latestSequence: number }>("/api/playout/diagnostics", {
      method: "DELETE"
    })
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
  // The access token minted at sign-in, read per request so a mid-session refresh is picked
  // up by the very next call.
  const token = currentAccessToken();
  let response: Response;
  try {
    response = await fetch(`${apiRoot}${route}`, {
      ...init,
      headers: {
        // Only claim a JSON body when one is actually sent. Fastify answers a
        // body-less request that declares application/json with
        // FST_ERR_CTP_EMPTY_JSON_BODY ("Body cannot be empty when content-type
        // is set to application/json"), which broke output start/stop, take-out
        // and engine reconnect.
        ...(init?.body === undefined ? {} : { "content-type": "application/json" }),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...init?.headers
      }
    });
  } catch (cause) {
    // `fetch` rejects with "Failed to fetch" and nothing else — no URL, no reason. On its
    // own that is indistinguishable from a bug in the UI, when it means the control service
    // is not running.
    throw new PlayoutRequestError(
      `The Playout control service at ${apiRoot} did not answer`,
      route,
      0,
      {
        code: "control-service.unreachable",
        summary: `The Playout control service at ${apiRoot} did not answer`,
        cause: cause instanceof Error ? cause.message : String(cause),
        remedy:
          "Start it with `npm run dev:playout`. If it runs on another host or port, set VITE_GRAPIX_PLAYOUT_API_URL for this UI.",
        context: { apiRoot, route, method: init?.method ?? "GET" }
      }
    );
  }

  // Not every failure answers in JSON: a proxy, a crashed process mid-reply or a wrong port
  // returns HTML or nothing, and parsing that used to throw a SyntaxError that hid the status.
  const raw = await response.text();
  let parsed: unknown;
  try {
    parsed = raw.length > 0 ? JSON.parse(raw) : undefined;
  } catch {
    parsed = undefined;
  }

  if (!response.ok) {
    const body = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
    const detail =
      typeof body.detail === "object" && body.detail !== null
        ? (body.detail as PlayoutDiagnosticDetail)
        : {
            code: `http.${response.status}`,
            summary:
              typeof body.error === "string" && body.error
                ? body.error
                : `${init?.method ?? "GET"} ${route} failed with HTTP ${response.status} ${response.statusText}`,
            ...(raw && typeof body.error !== "string" ? { cause: raw.slice(0, 400) } : {}),
            context: { route, httpStatus: response.status, method: init?.method ?? "GET" }
          };
    throw new PlayoutRequestError(
      detail.summary,
      route,
      response.status,
      detail,
      typeof body.diagnosticSequence === "number" ? body.diagnosticSequence : undefined
    );
  }

  return parsed as T;
}

/** What the control service pushes. Mirrors `PlayoutEventKind` in the control service. */
export type PlayoutEventKind =
  | "library.changed"
  | "sequence.changed"
  | "runtime.changed"
  | "diagnostics.logged";

/** Every event kind the control service pushes. */
const PLAYOUT_EVENT_KINDS: readonly PlayoutEventKind[] = [
  "library.changed",
  "sequence.changed",
  "runtime.changed",
  "diagnostics.logged"
];

interface Listener {
  onEvent: (kind: PlayoutEventKind) => void;
  onConnectionChange?: (live: boolean) => void;
}

/**
 * The one live stream, shared by every subscriber.
 *
 * Refcounted deliberately. `React.StrictMode` mounts an effect twice, and a subscribe call that
 * opened its own `EventSource` each time left two streams against one window — visible as
 * `liveSubscribers` sitting at 2 in the control service's health. Multiplexing also means a
 * second component can subscribe later without a second socket.
 */
let sharedSource: EventSource | null = null;
const listeners = new Set<Listener>();

/**
 * Subscribe to the control service's live event stream.
 *
 * The library used to refresh only on mount and on an explicit button press, so a scene
 * published from the Editor did not appear until the operator thought to press refresh. This
 * closes that gap. An event names what changed; the caller refetches. A missed event therefore
 * costs one stale render rather than a cache that has silently diverged.
 *
 * `EventSource` reconnects on its own, so a control-service restart heals without help. The
 * returned function detaches, and the last detach closes the socket.
 */
export function subscribeToPlayoutEvents(
  onEvent: (kind: PlayoutEventKind) => void,
  onConnectionChange?: (live: boolean) => void
): () => void {
  const listener: Listener = { onEvent, onConnectionChange };
  listeners.add(listener);

  if (!sharedSource) {
    const source = new EventSource(`${apiRoot}/api/playout/events`);
    for (const kind of PLAYOUT_EVENT_KINDS) {
      source.addEventListener(kind, () => {
        for (const current of listeners) current.onEvent(kind);
      });
    }
    source.onopen = () => {
      for (const current of listeners) current.onConnectionChange?.(true);
    };
    // Not an error worth surfacing: EventSource retries by itself, and the UI keeps its
    // three-second poll as the floor, so a dropped stream degrades to the old behaviour.
    source.onerror = () => {
      for (const current of listeners) current.onConnectionChange?.(false);
    };
    sharedSource = source;
  } else if (sharedSource.readyState === EventSource.OPEN) {
    // A late subscriber needs to be told the stream is already live; it will not see the
    // `onopen` that happened before it arrived.
    onConnectionChange?.(true);
  }

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && sharedSource) {
      sharedSource.onopen = null;
      sharedSource.onerror = null;
      sharedSource.close();
      sharedSource = null;
    }
  };
}
