/**
 * Link-local service discovery for GrapiX.
 *
 * The problem this exists for: the Editor and Playout find each other through addresses that
 * assume a working network. `GRAPIX_EDITOR_API_URL` names a host, the defaults name
 * `127.0.0.1`, and a browser UI is handed its service URL at build time. Take DHCP, DNS or the
 * router away — a truck on a dead uplink, a venue switch that lost its gateway, a machine whose
 * name no longer resolves — and two applications sitting on the same switch, or on the *same
 * machine*, can no longer address each other even though nothing is actually wrong with the link.
 *
 * mDNS/DNS-SD (RFC 6762, RFC 6763) is the right answer to that: it needs no DNS server, no DHCP
 * and no configuration, and it works over link-local addresses and loopback. Each service
 * announces itself, each service browses for the peers it needs, and `EndpointResolver` decides
 * which address to use — configured first, discovered only as a fallback.
 *
 * Boundaries this respects:
 *
 * - **Discovery never overrules configuration.** An explicit address is an instruction. A
 *   discovered one is used when the instruction does not answer, and the route taken is reported
 *   rather than hidden.
 * - **A candidate is proven before it is adopted.** Something listening on 4300 is not proof that
 *   it is a GrapiX control service.
 * - **Failing to discover is not a failure.** If the socket cannot open — port held, firewall,
 *   no multicast interface — every caller keeps its configured behaviour unchanged.
 * - **Browsers cannot do this.** A web UI has no multicast API, so a browser asks its own local
 *   service where the peer is; it never speaks DNS-SD itself.
 */

export {
  CACHE_FLUSH,
  CLASS_IN,
  FLAG_RESPONSE,
  RECORD_TYPE,
  UNICAST_RESPONSE,
  decodeMessage,
  decodeName,
  decodeText,
  encodeMessage,
  encodeName,
  encodeText,
  type AddressRecord,
  type DnsMessage,
  type DnsQuestion,
  type DnsRecord,
  type EncodableRecord,
  type OutgoingMessage,
  type PtrRecord,
  type RawRecord,
  type RecordType,
  type SrvRecord,
  type TxtRecord
} from "./dns.js";

export {
  MDNS_ADDRESS,
  MDNS_PORT,
  MdnsSocket,
  advertisableAddresses,
  multicastInterfaces,
  type IncomingPacket,
  type MdnsSocketEvents
} from "./socket.js";

export {
  RECORD_TTL_SECONDS,
  ServiceAdvertiser,
  type AdvertisedService,
  type AdvertiserOptions
} from "./advertiser.js";

export {
  ServiceBrowser,
  type BrowserOptions,
  type DiscoveredService
} from "./browser.js";

export {
  EndpointResolver,
  instanceUrls,
  type EndpointResolverOptions,
  type EndpointRoute,
  type ResolvedEndpoint
} from "./endpoint.js";

/**
 * The service types GrapiX publishes.
 *
 * Named here rather than at each call site so an advertiser and a browser can never disagree
 * about a string, which is a failure that looks exactly like "the network is broken".
 *
 * The render engine is deliberately absent: nothing advertises it. It is reached through its
 * configured address or the loopback port scan that `@grapix/render-protocol` already performs,
 * and adding a browse for a type no responder publishes would be a discovery path that silently
 * never resolves.
 */
/**
 * The port register. Every port GrapiX binds, verified by `npm run check:ports`.
 *
 * It lives in this package because discovery is already the answer to "which service is where":
 * the register is what a service announces from, and what a peer falls back to when nothing has
 * been discovered.
 */
export {
  GRAPIX_RETIRED_PORTS,
  GRAPIX_SERVICE_PORTS,
  servicePort,
  whatClaimsPort,
  type GrapixServiceOwner,
  type GrapixServicePort
} from "./ports.js";

export const GRAPIX_SERVICE_TYPES = {
  /** The Editor project service (default port 4100). */
  editor: "_grapix-editor._tcp",
  /** The Playout control service (default port 4300). */
  playout: "_grapix-playout._tcp"
} as const;

/**
 * TXT keys both sides agree on.
 *
 * `role` is what a browser filters on, `api` is the path prefix a client should use, and
 * `instance` is a stable id so a peer that re-announces under a new address is recognised as the
 * same service rather than a second one.
 */
export const GRAPIX_TXT_KEYS = {
  role: "role",
  api: "api",
  version: "v",
  instance: "id",
  scheme: "scheme"
} as const;
