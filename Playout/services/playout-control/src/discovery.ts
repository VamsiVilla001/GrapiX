/**
 * How Playout is found, and how it finds the Editor, when the network is not helping.
 *
 * `syncFromEditor` reaches the Editor at `GRAPIX_EDITOR_API_URL` or `http://127.0.0.1:4100`. Both
 * assume something: the first that a name still resolves and a route still exists, the second that
 * the Editor is on this machine. Take DHCP, DNS or the gateway away — a truck on a dead uplink, a
 * venue switch that lost its router — and Playout can no longer fetch from an Editor sitting on
 * the same switch, though nothing is wrong with the link itself.
 *
 * So the control service announces itself and browses for Editors, and `EndpointResolver` decides
 * which address to use: configured first, then what worked last, then this machine, then the link.
 * Every candidate is proven against the Editor's own health route before it is adopted, because
 * something answering on 4100 is not evidence that it is a GrapiX project service.
 *
 * Failing to open the multicast socket is not a failure of this service. It is reported into the
 * operator console — where an operator can find out that the fallback is not available — and
 * everything else runs exactly as before.
 */

import {
  EndpointResolver,
  GRAPIX_SERVICE_TYPES,
  ServiceAdvertiser,
  ServiceBrowser,
  type DiscoveredService,
  type ResolvedEndpoint
} from "@grapix/service-discovery";

import type { DiagnosticsLog } from "./diagnostics.js";

/** The Editor project service's own default. */
const EDITOR_LOOPBACK = "http://127.0.0.1:4100";

export interface PlayoutDiscoveryOptions {
  /** The port the control service is listening on. */
  port: number;
  version: string;
  /** Where discovery reports itself. Engine-link events use the same log. */
  diagnostics?: DiagnosticsLog;
}

export interface PlayoutDiscoveryStatus {
  advertising: boolean;
  instance: string | null;
  interfaces: string[];
  unavailableReason: string | null;
  /** The Editor endpoint in use, and how it was arrived at. */
  editor: ResolvedEndpoint | null;
  discoveredEditors: DiscoveredService[];
}

export class PlayoutDiscovery {
  private readonly options: PlayoutDiscoveryOptions;
  private advertiser: ServiceAdvertiser | null = null;
  private browser: ServiceBrowser | null = null;
  private resolver: EndpointResolver | null = null;
  private unavailableReason: string | null = null;

  constructor(options: PlayoutDiscoveryOptions) {
    this.options = options;
  }

  /** Begin advertising and browsing. Never throws; the return value says whether the fallback exists. */
  async start(): Promise<boolean> {
    const advertiser = new ServiceAdvertiser(
      {
        type: GRAPIX_SERVICE_TYPES.playout,
        name: "GrapiX Playout",
        port: this.options.port,
        txt: { role: "playout", api: "/api/playout", v: this.options.version }
      },
      { onError: (error) => this.warn("mDNS socket error", error) }
    );

    let advertising = false;
    try {
      advertising = await advertiser.start();
    } catch (error) {
      advertising = false;
      this.warn("advertising Playout on the local link failed", asError(error));
    }

    if (advertising) {
      this.advertiser = advertiser;
      this.options.diagnostics?.record({
        level: "info",
        source: "discovery",
        detail: {
          code: "discovery.advertising",
          summary: `Playout is announcing itself on the local link as ${advertiser.instance}`,
          context: { port: this.options.port, interfaces: advertiser.interfaces() }
        }
      });
    } else {
      this.unavailableReason =
        "the mDNS socket could not be opened — port 5353 may be held by the system responder, or multicast may be blocked by a firewall";
      this.options.diagnostics?.record({
        level: "warning",
        source: "discovery",
        detail: {
          code: "discovery.unavailable",
          summary: "Local-link discovery is not available, so only configured addresses can be used",
          cause: this.unavailableReason,
          remedy:
            "Nothing is broken by this on a working network. To have the fallback available, allow UDP 5353 for this process, or stop a conflicting mDNS responder.",
          context: { port: this.options.port }
        }
      });
    }

    // Attempted even when advertising failed: separate sockets, and being unable to announce does
    // not imply being unable to listen.
    const browser = new ServiceBrowser([GRAPIX_SERVICE_TYPES.editor], {
      onError: (error) => this.warn("mDNS browse error", error)
    });
    if (await browser.start()) this.browser = browser;

    this.resolver = new EndpointResolver({
      serviceType: GRAPIX_SERVICE_TYPES.editor,
      configured: process.env.GRAPIX_EDITOR_API_URL?.trim() || undefined,
      loopback: EDITOR_LOOPBACK,
      verify: verifyEditor,
      ...(this.browser ? { browser: this.browser } : {}),
      onRouteChange: (endpoint, previous) => this.reportRoute(endpoint, previous)
    });

    return advertising;
  }

