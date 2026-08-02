import assert from "node:assert/strict";
import test from "node:test";
import type { AdobeApplicationStatus } from "@grapix/adobe-common-schema";

import { describeApplication } from "../src/lib/adobeStatus";

function status(overrides: Partial<AdobeApplicationStatus> = {}): AdobeApplicationStatus {
  return {
    app: "photoshop",
    installed: false,
    connected: false,
    cloudAvailable: false,
    ...overrides
  };
}

test("an application GrapiX has never seen is Unavailable, not Disconnected", () => {
  // The two are not the same claim: "Disconnected" tells the operator Photoshop is
  // installed and idle. Without a bridge, GrapiX does not know that and must not imply it.
  const view = describeApplication("Photoshop", undefined);

  assert.equal(view.availability, "Unavailable");
  assert.equal(view.canRestart, false);
  assert.match(view.guidance ?? "", /Install and run the GrapiX bridge inside Photoshop/);
});

test("a bridge that was up and is now gone reads as Disconnected", () => {
  const view = describeApplication("After Effects", status({ app: "after-effects", installed: true }));

  assert.equal(view.availability, "Disconnected");
  assert.equal(view.canRestart, false, "there is no socket left to drop");
  assert.match(view.guidance ?? "", /reachable earlier in this session/);
});

test("only a live bridge can be restarted, and it needs no guidance", () => {
  const view = describeApplication("Photoshop", status({ installed: true, connected: true }));

  assert.equal(view.availability, "Connected");
  assert.equal(view.canRestart, true);
  assert.equal(view.guidance, undefined);
});

test("a connected bridge wins even if the installed flag was never set", () => {
  // `installed` is advisory; the socket is the fact. A bridge that connected without
  // the host reporting installation must still be shown as Connected and restartable.
  const view = describeApplication("Photoshop", status({ installed: false, connected: true }));

  assert.equal(view.availability, "Connected");
  assert.equal(view.canRestart, true);
});

test("no plugin but a configured Photoshop API reads as Cloud only, not Unavailable", () => {
  // This is the normal state on a playout machine with no Photoshop installed. Calling it
  // "Unavailable" would tell the operator Adobe is unreachable when a PSD by URL works.
  const view = describeApplication("Photoshop", status({ cloudAvailable: true }));

  assert.equal(view.availability, "Cloud only");
  assert.equal(view.cloudReady, true);
  assert.equal(view.canRestart, false, "there is no plugin socket to drop");
  assert.match(view.guidance ?? "", /Adobe's Photoshop API will serve any PSD/);
});

test("a running plugin outranks the cloud, because only it sees the open document", () => {
  const view = describeApplication("Photoshop", status({ connected: true, cloudAvailable: true }));

  assert.equal(view.availability, "Connected");
  assert.equal(view.canRestart, true);
  assert.equal(view.cloudReady, true, "cloud stays available as a fallback");
});

test("an unconfigured cloud API points at the configuration rather than only the plugin", () => {
  const view = describeApplication(
    "Photoshop",
    status({ cloudDetail: "the Photoshop API is not configured: set GRAPIX_PS_API_CLIENT_ID" })
  );

  assert.equal(view.availability, "Unavailable");
  assert.match(view.guidance ?? "", /GRAPIX_PS_API_CLIENT_ID/);
});

test("After Effects never claims a cloud transport", () => {
  const view = describeApplication(
    "After Effects",
    status({ app: "after-effects", cloudDetail: "After Effects has no cloud API; a local bridge is the only transport." })
  );

  assert.equal(view.cloudReady, false);
  assert.equal(view.availability, "Unavailable");
});
