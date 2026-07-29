import {
  DEFAULT_PROJECT_SETTINGS,
  normalizeProjectSettings,
  presetForResolution,
  projectCanvasSize,
  validateProjectSettings,
  type ProjectColorSpace,
  type ProjectSettings,
  type ProjectSettingsValidation,
  type RationalFrameRate,
  type ResolutionPresetId,
  type SceneDocument
} from "@grapix/shared-types";
import { create } from "zustand";

const storageKey = "grapix.project.settings.v1";

/**
 * Project settings store.
 *
 * One resolution and one colour space for the whole project. Scenes do not carry
 * their own resolution as an independent value — they carry a canvas that is
 * expected to match the project, and `conformScene` is what makes that true.
 *
 * Changing the resolution is therefore a project-wide operation with consequences,
 * so the store reports which scenes would need conforming rather than silently
 * rewriting them behind the operator's back.
 */
interface ProjectState {
  settings: ProjectSettings;
  /** Result of validating the current settings, recomputed on every change. */
  validation: ProjectSettingsValidation;

  setResolution: (width: number, height: number) => void;
  applyPreset: (preset: ResolutionPresetId) => void;
  setColorSpace: (colorSpace: ProjectColorSpace) => void;
  setPeakLuminance: (nits: number | undefined) => void;
  setFrameRate: (frameRate: RationalFrameRate) => void;
  setSafeAreaPercent: (percent: number) => void;
  setProjectName: (name: string) => void;
  replaceSettings: (settings: Partial<ProjectSettings>) => void;
}

function persist(settings: ProjectSettings): void {
  try {
    localStorage.setItem(storageKey, JSON.stringify(settings));
  } catch {
    // A full or blocked storage quota must not stop the editor working.
  }
}

function readPersisted(): ProjectSettings {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return normalizeProjectSettings(DEFAULT_PROJECT_SETTINGS);
    // Normalise on read: a hand-edited or older file is brought into range rather
    // than trusted.
    return normalizeProjectSettings(JSON.parse(raw) as Partial<ProjectSettings>);
  } catch {
    return normalizeProjectSettings(DEFAULT_PROJECT_SETTINGS);
  }
}

export const useProjectStore = create<ProjectState>((set) => {
  const initial = readPersisted();

  /** Normalise, validate, persist, and stamp the change time — in one place. */
  const commit = (next: Partial<ProjectSettings>, previous: ProjectSettings) => {
    const settings = normalizeProjectSettings({
      ...previous,
      ...next,
      updatedAt: new Date().toISOString()
    });
    persist(settings);
    return { settings, validation: validateProjectSettings(settings) };
  };

  return {
    settings: initial,
    validation: validateProjectSettings(initial),

    setResolution: (width, height) =>
      set((state) =>
        commit(
          {
            resolution: {
              // The preset follows the dimensions, never the other way round.
              preset: presetForResolution(width, height),
              width,
              height,
              pixelAspectRatio: 1
            }
          },
          state.settings
        )
      ),

    applyPreset: (preset) =>
      set((state) =>
        commit(
          {
            resolution: {
              preset,
              // Normalisation resolves a named preset to its dimensions, so passing
              // the current ones through is safe and keeps `custom` working.
              width: state.settings.resolution.width,
              height: state.settings.resolution.height,
              pixelAspectRatio: 1
            }
          },
          state.settings
        )
      ),

    setColorSpace: (colorSpace) =>
      set((state) => commit({ colorSpace }, state.settings)),

    setPeakLuminance: (nits) =>
      set((state) => commit({ peakLuminanceNits: nits }, state.settings)),

    setFrameRate: (frameRate) => set((state) => commit({ frameRate }, state.settings)),

    setSafeAreaPercent: (percent) =>
      set((state) => commit({ safeAreaPercent: percent }, state.settings)),

    setProjectName: (name) => set((state) => commit({ name }, state.settings)),

    replaceSettings: (settings) => set((state) => commit(settings, state.settings))
  };
});

/**
 * Bring a scene's canvas onto the project resolution.
 *
 * Only the canvas changes. Object positions are deliberately left alone: scaling
 * them would silently move every graphic an operator has already positioned, and a
 * lower third that was 40 px from the bottom must stay 40 px from the bottom when
 * the project moves from HD to UHD. Anything that needs re-laying out is the
 * author's decision, not the tool's.
 */
export function conformScene(scene: SceneDocument, settings: ProjectSettings): SceneDocument {
  const { width, height } = projectCanvasSize(settings);
  if (scene.canvas.width === width && scene.canvas.height === height) {
    return scene;
  }

  return {
    ...scene,
    canvas: { ...scene.canvas, width, height },
    updatedAt: new Date().toISOString()
  };
}

/** Does this scene match the project resolution? */
export function sceneMatchesProject(
  scene: SceneDocument,
  settings: ProjectSettings
): boolean {
  const { width, height } = projectCanvasSize(settings);
  return scene.canvas.width === width && scene.canvas.height === height;
}
