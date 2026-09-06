/**
 * The DNS wire format, limited to what DNS-SD over multicast needs.
 *
 * Written by hand rather than taken from a package because this is a closed, stable format —
 * RFC 1035 sections 3 and 4, plus SRV from RFC 2782 — and the alternative is a dependency in
 * the path of a facility whose whole purpose is to work when nothing else does. Five record
 * types are needed and no more: PTR to enumerate instances, SRV for host and port, TXT for
 * metadata, A and AAAA for addresses.
 *
 * Reading must handle name compression, because every real responder (Bonjour, Avahi, a
 * Windows box) compresses. Writing deliberately does not: an uncompressed packet is always
 * legal, our packets are a few hundred bytes, and a compression bug produces a packet that is
 * silently misparsed by peers rather than one that fails loudly here.
 */

/** Record types used by DNS-SD. `ANY` appears only in questions. */
export const RECORD_TYPE = {
  A: 1,
  PTR: 12,
  TXT: 16,
  AAAA: 28,
  SRV: 33,
  ANY: 255
} as const;

export type RecordType = (typeof RECORD_TYPE)[keyof typeof RECORD_TYPE];

/** Internet class. mDNS overloads the top bit; see `CACHE_FLUSH` and `UNICAST_RESPONSE`. */
export const CLASS_IN = 1;

/**
 * "Replace everything you have cached for this name" (RFC 6762 §10.2), set on responses.
 *
 * Without it a peer keeps a stale address alongside the new one after a service moves to a
 * different interface, and then picks whichever it happens to try first.
 */
export const CACHE_FLUSH = 0x8000;

/** "Answer me directly, not to the group" (RFC 6762 §5.4), set on questions. */
export const UNICAST_RESPONSE = 0x8000;

export interface DnsQuestion {
  name: string;
  type: number;
  /** Raw class field, including the unicast-response bit. */
  class: number;
}

interface RecordHeader {
  name: string;
  /** Raw class field, including the cache-flush bit. */
  class: number;
  ttl: number;
}

export interface PtrRecord extends RecordHeader {
  type: typeof RECORD_TYPE.PTR;
  target: string;
}

export interface TxtRecord extends RecordHeader {
  type: typeof RECORD_TYPE.TXT;
  text: Record<string, string>;
}

export interface SrvRecord extends RecordHeader {
  type: typeof RECORD_TYPE.SRV;
  priority: number;
  weight: number;
  port: number;
  target: string;
}

export interface AddressRecord extends RecordHeader {
  type: typeof RECORD_TYPE.A | typeof RECORD_TYPE.AAAA;
  address: string;
}

/**
 * Anything else on the link, kept verbatim.
 *
 * Decode-only: this exists so a neighbour's NSEC or HINFO record travels through the parser
 * without being mistaken for one of ours, and it is deliberately not part of `EncodableRecord`
 * — nothing here ever needs to emit a record type it does not understand.
 */
export interface RawRecord extends RecordHeader {
  type: number;
  data: Uint8Array;
}

export type EncodableRecord = PtrRecord | TxtRecord | SrvRecord | AddressRecord;
export type DnsRecord = EncodableRecord | RawRecord;

/** A decoded packet. Sections hold `RawRecord` for anything this codec does not model. */
export interface DnsMessage {
  id: number;
  flags: number;
  questions: DnsQuestion[];
  answers: DnsRecord[];
  authorities: DnsRecord[];
  additionals: DnsRecord[];
}

/**
 * A packet to send.
 *
 * Separate from `DnsMessage` because only the five modelled record types can be encoded: the
 * type system, not a runtime check, is what stops a record read off the link from being
 * re-emitted as something we never verified.
 */
export interface OutgoingMessage {
  id: number;
  flags: number;
  questions: DnsQuestion[];
  answers: EncodableRecord[];
  additionals: EncodableRecord[];
}

/** Response bit in the header flags. A packet without it is a query. */
export const FLAG_RESPONSE = 0x8400;

/**
 * Encode a message.
 *
 * Truncation is not implemented: every packet this produces is one service's records, which is
 * far below the 1500-byte practical limit, and a silently truncated announcement is worse than
 * an oversized one. `encodeMessage` throws if a packet would exceed the limit rather than
 * emitting something a peer will misread.
 */
export function encodeMessage(message: OutgoingMessage): Uint8Array {
  const parts: Uint8Array[] = [];
  const header = new Uint8Array(12);
  const headerView = new DataView(header.buffer);
  headerView.setUint16(0, message.id);
  headerView.setUint16(2, message.flags);
  headerView.setUint16(4, message.questions.length);
  headerView.setUint16(6, message.answers.length);
  // No authority section is ever sent: it carries probe tie-breaking records, and this
  // responder does not contest a name — it renames itself instead (see `advertiser.ts`).
  headerView.setUint16(8, 0);
  headerView.setUint16(10, message.additionals.length);
  parts.push(header);

  for (const question of message.questions) {
    parts.push(encodeName(question.name));
    const tail = new Uint8Array(4);
    const view = new DataView(tail.buffer);
    view.setUint16(0, question.type);
    view.setUint16(2, question.class);
    parts.push(tail);
  }

  for (const section of [message.answers, message.additionals]) {
    for (const record of section) parts.push(encodeRecord(record));
  }

  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  if (total > 9000) {
    throw new Error(`mDNS packet of ${total} bytes is too large to send in one datagram`);
  }
  const packet = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    packet.set(part, offset);
    offset += part.byteLength;
  }
  return packet;
}

