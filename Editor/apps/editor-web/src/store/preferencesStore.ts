/**
 * Per-user editor preferences.
 *
 * Distinct from `projectStore`, which holds *project* settings that travel with the work
 * (resolution, frame rate, safe area). These are machine-local operator choices: they follow
 * the person, not the show, so they are never written into a scene or a package.
 *
 * Persisted to `localStorage` like the dock layout and template view mode, under a versioned
 * key. Preferences are cheap to lose and expensive to migrate, so an unreadable or
 * out-of-range value falls back to the default rather than failing the editor.
 */

import { create } from "zustand";

const storageKey = "grapix-editor-preferences-v1";

/** Bounds for the autosave interval, in minutes. */
export const AUTOSAVE_INTERVAL_MIN = 1;
export const AUTOSAVE_INTERVAL_MAX = 120;
/** Bounds for the retained autosave ring depth. Mirrored by the project service. */
export const AUTOSAVE_VERSIONS_MIN = 1;
export const AUTOSAVE_VERSIONS_MAX = 50;

export interface AutosavePreferences {
  enabled: boolean;
  /**
   * Minutes between snapshots.
   *
   * After Effects defaults to 20. A broadcast deadline is harder than a post one and a
   * rundown changes late, so the default here is tighter.
   */
  intervalMinutes: number;
  /** Ring depth. Slot `n` is overwritten once this many snapshots exist. */
  maxVersions: number;
  /**
   * Snapshot before publishing, preflighting or converting the canvas.
   *
   * The highest-value trigger there is: a save taken immediately before the risky operation
   * beats any number of timer ticks. Separately toggleable because it costs a write on the
   * critical path of going to air.
   */
  beforeRiskyOperations: boolean;
}

export interface EditorPreferences {
  autosave: AutosavePreferences;
}

/**
 * Autosave is off.
 *
 * A GrapiX project is a folder the operator named, and until they have named one there is nowhere
 * for a background write to go. Saving is therefore an explicit act: File ▸ Save, which asks for
 * the project location the first time and writes the `.gpxpkg` from then on. Every mechanism autosave
 * needs is still here and still gated on this flag, so turning it back on is a one-line change
 * once the project-first flow has settled.
 */
export const DEFAULT_PREFERENCES: EditorPreferences = {
  autosave: {
    enabled: false,
    intervalMinutes: 10,
    maxVersions: 10,
    beforeRiskyOperations: false
  }
};

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(numeric)));
}

function normalizePreferences(raw: Partial<EditorPreferences> | undefined): EditorPreferences {
  const autosave = raw?.autosave;
  return {
    autosave: {
      // Off unless a profile explicitly asked for it. The default carries the manual-save-only
      // decision; coercing a stored value on top of that would make the preference unsettable and
      // leave the Preferences toggle describing something that cannot happen.
      enabled: typeof autosave?.enabled === "boolean"
        ? autosave.enabled
        : DEFAULT_PREFERENCES.autosave.enabled,
      intervalMinutes: clampInt(
        autosave?.intervalMinutes,
        AUTOSAVE_INTERVAL_MIN,
        AUTOSAVE_INTERVAL_MAX,
        DEFAULT_PREFERENCES.autosave.intervalMinutes
      ),
      maxVersions: clampInt(
        autosave?.maxVersions,
        AUTOSAVE_VERSIONS_MIN,
        AUTOSAVE_VERSIONS_MAX,
        DEFAULT_PREFERENCES.autosave.maxVersions
      ),
      beforeRiskyOperations: typeof autosave?.beforeRiskyOperations === "boolean"
        ? autosave.beforeRiskyOperations
        : DEFAULT_PREFERENCES.autosave.beforeRiskyOperations
    }
  };
}

function persist(preferences: EditorPreferences): void {
  try {
    localStorage.setItem(storageKey, JSON.stringify(preferences));
  } catch {
    // A full or blocked storage quota must not stop the editor working.
  }
}

function readPersisted(): EditorPreferences {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return normalizePreferences(undefined);
    // Normalised on read: a hand-edited or older payload is brought into range rather
    // than trusted.
    return normalizePreferences(JSON.parse(raw) as Partial<EditorPreferences>);
  } catch {
    return normalizePreferences(undefined);
  }
}

interface PreferencesState {
  preferences: EditorPreferences;
  updateAutosave: (patch: Partial<AutosavePreferences>) => void;
  resetPreferences: () => void;
}

export const usePreferencesStore = create<PreferencesState>((set) => ({
  preferences: readPersisted(),

  updateAutosave: (patch) =>
    set((state) => {
      const preferences = normalizePreferences({
        ...state.preferences,
        autosave: { ...state.preferences.autosave, ...patch }
      });
      persist(preferences);
      return { preferences };
    }),

  resetPreferences: () => {
    const preferences = normalizePreferences(undefined);
    persist(preferences);
    return set({ preferences });
  }
}));
