/**
 * The desktop shell's native file dialog, when there is one.
 *
 * The Editor runs in two places that matter: the Tauri shell, which `npm run dev` launches and
 * `npm run ship` packages, and a browser used for development. Only the shell can open a file
 * dialog, and this is where that difference is decided once, so the connector panel can ask for a
 * path without knowing where it is running.
 *
 * The panel needs a *path*, not a file. A browser `<input type="file">` reports a name and
 * deliberately never a location, and the project service needs the location: registering a project
 * is what makes its folder readable. So in a browser the author types the path, and in the shell
 * the platform dialog fills it in.
 *
 * There is no Electron branch. `Editor/apps/desktop-electron` still compiles, but it is not what
 * ships — it is absent from `npm run ship` and from the Editor's `verify` — so a branch here for a
 * capability it does not expose would be a path nothing can reach.
 */

/** Which host, if any, can open a file dialog. */
export type PickerSource = "tauri" | "none";

/**
 * Detect the host from the scope it exposes.
 *
 * Pure and given its scope, so both cases can be tested without a shell. Tauri v2 marks its webview
 * with `__TAURI_INTERNALS__` rather than a global API object, and `invoke` throws outside one — so
 * the marker is what decides whether the module is worth loading at all.
 */
export function detectPickerSource(scope: unknown): PickerSource {
  if (!scope || typeof scope !== "object") return "none";
  return (scope as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ ? "tauri" : "none";
}

/** Whether a Browse button should be offered at all. */
export function canPickFiles(scope: unknown = globalThis): boolean {
  return detectPickerSource(scope) !== "none";
}

/**
 * Ask the shell for an `.aep` path.
 *
 * Resolves to `null` when the author cancelled, which the panel treats as "nothing happened" rather
 * than as an error. A host that cannot pick also resolves `null`, so a caller that checked
 * `canPickFiles` first and one that did not behave the same way.
 */
export async function pickAeProjectPath(scope: unknown = globalThis): Promise<string | null> {
  if (detectPickerSource(scope) !== "tauri") return null;

  // Imported only inside a Tauri webview: a browser build should not pay for a module whose every
  // call would throw there.
  const { invoke } = await import("@tauri-apps/api/core");
  return (await invoke<string | null>("pick_ae_project")) ?? null;
}
/** Ask the shell for a project folder path. */
export async function pickProjectFolderPath(scope: unknown = globalThis): Promise<string | null> {
  if (detectPickerSource(scope) !== "tauri") return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return (await invoke<string | null>("pick_project_folder")) ?? null;
}

/**
 * Ask the shell where to save a new `.gpxpkg` project.
 *
 * `null` is a cancelled dialog. The caller treats that as "the save did not happen" rather than as
 * an error, because declining to name a project is a decision, not a failure.
 */
export async function pickProjectSavePath(scope: unknown = globalThis): Promise<string | null> {
  if (detectPickerSource(scope) !== "tauri") return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return (await invoke<string | null>("pick_project_save_path")) ?? null;
}
