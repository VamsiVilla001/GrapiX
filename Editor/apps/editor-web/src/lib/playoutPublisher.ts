/**
 * Publish a scene from the Editor to Playout.
 *
 * This is the hand-off between the two halves of the system. The Editor authors; once
 * published, Playout owns the scene as an immutable version and the Editor cannot
 * change what an operator is holding. Publishing again creates a new version rather
 * than mutating the old one, so a rundown pinned to v3 keeps rendering v3 while the
 * designer works on v4.
 *
 * What travels with the scene:
 *
 * - the full `SceneDocument`, unchanged
 * - a thumbnail, so the operator can recognise it in the scene manager
 * - the project colour space, because Playout configures outputs from it
 * - the default transition and any tags, which are operator metadata
 *
 * Nothing renderer-specific goes across: no PixiJS objects, no DOM, no overlay state.
 */

import type { SceneDocument } from "@grapix/shared-types";

import { captureSceneThumbnail } from "../rendering/thumbnailCapture";
import { apiBaseUrl } from "./apiClient";
import { currentAccessToken } from "./auth";
import { fetchProjectAsset, resolveProjectAssetUrl } from "./projectAssets";

/**
 * The configured Playout address.
 *
 * Baked in at build time, which is precisely why it needs a fallback: a UI built with one address
 * cannot be re-pointed when the machine it names stops resolving. `resolvePlayoutRoot` is what
 * every request should use.
 */
const configuredPlayoutRoot =
  (import.meta.env?.VITE_GRAPIX_PLAYOUT_API_URL as string | undefined)
  ?? "http://127.0.0.1:4300";

/** This Editor's own project service, which is what performs discovery on the UI's behalf. */
const projectApiRoot = apiBaseUrl;

/**
 * The address in use, once one has been proven.
 *
 * Cached for the lifetime of the page: a discovered address is stable for as long as the peer is,
 * and asking the project service on every publish would put a discovery round trip in front of an
 * operator action.
 */
let resolvedPlayoutRoot: string | null = null;

/**
 * Where Playout is.
 *
 * A page cannot speak mDNS — there is no multicast API in a browser — so when the configured
 * address does not answer, this asks the Editor's own project service, which does. That keeps one
 * discovery implementation in the repository rather than a second, weaker one written against
 * whatever a page can reach.
 *
 * `forceRefresh` is passed after a failed publish: the failure is better evidence about the
 * endpoint than anything cached.
 */
export async function resolvePlayoutRoot(forceRefresh = false): Promise<string> {
  if (!forceRefresh && resolvedPlayoutRoot) return resolvedPlayoutRoot;

  if (!forceRefresh && (await answersAsPlayout(configuredPlayoutRoot))) {
    resolvedPlayoutRoot = configuredPlayoutRoot;
    return configuredPlayoutRoot;
  }

  try {
    const response = await fetch(
      `${projectApiRoot}/api/discovery/playout${forceRefresh ? "?refresh=true" : ""}`,
      { signal: AbortSignal.timeout(6000) }
    );
    const payload = (await response.json()) as { ok?: boolean; endpoint?: { url?: string } };
    if (response.ok && payload.endpoint?.url) {
      resolvedPlayoutRoot = payload.endpoint.url;
      return payload.endpoint.url;
    }
  } catch {
    // The project service is the Editor's own, on this machine. If it cannot be reached the UI has
    // larger problems than publishing, and the configured address is still the best guess.
  }

  resolvedPlayoutRoot = null;
  return configuredPlayoutRoot;
}