/**
 * Decode a message.
 *
 * Tolerant by design and never throws on hostile input: this reads packets from anything on
 * the link, including other vendors' responders and a malformed frame from a device that is
 * not ours. A record it cannot parse is skipped; a truncated packet yields what was readable.
 * Throwing here would let one bad neighbour take the discovery path down.
 */
export function decodeMessage(packet: Uint8Array): DnsMessage | null {
  if (packet.byteLength < 12) return null;
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  const message: DnsMessage = {
    id: view.getUint16(0),
    flags: view.getUint16(2),
    questions: [],
    answers: [],
    authorities: [],
    additionals: []
  };

  const counts = [view.getUint16(4), view.getUint16(6), view.getUint16(8), view.getUint16(10)];
  const cursor = { offset: 12 };

  try {
    for (let index = 0; index < counts[0]; index += 1) {
      const name = decodeName(packet, cursor);
      if (name === null || cursor.offset + 4 > packet.byteLength) return message;
      message.questions.push({
        name,
        type: view.getUint16(cursor.offset),
        class: view.getUint16(cursor.offset + 2)
      });
      cursor.offset += 4;
    }

    const sections = [message.answers, message.authorities, message.additionals];
    for (let section = 0; section < 3; section += 1) {
      for (let index = 0; index < counts[section + 1]; index += 1) {
        const record = decodeRecord(packet, view, cursor);
        if (!record) return message;
        sections[section].push(record);
      }
    }
  } catch {
    // A malformed packet yields whatever parsed cleanly. See the note above.
  }

  return message;
}

function encodeRecord(record: EncodableRecord): Uint8Array {
  const name = encodeName(record.name);
  const rdata = encodeRdata(record);
  const middle = new Uint8Array(10);
  const view = new DataView(middle.buffer);
  view.setUint16(0, record.type);
  view.setUint16(2, record.class);
  view.setUint32(4, record.ttl);
  view.setUint16(8, rdata.byteLength);

  const out = new Uint8Array(name.byteLength + middle.byteLength + rdata.byteLength);
  out.set(name, 0);
  out.set(middle, name.byteLength);
  out.set(rdata, name.byteLength + middle.byteLength);
  return out;
}

function encodeRdata(record: EncodableRecord): Uint8Array {
  switch (record.type) {
    case RECORD_TYPE.PTR:
      return encodeName(record.target);
    case RECORD_TYPE.TXT:
      return encodeText(record.text);
    case RECORD_TYPE.SRV: {
      const target = encodeName(record.target);
      const out = new Uint8Array(6 + target.byteLength);
      const view = new DataView(out.buffer);
      view.setUint16(0, record.priority);
      view.setUint16(2, record.weight);
      view.setUint16(4, record.port);
      out.set(target, 6);
      return out;
    }
    case RECORD_TYPE.A:
      return encodeIpv4(record.address);
    case RECORD_TYPE.AAAA:
      return encodeIpv6(record.address);
  }
}

function decodeRecord(packet: Uint8Array, view: DataView, cursor: { offset: number }): DnsRecord | null {
  const name = decodeName(packet, cursor);
  if (name === null || cursor.offset + 10 > packet.byteLength) return null;
  const type = view.getUint16(cursor.offset);
  const recordClass = view.getUint16(cursor.offset + 2);
  const ttl = view.getUint32(cursor.offset + 4);
  const length = view.getUint16(cursor.offset + 8);
  cursor.offset += 10;
  const start = cursor.offset;
  if (start + length > packet.byteLength) return null;
  cursor.offset = start + length;

  const base = { name, class: recordClass, ttl };
  switch (type) {
    case RECORD_TYPE.PTR: {
      const target = decodeName(packet, { offset: start });
      return target === null ? null : { ...base, type: RECORD_TYPE.PTR, target };
    }
    case RECORD_TYPE.TXT:
      return { ...base, type: RECORD_TYPE.TXT, text: decodeText(packet.subarray(start, start + length)) };
    case RECORD_TYPE.SRV: {
      if (length < 7) return null;
      const target = decodeName(packet, { offset: start + 6 });
      if (target === null) return null;
      return {
        ...base,
        type: RECORD_TYPE.SRV,
        priority: view.getUint16(start),
        weight: view.getUint16(start + 2),
        port: view.getUint16(start + 4),
        target
      };
    }
    case RECORD_TYPE.A: {
      if (length !== 4) return null;
      const bytes = packet.subarray(start, start + 4);
      return { ...base, type: RECORD_TYPE.A, address: `${bytes[0]}.${bytes[1]}.${bytes[2]}.${bytes[3]}` };
    }
    case RECORD_TYPE.AAAA: {
      if (length !== 16) return null;
      return { ...base, type: RECORD_TYPE.AAAA, address: decodeIpv6(packet.subarray(start, start + 16)) };
    }
    default:
      return { ...base, type, data: packet.slice(start, start + length) };
  }
}

