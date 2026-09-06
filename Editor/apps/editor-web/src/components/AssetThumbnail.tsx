/**
 * An asset thumbnail that can actually load.
 *
 * `<img src="/api/project/assets/content?path=…">` sends no `Authorization` header, and every
 * project-service route answers 401 without one — so every thumbnail in the Material Manager was a
 * blank checkerboard, with the failure invisible because a broken `<img>` renders as nothing. The
 * renderers already solved this (`GpuSceneRenderer` hands Pixi a blob URL from
 * `resolveProjectAssetObjectUrl`); the panel had simply never been given the same treatment.
 *
 * The blob URL cache is keyed on the content route's etag, not on the address, so a file replaced
 * in place produces a new key and a fresh picture rather than the stale one the URL alone would
 * hit. That is the whole reason project assets are addressed by path: replacing
 * `lower-third-bg.png` has to be visible everywhere at once.
 *
 * Nothing is revoked here. The cache is process-wide and shared with the renderers — revoking on
 * unmount would pull the texture out from under a canvas still drawing it. `releaseProjectAssetObjectUrls`
 * clears the lot when a scene closes.
 */

import { useEffect, useState } from "react";

import { resolveProjectAssetObjectUrl } from "../lib/projectAssets";

type ThumbnailState =
  | { status: "loading" }
  | { status: "ready"; url: string }
  | { status: "failed" };

export interface AssetThumbnailProps {
  /** The asset's `source`: a project path, a service route, a data URL or a remote address. */
  source: string;
  alt?: string;
  /** Rendered while loading and on failure. A blank box says nothing; an icon says "not a picture". */
  fallback?: React.ReactNode;
}

export function AssetThumbnail({ source, alt = "", fallback = null }: AssetThumbnailProps) {
  const [state, setState] = useState<ThumbnailState>({ status: "loading" });

  useEffect(() => {
    // Guards the async resolve against a source that changed, or a panel that closed, while the
    // fetch was in flight. Without it a slow thumbnail can land after a faster one and show the
    // previous asset's picture in the new asset's tile.
    let current = true;
    setState({ status: "loading" });

    resolveProjectAssetObjectUrl(source).then(
      (url) => { if (current) setState({ status: "ready", url }); },
      () => { if (current) setState({ status: "failed" }); }
    );

    return () => { current = false; };
  }, [source]);

  if (state.status !== "ready") return <>{fallback}</>;
  // `decoding="async"` and `loading="lazy"`: a project folder can hold hundreds of images, and
  // decoding them all synchronously on first paint locks the panel while an author scrolls.
  return <img src={state.url} alt={alt} decoding="async" loading="lazy" />;
}
