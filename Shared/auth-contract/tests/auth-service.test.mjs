import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AuthService, UserStore, signingKeyFromSecret } from "../dist/index.js";

test("an access token minted by one GrapiX service is accepted by another", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "grapix-shared-auth-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const store = new UserStore(UserStore.defaultPath(root));
  await store.load();
  const user = await store.create({
    username: "shared-operator",
    email: "shared@example.test",
    password: "correct horse battery staple",
    role: "admin"
  });
  const key = signingKeyFromSecret("a-thirty-two-character-shared-test-secret");
  const editor = new AuthService(store, key);
  const playout = new AuthService(store, key);

  const login = await editor.login("shared-operator", "correct horse battery staple");
  assert.ok(!("failure" in login));

  const peerVerification = playout.verifyAccess(login.tokens.accessToken);
  assert.ok(!("failure" in peerVerification));
  assert.equal(peerVerification.session.user.id, user.id);
  assert.equal(peerVerification.claims.sid, login.session.id);

  await store.setDisabled(user.id, true);
  assert.deepEqual(playout.verifyAccess(login.tokens.accessToken), { failure: "disabled" });
});
