import assert from "node:assert/strict";
import test from "node:test";

import { ServiceAdvertiser } from "../dist/advertiser.js";
import { ServiceBrowser } from "../dist/browser.js";
import { CLASS_IN, FLAG_RESPONSE, RECORD_TYPE, decodeMessage, encodeMessage } from "../dist/dns.js";
import { EndpointResolver, instanceUrls } from "../dist/endpoint.js";

/**
 * A fake multicast socket.
 *
 * The advertiser and the browser take a socket, so the protocol behaviour can be tested without
 * a real group, a firewall or a port that another responder may already hold. `link()` wires two
 * fakes together, which is the interesting case: one process announcing and another discovering.
 */
function fakeSocket() {
  const sent = [];
  let onPacket = () => {};
  return {
    sent,
    peers: [],
    async open() {
      return true;
    },
    get isOpen() {
      return true;
    },
    send(packet, destination) {
      sent.push({ packet, destination });
      for (const peer of this.peers) peer.deliver(packet, "10.0.0.9", 5353);
    },
    deliver(packet, address = "10.0.0.9", port = 5353) {
      onPacket({ data: packet, address, port });
    },
    receive(handler) {
      onPacket = handler;
    },
    interfaces() {
      return ["10.0.0.9"];
    },
    close() {}
  };
}

test("an advertisement publishes the four records a resolver needs", async (t) => {
  const socket = fakeSocket();
  const advertiser = new ServiceAdvertiser(
    { type: "_grapix-editor._tcp", name: "Studio Editor", port: 4100, txt: { role: "editor" } },
    { socket, addresses: ["10.0.0.9", "127.0.0.1"] }
  );
  t.after(() => advertiser.stop());

  assert.equal(await advertiser.start(), true);

  const announcement = decodeMessage(socket.sent[0].packet);
  assert.equal(announcement.flags & 0x8000, 0x8000, "an announcement is an unsolicited response");
  const types = announcement.answers.map((record) => record.type);
  assert.deepEqual(types, [RECORD_TYPE.PTR, RECORD_TYPE.SRV, RECORD_TYPE.TXT, RECORD_TYPE.A, RECORD_TYPE.A]);

  const srv = announcement.answers.find((record) => record.type === RECORD_TYPE.SRV);
  assert.equal(srv.port, 4100);
  assert.equal(srv.target, advertiser.hostName);
  // The instance name carries a random suffix: two Editors on one link is normal, and the
  // instance name is the primary key of the protocol.
  assert.match(advertiser.instance, /^Studio Editor [0-9a-f]{6}\._grapix-editor\._tcp\.local$/);
});

test("a query for the service type is answered; an unrelated one is not", async (t) => {
  const socket = fakeSocket();
  const advertiser = new ServiceAdvertiser(
    { type: "_grapix-editor._tcp", name: "Studio Editor", port: 4100 },
    { socket, addresses: ["10.0.0.9"] }
  );
  t.after(() => advertiser.stop());
  await advertiser.start();
  socket.sent.length = 0;

  advertiser.handlePacket(query("_grapix-printer._tcp.local"), "10.0.0.5", 5353);
  assert.equal(socket.sent.length, 0, "another vendor's browse is not ours to answer");

  advertiser.handlePacket(query("_grapix-editor._tcp.local"), "10.0.0.5", 5353);
  assert.equal(socket.sent.length, 1);
  assert.equal(socket.sent[0].destination, undefined, "a multicast question gets a multicast answer");

  // A unicast-response question is answered directly, so a one-to-one lookup does not cost every
  // listener on the link a packet.
  advertiser.handlePacket(query("_grapix-editor._tcp.local", true), "10.0.0.5", 5353);
  assert.deepEqual(socket.sent[1].destination, { address: "10.0.0.5", port: 5353 });
});

