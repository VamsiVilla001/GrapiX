import assert from "node:assert/strict";
import test from "node:test";

import { ServiceAdvertiser } from "../dist/advertiser.js";
import { ServiceBrowser } from "../dist/browser.js";
import { MdnsSocket } from "../dist/socket.js";

/**
 * The one test that uses a real multicast socket.
 *
 * Everything else here runs against a fake socket, which proves the protocol but not the thing
 * this facility is actually judged on: whether two GrapiX processes on one machine can find each
 * other with no DNS, no DHCP and no configuration. That depends on real socket options —
 * SO_REUSEADDR to coexist with the operating system's own responder, multicast loopback so a
 * packet sent on this host is delivered to another process on it, and group membership on an
 * interface that exists.
 *
 * It is skipped, not failed, when port 5353 cannot be opened. A CI container without multicast, a
 * locked-down firewall profile and a machine already running a conflicting responder are all
 * legitimate environments in which the *fallback* is unavailable and everything else still works
 * — which is exactly the contract the rest of the code is written to.
 */
async function multicastAvailable() {
  const socket = new MdnsSocket({ onPacket: () => {} });
  const opened = await socket.open();
  socket.close();
  return opened;
}

const available = await multicastAvailable();

test(
  "two processes on one machine discover each other over real multicast, with no configuration",
  { skip: available ? false : "port 5353 could not be opened on this machine" },
  async (t) => {
    // Separate sockets, as two processes would have. Both bind 5353 — which only works because of
    // SO_REUSEADDR, and is the whole point of testing it for real.
    const advertiser = new ServiceAdvertiser({
      type: "_grapix-editor._tcp",
      name: "Live Test Editor",
      port: 4100,
      txt: { role: "editor", api: "/api" }
    });
    t.after(() => advertiser.stop());
    assert.equal(await advertiser.start(), true, "the responder opened its socket");

    const browser = new ServiceBrowser(["_grapix-editor._tcp"]);
    t.after(() => browser.stop());
    assert.equal(await browser.start(), true, "the browser opened its socket");

    // Five seconds is generous: an announcement goes out on start, the browse query goes out
    // immediately, and the responder answers it. On a healthy machine this resolves in
    // milliseconds; the margin is for a loaded CI host.
    const found = await browser.discover(5000);
    const ours = found.find((service) => service.instance === advertiser.instance);

    assert.ok(
      ours,
      `the advertised instance was not discovered. Found: ${found.map((s) => s.instance).join(", ") || "nothing"}`
    );
    assert.equal(ours.port, 4100);
    assert.equal(ours.txt.role, "editor");
    assert.ok(
      ours.addresses.some((address) => address.startsWith("127.") || /^\d+\.\d+\.\d+\.\d+$/.test(address)),
      "at least one dialable IPv4 address was published"
    );
  }
);

test(
  "a goodbye reaches the link, so a peer stops offering a service that has stopped",
  { skip: available ? false : "port 5353 could not be opened on this machine" },
  async (t) => {
    const advertiser = new ServiceAdvertiser({
      type: "_grapix-playout._tcp",
      name: "Live Test Playout",
      port: 4300
    });
    const browser = new ServiceBrowser(["_grapix-playout._tcp"]);
    t.after(() => {
      advertiser.stop();
      browser.stop();
    });

    await advertiser.start();
    await browser.start();
    const found = await browser.discover(5000);
    assert.ok(found.some((service) => service.instance === advertiser.instance), "discovered first");

    advertiser.stop();
    // The goodbye is a datagram; give the loop one turn plus a margin to deliver it.
    await new Promise((resolve) => setTimeout(resolve, 300));

    assert.equal(
      browser.services().some((service) => service.instance === advertiser.instance),
      false,
      "the instance was withdrawn rather than left to expire on its TTL"
    );
  }
);

test("a socket that cannot open reports it instead of throwing", async () => {
  // Whatever the environment, opening must resolve to a boolean and never reject: a service's
  // startup path calls this, and discovery being unavailable is not a startup failure.
  const socket = new MdnsSocket({ onPacket: () => {}, onError: () => {} });
  const opened = await socket.open();
  assert.equal(typeof opened, "boolean");
  socket.close();
});
