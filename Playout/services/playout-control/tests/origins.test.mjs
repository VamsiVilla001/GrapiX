import assert from "node:assert/strict";
import test from "node:test";
import {
  PLAYOUT_DEV_ORIGINS,
  TAURI_WEBVIEW_ORIGINS,
  readAllowedPlayoutOrigins
} from "../dist/origins.js";

/**
 * The regression this file exists for.
 *
 * A packaged Playout build could not reach its own control service: Tauri 2 on Windows serves
 * a bundled app from `http://tauri.localhost`, and only the `https` form was allowed. Dev mode
 * uses the Vite origin, so nothing caught it until the desktop build ran — and the operator UI
 * reported it as "Failed to fetch", which names neither CORS nor the origin.
 */
test("a packaged desktop app's own origin is allowed on every platform", () => {
  const allowed = readAllowedPlayoutOrigins({});

  // Windows WebView2 in a packaged build. The one that was missing.
  assert.ok(allowed.has("http://tauri.localhost"), "packaged Windows origin must be allowed");
  // Windows WebView2 when configured for https.
  assert.ok(allowed.has("https://tauri.localhost"));
  // macOS and Linux.
  assert.ok(allowed.has("tauri://localhost"));

  for (const origin of TAURI_WEBVIEW_ORIGINS) {
    assert.ok(allowed.has(origin), `${origin} must be allowed`);
  }
});

test("the operator UI's dev server is allowed", () => {
  const allowed = readAllowedPlayoutOrigins({});
  for (const origin of PLAYOUT_DEV_ORIGINS) {
    assert.ok(allowed.has(origin), `${origin} must be allowed`);
  }
});

test("an unlisted origin stays out", () => {
  const allowed = readAllowedPlayoutOrigins({});
  // This service can Cue, Take and configure outputs. The allowlist is a boundary.
  assert.ok(!allowed.has("http://evil.example"));
  assert.ok(!allowed.has("http://127.0.0.1:5173"), "the Editor's dev origin is not Playout's");
  assert.ok(!allowed.has("tauri://localhost/"), "a trailing slash is a different origin");
});

test("a deployment can add origins, and whitespace does not create empty ones", () => {
  const allowed = readAllowedPlayoutOrigins({
    GRAPIX_PLAYOUT_ALLOWED_ORIGINS: " https://ops.example , , https://studio.example "
  });

  assert.ok(allowed.has("https://ops.example"));
  assert.ok(allowed.has("https://studio.example"));
  assert.ok(!allowed.has(""), "an empty entry would allow a request with no Origin semantics");
  // The defaults survive the addition.
  assert.ok(allowed.has("http://tauri.localhost"));
});
