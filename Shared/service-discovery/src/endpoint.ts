/**
 * Choosing which address to talk to, and in which order.
 *
 * Discovery on its own does not fix anything. What fixes the failure an operator meets — "Playout
 * cannot see the Editor any more" — is a *policy*: try what you were told, then what worked last
 * time, then the local machine, then whatever answers on the link, and prove each candidate
 * before adopting it.
 *
 * The order is deliberate and each step earns its place:
 *
 * 1. **Configured.** An explicit `GRAPIX_*_URL` is an instruction, not a hint. A deployment that
 *    names an address must not be silently overruled by something that happens to answer a
 *    multicast query — that is how a rehearsal ends up driving the wrong machine.
 * 2. **Last known good.** Cheap, and almost always right: a service that answered a minute ago is
 *    the same service, and this avoids a discovery round trip on every call.
 * 3. **Loopback.** The one address that survives every interface going down. When "the network is
 *    lost" and both applications are on one machine, this is the answer, and it costs one local
 *    connection attempt to prove.
 * 4. **Discovered.** The link-local answer, for two machines on one switch with no DHCP and no
 *    DNS. Preferred candidates are the most recently seen; a routable address is tried before a
 *    loopback one, because a loopback address published by another host is meaningless here.
 *
 * Every candidate is proven with a caller-supplied `verify` before it is adopted, because
 * something listening on a port is not the same as the service you wanted: 4300 could be another
 * vendor's control surface, and adopting it would mean publishing scenes into it.
 */

import { ServiceBrowser, type DiscoveredService } from "./browser.js";

/** How an endpoint was arrived at. Reported so an operator can see it, not just infer it. */
export type EndpointRoute = "configured" | "remembered" | "loopback" | "discovered";

export interface ResolvedEndpoint {
  /** Origin, with no trailing slash: `http://127.0.0.1:4100`. */
  url: string;
  route: EndpointRoute;
  /** The discovered instance, when the route was `discovered`. */
  instance?: DiscoveredService;
  /** True when this differs from the configured or default address. */
  isFallback: boolean;
}

export interface EndpointResolverOptions {
  /** Service type to browse, e.g. `_grapix-editor._tcp`. */
  serviceType: string;
  /** Explicit address from configuration. Always tried first. */
  configured?: string | undefined;
  /** Loopback address to try when nothing configured answers. */
  loopback: string;
  /**
   * Proves a candidate is the service we want.
   *
   * Returning false must mean "this is not our service or it cannot answer". A `verify` that only
   * checks the socket opens turns this policy into a port scanner.
   */
  verify: (url: string) => Promise<boolean>;
  /** Shared browser. One per process is enough; several types can share it. */
  browser?: ServiceBrowser;
  /** How long a resolution is trusted before it is re-proven, in milliseconds. */
  trustForMs?: number;
  /** How long to wait for a discovery answer, in milliseconds. */
  discoveryTimeoutMs?: number;
  /** Called when the route changes, for diagnostics. Never called for a repeat of the same route. */
  onRouteChange?: (endpoint: ResolvedEndpoint, previous: ResolvedEndpoint | null) => void;
  now?: () => number;
}

/** Default trust window. Long enough to keep a hot path cheap, short enough to notice a move. */
const DEFAULT_TRUST_MS = 30_000;

/**
 * Resolves one service's endpoint, and remembers what worked.
 *
 * One resolver per peer service. It holds no socket of its own: the browser it is given (or the
 * one it lazily creates) owns that, so several resolvers on one process share a single
 * multicast socket.
 */
export class EndpointResolver {
  private readonly options: EndpointResolverOptions;
  private readonly now: () => number;
  private readonly trustForMs: number;
  private browser: ServiceBrowser | null;
  private current: ResolvedEndpoint | null = null;
  private provenAtMs = 0;
  private inFlight: Promise<ResolvedEndpoint | null> | null = null;

  constructor(options: EndpointResolverOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.trustForMs = options.trustForMs ?? DEFAULT_TRUST_MS;
    this.browser = options.browser ?? null;
  }

