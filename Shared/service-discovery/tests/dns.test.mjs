import assert from "node:assert/strict";
import test from "node:test";

import {
  CACHE_FLUSH,
  CLASS_IN,
  FLAG_RESPONSE,
  RECORD_TYPE,
  decodeMessage,
  decodeName,
  decodeText,
  encodeMessage,
  encodeName,
  encodeText
} from "../dist/dns.js";

/**
 * The wire format is the contract with every other responder on the link — Bonjour on macOS,
 * Avahi on Linux, the Windows resolver. A packet that round-trips through our own codec but not
 * through theirs is indistinguishable from "discovery does not work", so these assert byte
 * layout, not just symmetry.
 */
test("a query encodes to the exact bytes a responder expects", () => {
  const packet = encodeMessage({
    id: 0,
    flags: 0,
    questions: [{ name: "_grapix-editor._tcp.local", type: RECORD_TYPE.PTR, class: CLASS_IN }],
    answers: [],
    additionals: []
  });

  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  assert.equal(view.getUint16(0), 0, "mDNS ignores the transaction id, so it is zero");
  assert.equal(view.getUint16(2), 0, "a query has the QR bit clear");
  assert.equal(view.getUint16(4), 1, "one question");
  assert.equal(view.getUint16(6), 0);
  assert.equal(view.getUint16(8), 0);
  assert.equal(view.getUint16(10), 0);

  // Length-prefixed labels, terminated by a zero byte, then QTYPE and QCLASS.
  const labels = packet.subarray(12, packet.byteLength - 4);
  assert.equal(labels[0], "_grapix-editor".length);
  assert.equal(new TextDecoder().decode(labels.subarray(1, 15)), "_grapix-editor");
  assert.equal(labels.at(-1), 0, "the name ends with a root label");
  assert.equal(view.getUint16(packet.byteLength - 4), RECORD_TYPE.PTR);
  assert.equal(view.getUint16(packet.byteLength - 2), CLASS_IN);
});

test("a full announcement round-trips with its ports, addresses and metadata intact", () => {
  const answers = [
    {
      name: "_grapix-playout._tcp.local",
      type: RECORD_TYPE.PTR,
      class: CLASS_IN,
      ttl: 120,
      target: "Gallery 1 a1b2c3._grapix-playout._tcp.local"
    },
    {
      name: "Gallery 1 a1b2c3._grapix-playout._tcp.local",
      type: RECORD_TYPE.SRV,
      class: CLASS_IN | CACHE_FLUSH,
      ttl: 120,
      priority: 0,
      weight: 0,
      port: 4300,
      target: "grapix-studio-a1b2c3.local"
    },
    {
      name: "Gallery 1 a1b2c3._grapix-playout._tcp.local",
      type: RECORD_TYPE.TXT,
      class: CLASS_IN | CACHE_FLUSH,
      ttl: 120,
      text: { role: "playout", api: "/api/playout", v: "0.2.0" }
    },
    {
      name: "grapix-studio-a1b2c3.local",
      type: RECORD_TYPE.A,
      class: CLASS_IN | CACHE_FLUSH,
      ttl: 120,
      address: "169.254.12.9"
    }
  ];

  const decoded = decodeMessage(encodeMessage({ id: 0, flags: FLAG_RESPONSE, questions: [], answers, additionals: [] }));

  assert.equal(decoded.flags & 0x8000, 0x8000, "the QR bit marks it a response");
  assert.equal(decoded.answers.length, 4);
  assert.equal(decoded.answers[0].target, "Gallery 1 a1b2c3._grapix-playout._tcp.local");
  assert.equal(decoded.answers[1].port, 4300);
  assert.equal(decoded.answers[1].target, "grapix-studio-a1b2c3.local");
  assert.deepEqual(decoded.answers[2].text, { role: "playout", api: "/api/playout", v: "0.2.0" });
  assert.equal(decoded.answers[3].address, "169.254.12.9");

  // The cache-flush bit must survive: without it a peer keeps a stale address beside the new one.
  assert.equal(decoded.answers[1].class & CACHE_FLUSH, CACHE_FLUSH);
  assert.equal(decoded.answers[0].class & CACHE_FLUSH, 0, "PTR is shared, so it never flushes");
});

