/**
 * Autosave: keeps the open scene persisted, and keeps a rolling history of versions.
 *
 * Replaces the former `useSceneAutosave` hook. That hook re-armed a 550 ms timer on every
 * scene identity change, which made it an unconditional debounced save with no operator
 * control, no version history, and no way to turn it off. It also lived in React, so its
 * lifetime was tied to a component mount rather than to the window.
 *
 * Two jobs, one mechanism, because two mechanisms writing the same scene would report two
 * different save statuses for one document:
 *
 * - **Persist.** After edits settle, write the scene through the store's guarded
 *   `saveScene()`. This is what makes the editor safe to work in.
 * - **Version.** At most once per configured interval, also write an immutable snapshot into
 *   the scene's autosave ring (`<scene> autosave 1…n`), After Effects style. This is what
 *   makes a mistake recoverable, which persisting alone never does — a save that overwrites
 *   good work with bad is still a loss.
 *
 * Rules, each of them a learned failure rather than a preference:
 *
 * 1. **Never write mid-gesture.** A drag or multi-step edit runs inside a
 *    `historyTransaction`. Writing then captures a torn intermediate state that is not a
 *    valid undo boundary, so work defers until the transaction closes.
 * 2. **Never snapshot an unchanged scene.** Snapshots are keyed on `updatedAt`, so an idle
 *    editor cannot cycle the ring and destroy the history it exists to hold. Not on `revision`:
 *    only the project service increments that and the client never reads it back, so a
 *    revision-keyed guard sees one value forever. The guard holds even for a forced write.
 * 3. **Never let a snapshot failure surface as a save error.** Versioning is a safety net; a
 *    failure must stay quiet and must never block editing or contradict the save indicator.
 * 4. **Always re-arm a failed write.** The triggers below are all edits: without a retry, one
 *    transient network error parks the editor on "Not saved" until the operator happens to
 *    change something, and until then the document exists only in this window. That is the
 *    state a 2026-08-04 session was found in — the service had been healthy for minutes.
 */

import { autosaveSceneOnApi } from "./apiClient";
import { useEditorStore } from "../store/editorStore";
import { usePreferencesStore } from "../store/preferencesStore";

/**
 * Quiet period after the last change before writing.
 *
 * Long enough to coalesce a burst of edits (typing, nudging) into one write, short enough
 * that an operator who pauses sees "Saved" rather than wondering.
 */
const settleDelayMs = 550;

/** First retry after a failed write. Long enough that a restarting service is back. */
const retryFloorMs = 2_000;
/**
 * Slowest retry. A service that is genuinely gone is then polled twice a minute — often
 * enough that recovery is invisible to the operator, rarely enough to be no kind of load.
 */
const retryCeilingMs = 30_000;

/** Doubling backoff between retries of a failed write. Pure so the policy is testable. */
export function nextRetryDelayMs(previousMs: number): number {
  if (!Number.isFinite(previousMs) || previousMs <= 0) return retryFloorMs;
  return Math.min(previousMs * 2, retryCeilingMs);
}

export interface AutosaveSnapshotRecord {
  at: string;
  reason: string;
  fileName: string;
  version: number;
}

export interface AutosaveController {
  /** Persist now and take a version if one is due. */
  flush: (reason: string) => Promise<void>;
  stop: () => void;
}

let controller: AutosaveController | null = null;
let lastSnapshot: AutosaveSnapshotRecord | null = null;
/**
 * Scene state captured by the last version, so an unchanged scene is never re-versioned.
 *
 * Keyed on `updatedAt`, which `commitScene` stamps on every edit — deliberately not on
 * `revision`, which only the project service increments and the client never reads back, so
 * a revision-keyed guard would see one value forever and either block every version or
 * permit an unbounded stream of identical ones.
 */
let snapshotKey: string | null = null;
let snapshotAtMs = 0;

/** The most recent version taken this session, for Preferences to report. */
export function lastAutosave(): AutosaveSnapshotRecord | null {
  return lastSnapshot;
}

function autosavePreferences() {
  return usePreferencesStore.getState().preferences.autosave;
}

