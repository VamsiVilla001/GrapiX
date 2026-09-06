import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const TEST_SIGNING_SECRET = "test-signing-secret-that-is-long-enough-for-auth";

/**
 * The Editor's desktop shell loads its UI in a WebView, and that WebView has an origin. If the
 * project service does not allow it, every request fails as a bare "Failed to fetch" — no
 * status, no message, nothing naming CORS. The sibling Playout service shipped exactly that
 * bug in a packaged build by allowing only `https://tauri.localhost` while Tauri 2 on Windows
 * serves a bundled app over http.
 *
 * Asserted through the real server rather than against a constant, because what matters is the
 * response header a browser actually reads.
 */
test("the packaged desktop WebView origins are allowed, and others are refused", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "grapix-cors-test-"));
  process.env.GRAPIX_DATA_ROOT = root;
  const { createApiServer } = await import("../dist/index.js");
  const app = await createApiServer({ logger: false, signingSecret: TEST_SIGNING_SECRET });
  context.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });

  const allowHeaderFor = async (origin) => {
    const response = await app.inject({ method: "GET", url: "/health", headers: { origin } });
    return {
      status: response.statusCode,
      allowOrigin: response.headers["access-control-allow-origin"]
    };
  };

  // Tauri 2 webview origins. `http://tauri.localhost` is what a packaged Windows build uses.
  for (const origin of ["http://tauri.localhost", "https://tauri.localhost", "tauri://localhost"]) {
    const { status, allowOrigin } = await allowHeaderFor(origin);
    assert.equal(status, 200, `${origin} must not be refused`);
    assert.equal(allowOrigin, origin, `${origin} must be echoed back or a browser blocks it`);
  }

  // The Electron shell's custom scheme, and the editor dev server.
  for (const origin of ["grapix://editor", "http://127.0.0.1:5173"]) {
    const { allowOrigin } = await allowHeaderFor(origin);
    assert.equal(allowOrigin, origin);
  }

  // A same-machine tool with no Origin header stays supported.
  const noOrigin = await app.inject({ method: "GET", url: "/health" });
  assert.equal(noOrigin.statusCode, 200);

  // An unlisted origin is refused before the route runs — an execution guard, not just a
  // missing CORS header.
  const refused = await app.inject({
    method: "GET",
    url: "/api/scenes",
    headers: { origin: "http://evil.example" }
  });
  assert.equal(refused.statusCode, 403);
  assert.match(refused.json().error, /not allowed/i);
});