test("stopping sends a goodbye, so a peer stops offering an endpoint that just shut down", async () => {
  const socket = fakeSocket();
  const advertiser = new ServiceAdvertiser(
    { type: "_grapix-playout._tcp", name: "Gallery", port: 4300 },
    { socket, addresses: ["10.0.0.9"] }
  );
  await advertiser.start();
  socket.sent.length = 0;

  await advertiser.stop();

  assert.ok(socket.sent.length >= 1, "a goodbye is sent");
  const farewell = decodeMessage(socket.sent[0].packet);
  assert.ok(
    farewell.answers.every((record) => record.ttl === 0),
    "a goodbye is the same records at TTL 0"
  );
});

test("a browser assembles an endpoint from an announcement and reports it", async (t) => {
  const advertiserSocket = fakeSocket();
  const browserSocket = fakeSocket();
  advertiserSocket.peers.push(browserSocket);

  const changes = [];
  const browser = new ServiceBrowser(["_grapix-editor._tcp"], {
    socket: browserSocket,
    onChange: (services) => changes.push(services.length)
  });
  browserSocket.receive((packet) => browser.handlePacket(packet.data));
  t.after(() => browser.stop());
  await browser.start();

  const advertiser = new ServiceAdvertiser(
    { type: "_grapix-editor._tcp", name: "Studio Editor", port: 4100, txt: { role: "editor", api: "/api" } },
    { socket: advertiserSocket, addresses: ["10.0.0.9", "127.0.0.1"] }
  );
  t.after(() => advertiser.stop());
  await advertiser.start();

  const [service] = browser.services();
  assert.ok(service, "the announcement produced a complete instance");
  assert.equal(service.name, "Studio Editor " + advertiser.instance.split(" ")[2].split(".")[0]);
  assert.equal(service.port, 4100);
  assert.deepEqual(service.txt, { role: "editor", api: "/api" });
  // Routable first: a loopback address published by another host is meaningless to us.
  assert.deepEqual(service.addresses, ["10.0.0.9", "127.0.0.1"]);
  assert.ok(changes.length > 0, "a change was reported for a UI to react to");

  assert.deepEqual(instanceUrls(service), ["http://10.0.0.9:4100", "http://127.0.0.1:4100"]);
});

test("an instance with no address or no port is never offered", async (t) => {
  const socket = fakeSocket();
  const browser = new ServiceBrowser(["_grapix-editor._tcp"], { socket });
  t.after(() => browser.stop());
  await browser.start();

  // PTR alone: an instance exists but nothing says where.
  browser.handlePacket(
    response([
      {
        name: "_grapix-editor._tcp.local",
        type: RECORD_TYPE.PTR,
        class: CLASS_IN,
        ttl: 120,
        target: "Half Told._grapix-editor._tcp.local"
      }
    ])
  );
  assert.deepEqual(browser.services(), [], "half a record set is not an endpoint");

  // SRV as well, but still no A record for the host it names.
  browser.handlePacket(
    response([
      {
        name: "Half Told._grapix-editor._tcp.local",
        type: RECORD_TYPE.SRV,
        class: CLASS_IN,
        ttl: 120,
        priority: 0,
        weight: 0,
        port: 4100,
        target: "ghost.local"
      }
    ])
  );
  assert.deepEqual(browser.services(), [], "a port with no address cannot be dialled");

  browser.handlePacket(
    response([{ name: "ghost.local", type: RECORD_TYPE.A, class: CLASS_IN, ttl: 120, address: "10.0.0.4" }])
  );
  assert.equal(browser.services().length, 1, "the address completed it");
  assert.equal(browser.services()[0].addresses[0], "10.0.0.4");
});

