/**
 * How the Editor is found, and how it finds Playout, when the network is not helping.
 *
 * Both halves of GrapiX address each other through configuration: `GRAPIX_EDITOR_API_URL` on the
 * Playout side, `VITE_GRAPIX_PLAYOUT_API_URL` baked into the Editor UI, and `127.0.0.1` defaults
 * either side of both. Every one of those assumes something about the network that a dead uplink,
 * a lost DHCP lease or a machine name that no longer resolves takes away — while the two
 * applications are still sitting on the same switch, or the same machine, perfectly able to talk.
 *
 * So this service announces itself on the local link and browses for Playout. Two rules keep it
 * honest:
 *
 * - **Advertising is not a dependency.** If the multicast socket cannot open — port held by
 *   Bonjour, a firewall profile, no multicast interface — `start` reports it and the service runs
 *   exactly as before. Nothing here is allowed to fail a startup.
 * - **The browser UI never speaks mDNS.** It cannot: there is no multicast API in a page. It asks
 *   this service where Playout is, which is why `GET /api/discovery/playout` exists.
 */

import {
  EndpointResolver,
  GRAPIX_SERVICE_TYPES,
  ServiceAdvertiser,
  ServiceBrowser,
  type DiscoveredService,
  type ResolvedEndpoint
} from "@grapix/service-discovery";

/** Default Playout control address, matching the Playout service's own default. */
const PLAYOUT_LOOPBACK = "http://127.0.0.1:4300";

export interface EditorDiscoveryOptions {
  /** The port this service is actually listening on, not the one it was asked for. */
  port: number;
  /** Service version, published in TXT so a peer can refuse an incompatible one. */
  version: string;
  /** Reported rather than thrown. */
  onWarning?: (message: string, error?: Error) => void;
  onRouteChange?: (endpoint: ResolvedEndpoint, previous: ResolvedEndpoint | null) => void;
}

export interface DiscoveryStatus {
  advertising: boolean;
  /** The instance name peers see. Null when advertising could not start. */
  instance: string | null;
  interfaces: string[];
  /** Why discovery is unavailable, when it is. */
  unavailableReason: string | null;
  playout: ResolvedEndpoint | null;
  discoveredPlayout: DiscoveredService[];
}

/**
 * The Editor's side of discovery: one advertisement, one browse, one resolver.
 *
 * A single object because all three share one multicast socket and one lifetime, and because a
 * service shutting down owes the link a goodbye — a peer that is not told keeps offering an
 * operator an Editor that has closed.
 */
export class EditorDiscovery {
  private readonly options: EditorDiscoveryOptions;
  private advertiser: ServiceAdvertiser | null = null;
  private browser: ServiceBrowser | null = null;
  private resolver: EndpointResolver | null = null;
  private unavailableReason: string | null = null;

  constructor(options: EditorDiscoveryOptions) {
    this.options = options;
  }

  /**
   * Begin advertising and browsing.
   *
   * Never throws and never rejects. The return value says whether the fallback is available, which
   * the caller logs — an operator who later needs it should be able to find out that it was never
   * running.
   */
  async start(): Promise<boolean> {
    const advertiser = new ServiceAdvertiser(
      {
        type: GRAPIX_SERVICE_TYPES.editor,
        name: "GrapiX Editor",
        port: this.options.port,
        txt: {
          role: "editor",
          api: "/api",
          v: this.options.version
        }
      },
      { onError: (error) => this.options.onWarning?.("mDNS socket error", error) }
    );

    let advertising = false;
    try {
      advertising = await advertiser.start();
    } catch (error) {
      // Defensive: `start` is written not to throw, and a change that made it throw must not
      // become a service that will not boot.
      advertising = false;
      this.options.onWarning?.("advertising the Editor on the local link failed", asError(error));
    }

    if (!advertising) {
      this.unavailableReason =
        "the mDNS socket could not be opened (port 5353 may be held by the system responder, or blocked by a firewall)";
      this.options.onWarning?.(`local-link discovery is unavailable: ${this.unavailableReason}`);
    } else {
      this.advertiser = advertiser;
    }

    // Browsing is attempted even when advertising failed: the two use separate sockets, and being
    // unable to announce does not mean being unable to listen.
    const browser = new ServiceBrowser([GRAPIX_SERVICE_TYPES.playout], {
      onError: (error) => this.options.onWarning?.("mDNS browse error", error)
    });
    if (await browser.start()) this.browser = browser;

    this.resolver = new EndpointResolver({
      serviceType: GRAPIX_SERVICE_TYPES.playout,
      configured: process.env.GRAPIX_PLAYOUT_API_URL?.trim() || undefined,
      loopback: PLAYOUT_LOOPBACK,
      verify: verifyPlayout,
      ...(this.browser ? { browser: this.browser } : {}),
      ...(this.options.onRouteChange ? { onRouteChange: this.options.onRouteChange } : {})
    });

    return advertising;
  }

  /** Where Playout is, proven. Null when nothing answered anywhere. */
  async resolvePlayout(): Promise<ResolvedEndpoint | null> {
    return this.resolver?.resolve() ?? null;
  }

  /** Force the next resolution to re-prove. Called when a publish to the current endpoint fails. */
  async forgetPlayout(): Promise<void> {
    await this.resolver?.invalidate();
  }

  status(): DiscoveryStatus {
    return {
      advertising: this.advertiser !== null,
      instance: this.advertiser?.instance ?? null,
      interfaces: this.advertiser?.interfaces() ?? [],
      unavailableReason: this.unavailableReason,
      playout: this.resolver?.currentEndpoint() ?? null,
      discoveredPlayout: this.browser?.services() ?? []
    };
  }

  /** Withdraw from the link and release the sockets. */
  async stop(): Promise<void> {
    await this.advertiser?.stop();
    this.advertiser = null;
    this.browser?.stop();
    this.browser = null;
    this.resolver = null;
  }
}

/**
 * Prove a candidate really is a Playout control service.
 *
 * Its own health route names the service, so this checks the name rather than merely that
 * something accepted a connection. Port 4300 on an unknown machine could be anything, and
 * publishing a scene into "anything" is exactly the mistake discovery could otherwise cause.
 */
export async function verifyPlayout(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/api/playout/health`, {
      signal: AbortSignal.timeout(1200)
    });
    if (!response.ok) return false;
    const payload: unknown = await response.json();
    return (
      typeof payload === "object"
      && payload !== null
      && "service" in payload
      && payload.service === "grapix-playout-control"
    );
  } catch {
    return false;
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
