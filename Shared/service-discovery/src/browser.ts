/**
 * Finding GrapiX services on the local link.
 *
 * A browser holds a cache of instances assembled from whatever arrives: a PTR names an
 * instance, an SRV gives its host and port, a TXT its metadata, an A its addresses. Those may
 * arrive in one packet or four, in any order, from a responder that answers only part of what it
 * knows — so an instance is *incomplete* until it has both a port and at least one address, and
 * an incomplete instance is never offered to a caller. Half a record set resolves to an endpoint
 * that cannot be dialled, which is worse than reporting nothing.
 *
 * Entries expire on their TTL and disappear immediately on a goodbye (TTL 0). Both matter: a
 * machine that is switched off mid-show stops being offered as an endpoint within two minutes,
 * and one that shuts down cleanly stops being offered at once.
 */

import { CLASS_IN, RECORD_TYPE, decodeMessage, encodeMessage, type DnsRecord } from "./dns.js";
import { MdnsSocket } from "./socket.js";

/** One discovered service instance. */
export interface DiscoveredService {
  /** Fully qualified instance name — the primary key of DNS-SD. */
  instance: string;
  /** The friendly part, with the service type and `.local` removed. */
  name: string;
  type: string;
  /** Advertised host name. Not resolvable through DNS; the addresses are what to dial. */
  host: string;
  port: number;
  /** Every address the responder published, routable ones first. */
  addresses: string[];
  txt: Record<string, string>;
  /** When the last record for this instance was seen. */
  seenAtMs: number;
  /** Wall-clock expiry from the shortest TTL seen. */
  expiresAtMs: number;
}

export interface BrowserOptions {
  /** Injected in tests. Defaults to a shared multicast socket. */
  socket?: MdnsSocket;
  onError?: (error: Error) => void;
  /** Called whenever the instance set changes, for a UI that wants to react. */
  onChange?: (services: DiscoveredService[]) => void;
  /** Injected in tests so expiry is deterministic. */
  now?: () => number;
  /** Instance names to ignore — normally this process's own advertisements. */
  ignoreInstances?: string[];
}

/** How often the query is repeated while browsing, in milliseconds. */
const QUERY_INTERVAL_MS = 30_000;

interface PartialInstance {
  instance: string;
  type: string;
  host?: string;
  port?: number;
  addresses: string[];
  txt: Record<string, string>;
  seenAtMs: number;
  expiresAtMs: number;
}

/**
 * A live browse for one or more service types.
 *
 * One browser can watch several types, because one socket and one cache is cheaper than a
 * responder per type and the packets are shared anyway.
 */
export class ServiceBrowser {
  private readonly types: string[];
  private readonly socket: MdnsSocket;
  private readonly ownsSocket: boolean;
  private readonly options: BrowserOptions;
  private readonly now: () => number;
  private readonly instances = new Map<string, PartialInstance>();
  /** Host name -> addresses, because an A record arrives keyed by host, not by instance. */
  private readonly hosts = new Map<string, string[]>();
  private readonly ignored: Set<string>;
  private timer: ReturnType<typeof setInterval> | null = null;
  private started = false;

  constructor(types: string[], options: BrowserOptions = {}) {
    this.types = types.map((type) => type.toLowerCase());
    this.options = options;
    this.now = options.now ?? Date.now;
    this.ignored = new Set((options.ignoreInstances ?? []).map((name) => name.toLowerCase()));
    this.ownsSocket = options.socket === undefined;
    this.socket =
      options.socket
      ?? new MdnsSocket({
        onPacket: (packet) => this.handlePacket(packet.data),
        ...(options.onError ? { onError: options.onError } : {})
      });
  }

  /** Start browsing. False when the socket could not be opened; the caller degrades, never fails. */
  async start(): Promise<boolean> {
    if (this.started) return true;
    if (!(await this.socket.open())) return false;
    this.started = true;

    this.query();
    // A second query shortly after the first: the initial one can be lost while a switch learns
    // the group, and waiting a full interval to find a peer that is already there is a long time
    // to leave an operator looking at a failure.
    const soon = setTimeout(() => this.query(), 1200);
    soon.unref?.();

    this.timer = setInterval(() => this.query(), QUERY_INTERVAL_MS);
    this.timer.unref?.();
    return true;
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.started = false;
    if (this.ownsSocket) this.socket.close();
  }

  /** Ask the link now. Used on start, on the interval, and when a caller needs a fresh answer. */
  query(): void {
    if (!this.socket.isOpen) return;
    for (const type of this.types) {
      this.socket.send(
        encodeMessage({
          id: 0,
          flags: 0,
          questions: [
            {
              name: `${type}.local`,
              type: RECORD_TYPE.PTR,
              // Multicast response requested: every other browser on the link benefits from the
              // answer, and on a quiet link that is how a late joiner fills its cache for free.
              class: CLASS_IN
            }
          ],
          answers: [],
          additionals: []
        })
      );
    }
  }

  /**
   * Ask, then wait for an answer.
   *
   * The wait is bounded and returns whatever is known when it elapses rather than throwing: a
   * caller resolving an endpoint has a configured value to fall back to, and a rejection here
   * would turn "nothing answered" into an error path.
   */
  async discover(timeoutMs = 1500): Promise<DiscoveredService[]> {
    if (!(await this.start())) return [];
    this.query();
    const deadline = this.now() + timeoutMs;
    for (;;) {
      const found = this.services();
      if (found.length > 0) return found;
      if (this.now() >= deadline) return this.services();
      await sleep(100);
    }
  }