/**
 * Encode a domain name as length-prefixed labels.
 *
 * A label over 63 bytes cannot be represented, and a name that long in a service instance is
 * always a bug in the caller rather than something to silently truncate.
 */
export function encodeName(name: string): Uint8Array {
  const labels = name.replace(/\.$/, "").split(".").filter((label) => label.length > 0);
  const parts: number[] = [];
  for (const label of labels) {
    const bytes = new TextEncoder().encode(label);
    if (bytes.byteLength > 63) {
      throw new Error(`DNS label "${label}" is ${bytes.byteLength} bytes; the limit is 63`);
    }
    parts.push(bytes.byteLength, ...bytes);
  }
  parts.push(0);
  return new Uint8Array(parts);
}

/**
 * Decode a name, following compression pointers.
 *
 * The pointer budget is what stops a crafted packet with a self-referential pointer from
 * spinning forever. `cursor` advances past the name in the *original* position, which is why
 * the first pointer stops advancing it: everything after a pointer belongs to another record.
 */
export function decodeName(packet: Uint8Array, cursor: { offset: number }): string | null {
  const labels: string[] = [];
  let offset = cursor.offset;
  let jumps = 0;
  let advanced = false;

  for (;;) {
    if (offset >= packet.byteLength) return null;
    const length = packet[offset];

    if (length === 0) {
      if (!advanced) cursor.offset = offset + 1;
      return labels.join(".");
    }

    if ((length & 0xc0) === 0xc0) {
      if (offset + 1 >= packet.byteLength) return null;
      const pointer = ((length & 0x3f) << 8) | packet[offset + 1];
      if (!advanced) {
        cursor.offset = offset + 2;
        advanced = true;
      }
      jumps += 1;
      if (jumps > 64 || pointer >= packet.byteLength) return null;
      offset = pointer;
      continue;
    }

    if (offset + 1 + length > packet.byteLength) return null;
    labels.push(new TextDecoder().decode(packet.subarray(offset + 1, offset + 1 + length)));
    offset += 1 + length;
  }
}

/**
 * TXT as key/value pairs.
 *
 * DNS-SD TXT is a list of `key=value` strings (RFC 6763 §6). A bare string with no `=` is a
 * legal boolean-ish attribute and is kept with an empty value rather than dropped, because
 * dropping it would make a peer's advertisement look different from what it sent.
 */
export function encodeText(text: Record<string, string>): Uint8Array {
  const entries = Object.entries(text);
  if (entries.length === 0) return new Uint8Array([0]);

  const parts: number[] = [];
  for (const [key, value] of entries) {
    const bytes = new TextEncoder().encode(value === "" ? key : `${key}=${value}`);
    if (bytes.byteLength > 255) {
      throw new Error(`TXT entry "${key}" is ${bytes.byteLength} bytes; the limit is 255`);
    }
    parts.push(bytes.byteLength, ...bytes);
  }
  return new Uint8Array(parts);
}

export function decodeText(rdata: Uint8Array): Record<string, string> {
  const text: Record<string, string> = {};
  let offset = 0;
  while (offset < rdata.byteLength) {
    const length = rdata[offset];
    if (length === 0) {
      offset += 1;
      continue;
    }
    if (offset + 1 + length > rdata.byteLength) break;
    const entry = new TextDecoder().decode(rdata.subarray(offset + 1, offset + 1 + length));
    const separator = entry.indexOf("=");
    if (separator === -1) text[entry] = "";
    else text[entry.slice(0, separator)] = entry.slice(separator + 1);
    offset += 1 + length;
  }
  return text;
}

function encodeIpv4(address: string): Uint8Array {
  const parts = address.split(".").map((part) => Number(part) & 0xff);
  if (parts.length !== 4) throw new Error(`"${address}" is not an IPv4 address`);
  return new Uint8Array(parts);
}

function encodeIpv6(address: string): Uint8Array {
  const [head, tail] = address.split("::");
  const headGroups = head ? head.split(":").filter(Boolean) : [];
  const tailGroups = tail ? tail.split(":").filter(Boolean) : [];
  const missing = 8 - headGroups.length - tailGroups.length;
  if (missing < 0 || (missing > 0 && tail === undefined)) {
    throw new Error(`"${address}" is not an IPv6 address`);
  }
  const groups = [...headGroups, ...new Array(Math.max(0, missing)).fill("0"), ...tailGroups];
  const out = new Uint8Array(16);
  const view = new DataView(out.buffer);
  groups.forEach((group, index) => view.setUint16(index * 2, Number.parseInt(group || "0", 16)));
  return out;
}

function decodeIpv6(bytes: Uint8Array): string {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const groups: string[] = [];
  for (let index = 0; index < 8; index += 1) groups.push(view.getUint16(index * 2).toString(16));
  return groups.join(":");
}
