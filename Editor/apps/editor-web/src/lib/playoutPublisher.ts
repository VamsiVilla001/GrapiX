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

const playoutRoot =
  (import.meta.env.VITE_GRAPIX_PLAYOUT_API_URL as string | undefined)
  ?? "http://127.0.0.1:4300";

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
}

export interface PublishToPlayoutResult {
  published: PublishedSceneSummary;
  /** True when a thumbnail was captured; false means the card shows a placeholder. */
  hasThumbnail: boolean;
}

/**
 * Publish to the Playout scene library.
 *
 * Throws with the service's own message when Playout refuses, so the caller can show
 * something an operator can act on rather than "publish failed".
 */
export async function publishSceneToPlayout(
  scene: SceneDocument,
  options: PublishToPlayoutOptions = {}
): Promise<PublishToPlayoutResult> {
  const thumbnail = options.withoutThumbnail ? null : await captureSceneThumbnail(320);

  const response = await fetch(`${playoutRoot}/api/playout/scenes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      scene,
      options: {
        ...(thumbnail ? { thumbnailDataUrl: thumbnail.dataUrl } : {}),
        ...(options.colorSpace ? { colorSpace: options.colorSpace } : {}),
        defaultTransition: options.defaultTransition ?? "cut",
        ...(options.tags?.length ? { tags: options.tags } : {}),
        ...(options.category ? { category: options.category } : {}),
        sourceEditorId: "grapix-editor",
        sourceEndpoint: window.location.origin
      }
    })
  });

  const payload = (await response.json().catch(() => null)) as
    | (PublishedSceneSummary & { error?: string })
    | null;

  if (!response.ok) {
    throw new Error(
      payload?.error
        ?? `Playout refused the publish (${response.status}). Is the control service running on ${playoutRoot}?`
    );
  }
  if (!payload) {
    throw new Error("Playout accepted the scene but returned no metadata");
  }

  return { published: payload, hasThumbnail: thumbnail !== null };
}

/** Whether Playout is reachable, for enabling the publish action. */
export async function playoutIsReachable(): Promise<boolean> {
  try {
    const response = await fetch(`${playoutRoot}/api/playout/health`);
    return response.ok;
  } catch {
    return false;
  }
}

export { playoutRoot };