  /** Complete, unexpired instances, newest sighting first. */
  services(): DiscoveredService[] {
    const now = this.now();
    const found: DiscoveredService[] = [];
    for (const [key, candidate] of this.instances) {
      if (candidate.expiresAtMs <= now) {
        this.instances.delete(key);
        continue;
      }
      const addresses = candidate.addresses.length > 0
        ? candidate.addresses
        : this.hosts.get(candidate.host?.toLowerCase() ?? "") ?? [];
      // Incomplete: see the module note. A port with no address, or an address with no port, is
      // not an endpoint.
      if (candidate.port === undefined || addresses.length === 0) continue;
      found.push({
        instance: candidate.instance,
        name: friendlyName(candidate.instance, candidate.type),
        type: candidate.type,
        host: candidate.host ?? "",
        port: candidate.port,
        addresses: [...addresses],
        txt: { ...candidate.txt },
        seenAtMs: candidate.seenAtMs,
        expiresAtMs: candidate.expiresAtMs
      });
    }
    return found.sort((left, right) => right.seenAtMs - left.seenAtMs);
  }

  /** Feed a received packet. Public so one socket can serve a browser and an advertiser. */
  handlePacket(data: Uint8Array): void {
    const message = decodeMessage(data);
    if (!message) return;

    let changed = false;
    // Addresses first: an A record in the same packet as its SRV must already be in the host map
    // when the instance is completed, or the instance stays incomplete until the next packet.
    for (const record of [...message.answers, ...message.additionals]) {
      if (record.type === RECORD_TYPE.A || record.type === RECORD_TYPE.AAAA) {
        changed = this.recordAddress(record) || changed;
      }
    }
    for (const record of [...message.answers, ...message.additionals]) {
      if (record.type === RECORD_TYPE.A || record.type === RECORD_TYPE.AAAA) continue;
      changed = this.recordInstance(record) || changed;
    }

    if (changed) this.options.onChange?.(this.services());
  }

  private recordAddress(record: DnsRecord): boolean {
    if (record.type !== RECORD_TYPE.A && record.type !== RECORD_TYPE.AAAA) return false;
    if (!("address" in record)) return false;
    const host = record.name.toLowerCase();

    if (record.ttl === 0) {
      const remaining = (this.hosts.get(host) ?? []).filter((address) => address !== record.address);
      if (remaining.length > 0) this.hosts.set(host, remaining);
      else this.hosts.delete(host);
      return true;
    }

    const known = this.hosts.get(host) ?? [];
    if (known.includes(record.address)) return false;
    // Routable addresses first: a peer in another process on this machine can use 127.0.0.1, but
    // it is the last thing to try, because a peer on another machine cannot.
    const ordered = isLoopback(record.address) ? [...known, record.address] : [record.address, ...known];
    this.hosts.set(host, ordered);
    return true;
  }

  private recordInstance(record: DnsRecord): boolean {
    const type = this.typeOf(record);
    if (!type) return false;

    const instanceName = record.type === RECORD_TYPE.PTR && "target" in record ? record.target : record.name;
    if (this.ignored.has(instanceName.toLowerCase())) return false;
    const key = instanceName.toLowerCase();

    // A goodbye. Removing the whole instance rather than one record: a responder saying its PTR
    // is gone means the service is gone, and keeping the SRV would leave a dialable endpoint.
    if (record.ttl === 0) {
      return this.instances.delete(key);
    }

    const now = this.now();
    const expiry = now + record.ttl * 1000;
    const existing = this.instances.get(key);
    const candidate: PartialInstance = existing ?? {
      instance: instanceName,
      type,
      addresses: [],
      txt: {},
      seenAtMs: now,
      expiresAtMs: expiry
    };
    candidate.seenAtMs = now;
    // The shortest TTL wins while the records are fresh; a re-announcement extends it. Taking the
    // longest would let a 4500-second PTR keep an instance alive long after its SRV expired.
    candidate.expiresAtMs = existing ? Math.max(existing.expiresAtMs, expiry) : expiry;

    if (record.type === RECORD_TYPE.SRV && "port" in record) {
      candidate.port = record.port;
      candidate.host = record.target;
      const addresses = this.hosts.get(record.target.toLowerCase());
      if (addresses) candidate.addresses = [...addresses];
    }
    if (record.type === RECORD_TYPE.TXT && "text" in record) {
      candidate.txt = record.text;
    }

    this.instances.set(key, candidate);
    return true;
  }

  /** Which of the browsed types a record belongs to, if any. */
  private typeOf(record: DnsRecord): string | undefined {
    const name = (
      record.type === RECORD_TYPE.PTR && "target" in record ? record.target : record.name
    ).toLowerCase();
    return this.types.find((type) => name === `${type}.local` || name.endsWith(`.${type}.local`));
  }
}

/** A cancellation-free bounded pause. Timers are unref'd so a browse never holds the process. */
function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const timer = setTimeout(resolve, ms);
  timer.unref?.();
  return promise;
}

function friendlyName(instance: string, type: string): string {
  const suffix = `.${type}.local`;
  const lower = instance.toLowerCase();
  return lower.endsWith(suffix) ? instance.slice(0, instance.length - suffix.length) : instance;
}

function isLoopback(address: string): boolean {
  return address.startsWith("127.") || address === "::1";
}
