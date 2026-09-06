/**
 * Push a freshly published AE package to Playout.
 *
 * The package is already written and immutable before this runs — the push is the *announcement*,
 * not the artifact. That ordering is deliberate: a publish must succeed and be recorded even when
 * no Playout is reachable (an offline truck, a dark Playout station), so a failed push is reported
 * alongside the publish result rather than thrown, and the author is told to re-sync rather than
 * told the publish failed.
 *
 * The push carries the package's absolute version directory. Playout re-reads and re-verifies the
 * package from that path itself — it never trusts the bytes the Editor claims to have written.
 */
import type { EditorDiscovery } from "../discovery.js";

export interface AePlayoutPushResult {
  delivered: boolean;
  /** Why nothing was delivered, when it wasn't — Playout down, refused, unreachable. */
  reason: string | null;
  /** The graphic and version Playout acknowledged, when it did. */
  graphicId?: string;
  version?: number;
}

/**
 * POST the package's version root to Playout's ingest endpoint.
 *
 * Authored to be safe to fire and forget the failure of: every rejection, network error and
 * non-2xx is collapsed into `{ delivered: false, reason }`. The caller decides how loudly to
 * surface that; this function's job is only to never let a push problem look like a publish
 * problem.
 */
export async function pushAePackageToPlayout(
  discovery: EditorDiscovery | null,
  versionRoot: string
): Promise<AePlayoutPushResult> {
  if (!discovery) {
    return { delivered: false, reason: "this Editor is not running discovery, so it cannot locate Playout" };
  }

  let url: string;
  try {
    const endpoint = await discovery.resolvePlayout();
    if (!endpoint) {
      return { delivered: false, reason: "no Playout control service answered (checked config, loopback and the local link)" };
    }
    url = `${endpoint.url.replace(/\/+$/, "")}/api/playout/ae-packages/ingest`;
  } catch (error) {
    return { delivered: false, reason: `could not resolve Playout: ${error instanceof Error ? error.message : String(error)}` };
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ versionRoot }),
      signal: AbortSignal.timeout(15_000)
    });
  } catch (error) {
    return { delivered: false, reason: `Playout could not be reached: ${error instanceof Error ? error.message : String(error)}` };
  }

  let payload: { ok?: boolean; error?: string; graphicId?: string; version?: number } = {};
  try {
    payload = (await response.json()) as typeof payload;
  } catch {
    // A non-JSON rejection still carries the status; treat it as undelivered below.
  }

  if (!response.ok || !payload.ok) {
    return {
      delivered: false,
      reason: payload.error ?? `Playout refused the package (HTTP ${response.status})`
    };
  }
  return { delivered: true, reason: null, ...(payload.graphicId ? { graphicId: payload.graphicId } : {}), ...(payload.version !== undefined ? { version: payload.version } : {}) };
}
