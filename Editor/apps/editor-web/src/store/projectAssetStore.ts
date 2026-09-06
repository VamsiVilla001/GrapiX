/**
 * The project's asset folders, as the Material Manager's library.
 *
 * The library is the directory listing, not a catalogue the Editor maintains. That is the whole
 * design: a designer who copies four logos into `Assets/Images` with the file manager sees four
 * logos, and one who deletes a file stops being offered it. No import step invented the entries,
 * so nothing can disagree with what Explorer shows.
 *
 * ## Why this is a store and not a hook
 *
 * Several panels want the same list — the library grid, the inspector's source picker, and the
 * asset filter — and three components each running their own fetch would produce three different
 * answers during the second a scan takes. One store, one list, one refresh.
 *
 * ## When it refreshes
 *
 * The filesystem does not tell us it changed. There is no event for "the operator dropped a file
 * in with Explorer", so the list is re-read at the moments an operator expects it to be current:
 * when the panel mounts, when the window regains focus (they alt-tabbed to the file manager and
 * came back — the single most common way an asset arrives), and when they ask. A watcher was the
 * alternative and is worse: it holds handles on a folder the operator is editing, and on Windows
 * that is how a directory becomes undeletable.
 */

import { create } from "zustand";
import type { ProjectAssetReference } from "@grapix/shared-types";

import { listProjectAssetsOnApi } from "../lib/apiClient";

export type ProjectAssetStatus = "idle" | "loading" | "ready" | "error";

interface ProjectAssetState {
  assets: ProjectAssetReference[];
  /** False when the session has no project. An empty library then means "save it somewhere". */
  projectOpen: boolean;
  status: ProjectAssetStatus;
  error: string | null;
  /** When the list was last read, so the panel can say how current it is. */
  refreshedAt: string | null;
  refresh: () => Promise<void>;
}

/**
 * The refresh in flight, if any.
 *
 * Mount, focus and an explicit click routinely arrive together — opening the panel by clicking its
 * tab does all three — and three concurrent scans of the same folders would settle in arrival
 * order rather than in the order they started. Callers share the one that is running.
 */
let inFlight: Promise<void> | null = null;

export const useProjectAssetStore = create<ProjectAssetState>((set) => ({
  assets: [],
  projectOpen: false,
  status: "idle",
  error: null,
  refreshedAt: null,
  refresh: () => {
    if (inFlight) return inFlight;

    const attempt = (async () => {
      set({ status: "loading", error: null });
      try {
        const library = await listProjectAssetsOnApi();
        set({
          assets: library.assets,
          projectOpen: library.projectOpen,
          status: "ready",
          error: null,
          refreshedAt: new Date().toISOString()
        });
      } catch (error) {
        // The previous list is kept. A service that blinked is not a reason to empty a panel the
        // operator is working in — the error says the list may be stale, which is true and useful,
        // where an empty grid would be false.
        set({
          status: "error",
          error: error instanceof Error ? error.message : "Could not read the project's assets."
        });
      } finally {
        inFlight = null;
      }
    })();

    inFlight = attempt;
    return attempt;
  }
}));

/** Read the library once now, and again whenever the window is focused. Returns an unsubscribe. */
export function watchProjectAssets(): () => void {
  const { refresh } = useProjectAssetStore.getState();
  void refresh();

  const onFocus = () => void useProjectAssetStore.getState().refresh();
  window.addEventListener("focus", onFocus);
  return () => window.removeEventListener("focus", onFocus);
}
