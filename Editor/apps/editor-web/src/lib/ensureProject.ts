/**
 * Ask for a project location before doing work that needs one.
 *
 * A GrapiX project is a folder the operator named, holding a `.gpxpkg` file and the asset folders
 * beside it. Two actions cannot proceed without one — saving a scene, and importing an After
 * Effects composition, which copies footage into `Assets/AEP` — so both call this first.
 *
 * It lives here rather than inside the editor store on purpose. `saveScene` is called by autosave,
 * by tests and by anything else that persists in the background; a store action that raised a file
 * dialog would raise it from all of them. The store reports that a project is missing, and the UI —
 * which knows a person is present — is what asks.
 */

import { getProjectOnApi, openProjectOnApi } from "./apiClient";
import { canPickFiles, pickProjectSavePath } from "./desktopBridge";
import { useEditorStore } from "../store/editorStore";

export interface EnsureProjectOutcome {
  ok: boolean;
  /** Set when the caller should show something; `null` when the project was already there. */
  message: string | null;
}

/**
 * Resolve a project location, prompting once if there is none.
 *
 * A query that fails is treated as "already fine": the service being briefly unreachable is not a
 * reason to ask an operator to re-choose a project they have open, and the work that follows will
 * surface the real transport error itself.
 */
export async function ensureProjectLocation(suggestedName?: string): Promise<EnsureProjectOutcome> {
  const project = await getProjectOnApi().then(
    (value) => ({ known: true as const, root: value.root }),
    () => ({ known: false as const, root: null })
  );
  if (!project.known || project.root) return { ok: true, message: null };

  if (!canPickFiles()) {
    return {
      ok: false,
      message: "No project yet. Open GrapiX on the desktop to choose where the project is saved."
    };
  }

  const chosen = await pickProjectSavePath();
  if (!chosen) {
    return { ok: false, message: "Cancelled — choose where to save the project first." };
  }

  await openProjectOnApi(chosen, suggestedName);
  return { ok: true, message: null };
}

/**
 * Save the open scene, asking where the project lives if this is the first time.
 *
 * The one place that turns "the author asked to save" into a write, shared by the File menu and by
 * Ctrl+S. Two entry points running two copies of this would drift, and the interesting half is the
 * refusal handling — a cancelled dialog has to leave a visible reason rather than looking like a
 * save that silently did nothing.
 *
 * Deliberately not in the editor store. `saveScene` is called by autosave, by tests and by
 * anything that persists in the background; a store action that could raise a file dialog would
 * raise it from all of them. Prompting belongs to the paths a person took, which is this one.
 */
export async function saveSceneWithProjectPrompt(): Promise<boolean> {
  const store = useEditorStore.getState();
  if (!store.hasActiveScene) return false;

  const outcome = await ensureProjectLocation(store.scene.name);
  if (!outcome.ok) {
    if (outcome.message) store.setSaveStatus("error", outcome.message);
    return false;
  }
  return store.saveScene();
}