  /** The endpoint in use, without proving anything. Null until the first resolve. */
  currentEndpoint(): ResolvedEndpoint | null {
    return this.current;
  }

  /**
   * Resolve, using the trust window.
   *
   * Concurrent callers share one resolution: a service with an SSE fan-out and a poll loop will
   * ask at the same moment, and two simultaneous discovery rounds would double the traffic to
   * reach the same answer.
   */
  async resolve(): Promise<ResolvedEndpoint | null> {
    if (this.current && this.now() - this.provenAtMs < this.trustForMs) return this.current;
    if (this.inFlight) return this.inFlight;

    this.inFlight = this.resolveNow().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /**
   * Re-prove from scratch.
   *
   * Called when a request against the current endpoint fails: the trust window says the endpoint
   * was good, and the failure says it is not, so the failure wins.
   */
  async invalidate(): Promise<void> {
    this.provenAtMs = 0;
    // The remembered address stays as a candidate — it is still the most likely answer after a
    // transient failure — but it is no longer trusted without proof.
    this.browser?.query();
  }

  /** Walk the candidates in order, adopting the first that verifies. */
  private async resolveNow(): Promise<ResolvedEndpoint | null> {
    for (const candidate of this.candidates()) {
      if (await this.options.verify(candidate.url)) return this.adopt(candidate);
    }

    // Nothing local answered. Discovery is the last resort because it costs a round trip on the
    // link, and because a configured address that works must always win over one that is merely
    // present.
    for (const instance of await this.discover()) {
      for (const url of instanceUrls(instance)) {
        if (await this.options.verify(url)) {
          return this.adopt({ url, route: "discovered", instance, isFallback: true });
        }
      }
    }

    return null;
  }

  /** Configured, remembered and loopback candidates, in order, without duplicates. */
  private candidates(): ResolvedEndpoint[] {
    const configured = normaliseUrl(this.options.configured);
    const loopback = normaliseUrl(this.options.loopback);
    const ordered: ResolvedEndpoint[] = [];
    const seen = new Set<string>();

    const add = (url: string | undefined, route: EndpointRoute, isFallback: boolean) => {
      if (!url || seen.has(url)) return;
      seen.add(url);
      ordered.push({ url, route, isFallback });
    };

    add(configured, "configured", false);
    if (this.current) {
      add(
        this.current.url,
        "remembered",
        // A remembered address that is the configured one is not a fallback, however it was found.
        this.current.url !== configured
      );
    }
    add(loopback, "loopback", configured !== undefined && configured !== loopback);
    return ordered;
  }

  private async discover(): Promise<DiscoveredService[]> {
    if (!this.browser) {
      this.browser = new ServiceBrowser([this.options.serviceType]);
    }
    return this.browser.discover(this.options.discoveryTimeoutMs ?? 1500);
  }

  private adopt(endpoint: ResolvedEndpoint): ResolvedEndpoint {
    const previous = this.current;
    this.current = endpoint;
    this.provenAtMs = this.now();
    if (!previous || previous.url !== endpoint.url || previous.route !== endpoint.route) {
      this.options.onRouteChange?.(endpoint, previous);
    }
    return endpoint;
  }
}

/**
 * Every URL a discovered instance can be reached at, best first.
 *
 * A responder publishes each address it has, and only some of them are reachable from here: an
 * address on a VLAN this machine is not on will simply not connect, which is why `verify` decides
 * and this only orders. The TXT `scheme` key allows an https deployment to say so.
 */
export function instanceUrls(instance: DiscoveredService): string[] {
  const scheme = instance.txt.scheme === "https" ? "https" : "http";
  return instance.addresses.map((address) => `${scheme}://${formatHost(address)}:${instance.port}`);
}

function formatHost(address: string): string {
  return address.includes(":") ? `[${address}]` : address;
}

function normaliseUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  try {
    return new URL(trimmed).origin;
  } catch {
    return undefined;
  }
}
