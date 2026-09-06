import { useEffect } from "react";
import { createPortal } from "react-dom";
import {
  AUTOSAVE_INTERVAL_MAX,
  AUTOSAVE_INTERVAL_MIN,
  AUTOSAVE_VERSIONS_MAX,
  AUTOSAVE_VERSIONS_MIN,
  usePreferencesStore
} from "../store/preferencesStore";
import { lastAutosave } from "../lib/autosave";

/**
 * Per-user editor preferences.
 *
 * Applies immediately rather than on an Apply button: every control here is a single
 * reversible setting with no cross-field validation, so a commit step would only add a way to
 * lose the change. Project settings, which do interact, keep their Apply button.
 */
export function PreferencesDialog({ onClose }: { onClose: () => void }) {
  const autosave = usePreferencesStore((state) => state.preferences.autosave);
  const updateAutosave = usePreferencesStore((state) => state.updateAutosave);
  const resetPreferences = usePreferencesStore((state) => state.resetPreferences);
  const recent = lastAutosave();

  useEffect(() => {
    function closeFromKeyboard(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", closeFromKeyboard);
    return () => window.removeEventListener("keydown", closeFromKeyboard);
  }, [onClose]);

  return createPortal(
    <div
      className="material-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onClose();
      }}
    >
      <div
        className="material-create-dialog preferences-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="preferences-title"
      >
        <header>
          <strong id="preferences-title">Preferences</strong>
          <button aria-label="Close" onClick={onClose} type="button">×</button>
        </header>

        <fieldset>
          <legend>Autosave</legend>

          <label className="viewport-ruler-option">
            <input
              type="checkbox"
              checked={autosave.enabled}
              onChange={(event) => updateAutosave({ enabled: event.target.checked })}
            />
            Save this scene automatically while I work
          </label>

          {/*
            Interval and depth are only meaningful when autosave runs, so they are disabled
            rather than hidden: a control that vanishes makes the setting look unavailable
            instead of inactive.
          */}
          <div className="preferences-grid">
            <label>
              <span>New version every</span>
              <input
                aria-label="Autosave interval in minutes"
                disabled={!autosave.enabled}
                min={AUTOSAVE_INTERVAL_MIN}
                max={AUTOSAVE_INTERVAL_MAX}
                type="number"
                value={autosave.intervalMinutes}
                onChange={(event) => updateAutosave({ intervalMinutes: event.target.valueAsNumber })}
              />
              <span className="preferences-unit">minutes</span>
            </label>

            <label>
              <span>Keep</span>
              <input
                aria-label="Maximum autosave versions"
                disabled={!autosave.enabled}
                min={AUTOSAVE_VERSIONS_MIN}
                max={AUTOSAVE_VERSIONS_MAX}
                type="number"
                value={autosave.maxVersions}
                onChange={(event) => updateAutosave({ maxVersions: event.target.valueAsNumber })}
              />
              <span className="preferences-unit">versions</span>
            </label>
          </div>

          <label className="viewport-ruler-option">
            <input
              type="checkbox"
              checked={autosave.beforeRiskyOperations}
              disabled={!autosave.enabled}
              onChange={(event) => updateAutosave({ beforeRiskyOperations: event.target.checked })}
            />
            Also take a version before publishing or converting the canvas
          </label>

          <p className="material-dialog-note">
            Versions are kept beside the project as{" "}
            <code>&lt;scene&gt; autosave 1</code> … <code>{`<scene> autosave ${autosave.maxVersions}`}</code>,
            then the oldest is reused — the same scheme After Effects uses. A version is a
            read-only copy: restoring one never happens on its own, only through{" "}
            <strong>File ▸ Revert to Autosave…</strong>.
            {recent
              ? ` Last version: ${new Date(recent.at).toLocaleTimeString()} — ${recent.fileName}.`
              : ""}
          </p>
        </fieldset>

        <footer>
          <button onClick={resetPreferences} type="button">Restore Defaults</button>
          <button className="primary" onClick={onClose} type="button">Close</button>
        </footer>
      </div>
    </div>,
    document.body
  );
}