test("compressed names are followed, because every real responder compresses", () => {
  // Hand-built: "a.local" at offset 12, then a name that is a pointer back to it.
  const packet = new Uint8Array([
    0, 0, 0x84, 0, 0, 0, 0, 1, 0, 0, 0, 0,
    // answer name: "a" "local" 0
    1, 0x61, 5, 0x6c, 0x6f, 0x63, 0x61, 0x6c, 0,
    // type PTR, class IN, ttl 120, rdlength 2
    0, 12, 0, 1, 0, 0, 0, 120, 0, 2,
    // rdata: pointer to offset 12
    0xc0, 12
  ]);

  const decoded = decodeMessage(packet);
  assert.equal(decoded.answers.length, 1);
  assert.equal(decoded.answers[0].name, "a.local");
  assert.equal(decoded.answers[0].target, "a.local", "the pointer resolved to the same name");
});

test("a self-referential pointer cannot hang the parser", () => {
  // A name at offset 12 that points at itself: legal bytes, illegal meaning. One bad neighbour on
  // the link must not be able to wedge discovery.
  const packet = new Uint8Array([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0xc0, 12, 0, 12, 0, 1]);
  const decoded = decodeMessage(packet);
  assert.ok(decoded, "returns what it could read rather than throwing");
  assert.equal(decoded.questions.length, 0, "the unreadable question is dropped");
});

test("a truncated or hostile packet yields what parsed rather than throwing", () => {
  assert.equal(decodeMessage(new Uint8Array(4)), null, "shorter than a header is not a packet");

  // Header claims two answers; the body holds none.
  const lying = new Uint8Array([0, 0, 0x84, 0, 0, 0, 0, 2, 0, 0, 0, 0]);
  const decoded = decodeMessage(lying);
  assert.deepEqual(decoded.answers, []);

  const random = new Uint8Array(64).fill(0xff);
  assert.doesNotThrow(() => decodeMessage(random));
});

test("an unmodelled record type survives as raw data instead of corrupting the section", () => {
  // NSEC (47) is sent by Bonjour on every announcement.
  const packet = new Uint8Array([
    0, 0, 0x84, 0, 0, 0, 0, 1, 0, 0, 0, 0,
    1, 0x61, 5, 0x6c, 0x6f, 0x63, 0x61, 0x6c, 0,
    0, 47, 0, 1, 0, 0, 0, 120, 0, 3, 1, 2, 3
  ]);

  const decoded = decodeMessage(packet);
  assert.equal(decoded.answers.length, 1);
  assert.equal(decoded.answers[0].type, 47);
  assert.deepEqual([...decoded.answers[0].data], [1, 2, 3]);
});

test("TXT is a list of key=value strings, and a bare key keeps its meaning", () => {
  const encoded = encodeText({ role: "editor", ready: "" });
  const decoded = decodeText(encoded);
  assert.deepEqual(decoded, { role: "editor", ready: "" });

  // A bare attribute is sent without an "=" — that is how RFC 6763 expresses a flag.
  assert.equal(encoded[0], "role=editor".length);
  assert.equal(new TextDecoder().decode(encoded.subarray(1, 12)), "role=editor");
  assert.equal(encoded[12], "ready".length);
  assert.equal(new TextDecoder().decode(encoded.subarray(13)), "ready");

  // An empty TXT is one zero byte, not an empty RDATA: a zero-length TXT record is illegal.
  assert.deepEqual([...encodeText({})], [0]);
});

test("a value containing an equals sign splits only on the first one", () => {
  assert.deepEqual(decodeText(encodeText({ api: "/api/playout?x=1" })), { api: "/api/playout?x=1" });
});

test("names and TXT entries that cannot be represented are refused, not truncated", () => {
  assert.throws(() => encodeName(`${"x".repeat(64)}.local`), /limit is 63/);
  assert.throws(() => encodeText({ k: "y".repeat(300) }), /limit is 255/);
});

test("a trailing dot is not a separate empty label", () => {
  assert.deepEqual([...encodeName("a.local.")], [...encodeName("a.local")]);
  assert.equal(decodeName(encodeName("a.local."), { offset: 0 }), "a.local");
});
