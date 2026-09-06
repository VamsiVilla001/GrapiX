/**
 * The multicast socket every responder and browser here shares.
 *
 * Two properties matter more than anything else in this file:
 *
 * 1. **Loopback multicast stays on.** The case this facility exists for is two GrapiX
 *    applications on one machine, or on one switch, with no DNS and no router. If multicast
 *    loopback were off, two processes on the same host would never see each other — which is
 *    exactly the situation an operator is in when the network "is lost".
 * 2. **A failure to open is never fatal.** Port 5353 may already be held by Bonjour or Avahi
 *    with different socket options, a Windows firewall profile may refuse multicast, and a
 *    machine may have no non-loopback interface at all. Discovery is a *fallback*: if it
 *    cannot start, the caller must keep working with its configured endpoint and say so.
 *    Nothing in this module throws into a service's startup path.
 *
 * SO_REUSEADDR is required, not optional: it is what lets this coexist with the operating
 * system's own responder rather than fighting it for the port.
 */

import { createSocket, type Socket } from "node:dgram";
import { networkInterfaces } from "node:os";

/** The IPv4 mDNS group and port (RFC 6762 §3). */
export const MDNS_ADDRESS = "224.0.0.251";
export const MDNS_PORT = 5353;

/**
 * Hop limit for multicast (RFC 6762 §11).
 *
 * 255 rather than 1: the value is what lets a conforming implementation detect and reject a
 * packet that has been routed, which is a stronger guarantee than trusting a TTL of 1 not to
 * be forwarded.
 */
const MULTICAST_TTL = 255;

export interface IncomingPacket {
  data: Uint8Array;
  address: string;
  port: number;
}

export interface MdnsSocketEvents {
  onPacket: (packet: IncomingPacket) => void;
  /** Reported, never thrown. A caller decides whether a degraded fallback is worth logging. */
  onError?: (error: Error) => void;
}

/**
 * One shared IPv4 multicast socket.
 *
 * Interface membership is added per address rather than once on `0.0.0.0`, because a machine
 * with several NICs — normal on a broadcast station, where one is on the production network and
 * one on a control VLAN — otherwise joins on whichever the routing table prefers, and the peer
 * on the other one is invisible. A membership that cannot be added is skipped: an interface
 * that is up but not multicast-capable must not stop the others working.
 */
export class MdnsSocket {
  private socket: Socket | null = null;
  private readonly events: MdnsSocketEvents;
  private opening: Promise<boolean> | null = null;
  private joined: string[] = [];
  private lastError: Error | null = null;

  constructor(events: MdnsSocketEvents) {
    this.events = events;
  }

  /** True once the socket is bound. Repeat calls share one attempt. */
  async open(): Promise<boolean> {
    if (this.socket) return true;
    if (this.opening) return this.opening;


    const { promise, resolve } = Promise.withResolvers<boolean>();
    this.opening = promise.finally(() => {
      this.opening = null;
    });

    const socket = createSocket({ type: "udp4", reuseAddr: true });

    const fail = (error: Error) => {
      this.lastError = error;
      this.events.onError?.(error);
      socket.removeAllListeners();
      try {
        socket.close();
      } catch {
        // Never bound; nothing to release.
      }
      this.socket = null;
      resolve(false);
    };

    socket.once("error", fail);

    socket.on("message", (data, remote) => {
      this.events.onPacket({ data, address: remote.address, port: remote.port });
    });

    socket.bind({ port: MDNS_PORT, address: "0.0.0.0" }, () => {
      socket.removeListener("error", fail);
      // After binding, an error is a transient send or membership failure, not a startup
      // failure: report it and keep the socket.
      socket.on("error", (error) => {
        this.lastError = error;
        this.events.onError?.(error);
      });

      try {
        socket.setMulticastTTL(MULTICAST_TTL);
        socket.setMulticastLoopback(true);
      } catch (error) {
        this.events.onError?.(asError(error));
      }

      this.joined = [];
      for (const address of multicastInterfaces()) {
        try {
          socket.addMembership(MDNS_ADDRESS, address);
          this.joined.push(address);
        } catch (error) {
          // One unusable interface must not cost us the others.
          this.events.onError?.(asError(error));
        }
      }

      if (this.joined.length === 0) {
        // A machine with no multicast-capable interface still has loopback, and two processes on
        // one host is the case that matters most. `addMembership` with no interface lets the OS
        // choose, which is the best available answer.
        try {
          socket.addMembership(MDNS_ADDRESS);
          this.joined.push("default");
        } catch (error) {
          fail(asError(error));
          return;
        }
      }

      this.socket = socket;
      resolve(true);
    });

    return promise;
  }

  /**
   * Send to the group.
   *
   * The returned promise settles when the datagram has been handed to the operating system, and
   * a send failure resolves rather than rejecting: mDNS is not a reliable transport and a lost
   * announcement is repeated on the next interval. Awaiting matters in exactly one place — a
   * goodbye must reach the link before the socket closes, or a peer keeps offering a service that
   * has already stopped.
   */
  send(packet: Uint8Array, destination?: { address: string; port: number }): Promise<void> {
    const socket = this.socket;
    if (!socket) return Promise.resolve();

    const { promise, resolve } = Promise.withResolvers<void>();
    socket.send(
      packet,
      destination?.port ?? MDNS_PORT,
      destination?.address ?? MDNS_ADDRESS,
      (error) => {
        if (error) this.events.onError?.(error);
        resolve();
      }
    );
    return promise;
  }

  /** Interfaces the socket actually joined, for diagnostics. */
  interfaces(): string[] {
    return [...this.joined];
  }

  get error(): Error | null {
    return this.lastError;
  }

  get isOpen(): boolean {
    return this.socket !== null;
  }

  close(): void {
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    socket.removeAllListeners();
    try {
      socket.close();
    } catch {
      // Already closed.
    }
  }
}

/**
 * IPv4 addresses worth joining the group on.
 *
 * Internal (loopback) interfaces are included on purpose — see the module note about two
 * processes on one machine. A link-local 169.254 address is included too: it is precisely what
 * a host assigns itself when DHCP is gone, which is the failure this whole path serves.
 */
export function multicastInterfaces(): string[] {
  const addresses: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4") continue;
      addresses.push(entry.address);
    }
  }
  return addresses;
}

/**
 * Addresses to advertise for this host.
 *
 * Loopback is listed last rather than omitted: a peer on another machine cannot use 127.0.0.1,
 * but a peer in another process on this one can, and it is the only address that survives every
 * interface going down.
 */
export function advertisableAddresses(): string[] {
  const routable: string[] = [];
  const loopback: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4") continue;
      if (entry.internal) loopback.push(entry.address);
      else routable.push(entry.address);
    }
  }
  return [...routable, ...loopback];
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