async function answersAsPlayout(root: string): Promise<boolean> {
  try {
    const response = await fetch(`${root}/api/playout/health`, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return false;
    const payload = (await response.json()) as { service?: string };
    // The service names itself, so this is proof rather than "something answered on 4300".
    return payload.service === "grapix-playout-control";
  } catch {
    return false;
  }
}

export interface PublishedSceneSummary {
  sceneId: string;
  name: string;
  version: number;
  publishedAt: string;
  canvasWidth?: number;
  canvasHeight?: number;
  colorSpace?: string;
  thumbnailDataUrl?: string;
}

export interface PublishToPlayoutOptions {
  colorSpace?: string;
  defaultTransition?: "cut" | "mix" | "dip" | "wipe" | "push";
  tags?: string[];
  category?: string;
  /** Skip the thumbnail capture. Used when no viewport is mounted. */
  withoutThumbnail?: boolean;
  /** Editor playhead restored after capturing the scene's held final frame. */
  thumbnailRestoreFrame?: number;
}

export interface PublishToPlayoutResult {
  published: PublishedSceneSummary;
  /** True when a thumbnail was captured; false means the card shows a placeholder. */
  hasThumbnail: boolean;
}

/**
 * Publish to the Playout scene library.
 *
 * Throws with the service's own message when Playout refuses, so the caller can show something an
 * operator can act on rather than "publish failed".
 *
 * The address is resolved, not assumed: a UI built against one Playout address cannot be
 * re-pointed, so when that address does not answer the Editor's project service is asked where
 * Playout is. A send that fails at the transport level is retried once against a re-proven
 * address — that is the case this exists for, and one retry is the difference between a publish
 * that works on a dead network and an operator with nothing to air.
 */
export async function publishSceneToPlayout(
  scene: SceneDocument,
  options: PublishToPlayoutOptions = {}
): Promise<PublishToPlayoutResult> {
  const thumbnail = options.withoutThumbnail
    ? null
    : await captureSceneThumbnail({
        scene,
        frame: Math.max(0, scene.timeline.durationFrames - 1),
        restoreFrame: options.thumbnailRestoreFrame,
        maxDimension: 320
      });

  // Playout must retain project fonts after the Editor closes. Font assets are
  // small enough to travel with the immutable published scene; leaving their
  // source pointed at :4100 made every restart lose the typeface.
  const publishedScene = await inlinePublishedAssets(scene);

  const body = JSON.stringify({
    scene: publishedScene,
    options: {
      ...(thumbnail ? { thumbnailDataUrl: thumbnail.dataUrl } : {}),
      ...(options.colorSpace ? { colorSpace: options.colorSpace } : {}),
      defaultTransition: options.defaultTransition ?? "cut",
      ...(options.tags?.length ? { tags: options.tags } : {}),
      ...(options.category ? { category: options.category } : {}),
      sourceEditorId: "grapix-editor",
      sourceEndpoint: window.location.origin
    }
  });

  let root = await resolvePlayoutRoot();
  let response: Response;
  try {
    response = await send(root, body);
  } catch (cause) {
    // The address could not be reached at all — the exact failure discovery answers. Re-prove and
    // try once more before reporting anything to the operator.
    root = await resolvePlayoutRoot(true);
    try {
      response = await send(root, body);
    } catch {
      throw new Error(
        `Playout could not be reached at ${root}, and no Playout service was found on this machine or on the local network. `
          + `Start Playout, or check both machines are on the same switch. (${
            cause instanceof Error ? cause.message : String(cause)
          })`
      );
    }
  }

  const payload = (await response.json().catch(() => null)) as
    | (PublishedSceneSummary & { error?: string })
    | null;

  if (!response.ok) {
    throw new Error(
      payload?.error
        ?? `Playout refused the publish (${response.status}). Is the control service running on ${root}?`
    );
  }
  if (!payload) {
    throw new Error("Playout accepted the scene but returned no metadata");
  }

  return { published: payload, hasThumbnail: thumbnail !== null };
}

function send(root: string, body: string): Promise<Response> {
  /*
   * Playout's control API shares the Editor's account store and signing secret, so the
   * window's login already is a Playout login — but only if the token travels with the
   * request. Publishing without it was refused "authentication required" on a signed-in
   * session, which read as a second account the product does not have.
   */
  const token = currentAccessToken();
  return fetch(`${root}/api/playout/scenes`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body
  });
}

/**
 * Package every asset the scene needs into the scene itself.
 *
 * Playout must keep rendering after the Editor closes, so a published scene cannot point at
 * anything the Editor serves — not `/api/assets/<id>/content`, and not a project-relative
 * `images/<scene>/<layer>.png`. Both resolve here and nowhere else: Playout would upload nothing to
 * the render engine, and a take would show a missing texture the first time the Editor was shut
 * down. Fonts have travelled this way since the typeface kept disappearing on restart; images are
 * the same problem with bigger bytes.
 *
 * The object's `src` is rewritten with the asset, because that is what the renderers read.
 */
async function inlinePublishedAssets(scene: SceneDocument): Promise<SceneDocument> {
  /** Old source to inlined data URL, so an image used by ten layers is fetched and encoded once. */
  const inlined = new Map<string, string>();

  const assets = await Promise.all(scene.assets.map(async (asset) => {
    const source = asset.source;
    if (!source || source.startsWith("data:")) return asset;
    // A media server or another host stays a link: those are reachable from Playout too, and
    // inlining a video would put hundreds of megabytes in a scene document.
    if (asset.kind !== "font" && asset.kind !== "image" && asset.kind !== "svg") return asset;

    const known = inlined.get(source);
    if (known) return { ...asset, source: known };

    // The asset content route sits behind the same login as every other project route,
    // so a bare fetch answers 401 and packaging fails on the first image. The window's
    // session token is attached inside fetchProjectAsset.
    const response = await fetchProjectAsset(source);
    if (!response.ok) {
      throw new Error(
        `Could not package ${asset.kind} ${asset.name} for Playout: ${resolveProjectAssetUrl(source)} answered ${response.status}. `
          + "Playout has to carry its own copy, because it keeps rendering after the Editor closes."
      );
    }
    const bytes = await response.arrayBuffer();
    const mimeType = asset.mimeType
      ?? response.headers.get("content-type")
      ?? "application/octet-stream";
    const dataUrl = bytesToDataUrl(new Uint8Array(bytes), mimeType);
    inlined.set(source, dataUrl);
    return { ...asset, source: dataUrl };
  }));

  /*
   * An image object names its asset, it does not carry a second copy of it. Rewriting `src` to the
   * data URL as well doubled every picture in the document — 4 MiB of the 13 MiB a real scene
   * weighed — and a scene document is a control message that has to stay small enough to send.
   */
  const objects = scene.objects.map((object) => {
    if (object.type !== "image" || !object.src) return object;
    const asset = scene.assets.find((candidate) => candidate.source === object.src);
    return asset ? { ...object, src: `asset:${asset.assetId}` } : object;
  });

  return { ...scene, assets, objects };
}

function bytesToDataUrl(bytes: Uint8Array, mimeType: string): string {
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += 32_768) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 32_768)));
  }
  return `data:${mimeType};base64,${btoa(chunks.join(""))}`;
}

/**
 * Whether Playout is reachable, for enabling the publish action.
 *
 * Goes through the same resolution as a publish, so the button is enabled exactly when a publish
 * would find something — a button that is enabled against an address the publish will not use is
 * worse than one that is greyed out.
 */
export async function playoutIsReachable(): Promise<boolean> {
  const root = await resolvePlayoutRoot();
  return answersAsPlayout(root);
}

/** The configured address, for a UI that wants to show what was asked for. */
export { configuredPlayoutRoot };