test("a goodbye removes an instance at once, and a TTL removes it on time", async (t) => {
  let clock = 10_000;
  const socket = fakeSocket();
  const browser = new ServiceBrowser(["_grapix-playout._tcp"], { socket, now: () => clock });
  t.after(() => browser.stop());
  await browser.start();

  const records = [
    {
      name: "_grapix-playout._tcp.local",
      type: RECORD_TYPE.PTR,
      class: CLASS_IN,
      ttl: 120,
      target: "Gallery._grapix-playout._tcp.local"
    },
    {
      name: "Gallery._grapix-playout._tcp.local",
      type: RECORD_TYPE.SRV,
      class: CLASS_IN,
      ttl: 120,
      priority: 0,
      weight: 0,
      port: 4300,
      target: "gallery.local"
    },
    { name: "gallery.local", type: RECORD_TYPE.A, class: CLASS_IN, ttl: 120, address: "10.0.0.7" }
  ];

  browser.handlePacket(response(records));
  assert.equal(browser.services().length, 1);

  // Just inside the TTL.
  clock += 119_000;
  assert.equal(browser.services().length, 1);
  // Just outside it. A machine switched off mid-show stops being offered.
  clock += 2_000;
  assert.deepEqual(browser.services(), []);

  browser.handlePacket(response(records));
  assert.equal(browser.services().length, 1);
  browser.handlePacket(response([{ ...records[0], ttl: 0 }]));
  assert.deepEqual(browser.services(), [], "a clean shutdown is honoured immediately");
});

test("a browser ignores its own advertisement", async (t) => {
  const socket = fakeSocket();
  const advertiser = new ServiceAdvertiser(
    { type: "_grapix-editor._tcp", name: "Self", port: 4100 },
    { socket, addresses: ["10.0.0.9"] }
  );
  t.after(() => advertiser.stop());
  await advertiser.start();

  const browser = new ServiceBrowser(["_grapix-editor._tcp"], {
    socket,
    ignoreInstances: [advertiser.instance]
  });
  t.after(() => browser.stop());
  await browser.start();

  for (const { packet } of socket.sent) browser.handlePacket(packet);
  assert.deepEqual(browser.services(), [], "multicast loopback means we hear ourselves");
});

// ---------------------------------------------------------------------------
// The policy: which address is used, and why
// ---------------------------------------------------------------------------

/** A browser stand-in that returns a fixed instance list. */
function fakeBrowserWith(instances) {
  return {
    async start() {
      return true;
    },
    async discover() {
      return instances;
    },
    services() {
      return instances;
    },
    query() {},
    stop() {}
  };
}

const discovered = {
  instance: "Studio Editor abc._grapix-editor._tcp.local",
  name: "Studio Editor abc",
  type: "_grapix-editor._tcp",
  host: "studio.local",
  port: 4100,
  addresses: ["169.254.4.4"],
  txt: { role: "editor" },
  seenAtMs: 1,
  expiresAtMs: 999_999
};

test("a configured address that answers is used, and discovery is never consulted", async () => {
  let discoveries = 0;
  const browser = {
    ...fakeBrowserWith([discovered]),
    async discover() {
      discoveries += 1;
      return [discovered];
    }
  };
  const resolver = new EndpointResolver({
    serviceType: "_grapix-editor._tcp",
    configured: "http://studio-pc:4100",
    loopback: "http://127.0.0.1:4100",
    verify: async () => true,
    browser
  });

  const endpoint = await resolver.resolve();
  assert.equal(endpoint.url, "http://studio-pc:4100");
  assert.equal(endpoint.route, "configured");
  assert.equal(endpoint.isFallback, false);
  assert.equal(discoveries, 0, "an explicit address is an instruction, not a hint");
});

test("loopback is tried before the link, because it survives every interface going down", async () => {
  const attempted = [];
  const resolver = new EndpointResolver({
    serviceType: "_grapix-editor._tcp",
    configured: "http://studio-pc:4100",
    loopback: "http://127.0.0.1:4100",
    verify: async (url) => {
      attempted.push(url);
      return url === "http://127.0.0.1:4100";
    },
    browser: fakeBrowserWith([discovered])
  });

  const endpoint = await resolver.resolve();
  assert.deepEqual(attempted, ["http://studio-pc:4100", "http://127.0.0.1:4100"]);
  assert.equal(endpoint.route, "loopback");
  assert.equal(endpoint.isFallback, true, "it is not what the deployment asked for");
});

