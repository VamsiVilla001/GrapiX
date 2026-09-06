/**
 * Reading the bytes of a published asset, and explaining it when that fails.
 *
 * Separate from the engine controller because this is where the failure an operator actually
 * meets lives, and it is worth testing on its own. The engine refuses undeclared bytes, so
 * every asset in a scene has to be fetched and uploaded before the scene can be prepared; a
 * scene published against asset bytes the Editor's project service no longer holds fails
 * here, on the operator's take.
 *
 * The message this replaced was `asset asset_b5350b45cd6cca4ff8f7 returned HTTP 404`: an
 * opaque id, no asset name, no URL, no scene, no status text and no remedy. It reads like a
 * bug in Playout when it is nearly always a published scene pointing at content that was
 * re-imported, cleared, or never in this Editor's store.
 */

import type { AssetLibraryItem } from "@grapix/shared-types";

import { PlayoutOperationError } from "./diagnostics.js";

/** The identifiers an operator needs to find one asset in the Editor. */
export function assetContext(asset: AssetLibraryItem): Record<string, unknown> {
  return {
    assetId: asset.assetId,
    assetName: asset.name,
    assetKind: asset.kind,
    assetStatus: asset.status ?? "unspecified",
    mimeType: asset.mimeType ?? "unspecified",
    sizeBytes: asset.sizeBytes ?? null,
    checksum: asset.checksum ?? null,
    source: asset.source
  };
}

/**
 * Read an asset's bytes so they can be uploaded to the engine.
 *
 * `sceneContext` is merged into every failure: which scene was being loaded is the first
 * thing an operator needs and the last thing this layer still knows. An embedded data URL
 * needs no network and cannot fail this way, which is why publishing with embedded assets is
 * the remedy every failure here names.
 */
export async function readAssetBytes(
  asset: AssetLibraryItem,
  sceneContext: Record<string, unknown>
): Promise<Uint8Array> {
  const context = { ...sceneContext, ...assetContext(asset) };
  const dataUrl = asset.source.match(/^data:[^,]*?(;base64)?,(.*)$/s);
  if (dataUrl) {
    if (dataUrl[1]) return new Uint8Array(Buffer.from(dataUrl[2] ?? "", "base64"));
    const decoded = decodeURIComponent(dataUrl[2] ?? "");
    return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  }

  // A relative URL cannot be fetched from a service: it means the scene was published
  // without embedding the bytes and without an absolute address for them, so nothing on this
  // machine can say which host was meant.
  if (!/^[a-z][a-z0-9+.-]*:/i.test(asset.source)) {
    throw new PlayoutOperationError({
      code: "asset.source-not-absolute",
      summary: `"${asset.name}" points at "${asset.source}", which is not an address Playout can fetch`,
      remedy:
        "Re-publish the scene from the Editor with assets embedded, or with an absolute asset URL. A path on its own only resolves inside the Editor UI.",
      context
    });
  }

  const origin = new URL(asset.source).origin;
  let response: Response;
  try {
    response = await fetch(asset.source);
  } catch (cause) {
    throw new PlayoutOperationError({
      code: "asset.host-unreachable",
      summary: `Nothing answered at ${origin} for "${asset.name}"`,
      cause,
      remedy:
        "Start the service that holds the asset — normally the Editor project service on port 4100 (`npm run dev`) — then take the scene again. To air without it, re-publish the scene with assets embedded.",
      context
    });
  }

  if (!response.ok) {
    // The body is the answering service's own explanation, and a 404 page can be a whole
    // HTML document, so it is bounded: a diagnostic nobody can read is not one.
    const body = await response
      .text()
      .then((text) => text.trim().slice(0, 400))
      .catch(() => "");
    const missing = response.status === 404;
    throw new PlayoutOperationError({
      code: missing ? "asset.content-unavailable" : "asset.fetch-refused",
      summary: missing
        ? `${origin} no longer holds the bytes for "${asset.name}", so scene "${String(
            sceneContext.sceneName ?? sceneContext.sceneId ?? "unknown"
          )}" cannot be sent to the render engine`
        : `${origin} refused to serve "${asset.name}" with HTTP ${response.status} ${response.statusText}`,
      cause: `GET ${asset.source} → HTTP ${response.status} ${response.statusText}${body ? `: ${body}` : ""}`,
      remedy: missing
        ? "The published scene references an asset the Editor's project service does not have — usually because it was re-imported, or its store was cleared after publishing. Re-import the asset in the Editor, publish the scene again, then press Fetch in Scene Manager. To air the scene without it, mark the asset missing in the Editor and re-publish."
        : "Check the service that owns the asset; its own explanation is in the cause above. Then take the scene again.",
      context: {
        ...context,
        httpStatus: response.status,
        httpStatusText: response.statusText,
        ...(body ? { responseBody: body } : {})
      }
    });
  }

  return new Uint8Array(await response.arrayBuffer());
}
