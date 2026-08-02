/**
 * Origins the Editor UI may reach the assistant broker from.
 *
 * Same discipline as `Playout/services/playout-control/src/origins.ts`: an allowlist, extended
 * by environment, never widened to accept anything. The Editor web app is served at 5173 in
 * dev and from the Tauri webview when packaged.
 */

/** Tauri 2 webview origins. Platform facts — all three are required for a packaged build. */
export const TAURI_WEBVIEW_ORIGINS: readonly string[] = Object.freeze([
  "tauri://localhost",
  "http://tauri.localhost",
  "https://tauri.localhost"
]);

/** The Vite dev server for `@grapix/editor-web`. */
export const EDITOR_DEV_ORIGINS: readonly string[] = Object.freeze([
  "http://127.0.0.1:5173",
  "http://localhost:5173"
]);

export function readAllowedAssistantOrigins(environment: NodeJS.ProcessEnv = process.env): Set<string> {
  const origins = new Set([...TAURI_WEBVIEW_ORIGINS, ...EDITOR_DEV_ORIGINS]);
  for (const origin of (environment.GRAPIX_ASSISTANT_ALLOWED_ORIGINS ?? "").split(",")) {
    const trimmed = origin.trim();
    if (trimmed) origins.add(trimmed);
  }
  return origins;
}