export function startAutosave(): AutosaveController {
  if (controller) return controller;

  let settle: ReturnType<typeof setTimeout> | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let retryDelayMs = 0;
  let stopped = false;
  let writing: Promise<void> | null = null;

  function clearRetry() {
    if (retry) clearTimeout(retry);
    retry = null;
    retryDelayMs = 0;
  }

  /**
   * Re-arm a failed write (rule 4).
   *
   * Deliberately not conditional on which error occurred. A client cannot tell a service that
   * is restarting from one that is refusing for good, and treating that guess as "permanent"
   * is what leaves work in a window that is one crash away from losing it; the backoff ceiling
   * bounds the cost of being wrong the other way. The save indicator keeps naming the real
   * error throughout, so a retry loop is visible rather than a silent fallback.
   *
   * Gated on the preference, like `schedule`: an operator who turned autosave off is driving
   * saves themselves and a background write would take that back.
   */
  function armRetry(reason: string) {
    if (stopped || retry || !autosavePreferences().enabled) return;
    retryDelayMs = nextRetryDelayMs(retryDelayMs);
    retry = setTimeout(() => {
      retry = null;
      void write(reason, false);
    }, retryDelayMs);
  }

  /**
   * Is a new version due?
   *
   * Two questions, and the order is the point.
   *
   * **Has the scene changed** since the last version? If not there is nothing to capture, and no
   * amount of forcing may burn a slot: the ring holds a handful of versions, so cycling it on
   * repeated idle window blurs destroys exactly the history it exists to hold. This is why
   * `force` is an argument here rather than a check the caller does instead of calling — a
   * forced write that skipped this guard is what wrote three identical versions.
   *
   * **Has enough time passed?** This is the one `force` skips, because a forced write — window
   * hidden, publish, close — may be the last chance to capture real work.
   */
  function versionDue(key: string, force: boolean): boolean {
    if (snapshotKey === key) return false;
    if (snapshotKey === null || force) return true;
    return Date.now() - snapshotAtMs >= autosavePreferences().intervalMinutes * 60_000;
  }

  async function write(reason: string, force: boolean): Promise<void> {
    if (stopped) return;
    if (writing) return writing;

    const editor = useEditorStore.getState();
    if (!editor.hasActiveScene) return;
    // Mid-gesture: the falling edge re-schedules.
    if (editor.historyTransaction) return;

    const attempt = (async () => {
      try {
        // Persist first, so the version about to be written is one the scene file also holds.
        const persisted = await editor.saveScene();
        if (!persisted) {
          // `saveScene` also returns false when there is no scene to save, which is not a
          // failure and must not start a timer; the status is what distinguishes them.
          if (useEditorStore.getState().saveStatus === "error") armRetry(reason);
          return;
        }
        clearRetry();

        // Read the scene once, after the save, and decide from that snapshot. `saveScene` moves
        // only the save status and never the document, so this is the same scene the decision is
        // about — and taking the key once means the value recorded below is provably the value
        // that was tested, rather than a second read that could have moved underneath it.
        const scene = useEditorStore.getState().scene;
        if (!versionDue(scene.updatedAt, force)) return;

        try {
          const entry = await autosaveSceneOnApi(scene, autosavePreferences().maxVersions);
          snapshotKey = scene.updatedAt;
          snapshotAtMs = Date.now();
          lastSnapshot = {
            at: new Date().toISOString(),
            reason,
            fileName: entry.fileName,
            version: entry.version
          };
        } catch {
          // Quiet by design: see rule 3. The scene is already persisted either way.
        }
      } finally {
        writing = null;
      }
    })();

    writing = attempt;
    return attempt;
  }

  function schedule(reason: string) {
    if (stopped || !autosavePreferences().enabled) return;
    if (settle) clearTimeout(settle);
    settle = setTimeout(() => {
      settle = null;
      void write(reason, false);
    }, settleDelayMs);
  }

  const unsubscribe = useEditorStore.subscribe((state, previous) => {
    if (!state.hasActiveScene) return;

    // A gesture closing is the first moment the scene is a coherent undo boundary again.
    if (previous.historyTransaction && !state.historyTransaction) {
      schedule("gesture-boundary");
      return;
    }

    // Ignore everything that is not a scene edit: selection, panel state and save status all
    // move the store without changing the document.
    if (state.scene !== previous.scene) schedule("edit");
  });

  /**
   * Both edges of window visibility are useful, for opposite reasons.
   *
   * Losing the window is the cheapest reliable moment to capture: editing has stopped and a
   * crash or shutdown may follow. Forced, because this may be the last chance.
   *
   * Regaining it is when an operator reads the save indicator. Finding "Not saved" there and
   * having to wait out a backoff — or worse, having to make an edit to trigger a write — is
   * the failure rule 4 exists for, so a window coming back retries immediately.
   */
  const onVisibility = () => {
    if (!autosavePreferences().enabled) return;
    if (document.visibilityState === "hidden") {
      void write("window-hidden", true);
      return;
    }
    if (useEditorStore.getState().saveStatus === "error") {
      clearRetry();
      void write("window-visible", false);
    }
  };
  document.addEventListener("visibilitychange", onVisibility);

  controller = {
    flush: (reason) => write(reason, true),
    stop: () => {
      stopped = true;
      if (settle) clearTimeout(settle);
      clearRetry();
      unsubscribe();
      document.removeEventListener("visibilitychange", onVisibility);
      controller = null;
    }
  };

  return controller;
}

/**
 * Persist and take a version before an operation that changes or publishes the scene.
 *
 * Honours `beforeRiskyOperations` and resolves even when autosave is off, so callers can
 * await it unconditionally.
 */
export async function autosaveBefore(reason: string): Promise<void> {
  const autosave = autosavePreferences();
  if (!autosave.enabled || !autosave.beforeRiskyOperations) return;
  await controller?.flush(reason);
}
