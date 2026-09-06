import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  listSceneAutosavesFromApi,
  readSceneAutosaveFromApi,
  type ApiAutosaveEntry
} from "../lib/apiClient";
import { useEditorStore } from "../store/editorStore";

/**
 * Browse and restore an autosave snapshot.
 *
 * Restoring loads the snapshot into the editor and leaves it *unsaved*, so recovery is itself
 * undoable and the operator still chooses whether it reaches disk. A snapshot may be older
 * than what Playout has already taken to air, which is why the revision and time of each one
 * are shown rather than just "restore the latest".
 */
export function AutosaveRecoveryDialog({ onClose }: { onClose: () => void }) {
  const sceneId = useEditorStore((state) => state.scene.id);
  const loadScene = useEditorStore((state) => state.loadScene);

  /**
   * The stored scene's revision, from the service rather than from `scene.revision`.
   *
   * The open document's copy is whatever it was loaded with — the service increments the
   * revision on every save and the client never reads it back — so comparing against it
   * either warns about nothing or warns about everything.
   */
  const [sceneRevision, setSceneRevision] = useState(0);
  const [entries, setEntries] = useState<ApiAutosaveEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  useEffect(() => {
    function closeFromKeyboard(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", closeFromKeyboard);
    return () => window.removeEventListener("keydown", closeFromKeyboard);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    listSceneAutosavesFromApi(sceneId)
      .then((list) => {
        if (cancelled) return;
        setEntries(list.autosaves);
        setSceneRevision(list.sceneRevision);
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setEntries([]);
          setError(cause instanceof Error ? cause.message : "Could not read autosaves");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [sceneId]);

  async function restore(entry: ApiAutosaveEntry) {
    setBusy(entry.version);
    setError(null);
    try {
      const scene = await readSceneAutosaveFromApi(sceneId, entry.version);
      loadScene(scene);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not restore this autosave");
    } finally {
      setBusy(null);
    }
  }

  return createPortal(
    <div
      className="material-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onClose();
      }}
    >
      <div
        className="material-create-dialog autosave-recovery-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="autosave-recovery-title"
      >
        <header>
          <strong id="autosave-recovery-title">Revert to Autosave</strong>
          <button aria-label="Close" onClick={onClose} type="button">×</button>
        </header>

        {entries === null ? <p className="material-dialog-note">Reading autosaves…</p> : null}

        {entries?.length === 0 ? (
          <p className="material-dialog-note">
            No autosaves have been taken for this scene yet. Autosave can be enabled in{" "}
            <strong>Edit ▸ Preferences…</strong>.
          </p>
        ) : null}

        {entries && entries.length > 0 ? (
          <ul className="autosave-list">
            {entries.map((entry) => {
              const stale = entry.revision < sceneRevision;
              return (
                <li key={entry.version}>
                  <div className="autosave-entry">
                    <strong>{entry.fileName}</strong>
                    <small>
                      {new Date(entry.savedAt).toLocaleString()} · revision {entry.revision} ·{" "}
                      {(entry.sizeBytes / 1024).toFixed(0)} KiB
                    </small>
                    {/*
                      An older revision than the stored scene is the dangerous case: restoring
                      and publishing it would put superseded graphics to air.
                    */}
                    {stale ? (
                      <small className="autosave-stale">
                        Older than the saved scene (revision {sceneRevision})
                      </small>
                    ) : null}
                  </div>
                  <button
                    disabled={busy !== null}
                    onClick={() => void restore(entry)}
                    type="button"
                  >
                    {busy === entry.version ? "Restoring…" : "Restore"}
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}

        {error ? <p className="material-dialog-error">{error}</p> : null}

        <p className="material-dialog-note">
          Restoring replaces the scene in the editor without saving it, so you can undo the
          recovery or compare before committing with <strong>File ▸ Save</strong>.
        </p>

        <footer>
          <button className="primary" onClick={onClose} type="button">Close</button>
        </footer>
      </div>
    </div>,
    document.body
  );
}