  /**
   * The Editor endpoint to use now.
   *
   * Null when nothing answered anywhere, which the caller must report as such: "no Editor" and
   * "the Editor refused" are different failures with different remedies.
   */
  async resolveEditor(): Promise<ResolvedEndpoint | null> {
    return this.resolver?.resolve() ?? null;
  }

  /** Re-prove on the next call. Used when a fetch against the current endpoint fails. */
  async forgetEditor(): Promise<void> {
    await this.resolver?.invalidate();
  }

  status(): PlayoutDiscoveryStatus {
    return {
      advertising: this.advertiser !== null,
      instance: this.advertiser?.instance ?? null,
      interfaces: this.advertiser?.interfaces() ?? [],
      unavailableReason: this.unavailableReason,
      editor: this.resolver?.currentEndpoint() ?? null,
      discoveredEditors: this.browser?.services() ?? []
    };
  }

  async stop(): Promise<void> {
    await this.advertiser?.stop();
    this.advertiser = null;
    this.browser?.stop();
    this.browser = null;
    this.resolver = null;
  }

  /**
   * Announce a route change in the console.
   *
   * Worth a record every time: "Playout is now fetching from a machine it found on the link
   * instead of the address it was configured with" is exactly the kind of change that explains
   * later behaviour, and an operator should not have to infer it.
   */
  private reportRoute(endpoint: ResolvedEndpoint, previous: ResolvedEndpoint | null): void {
    this.options.diagnostics?.record({
      level: endpoint.isFallback ? "warning" : "info",
      source: "discovery",
      detail: {
        code: `discovery.editor-${endpoint.route}`,
        summary: endpoint.isFallback
          ? `Using a fallback address for the Editor: ${endpoint.url} (found by ${endpoint.route})`
          : `Editor is at ${endpoint.url}`,
        ...(previous ? { cause: `previously ${previous.url} (${previous.route})` } : {}),
        ...(endpoint.isFallback
          ? {
              remedy:
                "The configured address did not answer, so this is the address that did. Scenes fetched from here are the ones an operator will see; check it is the Editor you expect."
            }
          : {}),
        context: {
          url: endpoint.url,
          route: endpoint.route,
          configured: process.env.GRAPIX_EDITOR_API_URL?.trim() || EDITOR_LOOPBACK,
          ...(endpoint.instance
            ? { instance: endpoint.instance.name, host: endpoint.instance.host, addresses: endpoint.instance.addresses }
            : {})
        }
      }
    });
  }

  private warn(message: string, error?: Error): void {
    this.options.diagnostics?.record({
      level: "warning",
      source: "discovery",
      message,
      ...(error ? { error } : {})
    });
  }
}

/**
 * Prove a candidate really is a GrapiX project service.
 *
 * Its `/health` route names itself, so this checks the name. A bare connection check would let
 * Playout adopt any listener on 4100 and then present whatever it serves as a scene library.
 */
export async function verifyEditor(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1200) });
    if (!response.ok) return false;
    const payload: unknown = await response.json();
    return (
      typeof payload === "object"
      && payload !== null
      && "service" in payload
      && payload.service === "grapix-api"
    );
  } catch {
    return false;
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
