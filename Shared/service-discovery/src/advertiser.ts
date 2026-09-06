/**
 * Announcing a GrapiX service on the local link.
 *
 * DNS-SD (RFC 6763) in the shape a peer expects: a PTR record enumerating the instance under
 * the service type, an SRV record giving host and port, a TXT record carrying who we are, and A
 * records for every address the host can be reached on.
 *
 * What is deliberately **not** implemented, and why:
 *
 * - **Probing and name conflict resolution.** The full protocol probes a name three times
 *   before claiming it. Instance names here already carry a random suffix, so a genuine
 *   collision means two processes generated the same 32-bit value; the cost of that is one
 *   ambiguous entry in a discovery list, and the cost of probing is a second of startup delay
 *   plus a state machine on the path of a fallback. If a collision is ever observed, the
 *   suffix widens.
 * - **Known-answer suppression.** A responder may stay quiet when the querier already lists
 *   the answer. Skipping it costs a few hundred bytes on a link that carries video.
 * - **IPv6/AAAA.** Advertised addresses are IPv4. GrapiX services bind IPv4 by default, and an
 *   AAAA record for an address nothing listens on is worse than no record.
 *
 * Every one of those is a deliberate reduction, not an oversight, and none of them stops a
 * conforming implementation from resolving what we publish.
 */

import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import {
  CACHE_FLUSH,
  CLASS_IN,
  FLAG_RESPONSE,
  RECORD_TYPE,
  UNICAST_RESPONSE,
  decodeMessage,
  encodeMessage,
  type DnsMessage,
  type EncodableRecord,
  type OutgoingMessage
} from "./dns.js";
import { MdnsSocket, advertisableAddresses } from "./socket.js";

/**
 * Record lifetime, in seconds.
 *
 * 120 for everything, including PTR, where RFC 6763 suggests 4500. A GrapiX machine is
 * deliberately transient — a truck powers down, an operator station is rebooted between shows —
 * and a peer holding a 75-minute-stale pointer to a service that is gone would keep offering an
 * operator an endpoint that cannot answer. Re-announcing every minute against a 120-second TTL
 * costs one small packet per service per minute.
 */
export const RECORD_TTL_SECONDS = 120;

/** How often an advertisement is repeated, in milliseconds. Half the TTL, so one loss is survivable. */
const REANNOUNCE_MS = 60_000;

export interface AdvertisedService {
  /** DNS-SD service type, e.g. `_grapix-editor._tcp`. */
  type: string;
  /** Human-facing instance name. A random suffix is appended for uniqueness. */
  name: string;
  port: number;
  /** DNS-SD TXT metadata. Keys are lower-case by convention (RFC 6763 §6.4). */
  txt?: Record<string, string>;
}

export interface AdvertiserOptions {
  /** Injected in tests. Defaults to a shared multicast socket. */
  socket?: MdnsSocket;
  onError?: (error: Error) => void;
  /** Overrides the addresses published in A records. Injected in tests. */
  addresses?: string[];
}

/**
 * A live advertisement.
 *
 * `instance` is the fully qualified instance name a peer will see, and is also how the browser
 * on this side recognises and ignores its own announcements.
 */
export class ServiceAdvertiser {
  readonly instance: string;
  readonly hostName: string;

  private readonly service: AdvertisedService;
  private readonly socket: MdnsSocket;
  private readonly ownsSocket: boolean;
  private readonly addresses: string[];
  private timer: ReturnType<typeof setInterval> | null = null;
  private started = false;

  constructor(service: AdvertisedService, options: AdvertiserOptions = {}) {
    this.service = service;
    this.addresses = options.addresses ?? advertisableAddresses();
    this.ownsSocket = options.socket === undefined;
    this.socket =
      options.socket
      ?? new MdnsSocket({
        onPacket: (packet) => this.handlePacket(packet.data, packet.address, packet.port),
        ...(options.onError ? { onError: options.onError } : {})
      });

    // A suffix, not a bare name: two Editors on one link are normal, and an instance name is
    // the primary key of the whole protocol.
    const suffix = randomBytes(3).toString("hex");
    this.instance = `${service.name} ${suffix}.${service.type}.local`;
    // Not the real host name: a machine name may repeat inside a venue, and the A records are
    // published under whatever this says, so it must be unique to the instance.
    this.hostName = `grapix-${sanitiseLabel(hostname())}-${suffix}.local`;
  }

  /**
   * Start announcing.
   *
   * Returns false when the socket could not be opened — a held port, a firewall, no multicast
   * interface. The caller keeps working with its configured endpoint; nothing here throws.
   */
  async start(): Promise<boolean> {
    if (this.started) return true;
    if (!(await this.socket.open())) return false;
    this.started = true;

    // Twice, a second apart (RFC 6762 §8.3 recommends two to eight): the first can be lost to a
    // switch still learning the group membership.
    this.announce();
    const second = setTimeout(() => this.announce(), 1000);
    second.unref?.();

    this.timer = setInterval(() => this.announce(), REANNOUNCE_MS);
    this.timer.unref?.();
    return true;
  }

