/**
 * Origins the Playout operator UI may be served from.
 *
 * This exists as its own module so it can be tested. It was not tested, and the omission
 * cost a packaged release: Tauri 2 on Windows serves a bundled app over **http**
 * (`http://tauri.localhost`), not https, and only the https form was listed. Dev mode uses
 * the Vite origin, so every dev run passed while the desktop build could not reach its own
 * control service — and a CORS refusal surfaces in the UI as a bare "Failed to fetch", with
 * no status and no message to point at the cause.
 *
 * Add to this set rather than widening the check: an allowlist that accepts anything is not
 * an allowlist, and this service can Cue, Take and configure outputs.
 */

/** Tauri 2 webview origins. Platform facts, not preferences — all three are required. */
export const TAURI_WEBVIEW_ORIGINS: readonly string[] = Object.freeze([
  // macOS and Linux.
  "tauri://localhost",
  // Windows WebView2. The http form is what a packaged build actually uses.
  "http://tauri.localhost",
  "https://tauri.localhost"
]);

/** The Vite dev server for `@grapix/playout-web`. */
export const PLAYOUT_DEV_ORIGINS: readonly string[] = Object.freeze([
  "http://127.0.0.1:5174",
  "http://localhost:5174"
]);

/**
 * Build the allowlist.
 *
 * `GRAPIX_PLAYOUT_ALLOWED_ORIGINS` is a comma-separated addition for a deployment that serves
 * the operator UI from somewhere else. A `Set` rather than a record because the environment
 * inserts into it at runtime.
 */
export function readAllowedPlayoutOrigins(
  environment: NodeJS.ProcessEnv = process.env
): Set<string> {
  const origins = new Set([...TAURI_WEBVIEW_ORIGINS, ...PLAYOUT_DEV_ORIGINS]);

  for (const origin of (environment.GRAPIX_PLAYOUT_ALLOWED_ORIGINS ?? "").split(",")) {
    const trimmed = origin.trim();
    if (trimmed) {
      origins.add(trimmed);
    }
  }

  return origins;
}
