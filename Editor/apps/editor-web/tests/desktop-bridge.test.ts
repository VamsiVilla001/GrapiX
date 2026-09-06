import assert from "node:assert/strict";
import test from "node:test";
import { canPickFiles, detectPickerSource, pickAeProjectPath } from "../src/lib/desktopBridge";

/**
 * Which host can open a file dialog.
 *
 * The Editor runs in the Tauri shell — what `npm run dev` launches and `npm run ship` packages —
 * and in a browser during development. Only the first can produce a filesystem path. Getting this
 * wrong offers a Browse button that throws, or hides one that works.
 */

test("the Tauri shell is detected by its webview marker", () => {
  assert.equal(detectPickerSource({ __TAURI_INTERNALS__: {} }), "tauri");
  assert.equal(canPickFiles({ __TAURI_INTERNALS__: {} }), true);
});

test("a browser offers no picker", () => {
  assert.equal(detectPickerSource({}), "none");
  assert.equal(detectPickerSource(undefined), "none");
  assert.equal(detectPickerSource(null), "none");
  assert.equal(detectPickerSource("window"), "none");
  assert.equal(canPickFiles({}), false);
});

test("the retired Electron shell is not a picker", () => {
  // `desktop-electron` still compiles but is not what ships, so it never exposes a dialog. A scope
  // that looks like it must still resolve to "none" rather than to a branch nothing can satisfy.
  assert.equal(detectPickerSource({ grapixDesktop: { apiBaseUrl: "http://127.0.0.1:4100" } }), "none");
});

test("a host that cannot pick resolves null instead of throwing", async () => {
  // So a caller that checked canPickFiles first and one that did not behave identically, and a
  // browser never reaches the Tauri-only import.
  assert.equal(await pickAeProjectPath({}), null);
  assert.equal(await pickAeProjectPath(undefined), null);
});
