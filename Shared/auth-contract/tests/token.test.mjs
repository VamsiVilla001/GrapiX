import assert from "node:assert/strict";
import test from "node:test";

import {
  ACCESS_TOKEN_TTL_SECONDS,
  hashPassword,
  issueAccessToken,
  issueRefreshToken,
  needsRehash,
  newSessionId,
  signingKeyFromSecret,
  verifyPassword,
  verifyToken
} from "../dist/index.js";

const KEY = signingKeyFromSecret("a-thirty-two-character-signing-secret-01");

test("an access token carries the claims an operator needs, and only those", () => {
  const { token, claims } = issueAccessToken(
    { userId: "usr_1", username: "ada", role: "editor", sessionId: "sess_1" },
    KEY
  );
  assert.equal(claims.typ, "access");
  assert.equal(claims.role, "editor");
  assert.equal(claims.exp - claims.iat, ACCESS_TOKEN_TTL_SECONDS);
  // Narrowing only: an editor token must never carry an operator permission.
  assert.ok(!claims.perms.includes("playout.program"));
  assert.ok(claims.perms.includes("scene.write"));

  const verified = verifyToken(token, KEY, "access");
  assert.equal(verified.ok, true);
  assert.equal(verified.claims.sub, "usr_1");
});

test("a tampered payload, wrong key and wrong type are each refused by name", () => {
  const { token } = issueAccessToken({ userId: "u", username: "n", role: "admin", sessionId: "s" }, KEY);
  const [version, payload, signature] = token.split(".");

  assert.equal(verifyToken(`gx2.${payload}.${signature}`, KEY).reason, "unsupported-version");
  const forgedPayload = Buffer.from(JSON.stringify({ sub: "u", typ: "access", exp: 9999999999 })).toString("base64url");
  assert.equal(verifyToken(`${version}.${forgedPayload}.${signature}`, KEY).reason, "bad-signature");
  const otherKey = signingKeyFromSecret("a-different-signing-secret-that-is-long-enough-0");
  assert.equal(verifyToken(token, otherKey).reason, "bad-signature");
  assert.equal(verifyToken(token, KEY, "refresh").reason, "wrong-type");
});

test("an expired token is refused, and a refresh token is not an access token", () => {
  const past = Math.floor(Date.now() / 1000) - 3600;
  const { token } = issueAccessToken(
    { userId: "u", username: "n", role: "admin", sessionId: "s", issuedAt: past, ttlSeconds: 60 },
    KEY
  );
  assert.equal(verifyToken(token, KEY, "access").reason, "expired");

  const refresh = issueRefreshToken({ userId: "u", sessionId: "s", refreshId: "r1" }, KEY);
  assert.equal(verifyToken(refresh.token, KEY, "refresh").ok, true);
  assert.equal(verifyToken(refresh.token, KEY, "access").reason, "wrong-type");
});

test("a signing secret under the floor is refused rather than padded", () => {
  assert.throws(() => signingKeyFromSecret("short"), /at least 32 characters/);
});

test("session ids never collide across a thousand draws", () => {
  const seen = new Set();
  for (let index = 0; index < 1000; index += 1) seen.add(newSessionId());
  assert.equal(seen.size, 1000);
});

test("password hashes verify, reject the wrong password, and salt each hash", async () => {
  const first = await hashPassword("correct horse battery staple");
  const second = await hashPassword("correct horse battery staple");
  assert.ok(first.startsWith("scrypt$"));
  assert.notEqual(first, second, "each hash carries its own salt");

  assert.equal(await verifyPassword("correct horse battery staple", first), true);
  assert.equal(await verifyPassword("wrong", first), false);
  assert.equal(await verifyPassword("correct horse battery staple", "not-a-hash"), false);
  assert.equal(needsRehash(first), false);
  assert.equal(needsRehash("scrypt$8$8$1$c2FsdA==$a2V5"), true);
});
