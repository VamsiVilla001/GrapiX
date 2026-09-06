import assert from "node:assert/strict";
import test from "node:test";

let protectedRequest = false;
(globalThis as { fetch?: unknown }).fetch = (async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url.endsWith("/api/auth/login")) {
    return Response.json({
      ok: true,
      user: { id: "u1", username: "author", email: "author@example.test", role: "admin", permissions: [] },
      sessionId: "s1",
      accessToken: "stale-access-token",
      refreshToken: "refresh-token",
      expiresAt: Math.floor(Date.now() / 1000) + 60
    });
  }
  protectedRequest = true;
  return Response.json(
    { ok: false, error: "session is not valid; sign in again", code: "SESSION_EXPIRED" },
    { status: 401 }
  );
}) as typeof fetch;

const auth = await import("../src/lib/auth");
const api = await import("../src/lib/apiClient");

test("a 401 from the project service invalidates the Editor window session", async () => {
  await auth.signIn("author", "password");
  assert.equal(auth.currentUser()?.username, "author");

  await assert.rejects(() => api.listScenesFromApi(), /session is not valid/);

  assert.equal(protectedRequest, true);
  assert.equal(auth.currentUser(), null);
  assert.equal(auth.currentAccessToken(), null);
});