test("the link is used when nothing local answers, and the route is reported", async () => {
  const routes = [];
  const resolver = new EndpointResolver({
    serviceType: "_grapix-editor._tcp",
    configured: "http://studio-pc:4100",
    loopback: "http://127.0.0.1:4100",
    verify: async (url) => url === "http://169.254.4.4:4100",
    browser: fakeBrowserWith([discovered]),
    onRouteChange: (endpoint, previous) => routes.push([previous?.route ?? null, endpoint.route])
  });

  const endpoint = await resolver.resolve();
  assert.equal(endpoint.url, "http://169.254.4.4:4100");
  assert.equal(endpoint.route, "discovered");
  assert.equal(endpoint.instance.name, "Studio Editor abc");
  assert.deepEqual(routes, [[null, "discovered"]], "the change is reported once, with its predecessor");
});

test("a service listening on the port but not ours is refused", async () => {
  const resolver = new EndpointResolver({
    serviceType: "_grapix-editor._tcp",
    loopback: "http://127.0.0.1:4100",
    // Something answers on every address, and none of it is a GrapiX Editor.
    verify: async () => false,
    browser: fakeBrowserWith([discovered])
  });

  assert.equal(await resolver.resolve(), null, "nothing is adopted without proof");
  assert.equal(resolver.currentEndpoint(), null);
});

test("a proven endpoint is reused inside the trust window and re-proven after it", async () => {
  let clock = 0;
  let verifications = 0;
  const resolver = new EndpointResolver({
    serviceType: "_grapix-editor._tcp",
    loopback: "http://127.0.0.1:4100",
    verify: async () => {
      verifications += 1;
      return true;
    },
    browser: fakeBrowserWith([]),
    trustForMs: 30_000,
    now: () => clock
  });

  await resolver.resolve();
  await resolver.resolve();
  assert.equal(verifications, 1, "a hot path does not re-prove on every call");

  clock += 30_001;
  await resolver.resolve();
  assert.equal(verifications, 2, "trust expires, so a service that moved is noticed");
});

test("invalidating forces a re-proof, and the remembered address is tried first", async () => {
  const attempted = [];
  let editorMoved = false;
  const resolver = new EndpointResolver({
    serviceType: "_grapix-editor._tcp",
    loopback: "http://127.0.0.1:4100",
    verify: async (url) => {
      attempted.push(url);
      return editorMoved ? url === "http://169.254.4.4:4100" : url === "http://127.0.0.1:4100";
    },
    browser: fakeBrowserWith([discovered])
  });

  assert.equal((await resolver.resolve()).route, "loopback");
  attempted.length = 0;

  // The service moves; the next request against the remembered address fails.
  editorMoved = true;
  await resolver.invalidate();
  const endpoint = await resolver.resolve();

  assert.equal(attempted[0], "http://127.0.0.1:4100", "what worked before is still the best guess");
  assert.equal(endpoint.url, "http://169.254.4.4:4100");
  assert.equal(endpoint.route, "discovered");
});

test("concurrent callers share one resolution", async () => {
  let verifications = 0;
  const resolver = new EndpointResolver({
    serviceType: "_grapix-editor._tcp",
    loopback: "http://127.0.0.1:4100",
    verify: async () => {
      verifications += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return true;
    },
    browser: fakeBrowserWith([])
  });

  const [first, second] = await Promise.all([resolver.resolve(), resolver.resolve()]);
  assert.equal(first, second);
  assert.equal(verifications, 1, "two callers must not double the discovery traffic");
});

test("an https deployment is dialled over https", () => {
  assert.deepEqual(
    instanceUrls({ ...discovered, txt: { scheme: "https" } }),
    ["https://169.254.4.4:4100"]
  );
});

function query(name, unicast = false) {
  return encodeMessage({
    id: 0,
    flags: 0,
    questions: [{ name, type: RECORD_TYPE.PTR, class: unicast ? CLASS_IN | 0x8000 : CLASS_IN }],
    answers: [],
    additionals: []
  });
}

function response(answers) {
  return encodeMessage({ id: 0, flags: FLAG_RESPONSE, questions: [], answers, additionals: [] });
}
