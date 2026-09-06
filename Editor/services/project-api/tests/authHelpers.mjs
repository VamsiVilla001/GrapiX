/**
 * Sign in as the bootstrap admin against a test server and return the access token, plus an
 * `inject` that carries it on every call.
 *
 * The generated bootstrap password is held in memory on the server instance that created it
 * (`app.bootstrapAdminPassword`) - never written to the user store, so it cannot be read back
 * from disk. Signing in through the real route with it is how a test gets a credential, and
 * how it also proves the login works end to end.
 */

/** Sign in via Fastify injection, reading the bootstrap password off the instance. */
export async function injectSignInAsAdmin(app) {
  const password = app.bootstrapAdminPassword;
  if (!password) throw new Error("this test server did not bootstrap an admin - users.json already existed");
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { identifier: "admin", password }
  });
  const payload = response.json();
  if (!payload.ok) throw new Error(`test login failed: ${payload.error}`);
  return { accessToken: payload.accessToken, headers: { authorization: `Bearer ${payload.accessToken}` } };
}

/**
 * Sign in, then return an `inject` that carries the session token on every call.
 *
 * Tests written before the auth gate have dozens of `app.inject` calls; wrapping rather than
 * headering each one keeps them readable and cannot forget one.
 */
export async function authenticatedInject(app) {
  const { accessToken } = await injectSignInAsAdmin(app);
  return function inject(options) {
    const headers = { authorization: `Bearer ${accessToken}`, ...(options.headers ?? {}) };
    return app.inject({ ...options, headers });
  };
}