  /**
   * Stop announcing and tell the link.
   *
   * The goodbye (the same records at TTL 0, RFC 6762 §10.1) is what stops a peer offering an
   * operator an endpoint that has just been shut down. Sent twice, for the same reason
   * announcements are.
   *
   * Awaited, not fired and forgotten: closing the socket in the same turn discarded the datagram
   * before the OS had it, so a peer kept the withdrawn service in its cache for the full TTL —
   * which on a shutdown is two minutes of offering an operator an endpoint that is gone.
   */
  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.started) {
      this.started = false;
      const farewell = encodeMessage(response(this.records(0)));
      await Promise.allSettled([this.socket.send(farewell), this.socket.send(farewell)]);
    }
    if (this.ownsSocket) this.socket.close();
  }

  /** Interfaces the announcement actually goes out on. For diagnostics, not for policy. */
  interfaces(): string[] {
    return this.socket.interfaces();
  }

  /** Feed a received packet. Public so one socket can serve an advertiser and a browser. */
  handlePacket(data: Uint8Array, address: string, port: number): void {
    if (!this.started) return;
    const message = decodeQuery(data);
    if (!message) return;

    const asksForUs = message.questions.some((question) => this.answers(question.name, question.type));
    if (!asksForUs) return;

    const packet = encodeMessage(response(this.records(RECORD_TTL_SECONDS)));
    // A unicast-response request is answered directly. Answering the group instead is legal but
    // makes a one-to-one query cost every listener a packet.
    const unicast = message.questions.some((question) => (question.class & UNICAST_RESPONSE) !== 0);
    this.socket.send(packet, unicast ? { address, port } : undefined);
  }

  /** The records this advertisement publishes, at the given TTL. */
  records(ttl: number): EncodableRecord[] {
    const serviceType = `${this.service.type}.local`;
    const records: EncodableRecord[] = [
      // PTR is not cache-flush: several instances share this name, and flushing would delete
      // every other Editor a peer knows about.
      { name: serviceType, type: RECORD_TYPE.PTR, class: CLASS_IN, ttl, target: this.instance },
      {
        name: this.instance,
        type: RECORD_TYPE.SRV,
        class: CLASS_IN | CACHE_FLUSH,
        ttl,
        priority: 0,
        weight: 0,
        port: this.service.port,
        target: this.hostName
      },
      {
        name: this.instance,
        type: RECORD_TYPE.TXT,
        class: CLASS_IN | CACHE_FLUSH,
        ttl,
        text: this.service.txt ?? {}
      }
    ];

    for (const address of this.addresses) {
      records.push({
        name: this.hostName,
        type: RECORD_TYPE.A,
        class: CLASS_IN | CACHE_FLUSH,
        ttl,
        address
      });
    }
    return records;
  }

  private announce(): void {
    this.socket.send(encodeMessage(response(this.records(RECORD_TTL_SECONDS))));
  }

  /** Whether a question names something this advertisement owns. */
  private answers(name: string, type: number): boolean {
    const lower = name.toLowerCase();
    const serviceType = `${this.service.type}.local`.toLowerCase();
    const wanted = type === RECORD_TYPE.ANY;

    if (lower === serviceType) return wanted || type === RECORD_TYPE.PTR;
    if (lower === this.instance.toLowerCase()) {
      return wanted || type === RECORD_TYPE.SRV || type === RECORD_TYPE.TXT;
    }
    if (lower === this.hostName.toLowerCase()) return wanted || type === RECORD_TYPE.A;
    // The meta-query every browser tool uses to list what a host offers.
    return lower === "_services._dns-sd._udp.local" && (wanted || type === RECORD_TYPE.PTR);
  }
}

/** A response packet carrying `records` as answers. */
function response(records: EncodableRecord[]): OutgoingMessage {
  // Everything in the answer section rather than split across answers/additionals: a resolver
  // that ignores additionals then still gets host and port from one packet.
  return { id: 0, flags: FLAG_RESPONSE, questions: [], answers: records, additionals: [] };
}

/** Decode a packet only if it is a query. A response is another responder's business. */
function decodeQuery(data: Uint8Array): DnsMessage | null {
  const message = decodeMessage(data);
  if (!message || (message.flags & FLAG_RESPONSE_BIT) !== 0) return null;
  return message.questions.length > 0 ? message : null;
}

/** The QR bit on its own: `FLAG_RESPONSE` also carries the authoritative-answer bit. */
const FLAG_RESPONSE_BIT = 0x8000;

/** A DNS label may not contain a dot, and a host name with one would silently split. */
function sanitiseLabel(value: string): string {
  return value.replace(/[^A-Za-z0-9-]/g, "-").slice(0, 40) || "host";
}
