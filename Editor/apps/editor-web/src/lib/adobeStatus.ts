import type { AdobeApplicationStatus } from "@grapix/adobe-common-schema";

export type AdobeAvailability = "Connected" | "Cloud only" | "Disconnected" | "Unavailable";

export interface AdobeApplicationView {
  availability: AdobeAvailability;
  /** True only while a local plugin holds a socket, so a dead plugin cannot be "restarted". */
  canRestart: boolean;
  /** Adobe's Photoshop API can serve calls even with no plugin running. */
  cloudReady: boolean;
  /** What the operator should do next, or undefined when nothing is wrong. */
  guidance?: string;
}

/**
 * Turn a gateway application record into what the panel may claim.
 *
 * Three distinctions the operator needs, and which collapsing would hide:
 *
 * - **Connected** — a plugin is running, so GrapiX sees the document that is actually open.
 * - **Cloud only** — no plugin, but Adobe's Photoshop API is configured, so a PSD reachable
 *   by URL still works. This is the normal state on a playout machine.
 * - **Disconnected** — a plugin was there and is not now: it crashed, or the app closed.
 * - **Unavailable** — the gateway has never seen this application and cannot tell whether
 *   it is installed at all.
 */
export function describeApplication(
  label: string,
  status: AdobeApplicationStatus | undefined
): AdobeApplicationView {
  const cloudReady = status?.cloudAvailable === true;

  if (status?.connected) {
    return { availability: "Connected", canRestart: true, cloudReady };
  }

  if (cloudReady) {
    return {
      availability: "Cloud only",
      canRestart: false,
      cloudReady,
      guidance: `No ${label} plugin is running, so GrapiX cannot see an open document. Adobe's Photoshop API will serve any PSD you give it a URL for.`
    };
  }

  if (status?.installed) {
    return {
      availability: "Disconnected",
      canRestart: false,
      cloudReady,
      guidance: `${label} was reachable earlier in this session. Reopen it, or restart the GrapiX bridge inside it.`
    };
  }

  return {
    availability: "Unavailable",
    canRestart: false,
    cloudReady,
    guidance:
      status?.cloudDetail && status.cloudDetail.startsWith("the Photoshop API is not configured")
        ? `Install and run the GrapiX bridge inside ${label}, or configure Adobe's Photoshop API — ${status.cloudDetail}.`
        : `Install and run the GrapiX bridge inside ${label}. The gateway cannot launch ${label} for you.`
  };
}
